export type ReflexTranscriptSource = "interim" | "final";

export interface ReflexTranscriptFrame {
  speaker: "external" | "user" | string;
  speakerKey?: string;
  speakerLabel?: string;
  speakerIdentity?: "self" | "other" | "unknown";
  text: string;
  isFinal: boolean;
  confidence?: number;
  timestamp: number;
  meetingActive: boolean;
  manualVoiceCaptureActive: boolean;
  proactiveModeEnabled: boolean;
  liveCoachAvailable?: boolean;
}

export interface ReflexProactiveCandidate {
  text: string;
  confidence: number;
  source: ReflexTranscriptSource;
  reason: string;
}

export interface ReflexPipelineDecision {
  text: string;
  shouldRouteTranscript: boolean;
  routeToSession: boolean;
  routeToRag: boolean;
  captureToBrain: boolean;
  emitToUi: boolean;
  proactiveCandidate: ReflexProactiveCandidate | null;
}

export class RealtimeReflexPipeline {
  private lastProactiveAt = 0;
  private lastProactiveSignature: string | null = null;
  private lastProactiveKey: string | null = null;
  private lastProactiveKeyAt = 0;

  public ingestTranscriptFrame(frame: ReflexTranscriptFrame): ReflexPipelineDecision {
    const text = frame.text.replace(/\s+/g, " ").trim();
    const shouldRouteTranscript = Boolean(text) && (frame.meetingActive || frame.manualVoiceCaptureActive);
    const source: ReflexTranscriptSource = frame.isFinal ? "final" : "interim";

    const decision: ReflexPipelineDecision = {
      text,
      shouldRouteTranscript,
      routeToSession: shouldRouteTranscript && frame.meetingActive,
      routeToRag: shouldRouteTranscript && frame.meetingActive && frame.isFinal,
      captureToBrain: shouldRouteTranscript && frame.isFinal,
      emitToUi: shouldRouteTranscript,
      proactiveCandidate: null,
    };

    if (!shouldRouteTranscript || !frame.meetingActive) {
      return decision;
    }

    if (isSetupUtterance(text)) {
      return decision;
    }

    const canDriveProactiveCoach =
      frame.speaker === "external" ||
      (
        frame.proactiveModeEnabled &&
        frame.speaker === "user" &&
        frame.speakerIdentity !== "self" &&
        !frame.manualVoiceCaptureActive
      );

    if (!canDriveProactiveCoach) {
      return decision;
    }

    if (frame.liveCoachAvailable === false) {
      return decision;
    }

    if (!frame.isFinal && !frame.proactiveModeEnabled) {
      return decision;
    }

    const trigger = this.evaluateTrigger(text, source, frame.proactiveModeEnabled);
    if (!trigger.shouldTrigger) {
      return decision;
    }

    if (!this.reserveProactiveSlot(text, source, frame.proactiveModeEnabled)) {
      return decision;
    }

    decision.proactiveCandidate = {
      text,
      source,
      reason: trigger.reason,
      confidence: Math.max(
        frame.proactiveModeEnabled ? (source === "interim" ? 0.5 : 0.55) : 0.7,
        Math.min(1, frame.confidence || 0.8)
      ),
    };

    return decision;
  }

  private evaluateTrigger(
    text: string,
    source: ReflexTranscriptSource,
    proactiveModeEnabled: boolean
  ): { shouldTrigger: boolean; reason: string } {
    if (proactiveModeEnabled && source === "interim") {
      return this.evaluateInterimTrigger(text);
    }

    if (proactiveModeEnabled) {
      return this.evaluateAggressiveFinalTrigger(text);
    }

    return this.evaluateStandardTrigger(text);
  }

  private evaluateStandardTrigger(text: string): { shouldTrigger: boolean; reason: string } {
    if (text.length < 12 || text.length > 700) {
      return { shouldTrigger: false, reason: "length" };
    }

    const lower = text.toLowerCase();
    const questionLike =
      text.includes("?") ||
      /\b(what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you|does that make sense)\b/.test(lower);
    const ipCorpCue =
      /\b(ip corp|interplastic|molding products|fabric|purview|m3|mes|mdm|citrine|batch id|batch|lakehouse|warehouse|semantic model|power bi|source system|medallion|data product|governance)\b/.test(lower);
    const decisionCue =
      /\b(should we|can we|could we|would we|do we|how do we|what if|what about|recommend|approach|decision|risk|timeline|scope)\b/.test(lower);

    return {
      shouldTrigger: questionLike && (directedAtSteve || ipCorpCue || decisionCue),
      reason: "standard_question",
    };
  }

  private evaluateAggressiveFinalTrigger(text: string): { shouldTrigger: boolean; reason: string } {
    if (text.length < 10 || text.length > 900 || isAcknowledgement(text)) {
      return { shouldTrigger: false, reason: "length_or_ack" };
    }

    const lower = text.toLowerCase();
    const questionLike =
      text.includes("?") ||
      /\b(what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you|does that make sense)\b/.test(lower);
    const ipCorpCue =
      /\b(ip corp|interplastic|molding products|fabric|purview|m3|mes|mdm|citrine|batch id|batch|lakehouse|warehouse|semantic model|power bi|source system|medallion|data product|governance|steward|stewardship|policy|exception|ownership)\b/.test(lower);
    const decisionCue =
      /\b(should we|can we|could we|would we|do we|how do we|what if|what about|recommend|approach|decision|risk|timeline|scope|tradeoff|owner|approval|next step)\b/.test(lower);
    const actionCue =
      /\b(action item|follow up|blocker|dependency|deadline|commit|commitment|need from|walk away with|decide today|align on|proposal|recommendation)\b/.test(lower);

    return {
      shouldTrigger: questionLike || directedAtSteve || ipCorpCue || decisionCue || actionCue,
      reason: "aggressive_final",
    };
  }

  private evaluateInterimTrigger(text: string): { shouldTrigger: boolean; reason: string } {
    if (text.length < 28 || text.length > 700 || isAcknowledgement(text)) {
      return { shouldTrigger: false, reason: "length_or_ack" };
    }

    const lower = text.toLowerCase();
    const questionLike =
      text.includes("?") ||
      /\b(what|why|how|when|where|who|which|can|could|would|should)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you)\b/.test(lower);
    const explicitDecisionAsk =
      /\b(should we|what should|what would|how would|recommend|recommendation|need to decide|decision we need|decision do we|walk out with|decide today|align on|approval boundary|who owns|named owner)\b/.test(lower);
    const meetingDecisionCue =
      /\b(decision|owner|approval|recommend|risk|next step|follow up|policy|exception|steward)\b/.test(lower);

    return {
      shouldTrigger: directedAtSteve || explicitDecisionAsk || (questionLike && meetingDecisionCue),
      reason: "interim_reflex",
    };
  }

  private reserveProactiveSlot(
    text: string,
    source: ReflexTranscriptSource,
    proactiveModeEnabled: boolean
  ): boolean {
    const now = Date.now();
    const cooldownMs = source === "interim" && proactiveModeEnabled
      ? 12_000
      : proactiveModeEnabled
        ? 5_000
        : 18_000;

    if (now - this.lastProactiveAt < cooldownMs) {
      return false;
    }

    const signature = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(-180);
    if (signature && signature === this.lastProactiveSignature) {
      return false;
    }

    const key = buildProactiveKey(text);
    if (
      proactiveModeEnabled &&
      key &&
      this.lastProactiveKey &&
      now - this.lastProactiveKeyAt < 60_000 &&
      areKeysSimilar(key, this.lastProactiveKey)
    ) {
      return false;
    }

    this.lastProactiveAt = now;
    this.lastProactiveSignature = signature;
    if (key) {
      this.lastProactiveKey = key;
      this.lastProactiveKeyAt = now;
    }
    return true;
  }
}

function isSetupUtterance(text: string): boolean {
  const lower = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(hey )?(natively|native lee|native ly|nativeley)?\s*(can you hear me|do you hear me|are you listening|testing|test test|mic check|microphone check)\s*$/.test(lower);
}

function isAcknowledgement(text: string): boolean {
  return /^(yeah|yes|yep|ok|okay|right|sure|thanks|thank you|mmhmm|uh huh)[\s.!?]*$/i.test(text);
}

function buildProactiveKey(text: string): string {
  const stopWords = new Set([
    "about", "after", "again", "also", "because", "being", "could", "from", "have",
    "into", "just", "like", "make", "more", "need", "really", "should", "that",
    "their", "there", "these", "they", "this", "those", "what", "when", "where",
    "which", "with", "would", "your",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !stopWords.has(word))
    .slice(-36)
    .join(" ");
}

function areKeysSimilar(nextKey: string, previousKey: string): boolean {
  if (!nextKey || !previousKey) return false;
  if (nextKey.includes(previousKey) || previousKey.includes(nextKey)) return true;

  const nextTokens = new Set(nextKey.split(/\s+/).filter(Boolean));
  const previousTokens = new Set(previousKey.split(/\s+/).filter(Boolean));
  if (nextTokens.size < 4 || previousTokens.size < 4) return false;

  let overlap = 0;
  nextTokens.forEach((token) => {
    if (previousTokens.has(token)) {
      overlap += 1;
    }
  });

  return overlap / Math.min(nextTokens.size, previousTokens.size) >= 0.72;
}
