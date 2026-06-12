import type { Meeting } from "../db/DatabaseManager";
import type { ContextDocument } from "../context/types";
import { SemanticaSidecarManager, type SemanticaSidecarRuntimeStatus } from "./SemanticaSidecarManager";

interface RawSemanticaStatus {
  status: string;
  semanticaRoot?: string;
  stateDir?: string;
  dbPath?: string;
  graphPath?: string;
  recordCount?: number;
  meetingCount?: number;
  nodeCount?: number;
  edgeCount?: number;
  generatedAt?: string;
}

interface RawSemanticaQueryResult {
  id: string;
  meetingId: string;
  sourceType: ContextDocument["sourceType"];
  sourceSystem: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  participants?: string[];
  relatedMeetingIds?: string[];
  freshnessClass?: ContextDocument["freshnessClass"];
  trustTier?: ContextDocument["trustTier"];
  visibility?: ContextDocument["visibility"];
  sourceScore?: number;
  lexicalTerms?: string[];
  entities?: string[];
  metadata?: Record<string, unknown>;
}

export interface SemanticaBridgeStatus {
  available: boolean;
  ready: boolean;
  runtime: SemanticaSidecarRuntimeStatus;
  sidecar: RawSemanticaStatus | null;
  error?: string | null;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export class SemanticaBridgeService {
  private static instance: SemanticaBridgeService;

  public static getInstance(): SemanticaBridgeService {
    if (!SemanticaBridgeService.instance) {
      SemanticaBridgeService.instance = new SemanticaBridgeService();
    }
    return SemanticaBridgeService.instance;
  }

  public async ensureReady(): Promise<void> {
    await SemanticaSidecarManager.getInstance().ensureRunning();
  }

  public async getStatus(options?: { startIfNeeded?: boolean }): Promise<SemanticaBridgeStatus> {
    const startIfNeeded = options?.startIfNeeded !== false;
    if (startIfNeeded) {
      try {
        await this.ensureReady();
      } catch (error: any) {
        const runtime = await SemanticaSidecarManager.getInstance().getRuntimeStatus();
        return {
          available: false,
          ready: false,
          runtime,
          sidecar: null,
          error: error?.message || "Semantica sidecar unavailable.",
        };
      }
    }

    const runtime = await SemanticaSidecarManager.getInstance().getRuntimeStatus();
    try {
      const sidecar = await this.requestJson<RawSemanticaStatus>("/api/status", {
        method: "GET",
      }, { startIfNeeded: false });
      return {
        available: true,
        ready: runtime.healthy,
        runtime,
        sidecar,
        error: null,
      };
    } catch (error: any) {
      return {
        available: false,
        ready: false,
        runtime,
        sidecar: null,
        error: error?.message || "Failed to read Semantica status.",
      };
    }
  }

  public async upsertMeeting(meeting: Meeting): Promise<void> {
    await this.requestJson("/api/meetings/upsert", {
      method: "POST",
      body: JSON.stringify(this.serializeMeeting(meeting)),
    });
  }

  public async bulkUpsertMeetings(meetings: Meeting[]): Promise<number> {
    if (meetings.length === 0) return 0;

    let synced = 0;
    for (const batch of chunk(meetings, 30)) {
      const response = await this.requestJson<{ count?: number }>("/api/meetings/bulk-upsert", {
        method: "POST",
        body: JSON.stringify({
          meetings: batch.map((meeting) => this.serializeMeeting(meeting)),
        }),
      });
      synced += response.count ?? batch.length;
    }

    return synced;
  }

  public async deleteMeeting(meetingId: string): Promise<void> {
    await this.requestJson("/api/meetings/delete", {
      method: "POST",
      body: JSON.stringify({ meetingId }),
    });
  }

  public async queryMeetingContext(input: {
    query: string;
    activeMeetingId?: string;
    participantHints?: string[];
    limit?: number;
    surface?: string;
    startIfNeeded?: boolean;
    timeoutMs?: number;
  }): Promise<ContextDocument[]> {
    const response = await this.requestJson<{ results?: RawSemanticaQueryResult[] }>("/api/query/meetings", {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        activeMeetingId: input.activeMeetingId,
        participantHints: input.participantHints ?? [],
        limit: input.limit ?? 10,
        surface: input.surface ?? "reactive",
      }),
    }, {
      startIfNeeded: input.startIfNeeded,
      timeoutMs: input.timeoutMs,
    });

    return (response.results || []).map((result) => ({
      id: result.id,
      sourceType: result.sourceType,
      sourceSystem: result.sourceSystem || "semantica",
      title: result.title,
      body: result.body,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt || result.createdAt,
      participants: result.participants || [],
      entities: result.entities || [],
      relatedMeetingIds: result.relatedMeetingIds || (result.meetingId ? [result.meetingId] : []),
      trustTier: result.trustTier || "durable",
      visibility: result.visibility || "private",
      freshnessClass: result.freshnessClass || "historical",
      lexicalTerms: result.lexicalTerms || [],
      sourceScore: result.sourceScore ?? 0.55,
      metadata: {
        ...(result.metadata || {}),
        semanticaManaged: true,
      },
    }));
  }

  private serializeMeeting(meeting: Meeting): Meeting {
    return {
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      duration: meeting.duration,
      summary: meeting.summary,
      detailedSummary: meeting.detailedSummary,
      transcript: meeting.transcript || [],
      usage: meeting.usage || [],
      importMetadata: meeting.importMetadata,
      calendarEventId: meeting.calendarEventId,
      source: meeting.source,
      isProcessed: meeting.isProcessed,
    };
  }

  private async requestJson<T = any>(
    endpoint: string,
    init: RequestInit,
    options?: { startIfNeeded?: boolean; timeoutMs?: number }
  ): Promise<T> {
    if (options?.startIfNeeded !== false) {
      await this.ensureReady();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 15_000);

    try {
      const response = await fetch(`${SemanticaSidecarManager.getInstance().getBaseUrl()}${endpoint}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers || {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Semantica request failed (${response.status}): ${body || response.statusText}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
