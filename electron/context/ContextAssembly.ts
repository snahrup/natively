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
  const base = doc.relatedMeetingIds?.[0]
    ? `meeting ${doc.relatedMeetingIds[0]}`
    : doc.relatedCalendarEventIds?.[0]
      ? `event ${doc.relatedCalendarEventIds[0]}`
      : doc.sourceSystem;
  // Observations carry their actual age so a "Live screen observation" from
  // hours ago cannot be mistaken for the current screen.
  const age = formatAge(doc.updatedAt || doc.createdAt);
  return age ? `${base}, ${age}` : base;
}

function formatAge(iso: string | undefined): string | null {
  if (!iso) return null;
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
