# Semantica + Natively Afternoon Packets

Date: 2026-04-12

## Decision

We are not going to keep polishing Natively as its own long-term context substrate.

Target architecture:

- `Semantica` becomes the canonical context and knowledge layer.
- `Natively` remains the capture, workflow, meeting, and operator UI surface.
- The cross-source analysis experience adopts the useful parts of Vesti's frontend:
  - `Library`
  - `Explore`
  - `Network`
- All model execution remains local-command-first:
  - `Claude` via local Claude command / Agent SDK command flow
  - `ChatGPT` via Codex CLI command flow
- No traditional API-key model path remains part of the intended runtime architecture.

## What Vesti Actually Gets Right

After reviewing Vesti's sidepanel, search service, dashboard shell, and `vesti-ui` package, the parts worth adopting are structural and workflow-oriented, not extension-specific.

Patterns to adopt:

- A durable `Library / Explore / Network` split for cross-source work.
- Saved exploration sessions instead of one-off search boxes.
- Planner-routed exploration with an inspectable execution drawer:
  - plan
  - tool calls
  - sources
  - context draft
- Search scope controls so the user can query all context or a selected subset.
- Source-backed answers that are inspectable after generation.
- A temporal network view that makes cross-thread relationships legible.

Patterns to avoid copying:

- Vesti's extension storage model as canonical truth.
- Vesti's API-key-oriented LLM settings.
- Vesti's Notion-heavy settings footprint.
- Any implementation detail that assumes browser-extension-only capture.

## UI Direction

This repo does not currently define `.interface-design/system.md`, so the direction for the new exploration surface should be derived explicitly instead of defaulting to a generic dashboard.

Intent:

- Human: an operator trying to understand how meetings, chats, decisions, tasks, and upcoming events connect across sources.
- Task: inspect evidence, trace continuity, ask cross-source questions, verify provenance, and decide what matters next.
- Feel: calm, analytical, inspectable, and high-trust.

Domain concepts:

- dossier
- evidence lane
- provenance trail
- case file
- briefing workspace
- network replay
- session workspace
- source authority

Signature:

- The exploration surface should feel like a living case file: narrow question in the middle, inspectable reasoning and sources on the side, and temporal/network continuity available without leaving the product.

## Current Natively Seams

Current runtime seams that will be progressively re-homed behind Semantica:

- [electron/main.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/main.ts)
- [electron/rag/RAGManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/rag/RAGManager.ts)
- [electron/services/MeetingMemoryBrain.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingMemoryBrain.ts)
- [electron/services/MeetingOverviewService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingOverviewService.ts)
- [electron/services/MeetingPrepService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingPrepService.ts)
- [src/components/Launcher.tsx](/c:/Users/snahrup/CascadeProjects/natively/src/components/Launcher.tsx)
- [src/components/MeetingDetails.tsx](/c:/Users/snahrup/CascadeProjects/natively/src/components/MeetingDetails.tsx)

Meaning:

- Natively already has the right surfaces.
- The substrate responsibilities need to move behind a Semantica bridge.
- The UI should not be blocked on a total rewrite.

## Packet List

Each packet is a bounded implementation slice with a success gate.

### Packet 0: Local-Only Contract And Freeze

Goal:

- Freeze the architecture around local-command model execution and stop adding new in-app substrate logic on the old path.

Deliverables:

- Formalize `Semantica canonical / Natively UI` in docs and runtime notes.
- Mark old substrate modules as adapter targets instead of expansion points.
- Remove or wall off any new work that would deepen API-key-oriented retrieval/orchestration paths.

Primary touchpoints:

- [electron/main.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/main.ts)
- [electron/ProcessingHelper.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/ProcessingHelper.ts)
- [docs/architecture/context-source-authority.md](/c:/Users/snahrup/CascadeProjects/natively/docs/architecture/context-source-authority.md)

Success gate:

- No new planned runtime depends on direct API-key provider access for model calls.

### Packet 1: Semantica Sidecar Foundation

Goal:

- Stand up a local Semantica sidecar with persistent storage outside the packaged app path.

Deliverables:

- Local Python environment and Semantica install under a repo-owned sidecar folder.
- Sidecar bootstrap script for dev.
- Persistent app-data storage path, not install-path storage.
- Health check endpoint or equivalent readiness command.
- Clear separation between:
  - Semantica graph storage
  - raw source artifact storage
  - bridge logs

Recommended shape:

- `sidecars/semantica/`
- `scripts/start-semantica-dev.ps1`
- `%APPDATA%\\natively\\semantica\\...`

Success gate:

- Semantica can start locally, persist data, and survive app restarts and future `.exe` upgrades.

### Packet 2: Canonical Entity And Provenance Model

Goal:

- Define the shared model that all ingestors and retrieval flows will write into.

Core entities:

- meetings
- meeting turns / transcript segments
- participants
- documents / artifacts
- calendar events
- sessions
- facts
- decisions
- commitments
- contradictions
- entities
- relationships / edges
- provenance records

Rules:

- Every extracted fact must keep source provenance.
- Every derived node must point back to raw source spans or source artifacts.
- Source authority remains inspectable, not implicit.

Success gate:

- We can ingest one meeting and later explain where every synthesized statement came from.

### Packet 3: Natively Meeting Backfill And Live Mirror

Goal:

- Make Semantica aware of the meetings Natively already stores, then keep it updated.

Deliverables:

- One-shot backfill from the roaming Natively database.
- Mapping from existing meeting model to canonical Semantica entities.
- Incremental mirror path from meeting import/save/update flows.
- Transcript, summary, artifacts, usage, and upcoming-event references included in provenance.

Primary touchpoints:

- [electron/db/DatabaseManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/db/DatabaseManager.ts)
- [electron/MeetingPersistence.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/MeetingPersistence.ts)
- [electron/services/MeetingImportService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingImportService.ts)

Success gate:

- Current local meetings exist in Semantica with stable IDs and queryable provenance.

### Packet 4: Semantica Retrieval Bridge For Existing Natively Surfaces

Goal:

- Put Semantica behind the surfaces that already matter before building new UI.

First consumers:

- meeting overview generation
- meeting prep packets
- agent action planning
- context injection debug surfaces

Primary touchpoints:

- [electron/services/MeetingOverviewService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingOverviewService.ts)
- [electron/services/MeetingPrepService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingPrepService.ts)
- [electron/services/AgentActionPlanner.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/AgentActionPlanner.ts)

Implementation rule:

- Keep the UI contracts stable where possible.
- Replace the retrieval substrate behind them first.

Success gate:

- At least one existing user-facing flow is retrieving context from Semantica instead of the old Natively-owned stack.

### Packet 5: Vesti-Inspired Explore Workspace In Natively

Goal:

- Create the cross-source operator experience that the current Natively app is missing.

Structure to build:

- `Library`
- `Explore`
- `Network`

Explore requirements:

- saved exploration sessions
- source scope chooser
- source-backed answers
- execution drawer with:
  - plan
  - tool calls
  - sources
  - context draft
- ability to open the backing meeting/session/source from a result

Important note:

- We should borrow Vesti's interaction model, not its extension-specific assumptions or settings model.

Likely UI touchpoints:

- [src/components/Launcher.tsx](/c:/Users/snahrup/CascadeProjects/natively/src/components/Launcher.tsx)
- new `src/components/explore/*`

Success gate:

- Natively can run a saved cross-source exploration session with inspectable sources and context.

### Packet 6: Network And Continuity View

Goal:

- Add a graph surface that explains cross-source continuity instead of forcing the user to infer it from search results.

Requirements:

- temporal playback or timeline-aware graph state
- edge thresholding
- click-through node details
- provenance visibility for each edge
- mixed node types:
  - meeting
  - event
  - session
  - decision
  - commitment

Vesti feature to emulate:

- temporal network replay, not a static blob of nodes.

Success gate:

- We can visually explain why two meetings or sessions are related and which source evidence created the edge.

### Packet 7: External Context Ingestors

Goal:

- Bring the real context endpoints into the substrate instead of depending on manual exports forever.

Priority ingestors:

- Claude Code sessions
- Codex sessions
- Vesti local knowledge capture
- Natively meetings
- Notion migration-only backfill

Rules:

- Notion is treated as a migration source, not a future source of truth.
- Vesti is treated as a capture source and exploration reference, not canonical truth.
- All ingestors write into the same canonical entity and provenance model.

Success gate:

- At least one non-Natively source is searchable and linked inside Semantica-backed exploration.

### Packet 8: Agent Context Testing Harness

Goal:

- Get to the point where we can tune agent/model behavior against Semantica-fed context without doing the work twice.

Requirements:

- snapshot of the exact context injected into each agent/model turn
- source list attached to the turn
- provenance summary for why each context item was selected
- replayable evaluation prompts
- side-by-side comparison of old path versus Semantica path where needed

Success gate:

- We can ask a fixed set of evaluation prompts and inspect what Semantica fed into the answer path.

## Execution Order For This Afternoon

This is the recommended implementation order, not just a dependency list.

1. Packet 0
2. Packet 1
3. Packet 2
4. Packet 3
5. Packet 4
6. Packet 8
7. Packet 5
8. Packet 6
9. Packet 7

Reason:

- We need the substrate, data model, and first retrieval bridge in place before deep QA.
- We need the testing harness before tuning behavior.
- We should not build the full Explore surface on top of the wrong substrate.

## Minimum End-Of-Day Target

To call the afternoon successful, all of this should be true:

- Semantica sidecar runs locally and persists outside the packaged app path.
- Existing Natively meetings are backfilled or mirrored into Semantica.
- One real Natively retrieval flow is using Semantica.
- Agent-context inspection shows what Semantica supplied.
- A first Explore workspace skeleton exists in Natively with saved sessions and source inspection.

If time remains after that:

- Build the first Network surface.
- Add the first external session ingestor beyond Natively meetings.

## What We Are Explicitly Not Doing First

- We are not polishing the old Natively-only retrieval stack further.
- We are not making Natively the forever system of record.
- We are not treating Notion as a long-term dependency.
- We are not designing a graph page with no provenance model behind it.
- We are not adding any new API-key model flows to make Semantica easier to stand up.

## Recommendation

Approve this plan and treat the rest of the afternoon as a substrate-first pivot.

That gives us the best chance of getting to meaningful agent-response and action-behavior testing without redoing the same work on the wrong architecture.
