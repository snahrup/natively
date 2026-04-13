import {
  DatabaseManager,
  type Meeting,
  type MeetingChangeEvent,
} from "../db/DatabaseManager";
import { SemanticaBridgeService } from "./SemanticaBridgeService";

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export class SemanticaMeetingIndexer {
  private static instance: SemanticaMeetingIndexer;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private pendingMeetings = new Map<string, Meeting>();
  private flushTimer: NodeJS.Timeout | null = null;
  private initialSyncPromise: Promise<number> | null = null;

  public static getInstance(): SemanticaMeetingIndexer {
    if (!SemanticaMeetingIndexer.instance) {
      SemanticaMeetingIndexer.instance = new SemanticaMeetingIndexer();
    }
    return SemanticaMeetingIndexer.instance;
  }

  public async start(dbManager: DatabaseManager = DatabaseManager.getInstance()): Promise<number> {
    if (!this.started) {
      this.started = true;
      this.unsubscribe = dbManager.subscribeMeetingChanges((event) => {
        void this.handleMeetingChange(event);
      });
    }

    if (!this.initialSyncPromise) {
      this.initialSyncPromise = this.forceFullResync(dbManager).finally(() => {
        this.initialSyncPromise = null;
      });
    }

    return this.initialSyncPromise;
  }

  public async forceFullResync(dbManager: DatabaseManager = DatabaseManager.getInstance()): Promise<number> {
    const meetingIds = dbManager.getAllMeetingIds();
    const meetings = meetingIds
      .map((meetingId) => dbManager.getMeetingDetails(meetingId))
      .filter((meeting): meeting is Meeting => !!meeting);

    let synced = 0;
    for (const batch of chunk(meetings, 30)) {
      synced += await SemanticaBridgeService.getInstance().bulkUpsertMeetings(batch);
    }
    return synced;
  }

  private async handleMeetingChange(event: MeetingChangeEvent): Promise<void> {
    if (event.type === "delete") {
      this.pendingMeetings.delete(event.meetingId);
      try {
        await SemanticaBridgeService.getInstance().deleteMeeting(event.meetingId);
      } catch (error) {
        console.warn("[SemanticaMeetingIndexer] Failed to delete meeting from Semantica:", event.meetingId, error);
      }
      return;
    }

    this.pendingMeetings.set(event.meetingId, event.meeting);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushPendingMeetings();
    }, 650);
  }

  private async flushPendingMeetings(): Promise<void> {
    const meetings = [...this.pendingMeetings.values()];
    this.pendingMeetings.clear();

    if (meetings.length === 0) return;

    try {
      await SemanticaBridgeService.getInstance().bulkUpsertMeetings(meetings);
    } catch (error) {
      console.warn("[SemanticaMeetingIndexer] Failed to flush meeting updates to Semantica:", error);
      for (const meeting of meetings) {
        this.pendingMeetings.set(meeting.id, meeting);
      }
      this.scheduleFlush();
    }
  }
}
