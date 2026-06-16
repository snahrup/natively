# Handoff: Dependability Audit → Fix Implementation (2026-06-12)

**For:** fresh Claude Code session (Fable 5, ultracode) picking up mid-stream.
**Mission:** implement the fixes from the dependability audit — **2 critical + 32 high first**, then mediums. No re-auditing, no re-deciding. Build.

---

## 1. What happened before this handoff

1. A 68-agent audit of Natively ran across 9 domains (STT, vision/OCR, intelligence loop, ambient lifecycle, autonomy/tasks, context engine, monolith, resilience, eval/testing). Every critical/high finding was adversarially verified against code on disk. **68 confirmed findings: 2 critical, 32 high, 32 medium, 2 low.**
2. A dedicated Microsoft Graph gap analysis ran (zero Graph code exists; Teams=CDP DOM scraping, Outlook=COM dying with New Outlook; plan = Entra app registration with delegated read-only scopes → `GraphIngestService` background lane → brain repo).
3. **Read these two files first:**
   - `docs/audit/2026-06-12-dependability-audit.md` — the full report with priorities (§7 = roadmap)
   - `.tmp/audit-digest-tight.md` — ALL 34 critical/high findings with file:line evidence + fixes, and medium/low one-liners. **This is your work queue.**
4. Memory was saved at `~/.claude/projects/C--Users-snahrup-CascadeProjects-natively/memory/natively-dependability-audit-2026-06.md` (auto-loads via MEMORY.md).

## 2. Decisions already made — DO NOT re-litigate

- **Natively is the base.** Prism (`~/CascadeProjects/Prism`) and prism-v2 (`~/CascadeProjects/prism-v2`) are abandoned precursors. Steve explicitly decided: build out from Natively. Do not spend tokens evaluating the Prisms.
- **Fix order:** the 2 criticals, then the 32 highs, then mediums. Within that, follow the P0→P5 roadmap in report §7 (P0 = data loss + silent failure first).
- **Microsoft Graph:** the unblock is an IT ask (Entra public-client app, delegated read-only scopes: Mail.Read, Calendars.Read, Chat.Read, Files.Read.All, Presence.Read, offline_access, User.Read). Code-side work (GraphIngestService) is Phase 1+ — not part of the critical/high fix sweep unless Steve says so.
- **Steve wants Fable 5 doing this work** (he was fighting a client issue where the model kept switching off Fable — that's the only reason this handoff exists).
- For the fake-streaming/cancellation fix (intelligence-loop highs): if replacing CLI spawns, use **`@anthropic-ai/claude-agent-sdk`** — NEVER `@anthropic-ai/sdk` (raw API). Steve's global rule; runs on his Claude MAX subscriptions.

## 3. Session state at handoff

- **No fix code was written yet.** Investigation for Critical #1 was complete; implementation was about to start.
- **The working tree has ~5,700 lines of PRE-EXISTING uncommitted changes that predate this session** (46 files: main.ts, ipcHandlers.ts, Launcher.tsx, NativelyInterface.tsx, etc.). They are Steve's WIP — do NOT revert, do NOT blindly commit. Recommend at session start: ask Steve whether to commit his WIP first (clean baseline) or layer fixes on top and stage only the files you touch.
- Last commit: `a7dcb08 fix: auto-handle claude auth and chat issues`, branch `main`, version 2.3.12.

## 4. Critical #1 — Incremental transcript persistence (implementation plan, ready to execute)

**Finding:** the entire meeting transcript lives only in main-process RAM until Stop; crash/quit mid-meeting loses everything. Recovery is env-gated off.

**Code map (verified by direct reading):**
- `electron/SessionTracker.ts:58` — `fullTranscript: TranscriptSegment[]` in-memory only. Segments appended in `addTranscript()` (line 234) and `addAssistantMessage()` (line 288). `compactTranscriptIfNeeded()` (line 551) evicts the oldest 500 entries from RAM at >1800 — **eviction must NOT delete DB rows**. `reset()` (line 502) clears everything — called from `stopMeeting()` AFTER snapshot.
- `electron/MeetingPersistence.ts:29-90` — `stopMeeting()`: generates `meetingId` at STOP (line 58, `crypto.randomUUID()`), writes placeholder row at line 81, fires background `processAndSaveMeeting()` (3+ sequential LLM calls), final save at line 231.
- `electron/MeetingPersistence.ts:252` — `recoverUnprocessedMeetings()` exists and works off `is_processed=0`, but is gated by `STARTUP_MEETING_RECOVERY_ENABLED` (env flag, defaults OFF — see `electron/main.ts:3924-3930`; gate rationale: "avoid automatic model calls on launch").
- `electron/db/DatabaseManager.ts:881-1005` — `saveMeeting()`: upsert meeting row + **delete-and-reinsert ALL child transcript/interaction rows in one transaction** (lines 940-941). Idempotent, so the final save will harmlessly rewrite incrementally-flushed rows. `transcripts` table schema at line 329 (meeting_id, speaker, content, timestamp_ms). better-sqlite3 = synchronous.
- `electron/main.ts:2396` — `startMeeting()`; `electron/main.ts:2517` — `endMeeting()` (calls `intelligenceManager.stopMeeting()` at 2541); `electron/main.ts:3964` — `before-quit` handler (currently does NOT flush transcripts).
- `electron/IntelligenceManager.ts` — thin facade; `stopMeeting()` at line 212 delegates to persistence.

**Design (agreed):**
1. **Generate `meetingId` at meeting START.** Add `startMeeting(metadata)` to MeetingPersistence: creates UUID, writes the meeting row immediately (`is_processed=0`, title from metadata or "In progress…"), stores `activeMeetingId`. Wire from `AppState.startMeeting()` (main.ts:2396) via IntelligenceManager facade.
2. **Incremental flush.** Add `appendTranscriptSegments(meetingId, segments)` to DatabaseManager (prepared INSERT, transaction). SessionTracker gets a flush hook: track `lastFlushedIndex` into `fullTranscript`; a 15s timer (started/stopped with the meeting, `unref()`d) flushes new FINAL segments. **Compaction note:** compaction slices `fullTranscript` — convert `lastFlushedIndex` accounting to survive the slice (decrement by `summarizeCount` on compaction, floor 0). Flushed rows stay in DB regardless of RAM eviction — that's the point.
3. **`stopMeeting()` uses the existing `activeMeetingId`** instead of generating a new one (keep UUID generation as fallback if start-row creation failed). Final `saveMeeting()` delete-and-reinsert stays — it dedupes/normalizes whatever the incremental flush wrote.
4. **Flush on quit:** in the `before-quit` handler (main.ts:3964), if a meeting is active, synchronously flush pending segments (better-sqlite3 is sync — safe in the handler).
5. **Recovery on by default, without auto-LLM.** Split `recoverUnprocessedMeetings()`: recovery of DATA (mark meeting recoverable, compute duration from last segment `timestamp_ms - start_time`, set title "Recovered meeting") runs ALWAYS at startup; the LLM summary pass runs lazily (when the user opens the meeting, or behind the existing flag). This respects the gate's rationale (no surprise model calls on launch) while killing the data loss.
6. **Guard:** placeholder/in-progress rows must not confuse the meetings list UI — `is_processed=0` rows already render as "Processing..."; verify Launcher/MeetingDetails handle a row with no summary gracefully.

**Verify:** `npm run build:electron` (tsc) compiles; manual test = start meeting in dev (`npm run app:dev`), speak/play audio ~1 min, kill the process hard (taskkill), relaunch, confirm transcript rows exist and the meeting appears.

## 5. Critical #2 — quick spec

`electron/LLMHelper.ts:92-95, 751-767`: `runClaudeCli` hardcodes `--effort max` (`DEFAULT_CLAUDE_EFFORT`), ignores `this.reasoningEffort` and `request.requestProfile`. `resolveCodexRequestProfile` (line ~1101) maps realtime→low effort/9s timeout for codex only. **Fix:** mirror that profile resolution on the Claude path — realtime → cheaper/faster model (sonnet-class) + low effort + 10-15s timeout; honor `this.reasoningEffort` otherwise. Audit callers passing `requestProfile: 'realtime'` (IntelligenceEngine live lanes) to confirm they get the fast path.

## 6. The remaining 32 highs — work queue

Full details in `.tmp/audit-digest-tight.md`. Cluster order (per report §7):

**P0 cluster (after the 2 criticals):**
- STT liveness watchdog, all WS providers (`DeepgramStreamingSTT.ts:140-155` pattern, also Soniox/ElevenLabs/OpenAI)
- Soniox + ElevenLabs code-1000 permanent-death fix (`SonioxStreamingSTT.ts:318-333`, ElevenLabs same pattern; copy Deepgram's handler)
- Deepgram reconnect give-up + lazy-connect storm (`DeepgramStreamingSTT.ts:143-151, 256-279`)
- STT failure visibility: bind `meeting-audio-error` in preload, render `lastError`, transcription-freshness chip (`main.ts:935-938, 1944-1947, 2508-2513`; chips at `NativelyInterface.tsx:3244-3263`)
- powerMonitor handlers + powerSaveBlocker during meetings (zero usage today — `main.ts` initializeApp)
- Audio watchdog + auto-restart mid-meeting (`main.ts:935-938`)
- Device hot-plug (`native-module/src/microphone.rs:202` err_fn → ThreadsafeFunction; WASAPI default-device-change)

**P1 cluster:**
- Real streaming (make `collectJsonlOutput` yield deltas — parsing loop at `LLMHelper.ts:973-985` already splits JSONL live) + AbortSignal cancellation wired to `killProcessTree` (`IntelligenceEngine.ts:327-351`)
- Proactive failures visible, not "Could you repeat that?" (`IntelligenceEngine.ts:401-433`)
- Local OCR for the continuous loop (replace frontier vision CLI spawns — `ContinuousOCRService.ts:74, 244-318`); OCR failure surfacing (`:224-251`)
- Action-proposal interception gated to widget surface (`ipcHandlers.ts:678-712`)
- Per-request chat stream channels, kill global `_chatStreamId` slot (`ipcHandlers.ts:645-763`, `preload.ts:857-859`)
- OCR dump capped + not above ranked evidence + not injected twice (`LLMHelper.ts:578-582, 648-654`)
- RAG meeting-chat contamination: pass skip flags from `RAGManager.ts:177-216`
- Crop DPI math (`ScreenshotHelper.ts:462-477` vs `525-557` — use empirical ratio everywhere)

**P3/P4 highs:**
- Durable commitments + `dueAt` + DeadlineSweepService + clickable notifications + proposal generator (`ContextCommitmentExtractor.ts`, `electron/autonomy/*` — see audit §3 for the exact chain)
- Autonomy subsystem: retire or repoint (decision needed from Steve when reached)
- Durable observation store (SQLite) replacing 10-min in-RAM OCR TTL (`ContextObservationStore.ts:4-23`)
- Surface contracts + per-surface memory (`ipcHandlers.ts:67-74, 647-728`)
- Bootstrap registry with health states (`main.ts:528-595, 1448-1465`, wire into `context-hub:get-status` at `ipcHandlers.ts:2875`)
- vitest + first tests (broker scoring `ContextRetrievalBroker.ts:118-199`, commitment extraction, transcript prep) — cheap, do early; nothing else has a regression net

## 7. Constraints & gotchas

- **Windows 11.** Git Bash for shell; `taskkill //F //IM` not `kill`. Typecheck/build: `npm run build:electron`. Dev run: `npm run app:dev`. No test runner exists yet.
- **Prefix every response `[<session-name>]`** (Nexus mandate; name comes from the SessionStart briefing).
- **Auto-invoke QA agents** after each fix cluster per global CLAUDE.md: `steve-agents:task-completion-validator`, then `steve-agents:code-quality-pragmatist`. Escalate stubborn bugs to `steve-agents:ultrathink-debugger` after 2 failed attempts.
- Verify each fix compiles before moving on; batch-verify behavior at cluster boundaries (no test suite to lean on).
- Don't add features while fixing — Guardrail 10 / the audit's whole point. Smallest correct change per finding.
- The premium submodule and `electron/premium/` exist — avoid touching unless a finding requires it.
- Token discipline: Steve hit a session cap earlier today (resets were ~5:20pm ET). Don't spawn giant agent fleets for mechanical fixes; implement directly, use agents for verification sweeps.

## 8. Paste-ready prompt for the new session

```
Read docs/handoff/2026-06-12-dependability-fixes-handoff.md and follow it exactly.

You are implementing the fixes from the 2026-06-12 dependability audit (docs/audit/2026-06-12-dependability-audit.md, work queue in .tmp/audit-digest-tight.md). Decisions are already made: Natively is the base (ignore the Prism repos), fix order is the 2 criticals then the 32 highs (P0→P1 clusters first). Critical #1 (incremental transcript persistence) has a ready implementation plan in the handoff §4 — start there.

First: ask me whether to commit my pre-existing WIP (~5,700 uncommitted lines) before you start layering fixes, or stage only the files you touch.

Then bang out the fixes one at a time: smallest correct change, npm run build:electron after each, task-completion-validator after each cluster. Do not re-audit, do not redesign, do not add features.
```
