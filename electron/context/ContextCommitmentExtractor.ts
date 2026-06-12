import crypto from "crypto";
import { Meeting } from "../db/DatabaseManager";
import { ContextDocument } from "./types";

export class ContextCommitmentExtractor {
  extractFromMeeting(meeting: Meeting): ContextDocument[] {
    const commitments = new Map<string, ContextDocument>();
    const createdAt = meeting.date || new Date().toISOString();
    const relatedMeetingIds = [meeting.id];
    const sourceSystem = meeting.source === "calendar" ? "meeting_store" : "manual_import";

    const actionItems = meeting.detailedSummary?.actionItems || [];
    for (const item of actionItems) {
      const normalized = normalizeCommitment(item);
      if (!normalized) continue;
      commitments.set(normalized, this.buildCommitmentDoc({
        title: normalized,
        createdAt,
        sourceSystem,
        meeting,
        relatedMeetingIds,
      }));
    }

    const transcriptLines = (meeting.transcript || [])
      .map((segment) => segment.text)
      .filter(Boolean)
      .slice(-120);

    for (const line of transcriptLines) {
      const normalized = extractCommitmentFromLine(line);
      if (!normalized) continue;
      if (!commitments.has(normalized)) {
        commitments.set(normalized, this.buildCommitmentDoc({
          title: normalized,
          createdAt,
          sourceSystem,
          meeting,
          relatedMeetingIds,
        }));
      }
    }

    return [...commitments.values()];
  }

  private buildCommitmentDoc(input: {
    title: string;
    createdAt: string;
    sourceSystem: string;
    meeting: Meeting;
    relatedMeetingIds: string[];
  }): ContextDocument {
    const body = `Open commitment from ${input.meeting.title || "meeting"}: ${input.title}`;
    const reference = new Date(Date.parse(input.createdAt) || Date.now());
    const dueAt = parseDuePhrase(input.title, reference);
    return {
      id: `commitment:${crypto.createHash("sha1").update(`${input.meeting.id}:${input.title}`).digest("hex").slice(0, 16)}`,
      sourceType: "task_or_commitment",
      sourceSystem: input.sourceSystem,
      title: input.title,
      body,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      dueAt: dueAt ?? undefined,
      trustTier: "durable",
      visibility: "private",
      freshnessClass: "recent",
      relatedMeetingIds: input.relatedMeetingIds,
      lexicalTerms: tokenize(`${input.title} ${body}`),
      metadata: {
        meetingId: input.meeting.id,
        meetingTitle: input.meeting.title,
      },
    };
  }
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const END_OF_DAY_HOUR = 17;

/**
 * Deterministic date-phrase parser for commitment text ("I'll send that by
 * Friday", "end of day", "by June 15", "in 3 days"). Returns an ISO timestamp
 * (local 17:00 on the resolved day) or null when no temporal phrase is found.
 * No LLM calls — this runs on every meeting save.
 */
export function parseDuePhrase(text: string, reference: Date = new Date()): string | null {
  const lower = text.toLowerCase();

  const atEndOfDay = (date: Date): string => {
    const result = new Date(date);
    result.setHours(END_OF_DAY_HOUR, 0, 0, 0);
    return result.toISOString();
  };
  const addDays = (date: Date, days: number): Date => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  };

  // "by/before/until/due <weekday>" (also "next <weekday>")
  const weekdayMatch = lower.match(/\b(?:by|before|until|due|on|next)\s+(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const target = WEEKDAYS.indexOf(weekdayMatch[1]);
    let delta = (target - reference.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "by Friday" said on a Friday means next week
    return atEndOfDay(addDays(reference, delta));
  }

  // "tomorrow"
  if (/\btomorrow\b/.test(lower)) {
    return atEndOfDay(addDays(reference, 1));
  }

  // "today", "end of day", "eod", "tonight", "close of business", "cob"
  if (/\b(?:today|tonight|end of (?:the )?day|eod|close of business|cob)\b/.test(lower)) {
    return atEndOfDay(reference);
  }

  // "end of week", "eow", "this week" → Friday of the reference week
  if (/\b(?:end of (?:the )?week|eow|this week)\b/.test(lower)) {
    const delta = (5 - reference.getDay() + 7) % 7;
    return atEndOfDay(addDays(reference, delta));
  }

  // "next week" → next Monday
  if (/\bnext week\b/.test(lower)) {
    const delta = ((1 - reference.getDay() + 7) % 7) || 7;
    return atEndOfDay(addDays(reference, delta));
  }

  // "end of month", "eom"
  if (/\b(?:end of (?:the )?month|eom)\b/.test(lower)) {
    const result = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
    return atEndOfDay(result);
  }

  // "in N day(s)/week(s)"
  const inMatch = lower.match(/\bin\s+(\d{1,2})\s+(day|days|week|weeks)\b/);
  if (inMatch) {
    const amount = parseInt(inMatch[1], 10);
    const days = inMatch[2].startsWith("week") ? amount * 7 : amount;
    return atEndOfDay(addDays(reference, days));
  }

  // "by <Month> <day>" (e.g. "by June 15", "before march 3rd")
  const monthMatch = lower.match(/\b(?:by|before|until|due|on)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthMatch) {
    const month = MONTHS.indexOf(monthMatch[1]);
    const day = parseInt(monthMatch[2], 10);
    if (day >= 1 && day <= 31) {
      let result = new Date(reference.getFullYear(), month, day);
      if (result.getTime() < reference.getTime()) {
        result = new Date(reference.getFullYear() + 1, month, day);
      }
      return atEndOfDay(result);
    }
  }

  // "by the 15th" (day of the current/next month)
  const dayMatch = lower.match(/\b(?:by|before|until|due)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dayMatch) {
    const day = parseInt(dayMatch[1], 10);
    if (day >= 1 && day <= 31) {
      let result = new Date(reference.getFullYear(), reference.getMonth(), day);
      if (result.getTime() < reference.getTime()) {
        result = new Date(reference.getFullYear(), reference.getMonth() + 1, day);
      }
      return atEndOfDay(result);
    }
  }

  return null;
}

function extractCommitmentFromLine(line: string): string | null {
  const trimmed = normalizeCommitment(line);
  if (!trimmed) return null;
  const patterns = [
    /\b(i(?:'ll| will)|we(?:'ll| will)|let'?s|follow up|circle back|send|share|review|deliver|update|prepare|draft|confirm)\b/i,
    /\b(action item|next step|todo|to-do|need to|should)\b/i,
  ];
  return patterns.some((pattern) => pattern.test(trimmed)) ? trimmed : null;
}

function normalizeCommitment(input: string): string | null {
  const cleaned = input
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 8) return null;
  return cleaned;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}
