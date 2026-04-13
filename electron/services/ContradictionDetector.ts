/**
 * ContradictionDetector
 *
 * Runs after every meeting ends. Extracts factual claims from the transcript,
 * compares them against the MeetingMemoryBrain knowledge base, detects
 * conflicts, and logs them to the `contradictions` table in SQLite.
 *
 * When a contradiction is detected the NEWER claim wins by default (most
 * recent meeting = ground truth), the old entry is marked superseded, and
 * both are preserved with their source meeting ID for full traceability.
 *
 * Pipeline (all LLM calls use the fastest available provider):
 *   1. Extract claims  → "What factual assertions does this transcript make?"
 *   2. Search brain    → Find prior knowledge that mentions the same entities
 *   3. Detect conflict → "Does claim X contradict prior fact Y?"
 *   4. Write DB        → contradictions table (resolved + superseded entries)
 *   5. Reload brain    → so future meetings start with updated ground truth
 */

import { MeetingMemoryBrain, MemorySearchHit } from "./MeetingMemoryBrain";
import { DatabaseManager } from "../db/DatabaseManager";

export interface Contradiction {
  id?: number;
  meetingId: string;
  meetingTitle: string;
  detectedAt: string;
  newClaim: string;
  priorFact: string;
  priorSource: string;       // file path or "meeting:<id>"
  resolution: "newer_wins" | "manual";
  notes: string;
}

export class ContradictionDetector {
  private static instance: ContradictionDetector;
  private llmHelper: any;   // LLMHelper — injected to avoid circular deps

  static getInstance(): ContradictionDetector {
    if (!ContradictionDetector.instance) {
      ContradictionDetector.instance = new ContradictionDetector();
    }
    return ContradictionDetector.instance;
  }

  /** Inject LLMHelper after app startup. */
  setLLMHelper(llmHelper: any): void {
    this.llmHelper = llmHelper;
  }

  /**
   * Main entry point — call after a meeting is processed and saved.
   * Safe to call without awaiting; runs entirely in background.
   */
  async processTranscript(
    meetingId: string,
    meetingTitle: string,
    transcriptText: string
  ): Promise<void> {
    if (!this.llmHelper || transcriptText.trim().length < 200) return;

    console.log(`[ContradictionDetector] Processing meeting: ${meetingTitle}`);

    try {
      // Step 1: Extract factual claims from the transcript
      const claims = await this.extractClaims(transcriptText);
      if (claims.length === 0) {
        console.log("[ContradictionDetector] No claims extracted, skipping");
        return;
      }

      console.log(`[ContradictionDetector] Extracted ${claims.length} claims`);

      // Step 2: For each claim, search the brain for related prior knowledge
      const brain = MeetingMemoryBrain.getInstance();
      const contradictions: Contradiction[] = [];

      for (const claim of claims) {
        const related = brain.searchEntries(claim, 5);
        if (related.length === 0) continue;

        // Step 3: Ask LLM if there's a contradiction
        const conflict = await this.detectConflict(claim, related);
        if (!conflict) continue;

        contradictions.push({
          meetingId,
          meetingTitle,
          detectedAt: new Date().toISOString(),
          newClaim: claim,
          priorFact: conflict.priorFact,
          priorSource: conflict.priorSource,
          resolution: "newer_wins",
          notes: conflict.explanation,
        });
      }

      if (contradictions.length === 0) {
        console.log("[ContradictionDetector] No contradictions found");
      } else {
        console.log(`[ContradictionDetector] Found ${contradictions.length} contradictions — persisting`);
        await this.persistContradictions(contradictions);
      }

      // Step 4: Reload brain so next meeting sees updated knowledge
      await brain.reload();

    } catch (err: any) {
      console.error("[ContradictionDetector] Processing failed:", err.message);
    }
  }

  /** Get all stored contradictions for display in the UI. */
  getAll(): Contradiction[] {
    try {
      const db = DatabaseManager.getInstance().getDb();
      return db.prepare(`
        SELECT * FROM contradictions ORDER BY detected_at DESC LIMIT 200
      `).all().map((r: any) => ({
        id: r.id,
        meetingId: r.meeting_id,
        meetingTitle: r.meeting_title,
        detectedAt: r.detected_at,
        newClaim: r.new_claim,
        priorFact: r.prior_fact,
        priorSource: r.prior_source,
        resolution: r.resolution,
        notes: r.notes,
      }));
    } catch {
      return [];
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async extractClaims(transcript: string): Promise<string[]> {
    const transcriptChunks = chunkForLlm(transcript, 12_000).slice(0, 6);
    const claims = new Map<string, string>();

    for (const chunk of transcriptChunks) {
      const prompt = `Extract all distinct factual claims, decisions, and assertions from the meeting transcript below.
Focus on:
- Decisions made ("we decided to...", "going forward we will...")
- Numbers, dates, deadlines, budget figures
- Names of people and their roles/responsibilities
- System names and their status
- Process changes ("from now on...", "we're replacing...", "the new approach is...")
- Commitments and action items

Return ONLY a JSON array of short claim strings (1-2 sentences each). Maximum 20 claims.
Example: ["The M3 migration target date is Q3 2026", "Sarah is now leading the Fabric workstream"]

TRANSCRIPT:
${chunk}

JSON:`;

      try {
        const raw = await this.llmHelper.chat(prompt, undefined, undefined, undefined, {
          ignoreKnowledgeMode: true,
          skipRetrievedContext: true,
        });
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) continue;
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) continue;

        for (const entry of parsed) {
          if (typeof entry !== "string") continue;
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase();
          if (!claims.has(key)) claims.set(key, trimmed);
          if (claims.size >= 20) break;
        }
      } catch {}

      if (claims.size >= 20) break;
    }

    return [...claims.values()];
  }

  private async detectConflict(
    newClaim: string,
    priorKnowledge: MemorySearchHit[]
  ): Promise<{ priorFact: string; priorSource: string; explanation: string } | null> {
    const relatedContext = priorKnowledge
      .map((hit, index) => {
        const snippet = hit.content.slice(0, 900);
        return `[${index + 1}]
Source: ${hit.source}
Title: ${hit.title}
Text: ${snippet}`;
      })
      .join("\n\n");

    const prompt = `You are a knowledge consistency checker.

NEW CLAIM (from a recent meeting):
"${newClaim}"

PRIOR KNOWLEDGE CANDIDATES (from the knowledge base or past meetings):
${relatedContext}

Does the new claim directly contradict any specific statement in the prior knowledge?
A contradiction means the two statements CANNOT both be true (e.g., different numbers, opposite decisions, conflicting ownership).

Respond with ONLY a JSON object:
- If contradiction: {"contradicts": true, "matchIndex": <candidate number>, "priorFact": "<the exact prior statement that conflicts>", "explanation": "<1 sentence why they conflict>"}
- If no contradiction: {"contradicts": false}

JSON:`;

    try {
      const raw = await this.llmHelper.chat(prompt, undefined, undefined, undefined, {
        ignoreKnowledgeMode: true,
        skipRetrievedContext: true,
      });
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]);
      if (!parsed.contradicts) return null;
      const matchIndex = Number(parsed.matchIndex);
      if (!Number.isInteger(matchIndex) || matchIndex < 1 || matchIndex > priorKnowledge.length) {
        return null;
      }
      const matched = priorKnowledge[matchIndex - 1];
      const priorFact = String(parsed.priorFact ?? "").trim();
      if (!priorFact) return null;
      return {
        priorFact,
        priorSource: matched.source,
        explanation: parsed.explanation ?? "",
      };
    } catch {
      return null;
    }
  }

  private async persistContradictions(items: Contradiction[]): Promise<void> {
    const db = DatabaseManager.getInstance().getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO contradictions
        (meeting_id, meeting_title, detected_at, new_claim, prior_fact, prior_source, resolution, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows: Contradiction[]) => {
      for (const r of rows) {
        stmt.run(
          r.meetingId, r.meetingTitle, r.detectedAt,
          r.newClaim, r.priorFact, r.priorSource,
          r.resolution, r.notes
        );
      }
    });

    insertMany(items);
  }
}

function chunkForLlm(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n", end);
      if (breakAt > start + Math.floor(maxChars / 2)) {
        end = breakAt;
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }

  return chunks.filter(Boolean);
}
