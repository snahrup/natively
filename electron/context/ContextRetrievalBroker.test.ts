import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextDocument } from "./types";

// The broker imports source adapters and services that transitively reach
// electron/native modules — mock them so the test exercises the pure
// dedupe/filter/score/rank pipeline through the public retrieve() API.
const mockObservationDocs = vi.fn<() => ContextDocument[]>(() => []);

vi.mock("./ContextSourceAdapters", () => ({
    getCalendarDocuments: async () => [],
    getEmailDocuments: async () => [],
    getMeetingMemoryDocuments: async () => [],
    getObservationDocuments: (..._args: unknown[]) => mockObservationDocs(),
    getProfileDocuments: () => [],
    getTeamsDocuments: async () => [],
}));
vi.mock("../services/SemanticaBridgeService", () => ({
    SemanticaBridgeService: { getInstance: () => ({ queryMeetingContext: async () => [] }) },
}));
vi.mock("../services/BrainReadModelService", () => ({
    BrainReadModelService: { getInstance: () => ({ getContextDocuments: () => [] }) },
}));

import { ContextRetrievalBroker } from "./ContextRetrievalBroker";

const doc = (overrides: Partial<ContextDocument>): ContextDocument => ({
    id: overrides.id ?? `doc-${Math.abs(JSON.stringify(overrides).length)}-${overrides.title}`,
    sourceType: "meeting_summary",
    sourceSystem: "meeting_store",
    title: "Untitled",
    body: "",
    createdAt: new Date().toISOString(),
    trustTier: "durable",
    visibility: "private",
    freshnessClass: "recent",
    ...overrides,
});

describe("ContextRetrievalBroker.retrieve", () => {
    beforeEach(() => {
        mockObservationDocs.mockReturnValue([]);
    });

    it("returns an empty low-confidence result for a blank query", async () => {
        const result = await ContextRetrievalBroker.getInstance().retrieve({
            query: "   ",
            surface: "reactive",
        });
        expect(result.documents).toEqual([]);
        expect(result.confidence).toBe("low");
    });

    it("ranks a lexically-matching document above an unrelated one", async () => {
        mockObservationDocs.mockReturnValue([
            doc({
                id: "match",
                title: "Budget review with finance",
                body: "The quarterly budget review covers finance allocations and headcount.",
            }),
            doc({
                id: "noise",
                title: "Office plants watering schedule",
                body: "Water the ferns twice weekly and rotate the succulents monthly.",
            }),
        ]);

        const result = await ContextRetrievalBroker.getInstance().retrieve({
            query: "what did finance say about the quarterly budget review",
            surface: "reactive",
        });

        expect(result.documents[0]?.id).toBe("match");
    });

    it("drops documents below the 0.12 score cutoff", async () => {
        mockObservationDocs.mockReturnValue([
            doc({
                id: "irrelevant",
                title: "zzz qqq xyzzy",
                body: "plugh fnord wibble",
                // observed + historical floors the non-lexical components
                trustTier: "observed",
                freshnessClass: "historical",
                sourceScore: 0,
            }),
        ]);

        const result = await ContextRetrievalBroker.getInstance().retrieve({
            query: "quarterly budget review with finance",
            surface: "reactive",
        });

        expect(result.documents).toEqual([]);
        expect(result.confidence).toBe("low");
    });

    it("applies the superseded penalty so corrected facts outrank stale ones", async () => {
        const shared = {
            title: "Deployment date decision",
            body: "The deployment date for the platform migration release window.",
        };
        mockObservationDocs.mockReturnValue([
            doc({ ...shared, id: "stale", body: `${shared.body} Old date: June 1.`, metadata: { superseded: true } }),
            doc({ ...shared, id: "current", body: `${shared.body} New date: June 15.` }),
        ]);

        const result = await ContextRetrievalBroker.getInstance().retrieve({
            query: "deployment date for the platform migration",
            surface: "reactive",
        });

        const ids = result.documents.map((d) => d.id);
        expect(ids[0]).toBe("current");
        const stale = result.documents.find((d) => d.id === "stale");
        if (stale) {
            expect(stale.scoreBreakdown.penalty).toBe(0.4);
        }
    });

    it("boosts live transcript evidence on the meeting surface", async () => {
        const shared = {
            title: "Pricing discussion",
            body: "Customer asked about enterprise pricing tiers and discounts.",
        };
        mockObservationDocs.mockReturnValue([
            doc({ ...shared, id: "summary", sourceType: "meeting_summary" }),
            doc({ ...shared, id: "live", sourceType: "live_transcript", trustTier: "observed", freshnessClass: "live" }),
        ]);

        const meetingResult = await ContextRetrievalBroker.getInstance().retrieve({
            query: "enterprise pricing tiers discounts customer",
            surface: "meeting",
        });
        const reactiveResult = await ContextRetrievalBroker.getInstance().retrieve({
            query: "enterprise pricing tiers discounts customer",
            surface: "reactive",
        });

        const focusOf = (result: typeof meetingResult, id: string) =>
            result.documents.find((d) => d.id === id)?.scoreBreakdown.focus ?? 0;

        expect(focusOf(meetingResult, "live")).toBeGreaterThan(focusOf(reactiveResult, "live"));
    });

    it("respects the result limit", async () => {
        mockObservationDocs.mockReturnValue(
            Array.from({ length: 8 }, (_, i) =>
                doc({
                    id: `d${i}`,
                    title: `Quarterly budget review part ${i}`,
                    body: "Finance quarterly budget review discussion and allocations.",
                })
            )
        );

        const result = await ContextRetrievalBroker.getInstance().retrieve({
            query: "quarterly budget review finance",
            surface: "reactive",
            limit: 3,
        });

        expect(result.documents).toHaveLength(3);
    });

    it("honors includeSourceTypes / excludeSourceTypes filters", async () => {
        mockObservationDocs.mockReturnValue([
            doc({ id: "a", sourceType: "meeting_summary", title: "Budget review", body: "Quarterly budget review." }),
            doc({ id: "b", sourceType: "ocr_observation", title: "Budget review on screen", body: "Quarterly budget review on screen.", trustTier: "observed" }),
        ]);

        const onlyOcr = await ContextRetrievalBroker.getInstance().retrieve({
            query: "quarterly budget review",
            surface: "reactive",
            includeSourceTypes: ["ocr_observation"],
        });
        expect(onlyOcr.documents.map((d) => d.id)).toEqual(["b"]);

        const noOcr = await ContextRetrievalBroker.getInstance().retrieve({
            query: "quarterly budget review",
            surface: "reactive",
            excludeSourceTypes: ["ocr_observation"],
        });
        expect(noOcr.documents.map((d) => d.id)).toEqual(["a"]);
    });
});
