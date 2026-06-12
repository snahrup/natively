// DeadlineSweepService
// The "notice an approaching deadline" half of the follow-through loop.
// Before this, no code path compared a commitment against the clock: "I'll
// send that by Friday" was extracted as text and the temporal half discarded.
//
// - Meeting saves are watched (subscribeMeetingChanges); commitments with
//   parsed dueAt land in the durable observation store.
// - A 5-minute sweep compares dueAt to the clock and fires ONE clickable
//   desktop notification per commitment when it enters the due-soon window
//   (60 min before due, up to 24h overdue). Clicking opens the launcher.

import { Notification } from "electron";
import { DatabaseManager, Meeting } from "../db/DatabaseManager";
import { ContextObservationStore } from "../context/ContextObservationStore";
import { ContextCommitmentExtractor } from "../context/ContextCommitmentExtractor";
import { ContextDocument } from "../context/types";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DUE_SOON_WINDOW_MS = 60 * 60 * 1000;
const OVERDUE_GRACE_MS = 24 * 60 * 60 * 1000;

export class DeadlineSweepService {
  private static instance: DeadlineSweepService;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribeMeetings: (() => void) | null = null;
  private extractor = new ContextCommitmentExtractor();
  private onActivate: (() => void) | null = null;

  static getInstance(): DeadlineSweepService {
    if (!DeadlineSweepService.instance) {
      DeadlineSweepService.instance = new DeadlineSweepService();
    }
    return DeadlineSweepService.instance;
  }

  start(onActivate?: () => void): void {
    if (this.timer) return;
    this.onActivate = onActivate ?? null;

    try {
      this.unsubscribeMeetings = DatabaseManager.getInstance().subscribeMeetingChanges((event) => {
        if (event.type === "upsert") {
          this.ingestMeetingCommitments(event.meeting);
        }
      });
    } catch (error) {
      console.warn("[DeadlineSweep] Could not subscribe to meeting changes:", error);
    }

    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    this.sweep();
    console.log("[DeadlineSweep] Started (5-minute sweep, 60-minute due-soon window)");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribeMeetings?.();
    this.unsubscribeMeetings = null;
  }

  private ingestMeetingCommitments(meeting: Meeting): void {
    try {
      const docs = this.extractor.extractFromMeeting(meeting);
      if (docs.length === 0) return;
      const store = ContextObservationStore.getInstance();
      let withDue = 0;
      for (const doc of docs) {
        store.recordCommitmentDocument(doc);
        if (doc.dueAt) withDue += 1;
      }
      console.log(`[DeadlineSweep] Ingested ${docs.length} commitment(s) (${withDue} dated) from "${meeting.title}"`);
    } catch (error) {
      console.warn("[DeadlineSweep] Commitment ingestion failed:", error);
    }
  }

  sweep(): void {
    try {
      const store = ContextObservationStore.getInstance();
      const docs = store.getDocuments({ sourceTypes: ["task_or_commitment"] });
      const now = Date.now();

      for (const doc of docs) {
        if (!doc.dueAt || doc.metadata?.deadlineNotifiedAt) continue;
        const dueMs = Date.parse(doc.dueAt);
        if (!Number.isFinite(dueMs)) continue;

        const untilDue = dueMs - now;
        if (untilDue > DUE_SOON_WINDOW_MS) continue; // not due-soon yet
        if (untilDue < -OVERDUE_GRACE_MS) continue;  // long-stale — don't spam old imports

        this.notify(doc, untilDue);
        // One notification per commitment: persist the marker so it survives
        // restarts (the durable store write-through handles persistence).
        store.recordCommitmentDocument({
          ...doc,
          metadata: { ...(doc.metadata || {}), deadlineNotifiedAt: new Date(now).toISOString() },
        });
      }
    } catch (error) {
      console.warn("[DeadlineSweep] Sweep failed:", error);
    }
  }

  private notify(doc: ContextDocument, untilDueMs: number): void {
    try {
      if (!Notification.isSupported()) return;
      const overdue = untilDueMs < 0;
      const due = new Date(Date.parse(doc.dueAt!));
      const fromMeeting = typeof doc.metadata?.meetingTitle === "string" && doc.metadata.meetingTitle
        ? ` — from "${doc.metadata.meetingTitle}"`
        : "";

      const notification = new Notification({
        title: overdue ? "Commitment overdue" : "Commitment due soon",
        body: `${doc.title}\nDue ${due.toLocaleString()}${fromMeeting}`,
        silent: false,
      });
      notification.on("click", () => {
        try { this.onActivate?.(); } catch { /* window may be gone */ }
      });
      notification.show();
      console.log(`[DeadlineSweep] Notified (${overdue ? "overdue" : "due soon"}): ${doc.title}`);
    } catch (error) {
      console.warn("[DeadlineSweep] Notification failed:", error);
    }
  }
}
