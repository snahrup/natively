import fs from "fs";
import path from "path";
import crypto from "crypto";
import mammoth from "mammoth";
const pdfParse = require("pdf-parse");

import type { LLMHelper } from "../LLMHelper";
import { DatabaseManager, type Meeting, type MeetingSource } from "../db/DatabaseManager";
import type { TranscriptSegment } from "../SessionTracker";
import type { RAGManager } from "../rag/RAGManager";
import { ContradictionDetector } from "./ContradictionDetector";
import { MeetingMemoryBrain } from "./MeetingMemoryBrain";
import { GROQ_SUMMARY_JSON_PROMPT, GROQ_TITLE_PROMPT } from "../llm";

export interface MeetingImportArtifact {
  id?: string;
  inputType: "file" | "text";
  name: string;
  path?: string;
  content?: string;
  kind?: "auto" | "summary" | "transcript" | "usage" | "notes";
  sourceFormat?: "auto" | "cluely" | "teams" | "generic";
  meetingTitle?: string;
  meetingDate?: string;
}

export interface MeetingImportMeetingReport {
  meetingId: string;
  title: string;
  date: string;
  attendees: string[];
  transcriptSegments: number;
  relatedArtifacts: string[];
  summaryOverview: string;
  sourceFormat: string;
}

export interface MeetingImportResult {
  importedMeetings: MeetingImportMeetingReport[];
  skippedArtifacts: Array<{ name: string; reason: string }>;
  totalArtifacts: number;
}

interface ResolvedArtifact {
  id: string;
  name: string;
  content: string;
  kind: "summary" | "transcript" | "usage" | "notes";
  sourceFormat: "cluely" | "teams" | "generic";
  meetingTitle?: string;
  meetingDate?: string;
  modifiedAt?: string;
}

interface ImportGroup {
  key: string;
  sourceFormat: "cluely" | "teams" | "generic";
  artifacts: ResolvedArtifact[];
}

interface SummaryData {
  overview: string;
  keyPoints: string[];
  actionItems: string[];
  attendees: string[];
}

const IMPORT_SOURCE_PRIORITY: Record<MeetingSource, number> = {
  manual: 0,
  calendar: 0,
  imported: 1,
  cluely: 2,
  teams: 3,
};

export class MeetingImportService {
  public async importArtifacts(
    artifacts: MeetingImportArtifact[],
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null }
  ): Promise<MeetingImportResult> {
    const dbManager = DatabaseManager.getInstance();
    if (!dbManager.isReady()) {
      throw new Error(dbManager.getInitError() || "SQLite persistence is unavailable.");
    }

    const resolved: ResolvedArtifact[] = [];
    const skippedArtifacts: Array<{ name: string; reason: string }> = [];

    for (const artifact of artifacts) {
      try {
        const loaded = await this.resolveArtifact(artifact);
        if (!loaded.content.trim()) {
          skippedArtifacts.push({ name: artifact.name, reason: "No readable text content found" });
          continue;
        }
        resolved.push(loaded);
      } catch (error: any) {
        skippedArtifacts.push({ name: artifact.name, reason: error?.message || "Failed to read artifact" });
      }
    }

    const groups = this.groupArtifacts(resolved);
    const importedMeetings: MeetingImportMeetingReport[] = [];

    for (const group of groups) {
      const report = await this.importGroup(group, deps);
      if (report) importedMeetings.push(report);
    }

    await MeetingMemoryBrain.getInstance().reload();

    return {
      importedMeetings,
      skippedArtifacts,
      totalArtifacts: artifacts.length,
    };
  }

  private async resolveArtifact(artifact: MeetingImportArtifact): Promise<ResolvedArtifact> {
    let content = artifact.content || "";
    let modifiedAt: string | undefined;

    if (artifact.inputType === "file") {
      if (!artifact.path) throw new Error("Missing file path");
      const stat = fs.statSync(artifact.path);
      modifiedAt = stat.mtime.toISOString();
      content = await this.readArtifactText(artifact.path);
    }

    const kind = this.resolveKind(artifact.name, content, artifact.kind);
    const sourceFormat = this.resolveSourceFormat(artifact.name, content, artifact.sourceFormat);

    return {
      id: artifact.id || crypto.randomUUID(),
      name: artifact.name,
      content,
      kind,
      sourceFormat,
      meetingTitle: artifact.meetingTitle?.trim() || undefined,
      meetingDate: artifact.meetingDate?.trim() || undefined,
      modifiedAt,
    };
  }

  private async readArtifactText(filePath: string): Promise<string> {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".pdf")) {
      const buffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(buffer);
      return parsed.text || "";
    }

    if (lower.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value || "";
    }

    return fs.readFileSync(filePath, "utf-8");
  }

  private resolveKind(
    name: string,
    content: string,
    requestedKind?: MeetingImportArtifact["kind"]
  ): ResolvedArtifact["kind"] {
    if (requestedKind && requestedKind !== "auto") return requestedKind;

    const lowerName = name.toLowerCase();
    if (lowerName.includes("transcript") || lowerName.endsWith(".vtt") || lowerName.endsWith(".srt")) {
      return "transcript";
    }
    if (lowerName.includes("summary") || lowerName.includes("recap")) return "summary";
    if (lowerName.includes("usage") || lowerName.includes("assist")) return "usage";
    if (lowerName.includes("note")) return "notes";

    const lowerContent = content.toLowerCase();
    if (lowerContent.includes("action items") || lowerContent.includes("key points") || lowerContent.includes("overview")) {
      return "summary";
    }
    if (lowerContent.includes("webvtt") || /^.{0,80}:\s.+$/m.test(content)) {
      return "transcript";
    }
    return "notes";
  }

  private resolveSourceFormat(
    name: string,
    content: string,
    requested?: MeetingImportArtifact["sourceFormat"]
  ): ResolvedArtifact["sourceFormat"] {
    if (requested && requested !== "auto") return requested;
    const lowerName = name.toLowerCase();
    const lowerContent = content.toLowerCase();
    if (lowerName.includes("cluely") || lowerContent.includes("cluely")) return "cluely";
    if (lowerName.includes("teams") || lowerContent.includes("microsoft teams")) return "teams";
    return "generic";
  }

  private groupArtifacts(artifacts: ResolvedArtifact[]): ImportGroup[] {
    const map = new Map<string, ImportGroup>();

    for (const artifact of artifacts) {
      const key = this.resolveGroupKey(artifact);
      const existing = map.get(key);
      if (existing) {
        existing.artifacts.push(artifact);
        if (existing.sourceFormat === "generic" && artifact.sourceFormat !== "generic") {
          existing.sourceFormat = artifact.sourceFormat;
        }
        continue;
      }
      map.set(key, {
        key,
        sourceFormat: artifact.sourceFormat,
        artifacts: [artifact],
      });
    }

    return Array.from(map.values());
  }

  private resolveGroupKey(artifact: ResolvedArtifact): string {
    if (artifact.meetingTitle) {
      return normalizeKey(`${artifact.meetingTitle} ${artifact.meetingDate || ""}`);
    }

    const nameNoExt = artifact.name.replace(/\.[^.]+$/, "");
    const cleaned = nameNoExt
      .replace(/\b(summary|transcript|usage|notes?|meeting|teams|cluely|export|recording)\b/gi, " ")
      .replace(/[_-]+/g, " ");
    const explicitTitle = extractExplicitTitle(artifact.content);

    return normalizeKey(`${explicitTitle || cleaned} ${artifact.meetingDate || ""}`);
  }

  private async importGroup(
    group: ImportGroup,
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null }
  ): Promise<MeetingImportMeetingReport | null> {
    const dbManager = DatabaseManager.getInstance();
    const summaryTexts = group.artifacts.filter((artifact) => artifact.kind === "summary").map((artifact) => artifact.content);
    const transcriptTexts = group.artifacts.filter((artifact) => artifact.kind === "transcript").map((artifact) => artifact.content);
    const usageTexts = group.artifacts.filter((artifact) => artifact.kind === "usage").map((artifact) => artifact.content);
    const noteTexts = group.artifacts.filter((artifact) => artifact.kind === "notes").map((artifact) => artifact.content);

    const combinedSummary = summaryTexts.join("\n\n");
    const combinedTranscript = transcriptTexts.join("\n\n");
    const combinedNotes = noteTexts.join("\n\n");
    const combinedUsage = usageTexts.join("\n\n");
    const allText = [combinedSummary, combinedTranscript, combinedNotes, combinedUsage].filter(Boolean).join("\n\n");

    if (!allText.trim()) return null;

    const titleSeed =
      group.artifacts.find((artifact) => artifact.meetingTitle)?.meetingTitle ||
      extractExplicitTitle(combinedSummary) ||
      extractExplicitTitle(combinedTranscript) ||
      denormalizeKey(group.key);

    const meetingDate =
      group.artifacts.find((artifact) => artifact.meetingDate)?.meetingDate ||
      group.artifacts.find((artifact) => artifact.modifiedAt)?.modifiedAt ||
      extractDateFromText(allText) ||
      new Date().toISOString();

    const summaryData = await this.buildSummaryData({
      llmHelper: deps.llmHelper,
      titleSeed,
      summaryText: combinedSummary,
      transcriptText: combinedTranscript || combinedNotes,
      usageText: combinedUsage,
    });

    const transcriptSegments = parseTranscriptSegments(combinedTranscript || combinedNotes);
    const attendees = dedupeStrings([
      ...extractAttendees(allText),
      ...summaryData.attendees,
    ]);

    const startTime = normalizeDate(meetingDate).getTime();
    const durationMs = estimateDurationMs(transcriptSegments);
    const meetingId = `import-${crypto
      .createHash("sha1")
      .update(`${group.key}\n${meetingDate}\n${allText}`)
      .digest("hex")
      .slice(0, 12)}`;

    const usage = combinedUsage.trim()
      ? [{
          type: "assist" as const,
          timestamp: startTime,
          answer: combinedUsage.trim(),
        }]
      : [];

    const meeting: Meeting = {
      id: meetingId,
      title: await this.resolveMeetingTitle(deps.llmHelper, titleSeed, allText),
      date: normalizeDate(meetingDate).toISOString(),
      duration: formatDuration(durationMs),
      summary: summaryData.overview || "Imported meeting",
      detailedSummary: {
        overview: summaryData.overview,
        actionItems: summaryData.actionItems,
        keyPoints: summaryData.keyPoints,
      },
      transcript: transcriptSegments,
      usage,
      source: resolveMeetingSource(group.sourceFormat),
      importMetadata: {
        sourceFormat: group.sourceFormat,
        importedAt: new Date().toISOString(),
        fidelity: combinedSummary.trim() ? "exact" : "reconstructed",
        relatedArtifacts: group.artifacts.map((artifact) => artifact.name),
      },
      isProcessed: true,
    };

    const existingMeeting = this.findMatchingImportedMeeting(group.key, titleSeed, meeting.date, dbManager);
    const persistedMeeting = existingMeeting
      ? this.mergeImportedMeeting(existingMeeting, meeting)
      : meeting;
    const persistedStartTime = normalizeDate(persistedMeeting.date).getTime();
    const persistedTranscriptSegments = toTranscriptSegments(persistedMeeting.transcript || []);
    const persistedDurationMs = estimateDurationMs(persistedTranscriptSegments);

    dbManager.saveMeeting(persistedMeeting, persistedStartTime, persistedDurationMs);

    this.schedulePostImportProcessing(
      persistedMeeting.id,
      persistedMeeting.title,
      persistedTranscriptSegments,
      deps.ragManager || null
    );

    return {
      meetingId: persistedMeeting.id,
      title: persistedMeeting.title,
      date: persistedMeeting.date,
      attendees,
      transcriptSegments: persistedMeeting.transcript?.length || 0,
      relatedArtifacts: persistedMeeting.importMetadata?.relatedArtifacts || group.artifacts.map((artifact) => artifact.name),
      summaryOverview: persistedMeeting.detailedSummary?.overview || persistedMeeting.summary,
      sourceFormat: persistedMeeting.importMetadata?.sourceFormat || group.sourceFormat,
    };
  }

  private findMatchingImportedMeeting(
    groupKey: string,
    titleSeed: string,
    meetingDate: string,
    dbManager: DatabaseManager
  ): Meeting | null {
    const candidates = dbManager
      .getRecentMeetings(250)
      .filter((meeting) => meeting.source === "teams" || meeting.source === "cluely" || meeting.source === "imported");

    let bestMatchId: string | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = scoreImportedMeetingMatch(candidate, groupKey, titleSeed, meetingDate);
      if (score > bestScore) {
        bestScore = score;
        bestMatchId = candidate.id;
      }
    }

    if (!bestMatchId || bestScore < 70) {
      return null;
    }

    return dbManager.getMeetingDetails(bestMatchId);
  }

  private mergeImportedMeeting(existing: Meeting, incoming: Meeting): Meeting {
    const mergedTranscript = selectPreferredTranscript(existing, incoming);
    const mergedSource = selectHigherAuthoritySource(existing.source, incoming.source);
    const mergedOverview = selectPreferredText(
      existing.detailedSummary?.overview || existing.summary,
      incoming.detailedSummary?.overview || incoming.summary,
      existing.source,
      incoming.source
    ) || "Imported meeting";

    return {
      id: existing.id,
      title: selectPreferredText(existing.title, incoming.title, existing.source, incoming.source) || incoming.title || existing.title,
      date: selectPreferredDate(existing.date, incoming.date, existing.source, incoming.source),
      duration: formatDuration(estimateDurationMs(mergedTranscript)),
      summary: mergedOverview,
      detailedSummary: {
        overview: mergedOverview,
        actionItems: mergePreferredLists(
          existing.detailedSummary?.actionItems || [],
          incoming.detailedSummary?.actionItems || [],
          existing.source,
          incoming.source
        ),
        keyPoints: mergePreferredLists(
          existing.detailedSummary?.keyPoints || [],
          incoming.detailedSummary?.keyPoints || [],
          existing.source,
          incoming.source
        ),
      },
      transcript: mergedTranscript,
      usage: mergeUsage(existing.usage || [], incoming.usage || []),
      calendarEventId: incoming.calendarEventId || existing.calendarEventId,
      source: mergedSource,
      importMetadata: {
        sourceFormat: resolveSourceFormatFromMeetingSource(mergedSource),
        importedAt: new Date().toISOString(),
        fidelity: mergeImportFidelity(existing.importMetadata?.fidelity, incoming.importMetadata?.fidelity),
        relatedArtifacts: dedupeStrings([
          ...(existing.importMetadata?.relatedArtifacts || []),
          ...(incoming.importMetadata?.relatedArtifacts || []),
        ]),
        sourceMeetingId: incoming.importMetadata?.sourceMeetingId || existing.importMetadata?.sourceMeetingId,
      },
      isProcessed: true,
    };
  }

  private schedulePostImportProcessing(
    meetingId: string,
    meetingTitle: string,
    transcriptSegments: TranscriptSegment[],
    ragManager?: RAGManager | null
  ): void {
    void (async () => {
      try {
        if (transcriptSegments.length > 0) {
          const transcriptText = transcriptSegments
            .map((segment) => `${segment.speaker}: ${segment.text}`)
            .join("\n");
          await ContradictionDetector.getInstance()
            .processTranscript(meetingId, meetingTitle, transcriptText)
            .catch(() => {});
        }

        if (ragManager) {
          await ragManager.reprocessMeeting(meetingId).catch((error) => {
            console.warn(`[MeetingImportService] Failed to reprocess imported meeting ${meetingId} for RAG:`, error);
          });
        }
      } catch (error) {
        console.warn(`[MeetingImportService] Background post-import processing failed for ${meetingId}:`, error);
      }
    })();
  }

  private async resolveMeetingTitle(
    llmHelper: LLMHelper,
    titleSeed: string,
    allText: string
  ): Promise<string> {
    const cleanSeed = titleSeed.replace(/\s+/g, " ").trim();
    if (cleanSeed && cleanSeed !== "Imported Meeting") return cleanSeed;

    try {
      const titlePrompt = "Generate a concise 3-6 word title for this meeting context. Output ONLY the title text. Do not use quotes or conversational filler.";
      const generatedTitle = await llmHelper.generateMeetingSummary(
        titlePrompt,
        allText.slice(0, 5000),
        GROQ_TITLE_PROMPT
      );
      return generatedTitle?.replace(/["*]/g, "").trim() || "Imported Meeting";
    } catch {
      return "Imported Meeting";
    }
  }

  private async buildSummaryData(params: {
    llmHelper: LLMHelper;
    titleSeed: string;
    summaryText: string;
    transcriptText: string;
    usageText: string;
  }): Promise<SummaryData> {
    const parsedSummary = parseSummaryBlocks(params.summaryText);
    if (parsedSummary.overview || parsedSummary.keyPoints.length || parsedSummary.actionItems.length) {
      return parsedSummary;
    }

    const sourceText = [params.summaryText, params.transcriptText, params.usageText].filter(Boolean).join("\n\n");
    if (!sourceText.trim()) {
      return {
        overview: `${params.titleSeed} imported without readable content.`,
        keyPoints: [],
        actionItems: [],
        attendees: [],
      };
    }

    const summaryPrompt = `You are a silent meeting summarizer. Convert this imported meeting material into concise internal meeting notes.

RULES:
- Do NOT invent information not present in the content
- You MAY infer implied action items if they are clear
- Do NOT mention AI, imports, transcripts, or file formats
- Sound like sharp internal meeting prep notes

Return ONLY valid JSON:
{
  "overview": "1-2 sentence description of what was discussed",
  "keyPoints": ["3-6 concrete bullets"],
  "actionItems": ["specific next steps"],
  "attendees": ["names if they can be inferred, otherwise []"]
}`;

    try {
      const raw = await params.llmHelper.generateMeetingSummary(
        summaryPrompt,
        sourceText.slice(0, 12000),
        GROQ_SUMMARY_JSON_PROMPT
      );
      const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/) || [null, raw];
      const parsed = JSON.parse((jsonMatch[1] || raw).trim());
      return {
        overview: String(parsed.overview || "").trim(),
        keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.map(cleanLine).filter(Boolean) : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(cleanLine).filter(Boolean) : [],
        attendees: Array.isArray(parsed.attendees) ? parsed.attendees.map(cleanLine).filter(Boolean) : [],
      };
    } catch {
      return {
        overview: cleanLine(sourceText.slice(0, 260)),
        keyPoints: extractBulletLines(sourceText).slice(0, 5),
        actionItems: [],
        attendees: extractAttendees(sourceText),
      };
    }
  }
}

function resolveMeetingSource(sourceFormat: ResolvedArtifact["sourceFormat"]): MeetingSource {
  if (sourceFormat === "teams") return "teams";
  if (sourceFormat === "cluely") return "cluely";
  return "imported";
}

function resolveSourceFormatFromMeetingSource(source?: MeetingSource): ResolvedArtifact["sourceFormat"] {
  if (source === "teams") return "teams";
  if (source === "cluely") return "cluely";
  return "generic";
}

function getSourceAuthority(source?: MeetingSource): number {
  return IMPORT_SOURCE_PRIORITY[source || "imported"] ?? 0;
}

function selectHigherAuthoritySource(left?: MeetingSource, right?: MeetingSource): MeetingSource {
  return getSourceAuthority(right) > getSourceAuthority(left) ? (right || "imported") : (left || "imported");
}

function selectPreferredText(
  left: string | undefined,
  right: string | undefined,
  leftSource?: MeetingSource,
  rightSource?: MeetingSource
): string {
  const normalizedLeft = cleanLine(left || "");
  const normalizedRight = cleanLine(right || "");

  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;

  const leftAuthority = getSourceAuthority(leftSource);
  const rightAuthority = getSourceAuthority(rightSource);
  if (leftAuthority !== rightAuthority) {
    return rightAuthority > leftAuthority ? normalizedRight : normalizedLeft;
  }

  return normalizedRight.length > normalizedLeft.length ? normalizedRight : normalizedLeft;
}

function mergePreferredLists(
  left: string[],
  right: string[],
  leftSource?: MeetingSource,
  rightSource?: MeetingSource
): string[] {
  const normalizedLeft = dedupeStrings(left.map(cleanLine).filter(Boolean));
  const normalizedRight = dedupeStrings(right.map(cleanLine).filter(Boolean));

  if (normalizedLeft.length === 0) return normalizedRight;
  if (normalizedRight.length === 0) return normalizedLeft;

  if (getSourceAuthority(rightSource) > getSourceAuthority(leftSource)) {
    return dedupeStrings([...normalizedRight, ...normalizedLeft]).slice(0, 8);
  }
  if (getSourceAuthority(rightSource) < getSourceAuthority(leftSource)) {
    return dedupeStrings([...normalizedLeft, ...normalizedRight]).slice(0, 8);
  }

  return dedupeStrings(
    normalizedRight.join(" ").length > normalizedLeft.join(" ").length
      ? [...normalizedRight, ...normalizedLeft]
      : [...normalizedLeft, ...normalizedRight]
  ).slice(0, 8);
}

function selectPreferredTranscript(left: Meeting, right: Meeting): TranscriptSegment[] {
  const leftTranscript = toTranscriptSegments(left.transcript || []);
  const rightTranscript = toTranscriptSegments(right.transcript || []);

  if (leftTranscript.length === 0) return rightTranscript;
  if (rightTranscript.length === 0) return leftTranscript;

  const leftAuthority = getSourceAuthority(left.source);
  const rightAuthority = getSourceAuthority(right.source);
  if (leftAuthority !== rightAuthority) {
    return rightAuthority > leftAuthority ? rightTranscript : leftTranscript;
  }

  return transcriptCharacterLength(rightTranscript) > transcriptCharacterLength(leftTranscript)
    ? rightTranscript
    : leftTranscript;
}

function transcriptCharacterLength(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + (segment.text?.length || 0), 0);
}

function toTranscriptSegments(
  segments: Array<{ speaker: string; text: string; timestamp: number; final?: boolean }>
): TranscriptSegment[] {
  return segments.map((segment) => ({
    speaker: segment.speaker,
    text: segment.text,
    timestamp: segment.timestamp,
    final: segment.final ?? true,
  }));
}

function selectPreferredDate(
  left: string,
  right: string,
  leftSource?: MeetingSource,
  rightSource?: MeetingSource
): string {
  const leftDate = normalizeDate(left);
  const rightDate = normalizeDate(right);
  const leftTime = leftDate.getTime();
  const rightTime = rightDate.getTime();

  if (Number.isNaN(leftTime)) return rightDate.toISOString();
  if (Number.isNaN(rightTime)) return leftDate.toISOString();

  if (Math.abs(leftTime - rightTime) <= 36 * 60 * 60 * 1000) {
    return new Date(Math.min(leftTime, rightTime)).toISOString();
  }

  return getSourceAuthority(rightSource) > getSourceAuthority(leftSource)
    ? rightDate.toISOString()
    : leftDate.toISOString();
}

function mergeImportFidelity(
  left?: "exact" | "reconstructed",
  right?: "exact" | "reconstructed"
): "exact" | "reconstructed" {
  if (left === "exact" || right === "exact") return "exact";
  return "reconstructed";
}

function mergeUsage(left: Meeting["usage"] = [], right: Meeting["usage"] = []): Meeting["usage"] {
  const allowedTypes = new Set(["assist", "followup", "chat", "followup_questions"]);
  const merged = [...left, ...right]
    .filter((entry): entry is NonNullable<Meeting["usage"]>[number] => !!entry && allowedTypes.has(entry.type))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const seen = new Set<string>();
  return merged.filter((entry) => {
    const key = JSON.stringify([
      entry.type,
      entry.timestamp || 0,
      cleanLine(entry.question || ""),
      Array.isArray(entry.answer) ? "" : cleanLine(entry.answer || ""),
      Array.isArray(entry.items) ? entry.items.map(cleanLine) : [],
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreImportedMeetingMatch(candidate: Meeting, groupKey: string, titleSeed: string, meetingDate: string): number {
  const candidateTitleKey = normalizeKey(candidate.title || "");
  const groupTitleKey = normalizeKey(groupKey);
  const seedTitleKey = normalizeKey(titleSeed);
  const candidateTokens = extractMatchTokens(candidate.title || "");
  const targetTokens = new Set([
    ...extractMatchTokens(groupTitleKey),
    ...extractMatchTokens(seedTitleKey),
  ]);

  let score = 0;

  if (candidateTitleKey === groupTitleKey || candidateTitleKey === seedTitleKey) {
    score += 70;
  } else if (targetTokens.size > 0 && candidateTokens.size > 0) {
    const overlapCount = Array.from(targetTokens).filter((token) => candidateTokens.has(token)).length;
    const overlapRatio = overlapCount / Math.max(targetTokens.size, candidateTokens.size);
    if (overlapRatio >= 0.75) score += 55;
    else if (overlapRatio >= 0.5 && overlapCount >= 2) score += 40;
    else return 0;
  } else {
    return 0;
  }

  const candidateDate = normalizeDate(candidate.date);
  const incomingDate = normalizeDate(meetingDate);
  const dateDelta = Math.abs(candidateDate.getTime() - incomingDate.getTime());
  if (!Number.isNaN(dateDelta)) {
    if (isSameUtcDay(candidateDate, incomingDate)) score += 30;
    else if (dateDelta <= 12 * 60 * 60 * 1000) score += 20;
    else if (dateDelta <= 36 * 60 * 60 * 1000) score += 10;
  }

  score += getSourceAuthority(candidate.source);
  return score;
}

function extractMatchTokens(value: string): Set<string> {
  return new Set(
    normalizeKey(value)
      .split(" ")
      .filter((token) => token.length >= 3 && !["the", "and", "for", "with", "from", "meeting", "session"].includes(token))
  );
}

function isSameUtcDay(left: Date, right: Date): boolean {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

function parseTranscriptSegments(text: string): TranscriptSegment[] {
  const normalized = text
    .replace(/^WEBVTT\s*/i, "")
    .replace(/\r/g, "");
  const lines = normalized.split("\n");
  const segments: TranscriptSegment[] = [];
  let fallbackTimestamp = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}$/.test(line)) continue;

    const speakerMatch =
      line.match(/^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+([^:]{2,80}):\s+(.+)$/) ||
      line.match(/^([^:]{2,80})\s+\(((?:\d{1,2}:)?\d{1,2}:\d{2})\):\s+(.+)$/) ||
      line.match(/^<v\s+([^>]+)>(.+)$/i) ||
      line.match(/^([^:]{2,80}):\s+(.+)$/);

    if (speakerMatch) {
      const speaker = cleanSpeaker(speakerMatch[2] || speakerMatch[1] || "external");
      const textContent = cleanLine(speakerMatch[3] || speakerMatch[2] || "");
      if (!textContent || isHeadingSpeaker(speaker)) continue;
      const ts = speakerMatch[1] && /\d/.test(speakerMatch[1]) ? parseTimestampMs(speakerMatch[1]) : fallbackTimestamp;
      segments.push({
        speaker: mapSpeaker(speaker),
        text: textContent,
        timestamp: ts,
        final: true,
      });
      fallbackTimestamp = ts + 15_000;
      continue;
    }

    const existing = segments[segments.length - 1];
    if (existing) {
      existing.text = `${existing.text} ${cleanLine(line)}`.trim();
      continue;
    }

    segments.push({
      speaker: "external",
      text: cleanLine(line),
      timestamp: fallbackTimestamp,
      final: true,
    });
    fallbackTimestamp += 15_000;
  }

  return segments.slice(0, 800);
}

function parseSummaryBlocks(text: string): SummaryData {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: Record<string, string[]> = {
    overview: [],
    keyPoints: [],
    actionItems: [],
    attendees: [],
  };

  let current: keyof typeof sections | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const headingMatch = line.match(/^(overview|summary|key points?|action items?|next steps?|attendees?)\s*:?\s*(.*)$/i);
    if (headingMatch) {
      const heading = headingMatch[1].toLowerCase();
      const remainder = cleanLine(headingMatch[2] || "");

      if (heading.startsWith("overview") || heading.startsWith("summary")) current = "overview";
      else if (heading.startsWith("key")) current = "keyPoints";
      else if (heading.startsWith("action") || heading.startsWith("next")) current = "actionItems";
      else current = "attendees";

      if (remainder) sections[current].push(remainder);
      continue;
    }

    if (line.startsWith("-") || line.startsWith("*")) {
      const cleaned = cleanLine(line.replace(/^[-*]\s*/, ""));
      if (!cleaned) continue;
      sections[current || "keyPoints"].push(cleaned);
      continue;
    }

    sections[current || "overview"].push(cleanLine(line));
  }

  return {
    overview: cleanLine(sections.overview.join(" ").slice(0, 500)),
    keyPoints: dedupeStrings(sections.keyPoints.map(cleanLine).filter(Boolean)).slice(0, 6),
    actionItems: dedupeStrings(sections.actionItems.map(cleanLine).filter(Boolean)).slice(0, 6),
    attendees: dedupeStrings(sections.attendees.flatMap(splitNames)).slice(0, 12),
  };
}

function extractAttendees(text: string): string[] {
  const attendees: string[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^(attendees?|participants?)\s*:\s*(.+)$/i);
    if (match) attendees.push(...splitNames(match[2]));
  }

  return dedupeStrings(attendees.map(cleanLine).filter(Boolean));
}

function extractExplicitTitle(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 12)) {
    const match = line.match(/^(title|meeting|session)\s*:\s*(.+)$/i);
    if (match) return cleanLine(match[2]);
  }
  return null;
}

function extractDateFromText(text: string): string | null {
  const dateMatch = text.match(/\b(20\d{2}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]*)?)\b/);
  if (dateMatch) return dateMatch[1];
  return null;
}

function extractBulletLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => cleanLine(line.replace(/^[-*]\s+/, "")));
}

function estimateDurationMs(segments: TranscriptSegment[]): number {
  if (segments.length >= 2) {
    const start = segments[0]?.timestamp ?? 0;
    const end = segments[segments.length - 1]?.timestamp ?? start;
    if (end > start) return end - start + 60_000;
  }
  return 60 * 60 * 1000;
}

function formatDuration(durationMs: number): string {
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function normalizeDate(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return new Date();
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim() || "imported-meeting";
}

function denormalizeKey(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Imported Meeting";
}

function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitNames(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((part) => cleanLine(part))
    .filter(Boolean);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseTimestampMs(value: string): number {
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
  if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  return 0;
}

function cleanSpeaker(value: string): string {
  return cleanLine(value.replace(/^<v\s+|>$/g, ""));
}

function isHeadingSpeaker(value: string): boolean {
  const lower = value.toLowerCase();
  return ["summary", "overview", "action items", "attendees", "participants"].includes(lower);
}

function mapSpeaker(value: string): string {
  const lower = value.toLowerCase();
  if (["me", "speaker 1", "user", "self"].includes(lower)) return "user";
  if (["assistant", "copilot", "ai"].includes(lower)) return "assistant";
  return "external";
}
