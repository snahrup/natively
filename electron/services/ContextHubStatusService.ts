import { DatabaseManager } from "../db/DatabaseManager";
import { ContextObservationStore } from "../context";
import { CalendarManager } from "./CalendarManager";
import { MicrosoftLocalManager } from "./MicrosoftLocalManager";
import { SemanticaBridgeService } from "./SemanticaBridgeService";
import { AutonomousOpsService, type AutonomousOpsStatus } from "../autonomy";

type ResolvedSemanticaStatus = Awaited<ReturnType<SemanticaBridgeService["getStatus"]>>;

export interface ContextHubStatus {
  generatedAt: string;
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
}

export class ContextHubStatusService {
  static async getStatus(knowledgeOrchestrator?: any): Promise<ContextHubStatus> {
    const meetings = DatabaseManager.getInstance().getRecentMeetings(250);
    const observations = ContextObservationStore.getInstance().getDocuments();
    const [events, emails, teamsChats, microsoftStatus] = await Promise.all([
      CalendarManager.getInstance().getUpcomingEvents().catch((): any[] => []),
      MicrosoftLocalManager.getInstance().getRecentEmails(10).catch((): any[] => []),
      MicrosoftLocalManager.getInstance().getTeamsChats(10).catch((): any[] => []),
      MicrosoftLocalManager.getInstance().getStatus().catch(() => ({
        outlook: { outlookRunning: false, comAvailable: false },
        teams: { status: "disconnected" },
      })),
    ]);
    const semanticaStatus: ResolvedSemanticaStatus = await SemanticaBridgeService.getInstance().getStatus().catch((error: any) => ({
      available: false,
      ready: false,
      runtime: null as any,
      sidecar: null as any,
      error: error?.message || "Semantica status unavailable.",
    }));

    const profileData = safeGetProfileData(knowledgeOrchestrator);
    const autonomousOps = AutonomousOpsService.getInstance().getStatus();
    const lastMeetingAt = meetings[0]?.date;
    const lastObservedAt = observations
      .map((doc) => doc.updatedAt || doc.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return {
      generatedAt: new Date().toISOString(),
      semantica: {
        available: !!semanticaStatus.available,
        ready: !!semanticaStatus.ready,
        meetingCount: Number(semanticaStatus.sidecar?.meetingCount || 0),
        recordCount: Number(semanticaStatus.sidecar?.recordCount || 0),
        nodeCount: Number(semanticaStatus.sidecar?.nodeCount || 0),
        edgeCount: Number(semanticaStatus.sidecar?.edgeCount || 0),
        stateDir: semanticaStatus.sidecar?.stateDir || undefined,
        error: semanticaStatus.error || null,
      },
      meetings: {
        total: meetings.length,
        natively: meetings.filter((meeting) => !meeting.source || meeting.source === "manual").length,
        calendar: meetings.filter((meeting) => meeting.source === "calendar").length,
        teamsImports: meetings.filter((meeting) => meeting.source === "teams").length,
        cluelyImports: meetings.filter((meeting) => meeting.source === "cluely").length,
        genericImports: meetings.filter((meeting) => meeting.source === "imported").length,
        lastMeetingAt,
      },
      live: {
        ocrObservations: observations.filter((doc) => doc.sourceType === "ocr_observation").length,
        liveTranscriptSegments: observations.filter((doc) => doc.sourceType === "live_transcript").length,
        chatTurns: observations.filter((doc) => doc.sourceType === "interaction").length,
        lastObservedAt,
      },
      localSources: {
        upcomingEvents: events.length,
        recentEmails: emails.length,
        teamsChats: teamsChats.length,
        outlookConnected: !!microsoftStatus.outlook?.comAvailable,
        teamsConnected: microsoftStatus.teams?.status === "connected",
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
