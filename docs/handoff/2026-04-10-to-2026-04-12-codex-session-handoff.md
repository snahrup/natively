# Natively Session Handoff

Last updated: 2026-04-12 11:29:47 AM -04:00

## Session Span

- User-declared start: 2026-04-10 10:54 PM EST
- Handoff snapshot: 2026-04-12 11:29:47 AM EDT
- Working branch state: dirty working tree with extensive in-progress product changes; do not assume only this session's edits are present

## Executive Summary

This session turned Natively from a partially re-skinned derivative product into a much more opinionated local-first context engine and meeting/workflow assistant. The work covered four broad areas:

1. Product repurposing and prompt/system-behavior realignment away from interview-assistant language and toward Steve-specific meeting, workflow, and proactive-assistance usage.
2. Construction and expansion of a shared context engine so OCR, transcript, chat, imported meetings, Outlook, Teams, calendar, and durable meeting memory can all participate in one retrieval path instead of feature-specific prompt stuffing.
3. Building and validating local Microsoft integrations plus historical import surfaces so the product can ingest prior context and execute real desktop actions through Outlook and Teams.
4. Debugging critical runtime failures, especially importer hangs and false-success imports caused by a dead dev SQLite path and Electron-native module mismatch.

The system is materially stronger than it was at session start, but the current handoff must be read with one important constraint in mind: some user-facing surfaces still need another validation pass under real use, especially screen-grounding consistency, provider/model routing consistency, and high-confidence historical Cluely ingestion.

## What Was Implemented

### 1. Product Direction Reset

- Removed or replaced large amounts of interview-assistant framing, labels, and prompts.
- Reoriented the app around:
  - proactive meeting coaching
  - ambient off-track correction
  - pre-meeting prep
  - workflow follow-up support
  - read-first communication assistance
- Began consolidating prompt behavior so in-meeting output should read like first-person speakable guidance while ambient/off-meeting output can speak directly to the user.
- Aggregated prompt inventories and reference prompt material from this repo and adjacent repos to inform future prompt replacement work.

### 2. Shared Context Engine Foundation

- Established a normalized context-document model and supporting architecture in `electron/context/`.
- Added or extended:
  - context observation storage for ephemeral OCR/transcript/chat artifacts
  - source adapters
  - retrieval broker
  - ranking logic spanning trust, freshness, lexical overlap, participant overlap, and source-specific boosts
- Moved the product direction away from ad hoc feature prompts toward:
  - one ingestion shape
  - one retrieval path
  - one assembly model
  - output-surface-specific rendering contracts

### 3. Durable Meeting Memory and Retrieval

- Expanded the SQLite-backed meeting memory layer so meeting summaries, transcripts, usage logs, contradictions, chunks, and retrieval metadata are persisted and retrievable from the same engine.
- Wired imported meetings into the same meeting memory path rather than creating a sidecar import-only store.
- Continued use of RAG/indexing infrastructure so imported and captured artifacts become available for prep packets, reactive chat, and live guidance.

### 4. Historical Ingestion and Import Surfaces

- Added a manual importer flow under Context Hub for pasted or file-based meeting artifacts.
- Supported source-aware import normalization for:
  - Cluely-style artifacts
  - Teams-style artifacts
  - generic manual imports
- Added and iterated on Cluely import work and Teams import work, with Teams positioned as the higher-authority transcript source when both systems cover the same meeting.
- Added an imported-meeting visibility surface in Context Hub so imported artifacts can be seen directly in the app instead of existing only implicitly in retrieval.

### 5. Microsoft Local Desktop Integrations

- Integrated Outlook Desktop through a local COM bridge for:
  - reading recent emails
  - searching mailbox content
  - drafting email
  - sending email
  - replying to email
  - reading contacts
  - reading calendar items
  - creating calendar events
- Integrated Teams Desktop through the local bridge path for:
  - reading local Teams threads/messages
  - sending Teams messages
- Added a dedicated Microsoft Actions panel for validation and controlled usage.
- Preserved the local-desktop strategy instead of shifting to Graph-first admin-approved integration, because the chosen product direction explicitly relies on locally controlled access paths.

### 6. Chat and Action-Surface Improvements

- Added or extended inline action proposal behavior so communications can be represented as editable action cards rather than raw markdown/tool dump output.
- Continued work toward cross-model review and more deliberate provider routing, though this area still needs further validation and is not fully closed out.
- Improved the UI direction around rendering versus exposing raw markdown/tool-call noise by default.

### 7. Context Visibility and Explainability

- Added a launcher/home surface for a Context Engine Overview so the app has a user-visible summary of what context exists, how fresh it is, and what recently landed.
- Added imported meeting history visibility inside Context Hub.
- Added or extended diagnostic visibility for chat logs, timestamps, and response timing so the app can be debugged against real usage rather than only terminal logs.

### 8. Skills / Workflow Support For Future Codex Sessions

- Recreated Codex-local skill mirrors for:
  - `interface-design`
  - `modernize`
- This was done so future Codex sessions can use the same named workflows consistently without relying on guesswork about the Claude originals.

## Major Decisions Made

### Natively Owns The Context Engine

ClawMem is not treated as the primary source of truth for live context assembly. It may remain a useful secondary enrichment source in the future, but Natively now owns the authoritative meeting/workflow context engine.

### Structured Sources Outrank OCR

OCR remains useful for live awareness, but structured systems such as Teams transcripts, Outlook calendar/email, imported meeting artifacts, and durable Natively meeting memory outrank visible-screen text.

### Teams Transcript Authority Beats Cluely Transcript Authority

When the same meeting is available from both sources, Teams should be treated as the transcript authority because its speaker attribution is stronger and more trustworthy. Cluely can still contribute summaries or usage logs where valuable.

### Import Success Must Mean Persistence Succeeded

The system should never report a successful import if SQLite persistence is unavailable. This decision became critical after the dev environment was found to be silently running with a dead DB path.

### Internal Background LLM Calls Must Not Drag In The Whole Retrieval Broker

Internal analysis jobs such as contradiction detection should not automatically invoke the same retrieved-context path as user chat. That caused importer hangs and irrelevant Outlook query activity.

### Dev And Installed Builds Should Converge On One Canonical Natively Data Store

When the canonical shared Natively store exists, dev should use it instead of creating a separate isolated `natively-dev` persistence path. The split made imports appear successful while nothing user-visible actually changed.

### Read / Review / Confirm Before Action Remains The Default

Even though desktop actions now exist, the architecture still prefers explicit user confirmation and visible action cards rather than background autonomous mutation.

## Major Issues Encountered And How They Were Resolved

### 1. Manual Importer Appeared To Hang Or Never Finish

Symptoms:

- Manual Cluely import looked stuck.
- Terminal logs showed contradiction detection and repeated Outlook search failures.
- The user did not get prompt, reliable confirmation.

Root cause:

- Post-import contradiction detection was running synchronously in the visible import path.
- Contradiction detection reused the general LLM chat pipeline.
- The general pipeline triggered retrieved context.
- Retrieved context triggered Outlook mailbox search.
- Outlook search used a brittle DASL restriction string that failed on prompt-shaped search text.

Fixes applied:

- Moved post-import contradiction detection and reprocessing into scheduled background work after visible import completion.
- Added `skipRetrievedContext` support to internal LLM calls.
- Updated contradiction detection to call the LLM with:
  - `ignoreKnowledgeMode: true`
  - `skipRetrievedContext: true`
- Replaced the broken DASL `Restrict("@SQL=...")` mailbox search approach with bounded token matching over recent inbox items.

Result:

- Manual import completion is no longer blocked by downstream enrichment.
- Internal analyzer jobs stop dragging Outlook search into import flow.
- Outlook local search is much more tolerant of real-world queries.

### 2. Imports Reported Success But Nothing Appeared In Natively

Symptoms:

- User imported full Cluely meetings.
- UI reported success.
- Imported meetings appeared nowhere in the launcher or Context Hub.

Root cause:

- The dev app was initializing against `AppData\\Roaming\\natively-dev\\natively.db`.
- `better-sqlite3` for Electron was broken there (`ERR_DLOPEN_FAILED`, invalid Win32 application).
- Database initialization failed at startup.
- The app continued running without SQLite-backed persistence.
- `saveMeeting()` silently no-op'd when `this.db` was unavailable.

Fixes applied:

- Rebuilt `better-sqlite3` for the current Electron runtime.
- Updated `DatabaseManager` to prefer the canonical `appData\\natively` database path when present.
- Changed `saveMeeting()` so it throws if persistence is unavailable.
- Updated `MeetingImportService` to fail fast if `DatabaseManager` is not ready.
- Added explicit imported-meeting visibility in Context Hub.

Result:

- Current dev runtime successfully initializes the canonical Natively DB.
- Future imports should not report success if persistence is broken.
- The user can inspect imported meetings directly in-app.

Important operational note:

- The earlier Cluely imports performed before this fix were false-success imports and were not persisted anywhere. They must be re-imported.

### 3. Outlook Search Parsing Failures

Symptoms:

- Repeated terminal errors:
  - `Outlook email search failed: Cannot parse condition`

Root cause:

- Outlook COM DASL restriction logic was too brittle for general text queries.

Fixes applied:

- Rewrote the local Outlook search script to do bounded token matching over recent items instead of composing a fragile DASL expression.

Result:

- The bridge works more reliably for local enrichment and future mailbox search surfaces.

### 4. Product Visibility Was Too Weak

Symptoms:

- User could not tell what actually existed in context.
- Imported records and context freshness were opaque.

Fixes applied:

- Added Context Engine Overview on the launcher/home surface.
- Added imported meeting history visibility in Context Hub.
- Added/improved chat diagnostic visibility with timestamps and response timing.

Result:

- The app is less of a black box.
- Debugging can now start from visible product state, not only terminal logs.

## Validations Performed

- `npx tsc --noEmit`
- `npm run build:electron`
- Outlook bridge script execution against the local Outlook session
- Electron dev startup verification
- Database initialization log verification after native-module rebuild
- Direct DB inspection to confirm the difference between the broken dev path and the canonical shared path

## Current Known State At Handoff

### Confirmed Working / Materially Improved

- Canonical SQLite initialization in the current dev runtime
- Manual import visible completion path
- Background post-import processing separation
- Outlook local search robustness
- Context Engine Overview surface
- Imported meeting history visibility surface
- Microsoft local action bridge architecture

### Still Open Or Needs Another Validation Pass

- Real-world screen-grounding consistency across all model/provider paths
- Provider/model routing consistency, especially local Claude/Codex expectations versus explicit API-key fallbacks
- Cluely historical one-click import reliability against the current Cluely desktop/runtime state
- Broader startup orchestration for Billboard / Conductor / Nexus / ClawMem and other supporting services
- Final polish of inline action cards and cross-model review workflow

## Recommended First Steps For The Next Codex Session

1. Re-import one known Cluely meeting and confirm it appears in:
   - Context Hub imported meeting history
   - launcher/context overview surfaces
   - meeting retrieval where applicable
2. Validate Teams import again and confirm authority/merge behavior versus Cluely for a duplicated meeting.
3. Continue model/provider routing cleanup so Claude and Codex paths rely on the intended local authenticated flows instead of accidental API-key requirements.
4. Run a focused screen-grounding/debug pass with logged screenshots, timestamps, model choice, and returned answer to isolate why different models sometimes appear to describe stale or wrong UI.
5. Revisit startup orchestration for companion services only after the context/import/runtime foundation is stable.

## Important Files To Review First Next Session

- `electron/db/DatabaseManager.ts`
- `electron/services/MeetingImportService.ts`
- `electron/services/ContradictionDetector.ts`
- `electron/LLMHelper.ts`
- `electron/services/outlook-bridge/search-emails.ps1`
- `src/components/Launcher.tsx`
- `src/components/settings/ContextHubSettings.tsx`
- `docs/architecture/context-engine-implementation-log.md`
- `docs/architecture/context-engine-target-state.md`
- `docs/architecture/context-source-authority.md`
- `docs/product/capability-register.md`
- `docs/product/feature-system-map.md`

## Nexus Note

The Nexus tool transport was unavailable during handoff generation (`Transport closed`). A condensed handoff summary should be posted once Nexus is reachable again.
