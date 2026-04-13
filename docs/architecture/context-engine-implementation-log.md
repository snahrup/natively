# Context Engine Implementation Log

Last updated: 2026-04-12 11:29:47 AM -04:00

## Session Span

- User-declared start: 2026-04-10 10:54 PM EST
- Documentation snapshot: 2026-04-12 11:29:47 AM EDT

## Scope Covered In This Working Session

- shared context document model
- source ingestion contracts
- OCR/chat/transcript observation capture
- retrieval broker and ranking behavior
- durable meeting memory expansion
- prep packet migration onto shared retrieval
- contradiction extraction and memory post-processing
- Outlook Desktop and Teams Desktop local bridges
- manual import surfaces and historical meeting ingestion
- launcher/context visibility improvements
- runtime persistence and importer reliability fixes

## Current State Summary

Natively now operates much closer to a coherent local-first context engine than it did at session start. The system has a normalized context model, a shared retrieval broker, durable meeting storage, import flows for historical artifacts, local Microsoft desktop integrations, and user-visible context surfaces in both the launcher and Context Hub.

The biggest architectural correction during this session was stopping the product from pretending imports succeeded when SQLite persistence was unavailable in dev. The second biggest correction was breaking the accidental coupling between internal contradiction analysis and the general retrieved-context chat path.

## Progress Notes By Phase

### Phase 1. Shared Context Foundation

- Shared context-document model, observation store, source adapters, and retrieval broker were established and extended under `electron/context/`.
- OCR observations, live transcript segments, and Natively chat interactions were normalized as context artifacts instead of living only in side-channel prompt text.
- Retrieval behavior moved toward one broker with one ranking policy instead of feature-specific prompt stuffing.
- Prep packets were refactored to use the shared retrieval path rather than custom overlap heuristics.

### Phase 2. Durable Meeting Memory

- SQLite-backed meeting storage was extended to persist:
  - meetings
  - summaries
  - transcripts
  - usage logs
  - contradictions
  - chunked retrieval content
- `MeetingMemoryBrain` and related services became the durable spine for prior-meeting recall and import normalization.
- Imported meetings now land in the same durable meeting model rather than a one-off import-only structure.

### Phase 3. Microsoft Local Integrations

- Outlook Desktop local bridge was integrated and validated on this machine for:
  - inbox reads
  - calendar reads
  - draft/send/reply paths
  - event creation
- Teams local extraction/send paths were integrated through the local desktop strategy.
- A dedicated Microsoft Actions panel was added under Context Hub so email, Teams, and calendar operations can be tested and exercised directly.
- The repo direction remained explicitly local-desktop-first instead of Graph-admin-first.

### Phase 4. Historical Ingestion

- Temporary but functional in-app historical import surfaces were added under `Settings -> Context Hub`.
- Manual import supports:
  - pasted text
  - source-aware grouping
  - transcript/summary/usage import
- Cluely and Teams ingestion work was expanded with the longer-term goal of folding prior meeting history into one context engine.
- Same-meeting historical imports now merge into one durable meeting record instead of creating parallel Teams/Cluely duplicates.
- Teams transcript authority is now enforced during merge, while summary/action items/related artifacts are preserved across both sources.
- Cluely profile resolution now keeps `cluely-v2` primary but separately looks for a live-capable fallback token source and emits explicit stale-token warnings.

### Phase 5. Prompt And Product Repositioning

- The product direction was pushed away from interview-assistant residue and toward a meeting/workflow companion.
- Prompt inventories were aggregated so the next round of prompt cleanup can be based on real prior prompt assets instead of guesswork.
- The intended output split is now clearer:
  - in-meeting output should read like first-person speakable guidance
  - ambient/off-meeting output can talk directly to the user

### Phase 6. UI Visibility And Explainability

- A launcher/home Context Engine Overview was added so the user can see:
  - context totals
  - freshness
  - recent imported meetings
  - overall context-engine state
- Context Hub was extended with imported meeting history visibility.
- Chat/response debugging visibility was improved so the app can be debugged against actual usage traces rather than only terminal output.
- Durable chat debug now stores explicit screen-read intent and the freshest OCR snapshot metadata so grounding can be inspected after the fact.

### Phase 8. Local Model Routing Cleanup

- Selector-facing model names were normalized to plain `Claude` and `ChatGPT` families instead of internal `claude-max` / `codex-*` ids.
- Selector visibility now favors the local Claude command path and Codex CLI path rather than exposing traditional API-key-backed model choices in the runtime selector.
- Runtime normalization now accepts legacy internal ids but resolves them onto the plain local-only model ids used by the current selector contract.

### Phase 7. Importer Reliability And Persistence Corrections

#### Importer Hang / Slow Completion

- Root cause:
  - contradiction detection ran in the foreground
  - contradiction detection reused the general chat path
  - the general chat path pulled retrieved context
  - retrieved context hit Outlook search
  - Outlook search used brittle DASL restriction logic
- Fixes:
  - post-import contradiction and reprocessing work moved into background scheduling
  - internal LLM calls gained `skipRetrievedContext`
  - contradiction detection now bypasses knowledge-mode interception and retrieval
  - Outlook search bridge rewritten to use bounded token matching over recent items

#### False-Success Imports

- Root cause:
  - dev runtime was using `AppData\\Roaming\\natively-dev\\natively.db`
  - `better-sqlite3` was broken for the Electron runtime on that path
  - DB initialization failed
  - the app continued without SQLite-backed persistence
  - `saveMeeting()` silently returned instead of throwing
- Fixes:
  - rebuilt `better-sqlite3` for current Electron runtime
  - `DatabaseManager` now prefers the canonical `appData\\natively` path when present
  - `saveMeeting()` now throws if DB is unavailable
  - `MeetingImportService` now fails fast if DB is not ready

## Runtime Decisions Now In Force

1. Natively owns the authoritative context engine.
2. Structured sources outrank OCR.
3. Teams transcripts outrank Cluely transcripts for the same meeting.
4. Import success must mean persistence actually succeeded.
5. Internal background LLM analysis must not automatically invoke full retrieval.
6. Important context must be inspectable in the UI.
7. Dev and installed/runtime-visible builds should converge on one canonical Natively data store when that store exists.

## Validation Performed

- `npx tsc --noEmit`
- `npm run build:electron`
- Outlook bridge script execution against the local Outlook session
- DB path and row-count inspection across the broken dev DB and the canonical shared DB
- Electron runtime log inspection confirming successful SQLite initialization after rebuild

## Current Known Limitations

- Screen-grounding consistency still needs another focused debugging pass.
- Model/provider routing still needs additional real-world validation so the local-only Claude/Codex paths are confirmed under the current desktop-authenticated flows.
- Cluely one-click importer remains less reliable than desired against the current local Cluely runtime.
- Startup orchestration for supporting services such as Nexus/Conductor/Billboard/ClawMem remains incomplete and should be revisited after the core context engine is stable.

## Immediate Next Steps

1. Re-import one Cluely meeting now that persistence is fixed and verify it appears in Context Hub and launcher surfaces.
2. Validate Teams import again and confirm merged same-meeting behavior versus Cluely.
3. Continue screen-grounding debugging with screenshot-plus-response traces plus the new OCR snapshot metadata.
4. Finish removing dormant API-key model settings surfaces so the app contract matches the local-only selector/runtime path.
5. Only then return to broader startup orchestration and service lifecycle automation.
