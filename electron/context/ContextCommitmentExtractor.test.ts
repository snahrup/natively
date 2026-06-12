import { describe, expect, it } from "vitest";
import { ContextCommitmentExtractor, parseDuePhrase } from "./ContextCommitmentExtractor";
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

    it("attaches dueAt when the commitment carries a date phrase", () => {
        const meeting = baseMeeting({
            transcript: [{ speaker: "user", text: "I'll send that summary over by Friday", timestamp: 1 }],
        });
        const [doc] = extractor.extractFromMeeting(meeting);
        expect(doc.dueAt).toBeDefined();
        expect(Date.parse(doc.dueAt!)).toBeGreaterThan(Date.parse(meeting.date));
    });
});

describe("parseDuePhrase", () => {
    // Wednesday, 2026-06-10, 10:00 local
    const ref = new Date(2026, 5, 10, 10, 0, 0);

    const dayOf = (iso: string | null) => (iso ? new Date(iso) : null);

    it("resolves 'by Friday' to the upcoming Friday", () => {
        const due = dayOf(parseDuePhrase("I'll send the report by Friday", ref));
        expect(due?.getDay()).toBe(5);
        expect(due!.getTime()).toBeGreaterThan(ref.getTime());
        expect(due!.getTime() - ref.getTime()).toBeLessThan(7 * 24 * 60 * 60 * 1000);
    });

    it("rolls a same-weekday phrase to next week", () => {
        const due = dayOf(parseDuePhrase("Finish this by Wednesday", ref));
        expect(due?.getDay()).toBe(3);
        expect(due!.getDate()).toBe(17); // the NEXT Wednesday, not today
    });

    it("resolves 'tomorrow'", () => {
        const due = dayOf(parseDuePhrase("I'll confirm tomorrow", ref));
        expect(due?.getDate()).toBe(11);
    });

    it("resolves 'end of day' to the same day", () => {
        const due = dayOf(parseDuePhrase("Need to update the ticket by end of day", ref));
        expect(due?.getDate()).toBe(10);
        expect(due?.getHours()).toBe(17);
    });

    it("resolves 'end of week' to Friday", () => {
        const due = dayOf(parseDuePhrase("Let's wrap this up by end of week", ref));
        expect(due?.getDay()).toBe(5);
        expect(due?.getDate()).toBe(12);
    });

    it("resolves 'next week' to next Monday", () => {
        const due = dayOf(parseDuePhrase("I'll circle back next week", ref));
        expect(due?.getDay()).toBe(1);
        expect(due?.getDate()).toBe(15);
    });

    it("resolves 'in 3 days'", () => {
        const due = dayOf(parseDuePhrase("Deliver the draft in 3 days", ref));
        expect(due?.getDate()).toBe(13);
    });

    it("resolves 'by June 15' within the same year", () => {
        const due = dayOf(parseDuePhrase("Send the contract by June 15", ref));
        expect(due?.getMonth()).toBe(5);
        expect(due?.getDate()).toBe(15);
        expect(due?.getFullYear()).toBe(2026);
    });

    it("rolls a past month-date to next year", () => {
        const due = dayOf(parseDuePhrase("Review by January 5", ref));
        expect(due?.getFullYear()).toBe(2027);
    });

    it("returns null when no temporal phrase exists", () => {
        expect(parseDuePhrase("Send the deck to Maria", ref)).toBeNull();
        expect(parseDuePhrase("We should review the architecture", ref)).toBeNull();
    });
});
