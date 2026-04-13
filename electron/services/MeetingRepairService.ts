import { DatabaseManager, type Meeting } from "../db/DatabaseManager";
import type { RAGManager } from "../rag/RAGManager";
import { MicrosoftLocalManager } from "./MicrosoftLocalManager";
import type { OutlookCalendarEvent } from "./MicrosoftLocalTypes";

type MeetingTranscriptSegment = NonNullable<Meeting["transcript"]>[number];

interface TeamsTranscriptCandidate {
  chatId: string;
  meetingTitle: string;
  date?: string;
  hasTranscript: boolean;
}

interface ParsedTranscript {
  segments: MeetingTranscriptSegment[];
  explicitTimestampCount: number;
  explicitTimestamps: number[];
}

export interface MeetingRepairOptions {
  meetingIds?: string[];
  limit?: number;
  allowOutlook?: boolean;
  allowTeams?: boolean;
  force?: boolean;
  ragManager?: RAGManager | null;
}

export interface MeetingRepairItemResult {
  meetingId: string;
  title: string;
  status: "updated" | "skipped" | "failed";
  reason?: string;
  repairedDuration: boolean;
  repairedTranscript: boolean;
  matchedOutlook?: {
    subject: string;
    start: string;
    score: number;
  };
  matchedTeamsTranscript?: {
    meetingTitle: string;
    score: number;
  };
  transcriptSegments: number;
  duration: string;
}

export interface MeetingRepairResult {
  scanned: number;
  candidates: number;
  updated: number;
  durationRecovered: number;
  transcriptRecovered: number;
  outlookMatched: number;
  teamsTranscriptRecovered: number;
  results: MeetingRepairItemResult[];
}

interface TranscriptLookupTarget {
  key: string;
  meetingTitle: string;
  score: number;
  artifact?: string;
  source: "teams-chat" | "teams-title" | "outlook-subject";
}

export class MeetingRepairService {
  public async repairImportedMeetings(options: MeetingRepairOptions = {}): Promise<MeetingRepairResult> {
    const dbManager = DatabaseManager.getInstance();
    if (!dbManager.isReady()) {
      throw new Error(dbManager.getInitError() || "SQLite persistence is unavailable.");
    }

    const meetings = this.loadMeetings(dbManager, options.meetingIds, options.limit);
    const candidates = meetings.filter((meeting) => this.shouldRepairMeeting(meeting, !!options.force));

    const microsoftLocal = MicrosoftLocalManager.getInstance();
    await microsoftLocal.start().catch(() => {});
    await microsoftLocal.refreshConnections().catch(() => {});

    const outlookEvents = options.allowOutlook === false
      ? []
      : await this.prefetchOutlookEvents(microsoftLocal, candidates);
    const teamsCandidates = options.allowTeams === false
      ? []
      : await microsoftLocal.listTeamsMeetingTranscripts();

    const results: MeetingRepairItemResult[] = [];
    let updated = 0;
    let durationRecovered = 0;
    let transcriptRecovered = 0;
    let outlookMatched = 0;
    let teamsTranscriptRecovered = 0;

    for (const meeting of candidates) {
      const result = await this.repairMeeting(meeting, {
        outlookEvents,
        teamsCandidates,
        microsoftLocal,
        ragManager: options.ragManager || null,
      });
      results.push(result);

      if (result.status === "updated") updated += 1;
      if (result.repairedDuration) durationRecovered += 1;
      if (result.repairedTranscript) transcriptRecovered += 1;
      if (result.matchedOutlook) outlookMatched += 1;
      if (result.matchedTeamsTranscript) teamsTranscriptRecovered += 1;
    }

    return {
      scanned: meetings.length,
      candidates: candidates.length,
      updated,
      durationRecovered,
      transcriptRecovered,
      outlookMatched,
      teamsTranscriptRecovered,
      results,
    };
  }

  private loadMeetings(dbManager: DatabaseManager, meetingIds?: string[], limit?: number): Meeting[] {
    const ids = meetingIds?.length
      ? meetingIds
      : dbManager.getAllMeetingIds();

    const meetings = ids
      .map((meetingId) => dbManager.getMeetingDetails(meetingId))
      .filter((meeting): meeting is Meeting => !!meeting);

    return typeof limit === "number" && limit > 0
      ? meetings.slice(0, limit)
      : meetings;
  }

  private shouldRepairMeeting(meeting: Meeting, force: boolean): boolean {
    if (force) return true;
    if (meeting.source !== "imported") return false;
    return this.needsTranscriptRepair(meeting) || this.needsDurationRepair(meeting);
  }

  private needsDurationRepair(meeting: Meeting): boolean {
    return parseDurationMs(meeting.duration) <= 0;
  }

  private needsTranscriptRepair(meeting: Meeting): boolean {
    const transcript = meeting.transcript || [];
    if (transcript.length === 0) return true;

    const namedSpeakers = transcript.filter((segment) => !isGenericSpeaker(segment.speaker)).length;
    return namedSpeakers === 0 && transcript.length < 4;
  }

  private async prefetchOutlookEvents(
    microsoftLocal: MicrosoftLocalManager,
    meetings: Meeting[]
  ): Promise<OutlookCalendarEvent[]> {
    if (meetings.length === 0) return [];

    const validDates = meetings
      .map((meeting) => new Date(meeting.date))
      .filter((date) => !Number.isNaN(date.getTime()));

    if (validDates.length === 0) return [];

    const minDate = new Date(Math.min(...validDates.map((date) => date.getTime())));
    const maxDate = new Date(Math.max(...validDates.map((date) => date.getTime())));
    minDate.setDate(minDate.getDate() - 3);
    maxDate.setDate(maxDate.getDate() + 3);

    return microsoftLocal.getOutlookCalendarEventsInRange(minDate.toISOString(), maxDate.toISOString());
  }

  private async repairMeeting(
    meeting: Meeting,
    context: {
      outlookEvents: OutlookCalendarEvent[];
      teamsCandidates: TeamsTranscriptCandidate[];
      microsoftLocal: MicrosoftLocalManager;
      ragManager: RAGManager | null;
    }
  ): Promise<MeetingRepairItemResult> {
    try {
      const originalDurationMs = parseDurationMs(meeting.duration);
      const originalTranscript = meeting.transcript || [];
      const originalTranscriptCount = originalTranscript.length;

      const outlookMatch = this.findBestOutlookMatch(meeting, context.outlookEvents);
      const teamsMatch = this.findBestTeamsTranscriptCandidate(meeting, context.teamsCandidates);

      let mergedMeeting: Meeting = {
        ...meeting,
        detailedSummary: {
          actionItems: meeting.detailedSummary?.actionItems || [],
          keyPoints: meeting.detailedSummary?.keyPoints || [],
          ...meeting.detailedSummary,
        },
        importMetadata: {
          ...meeting.importMetadata,
        },
      };

      if (outlookMatch) {
        mergedMeeting = this.applyOutlookMatch(mergedMeeting, outlookMatch.event);
      }

      let repairedTranscript = false;
      let transcriptDurationMs = 0;
      let repairedDuration = parseDurationMs(mergedMeeting.duration) > originalDurationMs;
      let matchedTranscriptLookup: TranscriptLookupTarget | null = null;

      if (this.needsTranscriptRepair(mergedMeeting)) {
        const transcriptTargets = this.buildTranscriptLookupTargets(mergedMeeting, outlookMatch, teamsMatch);
        for (const target of transcriptTargets) {
          const transcriptResult = await context.microsoftLocal.getTeamsMeetingTranscript(target.key);
          if (!transcriptResult.success || !transcriptResult.transcript?.trim()) {
            continue;
          }

          const parsedTranscript = parseTranscript(transcriptResult.transcript);
          if (parsedTranscript.segments.length === 0 || !isTranscriptUpgrade(mergedMeeting.transcript || [], parsedTranscript.segments)) {
            continue;
          }

          mergedMeeting.transcript = parsedTranscript.segments;
          mergedMeeting.importMetadata = {
            ...mergedMeeting.importMetadata,
            transcriptRecoveredFrom: "teams",
            enrichmentSources: dedupeStrings([
              ...(mergedMeeting.importMetadata?.enrichmentSources || []),
              "teams-transcript",
              target.source === "outlook-subject" ? "teams-transcript-via-outlook" : "",
            ]),
            relatedArtifacts: dedupeStrings([
              ...(mergedMeeting.importMetadata?.relatedArtifacts || []),
              target.artifact || "",
            ]),
          };
          repairedTranscript = true;
          matchedTranscriptLookup = {
            ...target,
            meetingTitle: transcriptResult.meetingTitle || target.meetingTitle,
          };

          if (parsedTranscript.explicitTimestampCount >= 2) {
            transcriptDurationMs = estimateDurationFromExplicitTimestamps(parsedTranscript.explicitTimestamps);
            if (transcriptDurationMs > parseDurationMs(mergedMeeting.duration)) {
              mergedMeeting.duration = formatDuration(transcriptDurationMs);
              repairedDuration = true;
            }
          }

          break;
        }
      }

      const finalDurationMs = this.resolvePersistedDurationMs(mergedMeeting, outlookMatch?.event, transcriptDurationMs);
      const finalStartTimeMs = resolveStartTimeMs(mergedMeeting.date, outlookMatch?.event?.start);

      const changed =
        repairedTranscript ||
        repairedDuration ||
        (finalDurationMs > 0 && finalDurationMs !== originalDurationMs) ||
        !!outlookMatch;

      if (!changed) {
        return {
          meetingId: meeting.id,
          title: meeting.title,
          status: "skipped",
          reason: "No stronger Outlook or Teams match was available.",
          repairedDuration: false,
          repairedTranscript: false,
          transcriptSegments: originalTranscriptCount,
          duration: meeting.duration,
        };
      }

      DatabaseManager.getInstance().saveMeeting(mergedMeeting, finalStartTimeMs, finalDurationMs);

      if (repairedTranscript && context.ragManager) {
        await context.ragManager.reprocessMeeting(meeting.id).catch((error) => {
          console.warn(`[MeetingRepairService] Failed to reprocess repaired meeting ${meeting.id}:`, error);
        });
      }

      return {
        meetingId: meeting.id,
        title: mergedMeeting.title,
        status: "updated",
        repairedDuration: finalDurationMs > originalDurationMs,
        repairedTranscript,
        matchedOutlook: outlookMatch ? {
          subject: outlookMatch.event.subject,
          start: outlookMatch.event.start,
          score: outlookMatch.score,
        } : undefined,
        matchedTeamsTranscript: repairedTranscript && matchedTranscriptLookup ? {
          meetingTitle: matchedTranscriptLookup.meetingTitle,
          score: matchedTranscriptLookup.score,
        } : undefined,
        transcriptSegments: mergedMeeting.transcript?.length || 0,
        duration: mergedMeeting.duration,
      };
    } catch (error: any) {
      return {
        meetingId: meeting.id,
        title: meeting.title,
        status: "failed",
        reason: error?.message || String(error),
        repairedDuration: false,
        repairedTranscript: false,
        transcriptSegments: meeting.transcript?.length || 0,
        duration: meeting.duration,
      };
    }
  }

  private applyOutlookMatch(meeting: Meeting, event: OutlookCalendarEvent): Meeting {
    return {
      ...meeting,
      date: event.start || meeting.date,
      duration: event.duration > 0 ? formatDuration(event.duration * 60_000) : meeting.duration,
      calendarEventId: event.entryId || meeting.calendarEventId,
      importMetadata: {
        ...meeting.importMetadata,
        matchedCalendarEventId: event.entryId,
        matchedCalendarSubject: event.subject,
        calendarOrganizer: event.organizer || meeting.importMetadata?.calendarOrganizer,
        calendarAttendees: dedupeStrings([
          ...(meeting.importMetadata?.calendarAttendees || []),
          ...event.attendees
            .map((attendee) => attendee.name || attendee.email)
            .filter(Boolean),
        ]),
        enrichmentSources: dedupeStrings([
          ...(meeting.importMetadata?.enrichmentSources || []),
          "outlook-calendar",
        ]),
        relatedArtifacts: dedupeStrings([
          ...(meeting.importMetadata?.relatedArtifacts || []),
          `outlook:event:${event.entryId}`,
        ]),
      },
    };
  }

  private resolvePersistedDurationMs(meeting: Meeting, matchedEvent?: OutlookCalendarEvent, transcriptDurationMs = 0): number {
    if (transcriptDurationMs > 0) {
      return transcriptDurationMs;
    }

    if (matchedEvent?.duration && matchedEvent.duration > 0) {
      return matchedEvent.duration * 60_000;
    }

    const parsedDurationMs = parseDurationMs(meeting.duration);
    return parsedDurationMs > 0 ? parsedDurationMs : 60 * 60 * 1000;
  }

  private findBestOutlookMatch(
    meeting: Meeting,
    events: OutlookCalendarEvent[]
  ): { event: OutlookCalendarEvent; score: number } | null {
    let best: { event: OutlookCalendarEvent; score: number } | null = null;

    for (const event of events) {
      const score = scoreOutlookEventMatch(meeting, event);
      if (score < 45) continue;
      if (!best || score > best.score) {
        best = { event, score };
      }
    }

    return best;
  }

  private findBestTeamsTranscriptCandidate(
    meeting: Meeting,
    candidates: TeamsTranscriptCandidate[]
  ): (TeamsTranscriptCandidate & { score: number }) | null {
    let best: (TeamsTranscriptCandidate & { score: number }) | null = null;

    for (const candidate of candidates) {
      const score = scoreTitleMatch(meeting.title, candidate.meetingTitle, meeting.date, candidate.date);
      if (score < 50) continue;
      if (!best || score > best.score) {
        best = { ...candidate, score };
      }
    }

    return best;
  }

  private buildTranscriptLookupTargets(
    meeting: Meeting,
    outlookMatch: { event: OutlookCalendarEvent; score: number } | null,
    teamsMatch: (TeamsTranscriptCandidate & { score: number }) | null,
  ): TranscriptLookupTarget[] {
    const targets: TranscriptLookupTarget[] = [];
    const seen = new Set<string>();

    const pushTarget = (target: TranscriptLookupTarget | null) => {
      if (!target?.key) return;
      const normalizedKey = normalizeMatchString(target.key);
      if (!normalizedKey || seen.has(normalizedKey)) return;
      seen.add(normalizedKey);
      targets.push(target);
    };

    if (teamsMatch) {
      pushTarget({
        key: teamsMatch.chatId,
        meetingTitle: teamsMatch.meetingTitle,
        score: teamsMatch.score,
        artifact: `teams:chat:${teamsMatch.chatId}`,
        source: "teams-chat",
      });
      pushTarget({
        key: teamsMatch.meetingTitle,
        meetingTitle: teamsMatch.meetingTitle,
        score: Math.max(teamsMatch.score - 3, 0),
        artifact: `teams:meeting:${normalizeMatchString(teamsMatch.meetingTitle).replace(/\s+/g, "-")}`,
        source: "teams-title",
      });
    }

    if (outlookMatch?.event.subject) {
      pushTarget({
        key: outlookMatch.event.subject,
        meetingTitle: outlookMatch.event.subject,
        score: Math.max(outlookMatch.score - 5, 0),
        artifact: outlookMatch.event.entryId ? `outlook:event:${outlookMatch.event.entryId}` : undefined,
        source: "outlook-subject",
      });
    }

    if (!targets.length && tokenize(meeting.title).size >= 2) {
      pushTarget({
        key: meeting.title,
        meetingTitle: meeting.title,
        score: 25,
        source: "teams-title",
      });
    }

    return targets;
  }
}

function tokenize(value: string): Set<string> {
  return new Set(
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
  );
}

function scoreOutlookEventMatch(meeting: Meeting, event: OutlookCalendarEvent): number {
  if (/^(updated invitation with note:|canceled:|accepted:|declined:)/i.test(event.subject || "")) {
    return 0;
  }

  const meetingDate = new Date(meeting.date || "");
  const eventDate = new Date(event.start || "");
  if (!Number.isNaN(meetingDate.getTime()) && !Number.isNaN(eventDate.getTime())) {
    const deltaMs = Math.abs(meetingDate.getTime() - eventDate.getTime());
    if (deltaMs > 10 * 24 * 60 * 60 * 1000) {
      return 0;
    }
  }

  const titleScore = scoreTitleMatch(meeting.title, event.subject, meeting.date, event.start);
  const summarySubjectScore = scoreTitleMatch(meeting.summary || "", event.subject, meeting.date, event.start);
  const subjectOverlap = [...tokenize(buildMeetingCorpus(meeting))].filter((token) => tokenize(event.subject).has(token)).length;
  const meetingPeople = tokenizePersonContext([
    meeting.title,
    meeting.summary,
    meeting.detailedSummary?.overview,
  ].filter(Boolean).join(" "));
  const eventPeople = tokenizePersonContext([
    event.organizer,
    ...event.attendees.map((attendee) => attendee.name || attendee.email || ""),
  ].join(" "));
  const peopleOverlap = [...meetingPeople].filter((token) => eventPeople.has(token)).length;

  if (event.isRecurring && titleScore < 60 && subjectOverlap < 2 && peopleOverlap < 2) {
    return 0;
  }

  // Do not accept calendar fallbacks driven only by same-day coincidence.
  if (titleScore < 50 && subjectOverlap === 0 && peopleOverlap === 0) {
    return 0;
  }

  let score = titleScore;
  score += Math.min(18, Math.round(summarySubjectScore * 0.3));
  score += peopleOverlap * 6;

  // Body text is only trustworthy when the title/participants already provide a real anchor.
  if (titleScore >= 50 || subjectOverlap >= 2 || peopleOverlap > 0) {
    score += Math.min(12, scoreTokenOverlap(buildMeetingCorpus(meeting), event.body || ""));
  }

  if ((event.location || "").toLowerCase().includes("teams")) {
    score += 2;
  }

  return score;
}

function scoreTitleMatch(meetingTitle: string, candidateTitle: string, meetingDate?: string, candidateDate?: string): number {
  const left = normalizeMatchString(meetingTitle);
  const right = normalizeMatchString(candidateTitle);
  if (!left || !right) return 0;

  let score = 0;
  if (left === right) score += 70;
  if (left.includes(right) || right.includes(left)) score += 20;

  const leftTokens = tokenize(meetingTitle);
  const rightTokens = tokenize(candidateTitle);
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  score += overlap * 12;

  const leftSize = leftTokens.size || 1;
  const rightSize = rightTokens.size || 1;
  const overlapRatio = overlap / Math.max(leftSize, rightSize);
  if (overlapRatio >= 0.75) score += 15;
  else if (overlapRatio >= 0.5) score += 8;

  const leftDate = new Date(meetingDate || "");
  const rightDate = new Date(candidateDate || "");
  if (!Number.isNaN(leftDate.getTime()) && !Number.isNaN(rightDate.getTime())) {
    const delta = Math.abs(leftDate.getTime() - rightDate.getTime());
    if (sameLocalDay(leftDate, rightDate)) score += 35;
    else if (delta <= 12 * 60 * 60 * 1000) score += 22;
    else if (delta <= 36 * 60 * 60 * 1000) score += 12;
    else if (delta <= 72 * 60 * 60 * 1000) score += 6;
  }

  return score;
}

function normalizeMatchString(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildMeetingCorpus(meeting: Meeting): string {
  return [
    meeting.title,
    meeting.summary,
    meeting.detailedSummary?.overview,
    ...(meeting.detailedSummary?.keyPoints || []),
    ...(meeting.detailedSummary?.actionItems || []),
  ]
    .filter(Boolean)
    .join(" ");
}

function tokenizePersonContext(value: string): Set<string> {
  return new Set(
    [...tokenize(value)].filter((token) => !LOW_SIGNAL_PERSON_TOKENS.has(token))
  );
}

function scoreTokenOverlap(leftText: string, rightText: string): number {
  const leftTokens = tokenize(leftText);
  const rightTokens = tokenize(rightText);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (overlap === 0) return 0;

  let score = overlap * 4;
  const overlapRatio = overlap / Math.max(leftTokens.size, rightTokens.size);
  if (overlapRatio >= 0.5) score += 12;
  else if (overlapRatio >= 0.3) score += 7;

  return score;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function parseTranscript(rawTranscript: string): ParsedTranscript {
  const speakerParsed = parseSpeakerTranscript(rawTranscript);
  if (isStructuredParsedTranscript(speakerParsed)) {
    return speakerParsed;
  }

  const paragraphs = String(rawTranscript || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => cleanLine(stripInlineArtifacts(line)))
    .filter(Boolean)
    .map((text, index) => ({
      speaker: "Transcript",
      text,
      timestamp: index * 15_000,
    }));

  return {
    segments: paragraphs,
    explicitTimestampCount: 0,
    explicitTimestamps: [],
  };
}

function isStructuredParsedTranscript(parsedTranscript: ParsedTranscript): boolean {
  if (!parsedTranscript.segments.length) return false;
  if (parsedTranscript.explicitTimestampCount >= 1) return true;
  if (parsedTranscript.segments.length >= 2) return true;
  return parsedTranscript.segments.some((segment) => !isGenericSpeaker(segment.speaker));
}

function parseSpeakerTranscript(transcriptText: string): ParsedTranscript {
  const lines = expandInlineSpeakerTransitions(transcriptText).split(/\r?\n/);
  const rawSegments: Array<{ speaker: string; text: string; timestamp: number | null }> = [];
  let current: { speaker: string; text: string; timestamp: number | null } | null = null;
  let explicitTimestampCount = 0;
  const explicitTimestamps: number[] = [];

  for (const rawLine of lines) {
    const line = cleanLine(stripInlineArtifacts(rawLine));
    if (!line) continue;

    const parsedLine = parseSpeakerLine(line);

    if (parsedLine) {
      if (current && current.text.trim()) {
        rawSegments.push(current);
      }

      const parsedTimestamp = parsedLine.timestampToken
        ? parseTimestampToMs(parsedLine.timestampToken)
        : null;

      if (parsedTimestamp !== null) {
        explicitTimestampCount += 1;
        explicitTimestamps.push(parsedTimestamp);
      }

      current = {
        speaker: cleanSpeaker(parsedLine.speaker || "Transcript"),
        timestamp: parsedTimestamp,
        text: cleanLine(parsedLine.text || ""),
      };
      continue;
    }

    if (!current) {
      current = {
        speaker: "Transcript",
        timestamp: null,
        text: line,
      };
      continue;
    }

    current.text = `${current.text} ${line}`.trim();
  }

  if (current && current.text.trim()) {
    rawSegments.push(current);
  }

  const segments: MeetingTranscriptSegment[] = rawSegments
    .filter((segment) => segment.text)
    .map((segment, index, array) => ({
      speaker: segment.speaker || "Transcript",
      text: segment.text,
      timestamp: segment.timestamp ?? inferFallbackTimestamp(index, array),
    }));

  return { segments, explicitTimestampCount, explicitTimestamps };
}

function parseSpeakerLine(line: string): { speaker: string; timestampToken?: string; text: string } | null {
  const patterns = [
    { regex: /^(.+?)\s+\[\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\]:\s*(.*)$/, speaker: 1, timestamp: 2, text: 3 },
    { regex: /^(.+?)\s+\(\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\):\s*(.*)$/, speaker: 1, timestamp: 2, text: 3 },
    { regex: /^\*\*(.+?)\*\*\s*\*\(([^)]+)\)\*$/, speaker: 1, timestamp: 2, text: 3 },
    { regex: /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+([^:]{2,80}):\s+(.+)$/, speaker: 2, timestamp: 1, text: 3 },
    { regex: /^([^:]{2,80}):\s+(.+)$/, speaker: 1, timestamp: 0, text: 2 },
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern.regex);
    if (!match) continue;
    return {
      speaker: match[pattern.speaker] || "Transcript",
      timestampToken: pattern.timestamp ? match[pattern.timestamp] : undefined,
      text: match[pattern.text] || "",
    };
  }

  return null;
}

function inferFallbackTimestamp(
  index: number,
  segments: Array<{ speaker: string; text: string; timestamp: number | null }>
): number {
  const previousExplicit = [...segments.slice(0, index)]
    .reverse()
    .find((segment) => Number.isFinite(segment.timestamp));

  if (previousExplicit?.timestamp !== null && previousExplicit?.timestamp !== undefined) {
    return previousExplicit.timestamp + ((index + 1) * 15_000);
  }

  return index * 15_000;
}

function estimateDurationFromExplicitTimestamps(explicitTimestamps: number[]): number {
  if (explicitTimestamps.length < 2) {
    return 0;
  }

  const start = Math.min(...explicitTimestamps);
  const end = Math.max(...explicitTimestamps);
  return Math.max(60_000, (end - start) + 60_000);
}

function parseDurationMs(duration: string | undefined): number {
  if (!duration) return 0;
  const parts = duration.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  return 0;
}

function resolveStartTimeMs(meetingDate: string, eventStart?: string): number {
  const eventDate = new Date(eventStart || "");
  if (!Number.isNaN(eventDate.getTime())) {
    return eventDate.getTime();
  }
  const parsedMeetingDate = new Date(meetingDate);
  return Number.isNaN(parsedMeetingDate.getTime()) ? Date.now() : parsedMeetingDate.getTime();
}

function formatDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isTranscriptUpgrade(current: MeetingTranscriptSegment[], incoming: MeetingTranscriptSegment[]): boolean {
  const currentScore = scoreTranscript(current);
  const incomingScore = scoreTranscript(incoming);
  return incomingScore > currentScore;
}

function scoreTranscript(transcript: MeetingTranscriptSegment[]): number {
  if (transcript.length === 0) return 0;

  const uniqueSpeakers = new Set(
    transcript
      .map((segment) => normalizeSpeaker(segment.speaker))
      .filter(Boolean)
  );
  const namedSpeakers = transcript.filter((segment) => !isGenericSpeaker(segment.speaker)).length;
  const charCount = transcript.reduce((total, segment) => total + (segment.text?.length || 0), 0);

  return (
    Math.min(60, transcript.length * 6) +
    Math.min(20, uniqueSpeakers.size * 4) +
    Math.min(20, namedSpeakers * 2) +
    Math.min(20, Math.floor(charCount / 250))
  );
}

function normalizeSpeaker(value: string): string {
  return cleanLine(String(value || "").toLowerCase());
}

function isGenericSpeaker(value: string): boolean {
  return ["transcript", "participant", "unknown", "external", ""].includes(normalizeSpeaker(value));
}

function cleanSpeaker(value: string): string {
  return cleanLine(String(value || "").replace(/^<v\s+|>$/g, ""));
}

function parseTimestampToMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim().replace(/^~/, "");
  const parts = trimmed.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return null;

  let seconds = 0;
  if (parts.length === 3) {
    seconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
  } else if (parts.length === 2) {
    seconds = (parts[0] * 60) + parts[1];
  } else if (parts.length === 1) {
    seconds = parts[0];
  } else {
    return null;
  }

  return seconds * 1000;
}

function expandInlineSpeakerTransitions(text: string): string {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/(\S)\s+([A-Z][A-Za-z0-9.'&/-]*(?:\s+[A-Z][A-Za-z0-9.'&/-]*){0,4})\s*(\[\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\]|\(\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\))\s*:/g, "$1\n$2 $3:")
    .replace(/(\S)\s+(\*\*[^*]+\*\*\s*\*\(\s*(?:\d{1,2}:)?\d{1,2}:\d{2}\s*\)\*)/g, "$1\n$2");
}

function stripInlineArtifacts(text: string): string {
  return String(text || "")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/<mention-user[^>]*><\/mention-user>/g, "")
    .replace(/<mention-page[^>]*>(.*?)<\/mention-page>/g, "$1")
    .replace(/<mention-date[^>]*\/>/g, "")
    .replace(/<empty-block\/>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function cleanLine(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "meeting",
  "session",
  "discussion",
]);

const LOW_SIGNAL_PERSON_TOKENS = new Set([
  "steve",
  "patrick",
  "mike",
]);
