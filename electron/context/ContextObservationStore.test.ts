import { beforeEach, describe, expect, it } from "vitest";
import { ContextObservationStore } from "./ContextObservationStore";
import type { ContextDocument } from "./types";

// The store's DB write-through/rehydration is wrapped in try/catch and
// degrades to RAM-only when DatabaseManager is unavailable (as it is here) —
// these tests exercise the pure in-memory merge/TTL logic.

const commitment = (overrides: Partial<ContextDocument> = {}): ContextDocument => ({
    id: "commitment:test1234test1234",
    sourceType: "task_or_commitment",
    sourceSystem: "meeting_store",
    title: "Send the report by Friday",
    body: "Open commitment from Sync: Send the report by Friday",
    createdAt: new Date().toISOString(),
    dueAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    trustTier: "durable",
    visibility: "private",
    freshnessClass: "recent",
    metadata: { meetingId: "m1", meetingTitle: "Sync" },
    ...overrides,
});

describe("ContextObservationStore.recordCommitmentDocument", () => {
    beforeEach(() => {
        ContextObservationStore.getInstance().clearAll();
    });

    it("preserves the sweep's deadlineNotifiedAt marker across re-ingestion", () => {
        const store = ContextObservationStore.getInstance();

        // 1. Meeting save ingests the commitment
        store.recordCommitmentDocument(commitment());

        // 2. The deadline sweep notifies and persists the marker
        store.recordCommitmentDocument(commitment({
            metadata: { meetingId: "m1", meetingTitle: "Sync", deadlineNotifiedAt: "2026-06-12T12:00:00.000Z" },
        }));

        // 3. A later meeting re-save (rename, summary regen, context note)
        //    rebuilds the doc from scratch WITHOUT the marker
        store.recordCommitmentDocument(commitment());

        const [doc] = store.getDocuments({ sourceTypes: ["task_or_commitment"] });
        expect(doc.metadata?.deadlineNotifiedAt).toBe("2026-06-12T12:00:00.000Z");
    });

    it("lets an explicit marker on the incoming doc win", () => {
        const store = ContextObservationStore.getInstance();
        store.recordCommitmentDocument(commitment({
            metadata: { meetingId: "m1", meetingTitle: "Sync", deadlineNotifiedAt: "2026-06-12T12:00:00.000Z" },
        }));
        store.recordCommitmentDocument(commitment({
            metadata: { meetingId: "m1", meetingTitle: "Sync", deadlineNotifiedAt: "2026-06-12T13:30:00.000Z" },
        }));

        const [doc] = store.getDocuments({ sourceTypes: ["task_or_commitment"] });
        expect(doc.metadata?.deadlineNotifiedAt).toBe("2026-06-12T13:30:00.000Z");
    });

    it("applies the 180-day TTL when the doc carries none", () => {
        const store = ContextObservationStore.getInstance();
        const created = new Date();
        store.recordCommitmentDocument(commitment({ createdAt: created.toISOString() }));

        const [doc] = store.getDocuments({ sourceTypes: ["task_or_commitment"] });
        const expectedExpiry = created.getTime() + 180 * 24 * 60 * 60 * 1000;
        expect(Math.abs(Date.parse(doc.expiresAt!) - expectedExpiry)).toBeLessThan(1000);
    });

    it("ignores documents that are not commitments", () => {
        const store = ContextObservationStore.getInstance();
        store.recordCommitmentDocument(commitment({ sourceType: "meeting_summary" }));
        expect(store.getDocuments({ sourceTypes: ["meeting_summary"] })).toHaveLength(0);
    });
});
