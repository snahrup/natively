import crypto from "crypto";
import { ContextDocument, ContextSourceType } from "./types";

// Session-type TTLs cover a full working day: the ambient goal ("what did I
// do today", "you have X due") needs the morning's observations available in
// the evening. The old caps (OCR 10 min, interaction 2h, transcript 6h) made
// all-day memory structurally impossible.
const TTL_BY_SOURCE_MS: Record<ContextSourceType, number> = {
  ocr_observation: 12 * 60 * 60 * 1000,
  interaction: 12 * 60 * 60 * 1000,
  live_transcript: 12 * 60 * 60 * 1000,
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
  private rehydrated = false;
  private lastDbPruneAt = 0;

  static getInstance(): ContextObservationStore {
    if (!ContextObservationStore.instance) {
      ContextObservationStore.instance = new ContextObservationStore();
    }
    return ContextObservationStore.instance;
  }

  /**
   * Rehydrate the in-RAM working set from the durable SQLite log on first
   * use — observations survive app restarts up to their TTLs. Lazy so module
   * load order doesn't matter; non-fatal if the DB isn't up yet (we retry on
   * the next call).
   */
  private ensureRehydrated(): void {
    if (this.rehydrated) return;
    try {
      const { DatabaseManager } = require("../db/DatabaseManager");
      const db = DatabaseManager.getInstance();
      const persisted = db.loadObservations() as ContextDocument[];
      if (persisted.length > 0) {
        const known = new Set(this.documents.map((doc) => doc.id));
        for (const doc of persisted) {
          if (doc?.id && !known.has(doc.id)) {
            this.documents.push(doc);
          }
        }
        console.log(`[ContextObservationStore] Rehydrated ${persisted.length} observation(s) from SQLite`);
      }
      db.deleteExpiredObservations();
      this.rehydrated = true;
    } catch (error) {
      // DB not ready yet — keep operating in-RAM and retry later.
      console.warn("[ContextObservationStore] Rehydration unavailable:", (error as Error)?.message || error);
    }
  }

  private persistFailureReported = false;

  private persist(doc: ContextDocument): void {
    try {
      const { DatabaseManager } = require("../db/DatabaseManager");
      DatabaseManager.getInstance().upsertObservation(doc);
    } catch (error) {
      // Durable log unavailable — the in-RAM working set still serves, but
      // the degradation must be VISIBLE (once), not silently swallowed.
      if (!this.persistFailureReported) {
        this.persistFailureReported = true;
        console.warn("[ContextObservationStore] Durable observation writes failing — ambient memory will not survive restart:", (error as Error)?.message || error);
        try {
          const { ServiceHealthRegistry } = require("../services/ServiceHealthRegistry");
          ServiceHealthRegistry.getInstance().markDegraded(
            "ObservationStore",
            `Durable writes failing: ${(error as Error)?.message || error}`
          );
        } catch { /* registry unavailable — warn above already logged */ }
      }
    }
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

  /**
   * Persist a commitment document into the durable lane (180-day TTL).
   * Used by meeting ingestion and the deadline sweep (which re-records to
   * update notification metadata).
   */
  recordCommitmentDocument(doc: ContextDocument): void {
    if (doc.sourceType !== "task_or_commitment") return;
    const createdMs = Date.parse(doc.createdAt) || Date.now();

    // Sweep-owned metadata must survive re-ingestion: meeting saves (rename,
    // summary regen, context notes, repair) rebuild commitment docs from
    // scratch under the same id — without this merge, every re-save erased
    // deadlineNotifiedAt and the sweep re-notified the same commitment.
    this.ensureRehydrated();
    const existing = this.documents.find((candidate) => candidate.id === doc.id);
    const mergedMetadata = { ...(doc.metadata || {}) };
    if (existing?.metadata?.deadlineNotifiedAt && mergedMetadata.deadlineNotifiedAt === undefined) {
      mergedMetadata.deadlineNotifiedAt = existing.metadata.deadlineNotifiedAt;
    }

    this.upsertDocument({
      ...doc,
      metadata: mergedMetadata,
      expiresAt: doc.expiresAt ?? new Date(createdMs + TTL_BY_SOURCE_MS.task_or_commitment).toISOString(),
    });
  }

  getDocuments(options?: {
    sourceTypes?: ContextSourceType[];
    maxAgeMs?: number;
  }): ContextDocument[] {
    this.ensureRehydrated();
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

  /**
   * Session boundary hook. Observations are intentionally NOT deleted here
   * anymore — the durable lane keeps the day's context across meetings and
   * restarts, and TTLs do the forgetting. (This method used to wipe every
   * interaction/transcript/OCR doc at meeting stop, which made ambient
   * all-day memory impossible.)
   */
  clearSessionArtifacts(): void {
    this.prune();
  }

  clearAll(): void {
    this.documents = [];
    try {
      const { DatabaseManager } = require("../db/DatabaseManager");
      DatabaseManager.getInstance().clearObservations();
    } catch {
      // Durable log unavailable — RAM cleared regardless.
    }
  }

  private upsertDocument(doc: ContextDocument): void {
    this.ensureRehydrated();
    this.prune();
    this.persist(doc);
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

    // Batch-prune the durable log at most once a minute.
    if (now - this.lastDbPruneAt > 60_000) {
      this.lastDbPruneAt = now;
      try {
        const { DatabaseManager } = require("../db/DatabaseManager");
        DatabaseManager.getInstance().deleteExpiredObservations();
      } catch {
        // Durable log unavailable — RAM prune already done.
      }
    }
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
