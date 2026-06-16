import type { LLMHelper } from "../LLMHelper";
import type { Meeting } from "../db/DatabaseManager";
import { buildMeetingAnalysisContext } from "./TranscriptCleanupService";

const TITLE_MODEL = "gpt-5.5";
const TITLE_REASONING_EFFORT = "xhigh";

const PLACEHOLDER_TITLE_RE = /^(untitled|untitled session|processing|processing\.\.\.|live meeting|new meeting|recorded session|meeting recap|meeting notes)$/i;

export function isPlaceholderMeetingTitle(title?: string | null): boolean {
  const cleaned = compactWhitespace(title || "");
  if (!cleaned) return true;
  if (PLACEHOLDER_TITLE_RE.test(cleaned)) return true;
  if (/^untitled\b/i.test(cleaned)) return true;
  if (/^\[unknown-session\]/i.test(cleaned)) return true;
  return false;
}

export async function generateMeetingTitleWithCodex(
  llmHelper: LLMHelper,
  meeting: Pick<Meeting, "title" | "date" | "duration" | "summary" | "detailedSummary" | "transcript">
): Promise<string | null> {
  const context = buildMeetingAnalysisContext(meeting, {
    maxChars: 9_000,
    includeTimestamps: false,
  });

  const systemPrompt = [
    "You name business meetings from transcript evidence.",
    "Return only a concise meeting title.",
    "Use 3 to 7 words.",
    "Do not use quotes, markdown, dates, or generic labels like Untitled Session, Meeting Recap, or Discussion.",
    "Do not invent a topic that is not supported by the meeting context.",
  ].join("\n");

  const raw = await llmHelper.generateWithLocalCodex(
    context,
    systemPrompt,
    TITLE_MODEL,
    TITLE_REASONING_EFFORT
  );

  return sanitizeGeneratedTitle(raw);
}

function sanitizeGeneratedTitle(value: string): string | null {
  const cleaned = compactWhitespace(value)
    .replace(/^```(?:text)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["'`*_#\s]+|["'`*.\s]+$/g, "")
    .trim();

  if (!cleaned || isPlaceholderMeetingTitle(cleaned)) return null;
  if (cleaned.length < 6 || cleaned.length > 90) return null;
  if (/\n/.test(cleaned)) return sanitizeGeneratedTitle(cleaned.split(/\r?\n/).find(Boolean) || "");
  return cleaned;
}

function compactWhitespace(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
