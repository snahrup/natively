import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { app } from "electron";
import { promisify } from "util";

import type {
  AdapterActionDefinition,
  AdapterActionResult,
  AdapterActionSet,
  ArtifactRef,
  AppAdapter,
  DesktopContext,
  EvidenceBundle,
  WorkflowDescriptor,
  WorkflowEvaluation,
  WorkflowMonitorRequest,
} from "../../autonomy";

const execFileAsync = promisify(execFile);

const FMD_WORKFLOW_ID = "fmd.clean_load_run";
const RUNNING_STATUSES = new Set(["running", "inprogress", "queued", "notstarted"]);
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "aborted", "interrupted"]);
const SUCCESS_STATUSES = new Set(["success", "succeeded", "complete", "completed"]);

type FmdStatusSource = "api" | "watchdog-artifact" | "api+watchdog-artifact" | "unavailable";

export interface FmdStructuredState extends Record<string, unknown> {
  detected: boolean;
  repoPath: string;
  apiBase: string;
  statusSource: FmdStatusSource;
  stale: boolean;
  observedAt: string;
  runId: string | null;
  currentRunId: string | null;
  engineStatus: string | null;
  lastRun: Record<string, unknown>;
  run: Record<string, unknown>;
  integritySummary: Record<string, unknown>;
  integrityLastRun: Record<string, unknown>;
  recentFailures: Array<Record<string, unknown>>;
  recentTaskLogs: Array<Record<string, unknown>>;
  recentFailedTaskLogs: Array<Record<string, unknown>>;
  workerLogPath: string | null;
  workerLogExists: boolean;
  workerLogTail: string[];
  watchState: Record<string, unknown> | null;
  statusArtifactPath?: string;
  statusMarkdownPath?: string;
  workerTailPath?: string;
  error?: string;
}

export class FmdAdapter implements AppAdapter<FmdStructuredState> {
  public readonly id = "fmd";
  public readonly label = "FMD Framework";

  private readonly repoPath: string;
  private readonly apiBase: string;
  private readonly watchdogScriptPath: string;
  private readonly artifactDir: string;

  public constructor(repoPath?: string, apiBase?: string) {
    this.repoPath = path.resolve(
      repoPath
      || process.env.NATIVELY_FMD_REPO_PATH
      || path.join(app.getPath("home"), "CascadeProjects", "FMD_FRAMEWORK")
    );
    this.apiBase = (apiBase || process.env.NATIVELY_FMD_API_BASE || process.env.FMD_API_BASE || "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.watchdogScriptPath = path.join(this.repoPath, "scripts", "load_watchdog.py");
    this.artifactDir = path.join(this.repoPath, "artifacts", "load-watchdog");
  }

  public async matchesContext(ctx: DesktopContext): Promise<boolean> {
    return ctx.knownRepoPaths.includes(this.repoPath) || fs.existsSync(this.repoPath);
  }

  public async listWorkflows(): Promise<WorkflowDescriptor[]> {
    if (!fs.existsSync(this.repoPath)) return [];

    return [
      {
        workflowId: FMD_WORKFLOW_ID,
        label: "FMD Clean Load Run",
        adapterId: this.id,
        goalId: "achieve_clean_pipeline_run",
        triggerSignals: [
          "active repo path matches FMD_FRAMEWORK",
          "watchdog artifacts exist",
          "engine status reports an active run",
        ],
        successCriteria: [
          "terminal run status is not failed/interrupted/aborted",
          "integrity latestFullChain equals inScope",
          "integrity historicalOnly equals 0",
        ],
        blockingConditions: [
          "API unavailable and watchdog artifacts stale",
          "run failed or interrupted",
          "integrity report is not clean",
        ],
        allowedToolClasses: ["read", "verify", "control", "code-edit"],
        requiredEvidenceSources: [
          "FMD watchdog snapshot",
          "pipeline-integrity summary",
          "worker log tail",
        ],
        defaultAutonomyLevel: "observe",
      },
    ];
  }

  public async canAutostartWorkflow(_: string, state: FmdStructuredState): Promise<boolean> {
    const status = normalizeStatus(state.engineStatus || stringValue(state.run.status) || stringValue(state.lastRun.status));
    if (RUNNING_STATUSES.has(status)) return true;

    const observedAtMs = Date.parse(state.observedAt || "");
    if (!Number.isNaN(observedAtMs) && Date.now() - observedAtMs <= 10 * 60 * 1000) {
      return !!(state.currentRunId || state.runId || state.watchState?.runId);
    }

    return false;
  }

  public async getStructuredState(): Promise<FmdStructuredState> {
    const artifactSnapshot = this.readArtifactSnapshot();
    const apiSnapshot = await this.fetchApiSnapshot();
    const snapshot = apiSnapshot || artifactSnapshot;

    if (!snapshot) {
      return {
        detected: fs.existsSync(this.repoPath),
        repoPath: this.repoPath,
        apiBase: this.apiBase,
        statusSource: "unavailable",
        stale: true,
        observedAt: new Date(0).toISOString(),
        runId: null,
        currentRunId: null,
        engineStatus: null,
        lastRun: {},
        run: {},
        integritySummary: {},
        integrityLastRun: {},
        recentFailures: [],
        recentTaskLogs: [],
        recentFailedTaskLogs: [],
        workerLogPath: null,
        workerLogExists: false,
        workerLogTail: [],
        watchState: this.readJson(path.join(this.artifactDir, "watch-state.json")),
        statusArtifactPath: path.join(this.artifactDir, "status.json"),
        statusMarkdownPath: path.join(this.artifactDir, "status.md"),
        workerTailPath: path.join(this.artifactDir, "worker-tail.log"),
        error: "No live API response or watchdog snapshot is currently available.",
      };
    }

    const source: FmdStatusSource = apiSnapshot && artifactSnapshot
      ? "api+watchdog-artifact"
      : apiSnapshot
        ? "api"
        : "watchdog-artifact";

    const observedAt = stringValue(snapshot.generatedAt) || new Date().toISOString();
    const workerLogPath = stringValue(snapshot.workerLogPath) || null;
    const workerLogTail = arrayOfStrings(snapshot.workerLogTail);
    const workerLogExists = typeof snapshot.workerLogExists === "boolean"
      ? snapshot.workerLogExists
      : !!(workerLogPath && fs.existsSync(workerLogPath));

    return {
      detected: fs.existsSync(this.repoPath),
      repoPath: this.repoPath,
      apiBase: stringValue(snapshot.apiBase) || this.apiBase,
      statusSource: source,
      stale: isStale(observedAt),
      observedAt,
      runId: stringValue(snapshot.runId) || null,
      currentRunId: stringValue(snapshot.currentRunId) || null,
      engineStatus: stringValue(snapshot.engineStatus) || null,
      lastRun: recordValue(snapshot.lastRun),
      run: recordValue(snapshot.run),
      integritySummary: recordValue(snapshot.integritySummary),
      integrityLastRun: recordValue(snapshot.integrityLastRun),
      recentFailures: arrayOfRecords(snapshot.recentFailures),
      recentTaskLogs: arrayOfRecords(snapshot.recentTaskLogs),
      recentFailedTaskLogs: arrayOfRecords(snapshot.recentFailedTaskLogs),
      workerLogPath,
      workerLogExists,
      workerLogTail,
      watchState: recordValueOrNull(this.readJson(path.join(this.artifactDir, "watch-state.json"))),
      statusArtifactPath: path.join(this.artifactDir, "status.json"),
      statusMarkdownPath: path.join(this.artifactDir, "status.md"),
      workerTailPath: path.join(this.artifactDir, "worker-tail.log"),
      error: apiSnapshot ? undefined : "Using the last watchdog artifact snapshot because the FMD API is unavailable.",
    };
  }

  public async buildWorkflowContext(_: string, state: FmdStructuredState): Promise<Record<string, unknown>> {
    return {
      repoPath: state.repoPath,
      apiBase: state.apiBase,
      statusSource: state.statusSource,
      engineStatus: state.engineStatus,
      currentRunId: state.currentRunId,
      integritySummary: state.integritySummary,
    };
  }

  public async getEvidence(_: string, state: FmdStructuredState): Promise<EvidenceBundle> {
    const artifacts: ArtifactRef[] = [
      { kind: "directory" as const, label: "FMD watchdog artifact directory", path: this.artifactDir, external: true },
      { kind: "json" as const, label: "Watchdog status JSON", path: path.join(this.artifactDir, "status.json"), external: true },
      { kind: "markdown" as const, label: "Watchdog status markdown", path: path.join(this.artifactDir, "status.md"), external: true },
      { kind: "json" as const, label: "Watch state", path: path.join(this.artifactDir, "watch-state.json"), external: true },
    ];

    if (state.workerLogPath) {
      artifacts.push({
        kind: "log" as const,
        label: "Worker log",
        path: state.workerLogPath,
        external: true,
      });
    }

    return {
      capturedAt: state.observedAt,
      sources: [
        state.statusSource,
        "fmd.pipeline-integrity",
        "fmd.worker-log",
      ],
      structuredState: state,
      artifacts,
      logs: [
        {
          label: "Worker log tail",
          lines: state.workerLogTail,
        },
      ],
      validation: [
        {
          label: "Pipeline integrity",
          summary: renderIntegritySummary(state),
          passed: isIntegrityClean(state),
        },
      ],
    };
  }

  public async getActions(_: string, state: FmdStructuredState): Promise<AdapterActionSet> {
    const actions: AdapterActionDefinition[] = [
      {
        id: "refresh_status",
        label: "Refresh status",
        description: "Refresh the FMD watchdog snapshot and integrity summary.",
        policyClass: "read",
        safeForBoundedAuto: true,
      },
      {
        id: "cleanup_stale_runs",
        label: "Cleanup stale runs",
        description: "Invoke the repo-local watchdog cleanup flow for stale runs.",
        policyClass: "control",
        confirmationRequired: true,
        safeForBoundedAuto: true,
      },
      {
        id: "start_run",
        label: "Start run",
        description: "Start a new clean FMD load run and detach the repo watchdog.",
        policyClass: "control",
        confirmationRequired: true,
      },
      {
        id: "resume_run",
        label: "Resume run",
        description: "Resume the last known or explicitly requested interrupted run.",
        policyClass: "control",
        confirmationRequired: true,
      },
      {
        id: "retry_failed_entities",
        label: "Retry failed entities",
        description: "Retry the failed entities for the current or requested run.",
        policyClass: "control",
        confirmationRequired: true,
      },
    ];

    return {
      actions,
      invoke: async (actionId: string, payload?: Record<string, unknown>) => {
        switch (actionId) {
          case "refresh_status":
            return this.runWatchdog(["status"]);
          case "cleanup_stale_runs":
            return this.runWatchdog(["cleanup"]);
          case "start_run":
            return this.runStart(payload);
          case "resume_run":
            return this.runResumeOrRetry("resume", state, payload);
          case "retry_failed_entities":
            return this.runResumeOrRetry("retry-failed", state, payload);
          default:
            return {
              success: false,
              summary: `Unknown FMD action: ${actionId}`,
            };
        }
      },
    };
  }

  public async evaluateWorkflow(
    _: string,
    state: FmdStructuredState,
    request: WorkflowMonitorRequest | null
  ): Promise<WorkflowEvaluation> {
    if (!state.detected) {
      return {
        state: "blocked",
        summary: "FMD_FRAMEWORK was not detected on disk.",
        nextActionIds: [],
        success: false,
        blocked: true,
        requiresApproval: false,
      };
    }

    const status = normalizeStatus(state.engineStatus || stringValue(state.run.status) || stringValue(state.lastRun.status));
    const runId = state.currentRunId || state.runId || stringValue(state.watchState?.runId);
    const completedUnits = numberValue(state.lastRun.completed_units);
    const totalUnits = numberValue(state.lastRun.total) || numberValue(state.run.totalEntities);

    if (state.stale && !status && !runId) {
      return {
        state: "watching",
        summary: "FMD is detected, but the last watchdog snapshot is stale. Refresh status to reconcile the live state.",
        nextActionIds: ["refresh_status"],
        success: false,
        blocked: false,
        requiresApproval: false,
      };
    }

    if (RUNNING_STATUSES.has(status)) {
      const progress = totalUnits > 0 ? ` (${completedUnits}/${totalUnits} units)` : "";
      return {
        state: "working-in-background",
        summary: `FMD run ${runId || "unknown"} is ${status}${progress}. Natively is keeping the artifact bundle current.`,
        nextActionIds: ["refresh_status", "cleanup_stale_runs"],
        success: false,
        blocked: false,
        requiresApproval: false,
      };
    }

    if (TERMINAL_FAILURE_STATUSES.has(status)) {
      const topFailure = state.recentFailures[0];
      const failureMessage = topFailure
        ? `${stringValue(topFailure.ErrorType || topFailure.errorType) || "Failure"}: ${stringValue(topFailure.ErrorMessage || topFailure.errorMessage) || "no details"}`
        : "The latest run ended in a failure state.";
      return {
        state: "blocked",
        summary: `FMD run ${runId || "unknown"} is ${status}. ${failureMessage}`,
        nextActionIds: ["refresh_status", "resume_run", "retry_failed_entities"],
        success: false,
        blocked: true,
        requiresApproval: false,
      };
    }

    if ((SUCCESS_STATUSES.has(status) || !!runId) && isIntegrityClean(state)) {
      return {
        state: "completed",
        summary: `FMD clean-load loop is clean. Run ${runId || "latest"} passed integrity with ${numberValue(state.integritySummary.latestFullChain)}/${numberValue(state.integritySummary.inScope)} entities in the latest full chain.`,
        nextActionIds: ["refresh_status"],
        success: true,
        blocked: false,
        requiresApproval: false,
      };
    }

    if (SUCCESS_STATUSES.has(status) || !!runId) {
      return {
        state: "blocked",
        summary: `FMD run ${runId || "latest"} is not clean yet. ${renderIntegritySummary(state)}`,
        nextActionIds: ["refresh_status", "retry_failed_entities"],
        success: false,
        blocked: true,
        requiresApproval: false,
      };
    }

    if (request) {
      return {
        state: "ready-to-take-over",
        summary: "FMD is detected, but there is no active run yet. Start a run when you want Natively to own the monitoring loop.",
        nextActionIds: ["start_run", "refresh_status"],
        success: false,
        blocked: false,
        requiresApproval: true,
      };
    }

    return {
      state: "watching",
      summary: "FMD is available for passive monitoring. Waiting for an active run or an explicit start request.",
      nextActionIds: ["refresh_status", "start_run"],
      success: false,
      blocked: false,
      requiresApproval: false,
    };
  }

  private async fetchApiSnapshot(): Promise<Record<string, unknown> | null> {
    try {
      const engineStatus = await this.fetchJson("/api/engine/status");
      const integrity = await this.fetchJson("/api/pipeline-integrity");
      const runId = stringValue(engineStatus.current_run_id) || stringValue(recordValue(engineStatus.last_run).run_id);

      let runDetail: Record<string, unknown> = {};
      let recentLogs: Record<string, unknown> = {};
      let failedLogs: Record<string, unknown> = {};
      let workerLogPath: string | null = null;
      let workerLogTail: string[] = [];

      if (runId) {
        runDetail = await this.fetchJson(`/api/lmc/run/${encodeURIComponent(runId)}`).catch(() => ({}));
        recentLogs = await this.fetchJson(`/api/engine/logs?run_id=${encodeURIComponent(runId)}&limit=30`).catch(() => ({}));
        failedLogs = await this.fetchJson(`/api/engine/logs?run_id=${encodeURIComponent(runId)}&status=failed&limit=20`).catch(() => ({}));
        workerLogPath = path.join(this.repoPath, "logs", `engine-worker-${runId.slice(0, 12)}.log`);
        workerLogTail = tailFileLines(workerLogPath, 80);
      }

      return {
        generatedAt: new Date().toISOString(),
        apiBase: this.apiBase,
        runId,
        engineStatus: stringValue(engineStatus.status) || null,
        currentRunId: stringValue(engineStatus.current_run_id) || null,
        lastRun: recordValue(engineStatus.last_run),
        run: recordValue(runDetail.run),
        integritySummary: recordValue(integrity.summary),
        integrityLastRun: recordValue(integrity.lastRun),
        recentFailures: arrayOfRecords(runDetail.failures),
        recentTaskLogs: arrayOfRecords(recentLogs.logs).slice(0, 20),
        recentFailedTaskLogs: arrayOfRecords(failedLogs.logs).slice(0, 20),
        workerLogPath,
        workerLogExists: !!(workerLogPath && fs.existsSync(workerLogPath)),
        workerLogTail,
      };
    } catch {
      return null;
    }
  }

  private readArtifactSnapshot(): Record<string, unknown> | null {
    return this.readJson(path.join(this.artifactDir, "status.json"));
  }

  private readJson(filePath: string): Record<string, unknown> | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private async fetchJson(routePath: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 4_000);

    const response = await fetch(`${this.apiBase}${routePath.startsWith("/") ? routePath : `/${routePath}`}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeout);
    });

    if (!response.ok) {
      throw new Error(`GET ${routePath} failed with ${response.status}`);
    }

    const parsed = await response.json();
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  }

  private async runStart(payload?: Record<string, unknown>): Promise<AdapterActionResult> {
    const args = ["start", "--detach-watch", "--triggered-by", "natively-autonomous-ops"];
    const layers = csvString(payload?.layers);
    const sources = csvString(payload?.sources);
    if (layers) args.push("--layers", layers);
    if (sources) args.push("--sources", sources);
    return this.runWatchdog(args);
  }

  private async runResumeOrRetry(
    command: "resume" | "retry-failed",
    state: FmdStructuredState,
    payload?: Record<string, unknown>
  ): Promise<AdapterActionResult> {
    const args = [command, "--detach-watch"];
    const runId = stringValue(payload?.runId) || state.currentRunId || state.runId;
    if (runId) {
      args.push("--run-id", runId);
    }

    const layers = csvString(payload?.layers);
    if (command === "retry-failed" && layers) {
      args.push("--layers", layers);
    }

    return this.runWatchdog(args);
  }

  private async runWatchdog(args: string[]): Promise<AdapterActionResult> {
    if (!fs.existsSync(this.watchdogScriptPath)) {
      return {
        success: false,
        summary: `FMD watchdog script was not found at ${this.watchdogScriptPath}.`,
      };
    }

    const candidates = process.platform === "win32"
      ? [
          { command: "py", args: ["-3", this.watchdogScriptPath, ...args] },
          { command: "python", args: [this.watchdogScriptPath, ...args] },
        ]
      : [
          { command: "python3", args: [this.watchdogScriptPath, ...args] },
          { command: "python", args: [this.watchdogScriptPath, ...args] },
        ];

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        const result = await execFileAsync(candidate.command, candidate.args, {
          cwd: this.repoPath,
          timeout: 10 * 60 * 1000,
          windowsHide: true,
        });
        const output = extractJsonObject(result.stdout || "");
        return {
          success: true,
          summary: summarizeWatchdogAction(args[0] || "watchdog"),
          output: output || undefined,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
        };
      } catch (error) {
        if (isMissingInterpreter(error)) {
          lastError = error as Error;
          continue;
        }

        return {
          success: false,
          summary: extractStderr(error) || extractStdout(error) || `FMD watchdog ${args[0]} failed.`,
          stdout: extractStdout(error),
          stderr: extractStderr(error),
        };
      }
    }

    return {
      success: false,
      summary: lastError?.message || "No Python interpreter is available to run the FMD watchdog.",
    };
  }
}

function renderIntegritySummary(state: FmdStructuredState): string {
  const inScope = numberValue(state.integritySummary.inScope);
  const latest = numberValue(state.integritySummary.latestFullChain);
  const historicalOnly = numberValue(state.integritySummary.historicalOnly);
  return `Integrity latestFullChain=${latest}/${inScope}, historicalOnly=${historicalOnly}.`;
}

function isIntegrityClean(state: FmdStructuredState): boolean {
  const inScope = numberValue(state.integritySummary.inScope);
  const latest = numberValue(state.integritySummary.latestFullChain);
  const historicalOnly = numberValue(state.integritySummary.historicalOnly);
  return inScope > 0 && latest === inScope && historicalOnly === 0;
}

function isStale(observedAt: string): boolean {
  const parsed = Date.parse(observedAt);
  if (Number.isNaN(parsed)) return true;
  return Date.now() - parsed > 5 * 60 * 1000;
}

function normalizeStatus(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function csvString(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean).join(",");
  }
  return typeof value === "string" ? value.trim() : "";
}

function summarizeWatchdogAction(command: string): string {
  switch (command) {
    case "status":
      return "FMD watchdog snapshot refreshed.";
    case "cleanup":
      return "FMD stale-run cleanup invoked.";
    case "start":
      return "FMD clean run started with a detached watchdog.";
    case "resume":
      return "FMD run resume invoked with a detached watchdog.";
    case "retry-failed":
      return "FMD failed-entity retry invoked with a detached watchdog.";
    default:
      return "FMD watchdog action completed.";
  }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function tailFileLines(filePath: string, maxLines: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordValueOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function isMissingInterpreter(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybe = error as NodeJS.ErrnoException;
  return maybe.code === "ENOENT";
}

function extractStdout(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const maybe = error as { stdout?: string };
  return typeof maybe.stdout === "string" ? maybe.stdout : "";
}

function extractStderr(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const maybe = error as { stderr?: string };
  return typeof maybe.stderr === "string" ? maybe.stderr : "";
}
