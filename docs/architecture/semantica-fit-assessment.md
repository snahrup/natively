# Semantica Fit Assessment For Natively

Last updated: 2026-04-12

## Decision Summary

Semantica is a strong candidate for the canonical knowledge and context substrate behind Natively.

It should not replace Natively as the user-facing desktop product.

Instead:

- Semantica should own the durable semantic layer
- Natively should remain the capture, review, and operator UI
- Vesti, Claude Code, Codex, Outlook, Teams, and future sources should feed Semantica through explicit ingestors
- Notion should become a migration source and optional publishing/archive sink, not the canonical store

## Why This Assessment Exists

The current product direction still treats Natively as both:

1. the operator interface
2. the canonical context engine

That coupling is useful for velocity but structurally wrong for long-term durability.

The user's actual requirement is not "a better memory feature" or "a nicer context app".

The real requirement is:

- one durable context layer
- one provenance model
- one retrieval substrate
- one place where contradictory facts can be normalized instead of duplicated across tools
- one system that survives UI migrations

## Current Natively Shape

Natively already contains a large amount of the right product behavior:

- live capture
- meeting UI
- imported history
- local Outlook and Teams actions
- prep packet generation
- retrieval broker
- durable local meeting store
- chunked retrieval and RAG indexing
- contradiction tracking

The problem is that these capabilities currently live inside the app's own local runtime spine:

- `DatabaseManager`
- `MeetingMemoryBrain`
- `RAGManager`
- `ContextRetrievalBroker`
- `KnowledgeOrchestrator`

This makes Natively both the application and the substrate.

That is why it keeps drifting toward "single source of truth by accident".

## What Semantica Appears To Be

Based on the current public repo and docs, Semantica is much closer to the required infrastructure layer than the other tools under consideration.

Its published emphasis is:

- context graphs
- decision intelligence
- provenance and auditability
- conflict detection and entity resolution
- reasoning engines
- temporal reasoning
- graph plus vector retrieval
- persistent graph backends
- ingestion from many source types

This is the correct layer of the stack.

It is not primarily presenting itself as a polished end-user productivity app.

That is not a flaw for this use case.

## Fit Against The Actual Requirement

### 1. Single Durable Context Substrate

Fit: strong

Semantica is explicitly designed to sit underneath existing agent and workflow systems rather than replace them.

That aligns with the need to stop rebuilding the same context layer inside each frontend or tool shell.

### 2. Multi-Source Ingestion

Fit: strong

Semantica appears designed for heterogeneous ingestion and custom ingestors.

That matters because the target source set is not generic:

- Natively meetings and live observations
- Claude Code sessions
- Codex sessions
- Vesti web-chat captures
- Outlook and Teams evidence
- local files and exports
- one-time Notion extraction

### 3. Provenance And Explainability

Fit: strong

This is one of Semantica's clearest advantages over lightweight memory systems.

The desired system needs to answer:

- where did this fact come from
- when was it true
- what superseded it
- why was it retrieved

That is substrate behavior, not UI polish.

### 4. Conflict Handling

Fit: strong

The user's context sources naturally conflict:

- Cluely vs Teams vs manual summaries
- live screen OCR vs durable source records
- older notes vs newer meetings
- web-portal chats vs local sessions

Semantica's conflict-resolution posture is much closer to the actual problem than flat embedding stores.

### 5. Temporal Context

Fit: strong

The user's workflows are strongly temporal:

- meeting history
- evolving project decisions
- superseded assumptions
- upcoming meeting preparation

Temporal retrieval and point-in-time reconstruction are important, not optional.

### 6. Portability And Future Migration Safety

Fit: strong if implemented correctly

This is one of the main reasons to take Semantica seriously.

If the semantic layer becomes canonical and the UX apps become consumers, the user can replace Natively later without splitting memory again.

## Where Semantica Does Not Solve The Problem Alone

### 1. It Is Not The Finished Product UI

Semantica does not appear to be the daily destination interface the user wants to live in.

That is fine.

The destination experience can remain:

- Natively for operator workflows
- backend inspection UI from the chosen graph backend
- optional specialized admin/audit views later

### 2. It Is Still Comfortable With API-Key-Oriented Defaults

This is the biggest architectural caution.

The docs and examples are still friendly to:

- OpenAI-style keys
- LiteLLM provider switching
- generic hosted-model patterns

That is not compatible with the user's desired contract unless a wrapper policy is enforced.

Required rule:

- Semantica may own storage, retrieval, graph logic, provenance, and reasoning
- Natively must keep owning model execution policy
- model execution should remain local-command-first for Claude and Codex
- embeddings should default to local providers where possible

### 3. TypeScript / Electron To Python Boundary

Natively is currently an Electron/TypeScript app.

Semantica is a Python framework.

That means the clean path is not "import Semantica directly into Electron".

The correct path is a boundary:

- local Semantica sidecar service
- explicit ingestion API
- explicit retrieval API
- explicit provenance graph API

## Recommended Target Architecture

### Canonical Roles

- Semantica: canonical semantic memory and decision/provenance substrate
- Natively: capture, meeting UX, review, operator controls, and action execution
- Vesti: capture feeder for web AI portals
- Claude Code and Codex: session feeders
- Notion: migration source only, then optional export/archive surface

### Source Of Truth Model

Semantica should become the canonical store for:

- entities
- meetings
- sessions
- artifacts
- decisions
- commitments
- contradictions
- source provenance
- temporal validity
- retrieval-ready semantic relationships

Natively should retain only:

- UI state
- local UX caches
- transient runtime state
- action execution state
- possibly a thin local fallback cache for resilience

### Storage Pattern

Canonical storage should be split into:

1. Raw evidence store
   - transcripts
   - markdown
   - OCR snapshots
   - chat exports
   - session logs
   - source JSON payloads

2. Semantic layer
   - graph entities and relationships
   - provenance edges
   - temporal facts
   - decision chains
   - contradiction states
   - retrieval metadata

3. App cache
   - whatever Natively needs for fast local rendering and offline resilience

### Recommended Backend Posture

Do not rely on an in-memory development backend for the canonical layer.

Use a persistent graph backend from day one for real ownership.

The right decision should prioritize:

- local single-user reliability
- inspectability
- exportability
- low migration risk

Practical options:

- Neo4j if inspectability and mature browser/admin tooling matter most
- FalkorDB if lighter-weight local graph operation becomes preferable

If the graph backend exposes a good inspection surface, Semantica itself does not need to be the pretty UI.

That directly addresses the "why is there no flashy UI in the README" concern.

## What Stays In Natively

Natively should keep:

- meeting details UI
- meeting prep UI
- context hub
- imported meeting review
- Outlook and Teams local bridges
- local live transcript and OCR capture
- user-facing explainability surfaces
- model selection and local-only execution policy
- action proposal and execution UX

These are product behaviors, not substrate responsibilities.

## What Should Move Behind Semantica

The following Natively-owned responsibilities should move or be progressively re-homed behind a Semantica adapter:

- `MeetingMemoryBrain`
- long-term canonical retrieval corpus
- contradiction persistence model
- promoted observation storage
- durable cross-source entity linking
- precedent and decision-chain logic
- canonical provenance graph
- long-horizon context retrieval

The current `RAGManager`, `ContextRetrievalBroker`, and `KnowledgeOrchestrator` should become more adapter-like over time rather than acting as the final knowledge substrate themselves.

## Recommended Ingestion Adapters

### 1. Natively Adapter

Ingest:

- meetings
- summaries
- transcripts
- key points
- action items
- imported historical artifacts
- OCR snapshots once promoted
- chat debug and interaction traces where appropriate

### 2. Claude Code Session Adapter

Ingest:

- session metadata
- prompts
- responses
- tool-use summaries
- codebase decisions
- generated plans
- durable findings

### 3. Codex Session Adapter

Ingest the same class of artifacts as Claude Code sessions so both coding surfaces land in one comparable substrate.

### 4. Vesti Adapter

Ingest:

- captured web AI chats
- timestamps
- source portal/model metadata
- extracted decisions and facts
- linked references when available

### 5. Notion Migration Adapter

Use once for:

- meetings
- transcript pages
- feed/history pages
- explicitly curated records worth preserving

Then de-emphasize Notion operationally.

## Notion Recommendation

Notion should not remain the canonical memory layer.

It is useful for:

- historical extraction
- optional publishing
- optional human-readable archive

It is weak as the long-term system substrate for this use case because it does not want to be:

- the canonical provenance graph
- the contradiction engine
- the context retrieval substrate
- the durable decision intelligence layer

Once the historical value is extracted, it can become optional.

## Local-Only Policy Required For This Architecture

This architecture only makes sense if the model policy remains strict.

Required rules:

- no traditional API-key model path in the user-facing runtime contract
- Claude execution through the local Claude command / agent path
- ChatGPT execution through Codex CLI
- embeddings default to local providers where possible
- Semantica is not allowed to silently become the place where hosted-model assumptions creep back in

If that rule is violated, the substrate will drift toward the same failure pattern as previous systems.

## Main Risks

### Risk 1. Building Another Island

If Semantica is added alongside Natively instead of becoming canonical, this just creates one more context island.

### Risk 2. Weak Identity And Provenance Discipline

If the ingestion layer does not enforce canonical IDs and provenance links, the graph will become a more sophisticated duplicate pile.

### Risk 3. Python Sidecar Neglect

If the Semantica sidecar becomes fragile, unmonitored, or optional, Natively will quietly retake substrate responsibilities and the architecture will regress.

### Risk 4. UI Expectations

If the user expects Semantica itself to become the polished daily UI, disappointment is likely.

That should not be the goal.

## Final Recommendation

Proceed with Semantica as the most promising backbone candidate currently identified.

Do not adopt it as "the next app".

Adopt it as:

- the canonical context substrate
- the provenance and decision layer
- the long-term memory graph
- the system that outlives Natively, Notion, Vesti, or any single frontend

## Immediate Next Steps

1. Define the canonical entity model for the first production slice
   - meeting
   - person
   - organization
   - system
   - decision
   - commitment
   - artifact
   - session

2. Stand up a local Semantica proof-of-fit sidecar
   - persistent graph backend
   - local-only embedding and model policy
   - explicit ingest and query endpoints

3. Implement only one ingestion slice first
   - Natively meeting history and live meeting records

4. Verify three queries before expanding
   - "what decisions already exist about this topic"
   - "what changed since the last related meeting"
   - "why was this retrieved and what sources support it"

5. Add session feeders next
   - Claude Code
   - Codex
   - Vesti

6. Use Notion only as a controlled migration source

If those steps work cleanly, Semantica is likely the right backbone.

If they do not, stop before more context is migrated.
