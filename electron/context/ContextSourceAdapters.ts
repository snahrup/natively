import crypto from "crypto";
import { DatabaseManager, Meeting } from "../db/DatabaseManager";
import { CalendarEvent, CalendarManager } from "../services/CalendarManager";
import { MeetingMemoryBrain } from "../services/MeetingMemoryBrain";
import { MicrosoftLocalManager } from "../services/MicrosoftLocalManager";
import { ContextObservationStore } from "./ContextObservationStore";
import { ContextCommitmentExtractor } from "./ContextCommitmentExtractor";
import { ContextDocument } from "./types";

const commitmentExtractor = new ContextCommitmentExtractor();

export async function getCalendarDocuments(): Promise<ContextDocument[]> {
  const events = await CalendarManager.getInstance().getUpcomingEvents();
  return events.slice(0, 10).map(mapCalendarEventToDocument);
}

export function getObservationDocuments(maxAgeMs?: number): ContextDocument[] {
  return ContextObservationStore.getInstance().getDocuments({ maxAgeMs });
}

export async function getEmailDocuments(query?: string): Promise<ContextDocument[]> {
  const emails = query
    ? await MicrosoftLocalManager.getInstance().searchEmails(query, 12)
    : await MicrosoftLocalManager.getInstance().getRecentEmails(12);

  return emails.map((email) => {
    const participants = dedupeStrings([
      email.from.name,
      email.from.address,
      ...email.toRecipients.map((recipient) => recipient.name || recipient.address),
      ...email.ccRecipients.map((recipient) => recipient.name || recipient.address),
    ]);
    const body = [
      email.subject,
      `${email.from.name} <${email.from.address}>`,
      email.bodyPreview,
    ].filter(Boolean).join(" • ");

    return {
      id: `email:${email.id}`,
      sourceType: "email_thread",
      sourceSystem: "outlook_desktop",
      title: email.subject || "Email thread",
      body,
      createdAt: email.receivedDateTime,
      updatedAt: email.receivedDateTime,
      participants,
      trustTier: "durable",
      visibility: "private",
      freshnessClass: classifyFreshness(Date.parse(email.receivedDateTime)),
      lexicalTerms: tokenize(body),
      sourceScore: email.isRead ? 0.62 : 0.78,
      metadata: {
        emailId: email.id,
        unread: !email.isRead,
        hasAttachments: email.hasAttachments,
        importance: email.importance,
      },
    } satisfies ContextDocument;
  });
}

export async function getTeamsDocuments(): Promise<ContextDocument[]> {
  const chats = await MicrosoftLocalManager.getInstance().getTeamsChats(15);
  return chats.map((chat) => {
    const participants = dedupeStrings(chat.participants.map((participant) => participant.name));
    const body = [
      chat.topic,
      chat.lastMessage,
      participants.join(", "),
    ].filter(Boolean).join(" • ");

    return {
      id: `teams:${chat.id}`,
      sourceType: "teams_thread",
      sourceSystem: "teams_local_bridge",
      title: chat.topic || "Teams thread",
      body,
      createdAt: chat.lastMessageTime || new Date().toISOString(),
      updatedAt: chat.lastMessageTime || new Date().toISOString(),
      participants,
      trustTier: "durable",
      visibility: "private",
      freshnessClass: chat.lastMessageTime ? classifyFreshness(Date.parse(chat.lastMessageTime)) : "recent",
      lexicalTerms: tokenize(body),
      sourceScore: chat.unreadCount > 0 ? 0.76 : 0.58,
      metadata: {
        chatId: chat.id,
        unreadCount: chat.unreadCount,
        chatType: chat.chatType,
      },
    } satisfies ContextDocument;
  });
}

export function getProfileDocuments(knowledgeOrchestrator?: any): ContextDocument[] {
  if (!knowledgeOrchestrator || typeof knowledgeOrchestrator.getProfileData !== "function") {
    return [];
  }

  try {
    const profileData = knowledgeOrchestrator.getProfileData();
    if (!profileData) return [];

    const docs: ContextDocument[] = [];
    const createdAt = new Date().toISOString();

    if (profileData.identity) {
      const identityParts = [
        profileData.identity.name,
        profileData.identity.headline,
        profileData.identity.email,
        profileData.identity.location,
      ].filter(Boolean);
      if (identityParts.length > 0) {
        docs.push(buildProfileDoc("identity", "Profile identity", identityParts.join(" • "), createdAt));
      }
    }

    if (profileData.compactPersona) {
      docs.push(buildProfileDoc("persona", "Profile persona", String(profileData.compactPersona), createdAt));
    }

    if (profileData.hasActiveJD && profileData.activeJD) {
      const jd = profileData.activeJD;
      const jdParts = [
        jd.title,
        jd.company,
        jd.level,
        Array.isArray(jd.technologies) ? jd.technologies.join(", ") : "",
        Array.isArray(jd.requirements) ? jd.requirements.join(" • ") : "",
      ].filter(Boolean);
      if (jdParts.length > 0) {
        docs.push(buildProfileDoc("role-brief", "Role brief", jdParts.join(" • "), createdAt));
      }
    }

    return docs;
  } catch (error) {
    console.warn("[ContextSourceAdapters] Failed to read profile documents:", error);
    return [];
  }
}

export function getRecentMeetingDocuments(limit = 40): ContextDocument[] {
  const meetings = DatabaseManager.getInstance().getRecentMeetings(limit);
  return meetings.flatMap((meeting) => mapMeetingToDocuments(meeting));
}

export async function getMeetingMemoryDocuments(query: string, topN = 12): Promise<ContextDocument[]> {
  const db = DatabaseManager.getInstance();
  const brain = MeetingMemoryBrain.getInstance();
  await brain.initialize(db);
  const hits = brain.searchEntries(query, topN);

  return hits.map((hit) => ({
    id: `memory:${crypto.createHash("sha1").update(`${hit.source}:${hit.title}`).digest("hex").slice(0, 16)}`,
    sourceType: mapMemoryHitType(hit.type),
    sourceSystem: "meeting_memory_brain",
    title: hit.title,
    body: hit.content,
    createdAt: hit.date || new Date().toISOString(),
    updatedAt: hit.date,
    trustTier: hit.type === "knowledge" || hit.type === "entity" || hit.type === "contradiction" ? "authoritative" : "durable",
    visibility: "private",
    freshnessClass: hit.date ? classifyFreshness(Date.parse(hit.date)) : "historical",
    lexicalTerms: tokenize(`${hit.title} ${hit.content}`),
    sourceScore: normalizeScore(hit.score),
    relatedMeetingIds: extractMeetingIds(hit.source),
    metadata: {
      source: hit.source,
    },
  }));
}

function mapMemoryHitType(type: string): ContextDocument["sourceType"] {
  if (type === "summary") return "meeting_summary";
  if (type === "transcript") return "meeting_transcript";
  if (type === "contradiction") return "profile_fact";
  if (type === "entity") return "profile_fact";
  return "profile_fact";
}

function mapCalendarEventToDocument(event: CalendarEvent): ContextDocument {
  const attendees = (event.attendees || [])
    .map((attendee) => attendee.displayName || attendee.email)
    .filter(Boolean) as string[];
  const body = [
    event.title,
    event.description ? stripHtml(event.description) : "",
    event.location || "",
    attendees.join(", "),
  ]
    .filter(Boolean)
    .join(" • ");

  return {
    id: `calendar:${event.id}`,
    sourceType: "calendar_event",
    sourceSystem: event.source === "outlook" ? "outlook_desktop" : "google_calendar",
    title: event.title,
    body,
    createdAt: event.startTime,
    updatedAt: event.startTime,
    eventTimeStart: event.startTime,
    eventTimeEnd: event.endTime,
    participants: attendees,
    relatedCalendarEventIds: [event.id],
    trustTier: "authoritative",
    visibility: "private",
    freshnessClass: classifyEventFreshness(event.startTime),
    lexicalTerms: tokenize(body),
    metadata: {
      link: event.link,
      location: event.location,
    },
  };
}

function mapMeetingToDocuments(meeting: Meeting): ContextDocument[] {
  const docs: ContextDocument[] = [];
  const createdAt = meeting.date || new Date().toISOString();
  const overview =
    meeting.detailedSummary?.overview ||
    meeting.summary ||
    "";
  const keyPoints = meeting.detailedSummary?.keyPoints || [];
  const actionItems = meeting.detailedSummary?.actionItems || [];
  const participants = dedupeStrings(
    (meeting.transcript || [])
      .map((segment) => segment.speaker)
      .filter((speaker) => speaker && !["user", "assistant", "external"].includes(speaker.toLowerCase()))
  );

  if (overview || keyPoints.length || actionItems.length) {
    const body = [
      overview,
      keyPoints.length ? `Key points: ${keyPoints.join(" • ")}` : "",
      actionItems.length ? `Action items: ${actionItems.join(" • ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    docs.push({
      id: `meeting-summary:${meeting.id}`,
      sourceType: meeting.source === "teams" || meeting.source === "cluely" || meeting.source === "imported"
        ? "manual_import"
        : "meeting_summary",
      sourceSystem: "meeting_store",
      title: meeting.title || "Meeting summary",
      body,
      createdAt,
      updatedAt: createdAt,
      relatedMeetingIds: [meeting.id],
      relatedCalendarEventIds: meeting.calendarEventId ? [meeting.calendarEventId] : [],
      participants,
      trustTier: "durable",
      visibility: "private",
      freshnessClass: classifyFreshness(Date.parse(createdAt)),
      lexicalTerms: tokenize(`${meeting.title} ${body}`),
      metadata: {
        meetingId: meeting.id,
        calendarEventId: meeting.calendarEventId,
        source: meeting.source,
        importMetadata: meeting.importMetadata,
      },
    });
  }

  const transcript = (meeting.transcript || [])
    .slice(-25)
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join(" ");
  if (transcript.length > 50) {
    docs.push({
      id: `meeting-transcript:${meeting.id}`,
      sourceType: "meeting_transcript",
      sourceSystem: "meeting_store",
      title: `${meeting.title || "Meeting"} transcript excerpt`,
      body: transcript,
      createdAt,
      updatedAt: createdAt,
      relatedMeetingIds: [meeting.id],
      relatedCalendarEventIds: meeting.calendarEventId ? [meeting.calendarEventId] : [],
      participants,
      trustTier: "durable",
      visibility: "private",
      freshnessClass: classifyFreshness(Date.parse(createdAt)),
      lexicalTerms: tokenize(`${meeting.title} ${transcript}`),
      metadata: {
        meetingId: meeting.id,
        source: meeting.source,
      },
    });
  }

  docs.push(...commitmentExtractor.extractFromMeeting(meeting));
  return docs;
}

function buildProfileDoc(kind: string, title: string, body: string, createdAt: string): ContextDocument {
  return {
    id: `profile:${kind}`,
    sourceType: "profile_fact",
    sourceSystem: "profile_intelligence",
    title,
    body,
    createdAt,
    updatedAt: createdAt,
    trustTier: "authoritative",
    visibility: "private",
    freshnessClass: "historical",
    lexicalTerms: tokenize(`${title} ${body}`),
  };
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function classifyEventFreshness(startTime: string): ContextDocument["freshnessClass"] {
  const eventMs = Date.parse(startTime);
  const diff = eventMs - Date.now();
  if (Math.abs(diff) <= 4 * 60 * 60 * 1000) return "live";
  if (Math.abs(diff) <= 48 * 60 * 60 * 1000) return "recent";
  return "historical";
}

function classifyFreshness(timestampMs: number): ContextDocument["freshnessClass"] {
  const ageMs = Date.now() - timestampMs;
  if (ageMs <= 60 * 60 * 1000) return "live";
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return "recent";
  return "historical";
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.max(0, Math.min(1, score / 12));
}

function extractMeetingIds(source: string): string[] {
  const match = source.match(/meeting:([^:]+)/);
  return match?.[1] ? [match[1]] : [];
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
