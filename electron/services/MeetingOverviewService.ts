import type { LLMHelper } from "../LLMHelper";
import { ContextRetrievalBroker } from "../context/ContextRetrievalBroker";
import type { ContextRetrievalResult, ScoredContextDocument } from "../context/types";
import {
  DatabaseManager,
  type Meeting,
  type MeetingContextOverview,
  type MeetingContextOverviewEvidence,
} from "../db/DatabaseManager";
import { CalendarManager, type CalendarEvent } from "./CalendarManager";
import { buildMeetingAnalysisContext, cleanTranscriptForAnalysis } from "./TranscriptCleanupService";
import { reconstructTranscriptWithCodex } from "./TranscriptReconstructionService";
import { generateMeetingTitleWithCodex, isPlaceholderMeetingTitle } from "./MeetingTitleService";

const OVERVIEW_MODEL = "gpt-5.5";
const OVERVIEW_REASONING_EFFORT = "xhigh";
const MAX_EVIDENCE_ITEMS = 6;
const MAX_CONTEXT_DOCS = 8;
const RETRIEVAL_WINDOW_MS = 540 * 24 * 60 * 60 * 1000;

interface GenerateMeetingOverviewOptions {
  meetingId: string;
  force?: boolean;
  knowledgeOrchestrator?: any;
  llmHelper: LLMHelper;
}

interface OverviewPayload {
  synopsis?: string;
  significance?: string;
  value?: string;
  continuity?: string[];
  upcomingSignals?: string[];
}

export class MeetingOverviewService {
  static async generate(options: GenerateMeetingOverviewOptions): Promise<MeetingContextOverview> {
    const db = DatabaseManager.getInstance();
    const meeting = resolveMeetingForOverview(db, options.meetingId);
    if (!meeting) {
      throw new Error(`Meeting not found: ${options.meetingId}`);
    }

    const existing = meeting.detailedSummary?.contextOverview;
    if (existing && !options.force) {
      return existing;
    }

    let workingMeeting = meeting;
    if (!workingMeeting.detailedSummary?.reconstructedTranscript && (workingMeeting.transcript?.length || 0) > 5) {
      try {
        const reconstruction = await reconstructTranscriptWithCodex(options.llmHelper, workingMeeting);
        if (reconstruction) {
          workingMeeting = {
            ...workingMeeting,
            detailedSummary: {
              ...workingMeeting.detailedSummary,
              actionItems: workingMeeting.detailedSummary?.actionItems || [],
              keyPoints: workingMeeting.detailedSummary?.keyPoints || [],
              reconstructedTranscript: reconstruction,
              contextOverview: undefined,
            },
          };
          db.updateMeetingSummary(workingMeeting.id, {
            reconstructedTranscript: reconstruction,
            contextOverview: undefined,
          });
        }
      } catch (error) {
        console.warn("[MeetingOverviewService] Transcript reconstruction failed; using cleaned transcript fallback:", error);
      }
    }

    if (isPlaceholderMeetingTitle(workingMeeting.title) && (workingMeeting.transcript?.length || 0) > 2) {
      try {
        const generatedTitle = await generateMeetingTitleWithCodex(options.llmHelper, workingMeeting);
        if (generatedTitle) {
          db.updateMeetingTitle(workingMeeting.id, generatedTitle);
          workingMeeting = { ...workingMeeting, title: generatedTitle };
        }
      } catch (error) {
        console.warn("[MeetingOverviewService] Meeting title generation failed:", error);
      }
    }

    const retrieval = await this.retrieveContext(workingMeeting, options.knowledgeOrchestrator);
    const relatedDocs = selectRelatedDocuments(retrieval, workingMeeting.id);
    const upcomingMatches = await findUpcomingSignals(workingMeeting);

    const systemPrompt = [
      "You write concise executive meeting overviews for a desktop app called Natively.",
      "Use only the provided meeting and context evidence.",
      "Use the cleaned transcript context as the primary source for what happened in the meeting.",
      "Treat user-supplied post-meeting context as authoritative corrections or clarifications.",
      "Explain what the meeting was about, why it mattered, what value it created, and how it connects to prior or upcoming work.",
      "Do not mention AI, transcripts, context engines, or missing data.",
      "Return strict JSON with this shape and no markdown fences:",
      '{"synopsis":"", "significance":"", "value":"", "continuity":[""], "upcomingSignals":[""]}',
    ].join("\n");

    const userPrompt = buildOverviewPrompt(workingMeeting, retrieval, relatedDocs, upcomingMatches);
    const raw = await options.llmHelper.generateWithLocalCodex(
      userPrompt,
      systemPrompt,
      OVERVIEW_MODEL,
      OVERVIEW_REASONING_EFFORT,
    );
    const parsed = sanitizeOverviewPayload(parseOverviewPayload(raw), workingMeeting, relatedDocs, upcomingMatches);

    const overview: MeetingContextOverview = {
      synopsis: parsed.synopsis!,
      significance: parsed.significance!,
      value: parsed.value!,
      continuity: parsed.continuity!,
      upcomingSignals: parsed.upcomingSignals!,
      evidence: buildEvidence(retrieval, relatedDocs, upcomingMatches),
      generatedAt: new Date().toISOString(),
      confidence: retrieval.confidence,
      model: OVERVIEW_MODEL,
    };

    db.updateMeetingSummary(meeting.id, { contextOverview: overview });
    return overview;
  }

  private static async retrieveContext(meeting: Meeting, knowledgeOrchestrator?: any): Promise<ContextRetrievalResult> {
    const broker = ContextRetrievalBroker.getInstance();
    broker.setKnowledgeOrchestrator(knowledgeOrchestrator);

    return broker.retrieve({
      query: buildMeetingQuery(meeting),
      surface: "reactive",
      activeMeetingId: meeting.id,
      participantHints: buildParticipantHints(meeting),
      limit: MAX_CONTEXT_DOCS,
      maxAgeMs: RETRIEVAL_WINDOW_MS,
      includeLiveMicrosoftSources: false,
      includeSemantica: false,
    });
  }
}

function resolveMeetingForOverview(db: DatabaseManager, meetingId: string): Meeting | null {
  const direct = db.getMeetingDetails(meetingId);
  if (direct) return direct;

  try {
    const { BrainReadModelService } = require("./BrainReadModelService");
    const brainMeetings = BrainReadModelService.getInstance().getRecentMeetings(500);
    const brainRecord = brainMeetings.find((meeting: any) => meeting?.id === meetingId);
    const sourceMeetingId = brainRecord?.importMetadata?.sourceMeetingId;
    if (sourceMeetingId && sourceMeetingId !== meetingId) {
      return db.getMeetingDetails(sourceMeetingId);
    }
  } catch (error) {
    console.warn("[MeetingOverviewService] Failed to resolve brain meeting id:", error);
  }

  return null;
}

function buildMeetingQuery(meeting: Meeting): string {
  const transcriptExcerpt = cleanTranscriptForAnalysis(meeting.transcript || [], {
    maxChars: 1_200,
    includeTimestamps: false,
  }).analysisText;

  return [
    meeting.title,
    meeting.detailedSummary?.overview || meeting.summary,
    ...getUserContextNoteTexts(meeting),
    ...(meeting.detailedSummary?.keyPoints || []).slice(0, 5),
    ...(meeting.detailedSummary?.actionItems || []).slice(0, 4),
    transcriptExcerpt.slice(0, 1_200),
  ]
    .filter(Boolean)
    .join(" ");
}

function buildParticipantHints(meeting: Meeting): string[] {
  const speakers = (meeting.transcript || [])
    .map((segment) => segment.speaker || "")
    .map((speaker) => speaker.trim())
    .filter((speaker) => speaker && !["user", "assistant", "them", "me", "external"].includes(speaker.toLowerCase()));

  const noteNames = getUserContextNoteTexts(meeting)
    .flatMap((note) => Array.from(note.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g)).map((match) => match[0]))
    .filter((name) => !["This", "That", "Meeting", "Can"].includes(name));

  return dedupeStrings([...speakers, ...noteNames]).slice(0, 8);
}

function selectRelatedDocuments(retrieval: ContextRetrievalResult, meetingId: string): ScoredContextDocument[] {
  return retrieval.documents.filter((doc) => {
    if (doc.sourceType === "calendar_event") return false;
    if (doc.relatedMeetingIds?.includes(meetingId) && !["task_or_commitment", "profile_fact"].includes(doc.sourceType)) {
      return false;
    }
    return true;
  });
}

async function findUpcomingSignals(meeting: Meeting): Promise<Array<{ event: CalendarEvent; score: number }>> {
  const events = await CalendarManager.getInstance().getUpcomingEvents().catch((): CalendarEvent[] => []);
  if (!events.length) return [];

  const queryTerms = tokenize(buildMeetingQuery(meeting));
  const participantTerms = tokenize(buildParticipantHints(meeting).join(" "));

  return events
    .map((event) => {
      const eventTerms = tokenize([
        event.title,
        event.description || "",
        event.location || "",
        ...(event.attendees || []).map((attendee) => attendee.displayName || attendee.email || ""),
      ].join(" "));

      const lexical = overlapRatio(queryTerms, eventTerms);
      const participant = overlapRatio(
        participantTerms,
        tokenize((event.attendees || []).map((attendee) => attendee.displayName || attendee.email || "").join(" "))
      );
      const score = (0.72 * lexical) + (0.28 * participant);
      return { event, score };
    })
    .filter((item) => item.score >= 0.14)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

function buildOverviewPrompt(
  meeting: Meeting,
  retrieval: ContextRetrievalResult,
  relatedDocs: ScoredContextDocument[],
  upcomingMatches: Array<{ event: CalendarEvent; score: number }>
): string {
  const meetingBlock = [
    `TITLE: ${meeting.title}`,
    `DATE: ${meeting.date}`,
    `DURATION: ${meeting.duration}`,
    `SOURCE SUMMARY: ${meeting.detailedSummary?.overview || meeting.summary || "None"}`,
    `KEY POINTS: ${(meeting.detailedSummary?.keyPoints || []).join(" | ") || "None"}`,
    `ACTION ITEMS: ${(meeting.detailedSummary?.actionItems || []).join(" | ") || "None"}`,
  ].join("\n");

  const userContextBlock = formatUserContextNotes(meeting);

  const transcriptBlock = buildMeetingAnalysisContext(meeting, {
    maxChars: 18_000,
    includeTimestamps: true,
  });

  const relatedBlock = relatedDocs.length
    ? relatedDocs.slice(0, 5).map((doc, index) => [
        `${index + 1}. ${doc.title}`,
        `   TYPE: ${doc.sourceType}`,
        `   EXCERPT: ${doc.excerpt}`,
      ].join("\n")).join("\n")
    : "None";

  const upcomingBlock = upcomingMatches.length
    ? upcomingMatches.map((match, index) => [
        `${index + 1}. ${match.event.title}`,
        `   WHEN: ${match.event.startTime}`,
        `   WHY IT MAY RELATE: ${compactWhitespace(match.event.description || match.event.location || "Title/attendee overlap")}`,
      ].join("\n")).join("\n")
    : "None";

  return [
    "CURRENT MEETING",
    meetingBlock,
    "",
    "USER-SUPPLIED POST-MEETING CONTEXT",
    userContextBlock || "None",
    "",
    "CLEANED TRANSCRIPT AND ANALYSIS CONTEXT",
    transcriptBlock || "None",
    "",
    "RANKED SUPPORTING CONTEXT",
    relatedBlock,
    "",
    "POSSIBLE UPCOMING CONNECTIONS",
    upcomingBlock,
    "",
    `RETRIEVAL CONFIDENCE: ${retrieval.confidence}`,
    `RETRIEVAL SITUATION: ${retrieval.situation}`,
  ].join("\n");
}

function getUserContextNoteTexts(meeting: Meeting): string[] {
  const notes = meeting.detailedSummary?.userContextNotes;
  if (!Array.isArray(notes)) return [];
  return notes
    .map((note: any) => compactWhitespace(note?.text || ""))
    .filter(Boolean)
    .slice(-10);
}

function formatUserContextNotes(meeting: Meeting): string {
  const notes = meeting.detailedSummary?.userContextNotes;
  if (!Array.isArray(notes) || notes.length === 0) return "";

  return notes
    .slice(-10)
    .map((note: any, index) => {
      const createdAt = compactWhitespace(note?.createdAt || "");
      const text = compactWhitespace(note?.text || "");
      return text ? `${index + 1}. ${createdAt ? `[${createdAt}] ` : ""}${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildEvidence(
  retrieval: ContextRetrievalResult,
  relatedDocs: ScoredContextDocument[],
  upcomingMatches: Array<{ event: CalendarEvent; score: number }>
): MeetingContextOverviewEvidence[] {
  const evidenceFromDocs = relatedDocs
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((doc) => ({
      title: doc.title,
      sourceType: doc.sourceType,
      excerpt: doc.excerpt,
      date: doc.updatedAt || doc.createdAt,
      score: doc.finalScore,
    }));

  const evidenceFromEvents = upcomingMatches.map((match) => ({
    title: match.event.title,
    sourceType: "calendar_event",
    excerpt: compactWhitespace(match.event.description || match.event.location || "Upcoming calendar event likely connected to this work."),
    date: match.event.startTime,
    score: match.score,
  }));

  return [...evidenceFromDocs, ...evidenceFromEvents].slice(0, MAX_EVIDENCE_ITEMS);
}

function parseOverviewPayload(raw: string): OverviewPayload | null {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(cleaned) as OverviewPayload;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]) as OverviewPayload;
    } catch {
      return null;
    }
  }
}

function sanitizeOverviewPayload(
  payload: OverviewPayload | null,
  meeting: Meeting,
  relatedDocs: ScoredContextDocument[],
  upcomingMatches: Array<{ event: CalendarEvent; score: number }>
): Required<OverviewPayload> {
  const fallbackSynopsis = compactWhitespace(
    meeting.detailedSummary?.overview ||
    meeting.summary ||
    `${meeting.title} was captured without a strong written summary, so the overview is based on available meeting metadata.`
  );

  const fallbackContinuity = relatedDocs
    .filter((doc) => ["meeting_summary", "meeting_transcript", "manual_import", "task_or_commitment"].includes(doc.sourceType))
    .slice(0, 3)
    .map((doc) => `${doc.title}: ${doc.excerpt}`);

  const fallbackUpcoming = upcomingMatches
    .slice(0, 3)
    .map((match) => `${match.event.title} on ${formatShortDate(match.event.startTime)} may continue this thread.`);

  return {
    synopsis: sanitizeText(payload?.synopsis, fallbackSynopsis),
    significance: sanitizeText(
      payload?.significance,
      fallbackContinuity.length > 0
        ? "This meeting matters because it connects directly to active work already visible in nearby meetings and commitments."
        : "This meeting matters because it captures a concrete workstream checkpoint inside the broader meeting history."
    ),
    value: sanitizeText(
      payload?.value,
      meeting.detailedSummary?.actionItems?.length
        ? "The value is in the decisions, action items, and reusable context captured for future follow-up."
        : "The value is in preserving context, decisions, and terminology that would otherwise need to be reconstructed later."
    ),
    continuity: sanitizeList(payload?.continuity, fallbackContinuity),
    upcomingSignals: sanitizeList(payload?.upcomingSignals, fallbackUpcoming),
  };
}

function sanitizeText(value: string | undefined, fallback: string): string {
  const cleaned = compactWhitespace(value || "");
  if (cleaned) return cleaned;
  return compactWhitespace(fallback);
}

function sanitizeList(values: string[] | undefined, fallback: string[]): string[] {
  const cleaned = (values || [])
    .map((value) => compactWhitespace(value))
    .filter(Boolean)
    .slice(0, 4);

  if (cleaned.length > 0) {
    return cleaned;
  }

  return fallback.slice(0, 4);
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function tokenize(input: string): string[] {
  return compactWhitespace(input)
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const matches = left.reduce((count, term) => count + (rightSet.has(term) ? 1 : 0), 0);
  return Math.max(0, Math.min(1, matches / left.length));
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
