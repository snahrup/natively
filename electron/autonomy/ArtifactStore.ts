import fs from "fs";
import path from "path";
import { app } from "electron";

import type { ArtifactRef, WorkflowSnapshot } from "./types";

export class ArtifactStore {
  private static instance: ArtifactStore;

  public static getInstance(): ArtifactStore {
    if (!ArtifactStore.instance) {
      ArtifactStore.instance = new ArtifactStore();
    }
    return ArtifactStore.instance;
  }

  public getRootDirectory(): string {
    const root = path.join(app.getPath("userData"), "autonomous-ops");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  public getWorkflowDirectory(workflowId: string): string {
    const workflowDir = path.join(this.getRootDirectory(), sanitizeSegment(workflowId));
    fs.mkdirSync(workflowDir, { recursive: true });
    return workflowDir;
  }

  public getInternalArtifacts(workflowId: string): ArtifactRef[] {
    const workflowDir = this.getWorkflowDirectory(workflowId);
    return [
      { kind: "directory", label: "Workflow artifact directory", path: workflowDir },
      { kind: "json", label: "Workflow status", path: path.join(workflowDir, "status.json") },
      { kind: "markdown", label: "Workflow summary", path: path.join(workflowDir, "status.md") },
      { kind: "json", label: "Evidence index", path: path.join(workflowDir, "evidence-index.json") },
      { kind: "log", label: "Event log", path: path.join(workflowDir, "events.jsonl") },
    ];
  }

  public persistSnapshot(snapshot: WorkflowSnapshot): void {
    const workflowDir = this.getWorkflowDirectory(snapshot.workflowId);
    const statusPath = path.join(workflowDir, "status.json");
    const summaryPath = path.join(workflowDir, "status.md");
    const evidencePath = path.join(workflowDir, "evidence-index.json");

    writeJson(statusPath, snapshot);
    writeJson(evidencePath, snapshot.evidence);
    fs.writeFileSync(summaryPath, renderSummary(snapshot), "utf8");
  }

  public appendEvent(workflowId: string, eventType: string, payload: Record<string, unknown>): void {
    const workflowDir = this.getWorkflowDirectory(workflowId);
    const eventPath = path.join(workflowDir, "events.jsonl");
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      workflowId,
      eventType,
      payload,
    });
    fs.appendFileSync(eventPath, `${record}\n`, "utf8");
  }
}

function writeJson(filePath: string, value: unknown): void {
  const next = JSON.stringify(value, null, 2);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, next, "utf8");
  fs.renameSync(tmp, filePath);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function renderSummary(snapshot: WorkflowSnapshot): string {
  const actions = snapshot.nextActionIds.length > 0
    ? snapshot.availableActions.filter((action) => snapshot.nextActionIds.includes(action.id))
    : [];
  const stateJson = JSON.stringify(snapshot.structuredState || {}, null, 2);
  const artifactLines = [
    ...snapshot.evidence.artifacts,
    ...ArtifactStore.getInstance().getInternalArtifacts(snapshot.workflowId),
  ].map((artifact) => `- ${artifact.label}: \`${artifact.path}\``);

  return [
    `# ${snapshot.label}`,
    "",
    `- Updated: \`${snapshot.updatedAt}\``,
    `- State: \`${snapshot.state}\``,
    `- Goal: \`${snapshot.goalId}\``,
    `- Autonomy: \`${snapshot.autonomyLevel}\``,
    `- Adapter: \`${snapshot.adapterId}\``,
    `- Summary: ${snapshot.summary}`,
    snapshot.policySummary ? `- Policy: ${snapshot.policySummary}` : "",
    "",
    "## Suggested Actions",
    "",
    ...(actions.length > 0
      ? actions.map((action) => `- \`${action.id}\` — ${action.label}`)
      : ["- None"]),
    "",
    "## Artifacts",
    "",
    ...(artifactLines.length > 0 ? artifactLines : ["- None"]),
    "",
    "## Structured State",
    "",
    "```json",
    stateJson,
    "```",
    "",
  ].filter(Boolean).join("\n");
}
