import { describe, expect, it } from "vitest";
import {
    cleanTranscript,
    prepareTranscriptForWhatToAnswer,
    sparsifyTranscript,
    TranscriptTurn,
} from "./transcriptCleaner";

const turn = (role: TranscriptTurn["role"], text: string, timestamp = 0): TranscriptTurn => ({
    role,
    text,
    timestamp,
});

describe("cleanTranscript", () => {
    it("removes filler words but keeps the substance", () => {
        const [cleaned] = cleanTranscript([
            turn("external", "um so basically we need the quarterly report by Monday"),
        ]);
        expect(cleaned.text).toBe("we need the quarterly report by monday");
    });

    it("drops pure-acknowledgement turns", () => {
        expect(cleanTranscript([turn("user", "yeah yeah okay cool")])).toHaveLength(0);
    });

    it("collapses repeated words", () => {
        const [cleaned] = cleanTranscript([
            turn("external", "the the deadline deadline is friday for the migration"),
        ]);
        expect(cleaned.text).toBe("the deadline is friday for the migration");
    });

    it("keeps short external speech but drops short user speech", () => {
        const cleaned = cleanTranscript([
            turn("external", "And you?"),
            turn("user", "And you?"),
        ]);
        expect(cleaned).toHaveLength(1);
        expect(cleaned[0].role).toBe("external");
    });

    it("preserves turn order", () => {
        const cleaned = cleanTranscript([
            turn("external", "what is the status of the migration project", 1),
            turn("user", "we are about halfway done with the migration", 2),
            turn("external", "when will the remaining half be finished", 3),
        ]);
        expect(cleaned.map((t) => t.timestamp)).toEqual([1, 2, 3]);
    });
});

describe("sparsifyTranscript", () => {
    it("returns input unchanged when under the limit", () => {
        const turns = [turn("user", "hello there", 1), turn("external", "hi", 2)];
        expect(sparsifyTranscript(turns, 12)).toEqual(turns);
    });

    it("prioritizes recent external turns over user turns when over the limit", () => {
        const turns: TranscriptTurn[] = [];
        for (let i = 0; i < 10; i++) turns.push(turn("external", `external statement number ${i}`, i));
        for (let i = 10; i < 20; i++) turns.push(turn("user", `user statement number ${i}`, i));

        const result = sparsifyTranscript(turns, 8);
        expect(result).toHaveLength(8);
        // The 6 most recent external turns survive
        const externalKept = result.filter((t) => t.role === "external");
        expect(externalKept).toHaveLength(6);
        expect(externalKept.map((t) => t.timestamp)).toEqual([4, 5, 6, 7, 8, 9]);
    });

    it("returns turns sorted by timestamp", () => {
        const turns: TranscriptTurn[] = [];
        for (let i = 0; i < 30; i++) {
            turns.push(turn(i % 2 === 0 ? "external" : "user", `statement number ${i}`, i));
        }
        const result = sparsifyTranscript(turns, 10);
        const timestamps = result.map((t) => t.timestamp);
        expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    });
});

describe("prepareTranscriptForWhatToAnswer", () => {
    it("labels roles as CONTEXT / ME / ASSISTANT", () => {
        const formatted = prepareTranscriptForWhatToAnswer([
            turn("external", "what is your estimate for the api rewrite", 1),
            turn("user", "roughly three weeks including the integration tests", 2),
            turn("assistant", "mention the dependency on the auth service migration", 3),
        ]);
        expect(formatted).toContain("[CONTEXT]: what is your estimate for the api rewrite");
        expect(formatted).toContain("[ME]: roughly three weeks including the integration tests");
        expect(formatted).toContain("[ASSISTANT]:");
    });

    it("produces an empty string for filler-only input", () => {
        expect(prepareTranscriptForWhatToAnswer([turn("user", "um okay yeah")])).toBe("");
    });
});
