import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { ContextDocument } from "../context/types";

export type BrainMeetingSource = "manual" | "calendar" | "teams" | "cluely" | "imported";

export interface BrainMeetingRecord {
  id: string;
  title: string;
  date: string;
  duration: string;
  summary: string;
  source?: BrainMeetingSource;
  importMetadata?: {
    sourceFormat?: "cluely" | "teams" | "generic";
    importedAt?: string;
    fidelity?: string;
    brainSource?: string;
  };
  detailedSummary?: Record<string, unknown>;
  transcript: [];
  usage: [];
}

export interface BrainReadModelStatus {
  available: boolean;
  rootPath: string;
  nativelyPath: string;
  meetingIndexPath: string;
  statusPath: string;
  prepPacketsPath: string;
  cortexLatestRunPath: string;
  workflowRunsPath: string;
  statusUpdatedAt?: string;
  meetingIndexUpdatedAt?: string;
  latestRunUpdatedAt?: string;
  status?: Record<string, unknown>;
  warning?: string;
}

export interface BrainPrepPacket {
  id: string;
  title: string;
  startsAt: string | null;
  attendees: string[];
  summary: string;
  whyItMatters?: string;
  currentState: string[];
  relatedWork: string[];
  openQuestions: string[];
  openCommitments: string[];
  talkingPoints: string[];
  risks: string[];
  suggestedPosture?: string;
  evidenceRefs: string[];
  liveContextMarkdown?: string;
  sourcePath: string;
  updatedAt?: string;
}

export interface BrainCortexInsight {
  id: string;
  type: string;
  title: string;
  summary: string;
  createdAt: string;
  updatedAt?: string;
  confidence?: number | string;
  reasoning?: unknown;
  action?: string;
  actionProposalRefs: string[];
  tags: string[];
  sourcePath: string;
}

export interface BrainActionProposal {
  id: string;
  type: string;
  title: string;
  summary: string;
  status: "proposed" | "approved" | "rejected" | "snoozed" | "executed" | "failed" | string;
  createdAt: string;
  updatedAt?: string;
  relatedInsightIds: string[];
  payload?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  evidenceRefs: string[];
  sourcePath: string;
  workflowRun?: BrainWorkflowRun;
}

export type BrainWorkflowState =
  | "waiting_for_approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "rejected"
  | "snoozed"
  | "blocked";

export interface BrainWorkflowEvent {
  timestamp: string;
  type: string;
  actor: "steve" | "natively" | "brain" | "system";
  summary?: string;
  payload?: unknown;
}

export interface BrainWorkflowRun {
  id: string;
  proposalId: string;
  proposalType: string;
  title: string;
  state: BrainWorkflowState;
  createdAt: string;
  updatedAt: string;
  payload?: Record<string, unknown>;
  relatedInsightIds: string[];
  evidenceRefs: string[];
  approval: {
    required: boolean;
    reason?: string;
    approvedAt?: string;
    rejectedAt?: string;
    snoozedAt?: string;
    actor?: string;
  };
  autonomy: {
    level: number;
    policy: string;
    promotionBlockedUntil?: string;
  };
  execution?: {
    adapter?: string;
    startedAt?: string;
    completedAt?: string;
    failedAt?: string;
    summary?: string;
    receipt?: unknown;
    error?: string;
  };
  outcomeLedgerRefs: string[];
  events: BrainWorkflowEvent[];
  sourcePath: string;
}

const BRAIN_ROOT = path.join(os.homedir(), "CascadeProjects", "ipcorp-architecture-brain");
const NATIVELY_ROOT = path.join(BRAIN_ROOT, "natively");
const MEETING_INDEX_PATH = path.join(NATIVELY_ROOT, "meeting-index.json");
const STATUS_PATH = path.join(NATIVELY_ROOT, "status.json");
const PREP_PACKETS_DIR = path.join(NATIVELY_ROOT, "prep-packets");
const CORTEX_LATEST_RUN_PATH = path.join(NATIVELY_ROOT, "cortex", "latest-run.json");
const CORTEX_INSIGHTS_DIR = path.join(NATIVELY_ROOT, "cortex", "insights");
const ACTION_PROPOSALS_DIR = path.join(NATIVELY_ROOT, "action-proposals");
const WORKFLOW_RUNS_DIR = path.join(NATIVELY_ROOT, "workflow-runs");
const OUTCOMES_DIR = path.join(NATIVELY_ROOT, "outcomes");
const TASKS_DIR = path.join(NATIVELY_ROOT, "tasks");
const NOTES_DIR = path.join(NATIVELY_ROOT, "notes");

export class BrainReadModelService {
  private static instance: BrainReadModelService;

  public static getInstance(): BrainReadModelService {
    if (!BrainReadModelService.instance) {
      BrainReadModelService.instance = new BrainReadModelService();
    }
    return BrainReadModelService.instance;
  }

  public getStatus(): BrainReadModelStatus {
    const status = readJsonRecord(STATUS_PATH);
    const statusUpdatedAt = getMtimeIso(STATUS_PATH);
    const meetingIndexUpdatedAt = getMtimeIso(MEETING_INDEX_PATH);
    const latestRunUpdatedAt = getMtimeIso(CORTEX_LATEST_RUN_PATH);
    const available = fs.existsSync(BRAIN_ROOT);

    return {
      available,
      rootPath: BRAIN_ROOT,
      nativelyPath: NATIVELY_ROOT,
      meetingIndexPath: MEETING_INDEX_PATH,
      statusPath: STATUS_PATH,
      prepPacketsPath: PREP_PACKETS_DIR,
      cortexLatestRunPath: CORTEX_LATEST_RUN_PATH,
      workflowRunsPath: WORKFLOW_RUNS_DIR,
      statusUpdatedAt,
      meetingIndexUpdatedAt,
      latestRunUpdatedAt,
      status: status || undefined,
      warning: available
        ? undefined
        : `IP Corp architecture brain was not found at ${BRAIN_ROOT}.`,
    };
  }

  public getRecentMeetings(limit = 50): BrainMeetingRecord[] {
    const raw = readJson(MEETING_INDEX_PATH);
    const records = extractArray(raw, ["meetings", "items", "records", "index"]);
    if (!records.length) return [];

    return records
      .map((record, index) => normalizeMeetingRecord(record, index))
      .filter((record): record is BrainMeetingRecord => !!record)
      .sort((left, right) => Date.parse(right.date || "") - Date.parse(left.date || ""))
      .slice(0, limit);
  }

  public getMeetingCounts(meetings: BrainMeetingRecord[]): {
    total: number;
    natively: number;
    calendar: number;
    teamsImports: number;
    cluelyImports: number;
    genericImports: number;
    lastMeetingAt?: string;
  } {
    const statusCounts = readStatusMeetingCounts();
    if (statusCounts) {
      return {
        ...statusCounts,
        lastMeetingAt: statusCounts.lastMeetingAt || meetings[0]?.date,
      };
    }

    return {
      total: meetings.length,
      natively: meetings.filter((meeting) => !meeting.source || meeting.source === "manual").length,
      calendar: meetings.filter((meeting) => meeting.source === "calendar").length,
      teamsImports: meetings.filter((meeting) => meeting.source === "teams").length,
      cluelyImports: meetings.filter((meeting) => meeting.source === "cluely").length,
      genericImports: meetings.filter((meeting) => meeting.source === "imported").length,
      lastMeetingAt: meetings[0]?.date,
    };
  }

  public getLocalSourceCounts(): {
    upcomingEvents: number;
    recentEmails: number;
    teamsChats: number;
    outlookConnected: boolean;
    teamsConnected: boolean;
  } {
    const status = readJsonRecord(STATUS_PATH);
    const localSources = recordValue(status?.localSources) || recordValue(status?.sources);
    const calendar = recordValue(status?.calendar);
    const microsoft = recordValue(status?.microsoft);

    return {
      upcomingEvents: numberValue(
        localSources?.upcomingEvents,
        calendar?.upcomingEvents,
        status?.upcomingEvents
      ),
      recentEmails: numberValue(localSources?.recentEmails, microsoft?.recentEmails, status?.recentEmails),
      teamsChats: numberValue(localSources?.teamsChats, microsoft?.teamsChats, status?.teamsChats),
      outlookConnected: booleanValue(localSources?.outlookConnected, microsoft?.outlookConnected),
      teamsConnected: booleanValue(localSources?.teamsConnected, microsoft?.teamsConnected),
    };
  }

  public getPrepPackets(limit = 50): BrainPrepPacket[] {
    return readJsonFiles(PREP_PACKETS_DIR, normalizePrepPacket)
      .sort(sortByNewest)
      .slice(0, limit);
  }

  public getPrepPacketForEvent(event: {
    id?: string;
    title?: string;
    startTime?: string;
    attendees?: Array<{ email?: string; displayName?: string }>;
  }): BrainPrepPacket | null {
    const packets = this.getPrepPackets(100);
    if (!packets.length) return null;

    const eventId = slugify(stringValue(event.id));
    const eventTitle = stringValue(event.title);
    const eventSlug = slugify(eventTitle);
    const eventTerms = tokenize(eventTitle);
    const attendeeTerms = tokenize((event.attendees || [])
      .map((attendee) => attendee.displayName || attendee.email || "")
      .join(" "));
    const eventStartMs = Date.parse(stringValue(event.startTime));

    let best: { packet: BrainPrepPacket; score: number } | null = null;

    for (const packet of packets) {
      const packetSlug = slugify(packet.id || packet.title);
      const packetTerms = tokenize(`${packet.title} ${packet.summary} ${packet.relatedWork.join(" ")}`);
      let score = 0;

      if (eventId && packetSlug === eventId) score += 1;
      if (eventSlug && packetSlug === eventSlug) score += 0.95;
      if (eventSlug && (packetSlug.includes(eventSlug) || eventSlug.includes(packetSlug))) score += 0.5;
      score += overlapRatio(eventTerms, packetTerms) * 0.7;
      score += overlapRatio(attendeeTerms, tokenize(packet.attendees.join(" "))) * 0.25;

      const packetStartMs = Date.parse(packet.startsAt || "");
      if (Number.isFinite(eventStartMs) && Number.isFinite(packetStartMs)) {
        const diffMs = Math.abs(eventStartMs - packetStartMs);
        if (diffMs <= 2 * 60 * 60 * 1000) score += 0.35;
        else if (diffMs <= 24 * 60 * 60 * 1000) score += 0.15;
      }

      if (!best || score > best.score) {
        best = { packet, score };
      }
    }

    return best && best.score >= 0.35 ? best.packet : null;
  }

  public getCortexInsights(limit = 25): BrainCortexInsight[] {
    const latestRun = readJson(CORTEX_LATEST_RUN_PATH);
    const fromLatestRun = extractArray(latestRun, ["insights", "cortexInsights", "items"])
      .map((record, index) => normalizeCortexInsight(record, CORTEX_LATEST_RUN_PATH, index))
      .filter((record): record is BrainCortexInsight => !!record);
    const fromFiles = readJsonFiles(CORTEX_INSIGHTS_DIR, normalizeCortexInsight);

    return dedupeById([...fromLatestRun, ...fromFiles])
      .sort(sortByNewest)
      .slice(0, limit);
  }

  public getActionProposals(limit = 25): BrainActionProposal[] {
    const latestRun = readJson(CORTEX_LATEST_RUN_PATH);
    const fromLatestRun = extractArray(latestRun, ["actionProposals", "proposals", "actions"])
      .map((record, index) => normalizeActionProposal(record, CORTEX_LATEST_RUN_PATH, index))
      .filter((record): record is BrainActionProposal => !!record);
    const fromFiles = readJsonFiles(ACTION_PROPOSALS_DIR, normalizeActionProposal);
    const latestWorkflowRunByProposal = new Map<string, BrainWorkflowRun>();
    for (const run of this.getWorkflowRuns(500)) {
      if (!latestWorkflowRunByProposal.has(run.proposalId)) {
        latestWorkflowRunByProposal.set(run.proposalId, run);
      }
    }

    return dedupeById([...fromLatestRun, ...fromFiles])
      .map((proposal) => {
        const workflowRun = latestWorkflowRunByProposal.get(proposal.id);
        if (!workflowRun) return proposal;
        return {
          ...proposal,
          status: workflowStateToProposalStatus(workflowRun.state),
          workflowRun,
        };
      })
      .sort(sortByNewest)
      .slice(0, limit);
  }

  public getActionProposalById(proposalId: string): BrainActionProposal | null {
    const normalized = proposalId.trim();
    if (!normalized) return null;
    return this.getActionProposals(250).find((proposal) => proposal.id === normalized) || null;
  }

  public getWorkflowRuns(limit = 100): BrainWorkflowRun[] {
    return readJsonFiles(WORKFLOW_RUNS_DIR, normalizeWorkflowRun)
      .sort(sortByNewest)
      .slice(0, limit);
  }

  public getWorkflowRunById(runId: string): BrainWorkflowRun | null {
    const normalized = runId.trim();
    if (!normalized) return null;
    const filePath = path.join(WORKFLOW_RUNS_DIR, `${safePathSegment(normalized)}.json`);
    return normalizeWorkflowRun(readJson(filePath), filePath);
  }

  public getLatestWorkflowRunForProposal(proposalId: string): BrainWorkflowRun | null {
    const normalized = proposalId.trim();
    if (!normalized) return null;
    return this.getWorkflowRuns(500).find((run) => run.proposalId === normalized) || null;
  }

  public getOrCreateWorkflowRunForProposal(
    proposal: BrainActionProposal,
    options: {
      state?: BrainWorkflowState;
      actor?: BrainWorkflowEvent["actor"];
      eventType?: string;
      eventSummary?: string;
      payload?: Record<string, unknown>;
    } = {}
  ): BrainWorkflowRun {
    const existing = this.getLatestWorkflowRunForProposal(proposal.id);
    const payload = options.payload || proposal.payload;
    if (existing) {
      if (options.state && existing.state !== options.state) {
        return this.transitionWorkflowRun(existing.id, options.state, {
          type: options.eventType || "workflow.state_changed",
          actor: options.actor || "system",
          summary: options.eventSummary,
          payload,
        }) || existing;
      }
      if (options.eventType) {
        return this.transitionWorkflowRun(existing.id, existing.state, {
          type: options.eventType,
          actor: options.actor || "system",
          summary: options.eventSummary,
          payload,
        }) || existing;
      }
      return existing;
    }

    const timestamp = new Date().toISOString();
    const run: BrainWorkflowRun = {
      id: `run-${safePathSegment(proposal.id)}-${timestamp.replace(/[^0-9]/g, "").slice(0, 14)}`,
      proposalId: proposal.id,
      proposalType: proposal.type,
      title: proposal.title,
      state: options.state || "waiting_for_approval",
      createdAt: timestamp,
      updatedAt: timestamp,
      payload,
      relatedInsightIds: proposal.relatedInsightIds || [],
      evidenceRefs: proposal.evidenceRefs || [],
      approval: {
        required: proposal.approval?.required !== false,
        reason: stringValue(proposal.approval?.reason),
      },
      autonomy: {
        level: 1,
        policy: "explicit-human-approval-required",
      },
      outcomeLedgerRefs: [],
      events: [{
        timestamp,
        type: options.eventType || "workflow.created",
        actor: options.actor || "system",
        summary: options.eventSummary || "Brain action proposal workflow run created.",
        payload,
      }],
      sourcePath: path.relative(BRAIN_ROOT, workflowRunPath(`run-${safePathSegment(proposal.id)}-${timestamp.replace(/[^0-9]/g, "").slice(0, 14)}`)),
    };

    return writeWorkflowRun(run);
  }

  public transitionWorkflowRun(
    runId: string,
    state: BrainWorkflowState,
    event: {
      type: string;
      actor: BrainWorkflowEvent["actor"];
      summary?: string;
      payload?: unknown;
      receipt?: unknown;
      error?: string;
      adapter?: string;
    }
  ): BrainWorkflowRun | null {
    const run = this.getWorkflowRunById(runId);
    if (!run) return null;

    const timestamp = new Date().toISOString();
    const next: BrainWorkflowRun = {
      ...run,
      state,
      updatedAt: timestamp,
      events: [
        ...(run.events || []),
        {
          timestamp,
          type: event.type,
          actor: event.actor,
          summary: event.summary,
          payload: event.payload,
        },
      ],
    };

    if (state === "approved") {
      next.approval = {
        ...next.approval,
        approvedAt: timestamp,
        actor: "steve",
      };
    } else if (state === "rejected") {
      next.approval = {
        ...next.approval,
        rejectedAt: timestamp,
        actor: "steve",
      };
    } else if (state === "snoozed") {
      next.approval = {
        ...next.approval,
        snoozedAt: timestamp,
        actor: "steve",
      };
    }

    if (state === "executing") {
      next.execution = {
        ...(next.execution || {}),
        adapter: event.adapter,
        startedAt: timestamp,
        summary: event.summary,
      };
    } else if (state === "completed") {
      next.execution = {
        ...(next.execution || {}),
        adapter: event.adapter || next.execution?.adapter,
        completedAt: timestamp,
        summary: event.summary,
        receipt: event.receipt,
      };
    } else if (state === "failed") {
      next.execution = {
        ...(next.execution || {}),
        adapter: event.adapter || next.execution?.adapter,
        failedAt: timestamp,
        summary: event.summary,
        error: event.error,
      };
    }

    return writeWorkflowRun(next);
  }

  public writeTaskFromProposal(
    proposal: BrainActionProposal,
    payload: Record<string, unknown>,
    workflowRunId?: string
  ): { success: boolean; filePath: string; task: Record<string, unknown> } {
    const timestamp = new Date().toISOString();
    const task = {
      id: stringValue(payload.id, payload.taskId) || `task-${safePathSegment(proposal.id)}`,
      title: stringValue(payload.title, payload.subject, proposal.title),
      summary: stringValue(payload.summary, payload.body, payload.description, proposal.summary),
      status: stringValue(payload.status) || "open",
      priority: stringValue(payload.priority) || "normal",
      dueAt: stringValue(payload.dueAt, payload.dueDate) || undefined,
      owner: stringValue(payload.owner, payload.assignee) || "Steve Nahrup",
      sourceProposalId: proposal.id,
      workflowRunId,
      relatedInsightIds: proposal.relatedInsightIds || [],
      evidenceRefs: proposal.evidenceRefs || [],
      createdAt: timestamp,
      updatedAt: timestamp,
      payload,
    };
    const filePath = path.join(TASKS_DIR, `${safePathSegment(String(task.id))}.json`);
    writeJsonFile(filePath, task);
    return {
      success: true,
      filePath: path.relative(BRAIN_ROOT, filePath),
      task,
    };
  }

  public writeNoteFromProposal(
    proposal: BrainActionProposal,
    payload: Record<string, unknown>,
    workflowRunId?: string
  ): { success: boolean; filePath: string; note: string } {
    const timestamp = new Date().toISOString();
    const title = stringValue(payload.title, payload.subject, proposal.title) || "Brain note";
    const body = stringValue(payload.body, payload.note, payload.text, payload.content, proposal.summary);
    const tags = arrayOfStrings(payload.tags, proposal.relatedInsightIds);
    const note = [
      `# ${title}`,
      "",
      `Created: ${timestamp}`,
      `Source proposal: ${proposal.id}`,
      workflowRunId ? `Workflow run: ${workflowRunId}` : "",
      tags.length ? `Tags: ${tags.join(", ")}` : "",
      proposal.evidenceRefs.length ? `Evidence: ${proposal.evidenceRefs.join(", ")}` : "",
      "",
      body,
      "",
    ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
    const filePath = path.join(NOTES_DIR, `${safePathSegment(stringValue(payload.id, payload.noteId, proposal.id))}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, note, "utf8");
    return {
      success: true,
      filePath: path.relative(BRAIN_ROOT, filePath),
      note,
    };
  }

  public recordActionOutcome(input: {
    proposalId: string;
    decision: "approved" | "rejected" | "snoozed" | "edited_then_approved" | "executed" | "failed" | string;
    editSummary?: string;
    finalPayload?: unknown;
    error?: string;
    learningSignals?: string[];
  }): { success: boolean; filePath: string; workflowRunId?: string } {
    const timestamp = new Date().toISOString();
    const filePath = path.join(OUTCOMES_DIR, `${timestamp.slice(0, 10)}-natively-outcomes.jsonl`);
    fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
    const proposal = this.getActionProposalById(input.proposalId);
    const workflowRun = proposal
      ? this.getOrCreateWorkflowRunForProposal(proposal, {
        state: outcomeDecisionToWorkflowState(input.decision),
        actor: "steve",
        eventType: `outcome.${input.decision}`,
        eventSummary: input.editSummary || `Outcome recorded: ${input.decision}`,
        payload: recordValue(input.finalPayload) || proposal.payload,
      })
      : null;
    const record = {
      timestamp,
      proposalId: input.proposalId,
      workflowRunId: workflowRun?.id,
      decision: input.decision,
      editSummary: input.editSummary,
      originalPayloadHash: proposal?.payload ? stableHash(proposal.payload) : undefined,
      finalPayloadHash: input.finalPayload ? stableHash(input.finalPayload) : undefined,
      finalPayload: input.finalPayload,
      error: input.error,
      learningSignals: input.learningSignals || [],
    };
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    if (workflowRun) {
      const latest = this.getWorkflowRunById(workflowRun.id) || workflowRun;
      writeWorkflowRun({
        ...latest,
        outcomeLedgerRefs: [...new Set([...(latest.outcomeLedgerRefs || []), path.relative(BRAIN_ROOT, filePath)])],
      });
    }
    return {
      success: true,
      filePath: path.relative(BRAIN_ROOT, filePath),
      workflowRunId: workflowRun?.id,
    };
  }

  public getCortexSummary(): {
    prepPacketsReady: number;
    cortexInsights: number;
    openActionProposals: number;
    latestRunAt?: string;
    runtimeBoundary?: Record<string, unknown>;
  } {
    const status = readJsonRecord(STATUS_PATH);
    const counts = recordValue(status?.counts);
    const runtimeBoundary = recordValue(status?.runtimeBoundary) || undefined;
    const proposals = this.getActionProposals(100);

    return {
      prepPacketsReady: numberValue(counts?.prepPacketsReady) || this.getPrepPackets(100).length,
      cortexInsights: this.getCortexInsights(100).length,
      openActionProposals: proposals.filter((proposal) => proposal.status === "proposed" || proposal.status === "snoozed").length,
      latestRunAt: stringValue(status?.updatedAt) || getMtimeIso(CORTEX_LATEST_RUN_PATH) || getMtimeIso(STATUS_PATH),
      runtimeBoundary,
    };
  }

  public getContextDocuments(query = "", limit = 20): ContextDocument[] {
    const documents = [
      ...this.getPrepPackets(100).map(mapPrepPacketToDocument),
      ...this.getCortexInsights(100).map(mapCortexInsightToDocument),
      ...this.getActionProposals(100).map(mapActionProposalToDocument),
      ...this.getMeetingIndexDocuments(),
    ];

    return dedupeDocuments(documents)
      .sort((left, right) => scoreBrainDocument(right, query) - scoreBrainDocument(left, query))
      .slice(0, limit);
  }

  private getMeetingIndexDocuments(): ContextDocument[] {
    const raw = readJson(MEETING_INDEX_PATH);
    const record = recordValue(raw);
    if (!record) return [];

    const docs: ContextDocument[] = [];
    for (const item of extractArray(record.upcoming, ["items", "records"])) {
      const upcoming = recordValue(item);
      if (!upcoming) continue;
      const id = stringValue(upcoming.id, upcoming.slug, upcoming.title);
      const title = stringValue(upcoming.title) || id || "Upcoming brain meeting";
      const body = [
        stringValue(upcoming.whyNow),
        stringValue(upcoming.readinessStatus) ? `Readiness: ${stringValue(upcoming.readinessStatus)}` : "",
        stringValue(upcoming.packet) ? `Packet: ${stringValue(upcoming.packet)}` : "",
      ].filter(Boolean).join("\n");
      docs.push({
        id: `brain-index-upcoming:${slugify(id || title)}`,
        sourceType: "brain_prep_packet",
        sourceSystem: "ipcorp_architecture_brain",
        title,
        body,
        createdAt: stringValue(record.updatedAt) || new Date().toISOString(),
        updatedAt: stringValue(record.updatedAt) || getMtimeIso(MEETING_INDEX_PATH),
        eventTimeStart: stringValue(upcoming.startsAt) || undefined,
        relatedMeetingIds: id ? [id] : undefined,
        trustTier: "authoritative",
        visibility: "private",
        freshnessClass: classifyFreshness(Date.parse(stringValue(record.updatedAt))),
        lexicalTerms: tokenize(`${title} ${body}`),
        sourceScore: 0.82,
        metadata: {
          brainPath: path.relative(BRAIN_ROOT, MEETING_INDEX_PATH),
          readinessStatus: stringValue(upcoming.readinessStatus) || undefined,
          packet: stringValue(upcoming.packet) || undefined,
        },
      });
    }

    for (const item of extractArray(record.recent, ["items", "records"])) {
      const recent = recordValue(item);
      if (!recent) continue;
      const title = stringValue(recent.title) || "Recent brain meeting";
      const date = stringValue(recent.date, recent.updatedAt) || stringValue(record.updatedAt) || new Date().toISOString();
      const body = [
        stringValue(recent.source) ? `Source: ${stringValue(recent.source)}` : "",
        arrayOfStrings(recent.feedsPackets).length ? `Feeds packets: ${arrayOfStrings(recent.feedsPackets).join(", ")}` : "",
      ].filter(Boolean).join("\n");
      docs.push({
        id: `brain-index-recent:${slugify(`${date}-${title}`)}`,
        sourceType: "meeting_summary",
        sourceSystem: "ipcorp_architecture_brain",
        title,
        body,
        createdAt: date,
        updatedAt: date,
        trustTier: "authoritative",
        visibility: "private",
        freshnessClass: classifyFreshness(Date.parse(date)),
        lexicalTerms: tokenize(`${title} ${body}`),
        sourceScore: 0.76,
        metadata: {
          brainPath: stringValue(recent.source) || path.relative(BRAIN_ROOT, MEETING_INDEX_PATH),
          feedsPackets: arrayOfStrings(recent.feedsPackets),
        },
      });
    }

    return docs;
  }
}

function normalizePrepPacket(record: unknown, filePath: string): BrainPrepPacket | null {
  const item = recordValue(record);
  if (!item) return null;

  const id = stringValue(item.id, item.slug, item.title, path.basename(filePath, ".packet.json"));
  const title = stringValue(item.title, item.meetingTitle, item.name) || "Untitled prep packet";

  return {
    id: id || slugify(title),
    title,
    startsAt: stringValue(item.startsAt, item.startTime, item.date) || null,
    attendees: arrayOfStrings(item.attendees, item.participants),
    summary: stringValue(item.summary, item.overview, item.synopsis) || "",
    whyItMatters: stringValue(item.whyItMatters, item.why) || undefined,
    currentState: arrayOfStrings(item.currentState, item.state),
    relatedWork: arrayOfStrings(item.relatedWork, item.relatedProjects),
    openQuestions: arrayOfStrings(item.openQuestions, item.questions),
    openCommitments: arrayOfStrings(item.openCommitments, item.commitments, item.actionItems),
    talkingPoints: arrayOfStrings(item.talkingPoints, item.talkTrack),
    risks: arrayOfStrings(item.risks),
    suggestedPosture: stringValue(item.suggestedPosture, item.posture) || undefined,
    evidenceRefs: arrayOfStrings(item.evidenceRefs, item.sources, item.references),
    liveContextMarkdown: stringValue(item.liveContextMarkdown, item.contextMarkdown) || undefined,
    sourcePath: path.relative(BRAIN_ROOT, filePath),
    updatedAt: getMtimeIso(filePath),
  };
}

function normalizeCortexInsight(record: unknown, filePath: string, index = 0): BrainCortexInsight | null {
  const item = recordValue(record);
  if (!item) return null;

  const title = stringValue(item.title, item.name) || "Untitled Cortex insight";
  const createdAt = stringValue(item.createdAt, item.timestamp, item.generatedAt, item.updatedAt) || getMtimeIso(filePath) || new Date().toISOString();

  return {
    id: stringValue(item.id, item.insightId) || `cortex-insight-${index + 1}-${slugify(title)}`,
    type: stringValue(item.type, item.kind) || "observation",
    title,
    summary: stringValue(item.summary, item.description, item.body) || "",
    createdAt,
    updatedAt: stringValue(item.updatedAt, item.generatedAt) || getMtimeIso(filePath),
    confidence: typeof item.confidence === "number" || typeof item.confidence === "string" ? item.confidence : undefined,
    reasoning: item.reasoning,
    action: stringValue(item.action, item.recommendedAction) || undefined,
    actionProposalRefs: arrayOfStrings(item.actionProposalRefs, item.actionProposals, item.proposalIds),
    tags: arrayOfStrings(item.tags),
    sourcePath: path.relative(BRAIN_ROOT, filePath),
  };
}

function normalizeActionProposal(record: unknown, filePath: string, index = 0): BrainActionProposal | null {
  const item = recordValue(record);
  if (!item) return null;
  const proposalPayload = recordValue(item.proposal);

  const title = stringValue(item.title, item.label, item.name) || "Untitled action proposal";
  const createdAt = stringValue(item.createdAt, item.timestamp, item.generatedAt, item.updatedAt) || getMtimeIso(filePath) || new Date().toISOString();

  return {
    id: stringValue(item.id, item.proposalId) || `brain-action-${index + 1}-${slugify(title)}`,
    type: stringValue(item.type, item.kind, item.actionType) || "action",
    title,
    summary: stringValue(
      item.summary,
      item.description,
      item.body,
      proposalPayload?.suggestedAction,
      proposalPayload?.whyNow
    ) || "",
    status: stringValue(item.status) || "proposed",
    createdAt,
    updatedAt: stringValue(item.updatedAt, item.generatedAt) || getMtimeIso(filePath),
    relatedInsightIds: arrayOfStrings(item.relatedInsightIds, item.insightIds, item.sourceInsightRefs),
    payload: recordValue(item.payload) || proposalPayload || undefined,
    approval: recordValue(item.approval) || undefined,
    evidenceRefs: arrayOfStrings(item.evidenceRefs, item.sources, item.references),
    sourcePath: path.relative(BRAIN_ROOT, filePath),
  };
}

function normalizeWorkflowRun(record: unknown, filePath: string): BrainWorkflowRun | null {
  const item = recordValue(record);
  if (!item) return null;

  const id = stringValue(item.id, path.basename(filePath, ".json"));
  const proposalId = stringValue(item.proposalId);
  if (!id || !proposalId) return null;

  const createdAt = stringValue(item.createdAt) || getMtimeIso(filePath) || new Date().toISOString();
  const updatedAt = stringValue(item.updatedAt) || getMtimeIso(filePath) || createdAt;
  const approval = recordValue(item.approval) || {};
  const autonomy = recordValue(item.autonomy) || {};
  const execution = recordValue(item.execution) || undefined;

  return {
    id,
    proposalId,
    proposalType: stringValue(item.proposalType, item.type) || "action",
    title: stringValue(item.title) || proposalId,
    state: normalizeWorkflowState(stringValue(item.state)),
    createdAt,
    updatedAt,
    payload: recordValue(item.payload) || undefined,
    relatedInsightIds: arrayOfStrings(item.relatedInsightIds),
    evidenceRefs: arrayOfStrings(item.evidenceRefs),
    approval: {
      required: approval.required !== false,
      reason: stringValue(approval.reason) || undefined,
      approvedAt: stringValue(approval.approvedAt) || undefined,
      rejectedAt: stringValue(approval.rejectedAt) || undefined,
      snoozedAt: stringValue(approval.snoozedAt) || undefined,
      actor: stringValue(approval.actor) || undefined,
    },
    autonomy: {
      level: numberValue(autonomy.level) || 1,
      policy: stringValue(autonomy.policy) || "explicit-human-approval-required",
      promotionBlockedUntil: stringValue(autonomy.promotionBlockedUntil) || undefined,
    },
    execution: execution ? {
      adapter: stringValue(execution.adapter) || undefined,
      startedAt: stringValue(execution.startedAt) || undefined,
      completedAt: stringValue(execution.completedAt) || undefined,
      failedAt: stringValue(execution.failedAt) || undefined,
      summary: stringValue(execution.summary) || undefined,
      receipt: execution.receipt,
      error: stringValue(execution.error) || undefined,
    } : undefined,
    outcomeLedgerRefs: arrayOfStrings(item.outcomeLedgerRefs),
    events: Array.isArray(item.events)
      ? item.events
        .map((event) => normalizeWorkflowEvent(event))
        .filter((event): event is BrainWorkflowEvent => !!event)
      : [],
    sourcePath: path.relative(BRAIN_ROOT, filePath),
  };
}

function mapPrepPacketToDocument(packet: BrainPrepPacket): ContextDocument {
  const body = [
    packet.summary,
    packet.whyItMatters ? `Why it matters: ${packet.whyItMatters}` : "",
    packet.currentState.length ? `Current state:\n- ${packet.currentState.join("\n- ")}` : "",
    packet.talkingPoints.length ? `Talking points:\n- ${packet.talkingPoints.join("\n- ")}` : "",
    packet.openQuestions.length ? `Open questions:\n- ${packet.openQuestions.join("\n- ")}` : "",
    packet.openCommitments.length ? `Open commitments:\n- ${packet.openCommitments.join("\n- ")}` : "",
    packet.risks.length ? `Risks:\n- ${packet.risks.join("\n- ")}` : "",
    packet.suggestedPosture ? `Suggested posture: ${packet.suggestedPosture}` : "",
    packet.liveContextMarkdown,
  ].filter(Boolean).join("\n\n");

  const createdAt = packet.startsAt || packet.updatedAt || new Date().toISOString();

  return {
    id: `brain-prep:${packet.id}`,
    sourceType: "brain_prep_packet",
    sourceSystem: "ipcorp_architecture_brain",
    title: `Prep packet: ${packet.title}`,
    body,
    createdAt,
    updatedAt: packet.updatedAt,
    eventTimeStart: packet.startsAt || undefined,
    participants: packet.attendees,
    relatedMeetingIds: [packet.id],
    trustTier: "authoritative",
    visibility: "private",
    freshnessClass: classifyFreshness(Date.parse(packet.updatedAt || packet.startsAt || "")),
    lexicalTerms: tokenize(`${packet.title} ${body}`),
    sourceScore: 0.96,
    metadata: {
      brainPath: packet.sourcePath,
      evidenceRefs: packet.evidenceRefs,
    },
  };
}

function mapCortexInsightToDocument(insight: BrainCortexInsight): ContextDocument {
  const reasoning = insight.reasoning ? compactJson(insight.reasoning) : "";
  const body = [
    insight.summary,
    insight.action ? `Recommended action: ${insight.action}` : "",
    reasoning ? `Reasoning: ${reasoning}` : "",
    insight.tags.length ? `Tags: ${insight.tags.join(", ")}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    id: `brain-cortex:${insight.id}`,
    sourceType: "cortex_insight",
    sourceSystem: "ipcorp_architecture_brain",
    title: insight.title,
    body,
    createdAt: insight.createdAt,
    updatedAt: insight.updatedAt,
    trustTier: "authoritative",
    visibility: "private",
    freshnessClass: classifyFreshness(Date.parse(insight.updatedAt || insight.createdAt)),
    lexicalTerms: tokenize(`${insight.title} ${body}`),
    sourceScore: 0.92,
    metadata: {
      brainPath: insight.sourcePath,
      insightType: insight.type,
      confidence: insight.confidence,
      actionProposalRefs: insight.actionProposalRefs,
    },
  };
}

function mapActionProposalToDocument(proposal: BrainActionProposal): ContextDocument {
  const body = [
    proposal.summary,
    `Status: ${proposal.status}`,
    proposal.relatedInsightIds.length ? `Related insights: ${proposal.relatedInsightIds.join(", ")}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    id: `brain-action:${proposal.id}`,
    sourceType: "action_proposal",
    sourceSystem: "ipcorp_architecture_brain",
    title: proposal.title,
    body,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    trustTier: "authoritative",
    visibility: "private",
    freshnessClass: classifyFreshness(Date.parse(proposal.updatedAt || proposal.createdAt)),
    lexicalTerms: tokenize(`${proposal.title} ${body}`),
    sourceScore: proposal.status === "proposed" ? 0.88 : 0.68,
    metadata: {
      brainPath: proposal.sourcePath,
      proposalType: proposal.type,
      status: proposal.status,
      relatedInsightIds: proposal.relatedInsightIds,
      evidenceRefs: proposal.evidenceRefs,
    },
  };
}

function normalizeMeetingRecord(record: unknown, index: number): BrainMeetingRecord | null {
  const item = recordValue(record);
  if (!item) return null;

  const id = stringValue(item.id, item.meetingId, item.slug, item.path) || `brain-meeting-${index + 1}`;
  const title = stringValue(item.title, item.meetingTitle, item.name, item.subject) || "Untitled meeting";
  const date = stringValue(item.date, item.startTime, item.startedAt, item.createdAt, item.updatedAt) || new Date(0).toISOString();
  const source = normalizeSource(stringValue(item.source, item.sourceFormat, item.origin));
  const importMetadata = recordValue(item.importMetadata) || {};

  return {
    id,
    title,
    date,
    duration: stringValue(item.duration, item.durationText) || formatDuration(item.durationMinutes, item.durationMs),
    summary: stringValue(item.summary, item.overview, item.synopsis, item.description) || "",
    source,
    importMetadata: {
      ...importMetadata,
      sourceFormat: normalizeSourceFormat(stringValue(importMetadata.sourceFormat, item.sourceFormat, item.source)),
      importedAt: stringValue(importMetadata.importedAt, item.importedAt, item.updatedAt) || undefined,
      fidelity: stringValue(importMetadata.fidelity, item.fidelity) || undefined,
      brainSource: stringValue(item.path, item.file, item.sourcePath) || undefined,
    },
    detailedSummary: recordValue(item.detailedSummary) || recordValue(item.analysis) || undefined,
    transcript: [],
    usage: [],
  };
}

function readStatusMeetingCounts(): ReturnType<BrainReadModelService["getMeetingCounts"]> | null {
  const status = readJsonRecord(STATUS_PATH);
  const meetings = recordValue(status?.meetings) || recordValue(status?.meetingCounts);
  if (!meetings) return null;

  return {
    total: numberValue(meetings.total, meetings.indexed, meetings.count),
    natively: numberValue(meetings.natively, meetings.native, meetings.manual),
    calendar: numberValue(meetings.calendar, meetings.calendarEvents),
    teamsImports: numberValue(meetings.teamsImports, meetings.teams),
    cluelyImports: numberValue(meetings.cluelyImports, meetings.cluely),
    genericImports: numberValue(meetings.genericImports, meetings.imported, meetings.other),
    lastMeetingAt: stringValue(meetings.lastMeetingAt, meetings.latestMeetingAt) || undefined,
  };
}

function readJson(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn("[BrainReadModelService] Failed to read JSON:", filePath, error);
    return null;
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
  return recordValue(readJson(filePath));
}

function readJsonFiles<T>(
  dirPath: string,
  normalizer: (record: unknown, filePath: string, index: number) => T | null
): T[] {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
      .filter((fileName) => fileName.toLowerCase().endsWith(".json"))
      .map((fileName, index) => {
        const filePath = path.join(dirPath, fileName);
        return normalizer(readJson(filePath), filePath, index);
      })
      .filter((record): record is T => !!record);
  } catch (error) {
    console.warn("[BrainReadModelService] Failed to read JSON directory:", dirPath, error);
    return [];
  }
}

function extractArray(value: unknown, candidateKeys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = recordValue(value);
  if (!record) return [];
  for (const key of candidateKeys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function recordValue(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(...values: unknown[]): number {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function booleanValue(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(true|yes|connected|ready)$/i.test(value)) return true;
      if (/^(false|no|disconnected|unavailable)$/i.test(value)) return false;
    }
  }
  return false;
}

function arrayOfStrings(...values: unknown[]): string[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value
        .flatMap((item) => {
          if (typeof item === "string" || typeof item === "number") return [String(item)];
          const record = recordValue(item);
          if (!record) return [];
          const text = stringValue(record.name, record.displayName, record.email, record.title, record.summary, record.source);
          return text ? [text] : [];
        })
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split(/\r?\n|[;•]/)
        .map((item) => item.trim().replace(/^[-*]\s*/, ""))
        .filter(Boolean);
    }
  }
  return [];
}

function dedupeById<T extends { id: string }>(records: T[]): T[] {
  const seen = new Map<string, T>();
  for (const record of records) {
    if (!seen.has(record.id)) {
      seen.set(record.id, record);
    }
  }
  return [...seen.values()];
}

function dedupeDocuments(documents: ContextDocument[]): ContextDocument[] {
  const seen = new Map<string, ContextDocument>();
  for (const doc of documents) {
    if (!seen.has(doc.id)) {
      seen.set(doc.id, doc);
    }
  }
  return [...seen.values()];
}

function sortByNewest(left: { updatedAt?: string; createdAt?: string; startsAt?: string | null }, right: { updatedAt?: string; createdAt?: string; startsAt?: string | null }): number {
  return timestampMs(right.updatedAt, right.createdAt, right.startsAt) -
    timestampMs(left.updatedAt, left.createdAt, left.startsAt);
}

function scoreBrainDocument(doc: ContextDocument, query: string): number {
  const terms = tokenize(query);
  if (!terms.length) return doc.sourceScore ?? 0;
  return (doc.sourceScore ?? 0) + overlapRatio(terms, doc.lexicalTerms || tokenize(`${doc.title} ${doc.body}`));
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const matches = left.reduce((count, term) => count + (rightSet.has(term) ? 1 : 0), 0);
  return matches / left.length;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifyFreshness(timestampMs: number): ContextDocument["freshnessClass"] {
  if (!Number.isFinite(timestampMs)) return "historical";
  const ageMs = Math.abs(Date.now() - timestampMs);
  if (ageMs <= 4 * 60 * 60 * 1000) return "live";
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return "recent";
  return "historical";
}

function timestampMs(...values: unknown[]): number {
  const parsed = Date.parse(stringValue(...values));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeSource(value: string): BrainMeetingSource | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("cluely")) return "cluely";
  if (normalized.includes("teams")) return "teams";
  if (normalized.includes("calendar") || normalized.includes("outlook")) return "calendar";
  if (normalized.includes("manual") || normalized.includes("native")) return "manual";
  if (normalized.includes("generic") || normalized.includes("import")) return "imported";
  return undefined;
}

function normalizeSourceFormat(value: string): "cluely" | "teams" | "generic" | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("cluely")) return "cluely";
  if (normalized.includes("teams")) return "teams";
  if (normalized.includes("generic") || normalized.includes("import")) return "generic";
  return undefined;
}

function normalizeWorkflowState(value: string): BrainWorkflowState {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "approved") return "approved";
  if (normalized === "executing" || normalized === "running") return "executing";
  if (normalized === "completed" || normalized === "executed" || normalized === "done") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "rejected" || normalized === "declined") return "rejected";
  if (normalized === "snoozed" || normalized === "deferred") return "snoozed";
  if (normalized === "blocked") return "blocked";
  return "waiting_for_approval";
}

function workflowStateToProposalStatus(state: BrainWorkflowState): BrainActionProposal["status"] {
  switch (state) {
    case "waiting_for_approval":
      return "proposed";
    case "completed":
      return "executed";
    default:
      return state;
  }
}

function outcomeDecisionToWorkflowState(decision: string): BrainWorkflowState {
  const normalized = decision.toLowerCase();
  if (normalized === "approved" || normalized === "edited_then_approved") return "approved";
  if (normalized === "rejected") return "rejected";
  if (normalized === "snoozed") return "snoozed";
  if (normalized === "executed") return "completed";
  if (normalized === "failed") return "failed";
  return "waiting_for_approval";
}

function normalizeWorkflowEvent(value: unknown): BrainWorkflowEvent | null {
  const event = recordValue(value);
  if (!event) return null;
  const type = stringValue(event.type);
  if (!type) return null;
  const actor = stringValue(event.actor) as BrainWorkflowEvent["actor"];
  return {
    timestamp: stringValue(event.timestamp) || new Date().toISOString(),
    type,
    actor: ["steve", "natively", "brain", "system"].includes(actor) ? actor : "system",
    summary: stringValue(event.summary) || undefined,
    payload: event.payload,
  };
}

function workflowRunPath(runId: string): string {
  return path.join(WORKFLOW_RUNS_DIR, `${safePathSegment(runId)}.json`);
}

function writeWorkflowRun(run: BrainWorkflowRun): BrainWorkflowRun {
  const filePath = workflowRunPath(run.id);
  const next = {
    ...run,
    sourcePath: path.relative(BRAIN_ROOT, filePath),
  };
  writeJsonFile(filePath, next);
  return next;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safePathSegment(value: string): string {
  const segment = slugify(value).slice(0, 140);
  return segment || "untitled";
}

function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function formatDuration(durationMinutes: unknown, durationMs: unknown): string {
  const ms = numberValue(durationMs);
  const minutes = ms > 0 ? Math.round(ms / 60_000) : numberValue(durationMinutes);
  if (minutes <= 0) return "0:00";
  return `${minutes}:00`;
}

function getMtimeIso(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return undefined;
  }
}
