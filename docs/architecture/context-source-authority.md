# Context Source Authority

Last updated: 2026-05-12

## Decision

The IP Corp architecture brain repo is the authoritative context source for IP Corp meeting guidance and Cortex-style intelligence.

Natively is the local touchpoint. It reads prepared brain read models, displays guidance, captures decisions/outcomes, and executes explicitly approved actions. It is not the canonical analyzer, crawler, or prompt-time live-source aggregator.

## Why

The previous direction let too many systems compete for authority:

- Semantica was briefly treated as a canonical substrate, but the project moved toward `ipcorp-architecture-brain` as the durable working memory.
- Teams, Outlook, Notion, Cluely, and transcripts are already being consolidated by external/background processes before Natively needs them.
- Live widget-time calls to Microsoft or other source systems slow the app down and create unpredictable behavior.
- The long-term product objective is a learning operating model: every observation, proposal, approval, rejection, edit, and outcome should feed durable improvement over time.

That makes the brain repo the right source of truth, and Natively the right interaction layer.

## Authoritative Order

### Tier 1. IP Corp Brain Read Models

- `natively/status.json`
- `natively/meeting-index.json`
- `natively/prep-packets/*.packet.json`
- `natively/cortex/latest-run.json`
- `natively/cortex/insights/*.json`
- `natively/action-proposals/*.json`
- `natively/outcomes/*.jsonl`

Tier 1 is the default truth source for prep, memory recall, historical grounding, Cortex-style observations, and action cards.

### Tier 2. Natively Session State

- current meeting/session state
- current chat interaction turns
- microphone transcript fragments
- explicit user-entered notes
- model/provider runtime state for operational debugging

Tier 2 can support current interaction ergonomics, but it must not silently become IP Corp durable truth without promotion through the brain pipeline.

### Tier 3. Ephemeral Live Observations

- OCR screen observations
- live transcript segments
- transient UI state

Tier 3 is useful for "what is on my screen right now" or "what is happening in this meeting right now," but it is not authoritative.

### Tier 4. Approved Action Execution

- send approved email draft
- send approved Teams message
- create approved calendar event
- write approved task/note/follow-up artifact

Tier 4 is write-side only. It must not be used as a context-reading path during widget use.

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

### Rule 1. Do Not Block Core Product Behavior On Live Source Health

Meeting AI, prep packets, context assembly, and action proposal display must continue even if Teams, Outlook, Notion, Cluely, Semantica, Nexus, or Conductor is unavailable.

### Rule 2. Do Not Report Success Without Durable Persistence

If SQLite is unavailable, imports and other persistence-dependent flows must fail loudly rather than silently succeed.

### Rule 3. OCR Should Influence, Not Dominate

OCR can influence live assistance, but it should not overrule stronger structured or durable evidence unless the request is explicitly about visible on-screen state.

### Rule 4. Widget-Time Context Must Be Brain-First

During widget use, prep and chat retrieval should read the brain repo first. Live Microsoft, Notion, Cluely, and Semantica calls are not allowed for context gathering.

### Rule 5. Approved Writes Are Not Context Gathering

Natively may touch Outlook, Teams, or calendar APIs only after Steve approves a visible action proposal. Those calls execute the approved action; they do not gather context.

### Rule 6. Outcome Feedback Is Product Data

Every approval, rejection, edit, snooze, override, and execution outcome should become durable learning signal in the brain repo. The system cannot earn autonomy without that ledger.

## Re-entry Criteria For Any Secondary Context System

Any secondary context system can only be reconsidered as authoritative if all of the following are true:

1. one deterministic vault path on Windows
2. one live service using that same vault
3. verified ingestion coverage for Claude Code, Codex, and Natively sessions
4. API contracts aligned with what Natively actually calls
5. source provenance and freshness verified in practice
6. clear evidence that it improves retrieval quality instead of introducing ambiguity

Until then, the IP Corp architecture brain owns context authority and Natively reads from it.
