import type { Meeting, MeetingTranscriptReconstruction } from "../db/DatabaseManager";

type RawTranscriptSegment = NonNullable<Meeting["transcript"]>[number];

export interface CleanTranscriptTurn {
  speaker: string;
  text: string;
  startTimestamp: number;
  endTimestamp: number;
  segmentCount: number;
  sourceSpeakers: string[];
  isQuestion: boolean;
  isDecision: boolean;
  isActionItem: boolean;
}

export interface CleanTranscriptResult {
  turns: CleanTranscriptTurn[];
  analysisText: string;
  stats: {
    rawSegments: number;
    cleanTurns: number;
    rawCharacters: number;
    cleanCharacters: number;
    compressionRatio: number;
    speakers: string[];
  };
}

interface CleanTranscriptOptions {
  maxChars?: number;
  includeTimestamps?: boolean;
  preserveShortAnswers?: boolean;
}

const DEFAULT_MAX_CHARS = 28_000;
const MERGE_GAP_MS = 8_000;

const SHORT_ACK_RE = /^(ok|okay|yeah|yes|yep|no|nope|right|sure|got it|gotcha|cool|great|nice|perfect|alright|all right|mm hmm|mhm|uh huh)[.!? ]*$/i;
const FILLER_ONLY_RE = /^(um+|uh+|ah+|er+|hmm+|hm+|like|you know|i mean|basically|actually|so|well)[.!? ]*$/i;
const LEADING_FILLER_RE = /^(?:um+|uh+|ah+|er+|hmm+|hm+|okay|ok|yeah|so|well|right|like|you know|i mean|basically|actually)[,.\s]+/i;
const QUESTION_RE = /(\?|^(what|who|when|where|why|how|can|could|would|should|is|are|do|does|did|will|would)\b)/i;
const DECISION_RE = /\b(decided|agreed|confirmed|approved|settled|landed on|going with|we'?ll do|let'?s go with|decision is)\b/i;
const ACTION_RE = /\b(need to|needs to|will|going to|follow up|follow-up|send|schedule|confirm|review|check|ask|circle back|next step|todo|to do|before|by end|owner)\b/i;

export function cleanTranscriptForAnalysis(
  segments: RawTranscriptSegment[] = [],
  options: CleanTranscriptOptions = {}
): CleanTranscriptResult {
  const sorted = segments
    .filter((segment) => compactWhitespace(segment?.text || ""))
    .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0));

  const rawCharacters = sorted.reduce((total, segment) => total + compactWhitespace(segment.text).length, 0);
  const turns = mergeTranscriptSegments(sorted, options);
  const cleanCharacters = turns.reduce((total, turn) => total + turn.text.length, 0);
  const speakers = dedupe(turns.map((turn) => turn.speaker));
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const analysisText = formatTranscriptTurns(turns, maxChars, options.includeTimestamps !== false);

  return {
    turns,
    analysisText,
    stats: {
      rawSegments: sorted.length,
      cleanTurns: turns.length,
      rawCharacters,
      cleanCharacters,
      compressionRatio: rawCharacters > 0 ? Number((cleanCharacters / rawCharacters).toFixed(3)) : 0,
      speakers,
    },
  };
}

export function formatUserContextNotesForAnalysis(meeting: Pick<Meeting, "detailedSummary"> | null | undefined): string {
  const notes = meeting?.detailedSummary?.userContextNotes;
  if (!Array.isArray(notes) || notes.length === 0) return "";

  return notes
    .map((note: any, index) => {
      const text = compactWhitespace(note?.text || "");
      if (!text) return "";
      const createdAt = compactWhitespace(note?.createdAt || "");
      return `${index + 1}. ${createdAt ? `[${createdAt}] ` : ""}${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildMeetingAnalysisContext(
  meeting: Pick<Meeting, "title" | "date" | "duration" | "transcript" | "detailedSummary" | "summary">,
  options: CleanTranscriptOptions = {}
): string {
  const cleaned = cleanTranscriptForAnalysis(meeting.transcript || [], options);
  const reconstructedTranscript = formatReconstructedTranscript(meeting.detailedSummary?.reconstructedTranscript);
  const notes = formatUserContextNotesForAnalysis(meeting);
  const sourceSummary = compactWhitespace(meeting.detailedSummary?.overview || meeting.summary || "");
  const keyPoints = Array.isArray(meeting.detailedSummary?.keyPoints) ? meeting.detailedSummary.keyPoints : [];
  const actionItems = Array.isArray(meeting.detailedSummary?.actionItems) ? meeting.detailedSummary.actionItems : [];

  return [
    "MEETING METADATA",
    `Title: ${meeting.title || "Untitled Session"}`,
    `Date: ${meeting.date || "Unknown"}`,
    `Duration: ${meeting.duration || "Unknown"}`,
    reconstructedTranscript
      ? `Transcript cleanup: ${cleaned.stats.rawSegments} raw segments merged into ${cleaned.stats.cleanTurns} readable turns, then reconstructed into ${meeting.detailedSummary?.reconstructedTranscript?.reconstructedTurns || 0} coherent analysis turns with GPT 5.5 xhigh.`
      : `Transcript cleanup: ${cleaned.stats.rawSegments} raw segments merged into ${cleaned.stats.cleanTurns} readable turns across ${cleaned.stats.speakers.length} speaker label(s).`,
    "",
    sourceSummary ? `EXISTING SOURCE SUMMARY\n${sourceSummary}\n` : "",
    keyPoints.length ? `EXISTING KEY POINTS\n${keyPoints.map((point) => `- ${point}`).join("\n")}\n` : "",
    actionItems.length ? `EXISTING ACTION ITEMS\n${actionItems.map((item) => `- ${item}`).join("\n")}\n` : "",
    notes ? `USER-SUPPLIED CONTEXT\n${notes}\n` : "",
    reconstructedTranscript ? "RECONSTRUCTED TRANSCRIPT" : "CLEANED TRANSCRIPT",
    reconstructedTranscript || cleaned.analysisText || "No usable transcript text was captured.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatReconstructedTranscript(reconstruction?: MeetingTranscriptReconstruction): string {
  const turns = reconstruction?.turns;
  if (!Array.isArray(turns) || turns.length === 0) return "";

  return turns
    .map((turn: any) => {
      const speaker = compactWhitespace(turn?.speaker || "Speaker");
      const text = compactWhitespace(turn?.text || "");
      if (!text) return "";
      const timestamp = Number.isFinite(Number(turn?.startTimestamp))
        ? `[${formatClock(Number(turn.startTimestamp))}] `
        : "";
      const confidence = compactWhitespace(turn?.confidence || "");
      return `${timestamp}${speaker}${confidence && confidence !== "high" ? ` (${confidence} confidence)` : ""}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function mergeTranscriptSegments(
  sorted: RawTranscriptSegment[],
  options: CleanTranscriptOptions
): CleanTranscriptTurn[] {
  const turns: CleanTranscriptTurn[] = [];

  for (const segment of sorted) {
    const speaker = normalizeSpeaker(segment.speaker);
    const text = cleanSegmentText(segment.text);
    if (!shouldKeepText(text, options)) continue;

    const timestamp = Number.isFinite(segment.timestamp) ? segment.timestamp : Date.now();
    const previous = turns[turns.length - 1];
    const canMerge = previous &&
      previous.speaker === speaker &&
      timestamp - previous.endTimestamp <= MERGE_GAP_MS;

    if (canMerge) {
      previous.text = joinTurnText(previous.text, text);
      previous.endTimestamp = Math.max(previous.endTimestamp, timestamp);
      previous.segmentCount += 1;
      previous.isQuestion = previous.isQuestion || QUESTION_RE.test(text);
      previous.isDecision = previous.isDecision || DECISION_RE.test(text);
      previous.isActionItem = previous.isActionItem || ACTION_RE.test(text);
      continue;
    }

    turns.push({
      speaker,
      text,
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      segmentCount: 1,
      sourceSpeakers: [compactWhitespace(segment.speaker || speaker)],
      isQuestion: QUESTION_RE.test(text),
      isDecision: DECISION_RE.test(text),
      isActionItem: ACTION_RE.test(text),
    });
  }

  return turns.filter((turn) => shouldKeepTurn(turn, options));
}

function formatTranscriptTurns(turns: CleanTranscriptTurn[], maxChars: number, includeTimestamps: boolean): string {
  const lines = turns.map((turn) => {
    const markers = [
      turn.isQuestion ? "question" : "",
      turn.isDecision ? "decision" : "",
      turn.isActionItem ? "action" : "",
    ].filter(Boolean);
    const prefix = includeTimestamps
      ? `[${formatClock(turn.startTimestamp)}] ${turn.speaker}${markers.length ? ` (${markers.join(", ")})` : ""}:`
      : `${turn.speaker}${markers.length ? ` (${markers.join(", ")})` : ""}:`;
    return `${prefix} ${turn.text}`;
  });

  const output: string[] = [];
  let total = 0;

  for (const line of lines) {
    if (total + line.length + 1 > maxChars) {
      const remaining = lines.length - output.length;
      output.push(`[Transcript truncated for analysis after ${output.length} cleaned turns; ${remaining} additional turns remain in raw storage.]`);
      break;
    }
    output.push(line);
    total += line.length + 1;
  }

  return output.join("\n");
}

function shouldKeepText(text: string, options: CleanTranscriptOptions): boolean {
  if (!text) return false;
  if (FILLER_ONLY_RE.test(text)) return false;
  if (SHORT_ACK_RE.test(text) && options.preserveShortAnswers !== true) return false;
  return true;
}

function shouldKeepTurn(turn: CleanTranscriptTurn, options: CleanTranscriptOptions): boolean {
  const words = turn.text.split(/\s+/).filter(Boolean);
  if (words.length >= 4) return true;
  if (options.preserveShortAnswers === true && /^(no|yes|yep|nope)\b/i.test(turn.text)) return true;
  return turn.isQuestion || turn.isDecision || turn.isActionItem || turn.text.length >= 22;
}

function cleanSegmentText(value: string): string {
  let text = compactWhitespace(value);
  if (!text) return "";

  text = text.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, "$1");

  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEADING_FILLER_RE, "");
    if (next === text) break;
    text = next;
  }

  text = text
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([!?.,]){3,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

function joinTurnText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith("-")) return `${left}${right}`;
  return `${left} ${right}`.replace(/\s+/g, " ").trim();
}

function normalizeSpeaker(value: string): string {
  const speaker = compactWhitespace(value || "");
  if (!speaker) return "Speaker";
  const lower = speaker.toLowerCase();
  if (lower === "external") return "Meeting Audio";
  if (lower === "user") return "Steve";
  if (lower === "assistant") return "Natively";
  if (lower === "me" || lower === "self") return "Steve";
  return speaker;
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "00:00";
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
