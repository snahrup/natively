import { BrowserWindow } from "electron";
import { OutlookComBridge } from "./OutlookComBridge";
import { TeamsBridge } from "./TeamsBridge";
import type {
  CalendarCreateRequest,
  ComBridgeStatus,
  OutlookCalendarEvent,
  OutlookContact,
  OutlookEmail,
  TeamsBridgeInfo,
  TeamsChat,
  TeamsMessage,
  TeamsSendResult,
} from "./MicrosoftLocalTypes";

export interface MicrosoftLocalStatus {
  outlook: ComBridgeStatus;
  teams: TeamsBridgeInfo;
}

export class MicrosoftLocalManager {
  private static instance: MicrosoftLocalManager;

  private readonly outlook = new OutlookComBridge();
  private readonly teams = new TeamsBridge();
  private pollersStarted = false;
  private startPromise: Promise<void> | null = null;

  public static getInstance(): MicrosoftLocalManager {
    if (!MicrosoftLocalManager.instance) {
      MicrosoftLocalManager.instance = new MicrosoftLocalManager();
    }
    return MicrosoftLocalManager.instance;
  }

  public setWindow(win: BrowserWindow): void {
    this.outlook.setWindow(win);
    this.teams.setWindow(win);
  }

  public async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      if (!this.pollersStarted) {
        this.pollersStarted = true;
        await this.outlook.start().catch((error: any) => {
          console.warn("[MicrosoftLocalManager] Outlook bridge start failed:", error?.message || error);
        });
      }

      await this.refreshConnections();
    })().finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  public async refreshConnections(): Promise<void> {
    await this.outlook.healthCheck().catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Outlook health refresh failed:", error?.message || error);
    });

    if (this.teams.getInfo().status !== "connected") {
      await this.teams.connect().catch((error: any) => {
        console.warn("[MicrosoftLocalManager] Teams bridge connect failed:", error?.message || error);
      });
    }
  }

  public stop(): void {
    this.outlook.stop();
    this.teams.disconnect();
    this.pollersStarted = false;
    this.startPromise = null;
  }

  public async getStatus(): Promise<MicrosoftLocalStatus> {
    const [outlook, teams] = await Promise.all([
      this.outlook.getStatus().catch((error: any) => ({
        outlookRunning: false,
        comAvailable: false,
        lastError: error?.message || String(error),
      })),
      Promise.resolve(this.teams.getInfo()),
    ]);

    return { outlook, teams };
  }

  public async getOutlookCalendarEvents(hours = 48): Promise<OutlookCalendarEvent[]> {
    return this.outlook.getUpcoming(hours).catch((error: any): OutlookCalendarEvent[] => {
      console.warn("[MicrosoftLocalManager] Outlook calendar fetch failed:", error?.message || error);
      return [];
    });
  }

  public async getOutlookCalendarEventsInRange(startDate: string, endDate: string): Promise<OutlookCalendarEvent[]> {
    return this.outlook.getEvents(startDate, endDate).catch((error: any): OutlookCalendarEvent[] => {
      console.warn("[MicrosoftLocalManager] Outlook historical calendar fetch failed:", error?.message || error);
      return [];
    });
  }

  public async getRecentEmails(top = 25, unreadOnly = false): Promise<OutlookEmail[]> {
    const result = await this.outlook.listEmails({ top, unreadOnly }).catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Outlook email fetch failed:", error?.message || error);
      return { emails: [] as OutlookEmail[], totalCount: 0 };
    });
    return result.emails;
  }

  public async searchEmails(query: string, top = 25): Promise<OutlookEmail[]> {
    const result = await this.outlook.searchEmails(query, top).catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Outlook email search failed:", error?.message || error);
      return { emails: [] as OutlookEmail[], totalCount: 0 };
    });
    return result.emails;
  }

  public async getOutlookContacts(query?: string): Promise<OutlookContact[]> {
    const contacts = await this.outlook.getContacts(query).catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Outlook contact fetch failed:", error?.message || error);
      return [] as any[];
    });

    return contacts
      .map((contact: any) => ({
        name: contact?.name || contact?.fullName || [contact?.firstName, contact?.lastName].filter(Boolean).join(" ").trim(),
        email: contact?.email || contact?.email1 || contact?.address || "",
      }))
      .filter((contact: OutlookContact) => !!contact.email);
  }

  public async getTeamsChats(limit = 25): Promise<TeamsChat[]> {
    return this.teams.getChats(limit).catch((error: any): TeamsChat[] => {
      console.warn("[MicrosoftLocalManager] Teams chat fetch failed:", error?.message || error);
      return [];
    });
  }

  public async getTeamsMessages(chatId: string, limit = 50): Promise<TeamsMessage[]> {
    return this.teams.getMessages(chatId, limit).catch((error: any): TeamsMessage[] => {
      console.warn("[MicrosoftLocalManager] Teams message fetch failed:", error?.message || error);
      return [];
    });
  }

  public async listTeamsMeetingTranscripts(): Promise<Array<{
    chatId: string;
    meetingTitle: string;
    date?: string;
    hasTranscript: boolean;
  }>> {
    return this.teams.listMeetingTranscripts().catch((error: any): Array<{
      chatId: string;
      meetingTitle: string;
      date?: string;
      hasTranscript: boolean;
    }> => {
      console.warn("[MicrosoftLocalManager] Teams transcript candidate discovery failed:", error?.message || error);
      return [];
    });
  }

  public async getTeamsMeetingTranscript(chatIdOrTitle?: string): Promise<{
    success: boolean;
    transcript?: string;
    meetingTitle?: string;
    error?: string;
  }> {
    return this.teams.getMeetingTranscript(chatIdOrTitle).catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Teams transcript fetch failed:", error?.message || error);
      return {
        success: false,
        error: error?.message || String(error),
      };
    });
  }

  public async getOutlookContextSummary(): Promise<string> {
    return this.outlook.getContextSummary().catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Outlook context summary failed:", error?.message || error);
      return "[OUTLOOK] Local Outlook context unavailable.";
    });
  }

  public async getTeamsContextSummary(): Promise<string> {
    return this.teams.getContextSummary().catch((error: any) => {
      console.warn("[MicrosoftLocalManager] Teams context summary failed:", error?.message || error);
      return "[TEAMS] Local Teams context unavailable.";
    });
  }

  public async sendEmail(draft: Parameters<OutlookComBridge["sendEmail"]>[0]): Promise<void> {
    return this.outlook.sendEmail(draft);
  }

  public async createDraft(draft: Parameters<OutlookComBridge["createDraft"]>[0]): Promise<{ entryId: string }> {
    return this.outlook.createDraft(draft);
  }

  public async replyToEmail(entryId: string, body: string, replyAll = false, send = false): Promise<void> {
    return this.outlook.reply(entryId, body, replyAll, send);
  }

  public async createCalendarEvent(request: CalendarCreateRequest): Promise<{ entryId: string }> {
    return this.outlook.createEvent(request);
  }

  public async sendTeamsMessage(chatId: string, text: string): Promise<TeamsSendResult> {
    return this.teams.sendMessage(chatId, text);
  }

  public getTeamsBridge(): TeamsBridge {
    return this.teams;
  }

  public getOutlookBridge(): OutlookComBridge {
    return this.outlook;
  }
}
