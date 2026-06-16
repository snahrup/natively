import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Meeting } from "../db/DatabaseManager";

type ArtifactStatus = "skipped" | "queued" | "running" | "completed" | "failed";

interface ArtifactRecord {
  meetingId: string;
  status: ArtifactStatus;
  reason?: string;
  notebookId?: string;
  sourcePath?: string;
  infographicPath?: string;
  reportSuggestionsPath?: string;
  orientation?: "portrait" | "landscape";
  detail?: "concise" | "standard" | "detailed";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const MIN_DURATION_MS = 10 * 60 * 1000;
const MIN_CONTENT_CHARS = 600;
const IP_CORP_BRAIN_ROOT = "C:\\Users\\snahrup\\CascadeProjects\\ipcorp-architecture-brain";
const ARTIFACT_ROOT = path.join(IP_CORP_BRAIN_ROOT, "natively", "meeting-infographics");
const NOTEBOOKLM_TIMEOUT_MS = 20 * 60 * 1000;
const INFOGRAPHIC_ORIENTATION = "portrait" as const;
const INFOGRAPHIC_DETAIL = "detailed" as const;
const IP_LOGO_PATHS = [
  "C:\\Users\\snahrup\\Downloads\\ip-corp-logo-1400x624.png",
  "C:\\Users\\snahrup\\Downloads\\IP Corp Logo _ Official.png",
  "C:\\Users\\snahrup\\Downloads\\IP_Logo_Horizontal_White.png",
];

function safeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "meeting";
}

function compact(value?: string | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function extractNotebookId(stdout: string): string | undefined {
  const text = stdout.trim();
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text);
    const candidates = [
      parsed?.id,
      parsed?.notebook_id,
      parsed?.notebookId,
      parsed?.notebook?.id,
      parsed?.data?.id,
    ];
    return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 8);
  } catch {
    const match = text.match(/[a-f0-9-]{24,}|[A-Za-z0-9_-]{20,}/);
    return match?.[0];
  }
}

function parseJsonLoose(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function pickSuggestionPrompt(value: unknown): string | undefined {
  const candidates: any[] = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.suggestions)
      ? (value as any).suggestions
      : Array.isArray((value as any)?.data)
        ? (value as any).data
        : [];

  const chosen = candidates.find((item) => typeof item?.prompt === "string" && item.prompt.trim().length > 20);
  return chosen?.prompt?.trim();
}

function looksIpCorpRelated(meeting: Meeting): boolean {
  const haystack = [
    meeting.title,
    meeting.summary,
    meeting.detailedSummary?.overview,
    ...(meeting.detailedSummary?.keyPoints || []),
    ...(meeting.detailedSummary?.actionItems || []),
  ].join(" ").toLowerCase();

  return /\b(ip corp|ip corporation|ipcorp|m3|fabric|purview|fmd|demand management|steward|governance|architecture|mike spencer|dominiq|patrick)\b/.test(haystack);
}

function chooseIpLogo(): string | null {
  return IP_LOGO_PATHS.find((candidate) => fs.existsSync(candidate)) || null;
}

function hasEnoughProcessedContent(meeting: Meeting): boolean {
  const summaryChars = [
    meeting.summary,
    meeting.detailedSummary?.overview,
    ...(meeting.detailedSummary?.keyPoints || []),
    ...(meeting.detailedSummary?.actionItems || []),
  ].join(" ").length;
  const transcriptChars = (meeting.transcript || []).reduce((total, segment) => total + String(segment.text || "").length, 0);
  return summaryChars + transcriptChars >= MIN_CONTENT_CHARS;
}

function renderMeetingSource(meeting: Meeting): string {
  const overview = compact(meeting.detailedSummary?.overview) || compact(meeting.summary);
  const keyPoints = (meeting.detailedSummary?.keyPoints || []).map(compact).filter(Boolean);
  const actionItems = (meeting.detailedSummary?.actionItems || []).map(compact).filter(Boolean);
  const assistantMoments = (meeting.usage || []).filter((item) => item.answer || item.items?.length).slice(0, 6);
  const title = compact(meeting.title) || "Calendar Meeting";
  const date = meeting.date ? new Date(meeting.date).toLocaleString("en-US") : "Recently";

  const lines = [
    `# ${title}: Meeting Intelligence Brief`,
    "",
    `${title} created a useful working record for the next phase of decision-making. The session captured what mattered, where alignment improved, what still needs a clear owner, and which follow-up actions should move from discussion into execution.`,
    "",
    "## Executive Takeaway",
    overview || "This meeting produced a working signal that should be preserved for follow-up, continuity, and future preparation.",
    "",
    "## Why This Meeting Matters",
    "The value of the session is not only the immediate discussion. Its real value is the durable context it adds to the operating record: recurring themes, decision paths, unresolved commitments, stakeholder concerns, and the next practical moves that should shape upcoming work.",
    "",
    "## Important Signals",
    ...(keyPoints.length
      ? keyPoints.map((point) => `- ${point}`)
      : ["- The meeting record should be reviewed for decisions, risks, open questions, and follow-up opportunities."]),
    "",
    "## Follow-Up Momentum",
    ...(actionItems.length
      ? actionItems.map((item) => `- ${item}`)
      : ["- No explicit follow-up item was isolated, but the meeting should still contribute to the broader continuity record."]),
    "",
    "## What Natively Should Carry Forward",
    "- Preserve the decisions, unresolved questions, and stakeholder context so the next meeting starts with memory instead of repetition.",
    "- Separate immediate action items from longer-running themes that may need repeated attention over time.",
    "- Use this meeting as one more data point in the evolving picture of where Steve can add leverage, where alignment is thin, and where proactive support will matter most.",
    "",
  ];

  if (assistantMoments.length > 0) {
    lines.push("## Useful Guidance Moments");
    for (const moment of assistantMoments) {
      const text = compact(moment.answer || (moment.items || []).join("; "));
      if (text) lines.push(`- ${text}`);
    }
    lines.push("");
  }

  lines.push("## Meeting Metadata");
  lines.push(`- Meeting date: ${date}`);
  lines.push(`- Duration: ${meeting.duration || "Not recorded"}`);
  lines.push(`- Source: ${meeting.source || "calendar"}`);
  lines.push("");
  lines.push("## Future-State Value");
  lines.push("Over time, this meeting becomes part of a larger intelligence layer: one that helps identify patterns across decisions, prepares better meeting context, highlights follow-through gaps, and turns recurring observations into higher-quality work habits.");
  lines.push("");

  return lines.join("\n");
}

export class NotebookLmMeetingArtifactService {
  private static instance: NotebookLmMeetingArtifactService;
  private inFlight = new Set<string>();
  private queued = new Set<string>();
  private pending: Array<{ meeting: Meeting; durationMs: number }> = [];
  private workerActive = false;

  public static getInstance(): NotebookLmMeetingArtifactService {
    if (!NotebookLmMeetingArtifactService.instance) {
      NotebookLmMeetingArtifactService.instance = new NotebookLmMeetingArtifactService();
    }
    return NotebookLmMeetingArtifactService.instance;
  }

  public queueMeetingInfographic(meeting: Meeting, durationMs: number): void {
    if (process.env.NATIVELY_NOTEBOOKLM_MEETING_ARTIFACTS === "0") {
      this.writeSkip(meeting, "NotebookLM meeting artifacts are disabled.");
      return;
    }

    if (meeting.isProcessed === false) {
      this.writeSkip(meeting, "Meeting is not fully processed yet.");
      return;
    }

    if (durationMs < MIN_DURATION_MS) {
      this.writeSkip(meeting, "Meeting was shorter than 10 minutes.");
      return;
    }

    if (!hasEnoughProcessedContent(meeting)) {
      this.writeSkip(meeting, "Meeting does not have enough processed content for a NotebookLM infographic.");
      return;
    }

    if (this.inFlight.has(meeting.id) || this.queued.has(meeting.id)) return;
    this.queued.add(meeting.id);
    this.pending.push({ meeting, durationMs });
    void this.drainQueue();
  }

  public queueCalendarMeetingInfographic(meeting: Meeting, durationMs: number): void {
    this.queueMeetingInfographic(meeting, durationMs);
  }

  private async drainQueue(): Promise<void> {
    if (this.workerActive) return;
    this.workerActive = true;

    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) continue;
        this.queued.delete(next.meeting.id);
        this.inFlight.add(next.meeting.id);
        try {
          await this.runMeetingInfographic(next.meeting);
        } finally {
          this.inFlight.delete(next.meeting.id);
        }
      }
    } finally {
      this.workerActive = false;
    }
  }

  private async runMeetingInfographic(meeting: Meeting): Promise<void> {
    const dir = this.getArtifactDir(meeting);
    fs.mkdirSync(dir, { recursive: true });

    const sourcePath = path.join(dir, "notebooklm-source.md");
    const suggestionsPath = path.join(dir, "report-suggestions.json");
    const infographicPath = path.join(dir, "meeting-infographic.png");
    fs.writeFileSync(sourcePath, renderMeetingSource(meeting), "utf8");

    this.writeStatus(dir, {
      meetingId: meeting.id,
      status: "running",
      sourcePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      orientation: INFOGRAPHIC_ORIENTATION,
      detail: INFOGRAPHIC_DETAIL,
    });

    try {
      const title = `Natively - ${safeSlug(meeting.title)} - ${new Date().toISOString().slice(0, 10)}`;
      const created = await this.runNotebookLm(["create", "--json", title]);
      const notebookId = extractNotebookId(created.stdout);
      if (!notebookId) {
        throw new Error(`NotebookLM did not return a notebook id. ${created.stderr || created.stdout}`.trim());
      }

      await this.runNotebookLm(["source", "add", "--notebook", notebookId, "--title", "Meeting intelligence brief", "--json", sourcePath]);

      const logoPath = looksIpCorpRelated(meeting) ? chooseIpLogo() : null;
      if (logoPath) {
        await this.runNotebookLm(["source", "add", "--notebook", notebookId, "--type", "file", "--mime-type", "image/png", "--title", "IP Corp visual identity", "--json", logoPath]);
      }

      const suggestions = parseJsonLoose((await this.runNotebookLm(["artifact", "suggestions", "--notebook", notebookId, "--json"])).stdout);
      fs.writeFileSync(suggestionsPath, JSON.stringify(suggestions, null, 2), "utf8");
      const notebookPrompt = pickSuggestionPrompt(suggestions);

      const generateArgs = [
        "generate",
        "infographic",
        "--notebook",
        notebookId,
        "--orientation",
        INFOGRAPHIC_ORIENTATION,
        "--detail",
        INFOGRAPHIC_DETAIL,
        "--wait",
        "--json",
      ];
      if (notebookPrompt) generateArgs.push(notebookPrompt);
      await this.runNotebookLm(generateArgs);

      await this.runNotebookLm(["download", "infographic", "--notebook", notebookId, "--latest", "--force", "--json", infographicPath]);

      this.writeStatus(dir, {
        meetingId: meeting.id,
        status: "completed",
        notebookId,
        sourcePath,
        infographicPath,
        reportSuggestionsPath: suggestionsPath,
        orientation: INFOGRAPHIC_ORIENTATION,
        detail: INFOGRAPHIC_DETAIL,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      this.writeStatus(dir, {
        meetingId: meeting.id,
        status: "failed",
        sourcePath,
        infographicPath,
        reportSuggestionsPath: suggestionsPath,
        orientation: INFOGRAPHIC_ORIENTATION,
        detail: INFOGRAPHIC_DETAIL,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: error?.message || String(error),
      });
      console.error("[NotebookLM] Meeting infographic generation failed:", error);
    }
  }

  private runNotebookLm(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.platform === "win32" ? "notebooklm.exe" : "notebooklm", args, {
        windowsHide: true,
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`NotebookLM command timed out: notebooklm ${args.slice(0, 3).join(" ")}`));
      }, NOTEBOOKLM_TIMEOUT_MS);

      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error((stderr || stdout || `NotebookLM exited with code ${code}`).trim()));
        }
      });
    });
  }

  private writeSkip(meeting: Meeting, reason: string): void {
    const dir = this.getArtifactDir(meeting);
    fs.mkdirSync(dir, { recursive: true });
    this.writeStatus(dir, {
      meetingId: meeting.id,
      status: "skipped",
      reason,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  private writeStatus(dir: string, record: ArtifactRecord): void {
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(record, null, 2), "utf8");
  }

  private getArtifactDir(meeting: Meeting): string {
    const datePart = meeting.date ? new Date(meeting.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return path.join(ARTIFACT_ROOT, `${datePart}-${safeSlug(meeting.title)}-${meeting.id.slice(0, 8)}`);
  }
}
