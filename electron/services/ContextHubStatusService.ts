import { DatabaseManager } from "../db/DatabaseManager";
import { ContextObservationStore } from "../context";
import { AutonomousOpsService, type AutonomousOpsStatus } from "../autonomy";
import { BrainReadModelService } from "./BrainReadModelService";
import { DurableWorkflowLedger, type DurableWorkflowLedgerStatus } from "./DurableWorkflowLedger";
import { ServiceHealthRegistry, type ServiceHealthEntry } from "./ServiceHealthRegistry";

export interface ContextHubStatus {
  generatedAt: string;
  brain: {
    available: boolean;
    rootPath: string;
    statusUpdatedAt?: string;
    meetingIndexUpdatedAt?: string;
    latestRunAt?: string;
    prepPacketsReady: number;
    cortexInsights: number;
    openActionProposals: number;
    runtimeBoundary?: Record<string, unknown>;
    warning?: string;
  };
  semantica: {
    available: boolean;
    ready: boolean;
    meetingCount: number;
    recordCount: number;
    nodeCount: number;
    edgeCount: number;
    stateDir?: string;
    error?: string | null;
  };
  meetings: {
    total: number;
    natively: number;
    calendar: number;
    teamsImports: number;
    cluelyImports: number;
    genericImports: number;
    lastMeetingAt?: string;
  };
  live: {
    ocrObservations: number;
    liveTranscriptSegments: number;
    chatTurns: number;
    lastObservedAt?: string;
  };
  localSources: {
    upcomingEvents: number;
    recentEmails: number;
    teamsChats: number;
    outlookConnected: boolean;
    teamsConnected: boolean;
  };
  profile: {
    loaded: boolean;
    summary?: string;
    experienceCount: number;
    projectCount: number;
    nodeCount: number;
  };
  autonomousOps: AutonomousOpsStatus;
  durableWorkflows: DurableWorkflowLedgerStatus;
  /** Bootstrap/runtime health of background services (failed inits are visible here). */
  services: ServiceHealthEntry[];
}

export class ContextHubStatusService {
  static async getStatus(knowledgeOrchestrator?: any): Promise<ContextHubStatus> {
    const brainReadModel = BrainReadModelService.getInstance();
    const brainMeetings = brainReadModel.getRecentMeetings(250);
    const meetings = brainMeetings.length > 0
      ? brainMeetings
      : DatabaseManager.getInstance().getRecentMeetings(250);
    const meetingCounts = brainReadModel.getMeetingCounts(meetings as any);
    const localSourceCounts = brainReadModel.getLocalSourceCounts();
    const brainStatus = brainReadModel.getStatus();
    const cortexSummary = brainReadModel.getCortexSummary();
    const observations = ContextObservationStore.getInstance().getDocuments();

    const profileData = safeGetProfileData(knowledgeOrchestrator);
    const autonomousOps = AutonomousOpsService.getInstance().getStatus();
    const durableWorkflows = DurableWorkflowLedger.getInstance().getStatus(25);
    const lastObservedAt = observations
      .map((doc) => doc.updatedAt || doc.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      generatedAt: new Date().toISOString(),
      brain: {
        available: brainStatus.available,
        rootPath: brainStatus.rootPath,
        statusUpdatedAt: brainStatus.statusUpdatedAt,
        meetingIndexUpdatedAt: brainStatus.meetingIndexUpdatedAt,
        latestRunAt: cortexSummary.latestRunAt || brainStatus.latestRunUpdatedAt,
        prepPacketsReady: cortexSummary.prepPacketsReady,
        cortexInsights: cortexSummary.cortexInsights,
        openActionProposals: cortexSummary.openActionProposals,
        runtimeBoundary: cortexSummary.runtimeBoundary,
        warning: brainStatus.warning,
      },
      semantica: {
        available: false,
        ready: false,
        meetingCount: 0,
        recordCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        stateDir: undefined,
        error: "Deprecated: Natively now reads IP Corp brain repo read models instead of Semantica.",
      },
      meetings: {
        total: meetingCounts.total,
        natively: meetingCounts.natively,
        calendar: meetingCounts.calendar,
        teamsImports: meetingCounts.teamsImports,
        cluelyImports: meetingCounts.cluelyImports,
        genericImports: meetingCounts.genericImports,
        lastMeetingAt: meetingCounts.lastMeetingAt,
      },
      live: {
        ocrObservations: observations.filter((doc) => doc.sourceType === "ocr_observation").length,
        liveTranscriptSegments: observations.filter((doc) => doc.sourceType === "live_transcript").length,
        chatTurns: observations.filter((doc) => doc.sourceType === "interaction").length,
        lastObservedAt,
      },
      localSources: {
        upcomingEvents: localSourceCounts.upcomingEvents,
        recentEmails: localSourceCounts.recentEmails,
        teamsChats: localSourceCounts.teamsChats,
        outlookConnected: localSourceCounts.outlookConnected,
        teamsConnected: localSourceCounts.teamsConnected,
      },
      profile: {
        loaded: !!profileData,
        summary: profileData
          ? profileData.identity?.headline || profileData.identity?.email || profileData.identity?.name
          : undefined,
        experienceCount: Number(profileData?.experienceCount || 0),
        projectCount: Number(profileData?.projectCount || 0),
        nodeCount: Number(profileData?.nodeCount || 0),
      },
      autonomousOps,
      durableWorkflows,
      services: ServiceHealthRegistry.getInstance().getAll(),
    };
  }
}

function safeGetProfileData(knowledgeOrchestrator?: any): any | null {
  if (!knowledgeOrchestrator || typeof knowledgeOrchestrator.getProfileData !== "function") {
    return null;
  }

  try {
    return knowledgeOrchestrator.getProfileData();
  } catch {
    return null;
  }
}
