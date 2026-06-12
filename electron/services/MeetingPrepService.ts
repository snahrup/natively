import { CalendarManager, type CalendarEvent } from "./CalendarManager";
import { ContextRetrievalBroker } from "../context/ContextRetrievalBroker";
import { ScoredContextDocument } from "../context/types";
import { BrainReadModelService, type BrainPrepPacket } from "./BrainReadModelService";
import { DurableWorkflowLedger } from "./DurableWorkflowLedger";
import { MeetingContextCapsuleService, type MeetingContextCapsuleRef } from "./MeetingContextCapsuleService";

export interface MeetingPrepPacket {
  event: CalendarEvent;
  generatedAt: string;
  timing: {
    startsInMinutes: number;
    durationMinutes: number;
  };
  sourceHealth: {
    calendar: boolean;
    memory: boolean;
    backgroundContext: boolean;
    roleBrief: boolean;
    liveResearch: boolean;
  };
  summary: string;
  contextBullets: string[];
  profileSnapshot: string[];
  relatedMeetings: Array<{
    id: string;
    title: string;
    date: string;
    summary: string;
    matchScore: number;
  }>;
  memoryHighlights: Array<{
    title: string;
    excerpt: string;
    source: string;
    type: string;
    date?: string;
    score: number;
  }>;
  prepChecklist: string[];
  openQuestions: string[];
  openCommitments: string[];
  contextCapsule?: MeetingContextCapsuleRef;
}

interface CacheEntry {
  packet: MeetingPrepPacket;
  createdAtMs: number;
}

export interface MeetingPrepReadinessSnapshot {
  cachedPacketCount: number;
  nextMeeting: {
    id: string;
    title: string;
    startsAt: string;
    startsInMinutes: number;
    source: CalendarEvent["source"];
  } | null;
  nextPacketReady: boolean;
  nextPacketGeneratedAt: string | null;
  nextPacketAgeMs: number | null;
  inAutoPrepWindow: boolean;
  lastWarmStartedAt: string | null;
  lastWarmFinishedAt: string | null;
  lastWarmCandidateCount: number;
  lastWarmError: string | null;
  lastBuiltPacketAt: string | null;
  lastBuiltPacketTitle: string | null;
  cache: Array<{
    eventId: string;
    title: string;
    generatedAt: string;
    ageMs: number;
  }>;
}

const AUTO_PREP_LEAD_MS = 15 * 60 * 1000;
const AUTO_PREP_GRACE_MS = 2 * 60 * 1000;
const AUTO_PREP_STOP_BEFORE_START_MS = 3 * 60 * 1000;
const PREP_CACHE_TTL_MS = 45 * 60 * 1000;

export class MeetingPrepService {
  private static instance: MeetingPrepService;
  private cache = new Map<string, CacheEntry>();
  private lastWarmStartedAt: string | null = null;
  private lastWarmFinishedAt: string | null = null;
  private lastWarmCandidateCount: number = 0;
  private lastWarmError: string | null = null;
  private lastBuiltPacketAt: string | null = null;
  private lastBuiltPacketTitle: string | null = null;

  public static getInstance(): MeetingPrepService {
    if (!MeetingPrepService.instance) {
      MeetingPrepService.instance = new MeetingPrepService();
    }
    return MeetingPrepService.instance;
  }

  public async warmPackets(events: CalendarEvent[], knowledgeOrchestrator?: any): Promise<void> {
    this.lastWarmStartedAt = new Date().toISOString();
    this.lastWarmFinishedAt = null;
    this.lastWarmError = null;
    ContextRetrievalBroker.getInstance().setKnowledgeOrchestrator(knowledgeOrchestrator);
    const now = Date.now();
    const candidates = events
      .filter((event) => {
        const startMs = new Date(event.startTime).getTime();
        const endMs = new Date(event.endTime).getTime();
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
        if (endMs <= now) return false;
        if (this.getCachedPacket(event.id)) return false;
        if (startMs < now + AUTO_PREP_STOP_BEFORE_START_MS) return false;
        return startMs <= now + AUTO_PREP_LEAD_MS + AUTO_PREP_GRACE_MS;
      })
      .slice(0, 5);
    this.lastWarmCandidateCount = candidates.length;

    try {
      const results = await Promise.allSettled(
        candidates.map((event) => this.buildPacketWithLedger(event, knowledgeOrchestrator, "scheduler"))
      );
      const firstFailure = results.find((result) => result.status === "rejected");
      if (firstFailure && firstFailure.status === "rejected") {
        this.lastWarmError = firstFailure.reason?.message || String(firstFailure.reason);
      }
    } catch (error: any) {
      this.lastWarmError = error?.message || String(error);
      throw error;
    } finally {
      this.lastWarmFinishedAt = new Date().toISOString();
    }
  }

  public getCachedPacket(eventId: string): MeetingPrepPacket | null {
    const cached = this.cache.get(eventId);
    if (!cached || Date.now() - cached.createdAtMs >= PREP_CACHE_TTL_MS) {
      if (cached) {
        this.cache.delete(eventId);
      }
      return null;
    }
    if (!cached.packet.contextCapsule) {
      this.attachContextCapsule(cached.packet);
    }
    return cached.packet;
  }

  public async buildPacket(eventId: string, knowledgeOrchestrator?: any): Promise<MeetingPrepPacket | null> {
    const cached = this.getCachedPacket(eventId);
    if (cached) return cached;

    const events = await CalendarManager.getInstance().getUpcomingEvents();
    const event = events.find((candidate) => candidate.id === eventId);
    if (!event) return null;

    return this.buildPacketWithLedger(event, knowledgeOrchestrator, "manual");
  }

  public clear(eventId?: string): void {
    if (eventId) {
      this.cache.delete(eventId);
      return;
    }
    this.cache.clear();
  }

  public getReadinessSnapshot(events: CalendarEvent[] = []): MeetingPrepReadinessSnapshot {
    const now = Date.now();
    const validCache = Array.from(this.cache.entries())
      .filter(([eventId]) => Boolean(this.getCachedPacket(eventId)))
      .map(([eventId, entry]) => ({
        eventId,
        title: entry.packet.event?.title || "Untitled meeting",
        generatedAt: entry.packet.generatedAt,
        ageMs: Math.max(0, now - entry.createdAtMs),
      }))
      .sort((a, b) => a.ageMs - b.ageMs);

    const upcoming = events
      .filter((event) => {
        const endMs = new Date(event.endTime).getTime();
        return Number.isFinite(endMs) && endMs > now;
      })
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());

    const nextEvent = upcoming[0] || null;
    const nextStartMs = nextEvent ? new Date(nextEvent.startTime).getTime() : NaN;
    const nextPacket = nextEvent ? this.getCachedPacket(nextEvent.id) : null;
    const nextCacheEntry = nextEvent ? this.cache.get(nextEvent.id) : null;

    return {
      cachedPacketCount: validCache.length,
      nextMeeting: nextEvent && Number.isFinite(nextStartMs)
        ? {
            id: nextEvent.id,
            title: nextEvent.title,
            startsAt: nextEvent.startTime,
            startsInMinutes: Math.round((nextStartMs - now) / 60000),
            source: nextEvent.source,
          }
        : null,
      nextPacketReady: Boolean(nextPacket),
      nextPacketGeneratedAt: nextPacket?.generatedAt || null,
      nextPacketAgeMs: nextCacheEntry ? Math.max(0, now - nextCacheEntry.createdAtMs) : null,
      inAutoPrepWindow: Boolean(
        nextEvent &&
        Number.isFinite(nextStartMs) &&
        nextStartMs > now + AUTO_PREP_STOP_BEFORE_START_MS &&
        nextStartMs <= now + AUTO_PREP_LEAD_MS + AUTO_PREP_GRACE_MS
      ),
      lastWarmStartedAt: this.lastWarmStartedAt,
      lastWarmFinishedAt: this.lastWarmFinishedAt,
      lastWarmCandidateCount: this.lastWarmCandidateCount,
      lastWarmError: this.lastWarmError,
      lastBuiltPacketAt: this.lastBuiltPacketAt,
      lastBuiltPacketTitle: this.lastBuiltPacketTitle,
      cache: validCache.slice(0, 10),
    };
  }

  private async buildPacketFromEvent(
    event: CalendarEvent,
    knowledgeOrchestrator?: any
  ): Promise<MeetingPrepPacket> {
    const cached = this.getCachedPacket(event.id);
    if (cached) return cached;

    const brainPacket = BrainReadModelService.getInstance().getPrepPacketForEvent(event);
    if (brainPacket) {
      const packet = this.buildPacketFromBrainPacket(event, brainPacket);
      this.cache.set(event.id, { packet, createdAtMs: Date.now() });
      this.rememberBuiltPacket(packet);
      return packet;
    }

    const broker = ContextRetrievalBroker.getInstance();
    broker.setKnowledgeOrchestrator(knowledgeOrchestrator);

    const retrieval = await broker.retrieve({
      query: this.buildQuery(event),
      surface: "prep",
      activeCalendarEventId: event.id,
      participantHints: (event.attendees || [])
        .map((attendee) => attendee.displayName || attendee.email)
        .filter(Boolean) as string[],
      limit: 12,
      maxAgeMs: 60 * 24 * 60 * 60 * 1000,
      includeLiveMicrosoftSources: false,
      includeSemantica: false,
    });

    const relatedMeetings = this.extractRelatedMeetings(retrieval.documents);
    const profileSnapshot = this.extractProfileSnapshot(retrieval.documents);
    const openCommitments = this.extractOpenCommitments(retrieval.documents);
    const contextBullets = this.buildContextBullets(event, retrieval.documents, profileSnapshot, relatedMeetings, openCommitments);
    const prepChecklist = this.buildChecklist(event, relatedMeetings, profileSnapshot, openCommitments);
    const openQuestions = this.buildOpenQuestions(event, relatedMeetings, openCommitments, retrieval.documents.length);

    const startMs = new Date(event.startTime).getTime();
    const endMs = new Date(event.endTime).getTime();
    const startsInMinutes = Math.max(0, Math.round((startMs - Date.now()) / 60000));
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));

    const packet: MeetingPrepPacket = {
      event,
      generatedAt: new Date().toISOString(),
      timing: {
        startsInMinutes,
        durationMinutes,
      },
      sourceHealth: {
        calendar: true,
        memory: retrieval.documents.some((doc) => (doc.relatedMeetingIds?.length || 0) > 0),
        backgroundContext: profileSnapshot.some((line) => line.startsWith("Background")),
        roleBrief: profileSnapshot.some((line) => line.startsWith("Role brief")),
        liveResearch: false,
      },
      summary: this.buildSummary(event, startsInMinutes, durationMinutes, retrieval.documents.length, openCommitments.length),
      contextBullets,
      profileSnapshot,
      relatedMeetings,
      memoryHighlights: retrieval.documents.slice(0, 5).map((doc) => ({
        title: doc.title,
        excerpt: doc.excerpt,
        source: doc.sourceSystem,
        type: doc.sourceType,
        date: doc.updatedAt || doc.createdAt,
        score: doc.finalScore,
      })),
      prepChecklist,
      openQuestions,
      openCommitments,
    };

    this.cache.set(event.id, { packet, createdAtMs: Date.now() });
    this.rememberBuiltPacket(packet);
    return packet;
  }

  private async buildPacketWithLedger(
    event: CalendarEvent,
    knowledgeOrchestrator: any,
    trigger: "scheduler" | "manual"
  ): Promise<MeetingPrepPacket> {
    const cached = this.getCachedPacket(event.id);
    if (cached) return cached;

    return DurableWorkflowLedger.getInstance().runTask(
      {
        type: "meeting_prep_packet",
        title: `Prepare ${event.title}`,
        dedupeKey: `meeting-prep:${event.id}`,
        metadata: {
          calendarEventId: event.id,
          meetingTitle: event.title,
          startsAt: event.startTime,
          trigger,
          contextAuthority: "ipcorp_architecture_brain",
        },
        queuedSummary: `${event.title} prep packet queued.`,
        runningSummary: `Building prep packet for ${event.title}.`,
        completedSummary: `${event.title} prep packet is ready.`,
      },
      () => this.buildPacketFromEvent(event, knowledgeOrchestrator)
    ).then((packet) => {
      this.attachContextCapsule(packet);
      this.cache.set(event.id, { packet, createdAtMs: Date.now() });
      this.rememberBuiltPacket(packet);
      return packet;
    });
  }

  private rememberBuiltPacket(packet: MeetingPrepPacket): void {
    this.lastBuiltPacketAt = packet.generatedAt || new Date().toISOString();
    this.lastBuiltPacketTitle = packet.event?.title || "Untitled meeting";
  }

  private attachContextCapsule(packet: MeetingPrepPacket): void {
    try {
      const capsule = MeetingContextCapsuleService.getInstance().buildAndWriteCapsule(packet);
      if (capsule) {
        packet.contextCapsule = capsule;
      }
    } catch (error: any) {
      console.warn("[MeetingPrepService] Failed to build meeting context capsule:", error?.message || error);
    }
  }

  private buildPacketFromBrainPacket(event: CalendarEvent, brainPacket: BrainPrepPacket): MeetingPrepPacket {
    const startMs = new Date(event.startTime).getTime();
    const endMs = new Date(event.endTime).getTime();
    const startsInMinutes = Math.max(0, Math.round((startMs - Date.now()) / 60000));
    const durationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000));

    const contextBullets = dedupeStrings([
      brainPacket.whyItMatters ? `Why it matters: ${brainPacket.whyItMatters}` : "",
      ...brainPacket.currentState.slice(0, 3),
      brainPacket.suggestedPosture ? `Suggested posture: ${brainPacket.suggestedPosture}` : "",
      ...brainPacket.talkingPoints.slice(0, 3),
    ]).slice(0, 6);

    const evidenceHighlights = brainPacket.evidenceRefs.slice(0, 5).map((ref, index) => ({
      title: ref.split(/[\\/]/).pop() || `Brain evidence ${index + 1}`,
      excerpt: ref,
      source: "ipcorp_architecture_brain",
      type: "brain_prep_packet",
      date: brainPacket.updatedAt,
      score: 0.95 - index * 0.04,
    }));

    const liveContext = brainPacket.liveContextMarkdown?.trim()
      ? [{
          title: `${brainPacket.title} live context`,
          excerpt: compactWhitespace(brainPacket.liveContextMarkdown).slice(0, 360),
          source: "ipcorp_architecture_brain",
          type: "brain_prep_packet",
          date: brainPacket.updatedAt,
          score: 0.98,
        }]
      : [];

    return {
      event,
      generatedAt: brainPacket.updatedAt || new Date().toISOString(),
      timing: {
        startsInMinutes,
        durationMinutes,
      },
      sourceHealth: {
        calendar: true,
        memory: true,
        backgroundContext: true,
        roleBrief: brainPacket.suggestedPosture ? true : false,
        liveResearch: false,
      },
      summary: brainPacket.summary || `${brainPacket.title} prep packet loaded from the IP Corp architecture brain.`,
      contextBullets,
      profileSnapshot: brainPacket.suggestedPosture ? [`Suggested posture: ${brainPacket.suggestedPosture}`] : [],
      relatedMeetings: brainPacket.relatedWork.slice(0, 3).map((work, index) => ({
        id: `${brainPacket.id}-related-${index + 1}`,
        title: work,
        date: brainPacket.updatedAt || brainPacket.startsAt || new Date().toISOString(),
        summary: work,
        matchScore: 0.9 - index * 0.05,
      })),
      memoryHighlights: [...liveContext, ...evidenceHighlights].slice(0, 5),
      prepChecklist: this.buildChecklistFromBrainPacket(brainPacket),
      openQuestions: brainPacket.openQuestions.slice(0, 4),
      openCommitments: brainPacket.openCommitments.slice(0, 4),
    };
  }

  private buildChecklistFromBrainPacket(brainPacket: BrainPrepPacket): string[] {
    const checklist = [
      ...brainPacket.talkingPoints.slice(0, 3).map((point) => `Be ready to cover: ${point}`),
      ...brainPacket.openCommitments.slice(0, 2).map((commitment) => `Have status ready for: ${commitment}`),
    ];

    if (brainPacket.openQuestions.length > 0) {
      checklist.push(`Clarify: ${brainPacket.openQuestions[0]}`);
    }

    return dedupeStrings(checklist).slice(0, 5);
  }

  private buildSummary(
    event: CalendarEvent,
    startsInMinutes: number,
    durationMinutes: number,
    contextCount: number,
    commitmentCount: number
  ): string {
    const timing =
      startsInMinutes === 0
        ? "already underway or starting now"
        : `starts in ${startsInMinutes} min`;
    const contextState =
      contextCount > 0
        ? `Ranked ${contextCount} supporting context records for this meeting.`
        : "No strong supporting context was found, so this packet stays lightweight.";
    const commitmentState =
      commitmentCount > 0
        ? `There ${commitmentCount === 1 ? "is" : "are"} ${commitmentCount} open commitment${commitmentCount === 1 ? "" : "s"} linked to nearby work.`
        : "No open commitments were detected from recent linked meetings.";

    return `${event.title} ${timing}. Expected duration is about ${durationMinutes} min. ${contextState} ${commitmentState}`;
  }

  private extractProfileSnapshot(documents: ScoredContextDocument[]): string[] {
    return documents
      .filter((doc) => doc.sourceType === "profile_fact")
      .slice(0, 3)
      .map((doc) => {
        if (/role brief/i.test(doc.title)) return `Role brief: ${doc.excerpt}`;
        return `Background: ${doc.excerpt}`;
      });
  }

  private extractRelatedMeetings(documents: ScoredContextDocument[]): MeetingPrepPacket["relatedMeetings"] {
    const seen = new Set<string>();
    const related: MeetingPrepPacket["relatedMeetings"] = [];

    for (const doc of documents) {
      const meetingId = doc.relatedMeetingIds?.[0];
      if (!meetingId || seen.has(meetingId)) continue;
      if (!["meeting_summary", "meeting_transcript", "manual_import"].includes(doc.sourceType)) continue;
      related.push({
        id: meetingId,
        title: doc.title,
        date: doc.updatedAt || doc.createdAt,
        summary: doc.excerpt,
        matchScore: doc.finalScore,
      });
      seen.add(meetingId);
      if (related.length >= 3) break;
    }

    return related;
  }

  private extractOpenCommitments(documents: ScoredContextDocument[]): string[] {
    return dedupeStrings(
      documents
        .filter((doc) => doc.sourceType === "task_or_commitment")
        .map((doc) => doc.title)
    ).slice(0, 4);
  }

  private buildContextBullets(
    event: CalendarEvent,
    documents: ScoredContextDocument[],
    profileSnapshot: string[],
    relatedMeetings: MeetingPrepPacket["relatedMeetings"],
    openCommitments: string[]
  ): string[] {
    const bullets: string[] = [];

    if (event.attendees?.length) {
      const attendeeNames = event.attendees
        .map((attendee) => attendee.displayName || attendee.email)
        .filter(Boolean)
        .slice(0, 4)
        .join(", ");
      if (attendeeNames) {
        bullets.push(`Attendees on the invite: ${attendeeNames}${event.attendees.length > 4 ? " and others." : "."}`);
      }
    }

    if (event.location) {
      bullets.push(`Location: ${event.location}.`);
    }

    if (event.description) {
      bullets.push(`Calendar notes: ${compactWhitespace(stripHtml(event.description)).slice(0, 180)}.`);
    }

    bullets.push(...profileSnapshot);

    if (relatedMeetings[0]) {
      bullets.push(`Closest prior meeting: ${relatedMeetings[0].title} (${formatDateShort(relatedMeetings[0].date)}) — ${relatedMeetings[0].summary}.`);
    }

    if (openCommitments.length > 0) {
      bullets.push(`Open commitments: ${openCommitments.join(" • ")}.`);
    }

    for (const doc of documents) {
      if (bullets.length >= 6) break;
      if (["calendar_event", "task_or_commitment"].includes(doc.sourceType)) continue;
      bullets.push(`${doc.title}: ${doc.excerpt}.`);
    }

    return dedupeStrings(bullets).slice(0, 6);
  }

  private buildChecklist(
    event: CalendarEvent,
    relatedMeetings: MeetingPrepPacket["relatedMeetings"],
    profileSnapshot: string[],
    openCommitments: string[]
  ): string[] {
    const checklist: string[] = [];

    if (event.link) {
      checklist.push("Open the meeting link before joining so the overlay can stay focused on the discussion.");
    }

    if (relatedMeetings.length > 0) {
      checklist.push("Review the most recent related meeting summary and any unresolved decisions before the call starts.");
    } else {
      checklist.push("Anchor the first minute by stating the purpose, owner, and desired outcome of the meeting.");
    }

    if (openCommitments.length > 0) {
      checklist.push("Be ready to give status on the open commitments that are already tied to this work.");
    }

    if (profileSnapshot.some((line) => line.startsWith("Role brief"))) {
      checklist.push("Keep the loaded role or account brief in mind when framing priorities and tradeoffs.");
    }

    if (event.attendees && event.attendees.length > 0) {
      checklist.push("Check who is on the invite so responses stay calibrated to the right audience.");
    }

    return checklist.slice(0, 5);
  }

  private buildOpenQuestions(
    event: CalendarEvent,
    relatedMeetings: MeetingPrepPacket["relatedMeetings"],
    openCommitments: string[],
    retrievedCount: number
  ): string[] {
    const questions: string[] = [];

    if (!event.attendees || event.attendees.length === 0) {
      questions.push("The calendar entry has no attendee list exposed here. Confirm who actually needs to be addressed.");
    }

    if (relatedMeetings.length === 0) {
      questions.push("There is no close prior meeting match. Be ready to establish fresh context at the start.");
    }

    if (openCommitments.length === 0) {
      questions.push("No open commitments surfaced. Confirm whether this meeting is decision-making, status review, or discovery.");
    }

    if (retrievedCount < 3) {
      questions.push("Context coverage is light. If this meeting is high stakes, open the key thread or doc before it starts.");
    }

    return questions.slice(0, 4);
  }

  private buildQuery(event: CalendarEvent): string {
    const attendeeText = (event.attendees || [])
      .map((attendee) => attendee.displayName || attendee.email)
      .filter(Boolean)
      .join(" ");
    const description = event.description ? stripHtml(event.description).slice(0, 160) : "";
    return [event.title, attendeeText, event.location, description]
      .filter(Boolean)
      .join(" ");
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function formatDateShort(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
