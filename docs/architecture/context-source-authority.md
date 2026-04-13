# Context Source Authority

Last updated: 2026-04-12

## Decision

Natively is the authoritative context engine.

ClawMem is not treated as a required live source of truth for meeting guidance, prep assembly, or prompt-time context injection.

## Why

ClawMem is currently not reliable enough to serve as the single authority:

- the live Windows service was previously observed running against a different vault path than the user-profile vault with actual session rows
- the running service corpus was dominated by imported markdown extracts rather than current Natively runtime context
- Natively was still pointed at legacy ClawMem API assumptions that did not line up with the live server state
- even when auxiliary tools are down, Natively still needs to continue delivering guidance from its own durable store and structured local sources

That combination makes ClawMem unsafe as a primary source for real-time context injection.

## Authoritative Order

### Tier 1. Natively-Owned Durable Memory

- Natively meeting records
- transcripts
- summaries
- usage logs
- commitments
- contradictions
- imported Cluely history
- imported Teams history
- background reference documents
- any promoted durable observations

Tier 1 is the default truth source for prep, memory recall, and historical grounding.

### Tier 2. Structured Live Local Sources

- Outlook Desktop email and calendar
- Teams Desktop messages and meeting-adjacent signals
- current meeting/session state
- model/provider runtime state when needed for operational debugging

Tier 2 can outrank stale Tier 1 artifacts when the question is explicitly about current live state.

### Tier 3. Ephemeral Live Observations

- OCR screen observations
- live transcript segments
- current chat interaction turns
- transient UI state

Tier 3 is highly useful for "what is on my screen right now" or "what is happening in this meeting right now," but it should not silently become durable truth without promotion.

### Tier 4. Optional Secondary Enrichment

- Nexus / Conductor session bus
- ClawMem
- future MCP-connected systems

Tier 4 may enrich retrieval, but it must not override Tier 1 or Tier 2 unless the product explicitly declares a new authority policy.

## Same-Meeting Conflict Resolution

When more than one source represents the same meeting, apply this precedence unless a future source-specific rule overrides it:

1. Teams transcript / recording-derived transcript
2. Native Natively-captured transcript
3. Cluely transcript
4. Manually pasted transcript without structured provenance
5. OCR-derived transcript fragments

For summaries:

1. User-curated or explicitly approved summary
2. Teams recap/summary
3. Natively generated summary tied to durable meeting evidence
4. Cluely summary
5. Freeform pasted notes

For usage / assistant interaction logs:

1. Native Natively interaction log
2. Cluely usage log
3. Manual pasted usage log

## Operational Rules

### Rule 1. Do Not Block Core Product Behavior On ClawMem Health

Meeting AI, prep packets, context assembly, and import flows must continue even if ClawMem, Nexus, or Conductor is unavailable.

### Rule 2. Do Not Report Success Without Durable Persistence

If SQLite is unavailable, imports and other persistence-dependent flows must fail loudly rather than silently succeed.

### Rule 3. OCR Should Influence, Not Dominate

OCR can influence live assistance, but it should not overrule stronger structured or durable evidence unless the request is explicitly about visible on-screen state.

### Rule 4. Internal Analysis Jobs Must Stay Narrow

Background contradiction detection or cleanup jobs should default to the local meeting/job evidence they are processing and not pull broad mailbox/calendar context unless explicitly requested.

## Re-entry Criteria For ClawMem

ClawMem can only be reconsidered as an authoritative source if all of the following are true:

1. one deterministic vault path on Windows
2. one live service using that same vault
3. verified ingestion coverage for Claude Code, Codex, and Natively sessions
4. API contracts aligned with what Natively actually calls
5. source provenance and freshness verified in practice
6. clear evidence that it improves retrieval quality instead of introducing ambiguity

Until then, Natively owns the context engine.
