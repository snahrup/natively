export type AutonomyLevel = "observe" | "assist" | "bounded-auto" | "approval-required";

export type WorkflowRuntimeState =
  | "idle"
  | "watching"
  | "ready-to-take-over"
  | "taking-over"
  | "working-in-background"
  | "needs-approval"
  | "blocked"
  | "completed";

export type PolicyActionClass = "read" | "verify" | "control" | "code-edit" | "destructive";
export type PolicyDecision = "allow" | "allow-with-confirmation" | "deny" | "escalate";

export interface DesktopContext {
  capturedAt: string;
  knownRepoPaths: string[];
  activeWindowTitle: string | null;
}

export interface WorkflowDescriptor {
  workflowId: string;
  label: string;
  adapterId: string;
  goalId: string;
  triggerSignals: string[];
  successCriteria: string[];
  blockingConditions: string[];
  allowedToolClasses: PolicyActionClass[];
  requiredEvidenceSources: string[];
  defaultAutonomyLevel: AutonomyLevel;
}

export interface ArtifactRef {
  kind: "json" | "markdown" | "log" | "directory" | "file";
  label: string;
  path: string;
  external?: boolean;
}

export interface LogSlice {
  label: string;
  lines: string[];
}

export interface ValidationRef {
  label: string;
  summary: string;
  passed: boolean;
}

export interface EvidenceBundle {
  capturedAt: string;
  sources: string[];
  structuredState?: Record<string, unknown>;
  artifacts: ArtifactRef[];
  logs?: LogSlice[];
  validation?: ValidationRef[];
}

export interface AdapterActionDefinition {
  id: string;
  label: string;
  description: string;
  policyClass: PolicyActionClass;
  confirmationRequired?: boolean;
  safeForBoundedAuto?: boolean;
}

export interface AdapterActionResult {
  success: boolean;
  summary: string;
  output?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
}

export interface AdapterActionSet {
  actions: AdapterActionDefinition[];
  invoke(actionId: string, payload?: Record<string, unknown>): Promise<AdapterActionResult>;
}

export interface WorkflowMonitorRequest {
  workflowId: string;
  goalId: string;
  autonomyLevel: AutonomyLevel;
  manual: boolean;
}

export interface WorkflowEvaluation {
  state: WorkflowRuntimeState;
  summary: string;
  nextActionIds: string[];
  policySummary?: string;
  success: boolean;
  blocked: boolean;
  requiresApproval: boolean;
}

export interface WorkflowSnapshot {
  workflowId: string;
  label: string;
  adapterId: string;
  goalId: string;
  autonomyLevel: AutonomyLevel;
  manual: boolean;
  autoDetected: boolean;
  active: boolean;
  state: WorkflowRuntimeState;
  updatedAt: string;
  summary: string;
  structuredState?: Record<string, unknown>;
  evidence: EvidenceBundle;
  availableActions: AdapterActionDefinition[];
  nextActionIds: string[];
  lastActionResult?: AdapterActionResult;
  policySummary?: string;
  artifactDirectory: string;
}

export interface AutonomousOpsStatusSummary {
  active: number;
  blocked: number;
  completed: number;
  approvalRequired: number;
}

export interface AutonomousOpsStatus {
  resident: boolean;
  updatedAt: string;
  workflows: WorkflowSnapshot[];
  summary: AutonomousOpsStatusSummary;
}

export interface PolicyEvaluationInput {
  workflowId: string;
  adapterId: string;
  action: AdapterActionDefinition;
  autonomyLevel: AutonomyLevel;
  initiatedBy: "user" | "system";
  userPresent: boolean;
  targetFiles?: string[];
  environment?: string;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  reason: string;
}

export interface AppAdapter<TStructuredState extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  label: string;
  matchesContext(ctx: DesktopContext): Promise<boolean>;
  listWorkflows(ctx: DesktopContext): Promise<WorkflowDescriptor[]>;
  canAutostartWorkflow(workflowId: string, state: TStructuredState): Promise<boolean>;
  getStructuredState(ctx: DesktopContext): Promise<TStructuredState>;
  buildWorkflowContext(workflowId: string, state: TStructuredState): Promise<Record<string, unknown>>;
  getEvidence(workflowId: string, state: TStructuredState): Promise<EvidenceBundle>;
  getActions(workflowId: string, state: TStructuredState): Promise<AdapterActionSet>;
  evaluateWorkflow(
    workflowId: string,
    state: TStructuredState,
    request: WorkflowMonitorRequest | null,
    actions: AdapterActionDefinition[]
  ): Promise<WorkflowEvaluation>;
}
