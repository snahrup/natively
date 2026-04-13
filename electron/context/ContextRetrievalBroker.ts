import {
  getCalendarDocuments,
  getEmailDocuments,
  getObservationDocuments,
  getProfileDocuments,
  getTeamsDocuments,
} from "./ContextSourceAdapters";
import {
  ContextDocument,
  ContextRetrievalRequest,
  ContextRetrievalResult,
  ContextScoreBreakdown,
  ScoredContextDocument,
} from "./types";
import { SemanticaBridgeService } from "../services/SemanticaBridgeService";

const TRUST_SCORES: Record<ContextDocument["trustTier"], number> = {
  authoritative: 1,
  durable: 0.8,
  observed: 0.55,
};

const FRESHNESS_SCORES: Record<ContextDocument["freshnessClass"], number> = {
  live: 1,
  recent: 0.72,
  historical: 0.45,
};

export class ContextRetrievalBroker {
  private static instance: ContextRetrievalBroker;
  private knowledgeOrchestrator: any = null;

  static getInstance(): ContextRetrievalBroker {
    if (!ContextRetrievalBroker.instance) {
      ContextRetrievalBroker.instance = new ContextRetrievalBroker();
    }
    return ContextRetrievalBroker.instance;
  }

  setKnowledgeOrchestrator(orchestrator: any): void {
    this.knowledgeOrchestrator = orchestrator;
  }

  async retrieve(request: ContextRetrievalRequest): Promise<ContextRetrievalResult> {
    const query = request.query.trim();
    if (!query) {
      return {
        query,
        surface: request.surface,
        generatedAt: new Date().toISOString(),
        confidence: "low",
        situation: "No query was available to retrieve context.",
        documents: [],
      };
    }

    const [calendarDocs, emailDocs, teamsDocs] = await Promise.all([
      getCalendarDocuments(),
      getEmailDocuments(query),
      getTeamsDocuments(),
    ]);

    let semanticaDocs: ContextDocument[] = [];
    try {
      semanticaDocs = await SemanticaBridgeService.getInstance().queryMeetingContext({
        query,
        activeMeetingId: request.activeMeetingId,
        participantHints: request.participantHints,
        limit: request.surface === "prep" ? 14 : 10,
        surface: request.surface,
      });
    } catch (error) {
      console.warn("[ContextRetrievalBroker] Semantica query failed:", error);
    }

    const candidates = dedupeDocuments([
      ...getObservationDocuments(request.maxAgeMs),
      ...calendarDocs,
      ...emailDocs,
      ...teamsDocs,
      ...getProfileDocuments(this.knowledgeOrchestrator),
      ...semanticaDocs,
    ]);

    const filtered = candidates.filter((doc) => {
      if (request.includeSourceTypes?.length && !request.includeSourceTypes.includes(doc.sourceType)) return false;
      if (request.excludeSourceTypes?.length && request.excludeSourceTypes.includes(doc.sourceType)) return false;
      if (request.maxAgeMs && isOlderThan(doc, request.maxAgeMs)) return false;
      return true;
    });

    const scored = filtered
      .map((doc) => this.scoreDocument(doc, request))
      .filter((doc) => doc.finalScore > 0.12)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, request.limit ?? 10);

    return {
      query,
      surface: request.surface,
      generatedAt: new Date().toISOString(),
      confidence: computeConfidence(scored),
      situation: buildSituation(scored, request),
      documents: scored,
    };
  }

  private scoreDocument(doc: ContextDocument, request: ContextRetrievalRequest): ScoredContextDocument {
    const queryTerms = tokenize([request.query, ...(request.participantHints || [])].join(" "));
    const docTerms = doc.lexicalTerms?.length ? doc.lexicalTerms : tokenize(`${doc.title} ${doc.body}`);
    const lexical = overlapRatio(queryTerms, docTerms);
    const source = clamp(doc.sourceScore ?? 0.35, 0, 1);
    const participant = overlapRatio(
      tokenize((request.participantHints || []).join(" ")),
      tokenize((doc.participants || []).join(" "))
    );
    const freshness = FRESHNESS_SCORES[doc.freshnessClass] ?? 0.45;
    const trust = TRUST_SCORES[doc.trustTier] ?? 0.6;
    const focus = this.computeFocusBoost(doc, request);
    const penalty = computePenalty(doc);

    const finalScore =
      0.35 * lexical +
      0.2 * source +
      0.15 * participant +
      0.1 * freshness +
      0.1 * trust +
      0.1 * focus -
      penalty;

    const scoreBreakdown: ContextScoreBreakdown = {
      lexical,
      source,
      participant,
      freshness,
      trust,
      focus,
      penalty,
    };

    return {
      ...doc,
      excerpt: buildExcerpt(doc.body),
      finalScore: clamp(finalScore, 0, 1.5),
      scoreBreakdown,
    };
  }

  private computeFocusBoost(doc: ContextDocument, request: ContextRetrievalRequest): number {
    let boost = 0;
    if (request.activeMeetingId && doc.relatedMeetingIds?.includes(request.activeMeetingId)) {
      boost += 1;
    }
    if (request.activeCalendarEventId && doc.relatedCalendarEventIds?.includes(request.activeCalendarEventId)) {
      boost += 1;
    }
    if (request.surface === "prep" && doc.sourceType === "calendar_event") {
      boost += 0.5;
    }
    if (request.surface === "meeting" && (doc.sourceType === "live_transcript" || doc.sourceType === "ocr_observation")) {
      boost += 0.45;
    }
    return clamp(boost, 0, 1);
  }
}

function dedupeDocuments(documents: ContextDocument[]): ContextDocument[] {
  const seen = new Map<string, ContextDocument>();
  for (const doc of documents) {
    const key = `${doc.sourceType}:${doc.title}:${doc.body.slice(0, 180)}`;
    const existing = seen.get(key);
    if (!existing || (doc.sourceScore ?? 0) > (existing.sourceScore ?? 0)) {
      seen.set(key, doc);
    }
  }
  return [...seen.values()];
}

function buildSituation(scored: ScoredContextDocument[], request: ContextRetrievalRequest): string {
  if (scored.length === 0) {
    return request.surface === "prep"
      ? "No strong prep context was found, so the packet should stay lightweight."
      : "No strong supporting context was found for this request.";
  }

  const top = scored[0];
  if (request.surface === "prep") {
    return `Prep context is anchored by ${top.title} and ${Math.max(0, scored.length - 1)} additional ranked sources.`;
  }
  if (request.surface === "meeting") {
    return `Live guidance should be grounded in ${top.title} plus the freshest transcript and screen evidence.`;
  }
  if (request.surface === "proactive") {
    return `The proactive nudge should be based on ${top.title} and nearby supporting evidence.`;
  }
  return `Reactive answer should rely on ${top.title} and the next strongest supporting records.`;
}

function computeConfidence(scored: ScoredContextDocument[]): ContextRetrievalResult["confidence"] {
  const top = scored[0]?.finalScore ?? 0;
  if (top >= 0.78) return "high";
  if (top >= 0.45) return "medium";
  return "low";
}

function computePenalty(doc: ContextDocument): number {
  const superseded = Boolean(doc.metadata?.superseded);
  return superseded ? 0.4 : 0;
}

function buildExcerpt(body: string, maxChars = 220): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9@.]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const matches = left.reduce((count, term) => count + (rightSet.has(term) ? 1 : 0), 0);
  return clamp(matches / left.length, 0, 1);
}

function isOlderThan(doc: ContextDocument, maxAgeMs: number): boolean {
  const createdAtMs = Date.parse(doc.updatedAt || doc.createdAt);
  return Number.isFinite(createdAtMs) && (Date.now() - createdAtMs) > maxAgeMs;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
