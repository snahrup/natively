// CommitmentAdapter
// The autonomy subsystem's first real adapter pointed at the user's actual
// goal: supervising meeting commitments instead of a dev-repo pipeline
// (FmdAdapter, now legacy-gated). Reads the durable commitment lane that
// meeting ingestion + the deadline sweep maintain — pure read-only state,
// zero LLM calls, so it is safe to run resident by default.

import { ContextObservationStore } from "../../context/ContextObservationStore";
import type { ContextDocument } from "../../context/types";
import type {
  AdapterActionDefinition,
  AdapterActionResult,
  AdapterActionSet,
  AppAdapter,
  DesktopContext,
  EvidenceBundle,
  WorkflowDescriptor,
  WorkflowEvaluation,
  WorkflowMonitorRequest,
} from "../../autonomy/types";

const WORKFLOW_ID = "commitments.follow-through";
const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CommitmentSummary extends Record<string, unknown> {
  id: string;
  title: string;
  dueAt: string | null;
  meetingTitle: string | null;
  overdue: boolean;
  dueSoon: boolean;
  notifiedAt: string | null;
}

export interface CommitmentState extends Record<string, unknown> {
  capturedAt: string;
  commitments: CommitmentSummary[];
  openCount: number;
  datedCount: number;
  dueSoonCount: number;
  overdueCount: number;
}

export class CommitmentAdapter implements AppAdapter<CommitmentState> {
  public readonly id = "commitments";
  public readonly label = "Meeting Commitments";

  async matchesContext(_ctx: DesktopContext): Promise<boolean> {
    // Commitments are not tied to a window/repo — always relevant.
    return true;
  }

  async listWorkflows(_ctx: DesktopContext): Promise<WorkflowDescriptor[]> {
    return [
      {
        workflowId: WORKFLOW_ID,
        label: "Commitment follow-through",
        adapterId: this.id,
        goalId: "meeting-follow-through",
        triggerSignals: [
          "commitment extracted from a saved meeting",
          "commitment due date approaching",
        ],
        successCriteria: ["no open commitments remain"],
        blockingConditions: [],
        allowedToolClasses: ["read", "verify"],
        requiredEvidenceSources: ["natively.context.observation_store"],
        defaultAutonomyLevel: "assist",
      },
    ];
  }

  async canAutostartWorkflow(_workflowId: string, state: CommitmentState): Promise<boolean> {
    return state.openCount > 0;
  }

  async getStructuredState(_ctx: DesktopContext): Promise<CommitmentState> {
    const now = Date.now();
    const docs = ContextObservationStore.getInstance().getDocuments({
      sourceTypes: ["task_or_commitment"],
    });

    const commitments: CommitmentSummary[] = docs
      .map((doc: ContextDocument) => {
        const dueMs = doc.dueAt ? Date.parse(doc.dueAt) : NaN;
        return {
          id: doc.id,
          title: doc.title,
          dueAt: doc.dueAt ?? null,
          meetingTitle: typeof doc.metadata?.meetingTitle === "string" ? doc.metadata.meetingTitle : null,
          overdue: Number.isFinite(dueMs) && dueMs < now,
          dueSoon: Number.isFinite(dueMs) && dueMs >= now && dueMs - now <= DUE_SOON_WINDOW_MS,
          notifiedAt: typeof doc.metadata?.deadlineNotifiedAt === "string" ? doc.metadata.deadlineNotifiedAt : null,
        };
      })
      // Dated commitments first (soonest due leading), undated after
      .sort((left, right) => {
        const leftMs = left.dueAt ? Date.parse(left.dueAt) : Number.POSITIVE_INFINITY;
        const rightMs = right.dueAt ? Date.parse(right.dueAt) : Number.POSITIVE_INFINITY;
        return leftMs - rightMs;
      });

    return {
      capturedAt: new Date(now).toISOString(),
      commitments,
      openCount: commitments.length,
      datedCount: commitments.filter((item) => item.dueAt).length,
      dueSoonCount: commitments.filter((item) => item.dueSoon).length,
      overdueCount: commitments.filter((item) => item.overdue).length,
    };
  }

  async buildWorkflowContext(_workflowId: string, state: CommitmentState): Promise<Record<string, unknown>> {
    return {
      openCount: state.openCount,
      dueSoonCount: state.dueSoonCount,
      overdueCount: state.overdueCount,
      commitments: state.commitments.slice(0, 20),
    };
  }

  async getEvidence(_workflowId: string, state: CommitmentState): Promise<EvidenceBundle> {
    return {
      capturedAt: state.capturedAt,
      sources: ["natively.context.observation_store"],
      structuredState: {
        openCount: state.openCount,
        datedCount: state.datedCount,
        dueSoonCount: state.dueSoonCount,
        overdueCount: state.overdueCount,
      },
      artifacts: [],
    };
  }

  async getActions(_workflowId: string, state: CommitmentState): Promise<AdapterActionSet> {
    const actions: AdapterActionDefinition[] = [
      {
        id: "list_open_commitments",
        label: "List open commitments",
        description: "Return the open commitments with due dates and source meetings.",
        policyClass: "read",
        safeForBoundedAuto: true,
      },
    ];

    const invoke = async (actionId: string): Promise<AdapterActionResult> => {
      if (actionId !== "list_open_commitments") {
        return { success: false, summary: `Unknown action: ${actionId}` };
      }
      return {
        success: true,
        summary: `${state.openCount} open commitment(s); ${state.dueSoonCount} due within 24h, ${state.overdueCount} overdue.`,
        output: { commitments: state.commitments },
      };
    };

    return { actions, invoke };
  }

  async evaluateWorkflow(
    _workflowId: string,
    state: CommitmentState,
    _request: WorkflowMonitorRequest | null,
    _actions: AdapterActionDefinition[]
  ): Promise<WorkflowEvaluation> {
    if (state.openCount === 0) {
      return {
        state: "completed",
        summary: "No open commitments.",
        nextActionIds: [],
        success: true,
        blocked: false,
        requiresApproval: false,
      };
    }

    // Desktop notifications for individual deadlines are DeadlineSweepService's
    // job — these states stay out of NotificationService's notifiable set so
    // the same deadline never notifies twice. This surface is for the
    // Context Hub / Autonomous Ops status panel.
    if (state.overdueCount > 0) {
      return {
        state: "ready-to-take-over",
        summary: `${state.overdueCount} overdue commitment(s) need attention; ${state.openCount} open in total.`,
        nextActionIds: ["list_open_commitments"],
        success: false,
        blocked: false,
        requiresApproval: false,
      };
    }

    return {
      state: "watching",
      summary: state.dueSoonCount > 0
        ? `${state.dueSoonCount} commitment(s) due within 24h; ${state.openCount} open in total.`
        : `Tracking ${state.openCount} open commitment(s) (${state.datedCount} dated).`,
      nextActionIds: ["list_open_commitments"],
      success: false,
      blocked: false,
      requiresApproval: false,
    };
  }
}
