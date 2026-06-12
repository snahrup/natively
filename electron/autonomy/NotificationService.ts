import { BrowserWindow, Notification } from "electron";

import type { AutonomousOpsStatus, WorkflowRuntimeState, WorkflowSnapshot } from "./types";

const NOTIFIABLE_STATES = new Set<WorkflowRuntimeState>([
  "working-in-background",
  "needs-approval",
  "blocked",
  "completed",
]);
const LEGACY_APP_MONITORS_ENABLED = process.env.NATIVELY_ENABLE_LEGACY_APP_MONITORS === "1";

export class NotificationService {
  private static instance: NotificationService;
  private readonly signatures = new Map<string, string>();

  public static getInstance(): NotificationService {
    if (!NotificationService.instance) {
      NotificationService.instance = new NotificationService();
    }
    return NotificationService.instance;
  }

  public publishStatus(status: AutonomousOpsStatus): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("autonomous-ops:updated", status);
      }
    }
  }

  public maybeNotify(previous: WorkflowSnapshot | undefined, next: WorkflowSnapshot): void {
    if (!NOTIFIABLE_STATES.has(next.state)) return;
    if (isLegacyWorkflow(next) && !LEGACY_APP_MONITORS_ENABLED) return;
    if (previous?.state === next.state && previous.summary === next.summary) return;

    const runId = stringifyStateValue(next.structuredState, "currentRunId")
      || stringifyStateValue(next.structuredState, "runId");
    const signature = `${next.state}::${runId}::${next.summary}`;
    if (this.signatures.get(next.workflowId) === signature) return;
    this.signatures.set(next.workflowId, signature);

    try {
      const notification = new Notification({
        title: next.label,
        body: next.summary,
        silent: false,
      });
      notification.show();
    } catch (error) {
      console.warn("[AutonomousOps] Failed to show notification:", error);
    }
  }
}

function isLegacyWorkflow(snapshot: WorkflowSnapshot): boolean {
  return snapshot.adapterId === "fmd" || snapshot.workflowId.startsWith("fmd.");
}

function stringifyStateValue(state: Record<string, unknown> | undefined, key: string): string {
  const value = state?.[key];
  return typeof value === "string" ? value : "";
}
