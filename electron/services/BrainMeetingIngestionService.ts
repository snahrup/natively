import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { DatabaseManager, type Meeting } from "../db/DatabaseManager";
import { CalendarManager, type CalendarEvent } from "./CalendarManager";
import { cleanTranscriptForAnalysis } from "./TranscriptCleanupService";

type TranscriptSegment = NonNullable<Meeting["transcript"]>[number];

interface MeetingCapturePart {
  id: string;
  title: string;
  summary: string;
  startTime: string;
  endTime: string;
  duration: string;
  transcript: TranscriptSegment[];
  keyPoints: string[];
  actionItems: string[];
  topicKeywords: string[];
  calendarEvent?: CalendarEvent;
  files?: {
    markdown: string;
    json: string;
  };
}

interface ProcessedManifestEntry {
  hash: string;
  exportedAt: string;
  partIds: string[];
  files: string[];
}

const BRAIN_ROOT = path.join(os.homedir(), "CascadeProjects", "ipcorp-architecture-brain");
const NATIVELY_ROOT = path.join(BRAIN_ROOT, "natively");
const CAPTURES_ROOT = path.join(NATIVELY_ROOT, "meeting-captures");
const MEETING_INDEX_PATH = path.join(NATIVELY_ROOT, "meeting-index.json");
const STATUS_PATH = path.join(NATIVELY_ROOT, "status.json");
const PROCESSED_MANIFEST_PATH = path.join(CAPTURES_ROOT, "_processed.json");

const STOPWORDS = new Set([
  "about", "actually", "again", "also", "because", "been", "being", "could", "didn", "does", "doing", "done",
  "from", "going", "have", "here", "just", "kind", "know", "like", "really", "right", "said", "some", "that",
  "their", "there", "these", "thing", "think", "this", "those", "through", "want", "were", "what", "when",
  "where", "which", "with", "would", "yeah", "you", "your",
]);

export class BrainMeetingIngestionService {
  private static instance: BrainMeetingIngestionService;
  private unsubscribe: (() => void) | null = null;
  private readonly queued = new Set<string>();

  public static getInstance(): BrainMeetingIngestionService {
    if (!BrainMeetingIngestionService.instance) {
      BrainMeetingIngestionService.instance = new BrainMeetingIngestionService();
    }
    return BrainMeetingIngestionService.instance;
  }

  public start(dbManager: DatabaseManager): void {
    if (this.unsubscribe) return;

    this.ensureScaffold();
    this.unsubscribe = dbManager.subscribeMeetingChanges((event) => {
      if (event.type !== "upsert") return;
      this.queueMeeting(event.meeting);
    });
    setTimeout(() => {
      void this.backfillExistingMeetings(dbManager);
    }, 1_500);
    console.log("[BrainMeetingIngestionService] Watching processed meetings for brain export.");
  }

  public queueMeeting(meeting: Meeting): void {
    if (!this.shouldExport(meeting)) return;
    if (this.queued.has(meeting.id)) return;

    this.queued.add(meeting.id);
    setTimeout(() => {
      this.exportMeeting(meeting)
        .catch((error) => {
          console.warn("[BrainMeetingIngestionService] Export failed:", error?.message || error);
        })
        .finally(() => {
          this.queued.delete(meeting.id);
        });
    }, 500);
  }

  private shouldExport(meeting: Meeting): boolean {
    if (!meeting?.id || meeting.isProcessed === false) return false;
    if (meeting.id === "demo-meeting") return false;
    if (meeting.source && meeting.source !== "manual" && meeting.source !== "calendar") return false;
    if (!meeting.transcript || meeting.transcript.length === 0) return false;
    if (/^processing/i.test(meeting.title || "")) return false;
    if (/^demo\b/i.test(meeting.title || "")) return false;
    return true;
  }

  private async backfillExistingMeetings(dbManager: DatabaseManager): Promise<void> {
    const meetingIds = dbManager.getAllMeetingIds();
    let checked = 0;
    let candidates = 0;

    for (const meetingId of meetingIds) {
      const meeting = dbManager.getMeetingDetails(meetingId);
      checked += 1;
      if (!this.shouldExport(meeting as Meeting)) continue;

      candidates += 1;
      await this.exportMeeting(meeting as Meeting);
    }

    if (checked > 0) {
      console.log(`[BrainMeetingIngestionService] Backfill scan complete. Checked ${checked} meeting(s); evaluated ${candidates} export candidate(s).`);
    }
  }

  private async exportMeeting(meeting: Meeting): Promise<void> {
    if (!fs.existsSync(BRAIN_ROOT)) return;

    this.ensureScaffold();
    const hash = stableHash({
      title: meeting.title,
      date: meeting.date,
      calendarEventId: meeting.calendarEventId,
      detailedSummary: meeting.detailedSummary,
      transcript: meeting.transcript,
    });

    const manifest = this.readProcessedManifest();
    const previous = manifest[meeting.id];
    if (previous?.hash === hash) {
      return;
    }

    const calendarEvents = await this.getNearbyCalendarEvents(meeting);
    const parts = this.buildMeetingParts(meeting, calendarEvents);
    const exportedAt = new Date().toISOString();
    const files: string[] = [];

    for (const part of parts) {
      const written = this.writePart(meeting, part, exportedAt);
      part.files = written;
      files.push(written.markdown, written.json);
    }

    const runReport = this.writeRunReport(meeting, parts, exportedAt);
    files.push(runReport);
    this.updateMeetingIndex(meeting, parts, exportedAt);
    this.updateStatus(parts, exportedAt);

    manifest[meeting.id] = {
      hash,
      exportedAt,
      partIds: parts.map((part) => part.id),
      files,
    };
    writeJsonFile(PROCESSED_MANIFEST_PATH, manifest);

    console.log(`[BrainMeetingIngestionService] Exported ${meeting.id} to brain (${parts.length} part${parts.length === 1 ? "" : "s"}).`);
  }

  private async getNearbyCalendarEvents(meeting: Meeting): Promise<CalendarEvent[]> {
    const startMs = resolveMeetingStartMs(meeting);
    const durationMs = Math.max(parseDurationMs(meeting.duration), resolveTranscriptDurationMs(meeting.transcript || []), 15 * 60_000);
    const rangeStart = new Date(startMs - 4 * 60 * 60 * 1000).toISOString();
    const rangeEnd = new Date(startMs + durationMs + 4 * 60 * 60 * 1000).toISOString();

    return CalendarManager.getInstance()
      .getEventsInRange(rangeStart, rangeEnd)
      .catch((error): CalendarEvent[] => {
        console.warn("[BrainMeetingIngestionService] Calendar association unavailable:", error?.message || error);
        return [];
      });
  }

  private buildMeetingParts(meeting: Meeting, calendarEvents: CalendarEvent[]): MeetingCapturePart[] {
    const transcript = (meeting.transcript || [])
      .filter((segment) => segment.text?.trim())
      .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));

    if (transcript.length === 0) return [];

    const ranges = splitTranscriptByTopic(transcript);
    const singlePart = ranges.length === 1;
    return ranges.map((range, index) => {
      const partTranscript = transcript.slice(range.startIndex, range.endIndex + 1);
      const partStartMs = partTranscript[0]?.timestamp || resolveMeetingStartMs(meeting);
      const partEndMs = partTranscript[partTranscript.length - 1]?.timestamp || partStartMs;
      const calendarEvent = findBestCalendarEventForRange(meeting, partStartMs, partEndMs, calendarEvents);
      const topicKeywords = topKeywords(partTranscript.map((segment) => segment.text).join(" "), 6);
      const baseTitle = calendarEvent?.title || meeting.title || "Natively Session";
      const topicTitle = singlePart ? baseTitle : `${baseTitle} - Part ${index + 1}: ${titleFromKeywords(topicKeywords)}`;
      const summary = summarizePart(meeting, partTranscript, topicKeywords, singlePart);
      const keyPoints = extractKeyPoints(meeting, partTranscript, singlePart);
      const actionItems = extractActionItems(meeting, partTranscript, singlePart);
      const id = `${safePathSegment(`${datePrefix(partStartMs)}-${topicTitle}`)}-${meeting.id.slice(0, 8)}${singlePart ? "" : `-p${index + 1}`}`;

      return {
        id,
        title: topicTitle,
        summary,
        startTime: new Date(partStartMs).toISOString(),
        endTime: new Date(partEndMs).toISOString(),
        duration: formatDuration(Math.max(0, partEndMs - partStartMs)),
        transcript: partTranscript,
        keyPoints,
        actionItems,
        topicKeywords,
        calendarEvent,
      };
    });
  }

  private writePart(meeting: Meeting, part: MeetingCapturePart, exportedAt: string): { markdown: string; json: string } {
    const day = part.startTime.slice(0, 10);
    const dayDir = path.join(CAPTURES_ROOT, day);
    fs.mkdirSync(dayDir, { recursive: true });

    const markdownPath = path.join(dayDir, `${part.id}.md`);
    const jsonPath = path.join(dayDir, `${part.id}.json`);
    const cleanedTranscript = cleanTranscriptForAnalysis(part.transcript, { maxChars: 80_000 });
    const reconstructedTranscript = selectReconstructedTranscriptForPart(meeting, part);
    const markdown = renderMeetingCaptureMarkdown(meeting, part, exportedAt, toBrainPath(jsonPath));
    const json = {
      schemaVersion: 1,
      source: "natively",
      exportedAt,
      nativelyMeetingId: meeting.id,
      partId: part.id,
      title: part.title,
      startTime: part.startTime,
      endTime: part.endTime,
      duration: part.duration,
      summary: part.summary,
      keyPoints: part.keyPoints,
      actionItems: part.actionItems,
      topicKeywords: part.topicKeywords,
      calendarEvent: part.calendarEvent ? {
        id: part.calendarEvent.id,
        title: part.calendarEvent.title,
        startTime: part.calendarEvent.startTime,
        endTime: part.calendarEvent.endTime,
        source: part.calendarEvent.source,
        attendees: part.calendarEvent.attendees || [],
      } : null,
      sourceMeeting: {
        id: meeting.id,
        title: meeting.title,
        date: meeting.date,
        source: meeting.source || "manual",
        calendarEventId: meeting.calendarEventId,
        summary: meeting.summary,
        detailedSummary: meeting.detailedSummary,
      },
      userContextNotes: normalizeUserContextNotes(meeting),
      transcriptCleanup: cleanedTranscript.stats,
      reconstructedTranscript,
      cleanedTranscript: cleanedTranscript.turns,
      transcript: part.transcript,
    };

    writeTextFile(markdownPath, markdown);
    writeJsonFile(jsonPath, json);

    return {
      markdown: toBrainPath(markdownPath),
      json: toBrainPath(jsonPath),
    };
  }

  private writeRunReport(meeting: Meeting, parts: MeetingCapturePart[], exportedAt: string): string {
    const day = exportedAt.slice(0, 10);
    const reportPath = path.join(
      BRAIN_ROOT,
      "meetings",
      "summaries",
      `_RUN_REPORT_${day}-natively-${safePathSegment(meeting.title || meeting.id).slice(0, 48)}-${meeting.id.slice(0, 8)}.md`
    );
    const createdFiles = parts.flatMap((part) => [part.files?.markdown, part.files?.json].filter(Boolean));
    const splitNote = parts.length > 1
      ? `Topic segmentation split the source session into ${parts.length} capture records before indexing.`
      : "Topic segmentation did not find a material subject boundary.";
    const report = [
      `# Run Report - Natively Meeting Export (${day})`,
      "",
      `> Run date: ${exportedAt}`,
      `> Trigger: Natively processed meeting ${meeting.id}`,
      `> Scope: Raw transcript, extractive summary, calendar association, and Natively read-model index update.`,
      "",
      "## 1. Summary table",
      "",
      `| Item | Count | Note |`,
      `|---|---:|---|`,
      `| Source meetings processed | 1 | ${escapeMarkdownTable(meeting.title || meeting.id)} |`,
      `| Capture records written | ${parts.length} | ${escapeMarkdownTable(splitNote)} |`,
      `| Outlook/Calendar associations | ${parts.filter((part) => part.calendarEvent).length} | Calendar lookup is prep/association only, not live context retrieval. |`,
      "",
      "## 2. Files modified",
      "### Created / updated",
      ...createdFiles.map((file) => `- ${file}`),
      `- natively/meeting-index.json`,
      `- natively/status.json`,
      `- ${toBrainPath(PROCESSED_MANIFEST_PATH)}`,
      "",
      "## 3. Source manifest",
      `- SQLite meeting: ${meeting.id}`,
      `- Natively transcript segments: ${meeting.transcript?.length || 0}`,
      "",
      "## 4. Contradictions detected",
      "- None detected by the Natively export layer. Deep contradiction handling remains a brain/Cortex processing step.",
      "",
      "## 5. Open follow-ups",
      "- Run deep meeting-intelligence extraction if this capture contains architecture decisions, risks, stakeholder signals, or new facts that should be promoted into canonical project-memory files.",
      "",
      "## 6. Next-run high-water mark",
      `- ${exportedAt}`,
      "",
    ].join("\n");

    writeTextFile(reportPath, report);
    return toBrainPath(reportPath);
  }

  private updateMeetingIndex(meeting: Meeting, parts: MeetingCapturePart[], exportedAt: string): void {
    const existing = readJsonObject(MEETING_INDEX_PATH);
    const records = extractArray(existing, ["meetings", "items", "records", "index"]);
    const nextRecords = records.filter((record) => {
      const sourceMeetingId = recordValue(record)?.importMetadata?.sourceMeetingId;
      return sourceMeetingId !== meeting.id;
    });

    for (const part of parts) {
      nextRecords.push({
        id: part.id,
        title: part.title,
        date: part.startTime,
        duration: part.duration,
        summary: part.summary,
        source: meeting.source || "manual",
        importMetadata: {
          sourceFormat: "generic",
          importedAt: exportedAt,
          fidelity: "exact",
          brainSource: "natively-auto-export",
          sourceMeetingId: meeting.id,
          matchedCalendarEventId: part.calendarEvent?.id || meeting.calendarEventId,
          matchedCalendarSubject: part.calendarEvent?.title,
          calendarAttendees: part.calendarEvent?.attendees?.map((attendee) => attendee.displayName || attendee.email).filter(Boolean) || [],
          relatedArtifacts: [part.files?.markdown, part.files?.json].filter(Boolean),
          enrichmentSources: ["natively-transcript", part.calendarEvent ? `${part.calendarEvent.source}-calendar` : ""].filter(Boolean),
        },
        detailedSummary: {
          overview: part.summary,
          keyPoints: part.keyPoints,
          actionItems: part.actionItems,
        },
        transcript: [],
        usage: [],
      });
    }

    nextRecords.sort((left, right) => Date.parse(recordValue(right)?.date || "") - Date.parse(recordValue(left)?.date || ""));
    const next = {
      ...(existing || {}),
      updatedAt: exportedAt,
      meetings: nextRecords,
    };
    writeJsonFile(MEETING_INDEX_PATH, next);
  }

  private updateStatus(parts: MeetingCapturePart[], exportedAt: string): void {
    const status = readJsonObject(STATUS_PATH) || {};
    const index = readJsonObject(MEETING_INDEX_PATH);
    const records = extractArray(index, ["meetings", "items", "records", "index"]);
    const nativelyAutoExports = records.filter((record) => {
      return recordValue(record)?.importMetadata?.brainSource === "natively-auto-export";
    }).length;
    const latestRecord = records
      .filter((record) => recordValue(record)?.importMetadata?.brainSource === "natively-auto-export")
      .sort((left, right) => Date.parse(recordValue(right)?.date || "") - Date.parse(recordValue(left)?.date || ""))[0];
    const latestMetadata = recordValue(recordValue(latestRecord)?.importMetadata);
    const latestArtifacts = Array.isArray(latestMetadata?.relatedArtifacts)
      ? latestMetadata.relatedArtifacts.filter((artifact: unknown): artifact is string => typeof artifact === "string")
      : [];
    const latestInput = latestArtifacts[0] || parts[0]?.files?.markdown || "natively/meeting-captures";
    const sourceHealth = recordValue(status.sourceHealth) || {};
    const counts = recordValue(status.counts) || {};

    const next = {
      ...status,
      updatedAt: exportedAt,
      freshnessLabel: "fresh-natively-auto-export",
      counts: {
        ...counts,
        meetingsIndexed: records.length,
        nativelyAutoExports,
      },
      sourceHealth: {
        ...sourceHealth,
        nativelyAutoExport: {
          status: "fresh",
          latestInput,
          latestExportedAt: exportedAt,
          note: `${nativelyAutoExports} Natively capture record${nativelyAutoExports === 1 ? "" : "s"} indexed from manual/calendar sessions with topic segmentation and calendar association.`,
        },
      },
    };

    writeJsonFile(STATUS_PATH, next);
  }

  private ensureScaffold(): void {
    if (!fs.existsSync(BRAIN_ROOT)) return;
    fs.mkdirSync(CAPTURES_ROOT, { recursive: true });
    const readmePath = path.join(CAPTURES_ROOT, "README.md");
    if (!fs.existsSync(readmePath)) {
      writeTextFile(readmePath, [
        "# Natively Meeting Captures",
        "",
        "This folder is the handoff lane from the Natively desktop app into the IP Corp architecture brain.",
        "",
        "- Natively writes raw transcript evidence and extractive meeting summaries here after each completed session.",
        "- Long-running recordings are split into multiple capture records when time gaps, topic drift, or hard duration limits indicate a material subject change.",
        "- These files are safe for Natively to read during prep and live assistance; deeper promotion into canonical `meetings/summaries/`, discoveries, ADR candidates, and project-memory files remains a brain/Cortex processing step.",
        "- Calendar association is limited to meeting metadata and timing; live Outlook email/Teams context is not read during meetings.",
        "",
      ].join("\n"));
    }
  }

  private readProcessedManifest(): Record<string, ProcessedManifestEntry> {
    return readJsonObject(PROCESSED_MANIFEST_PATH) as Record<string, ProcessedManifestEntry> || {};
  }
}

function splitTranscriptByTopic(transcript: TranscriptSegment[]): Array<{ startIndex: number; endIndex: number }> {
  if (transcript.length <= 1) return [{ startIndex: 0, endIndex: transcript.length - 1 }];

  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = 0;

  for (let index = 1; index < transcript.length; index += 1) {
    const current = transcript.slice(startIndex, index);
    const previous = transcript[index - 1];
    const next = transcript[index];
    const currentDurationMs = Math.max(0, (previous.timestamp || 0) - (transcript[startIndex].timestamp || 0));
    const gapMs = Math.max(0, (next.timestamp || 0) - (previous.timestamp || 0));
    const nextWindow = transcript.slice(index, Math.min(transcript.length, index + 12));
    const currentText = current.slice(-40).map((segment) => segment.text).join(" ");
    const nextText = nextWindow.map((segment) => segment.text).join(" ");
    const similarity = tokenSimilarity(currentText, nextText);
    const shiftLanguage = /\b(next topic|switch gears|moving on|another thing|different topic|walk over|tour|new meeting|new question|let'?s talk about|now we'?re|on the other hand)\b/i.test(nextText);
    const shouldSplit =
      (gapMs >= 12 * 60_000 && currentDurationMs >= 5 * 60_000) ||
      (currentDurationMs >= 50 * 60_000 && nextText.length > 180 && (similarity < 0.08 || shiftLanguage)) ||
      currentDurationMs >= 90 * 60_000;

    if (shouldSplit) {
      ranges.push({ startIndex, endIndex: index - 1 });
      startIndex = index;
    }
  }

  ranges.push({ startIndex, endIndex: transcript.length - 1 });

  if (ranges.length === 1) {
    const totalDuration = resolveTranscriptDurationMs(transcript);
    if (totalDuration >= 2 * 60 * 60_000) {
      return forceSplitByDuration(transcript, 60 * 60_000);
    }
  }

  return ranges.filter((range) => range.endIndex >= range.startIndex);
}

function forceSplitByDuration(transcript: TranscriptSegment[], chunkMs: number): Array<{ startIndex: number; endIndex: number }> {
  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let startIndex = 0;
  let chunkStartMs = transcript[0]?.timestamp || 0;

  for (let index = 1; index < transcript.length; index += 1) {
    const ts = transcript[index].timestamp || 0;
    if (ts - chunkStartMs >= chunkMs) {
      ranges.push({ startIndex, endIndex: index - 1 });
      startIndex = index;
      chunkStartMs = ts;
    }
  }

  ranges.push({ startIndex, endIndex: transcript.length - 1 });
  return ranges;
}

function renderMeetingCaptureMarkdown(meeting: Meeting, part: MeetingCapturePart, exportedAt: string, jsonPath: string): string {
  const sourcePath = part.files?.json || jsonPath;
  const originalOverview = typeof meeting.detailedSummary?.overview === "string" ? meeting.detailedSummary.overview.trim() : "";
  const originalKeyPoints = Array.isArray(meeting.detailedSummary?.keyPoints) ? meeting.detailedSummary.keyPoints : [];
  const originalActionItems = Array.isArray(meeting.detailedSummary?.actionItems) ? meeting.detailedSummary.actionItems : [];
  const userContextNotes = normalizeUserContextNotes(meeting);
  const calendar = part.calendarEvent
    ? `${part.calendarEvent.title} (${part.calendarEvent.source}, ${part.calendarEvent.startTime})`
    : "No calendar match";
  const cleanedTranscript = cleanTranscriptForAnalysis(part.transcript, { maxChars: 80_000 });
  const reconstructedTranscript = selectReconstructedTranscriptForPart(meeting, part);
  const reconstructedLines = (reconstructedTranscript?.turns || []).map((turn: any) => {
    const ts = Number.isFinite(Number(turn.startTimestamp)) ? formatClock(Number(turn.startTimestamp)) : "";
    return `- ${ts ? `[${ts}] ` : ""}**${normalizeSpeaker(turn.speaker)}:** ${String(turn.text || "").replace(/\s+/g, " ").trim()}`;
  });
  const transcriptLines = cleanedTranscript.turns.map((turn) => {
    const ts = formatClock(turn.startTimestamp);
    return `- [${ts}] **${normalizeSpeaker(turn.speaker)}:** ${turn.text.replace(/\s+/g, " ").trim()}`;
  });

  return [
    "---",
    "tags:",
    "  - all",
    "source: natively",
    `nativelyMeetingId: ${meeting.id}`,
    `capturePartId: ${part.id}`,
    `exportedAt: ${exportedAt}`,
    "---",
    `# ${part.title} - ${part.startTime.slice(0, 10)}`,
    "",
    `> Source: ${sourcePath} · Calendar: ${calendar} · Duration: ${part.duration}`,
    "",
    "## Summary",
    part.summary || "Natively captured this session and preserved the transcript for deeper brain processing.",
    "",
    "## Transcript Cleanup",
    `- Raw transcript segments: ${cleanedTranscript.stats.rawSegments}`,
    `- Cleaned speaker turns: ${cleanedTranscript.stats.cleanTurns}`,
    `- Raw characters: ${cleanedTranscript.stats.rawCharacters}`,
    `- Cleaned characters: ${cleanedTranscript.stats.cleanCharacters}`,
    `- Compression ratio: ${cleanedTranscript.stats.compressionRatio}`,
    "",
    "## Original Natively Summary",
    originalOverview || meeting.summary || "No original comprehensive summary was available.",
    "",
    "### Original Key Points",
    ...(originalKeyPoints.length ? originalKeyPoints.map((point) => `- ${point}`) : ["- None captured."]),
    "",
    "### Original Action Items",
    ...(originalActionItems.length ? originalActionItems.map((item) => `- ${item}`) : ["- None captured."]),
    "",
    "## User-Supplied Context",
    ...(userContextNotes.length
      ? userContextNotes.map((note) => `- ${note.createdAt ? `**${note.createdAt}:** ` : ""}${note.text}`)
      : ["- None provided."]),
    "",
    "## GPT-Reconstructed Transcript",
    ...(reconstructedLines.length
      ? [
          `- Reconstruction model: ${reconstructedTranscript.model || "gpt-5.5"} (${reconstructedTranscript.reasoningEffort || "xhigh"})`,
          ...(Array.isArray(reconstructedTranscript.summaryNotes) ? reconstructedTranscript.summaryNotes.map((note: string) => `- Note: ${note}`) : []),
          "",
          ...reconstructedLines,
        ]
      : ["- No GPT reconstruction was available for this capture; use the cleaned transcript below."]),
    "",
    "## Decisions",
    "- Open Question: automated Natively export does not promote decisions without a deeper meeting-intelligence pass.",
    "",
    "## Action Items",
    ...(part.actionItems.length ? part.actionItems.map((item) => `- **Next step:** ${item}`) : ["- Open Question: no explicit action item detected in the automated pass."]),
    "",
    "## Risks",
    "- Open Question: risk extraction requires the follow-up brain/Cortex processing pass.",
    "",
    "## Open Questions",
    "- Open Question: should this Natively capture be promoted into canonical meeting summaries, discoveries, ADR candidates, or stakeholder updates?",
    "",
    "## New Facts",
    ...(part.keyPoints.length ? part.keyPoints.map((point) => `- **Fact:** ${point}`) : ["- Open Question: no high-confidence fact extracted by the automated pass."]),
    "",
    "## Architecture Implications",
    "- Review this capture against `project-memory/`, `risk-register.md`, open questions, and ADR candidates before canonical promotion.",
    "",
    "## Stakeholder Signals",
    "- Open Question: speaker identity and stakeholder signal extraction requires the follow-up brain/Cortex processing pass.",
    "",
    "## Cross-references",
    `- Natively source meeting: ${meeting.id}`,
    part.calendarEvent ? `- Calendar event: ${part.calendarEvent.title} (${part.calendarEvent.id})` : "- Calendar event: no match",
    "",
    "## Cleaned Transcript",
    ...transcriptLines,
    "",
  ].join("\n");
}

function normalizeUserContextNotes(meeting: Meeting): Array<{ id?: string; text: string; createdAt?: string; source?: string }> {
  const notes = meeting.detailedSummary?.userContextNotes;
  if (!Array.isArray(notes)) return [];

  return notes
    .map((note: any) => ({
      id: typeof note?.id === "string" ? note.id : undefined,
      text: String(note?.text || "").replace(/\s+/g, " ").trim(),
      createdAt: typeof note?.createdAt === "string" ? note.createdAt : undefined,
      source: typeof note?.source === "string" ? note.source : undefined,
    }))
    .filter((note) => note.text);
}

function selectReconstructedTranscriptForPart(meeting: Meeting, part: MeetingCapturePart): any | null {
  const reconstruction = meeting.detailedSummary?.reconstructedTranscript as any;
  const turns = reconstruction?.turns;
  if (!Array.isArray(turns) || turns.length === 0) return null;

  const partStart = Date.parse(part.startTime);
  const partEnd = Date.parse(part.endTime);
  const meetingTranscriptCount = meeting.transcript?.length || 0;
  const isFullMeetingPart = meetingTranscriptCount > 0 && part.transcript.length >= meetingTranscriptCount * 0.9;

  const selectedTurns = turns.filter((turn: any) => {
    const ts = Number(turn?.startTimestamp);
    if (!Number.isFinite(ts)) return isFullMeetingPart;
    if (!Number.isFinite(partStart) || !Number.isFinite(partEnd)) return true;
    return ts >= partStart - 60_000 && ts <= partEnd + 60_000;
  });

  if (!selectedTurns.length) return null;

  return {
    generatedAt: reconstruction.generatedAt,
    model: reconstruction.model,
    reasoningEffort: reconstruction.reasoningEffort,
    summaryNotes: Array.isArray(reconstruction.summaryNotes) ? reconstruction.summaryNotes : [],
    speakerMap: Array.isArray(reconstruction.speakerMap) ? reconstruction.speakerMap : [],
    turns: selectedTurns,
  };
}

function summarizePart(meeting: Meeting, transcript: TranscriptSegment[], keywords: string[], singlePart: boolean): string {
  const overview = typeof meeting.detailedSummary?.overview === "string" ? meeting.detailedSummary.overview.trim() : "";
  if (singlePart && overview) return overview;
  if (singlePart && meeting.summary && !/^see detailed summary$/i.test(meeting.summary)) return meeting.summary;
  const top = keywords.length ? `Primary signals: ${keywords.join(", ")}.` : "Natively preserved the raw transcript for follow-up processing.";
  const first = transcript.find((segment) => segment.text?.trim())?.text?.replace(/\s+/g, " ").trim();
  return first ? `${top} Opening context: ${first.slice(0, 220)}${first.length > 220 ? "..." : ""}` : top;
}

function extractKeyPoints(meeting: Meeting, transcript: TranscriptSegment[], singlePart: boolean): string[] {
  if (singlePart && Array.isArray(meeting.detailedSummary?.keyPoints) && meeting.detailedSummary.keyPoints.length) {
    return meeting.detailedSummary.keyPoints.slice(0, 8);
  }
  return extractRepresentativeLines(transcript, 6);
}

function extractActionItems(meeting: Meeting, transcript: TranscriptSegment[], singlePart: boolean): string[] {
  if (singlePart && Array.isArray(meeting.detailedSummary?.actionItems) && meeting.detailedSummary.actionItems.length) {
    return meeting.detailedSummary.actionItems.slice(0, 8);
  }

  return transcript
    .map((segment) => segment.text.replace(/\s+/g, " ").trim())
    .filter((text) => /\b(need to|follow up|send|schedule|confirm|review|check|ask|circle back|next step|todo|to do)\b/i.test(text))
    .slice(0, 8);
}

function extractRepresentativeLines(transcript: TranscriptSegment[], limit: number): string[] {
  const lines = transcript
    .map((segment) => segment.text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 35);
  const terms = topKeywords(lines.join(" "), 12);
  const scored = lines.map((text, index) => ({
    text,
    index,
    score: terms.reduce((total, term) => total + (text.toLowerCase().includes(term) ? 1 : 0), 0) + Math.min(2, text.length / 180),
  }));
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text.slice(0, 260));
}

function findBestCalendarEventForRange(
  meeting: Meeting,
  startMs: number,
  endMs: number,
  events: CalendarEvent[]
): CalendarEvent | undefined {
  let best: { event: CalendarEvent; score: number } | null = null;

  for (const event of events) {
    if (meeting.calendarEventId && event.id === meeting.calendarEventId) return event;

    const eventStart = Date.parse(event.startTime || "");
    const eventEnd = Date.parse(event.endTime || "");
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) continue;
    const overlap = Math.max(0, Math.min(endMs, eventEnd) - Math.max(startMs, eventStart));
    const overlapMinutes = overlap / 60_000;
    const distanceMinutes = Math.abs(startMs - eventStart) / 60_000;
    const titleScore = tokenSimilarity(meeting.title || "", event.title || "") * 30;
    const score = Math.min(70, overlapMinutes * 2) + titleScore + Math.max(0, 20 - distanceMinutes / 3);

    if (!best || score > best.score) {
      best = { event, score };
    }
  }

  return best && best.score >= 35 ? best.event : undefined;
}

function topKeywords(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) {
    if (STOPWORDS.has(match)) continue;
    counts.set(match, (counts.get(match) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTerms = new Set(topKeywords(left, 80));
  const rightTerms = new Set(topKeywords(right, 80));
  if (!leftTerms.size || !rightTerms.size) return 0;
  let intersection = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) intersection += 1;
  }
  return intersection / Math.max(leftTerms.size, rightTerms.size);
}

function titleFromKeywords(keywords: string[]): string {
  if (!keywords.length) return "Session Segment";
  return keywords.slice(0, 4).map((term) => term.charAt(0).toUpperCase() + term.slice(1)).join(" ");
}

function resolveMeetingStartMs(meeting: Meeting): number {
  const transcript = meeting.transcript || [];
  const firstTranscriptTs = transcript.map((segment) => segment.timestamp).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (firstTranscriptTs) return firstTranscriptTs;
  const parsedDate = Date.parse(meeting.date || "");
  return Number.isFinite(parsedDate) ? parsedDate : Date.now();
}

function resolveTranscriptDurationMs(transcript: TranscriptSegment[]): number {
  const timestamps = transcript.map((segment) => segment.timestamp).filter(Number.isFinite).sort((a, b) => a - b);
  if (timestamps.length < 2) return 0;
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

function parseDurationMs(duration: string | undefined): number {
  if (!duration) return 0;
  const parts = duration.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  if (parts.length === 3) return (((parts[0] * 60) + parts[1]) * 60 + parts[2]) * 1000;
  return 0;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

function datePrefix(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeSpeaker(speaker: string): string {
  if (speaker === "user") return "Steve";
  if (speaker === "external") return "Meeting";
  return speaker || "Speaker";
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safePathSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return segment || "untitled";
}

function writeTextFile(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function toBrainPath(filePath: string): string {
  return path.relative(BRAIN_ROOT, filePath).replace(/\\/g, "/");
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonObject(filePath: string): Record<string, any> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return recordValue(parsed);
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function extractArray(value: unknown, keys: string[]): Record<string, any>[] {
  const record = recordValue(value);
  if (!record) return [];
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate.filter((item) => !!recordValue(item)) as Record<string, any>[];
    }
  }
  return [];
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function escapeMarkdownTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
