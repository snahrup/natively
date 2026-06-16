import type { LLMHelper } from "../LLMHelper";
import type {
  Meeting,
  MeetingTranscriptReconstruction,
  MeetingReconstructedTranscriptTurn,
} from "../db/DatabaseManager";
import {
  cleanTranscriptForAnalysis,
  formatUserContextNotesForAnalysis,
} from "./TranscriptCleanupService";

const RECONSTRUCTION_MODEL = "gpt-5.5";
const RECONSTRUCTION_REASONING_EFFORT = "xhigh";
const MAX_RECONSTRUCTION_INPUT_CHARS = 30_000;
const MAX_RECONSTRUCTED_TURNS = 140;

interface ReconstructionPayload {
  summaryNotes?: string[];
  speakerMap?: Array<{
    source?: string;
    resolved?: string;
    reason?: string;
  }>;
  turns?: Array<{
    speaker?: string;
    text?: string;
    startTimestamp?: number | string;
    endTimestamp?: number | string;
    confidence?: string;
  }>;
}

export async function reconstructTranscriptWithCodex(
  llmHelper: LLMHelper,
  meeting: Pick<Meeting, "title" | "date" | "duration" | "transcript" | "detailedSummary">
): Promise<MeetingTranscriptReconstruction | null> {
  const cleaned = cleanTranscriptForAnalysis(meeting.transcript || [], {
    maxChars: MAX_RECONSTRUCTION_INPUT_CHARS,
    includeTimestamps: true,
    preserveShortAnswers: true,
  });

  if (cleaned.turns.length < 2 || cleaned.analysisText.length < 200) {
    return null;
  }

  const systemPrompt = [
    "You reconstruct noisy live meeting transcripts for durable business memory.",
    "The input is already cleaned once, but it may still contain chopped fragments, bad diarization, filler, missing words, and incorrect speaker switches.",
    "Your job is to produce a coherent analysis-grade transcript, not a summary.",
    "Use GPT-level reasoning to infer obvious missing words and merge fragments that clearly belong to the same person.",
    "Never invent new facts, decisions, names, numbers, or commitments that are not supported by the transcript or user-supplied context.",
    "If a phrase cannot be confidently reconstructed, preserve the uncertainty with [unclear] instead of making it up.",
    "When user-supplied context names participants or corrects the meeting, treat that as authoritative.",
    "Return strict JSON only. No markdown fences.",
  ].join("\n");

  const userPrompt = [
    "MEETING",
    `Title: ${meeting.title || "Untitled Session"}`,
    `Date: ${meeting.date || "Unknown"}`,
    `Duration: ${meeting.duration || "Unknown"}`,
    "",
    "USER-SUPPLIED CONTEXT",
    formatUserContextNotesForAnalysis(meeting) || "None",
    "",
    "CLEANED BUT STILL NOISY TRANSCRIPT",
    cleaned.analysisText,
    "",
    "RECONSTRUCTION REQUIREMENTS",
    "- Merge consecutive fragments when they are clearly one person's continuous thought.",
    "- Fix obvious speech-to-text garble only when the intended word is clear from context.",
    "- Keep speaker attribution stable. Do not alternate speakers just because the source labels bounced for tiny fragments.",
    "- Use real names from user-supplied context when they can be mapped confidently; otherwise keep neutral labels like Speaker 1.",
    "- Preserve questions, decisions, action items, risks, and concrete technical details.",
    "- Keep the transcript readable and analysis-grade. It does not need to be word-for-word if the raw input is fragmented.",
    `- Keep no more than ${MAX_RECONSTRUCTED_TURNS} reconstructed turns; combine adjacent material as needed.`,
    "",
    "RETURN THIS JSON SHAPE EXACTLY:",
    JSON.stringify({
      summaryNotes: [
        "short note about reconstruction confidence, limitations, or participant mapping",
      ],
      speakerMap: [
        {
          source: "Speaker 1",
          resolved: "Patrick",
          reason: "why this mapping is supported, or leave source unresolved",
        },
      ],
      turns: [
        {
          speaker: "Patrick",
          text: "coherent reconstructed transcript turn",
          startTimestamp: 1779898419029,
          endTimestamp: 1779898445786,
          confidence: "medium",
        },
      ],
    }),
  ].join("\n");

  const raw = await llmHelper.generateWithLocalCodex(
    userPrompt,
    systemPrompt,
    RECONSTRUCTION_MODEL,
    RECONSTRUCTION_REASONING_EFFORT
  );
  const parsed = parseReconstructionPayload(raw);
  if (!parsed) return null;

  const turns = sanitizeTurns(parsed.turns || []);
  if (turns.length === 0) return null;

  return {
    generatedAt: new Date().toISOString(),
    model: RECONSTRUCTION_MODEL,
    reasoningEffort: RECONSTRUCTION_REASONING_EFFORT,
    sourceRawSegments: cleaned.stats.rawSegments,
    cleanedTurns: cleaned.stats.cleanTurns,
    reconstructedTurns: turns.length,
    summaryNotes: sanitizeStringList(parsed.summaryNotes, 6),
    speakerMap: sanitizeSpeakerMap(parsed.speakerMap || []),
    turns,
  };
}

function parseReconstructionPayload(raw: string): ReconstructionPayload | null {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as ReconstructionPayload;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as ReconstructionPayload;
    } catch {
      return null;
    }
  }
}

function sanitizeTurns(turns: NonNullable<ReconstructionPayload["turns"]>): MeetingReconstructedTranscriptTurn[] {
  return turns
    .map((turn): MeetingReconstructedTranscriptTurn | null => {
      const speaker = compactWhitespace(turn?.speaker || "");
      const text = compactWhitespace(turn?.text || "");
      if (!speaker || !text) return null;
      return {
        speaker,
        text,
        startTimestamp: numberOrUndefined(turn.startTimestamp),
        endTimestamp: numberOrUndefined(turn.endTimestamp),
        confidence: normalizeConfidence(turn.confidence),
      };
    })
    .filter((turn): turn is MeetingReconstructedTranscriptTurn => Boolean(turn))
    .slice(0, MAX_RECONSTRUCTED_TURNS);
}

function sanitizeSpeakerMap(items: NonNullable<ReconstructionPayload["speakerMap"]>): MeetingTranscriptReconstruction["speakerMap"] {
  return items
    .map((item) => ({
      source: compactWhitespace(item?.source || ""),
      resolved: compactWhitespace(item?.resolved || ""),
      reason: compactWhitespace(item?.reason || "") || undefined,
    }))
    .filter((item) => item.source && item.resolved)
    .slice(0, 12);
}

function sanitizeStringList(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => compactWhitespace(String(value || "")))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeConfidence(value: unknown): "low" | "medium" | "high" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "high" || normalized === "low") return normalized;
  return "medium";
}

function numberOrUndefined(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
