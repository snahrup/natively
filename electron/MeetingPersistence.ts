// MeetingPersistence.ts
// Handles meeting lifecycle: stop, save, and recovery.
// Extracted from IntelligenceManager to decouple DB operations from LLM orchestration.

import { SessionTracker, TranscriptSegment } from './SessionTracker';
import { LLMHelper } from './LLMHelper';
import { DatabaseManager, Meeting } from './db/DatabaseManager';
import { GROQ_SUMMARY_JSON_PROMPT } from './llm';
import { ContradictionDetector } from './services/ContradictionDetector';
import { NotebookLmMeetingArtifactService } from './services/NotebookLmMeetingArtifactService';
import { buildMeetingAnalysisContext, cleanTranscriptForAnalysis } from './services/TranscriptCleanupService';
import { reconstructTranscriptWithCodex } from './services/TranscriptReconstructionService';
import { generateMeetingTitleWithCodex, isPlaceholderMeetingTitle } from './services/MeetingTitleService';
const crypto = require('crypto');

const TRANSCRIPT_FLUSH_INTERVAL_MS = 15_000;

export class MeetingPersistence {
    private session: SessionTracker;
    private llmHelper: LLMHelper;

    // Incremental persistence: meeting row is created at START and transcript
    // segments are flushed to SQLite on a timer, so a crash/quit mid-meeting
    // loses at most one flush interval of transcript instead of everything.
    private activeMeetingId: string | null = null;
    private activeMeetingStartTime: number = 0;
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(session: SessionTracker, llmHelper: LLMHelper) {
        this.session = session;
        this.llmHelper = llmHelper;
    }

    /**
     * Called at meeting START: generates the meetingId, writes the meeting row
     * immediately (is_processed=0), and starts the incremental transcript flush.
     * Failure is non-fatal — stopMeeting() falls back to generating a fresh
     * UUID at stop (the pre-incremental behavior).
     */
    public startMeeting(metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null): string | null {
        this.stopFlushTimer();
        const meetingId = crypto.randomUUID();
        const startTime = Date.now();
        try {
            DatabaseManager.getInstance().createMeetingShell({
                id: meetingId,
                // "Live meeting" is recognized by isPlaceholderMeetingTitle, so
                // recovery and title generation both treat it as replaceable.
                title: metadata?.title && !isPlaceholderMeetingTitle(metadata.title) ? metadata.title : 'Live meeting',
                startTimeMs: startTime,
                calendarEventId: metadata?.calendarEventId,
                source: metadata?.source,
            });
        } catch (e) {
            console.error('[MeetingPersistence] Failed to create meeting row at start — incremental persistence disabled for this meeting:', e);
            // Clear any id left over from a previous meeting so a quit-flush
            // cannot write this session's segments into an old meeting row.
            this.activeMeetingId = null;
            return null;
        }
        this.activeMeetingId = meetingId;
        this.activeMeetingStartTime = startTime;
        this.flushTimer = setInterval(() => this.flushPendingSegments(), TRANSCRIPT_FLUSH_INTERVAL_MS);
        this.flushTimer.unref?.();
        console.log(`[MeetingPersistence] Meeting ${meetingId} persisted at start; incremental flush every ${TRANSCRIPT_FLUSH_INTERVAL_MS / 1000}s`);
        return meetingId;
    }

    /**
     * Flush transcript segments that have not yet been written to SQLite.
     * Synchronous (better-sqlite3), so it is also safe to call from the
     * app's before-quit handler via flushActiveMeeting().
     */
    private flushPendingSegments(): void {
        if (!this.activeMeetingId) return;
        const pending = this.session.getUnflushedSegments();
        if (pending.length === 0) return;
        try {
            const db = DatabaseManager.getInstance();
            db.appendTranscriptSegments(
                this.activeMeetingId,
                pending.map(s => ({ speaker: s.speaker, text: s.text, timestamp: s.timestamp }))
            );
            this.session.markSegmentsFlushed(pending.length);
            db.updateMeetingDuration(this.activeMeetingId, Date.now() - this.activeMeetingStartTime);
        } catch (e) {
            // Segments stay unflushed and are retried next interval; the final
            // saveMeeting() rewrites all rows anyway, so this is never fatal.
            console.warn('[MeetingPersistence] Incremental transcript flush failed (will retry):', e);
        }
    }

    /**
     * Force-persist everything pending for the active meeting (interim segment
     * included). Called from the before-quit handler.
     */
    public flushActiveMeeting(): void {
        if (!this.activeMeetingId) return;
        this.session.flushInterimTranscript();
        this.flushPendingSegments();
    }

    private stopFlushTimer(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(): Promise<string | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        this.stopFlushTimer();
        const startedMeetingId = this.activeMeetingId;
        this.activeMeetingId = null;

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        const durationMs = Date.now() - this.session.getSessionStartTime();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
            // Remove the shell row created at start — it holds nothing.
            if (startedMeetingId) {
                try { DatabaseManager.getInstance().deleteMeeting(startedMeetingId); } catch { /* non-fatal */ }
            }
            this.session.reset();
            return null;
        }

        const snapshot = {
            transcript: [...this.session.getFullTranscript()],
            usage: [...this.session.getFullUsage()],
            startTime: this.session.getSessionStartTime(),
            durationMs: durationMs,
            context: this.session.getFullSessionContext()
        };

        // BUG-04 fix: snapshot metadata BEFORE reset() clears it so the
        // background processAndSaveMeeting worker receives the calendar info.
        const metadataSnapshot = this.session.getMeetingMetadata();

        // 2. Reset state immediately so new meeting can start or UI is clean
        this.session.reset();

        // Reuse the id created at meeting start so the final save lands on the
        // incrementally-persisted row; fall back to a fresh UUID if the start
        // row could not be created.
        const meetingId = startedMeetingId ?? crypto.randomUUID();
        this.processAndSaveMeeting(snapshot, meetingId, metadataSnapshot).catch(err => {
            console.error('[MeetingPersistence] Background processing failed:', err);
        });

        // 4. Initial Save (Placeholder)
        const minutes = Math.floor(durationMs / 60000);
        const seconds = ((durationMs % 60000) / 1000).toFixed(0);
        const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

        const placeholder: Meeting = {
            id: meetingId,
            title: "Processing...",
            date: new Date().toISOString(),
            duration: durationStr,
            summary: "Generating summary...",
            detailedSummary: { actionItems: [], keyPoints: [] },
            transcript: snapshot.transcript,
            usage: snapshot.usage,
            isProcessed: false
        };

        try {
            DatabaseManager.getInstance().saveMeeting(placeholder, snapshot.startTime, durationMs);
            // Notify Frontend
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));
        } catch (e) {
            console.error("Failed to save placeholder", e);
        }

        return meetingId;
    }

    /**
     * Heavy lifting: LLM Title, Summary, and DB Write
     */
    private async processAndSaveMeeting(
        data: { transcript: TranscriptSegment[], usage: any[], startTime: number, durationMs: number, context: string },
        meetingId: string,
        // BUG-04 fix: accept metadata snapshot so calendar info is not lost after session.reset()
        metadata?: { title?: string; calendarEventId?: string; source?: 'manual' | 'calendar' } | null
    ): Promise<void> {
        let title = "Untitled Session";
        let summaryData: { actionItems: string[], keyPoints: string[], overview?: string, transcriptCleanup?: any, reconstructedTranscript?: any } = { actionItems: [], keyPoints: [] };

        // Use passed-in metadata snapshot (NOT this.session.getMeetingMetadata() which is already cleared)
        let calendarEventId: string | undefined;
        let source: 'manual' | 'calendar' = 'manual';

        if (metadata) {
            if (metadata.title && !isPlaceholderMeetingTitle(metadata.title)) title = metadata.title;
            if (metadata.calendarEventId) calendarEventId = metadata.calendarEventId;
            if (metadata.source) source = metadata.source;
        }

        const cleanedTranscript = cleanTranscriptForAnalysis(data.transcript, { maxChars: 28_000 });
        summaryData.transcriptCleanup = {
            rawSegments: cleanedTranscript.stats.rawSegments,
            cleanTurns: cleanedTranscript.stats.cleanTurns,
            rawCharacters: cleanedTranscript.stats.rawCharacters,
            cleanCharacters: cleanedTranscript.stats.cleanCharacters,
            compressionRatio: cleanedTranscript.stats.compressionRatio,
            generatedAt: new Date().toISOString(),
            strategy: "merge-same-speaker-filter-filler-analysis-context",
        };
        const durationForAnalysis = `${Math.floor(data.durationMs / 60000)}:${Number(((data.durationMs % 60000) / 1000).toFixed(0)) < 10 ? '0' : ''}${((data.durationMs % 60000) / 1000).toFixed(0)}`;
        const analysisDate = new Date(data.startTime || Date.now()).toISOString();
        const reconstructionSeedMeeting = {
            title,
            date: analysisDate,
            duration: durationForAnalysis,
            summary: "",
            detailedSummary: { actionItems: [] as string[], keyPoints: [] as string[] },
            transcript: data.transcript,
        };

        if (cleanedTranscript.turns.length > 1) {
            try {
                const reconstruction = await reconstructTranscriptWithCodex(this.llmHelper, reconstructionSeedMeeting);
                if (reconstruction) {
                    summaryData.reconstructedTranscript = reconstruction;
                }
            } catch (error) {
                console.warn('[MeetingPersistence] Transcript reconstruction failed; using cleaned transcript fallback:', error);
            }
        }

        const analysisMeeting = {
            ...reconstructionSeedMeeting,
            detailedSummary: {
                actionItems: [] as string[],
                keyPoints: [] as string[],
                reconstructedTranscript: summaryData.reconstructedTranscript,
            },
        };
        const analysisContext = buildMeetingAnalysisContext(analysisMeeting, { maxChars: 28_000 });

        try {
            // Generate title when there is no real calendar title, or the title is
            // still a placeholder such as "Untitled Session".
            if (isPlaceholderMeetingTitle(title)) {
                const generatedTitle = await generateMeetingTitleWithCodex(this.llmHelper, {
                    ...analysisMeeting,
                    title,
                });
                if (generatedTitle) title = generatedTitle;
            }

            // Generate Structured Summary
            if (cleanedTranscript.turns.length > 1) {
                const summaryPrompt = `You are a silent meeting summarizer. Convert this conversation into concise internal meeting notes.
    
    RULES:
    - Use the CLEANED TRANSCRIPT as the primary evidence
    - User-supplied context is authoritative when present
    - Do NOT invent information not present in the context
    - You MAY infer implied action items or next steps if they are logical consequences of the discussion
    - Do NOT explain or define concepts mentioned
    - Do NOT use filler phrases like "The meeting covered..." or "Discussed various..."
    - Do NOT mention transcripts, AI, or summaries
    - Do NOT sound like an AI assistant
    - Sound like a senior PM's internal notes
    
    STYLE: Calm, neutral, professional, skim-friendly. Short bullets, no sub-bullets.
    
    Return ONLY valid JSON (no markdown code blocks):
    {
      "overview": "1-2 sentence description of what was discussed",
      "keyPoints": ["3-6 specific bullets - each = one concrete topic or point discussed"],
      "actionItems": ["specific next steps, assigned tasks, or implied follow-ups. If absolutely none found, return empty array"]
    }`;

                const groqSummaryPrompt = GROQ_SUMMARY_JSON_PROMPT;

                const generatedSummary = await this.llmHelper.generateMeetingSummary(summaryPrompt, analysisContext, groqSummaryPrompt);

                if (generatedSummary) {
                    const jsonMatch = generatedSummary.match(/```json\n([\s\S]*?)\n```/) || [null, generatedSummary];
                    const jsonStr = (jsonMatch[1] || generatedSummary).trim();
                    try {
                        summaryData = {
                            ...summaryData,
                            ...JSON.parse(jsonStr),
                        };
                    } catch (e) { console.error("Failed to parse summary JSON", e); }
                }
            } else {
                console.log("Cleaned transcript too short for summary generation.");
            }
        } catch (e) {
            console.error("Error generating meeting metadata", e);
        }

        try {
            const minutes = Math.floor(data.durationMs / 60000);
            const seconds = ((data.durationMs % 60000) / 1000).toFixed(0);
            const durationStr = `${minutes}:${Number(seconds) < 10 ? '0' : ''}${seconds}`;

            const meetingData: Meeting = {
                id: meetingId,
                title: title,
                date: new Date().toISOString(),
                duration: durationStr,
                summary: "See detailed summary",
                detailedSummary: summaryData,
                transcript: data.transcript,
                usage: data.usage,
                calendarEventId: calendarEventId,
                source: source,
                isProcessed: true
            };

            DatabaseManager.getInstance().saveMeeting(meetingData, data.startTime, data.durationMs);

            // Metadata was already snapshotted before session.reset() — nothing to clear here.

            // Run contradiction detection in the background (fire-and-forget)
            const fullTranscript = data.transcript.map(s => s.text ?? '').join('\n');
            ContradictionDetector.getInstance().processTranscript(meetingId, title, fullTranscript).catch(() => {});
            NotebookLmMeetingArtifactService.getInstance().queueMeetingInfographic(meetingData, data.durationMs);

            // Notify Frontend to refresh list
            const wins = require('electron').BrowserWindow.getAllWindows();
            wins.forEach((w: any) => w.webContents.send('meetings-updated'));

        } catch (error) {
            console.error('[MeetingPersistence] Failed to save meeting:', error);
        }
    }

    /**
     * Recover meetings that were started but not fully processed (e.g. app crash).
     *
     * Two modes:
     * - llmProcessing=false (default; always safe at startup): DATA-only recovery.
     *   The transcript is already in SQLite from the incremental flush — finalize
     *   the row (real title/duration, is_processed=1) with ZERO model calls.
     * - llmProcessing=true (behind NATIVELY_ENABLE_STARTUP_MEETING_RECOVERY):
     *   full reprocessing with title/summary generation, as before.
     */
    public async recoverUnprocessedMeetings(options?: { llmProcessing?: boolean }): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering (llmProcessing=${Boolean(options?.llmProcessing)})...`);

        if (!options?.llmProcessing) {
            this.recoverMeetingDataOnly(unprocessed.map(m => m.id));
            return;
        }

        for (const m of unprocessed) {
            try {
                const details = db.getMeetingDetails(m.id);
                if (!details) continue;

                console.log(`[MeetingPersistence] Recovering meeting ${m.id}...`);

                const context = details.transcript?.map(t => {
                    const label = t.speaker === 'external' ? 'CONTEXT' :
                        t.speaker === 'user' ? 'ME' : 'ASSISTANT';
                    return `[${label}]: ${t.text}`;
                }).join('\n') || "";

                const parts = (details.duration || '0:00').split(':');
                // EC-07 fix: guard against malformed duration strings (e.g. corrupted DB row)
                const mins = parseInt(parts[0]) || 0;
                const secs = parseInt(parts[1]) || 0;
                const durationMs = ((mins * 60) + secs) * 1000;
                const startTime = new Date(details.date).getTime();

                const snapshot = {
                    transcript: details.transcript as TranscriptSegment[],
                    usage: details.usage,
                    startTime: startTime,
                    durationMs: durationMs,
                    context: context
                };

                await this.processAndSaveMeeting(snapshot, m.id);
                console.log(`[MeetingPersistence] Recovered meeting ${m.id}`);

            } catch (e) {
                console.error(`[MeetingPersistence] Failed to recover meeting ${m.id}`, e);
            }
        }
    }

    /**
     * Finalize crashed meetings from their incrementally-flushed transcripts
     * without any model calls. Empty shells (no transcript rows) are deleted.
     */
    private recoverMeetingDataOnly(meetingIds: string[]): void {
        const db = DatabaseManager.getInstance();
        for (const id of meetingIds) {
            try {
                const details = db.getMeetingDetails(id);
                if (!details) continue;

                const transcript = details.transcript || [];
                if (transcript.length === 0) {
                    console.log(`[MeetingPersistence] Removing empty unprocessed meeting ${id} (no transcript rows)`);
                    db.deleteMeeting(id);
                    continue;
                }

                // Prefer last-segment timestamp over the (possibly stale) stored duration.
                const startTime = new Date(details.date).getTime();
                const lastTs = transcript[transcript.length - 1].timestamp;
                const parts = (details.duration || '0:00').split(':');
                const storedMs = (((parseInt(parts[0]) || 0) * 60) + (parseInt(parts[1]) || 0)) * 1000;
                const durationMs = Number.isFinite(startTime) && lastTs > startTime
                    ? lastTs - startTime
                    : storedMs;

                const title = isPlaceholderMeetingTitle(details.title)
                    ? 'Recovered meeting'
                    : details.title;

                db.markMeetingRecovered(id, { title, durationMs });
                console.log(`[MeetingPersistence] Recovered meeting data ${id} (${transcript.length} segments, no LLM calls)`);
            } catch (e) {
                console.error(`[MeetingPersistence] Failed data-only recovery for meeting ${id}`, e);
            }
        }
    }
}
