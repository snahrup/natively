import fs from "node:fs";
import path from "node:path";
import type { LLMHelper } from "../LLMHelper";
import { DatabaseManager, type Meeting, type MeetingTranscriptReconstruction } from "../db/DatabaseManager";
import type { RAGManager } from "../rag/RAGManager";
import { buildMeetingAnalysisContext, cleanTranscriptForAnalysis } from "./TranscriptCleanupService";
import { reconstructTranscriptWithCodex } from "./TranscriptReconstructionService";
import { generateMeetingTitleWithCodex, isPlaceholderMeetingTitle } from "./MeetingTitleService";
import { NotebookLmMeetingArtifactService } from "./NotebookLmMeetingArtifactService";

interface BackfillOptions {
  maxMeetings?: number;
  delayMs?: number;
  minTranscriptChars?: number;
}

interface SummaryPayload {
  overview?: string;
  keyPoints?: string[];
  actionItems?: string[];
}

const DEFAULT_MAX_MEETINGS = 12;
const DEFAULT_DELAY_MS = 20_000;
const DEFAULT_MIN_TRANSCRIPT_CHARS = 600;
const MIN_ARTIFACT_DURATION_MS = 10 * 60 * 1000;
const IP_CORP_BRAIN_ROOT = "C:\\Users\\snahrup\\CascadeProjects\\ipcorp-architecture-brain";
const NOTEBOOKLM_ARTIFACT_ROOT = path.join(IP_CORP_BRAIN_ROOT, "natively", "meeting-infographics");

export class MeetingTranscriptBackfillService {
  private static instance: MeetingTranscriptBackfillService;
  private running = false;
  private scheduled = false;

  public static getInstance(): MeetingTranscriptBackfillService {
    if (!MeetingTranscriptBackfillService.instance) {
      MeetingTranscriptBackfillService.instance = new MeetingTranscriptBackfillService();
    }
    return MeetingTranscriptBackfillService.instance;
  }

  public schedule(
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null },
    options: BackfillOptions = {}
  ): void {
    if (this.scheduled || this.running) return;
    this.scheduled = true;

    setTimeout(() => {
      this.scheduled = false;
      void this.run(deps, options).catch((error) => {
        console.warn("[MeetingTranscriptBackfillService] Backfill failed:", error?.message || error);
      });
    }, options.delayMs ?? DEFAULT_DELAY_MS);
  }

  public async run(
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null },
    options: BackfillOptions = {}
  ): Promise<{ scanned: number; processed: number; skipped: number; failed: number }> {
    if (this.running) {
      return { scanned: 0, processed: 0, skipped: 0, failed: 0 };
    }

    this.running = true;
    const db = DatabaseManager.getInstance();
    const maxMeetings = options.maxMeetings ?? DEFAULT_MAX_MEETINGS;
    const minTranscriptChars = options.minTranscriptChars ?? DEFAULT_MIN_TRANSCRIPT_CHARS;
    let scanned = 0;
    let processed = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const candidates = db
        .getAllMeetingIds()
        .map((id) => db.getMeetingDetails(id))
        .filter((meeting): meeting is Meeting => Boolean(meeting))
        .filter((meeting) => {
          scanned += 1;
          return shouldBackfillMeeting(meeting, minTranscriptChars) || shouldQueueNotebookLmArtifact(meeting, minTranscriptChars);
        })
        .slice(0, maxMeetings);

      if (candidates.length === 0) {
        console.log(`[MeetingTranscriptBackfillService] No prior meetings need transcript reconstruction. Scanned ${scanned}.`);
        return { scanned, processed, skipped, failed };
      }

      console.log(`[MeetingTranscriptBackfillService] Reconstructing ${candidates.length} prior meeting transcript(s).`);

      for (const meeting of candidates) {
        try {
          const existingReconstruction = meeting.detailedSummary?.reconstructedTranscript || null;
          const reconstruction = existingReconstruction || await reconstructTranscriptWithCodex(deps.llmHelper, meeting);
          if (!reconstruction) {
            skipped += 1;
            continue;
          }

          const meetingWithReconstruction = {
            ...meeting,
            detailedSummary: {
              ...(meeting.detailedSummary || { actionItems: [], keyPoints: [] }),
              reconstructedTranscript: reconstruction,
            },
          };
          const updates = existingReconstruction
            ? {}
            : await buildSummaryUpdates(deps.llmHelper, meeting, reconstruction);
          const generatedTitle = isPlaceholderMeetingTitle(meeting.title)
            ? await generateMeetingTitleWithCodex(deps.llmHelper, meetingWithReconstruction)
            : null;

          if (!existingReconstruction || generatedTitle) {
            db.updateMeetingSummary(meeting.id, {
              ...updates,
              reconstructedTranscript: reconstruction,
              transcriptCleanup: buildCleanupMetadata(meeting),
              contextOverview: undefined,
            });
          }

          if (generatedTitle) {
            db.updateMeetingTitle(meeting.id, generatedTitle);
          }

          NotebookLmMeetingArtifactService.getInstance().queueMeetingInfographic({
            ...meetingWithReconstruction,
            title: generatedTitle || meeting.title,
            summary: updates.overview || meeting.summary,
            detailedSummary: {
              ...meetingWithReconstruction.detailedSummary,
              ...updates,
              reconstructedTranscript: reconstruction,
              transcriptCleanup: buildCleanupMetadata(meeting),
              contextOverview: undefined,
            },
            isProcessed: true,
          }, parseMeetingDurationMs(meeting.duration));

          if (deps.ragManager) {
            await deps.ragManager.reprocessMeeting(meeting.id).catch((error) => {
              console.warn(`[MeetingTranscriptBackfillService] RAG reprocess failed for ${meeting.id}:`, error?.message || error);
            });
          }

          processed += 1;
          console.log(`[MeetingTranscriptBackfillService] Reconstructed prior meeting ${meeting.id} (${generatedTitle || meeting.title}).`);
        } catch (error) {
          failed += 1;
          console.warn(`[MeetingTranscriptBackfillService] Failed to reconstruct meeting ${meeting.id}:`, error);
        }
      }

      return { scanned, processed, skipped, failed };
    } finally {
      this.running = false;
    }
  }
}

function shouldBackfillMeeting(meeting: Meeting, minTranscriptChars: number): boolean {
  if (!meeting?.id || meeting.id === "demo-meeting") return false;
  if (meeting.isProcessed === false) return false;
  if (meeting.source && meeting.source !== "manual" && meeting.source !== "calendar") return false;
  if (!meeting.transcript || meeting.transcript.length < 3) return false;
  if (/^processing/i.test(meeting.title || "")) return false;
  const charCount = meeting.transcript.reduce((total, segment) => total + String(segment.text || "").length, 0);
  if (charCount < minTranscriptChars) return false;
  return !meeting.detailedSummary?.reconstructedTranscript?.turns?.length || isPlaceholderMeetingTitle(meeting.title);
}

function shouldQueueNotebookLmArtifact(meeting: Meeting, minContentChars: number): boolean {
  if (!meeting?.id || meeting.id === "demo-meeting") return false;
  if (meeting.isProcessed === false) return false;
  if (meeting.source && meeting.source !== "manual" && meeting.source !== "calendar") return false;
  if (parseMeetingDurationMs(meeting.duration) < MIN_ARTIFACT_DURATION_MS) return false;
  if (countMeetingContentChars(meeting) < minContentChars) return false;
  return !hasCompletedNotebookLmArtifact(meeting.id);
}

function countMeetingContentChars(meeting: Meeting): number {
  const summaryChars = [
    meeting.summary,
    meeting.detailedSummary?.overview,
    ...(meeting.detailedSummary?.keyPoints || []),
    ...(meeting.detailedSummary?.actionItems || []),
  ].join(" ").length;
  const transcriptChars = (meeting.transcript || []).reduce((total, segment) => total + String(segment.text || "").length, 0);
  return summaryChars + transcriptChars;
}

function hasCompletedNotebookLmArtifact(meetingId: string): boolean {
  if (!fs.existsSync(NOTEBOOKLM_ARTIFACT_ROOT)) return false;
  const idSuffix = meetingId.slice(0, 8);
  const dirs = fs.readdirSync(NOTEBOOKLM_ARTIFACT_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(idSuffix))
    .map((entry) => path.join(NOTEBOOKLM_ARTIFACT_ROOT, entry.name));

  for (const dir of dirs) {
    const statusPath = path.join(dir, "status.json");
    if (!fs.existsSync(statusPath)) continue;
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
      if (status?.status === "completed" && (!status.infographicPath || fs.existsSync(status.infographicPath))) {
        return true;
      }
    } catch {
      // Ignore malformed artifact status and let the artifact be regenerated.
    }
  }

  return false;
}

function parseMeetingDurationMs(duration: string | null | undefined): number {
  const parts = String(duration || "")
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));

  if (parts.length === 3) return ((parts[0] * 60 * 60) + (parts[1] * 60) + parts[2]) * 1000;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  if (parts.length === 1) return parts[0] * 60 * 1000;
  return 0;
}

async function buildSummaryUpdates(
  llmHelper: LLMHelper,
  meeting: Meeting,
  reconstruction: MeetingTranscriptReconstruction
): Promise<SummaryPayload> {
  const context = buildMeetingAnalysisContext({
    ...meeting,
    detailedSummary: {
      ...(meeting.detailedSummary || { actionItems: [], keyPoints: [] }),
      reconstructedTranscript: reconstruction,
    },
  }, { maxChars: 30_000 });

  const systemPrompt = [
    "You write concise internal meeting notes from a reconstructed transcript.",
    "Use only the supplied meeting context.",
    "User-supplied context is authoritative.",
    "Do not mention transcripts, AI, reconstruction, or missing data.",
    "Return strict JSON only.",
  ].join("\n");

  const userPrompt = [
    context,
    "",
    "Return this JSON shape:",
    JSON.stringify({
      overview: "1-2 sentence description of what was actually discussed",
      keyPoints: ["3-8 specific concrete bullets"],
      actionItems: ["specific next steps or implied follow-ups; empty array if none"],
    }),
  ].join("\n");

  const raw = await llmHelper.generateWithLocalCodex(userPrompt, systemPrompt, "gpt-5.5", "xhigh");
  return sanitizeSummaryPayload(parseSummaryPayload(raw));
}

function buildCleanupMetadata(meeting: Meeting): NonNullable<Meeting["detailedSummary"]>["transcriptCleanup"] {
  const cleaned = cleanTranscriptForAnalysis(meeting.transcript || [], { maxChars: 30_000 });
  return {
    rawSegments: cleaned.stats.rawSegments,
    cleanTurns: cleaned.stats.cleanTurns,
    rawCharacters: cleaned.stats.rawCharacters,
    cleanCharacters: cleaned.stats.cleanCharacters,
    compressionRatio: cleaned.stats.compressionRatio,
    generatedAt: new Date().toISOString(),
    strategy: "gpt-5.5-xhigh-reconstruction-backfill",
  };
}

function parseSummaryPayload(raw: string): SummaryPayload | null {
  const cleaned = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as SummaryPayload;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as SummaryPayload;
    } catch {
      return null;
    }
  }
}

function sanitizeSummaryPayload(payload: SummaryPayload | null): SummaryPayload {
  return {
    overview: compactWhitespace(payload?.overview || ""),
    keyPoints: sanitizeList(payload?.keyPoints, 8),
    actionItems: sanitizeList(payload?.actionItems, 8),
  };
}

function sanitizeList(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => compactWhitespace(String(value || "")))
    .filter(Boolean)
    .slice(0, limit);
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
