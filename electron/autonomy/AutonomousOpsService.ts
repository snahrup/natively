import { BrowserWindow } from "electron";

import { DatabaseManager } from "../db/DatabaseManager";
import { CommitmentAdapter } from "../adapters/commitments/adapter";
import { FmdAdapter } from "../adapters/fmd/adapter";
import { ArtifactStore } from "./ArtifactStore";
import { DesktopContextService } from "./DesktopContextService";
import { NotificationService } from "./NotificationService";
import { PolicyEngine } from "./PolicyEngine";
import { WorkflowRegistry } from "./WorkflowRegistry";
import type {
  AdapterActionResult,
  AutonomousOpsStatus,
  AutonomousOpsStatusSummary,
  WorkflowDescriptor,
  WorkflowMonitorRequest,
  WorkflowSnapshot,
} from "./types";

const STATE_KEY = "autonomous-ops:workflow-monitors";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const LEGACY_APP_MONITORS_ENABLED = process.env.NATIVELY_ENABLE_LEGACY_APP_MONITORS === "1";

export class AutonomousOpsService {
  private static instance: AutonomousOpsService;

  private readonly registry = new WorkflowRegistry();
  private readonly artifactStore = ArtifactStore.getInstance();
  private readonly desktopContextService = DesktopContextService.getInstance();
  private readonly policyEngine = PolicyEngine.getInstance();
  private readonly notificationService = NotificationService.getInstance();
  private readonly monitors = new Map<string, WorkflowMonitorRequest>();
  private readonly snapshots = new Map<string, WorkflowSnapshot>();
  private readonly lastActionResults = new Map<string, AdapterActionResult>();

  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;

  public static getInstance(): AutonomousOpsService {
    if (!AutonomousOpsService.instance) {
      AutonomousOpsService.instance = new AutonomousOpsService();
    }
    return AutonomousOpsService.instance;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;

    // The resident adapter watches the user's actual goal: meeting
    // commitments from the durable observation lane. Read-only, no LLM calls.
    this.registry.registerAdapter(new CommitmentAdapter());

    if (LEGACY_APP_MONITORS_ENABLED) {
      this.registry.registerAdapter(new FmdAdapter());
    } else {
      console.log(
        "[AutonomousOps] Legacy app monitors disabled by default. Set NATIVELY_ENABLE_LEGACY_APP_MONITORS=1 to enable FMD/repo workflow adapters."
      );
    }

    this.loadPersistedMonitors();
    void this.refreshNow();

    this.timer = setInterval(() => {
      void this.refreshNow();
    }, DEFAULT_POLL_INTERVAL_MS);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public getStatus(): AutonomousOpsStatus {
    const workflows = [...this.snapshots.values()].sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.label.localeCompare(right.label);
    });

    const summary: AutonomousOpsStatusSummary = {
      active: workflows.filter((workflow) => workflow.active).length,
      blocked: workflows.filter((workflow) => workflow.state === "blocked").length,
      completed: workflows.filter((workflow) => workflow.state === "completed").length,
      approvalRequired: workflows.filter((workflow) => workflow.state === "needs-approval").length,
    };

    return {
      resident: this.started,
      updatedAt: new Date().toISOString(),
      workflows,
      summary,
    };
  }

  public async startWorkflow(
    workflowId: string,
    options?: Partial<Pick<WorkflowMonitorRequest, "goalId" | "autonomyLevel">>
  ): Promise<WorkflowSnapshot | null> {
    const descriptor = await this.ensureDescriptor(workflowId);
    if (!descriptor) return null;

    this.monitors.set(workflowId, {
      workflowId,
      goalId: options?.goalId || descriptor.goalId,
      autonomyLevel: options?.autonomyLevel || descriptor.defaultAutonomyLevel,
      manual: true,
    });
    this.persistMonitors();

    await this.refreshNow();
    return this.snapshots.get(workflowId) || null;
  }

  public stopWorkflow(workflowId: string): void {
    this.monitors.delete(workflowId);
    this.persistMonitors();

    const existing = this.snapshots.get(workflowId);
    if (existing) {
      const next: WorkflowSnapshot = {
        ...existing,
        active: false,
        autoDetected: false,
        manual: false,
        state: "idle",
        summary: "Monitoring paused.",
        updatedAt: new Date().toISOString(),
      };
      this.snapshots.set(workflowId, next);
      this.artifactStore.persistSnapshot(next);
      this.artifactStore.appendEvent(workflowId, "workflow.stopped", {
        reason: "user-requested",
      });
      this.publishStatus();
    }
  }

  public async invokeAction(
    workflowId: string,
    actionId: string,
    payload?: Record<string, unknown>
  ): Promise<AdapterActionResult> {
    const descriptor = await this.ensureDescriptor(workflowId);
    if (!descriptor) {
      return {
        success: false,
        summary: `Workflow ${workflowId} is not registered.`,
      };
    }

    const adapter = this.registry.getAdapter(descriptor.adapterId);
    if (!adapter) {
      return {
        success: false,
        summary: `Adapter ${descriptor.adapterId} is not available.`,
      };
    }

    const context = this.desktopContextService.getContext();
    const structuredState = this.snapshots.get(workflowId)?.structuredState || await adapter.getStructuredState(context);
    const actionSet = await adapter.getActions(workflowId, structuredState);
    const action = actionSet.actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      return {
        success: false,
        summary: `Action ${actionId} is not available for ${workflowId}.`,
      };
    }

    const monitor = this.monitors.get(workflowId);
    const policy = this.policyEngine.evaluate({
      workflowId,
      adapterId: descriptor.adapterId,
      action,
      autonomyLevel: monitor?.autonomyLevel || descriptor.defaultAutonomyLevel,
      initiatedBy: "user",
      userPresent: true,
    });

    if (policy.decision === "deny") {
      return {
        success: false,
        summary: policy.reason,
      };
    }

    const result = await actionSet.invoke(actionId, payload);
    this.lastActionResults.set(workflowId, result);

    if (["start_run", "resume_run", "retry_failed_entities"].includes(actionId) && !monitor) {
      this.monitors.set(workflowId, {
        workflowId,
        goalId: descriptor.goalId,
        autonomyLevel: descriptor.defaultAutonomyLevel,
        manual: true,
      });
      this.persistMonitors();
    }

    this.artifactStore.appendEvent(workflowId, "action.executed", {
      actionId,
      policyDecision: policy.decision,
      policyReason: policy.reason,
      success: result.success,
      summary: result.summary,
    });

    await this.refreshNow();
    return result;
  }

  public async refreshNow(): Promise<AutonomousOpsStatus> {
    await this.tick();
    return this.getStatus();
  }

  private async tick(): Promise<void> {
    if (!this.tickPromise) {
      this.tickPromise = this.tickInternal().finally(() => {
        this.tickPromise = null;
      });
    }
    return this.tickPromise;
  }

  private async tickInternal(): Promise<void> {
    const context = this.desktopContextService.getContext();
    const descriptors = await this.registry.refresh(context);
    const nextSnapshots = new Map<string, WorkflowSnapshot>();

    for (const descriptor of descriptors) {
      const adapter = this.registry.getAdapter(descriptor.adapterId);
      if (!adapter) continue;
      const request = this.monitors.get(descriptor.workflowId) || null;

      try {
        const structuredState = await adapter.getStructuredState(context);
        const autoDetected = await adapter.canAutostartWorkflow(descriptor.workflowId, structuredState);
        const shouldMonitor = !!request || autoDetected;

        const actionSet = await adapter.getActions(descriptor.workflowId, structuredState);
        const evidence = await adapter.getEvidence(descriptor.workflowId, structuredState);
        const evaluation = await adapter.evaluateWorkflow(
          descriptor.workflowId,
          structuredState,
          request,
          actionSet.actions
        );

        const nextActionId = evaluation.nextActionIds[0];
        const nextAction = actionSet.actions.find((action) => action.id === nextActionId);
        const policySummary = nextAction
          ? this.policyEngine.evaluate({
              workflowId: descriptor.workflowId,
              adapterId: descriptor.adapterId,
              action: nextAction,
              autonomyLevel: request?.autonomyLevel || descriptor.defaultAutonomyLevel,
              initiatedBy: "system",
              userPresent: BrowserWindow.getFocusedWindow() !== null,
            }).reason
          : evaluation.policySummary;

        const snapshot: WorkflowSnapshot = {
          workflowId: descriptor.workflowId,
          label: descriptor.label,
          adapterId: descriptor.adapterId,
          goalId: request?.goalId || descriptor.goalId,
          autonomyLevel: request?.autonomyLevel || descriptor.defaultAutonomyLevel,
          manual: !!request?.manual,
          autoDetected,
          active: shouldMonitor,
          state: evaluation.state,
          updatedAt: new Date().toISOString(),
          summary: evaluation.summary,
          structuredState,
          evidence: {
            ...evidence,
            artifacts: [
              ...evidence.artifacts,
              ...this.artifactStore.getInternalArtifacts(descriptor.workflowId),
            ],
          },
          availableActions: actionSet.actions,
          nextActionIds: evaluation.nextActionIds,
          lastActionResult: this.lastActionResults.get(descriptor.workflowId),
          policySummary,
          artifactDirectory: this.artifactStore.getWorkflowDirectory(descriptor.workflowId),
        };

        const previous = this.snapshots.get(descriptor.workflowId);
        this.artifactStore.persistSnapshot(snapshot);
        if (snapshot.active || previous?.active) {
          this.recordEvents(previous, snapshot);
          this.notificationService.maybeNotify(previous, snapshot);
        }
        nextSnapshots.set(descriptor.workflowId, snapshot);
      } catch (error) {
        const fallback = this.buildFailureSnapshot(descriptor, error, !!request);
        this.artifactStore.persistSnapshot(fallback);
        const previous = this.snapshots.get(descriptor.workflowId);
        if (fallback.active || previous?.active) {
          this.artifactStore.appendEvent(descriptor.workflowId, "workflow.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          this.notificationService.maybeNotify(previous, fallback);
        }
        nextSnapshots.set(descriptor.workflowId, fallback);
      }
    }

    this.snapshots.clear();
    for (const [workflowId, snapshot] of nextSnapshots.entries()) {
      this.snapshots.set(workflowId, snapshot);
    }

    this.publishStatus();
  }

  private recordEvents(previous: WorkflowSnapshot | undefined, next: WorkflowSnapshot): void {
    this.artifactStore.appendEvent(next.workflowId, "evidence.refreshed", {
      state: next.state,
      summary: next.summary,
    });

    if (!previous) {
      this.artifactStore.appendEvent(next.workflowId, "workflow.started", {
        state: next.state,
        summary: next.summary,
      });
      return;
    }

    if (previous.state !== next.state || previous.summary !== next.summary) {
      this.artifactStore.appendEvent(next.workflowId, "workflow.state_changed", {
        previousState: previous.state,
        nextState: next.state,
        summary: next.summary,
      });
    }

    if (next.state === "completed" && previous.state !== "completed") {
      this.artifactStore.appendEvent(next.workflowId, "workflow.completed", {
        summary: next.summary,
      });
    }
  }

  private buildFailureSnapshot(
    descriptor: WorkflowDescriptor,
    error: unknown,
    active: boolean
  ): WorkflowSnapshot {
    const message = error instanceof Error ? error.message : String(error);
    return {
      workflowId: descriptor.workflowId,
      label: descriptor.label,
      adapterId: descriptor.adapterId,
      goalId: descriptor.goalId,
      autonomyLevel: descriptor.defaultAutonomyLevel,
      manual: !!this.monitors.get(descriptor.workflowId)?.manual,
      autoDetected: false,
      active,
      state: "blocked",
      updatedAt: new Date().toISOString(),
      summary: `Workflow refresh failed: ${message}`,
      structuredState: {
        error: message,
      },
      evidence: {
        capturedAt: new Date().toISOString(),
        sources: ["natively.autonomous-ops"],
        artifacts: this.artifactStore.getInternalArtifacts(descriptor.workflowId),
      },
      availableActions: [],
      nextActionIds: [],
      lastActionResult: this.lastActionResults.get(descriptor.workflowId),
      policySummary: "Refresh failed before policy evaluation completed.",
      artifactDirectory: this.artifactStore.getWorkflowDirectory(descriptor.workflowId),
    };
  }

  private publishStatus(): void {
    this.notificationService.publishStatus(this.getStatus());
  }

  private loadPersistedMonitors(): void {
    const raw = DatabaseManager.getInstance().getAppState(STATE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as WorkflowMonitorRequest[];
      for (const item of parsed) {
        if (!item?.workflowId) continue;
        this.monitors.set(item.workflowId, item);
      }
    } catch (error) {
      console.warn("[AutonomousOps] Failed to parse persisted monitor state:", error);
    }
  }

  private persistMonitors(): void {
    DatabaseManager.getInstance().setAppState(STATE_KEY, JSON.stringify([...this.monitors.values()]));
  }

  private async ensureDescriptor(workflowId: string): Promise<WorkflowDescriptor | undefined> {
    const existing = this.registry.getDescriptor(workflowId);
    if (existing) return existing;

    const context = this.desktopContextService.getContext();
    await this.registry.refresh(context);
    return this.registry.getDescriptor(workflowId);
  }
}
