# Natively Session Handoff

Last updated: 2026-04-12 11:45:55 PM -04:00

## Scope

This handoff covers the continuation work after [2026-04-10-to-2026-04-12-codex-session-handoff.md](/c:/Users/snahrup/CascadeProjects/natively/docs/handoff/2026-04-10-to-2026-04-12-codex-session-handoff.md).

It includes:

- the Semantica direction and local-only model contract
- the current status of the Natively + Semantica architecture work
- the exact state of the Notion/Outlook/Teams meeting-repair effort
- what is intentionally paused right now

## Repo State

- Working directory during this session: `c:\Users\snahrup\CascadeProjects\natively`
- Host environment: Windows / PowerShell
- Current date during handoff: 2026-04-12
- Timezone: `America/New_York`
- Git state: dirty working tree with many unrelated and ongoing edits; do not assume only this session's changes are present

## User Non-Negotiables

These are hard requirements and should be treated as binding:

- Never use API keys for model calls.
- Only local-command execution paths are allowed.
- `Claude` must route through the local Claude command / Agent SDK command approach.
- `ChatGPT` must route through Codex CLI.
- Do not surface "local session", "claude-max", or similar UX labels.
- Provider/model naming in the UI should stay plain:
  - `Claude`
  - `ChatGPT`
  - `Sonnet`
  - `Opus`
  - `5.4`
  - `5.3 Codex`
- Natively should not become the canonical long-term source of truth for all context.
- Semantica is the intended canonical substrate.
- Natively remains the capture, workflow, meeting, and operator UI.

## Current Product Direction

The current intended architecture is:

- `Semantica` = canonical context and knowledge substrate
- `Natively` = operator UI, capture, meeting review, meeting prep, workflow actions
- `Vesti` is not being copied wholesale, but its `Library / Explore / Network` exploration patterns are the target reference for the future cross-source exploration UX

Primary architecture docs already created:

- [semantica-fit-assessment.md](/c:/Users/snahrup/CascadeProjects/natively/docs/architecture/semantica-fit-assessment.md)
- [semantica-natively-afternoon-packets.md](/c:/Users/snahrup/CascadeProjects/natively/docs/architecture/semantica-natively-afternoon-packets.md)
- [context-engine-target-state.md](/c:/Users/snahrup/CascadeProjects/natively/docs/architecture/context-engine-target-state.md)
- [context-source-authority.md](/c:/Users/snahrup/CascadeProjects/natively/docs/architecture/context-source-authority.md)

## Semantica State

Semantica was cloned locally as an independent repo, not kept as a GitHub fork:

- local path: `C:\Users\snahrup\CascadeProjects\semantica`

The intended runtime direction already established in code/docs is:

- local Semantica sidecar
- persistent data outside the packaged app path
- Natively reading/writing context through the Semantica bridge layer instead of deepening the old in-app substrate path

Relevant Natively files already present in the tree:

- [electron/services/SemanticaSidecarManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/SemanticaSidecarManager.ts)
- [electron/services/SemanticaBridgeService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/SemanticaBridgeService.ts)
- [electron/services/SemanticaMeetingIndexer.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/SemanticaMeetingIndexer.ts)
- [electron/services/ContextStackBootstrapService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/ContextStackBootstrapService.ts)

This handoff does not re-verify the full Semantica integration end-to-end. It records project direction and the currently relevant repo state so the next session can pick up without reconstructing intent.

## Meeting Import Status

The user explicitly said to put a pin in the meeting import work for now:

- do not resume the Notion/Outlook/Teams repair effort by default
- only resume it if the user asks for it again

The user does not currently care enough about this path to keep spending time on it in the next session.

## What Was Actually Implemented In This Session

The user asked whether changes were actually made before the IDE disruption. The answer is yes. This was not "about to happen". The following work is real and present in the tree.

### 1. Notion Transcript Parsing Was Improved

Problem:

- many Notion `transcriptMarkdown` payloads were being collapsed into a single generic `Transcript` segment
- that caused the meeting detail transcript view to show a single blob of text even when the source contained multiple paragraphs or speaker-ish structure

Fixes:

- [scripts/notion-meeting-backfill.cjs](/c:/Users/snahrup/CascadeProjects/natively/scripts/notion-meeting-backfill.cjs)
  - added logic to distinguish structured speaker parses from generic one-line fallbacks
  - paragraph-based transcripts now stay segmented instead of degenerating into a single transcript row
  - the older explicit transcript parsing path was updated too, not just `parsedMeeting` imports

Result:

- some imported meetings that previously persisted as `1` blob row now persist as multi-segment transcripts

### 2. Cross-Source Meeting Repair Service Was Extended

Core files:

- [electron/services/MeetingRepairService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingRepairService.ts)
- [electron/services/MicrosoftLocalManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MicrosoftLocalManager.ts)
- [electron/services/OutlookComBridge.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/OutlookComBridge.ts)
- [electron/services/outlook-bridge/poll-calendar.ps1](/c:/Users/snahrup/CascadeProjects/natively/electron/services/outlook-bridge/poll-calendar.ps1)
- [electron/db/DatabaseManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/db/DatabaseManager.ts)

What was added or improved:

- historical Outlook calendar fetch over date ranges
- Teams meeting transcript candidate discovery
- Teams meeting transcript fetch by chat/title
- repair flow that can update imported meetings with:
  - stronger date/time
  - duration
  - calendar metadata
  - transcript recovery metadata
  - transcript replacement when a stronger Teams transcript is found

Important implementation detail:

- Outlook historical export over PowerShell stdout was unreliable for large JSON payloads
- the bridge was changed to use a temp JSON file handoff instead of trusting huge stdout blobs

### 3. Notion Backfill Was Replayed Against The Real Roaming DB

Roaming DB path used during repair:

- `C:\Users\sasnahrup\AppData\Roaming\natively\natively.db`

Batch source used:

- `temp_cluely_extract/notion-backfill-batch-001.cjs`
- `temp_cluely_extract/notion-backfill-batch-002.cjs`
- `temp_cluely_extract/notion-backfill-batch-003.cjs`
- `temp_cluely_extract/notion-backfill-batch-004.cjs`
- `temp_cluely_extract/notion-backfill-batch-005.cjs`

The backfill and repair were rerun multiple times after parser and matcher adjustments.

## Exact Current Meeting-Import State

Latest verified SQLite stats after the replay/repair work:

- `total_meetings = 53`
- `imported_meetings = 44`
- `imported_zero_duration = 26`
- `imported_with_transcripts = 6`
- `imported_multi_segment = 4`

This is materially better than the earlier broken state observed during the session:

- earlier broken imported zero-duration count: `40`
- current imported zero-duration count: `26`
- earlier imported multi-segment transcript count: `1`
- current imported multi-segment transcript count: `4`

Imported meetings that now persist with real transcript segmentation:

- `notion-2e95632092ca8034a56df8c86e65334e`
  - title: `MDM Meeting Planning Discussion — Patrick Stiller — 2026-01-15`
  - transcript rows: `36`
- `notion-cade64001aa04dc39f8e0cd59fc538d8`
  - title: `Discuss MDM Data Priorities — Robin Virginia & Patrick Stiller — 2026-02-13`
  - transcript rows: `19`
- `notion-2c65632092ca8055bc9fd7d44a0b252a`
  - title: `IT Systems and Reporting Infrastructure Meeting`
  - transcript rows: `16`
- `notion-b13b1c35a5fd4aa78dbf0d0388458b36`
  - title: `Database Exploration with Eudias`
  - transcript rows: `5`

## What Is Still Wrong In The Meeting Import Path

This is the main reason the work was paused instead of declared done.

### 1. Outlook Fuzzy Matching Still Needs A Precision Pass

Some repaired calendar matches are clearly useful and likely right.

Examples of likely-good matches:

- `notion-534c7dee801d484aa62fcafcad6c4bab`
  - matched subject: `MDM - Systems - Lite discussion`
- `notion-2647dc2f8e3d40bc81a68fce805a04e4`
  - matched subject: `Project Scoping & Data Standardization`

But some repaired matches are still too plausible-looking and not trustworthy enough:

- `notion-2e95632092ca8034a56df8c86e65334e`
  - matched subject: `Updated invitation with note: Citrine Kickoff Call @ Wed Jan 14, 2026 1pm - 1:30pm (PST) (dmathers@ip-corporation.com)`
  - this is almost certainly not the intended authoritative match
- `notion-2e65632092ca800e85c0c6a70484e9fd`
  - matched subject: `Molding Products Sales BI report demo.`
  - also suspicious

Why this is happening:

- Outlook matching started incorporating richer token overlap from meeting summary/body/participants
- that improved recovery coverage, but it also introduced false positives for:
  - recurring generic calendar items
  - invitation wrapper subjects
  - events sharing common names or generic enterprise vocabulary

The matcher was partially tightened again during this session:

- date window cap
- lower-signal subject wrapper rejection
- some low-signal person-token reduction
- recurring-event gating

But it still is not at a quality threshold I would trust blindly.

### 2. Teams Transcript Recovery Exists But Is Still Low-Yield

The code can now:

- enumerate Teams meeting transcript candidates
- fetch transcripts
- attempt transcript upgrade

But in actual replay runs during this session:

- Teams transcript recoveries were still effectively `0`

Likely reasons:

- candidate discovery is limited by what is visible in Teams DOM/CDP state
- title matching between Notion meeting titles and Teams chat titles is still weak
- many meetings do not have clean transcript-bearing Teams chat titles exposed through the current bridge

### 3. Embedding Pipeline Is Still Broken On This Machine

This is separate from meeting persistence, but it showed up repeatedly during backfill/reprocess.

Current failure:

- `sharp-win32-x64.node is not a valid Win32 application`

Source:

- `@xenova/transformers` local embedding path

Effect:

- meeting persistence still works
- transcript rows and summary data still save
- RAG reprocessing can proceed only in degraded form without working embeddings

This was not fixed in this session.

## Validation Performed

Validation commands that passed:

- `npx tsc --noEmit`
- `npm run build:electron`

Operational commands used:

- `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npx electron scripts/notion-meeting-backfill.cjs <batch>`
- `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npx electron scripts/repair-imported-meetings.cjs`

Important runtime note:

- Electron script runs will fail or behave incorrectly if `ELECTRON_RUN_AS_NODE=1` is left set

## Files Changed During This Session

Primary files touched:

- [scripts/notion-meeting-backfill.cjs](/c:/Users/snahrup/CascadeProjects/natively/scripts/notion-meeting-backfill.cjs)
- [scripts/repair-imported-meetings.cjs](/c:/Users/snahrup/CascadeProjects/natively/scripts/repair-imported-meetings.cjs)
- [electron/services/MeetingRepairService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingRepairService.ts)
- [electron/services/MicrosoftLocalManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MicrosoftLocalManager.ts)
- [electron/services/OutlookComBridge.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/OutlookComBridge.ts)
- [electron/services/outlook-bridge/poll-calendar.ps1](/c:/Users/snahrup/CascadeProjects/natively/electron/services/outlook-bridge/poll-calendar.ps1)
- [electron/db/DatabaseManager.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/db/DatabaseManager.ts)

## What The Next Session Should Do By Default

Unless the user explicitly reopens the meeting-import work, the next session should not start there.

Default next-session priority should be:

1. Continue the Semantica + Natively integration path.
2. Focus on context injection / model response behavior / action behavior testing.
3. Use the Semantica architecture docs and Vesti-inspired explore/network plan as the working blueprint.
4. Keep all model execution local-only.

## What The Next Session Should Do If The User Reopens Meeting Import

If the user explicitly wants the meeting repair resumed, the next session should:

1. Read this handoff and the earlier [2026-04-10-to-2026-04-12-codex-session-handoff.md](/c:/Users/snahrup/CascadeProjects/natively/docs/handoff/2026-04-10-to-2026-04-12-codex-session-handoff.md).
2. Start with [electron/services/MeetingRepairService.ts](/c:/Users/snahrup/CascadeProjects/natively/electron/services/MeetingRepairService.ts).
3. Tighten Outlook precision further before trying to increase recall again.
4. Add stronger rejection for:
   - invitation wrapper subjects
   - recurring generic meetings
   - matches driven only by common names like Steve/Patrick/Mike
5. Consider using Teams calendar and Teams-recording surfaces as stronger transcript/date anchors instead of relying so heavily on chat-title heuristics.
6. Do not trust a higher recovered-duration count if the underlying match quality gets worse.

## Bottom Line

The meeting-import work is not done, but it is not imaginary either.

Real progress made:

- parser quality improved
- transcript persistence improved
- duration recovery improved
- Outlook bridge reliability improved

Current pause status:

- meeting import is intentionally deprioritized
- Semantica/Natively context-substrate work should take precedence unless the user explicitly changes course
