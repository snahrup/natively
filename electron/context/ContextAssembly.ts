import { ContextRetrievalResult, PromptContextAssembly } from "./types";

export function buildPromptContextAssembly(result: ContextRetrievalResult): PromptContextAssembly {
  return {
    situation: result.situation,
    confidence: result.confidence,
    evidence: result.documents.slice(0, 6).map((doc) => ({
      sourceType: doc.sourceType,
      title: doc.title,
      excerpt: doc.excerpt,
      provenance: buildProvenance(doc),
    })),
  };
}

export function buildPromptContextBlock(result: ContextRetrievalResult): string {
  if (result.documents.length === 0) return "";
  const assembly = buildPromptContextAssembly(result);

  const evidenceLines = assembly.evidence
    .map((evidence) => `- [${evidence.sourceType}] ${evidence.title} (${evidence.provenance})\n  ${evidence.excerpt}`)
    .join("\n");

  return [
    "## Ranked Context",
    `Confidence: ${assembly.confidence}`,
    `Situation: ${assembly.situation}`,
    "Evidence:",
    evidenceLines,
  ].join("\n");
}

function buildProvenance(doc: ContextRetrievalResult["documents"][number]): string {
  if (doc.relatedMeetingIds?.[0]) return `meeting ${doc.relatedMeetingIds[0]}`;
  if (doc.relatedCalendarEventIds?.[0]) return `event ${doc.relatedCalendarEventIds[0]}`;
  return doc.sourceSystem;
}
