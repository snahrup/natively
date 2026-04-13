import { CalendarManager, type CalendarEvent } from "./CalendarManager";
import { ContextRetrievalBroker } from "../context/ContextRetrievalBroker";
import { ScoredContextDocument } from "../context/types";

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
}

interface CacheEntry {
  packet: MeetingPrepPacket;
  createdAtMs: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

export class MeetingPrepService {
  private static instance: MeetingPrepService;
  private cache = new Map<string, CacheEntry>();

  public static getInstance(): MeetingPrepService {
    if (!MeetingPrepService.instance) {
      MeetingPrepService.instance = new MeetingPrepService();
    }
    return MeetingPrepService.instance;
  }

  public async warmPackets(events: CalendarEvent[], knowledgeOrchestrator?: any): Promise<void> {
    ContextRetrievalBroker.getInstance().setKnowledgeOrchestrator(knowledgeOrchestrator);
    const candidates = events
      .filter((event) => new Date(event.endTime).getTime() > Date.now())
      .slice(0, 3);

    await Promise.allSettled(
      candidates.map((event) => this.buildPacketFromEvent(event, knowledgeOrchestrator))
    );
  }

  public async buildPacket(eventId: string, knowledgeOrchestrator?: any): Promise<MeetingPrepPacket | null> {
    const cached = this.cache.get(eventId);
    if (cached && Date.now() - cached.createdAtMs < CACHE_TTL_MS) {
      return cached.packet;
    }

    const events = await CalendarManager.getInstance().getUpcomingEvents();
    const event = events.find((candidate) => candidate.id === eventId);
    if (!event) return null;

    return this.buildPacketFromEvent(event, knowledgeOrchestrator);
  }

  public clear(eventId?: string): void {
    if (eventId) {
      this.cache.delete(eventId);
      return;
    }
    this.cache.clear();
  }

  private async buildPacketFromEvent(
    event: CalendarEvent,
    knowledgeOrchestrator?: any
  ): Promise<MeetingPrepPacket> {
    const cached = this.cache.get(event.id);
    if (cached && Date.now() - cached.createdAtMs < CACHE_TTL_MS) {
      return cached.packet;
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
    return packet;
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
