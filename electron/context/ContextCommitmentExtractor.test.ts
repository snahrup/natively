import { describe, expect, it } from "vitest";
import { ContextCommitmentExtractor } from "./ContextCommitmentExtractor";
import type { Meeting } from "../db/DatabaseManager";

const baseMeeting = (overrides: Partial<Meeting> = {}): Meeting => ({
    id: "meeting-1",
    title: "Q3 Planning Sync",
    date: "2026-06-12T15:00:00.000Z",
    duration: "30:00",
    summary: "",
    detailedSummary: { actionItems: [], keyPoints: [] },
    transcript: [],
    source: "calendar",
    ...overrides,
});

const extractor = new ContextCommitmentExtractor();

const titles = (meeting: Meeting): string[] =>
    extractor.extractFromMeeting(meeting).map((doc) => doc.title);

describe("ContextCommitmentExtractor.extractFromMeeting", () => {
    it("extracts action items as commitments", () => {
        const meeting = baseMeeting({
            detailedSummary: {
                actionItems: ["Send the revised budget to finance", "- Schedule follow-up with vendor"],
                keyPoints: [],
            },
        });
        expect(titles(meeting)).toEqual([
            "Send the revised budget to finance",
            "Schedule follow-up with vendor",
        ]);
    });

    it("extracts explicit commitments from transcript lines", () => {
        const meeting = baseMeeting({
            transcript: [
                { speaker: "user", text: "I'll send that summary over by Friday", timestamp: 1 },
                { speaker: "external", text: "The weather has been great lately", timestamp: 2 },
            ],
        });
        expect(titles(meeting)).toEqual(["I'll send that summary over by Friday"]);
    });

    it("ignores non-committal conversation", () => {
        const meeting = baseMeeting({
            transcript: [
                { speaker: "external", text: "That sounds reasonable to me overall", timestamp: 1 },
                { speaker: "user", text: "Great, thanks everyone for joining", timestamp: 2 },
            ],
        });
        expect(titles(meeting)).toEqual([]);
    });

    it("ignores lines under the minimum length", () => {
        const meeting = baseMeeting({
            transcript: [{ speaker: "user", text: "I'll do", timestamp: 1 }],
        });
        expect(titles(meeting)).toEqual([]);
    });

    it("dedupes a commitment that appears as both action item and transcript line", () => {
        const meeting = baseMeeting({
            detailedSummary: { actionItems: ["Send the deck to Maria"], keyPoints: [] },
            transcript: [{ speaker: "user", text: "Send the deck to Maria", timestamp: 1 }],
        });
        expect(titles(meeting)).toEqual(["Send the deck to Maria"]);
    });

    it("strips bullet/number prefixes when normalizing", () => {
        const meeting = baseMeeting({
            detailedSummary: { actionItems: ["1. Review the security audit findings"], keyPoints: [] },
        });
        expect(titles(meeting)).toEqual(["Review the security audit findings"]);
    });

    it("produces durable, private commitment documents tied to the meeting", () => {
        const meeting = baseMeeting({
            detailedSummary: { actionItems: ["Draft the rollout announcement"], keyPoints: [] },
        });
        const [doc] = extractor.extractFromMeeting(meeting);
        expect(doc.sourceType).toBe("task_or_commitment");
        expect(doc.trustTier).toBe("durable");
        expect(doc.visibility).toBe("private");
        expect(doc.relatedMeetingIds).toEqual(["meeting-1"]);
        expect(doc.id).toMatch(/^commitment:[0-9a-f]{16}$/);
    });

    it("generates stable ids for the same meeting + commitment", () => {
        const meeting = baseMeeting({
            detailedSummary: { actionItems: ["Draft the rollout announcement"], keyPoints: [] },
        });
        const [first] = extractor.extractFromMeeting(meeting);
        const [second] = extractor.extractFromMeeting(meeting);
        expect(first.id).toBe(second.id);
    });
});
