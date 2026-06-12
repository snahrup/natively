export type ContextSourceType =
  | "ocr_observation"
  | "meeting_transcript"
  | "meeting_summary"
  | "calendar_event"
  | "email_thread"
  | "teams_thread"
  | "profile_fact"
  | "task_or_commitment"
  | "manual_import"
  | "interaction"
  | "live_transcript"
  | "brain_prep_packet"
  | "cortex_insight"
  | "action_proposal";

export type ContextTrustTier = "authoritative" | "durable" | "observed";
export type ContextVisibility = "private" | "workspace" | "external";
export type ContextFreshnessClass = "live" | "recent" | "historical";
export type ContextSurface = "reactive" | "proactive" | "prep" | "meeting";
export type ContextConfidence = "low" | "medium" | "high";

export interface ContextDocument {
  id: string;
  sourceType: ContextSourceType;
  sourceSystem: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  eventTimeStart?: string;
  eventTimeEnd?: string;
  participants?: string[];
  entities?: string[];
  relatedMeetingIds?: string[];
  relatedCalendarEventIds?: string[];
  trustTier: ContextTrustTier;
  visibility: ContextVisibility;
  freshnessClass: ContextFreshnessClass;
  lexicalTerms?: string[];
  sourceScore?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextRetrievalRequest {
  query: string;
  surface: ContextSurface;
  activeMeetingId?: string;
  activeCalendarEventId?: string;
  participantHints?: string[];
  includeSourceTypes?: ContextSourceType[];
  excludeSourceTypes?: ContextSourceType[];
  limit?: number;
  maxAgeMs?: number;
  includeLiveMicrosoftSources?: boolean;
  includeSemantica?: boolean;
}

export interface ContextScoreBreakdown {
  lexical: number;
  source: number;
  participant: number;
  freshness: number;
  trust: number;
  focus: number;
  penalty: number;
}

export interface ScoredContextDocument extends ContextDocument {
  excerpt: string;
  finalScore: number;
  scoreBreakdown: ContextScoreBreakdown;
}

export interface ContextRetrievalResult {
  query: string;
  surface: ContextSurface;
  generatedAt: string;
  confidence: ContextConfidence;
  situation: string;
  documents: ScoredContextDocument[];
}

export interface PromptContextAssembly {
  situation: string;
  confidence: ContextConfidence;
  evidence: Array<{
    sourceType: ContextSourceType;
    title: string;
    excerpt: string;
    provenance: string;
  }>;
}
