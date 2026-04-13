import type { LLMHelper } from "../LLMHelper";
import type { RAGManager } from "../rag/RAGManager";
import { MicrosoftLocalManager } from "./MicrosoftLocalManager";
import { MeetingImportService, type MeetingImportResult } from "./MeetingImportService";

export interface TeamsImportCandidate {
  chatId: string;
  meetingTitle: string;
  date?: string;
  hasTranscript: boolean;
}

export interface TeamsImportRunResult extends MeetingImportResult {
  attemptedChats: number;
  discoveredCandidates: number;
}

export class TeamsMeetingImportService {
  async discoverCandidates(limit = 12): Promise<TeamsImportCandidate[]> {
    const candidates = await MicrosoftLocalManager.getInstance().getTeamsBridge().listMeetingTranscripts();
    return candidates
      .filter((candidate) => candidate.hasTranscript)
      .slice(0, limit)
      .map((candidate) => ({
        chatId: candidate.chatId,
        meetingTitle: candidate.meetingTitle,
        date: candidate.date,
        hasTranscript: candidate.hasTranscript,
      }));
  }

  async importRecentCandidates(
    deps: { llmHelper: LLMHelper; ragManager?: RAGManager | null },
    options?: { limit?: number; chatIds?: string[] }
  ): Promise<TeamsImportRunResult> {
    const candidates = await this.discoverCandidates(options?.limit ?? 8);
    const filtered = options?.chatIds?.length
      ? candidates.filter((candidate) => options.chatIds!.includes(candidate.chatId))
      : candidates;

    const artifacts: Array<{
      inputType: "text";
      name: string;
      content: string;
      kind: "transcript";
      sourceFormat: "teams";
      meetingTitle: string;
      meetingDate?: string;
    }> = [];
    const skippedArtifacts: Array<{ name: string; reason: string }> = [];

    for (const candidate of filtered) {
      const transcriptResult = await MicrosoftLocalManager.getInstance()
        .getTeamsBridge()
        .getMeetingTranscript(candidate.meetingTitle);

      if (!transcriptResult.success || !transcriptResult.transcript?.trim()) {
        skippedArtifacts.push({
          name: candidate.meetingTitle,
          reason: transcriptResult.error || "Transcript was not available in Teams.",
        });
        continue;
      }

      artifacts.push({
        inputType: "text",
        name: `teams-${candidate.meetingTitle}-transcript.txt`,
        content: transcriptResult.transcript,
        kind: "transcript",
        sourceFormat: "teams",
        meetingTitle: transcriptResult.meetingTitle || candidate.meetingTitle,
        meetingDate: candidate.date,
      });
    }

    if (artifacts.length === 0) {
      return {
        importedMeetings: [],
        skippedArtifacts,
        totalArtifacts: filtered.length,
        attemptedChats: filtered.length,
        discoveredCandidates: candidates.length,
      };
    }

    const importResult = await new MeetingImportService().importArtifacts(artifacts, deps);
    return {
      ...importResult,
      skippedArtifacts: [...skippedArtifacts, ...importResult.skippedArtifacts],
      totalArtifacts: filtered.length,
      attemptedChats: filtered.length,
      discoveredCandidates: candidates.length,
    };
  }
}
