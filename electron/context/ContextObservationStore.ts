import crypto from "crypto";
import { ContextDocument, ContextSourceType } from "./types";

const TTL_BY_SOURCE_MS: Record<ContextSourceType, number> = {
  ocr_observation: 10 * 60 * 1000,
  interaction: 2 * 60 * 60 * 1000,
  live_transcript: 6 * 60 * 60 * 1000,
  meeting_transcript: 7 * 24 * 60 * 60 * 1000,
  meeting_summary: 30 * 24 * 60 * 60 * 1000,
  calendar_event: 7 * 24 * 60 * 60 * 1000,
  email_thread: 30 * 24 * 60 * 60 * 1000,
  teams_thread: 14 * 24 * 60 * 60 * 1000,
  profile_fact: 365 * 24 * 60 * 60 * 1000,
  task_or_commitment: 180 * 24 * 60 * 60 * 1000,
  manual_import: 365 * 24 * 60 * 60 * 1000,
  brain_prep_packet: 365 * 24 * 60 * 60 * 1000,
  cortex_insight: 365 * 24 * 60 * 60 * 1000,
  action_proposal: 365 * 24 * 60 * 60 * 1000,
};

export class ContextObservationStore {
  private static instance: ContextObservationStore;
  private documents: ContextDocument[] = [];

  static getInstance(): ContextObservationStore {
    if (!ContextObservationStore.instance) {
      ContextObservationStore.instance = new ContextObservationStore();
    }
    return ContextObservationStore.instance;
  }

  recordOCRObservation(input: {
    text: string;
    capturedAt?: number;
    displayCount?: number;
  }): void {
    const body = input.text.trim();
    if (body.length < 15) return;
    const capturedAt = input.capturedAt ?? Date.now();
    this.upsertDocument({
      id: buildId("ocr", `${capturedAt}:${body.slice(0, 120)}`),
      sourceType: "ocr_observation",
      sourceSystem: "continuous_ocr",
      title: "Live screen observation",
      body,
      createdAt: new Date(capturedAt).toISOString(),
      expiresAt: new Date(capturedAt + TTL_BY_SOURCE_MS.ocr_observation).toISOString(),
      trustTier: "observed",
      visibility: "private",
      freshnessClass: "live",
      lexicalTerms: tokenize(`${body}`),
      metadata: {
        displayCount: input.displayCount ?? 1,
      },
    });
  }

  recordInteraction(input: {
    role: "user" | "assistant" | "system";
    text: string;
    timestamp?: number;
  }): void {
    const body = input.text.trim();
    if (body.length < 3) return;
    const timestamp = input.timestamp ?? Date.now();
    this.upsertDocument({
      id: buildId("interaction", `${input.role}:${timestamp}:${body.slice(0, 120)}`),
      sourceType: "interaction",
      sourceSystem: "overlay_chat",
      title: `${capitalize(input.role)} chat turn`,
      body,
      createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + TTL_BY_SOURCE_MS.interaction).toISOString(),
      trustTier: input.role === "system" ? "observed" : "durable",
      visibility: "private",
      freshnessClass: "recent",
      lexicalTerms: tokenize(body),
      metadata: {
        role: input.role,
      },
    });
  }

  recordTranscriptSegment(input: {
    speaker: string;
    text: string;
    timestamp?: number;
    meetingId?: string;
    calendarEventId?: string;
  }): void {
    const body = input.text.trim();
    if (body.length < 3) return;
    const timestamp = input.timestamp ?? Date.now();
    const speaker = input.speaker?.trim() || "unknown";
    this.upsertDocument({
      id: buildId(
        "transcript",
        `${speaker}:${timestamp}:${input.meetingId ?? "session"}:${body.slice(0, 120)}`
      ),
      sourceType: "live_transcript",
      sourceSystem: "session_tracker",
      title: `Live transcript: ${speaker}`,
      body,
      createdAt: new Date(timestamp).toISOString(),
      expiresAt: new Date(timestamp + TTL_BY_SOURCE_MS.live_transcript).toISOString(),
      trustTier: speaker === "external" || speaker === "user" ? "durable" : "observed",
      visibility: "private",
      freshnessClass: "live",
      lexicalTerms: tokenize(body),
      relatedMeetingIds: input.meetingId ? [input.meetingId] : [],
      relatedCalendarEventIds: input.calendarEventId ? [input.calendarEventId] : [],
      participants: isNamedParticipant(speaker) ? [speaker] : [],
      metadata: {
        speaker,
      },
    });
  }

  getDocuments(options?: {
    sourceTypes?: ContextSourceType[];
    maxAgeMs?: number;
  }): ContextDocument[] {
    this.prune();
    const now = Date.now();
    return this.documents.filter((doc) => {
      if (options?.sourceTypes?.length && !options.sourceTypes.includes(doc.sourceType)) {
        return false;
      }
      if (!options?.maxAgeMs) return true;
      return now - Date.parse(doc.createdAt) <= options.maxAgeMs;
    });
  }

  clearSessionArtifacts(): void {
    this.prune();
    this.documents = this.documents.filter((doc) => {
      return !["interaction", "live_transcript", "ocr_observation"].includes(doc.sourceType);
    });
  }

  clearAll(): void {
    this.documents = [];
  }

  private upsertDocument(doc: ContextDocument): void {
    this.prune();
    const idx = this.documents.findIndex((existing) => existing.id === doc.id);
    if (idx >= 0) {
      this.documents[idx] = doc;
      return;
    }
    this.documents.push(doc);
  }

  private prune(): void {
    const now = Date.now();
    this.documents = this.documents.filter((doc) => {
      if (!doc.expiresAt) return true;
      return Date.parse(doc.expiresAt) > now;
    });
  }
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function buildId(prefix: string, input: string): string {
  return `${prefix}:${crypto.createHash("sha1").update(input).digest("hex").slice(0, 16)}`;
}

function capitalize(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

function isNamedParticipant(speaker: string): boolean {
  const lowered = speaker.toLowerCase();
  return !["external", "user", "assistant", "system", "unknown"].includes(lowered);
}
