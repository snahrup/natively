import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { CalendarEvent } from "./CalendarManager";
import type { MeetingPrepPacket } from "./MeetingPrepService";

export interface MeetingContextCapsuleRef {
  id: string;
  filePath: string;
  markdownPath: string;
  confidence: "low" | "medium" | "high";
  needsUserInput: boolean;
  updatedAt: string;
}

export interface MeetingContextCapsule extends MeetingContextCapsuleRef {
  eventId: string;
  title: string;
  generatedAt: string;
  startsAt?: string;
  endsAt?: string;
  inferredIntent: {
    objective: string;
    confidence: "low" | "medium" | "high";
    signals: string[];
    keywords: string[];
    ambiguityReasons: string[];
  };
  contextMarkdown: string;
  sourceRefs: string[];
  packetGeneratedAt?: string;
}

const BRAIN_ROOT = path.join(os.homedir(), "CascadeProjects", "ipcorp-architecture-brain");
const CAPSULE_DIR = path.join(BRAIN_ROOT, "natively", "context-capsules");

export class MeetingContextCapsuleService {
  private static instance: MeetingContextCapsuleService;

  public static getInstance(): MeetingContextCapsuleService {
    if (!MeetingContextCapsuleService.instance) {
      MeetingContextCapsuleService.instance = new MeetingContextCapsuleService();
    }
    return MeetingContextCapsuleService.instance;
  }

  public buildAndWriteCapsule(packet: MeetingPrepPacket): MeetingContextCapsuleRef | null {
    if (!packet?.event?.id) return null;
    if (!fs.existsSync(BRAIN_ROOT)) return null;

    const capsule = this.buildCapsule(packet);
    fs.mkdirSync(CAPSULE_DIR, { recursive: true });

    const jsonPath = this.getJsonPath(packet.event.id);
    const markdownPath = this.getMarkdownPath(packet.event.id);
    fs.writeFileSync(jsonPath, JSON.stringify(capsule, null, 2), "utf8");
    fs.writeFileSync(markdownPath, capsule.contextMarkdown, "utf8");

    return {
      id: capsule.id,
      filePath: path.relative(BRAIN_ROOT, jsonPath),
      markdownPath: path.relative(BRAIN_ROOT, markdownPath),
      confidence: capsule.confidence,
      needsUserInput: capsule.needsUserInput,
      updatedAt: capsule.updatedAt,
    };
  }

  public getCapsuleForEvent(eventId: string): MeetingContextCapsule | null {
    const filePath = this.getJsonPath(eventId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as MeetingContextCapsule;
      return parsed?.eventId ? parsed : null;
    } catch (error) {
      console.warn("[MeetingContextCapsuleService] Failed to read capsule:", error);
      return null;
    }
  }

  private buildCapsule(packet: MeetingPrepPacket): MeetingContextCapsule {
    const event = packet.event;
    const updatedAt = new Date().toISOString();
    const intent = inferIntent(event, packet);
    const sourceRefs = dedupeStrings([
      ...packet.memoryHighlights.map((item) => item.source),
      ...packet.memoryHighlights.map((item) => item.title),
      ...packet.relatedMeetings.map((meeting) => meeting.title),
    ]).slice(0, 16);

    const contextMarkdown = buildContextMarkdown(event, packet, intent, sourceRefs);
    const id = `capsule-${safeSegment(event.id || event.title)}-${hashText(`${event.title}:${event.startTime}`).slice(0, 8)}`;

    return {
      id,
      eventId: event.id,
      title: event.title,
      startsAt: event.startTime,
      endsAt: event.endTime,
      generatedAt: updatedAt,
      updatedAt,
      filePath: path.relative(BRAIN_ROOT, this.getJsonPath(event.id)),
      markdownPath: path.relative(BRAIN_ROOT, this.getMarkdownPath(event.id)),
      confidence: intent.confidence,
      needsUserInput: intent.confidence === "low",
      inferredIntent: intent,
      contextMarkdown,
      sourceRefs,
      packetGeneratedAt: packet.generatedAt,
    };
  }

  private getJsonPath(eventId: string): string {
    return path.join(CAPSULE_DIR, `${safeSegment(eventId)}.json`);
  }

  private getMarkdownPath(eventId: string): string {
    return path.join(CAPSULE_DIR, `${safeSegment(eventId)}.md`);
  }
}

function inferIntent(
  event: CalendarEvent,
  packet: MeetingPrepPacket
): MeetingContextCapsule["inferredIntent"] {
  const inviteText = compactWhitespace([
    event.title,
    stripHtml(event.description || ""),
    event.location || "",
    ...(event.attendees || []).map((attendee) => attendee.displayName || attendee.email),
  ].filter(Boolean).join(" "));
  const packetText = compactWhitespace([
    packet.summary,
    ...packet.contextBullets,
    ...packet.openQuestions,
    ...packet.openCommitments,
    ...packet.prepChecklist,
  ].filter(Boolean).join(" "));

  const combined = `${inviteText} ${packetText}`.toLowerCase();
  const signals: string[] = [];
  const ambiguityReasons: string[] = [];
  const keywords = extractKeywords(`${inviteText} ${packetText}`).slice(0, 16);

  const objectiveParts: string[] = [];
  if (/\b(decision|decide|approve|approval|sign[-\s]?off|go\/no-go)\b/.test(combined)) {
    signals.push("decision_or_approval");
    objectiveParts.push("drive toward a clear decision, owner, and approval boundary");
  }
  if (/\b(policy|governance|steward|stewardship|ownership|exception)\b/.test(combined)) {
    signals.push("governance_or_ownership");
    objectiveParts.push("clarify governance, ownership, and exception handling");
  }
  if (/\b(architecture|fabric|purview|m3|mes|mdm|semantic model|lakehouse|warehouse|data product)\b/.test(combined)) {
    signals.push("architecture_context");
    objectiveParts.push("connect the discussion to the current IP Corp architecture path");
  }
  if (/\b(status|standup|update|review|sync|checkpoint)\b/.test(combined)) {
    signals.push("status_or_review");
    objectiveParts.push("surface progress, blockers, and the next checkpoint");
  }
  if (/\b(risk|issue|blocker|dependency|concern|tradeoff)\b/.test(combined)) {
    signals.push("risk_or_tradeoff");
    objectiveParts.push("call out risks, tradeoffs, and follow-through gaps");
  }

  const attendeeCount = event.attendees?.length || 0;
  if (attendeeCount > 0) signals.push(`attendees_${Math.min(attendeeCount, 10)}`);
  if (event.description && stripHtml(event.description).trim().length > 40) signals.push("invite_description");
  if (packet.relatedMeetings.length > 0) signals.push("related_prior_meetings");
  if (packet.openCommitments.length > 0) signals.push("open_commitments");
  if (packet.memoryHighlights.length > 0) signals.push("brain_memory_hits");

  if (signals.length < 3) {
    ambiguityReasons.push("The invite has limited title, attendee, description, or brain-match signal.");
  }
  if (keywords.length < 5) {
    ambiguityReasons.push("Not enough distinctive terms were available to anchor the meeting topic.");
  }
  if (packet.memoryHighlights.length === 0 && packet.relatedMeetings.length === 0) {
    ambiguityReasons.push("No strong matching prior meetings or memory highlights were found.");
  }

  const confidence =
    ambiguityReasons.length === 0 && signals.length >= 5
      ? "high"
      : signals.length >= 3 || packet.memoryHighlights.length > 0
        ? "medium"
        : "low";

  const objective = objectiveParts.length > 0
    ? dedupeStrings(objectiveParts).join("; ")
    : packet.summary || `Prepare for ${event.title} using invite details and the most relevant available brain context.`;

  return {
    objective,
    confidence,
    signals: dedupeStrings(signals),
    keywords,
    ambiguityReasons,
  };
}

function buildContextMarkdown(
  event: CalendarEvent,
  packet: MeetingPrepPacket,
  intent: MeetingContextCapsule["inferredIntent"],
  sourceRefs: string[]
): string {
  const attendeeNames = (event.attendees || [])
    .map((attendee) => attendee.displayName || attendee.email)
    .filter(Boolean)
    .slice(0, 12);

  return [
    `# ${event.title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Intent confidence: ${intent.confidence}`,
    `Objective: ${intent.objective}`,
    "",
    "## Invite Signals",
    `- Starts: ${event.startTime || "unknown"}`,
    `- Ends: ${event.endTime || "unknown"}`,
    event.location ? `- Location: ${event.location}` : "",
    attendeeNames.length ? `- Attendees: ${attendeeNames.join(", ")}` : "- Attendees: not available",
    event.description ? `- Invite notes: ${compactWhitespace(stripHtml(event.description)).slice(0, 600)}` : "",
    "",
    "## Fast Context",
    packet.contextBullets.map((line) => `- ${line}`).join("\n") || "- No high-confidence context bullets yet.",
    "",
    "## Open Commitments",
    packet.openCommitments.map((line) => `- ${line}`).join("\n") || "- No open commitments surfaced.",
    "",
    "## Open Questions",
    packet.openQuestions.map((line) => `- ${line}`).join("\n") || "- No open questions surfaced.",
    "",
    "## Relevant Memory",
    packet.memoryHighlights.map((item) => `- ${item.title}: ${item.excerpt}`).join("\n") || "- No memory highlights surfaced.",
    "",
    "## Suggested Live Posture",
    packet.profileSnapshot.map((line) => `- ${line}`).join("\n") || "- Be concise, decision-oriented, and ask for ownership when follow-through is unclear.",
    "",
    "## Prep Checklist",
    packet.prepChecklist.map((line) => `- ${line}`).join("\n") || "- Confirm purpose, owner, decision boundary, and next step.",
    "",
    "## Capsule Signals",
    intent.signals.map((line) => `- ${line}`).join("\n") || "- No strong signals.",
    "",
    "## Keywords",
    intent.keywords.length ? intent.keywords.join(", ") : "none",
    "",
    "## Source References",
    sourceRefs.map((line) => `- ${line}`).join("\n") || "- Generated from invite details and current prep packet only.",
    "",
    intent.ambiguityReasons.length
      ? ["## Ambiguity", ...intent.ambiguityReasons.map((line) => `- ${line}`)].join("\n")
      : "",
    "",
  ].filter((line) => line !== "").join("\n");
}

function extractKeywords(input: string): string[] {
  const stopWords = new Set([
    "about", "after", "again", "also", "before", "being", "between", "could", "from",
    "have", "into", "meeting", "need", "notes", "review", "should", "that", "their",
    "there", "these", "this", "those", "update", "what", "when", "where", "which",
    "with", "would", "your",
  ]);

  const counts = new Map<string, number>();
  compactWhitespace(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !stopWords.has(word))
    .forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([word]) => word);
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function compactWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "meeting";
}

function hashText(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}
