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
    return {
      id: `commitment:${crypto.createHash("sha1").update(`${input.meeting.id}:${input.title}`).digest("hex").slice(0, 16)}`,
      sourceType: "task_or_commitment",
      sourceSystem: input.sourceSystem,
      title: input.title,
      body,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
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
