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

export class MeetingPersistence {
    private session: SessionTracker;
    private llmHelper: LLMHelper;

    constructor(session: SessionTracker, llmHelper: LLMHelper) {
        this.session = session;
        this.llmHelper = llmHelper;
    }

    /**
     * Stops the meeting immediately, snapshots data, and triggers background processing.
     * Returns immediately so UI can switch.
     */
    public async stopMeeting(): Promise<string | null> {
        console.log('[MeetingPersistence] Stopping meeting and queueing save...');

        // 0. Force-save any pending interim transcript
        this.session.flushInterimTranscript();

        // 1. Snapshot valid data BEFORE resetting
        const durationMs = Date.now() - this.session.getSessionStartTime();
        if (durationMs < 1000) {
            console.log("Meeting too short, ignoring.");
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

        const meetingId = crypto.randomUUID();
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
     * Recover meetings that were started but not fully processed (e.g. app crash)
     */
    public async recoverUnprocessedMeetings(): Promise<void> {
        console.log('[MeetingPersistence] Checking for unprocessed meetings...');
        const db = DatabaseManager.getInstance();
        const unprocessed = db.getUnprocessedMeetings();

        if (unprocessed.length === 0) {
            console.log('[MeetingPersistence] No unprocessed meetings found.');
            return;
        }

        console.log(`[MeetingPersistence] Found ${unprocessed.length} unprocessed meetings. recovering...`);

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
}
