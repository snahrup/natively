import crypto from "crypto";

import { DatabaseManager } from "../db/DatabaseManager";

export type DurableWorkflowState =
  | "queued"
  | "running"
  | "needs_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableWorkflowType =
  | "meeting_prep_packet"
  | "meeting_digestion"
  | "action_approval"
  | "realtime_reflex"
  | string;

export interface DurableWorkflowEvent {
  timestamp: string;
  type: string;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface DurableWorkflowRun {
  id: string;
  type: DurableWorkflowType;
  title: string;
  state: DurableWorkflowState;
  dedupeKey?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  summary?: string;
  error?: string;
  metadata: Record<string, unknown>;
  approval?: {
    required: boolean;
    reason?: string;
    requestedAt?: string;
    approvedAt?: string;
    rejectedAt?: string;
  };
  events: DurableWorkflowEvent[];
}

export interface DurableWorkflowLedgerStatus {
  updatedAt: string;
  summary: Record<DurableWorkflowState, number>;
  recentRuns: DurableWorkflowRun[];
}

interface DurableWorkflowLedgerState {
  schemaVersion: 1;
  runs: DurableWorkflowRun[];
}

const STATE_KEY = "durable-workflow-ledger:v1";
const MAX_RUNS = 300;
const MAX_EVENTS_PER_RUN = 80;

export class DurableWorkflowLedger {
  private static instance: DurableWorkflowLedger;
  private memoryState: DurableWorkflowLedgerState = { schemaVersion: 1, runs: [] };

  public static getInstance(): DurableWorkflowLedger {
    if (!DurableWorkflowLedger.instance) {
      DurableWorkflowLedger.instance = new DurableWorkflowLedger();
    }
    return DurableWorkflowLedger.instance;
  }

  public startRun(input: {
    type: DurableWorkflowType;
    title: string;
    dedupeKey?: string;
    metadata?: Record<string, unknown>;
    summary?: string;
  }): DurableWorkflowRun {
    const now = new Date().toISOString();
    const run: DurableWorkflowRun = {
      id: buildRunId(input.type, input.dedupeKey || input.title),
      type: input.type,
      title: input.title,
      state: "queued",
      dedupeKey: input.dedupeKey,
      createdAt: now,
      updatedAt: now,
      summary: input.summary,
      metadata: input.metadata || {},
      events: [{
        timestamp: now,
        type: "workflow.queued",
        summary: input.summary || "Workflow run queued.",
      }],
    };

    const state = this.loadState();
    state.runs.unshift(run);
    this.saveState(state);
    return run;
  }

  public transitionRun(
    runId: string,
    state: DurableWorkflowState,
    event?: Omit<DurableWorkflowEvent, "timestamp">
  ): DurableWorkflowRun | null {
    const ledger = this.loadState();
    const index = ledger.runs.findIndex((run) => run.id === runId);
    if (index < 0) return null;

    const now = new Date().toISOString();
    const current = ledger.runs[index];
    const next: DurableWorkflowRun = {
      ...current,
      state,
      updatedAt: now,
      summary: event?.summary || current.summary,
      events: [
        ...(current.events || []),
        {
          timestamp: now,
          type: event?.type || `workflow.${state}`,
          summary: event?.summary,
          payload: event?.payload,
        },
      ].slice(-MAX_EVENTS_PER_RUN),
    };

    if (state === "running" && !next.startedAt) {
      next.startedAt = now;
    } else if (state === "completed") {
      next.completedAt = now;
    } else if (state === "failed") {
      next.failedAt = now;
      next.error = event?.payload?.error ? String(event.payload.error) : next.error;
    }

    ledger.runs[index] = next;
    this.saveState(ledger);
    return next;
  }

  public requestApproval(
    runId: string,
    reason: string,
    payload?: Record<string, unknown>
  ): DurableWorkflowRun | null {
    const ledger = this.loadState();
    const index = ledger.runs.findIndex((run) => run.id === runId);
    if (index < 0) return null;

    const now = new Date().toISOString();
    const current = ledger.runs[index];
    const next: DurableWorkflowRun = {
      ...current,
      state: "needs_approval",
      updatedAt: now,
      approval: {
        ...(current.approval || {}),
        required: true,
        reason,
        requestedAt: now,
      },
      events: [
        ...(current.events || []),
        {
          timestamp: now,
          type: "approval.requested",
          summary: reason,
          payload,
        },
      ].slice(-MAX_EVENTS_PER_RUN),
    };

    ledger.runs[index] = next;
    this.saveState(ledger);
    return next;
  }

  public async runTask<T>(
    input: {
      type: DurableWorkflowType;
      title: string;
      dedupeKey?: string;
      metadata?: Record<string, unknown>;
      queuedSummary?: string;
      runningSummary?: string;
      completedSummary?: string;
    },
    work: (run: DurableWorkflowRun) => Promise<T>
  ): Promise<T> {
    const run = this.startRun({
      type: input.type,
      title: input.title,
      dedupeKey: input.dedupeKey,
      metadata: input.metadata,
      summary: input.queuedSummary,
    });

    const running = this.transitionRun(run.id, "running", {
      type: "workflow.started",
      summary: input.runningSummary || "Workflow run started.",
    }) || run;

    try {
      const result = await work(running);
      this.transitionRun(run.id, "completed", {
        type: "workflow.completed",
        summary: input.completedSummary || "Workflow run completed.",
        payload: summarizeResult(result),
      });
      return result;
    } catch (error: any) {
      this.transitionRun(run.id, "failed", {
        type: "workflow.failed",
        summary: error?.message || "Workflow run failed.",
        payload: { error: error?.message || String(error) },
      });
      throw error;
    }
  }

  public listRuns(limit = 50): DurableWorkflowRun[] {
    return this.loadState().runs
      .slice()
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(250, limit)));
  }

  public getStatus(limit = 25): DurableWorkflowLedgerStatus {
    const runs = this.listRuns(limit);
    const summary = emptySummary();
    for (const run of this.loadState().runs) {
      summary[run.state] += 1;
    }
    return {
      updatedAt: new Date().toISOString(),
      summary,
      recentRuns: runs,
    };
  }

  private loadState(): DurableWorkflowLedgerState {
    try {
      const raw = DatabaseManager.getInstance().getAppState(STATE_KEY);
      if (!raw) return this.memoryState;
      const parsed = JSON.parse(raw) as DurableWorkflowLedgerState;
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.runs)) {
        return this.memoryState;
      }
      this.memoryState = parsed;
      return parsed;
    } catch (error) {
      console.warn("[DurableWorkflowLedger] Failed to load state:", error);
      return this.memoryState;
    }
  }

  private saveState(state: DurableWorkflowLedgerState): void {
    const pruned: DurableWorkflowLedgerState = {
      schemaVersion: 1,
      runs: state.runs
        .slice()
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_RUNS)
        .map((run) => ({
          ...run,
          events: (run.events || []).slice(-MAX_EVENTS_PER_RUN),
        })),
    };

    this.memoryState = pruned;
    try {
      DatabaseManager.getInstance().setAppState(STATE_KEY, JSON.stringify(pruned));
    } catch (error) {
      console.warn("[DurableWorkflowLedger] Failed to persist state:", error);
    }
  }
}

function buildRunId(type: DurableWorkflowType, seed: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const hash = crypto.createHash("sha1").update(`${type}:${seed}:${timestamp}:${crypto.randomUUID()}`).digest("hex").slice(0, 10);
  return `run-${safeSegment(type)}-${timestamp}-${hash}`;
}

function safeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workflow";
}

function emptySummary(): Record<DurableWorkflowState, number> {
  return {
    queued: 0,
    running: 0,
    needs_approval: 0,
    approved: 0,
    executing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return { resultType: typeof result };
  }

  const record = result as Record<string, unknown>;
  return {
    resultType: Array.isArray(result) ? "array" : "object",
    keys: Object.keys(record).slice(0, 12),
  };
}
