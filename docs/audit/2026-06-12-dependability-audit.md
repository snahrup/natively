# Natively Dependability Audit — 2026-06-12

**Method:** 68-agent multi-pass audit across 9 domains (STT pipeline, vision/OCR, intelligence loop, ambient lifecycle, autonomy/tasks, context engine, architecture/monolith, resilience/observability, eval/testing) plus a dedicated Microsoft Graph gap analysis. Every critical/high finding was independently adversarially verified by a second agent instructed to refute it against the code on disk. 68 findings confirmed (2 critical, 32 high, 32 medium, 2 low); 3 refuted and excluded.

**Caveat:** medium/low findings in 5 domains carry auditor confidence only (their batch verifiers hit a session limit), and the completeness-critic round did not run. All critical/high findings below are independently verified.

**Audited against three goals:**
1. **Live meeting assist** — proactive, accurate, fast help via vision + STT during live meetings; never silently failing.
2. **Ambient all-day listening** — lightweight 8-12h background operation; "you have X due, deadline approaching."
3. **Proactive task follow-through** — notice task → draft → clickable notification → review → execute.

---

## Executive summary

Natively's architecture documents are genuinely good — the code does not yet comply with them. Five systemic patterns account for most of the 68 findings:

1. **Silent failure is the default everywhere.** STT death, OCR death, proactive-coach death, and service-bootstrap death all land in console logs, unread strings, or broadcast channels with no listener. The health chips measure *capture freshness*, which stays green while *transcription* is dead. This single pattern is the largest threat to daily dependability.
2. **The live path is configured for maximum slowness.** Every LLM call is a cold CLI process spawn; the default live-answer path is claude-opus-4-8 at hardcoded `--effort max` with a 180s timeout; "streaming" is fake (one blocking call that yields the whole answer at the end); in-flight calls cannot be cancelled. "Continuous OCR" is not OCR — it is frontier vision-LLM CLI spawns per display per 5s cycle.
3. **Data-loss windows are wide open.** The entire meeting transcript lives only in main-process RAM until Stop is pressed. A crash, force-quit, or Windows Update at hour 3 erases the meeting. Zero `powerMonitor` usage means sleep/lock/resume are invisible and kill transcription silently.
4. **Goal 2 and the front half of goal 3 are unbuilt, not buggy.** There is no ambient runtime path (all-day = meeting-mode-left-on, the *heaviest* mode). Commitments have no due dates, no durable storage, no deadline sweep, no proposal generator, and notifications are not clickable. The approve→execute *back half* genuinely works.
5. **The Prism monolith pattern is recurring and accelerating.** main.ts grew +38% (2,893 → 4,003 lines) in one uncommitted batch, with proactive-suggestion NLU, wake-word handling, and speaker identity inlined into the AppState god object. Seven context-injection paths exist; only one goes through the shared retrieval broker. Surfaces are debug labels, not behavior contracts.

**The Microsoft answer (Steve's #1 blocker):** there is **zero Graph API code in the repo** — no MSAL, no SDK, no dependency. Teams = CDP DOM scraping (keyed to obfuscated CSS hashes, with EDR-evasion jitter aimed at Arctic Wolf — a real policy risk). Outlook = COM automation that dies entirely when IP Corp force-migrates to New Outlook. The single unblock is one Entra app registration with delegated read-only scopes. Full analysis in §6.

---

## 1. Goal 1 — Live meeting assist: what blocks it

### CRITICAL

**C1. Meeting transcript exists only in RAM until Stop; crash mid-meeting loses everything** *(confirmed independently by two domains)*
`electron/MeetingPersistence.ts:29-89`, `electron/SessionTracker.ts:57-60`
The only DB write happens in `stopMeeting()`. During the meeting, every segment lives in `SessionTracker.fullTranscript` (in-memory array). A renderer/GPU crash, uncaughtException, Windows Update reboot, battery death, or tray-Quit during hour 3 erases hours of transcript. The recovery path that exists is env-gated off in packaged builds.
**Fix:** insert the meeting row (`is_processed=0`) at `startMeeting()`; batched append of final segments to the transcripts table every 10-30s from SessionTracker; enable `recoverUnprocessedMeetings()` by default.

**C2. Default live-answer path runs claude-opus-4-8 at hardcoded `--effort max`, 180s timeout**
`electron/LLMHelper.ts:92-95, 751-767`
`runClaudeCli` always pushes `--effort max` (`DEFAULT_CLAUDE_EFFORT`); `this.reasoningEffort` and `request.requestProfile` are never consulted on the Claude path — the realtime profile (effort low, 9s timeout) exists only for codex. The primary live-meeting path is configured for the slowest possible response: frontier model, max effort, cold process spawn, no streaming.
**Fix:** honor `requestProfile` on the Claude path: realtime → sonnet/haiku-class, low effort, 10-15s timeout. Reserve opus-max for non-realtime jobs.

### HIGH — STT reliability

- **No liveness watchdog on STT WebSockets** (`DeepgramStreamingSTT.ts:140-155`): WiFi drop creates a half-open socket; `write()` keeps "sending" into the void for 1-3 minutes (OS retransmission timeout) with zero signal. **Fix:** record `lastMessageAt` per provider; if connected + writing + no server message for ~10s → `ws.terminate()` to force the reconnect path.
- **Soniox and ElevenLabs permanently kill transcription on server code-1000 close** (`SonioxStreamingSTT.ts:318-333`): graceful vendor closes (session limits, idle) set `isActive=false` mid-meeting; every subsequent chunk is dropped, no error emitted. Deepgram's handler already does this right — copy it.
- **STT death is invisible** (`main.ts:935-938, 1944-1947, 2508-2513`): `stt.on('error')` → console + an unread string; the `meeting-audio-error` broadcast has **no preload binding and no listener**; health chips track capture chunks (which keep flowing), not transcripts. **Fix:** bind the broadcast, render `lastError`, add a transcripts-freshness chip that goes loud during active meetings.
- **Deepgram gives up after 10 reconnect attempts, then lazy-connect bypasses all backoff** (`DeepgramStreamingSTT.ts:143-151, 256-279`): after give-up, every audio chunk triggers an immediate `connect()` — an unthrottled reconnect storm at up to 50 attempts/sec. Disconnect buffer holds only ~10s of audio. **Fix:** capped persistent backoff (30-60s forever), make lazy-connect respect it, size the buffer for minutes.
- **No device hot-plug handling; native capture errors die in stderr** (`native-module/src/microphone.rs:202`, `main.ts:2090-2226`): cpal stream errors are `eprintln!` only — JS never sees them; headset unplug mid-meeting silently pins capture to a dead device. **Fix:** WASAPI default-device-change notification → `reconfigureAudio()`; promote cpal `err_fn` to a ThreadsafeFunction emitting to JS.
- **Missing-key fallback lands on unconfigured GoogleSTT; no runtime cross-provider failover** (`main.ts:1747-1828`).

### HIGH — Intelligence loop

- **All "streaming" is fake** (`LLMHelper.ts:520-540`): `streamChat` awaits the entire blocking `chat()` then yields once. The user stares at a blank panel for 10-60+s, then the answer pops in whole. The JSONL parsing loop at `LLMHelper.ts:973-985` already splits lines in real time — emit deltas from there. *(Strongly consider replacing CLI spawns with the Claude Agent SDK — real streaming, AbortSignal cancellation, and it runs on the MAX subscriptions.)*
- **In-flight calls cannot be cancelled** (`IntelligenceEngine.ts:327-351, 904-914`): the "RC-03 fix" comment claims `stream.return()` stops the request — false; superseded opus-max CLI processes run to completion (up to 180-300s) while new ones spawn alongside. **Fix:** AbortSignal through `runCliText`/`collectJsonlOutput` → existing `killProcessTree(child.pid)`.
- **Proactive failures swallowed; errors masked as "Could you repeat that?"** (`IntelligenceEngine.ts:401-433`): the user cannot distinguish "nothing useful to say" from "the coach has been dead for 40 minutes" (expired CLI auth produces exactly this). **Fix:** visible health event on CLI error/timeout; reserve the canned line for genuinely empty transcripts.
- **Action-proposal interception blocks chat and breaks non-widget surfaces** (`ipcHandlers.ts:678-712`, `AgentActionPlanner.ts:83-129`): every chat call matching `/(send|...|meeting|message|schedule)/i` — words constant in meeting assistance — runs a serial, non-streamed planner LLM call before any token streams, and emits raw JSON to surfaces that can't render the card. **Fix:** gate on `surface === 'widget'`.

### HIGH — Vision

- **"Continuous OCR" = frontier vision-LLM CLI spawn per display per 5s cycle** (`ContinuousOCRService.ts:74, 244-318`): screen context is typically 1-3+ minutes stale during meetings (cycles overrun and skip), competes with the live coach for CPU/quota, and the 60s rolling window frequently empties between frames. **Fix:** local OCR engine (Windows.Media.Ocr / tesseract.js / RapidOCR) for the continuous loop; reserve LLM vision for on-demand captures.
- **Capture loop never surfaces failure** (`ContinuousOCRService.ts:224-251`): lock screen, permission revocation, RDP, dead displays → console.warn only while status reports "running."
- **Selective-crop DPI math contradicts the stitched path** (`ScreenshotHelper.ts:462-477, 525-557`): one path empirically measures thumbnail scaling, the other hardcodes the opposite assumption — wrong region captured on scaled monitors for the highest-intent vision interaction (snip-and-ask).

### HIGH — Cross-surface contamination

- **One global chat stream slot for all surfaces** (`ipcHandlers.ts:645-763`, `preload.ts:857-859`): module-level `_chatStreamId` shared by widget, meeting overlay, and global overlay. A new request from any surface silently kills in-flight answers (no terminal event → stuck spinners) and stale listeners bleed tokens across surfaces. **Fix:** per-request IDs with guaranteed terminal events.
- **Surfaces are debug labels, not behavior contracts; all share one conversation memory** (`ipcHandlers.ts:67-74, 647-728`): the meeting coach's context is nondeterministically polluted by what you did in other chat surfaces — Prism shortfall C verbatim. **Fix:** SurfaceContract map (per-surface system prompt, memory scope, context sources, allowed actions).
- **Raw OCR dump prepended ABOVE ranked evidence, uncapped, injected twice per prompt** (`LLMHelper.ts:578-582, 648-654`): up to 12 full-screen frames of unranked text dominate the prompt — the "OCR sovereign" failure Guardrail 5 forbids.
- **Meeting-chat RAG answers contaminated by a second retrieval pass + OCR layered onto a "meeting-excerpt-only" prompt** (`RAGManager.ts:177-216`, `LLMHelper.ts:626-654`): "ask about this meeting" can silently blend other meetings, emails, and current screen content.

---

## 2. Goal 2 — Ambient all-day: what blocks it

**The headline: ambient mode does not exist as a runtime.** The audio pipeline starts only via `startMeeting()` or manual voice capture (`main.ts:2360-2390, 2466-2514`); "Ambient Coach" exists solely as an LLM prompt string (`prompts.ts:104`). All-day use is meeting-mode-left-on — which is the *heaviest* mode the app has (reflex pipeline + 30s RAG embedding ticks + per-segment compaction LLM calls + 5s frontier-vision OCR). Long-session compaction silently discards early-day raw transcript.

- **Zero `powerMonitor` usage** (repo-wide grep: no hits): laptop sleep, lid-close, lock, unlock are invisible. An all-day session will cross at least one lock event, after which transcription is dead until manual restart — and nothing says so.
- **Audio-pipeline death mid-session is silent, no watchdog, no auto-restart** (`main.ts:935-938`): the error lands in a string nobody reads unless the UI polls.
- **Volatile in-memory observation store, 10-minute OCR TTL** (`ContextObservationStore.ts:4-23`): an 8-12h session retains at most the last 10 minutes of screen activity; everything is lost on restart. "Analyze what I did today and suggest automations" is structurally impossible.
- **35 untracked singletons, two competing bootstrap sites, catch-log-continue failure policy** (`main.ts:528-595, 1448-1465`): RAG/memory/calendar can die at 8am and stay dead until restart, with the evidence buried in `natively_debug.log`.
- Medium: unbounded DB growth (no retention/VACUUM, unindexed LIKE over `ai_interactions`); 10MB single-rotation log loses the morning's evidence by 6pm; no strict TypeScript (`strictNullChecks` off across 125 main-process files — undefined-property crashes mid-day have nothing to catch them).

**Fix direction:** define an explicit ambient surface — a session type that persists observations to SQLite, runs OCR on a 30-60s cadence with *local* text extraction, skips reflex/coaching lanes, and registers powerMonitor + watchdog handlers. This is a design task, not a bug fix.

---

## 3. Goal 3 — Proactive task follow-through: the front half is missing

**What works (verified):** editable `InlineActionProposalCard` drafts with explicit Send buttons; `brain-action-proposals:execute` (`ipcHandlers.ts:2912-3013`) audited via the durable workflow ledger, executing through MicrosoftLocalManager. The approve→execute back half is real.

**What's missing — precisely steps 1-3 of your loop:**

1. **Nothing notices commitments durably.** `ContextCommitmentExtractor` emits title/body strings only — no `dueAt` field exists in `ContextDocument`; "I'll send that by Friday" loses its temporal half at extraction. Commitments are recomputed per retrieval, never stored, no cross-meeting dedupe, no done-state, and extraction never sees live transcripts (nothing actionable until the meeting is saved).
2. **No deadline awareness anywhere.** Repo-wide, exactly one clock-vs-event comparison exists: the 2-minute meeting-start reminder in CalendarManager. Nothing evaluates "X is due tomorrow."
3. **No proposal generator and no actionable notifications.** Nothing creates proposals proactively; autonomy notifications are fire-and-forget with RAM-only dedupe — not clickable (the calendar reminder already does clickable right; copy it).
4. **The `electron/autonomy/` subsystem is double-gated dead code**: `NATIVELY_ENABLE_AUTONOMOUS_OPS !== '1'` in normal launches, and even enabled, the only adapter is FmdAdapter (a dev-repo pipeline watcher) behind a second flag. PolicyEngine is a stub whose 'escalate' verdict gates nothing — the exact guardrail-erosion pattern the docs warn about. Decide: retire it or repoint it.

**Build list to close the loop:** `dueAt` on ContextDocument + date-phrase parser (the regex vocabulary already exists in `TranscriptPreprocessor.ts:46`) → durable commitments table → DeadlineSweepService (5-min interval comparing dueAt vs clock) → on trigger, call AgentActionPlanner with a synthesized request, store as a proposed brain action → clickable notification opening the proposal card → existing execute path. Every piece is small; the chain is what's missing.

---

## 4. The monolith question: is it Prism again?

Yes — measurably, and accelerating. The uncommitted working tree grew main.ts from 2,893 to 4,003 lines (+38%) in one batch, inlining proactive-suggestion regex NLU (798-904), wake-word extraction (687-797), and speaker identity (948-1100) directly into AppState (70+ mutable fields, ~140 methods, 20+ responsibilities). The live transcript hot path runs ~10 unrelated concerns per frame with no error isolation — including filesystem writes to a hardcoded personal repo path. 201 flat, unvalidated IPC channels; side-effecting email/Teams sends are inlined in the IPC file with payload-shape guessing. Interview-coder (Free-Cluely fork) residue is still constructed in the runtime path.

**The good news:** the service layer underneath (41 files) is mostly well-factored, and the new code is method-granular, so extraction is mechanical.

**Decomposition order (dependability payoff, not aesthetics):**
1. TranscriptRouter/AudioSessionService — isolate the hot path with per-consumer error isolation
2. Per-request chat stream channels (kills the global stream slot)
3. ProactiveCoachService + WakeWordService (the 622-904 block is pure functions already)
4. Meeting lifecycle service
5. One bootstrap registry with `{name, init, healthCheck, restart}` and visible degraded states (wire into the existing `context-hub:get-status`)
6. Delete interview-coder residue
+ **Freeze rule: no new method lands in main.ts.**

---

## 5. Testing and evals: zero

- Exactly one test file exists: unrunnable CRA boilerplate in a vestigial `renderer/` folder. No test runner, no `test` script.
- The eval-harness spec and Guardrail 10 release gates are completely unimplemented — no fixtures, no eval sets, no `docs/evals/`.
- The hand-tuned ranking math in `ContextRetrievalBroker.scoreDocument` (weights, 0.12 cutoff, surface boosts) — the code that decides what the LLM sees — is pure, mock-free, actively edited, and untested. These are the highest-value-per-hour test targets in the repo.
- CI triggers on pull_request only, builds macOS only, verifies file existence only. TypeScript strict mode off for the entire main process.
- **Today, regressions in the STT→intelligence→suggestion path are caught by you, during real meetings.**

**Minimum viable discipline:** vitest (~10 min with the existing Vite toolchain) + table-driven specs for `scoreDocument`, `extractCommitmentFromLine`, and `prepareTranscriptForWhatToAnswer`; then JSON-fixture replay through `ContextRetrievalBroker.retrieve()` per the spec's own "minimum harness shape."

---

## 6. Microsoft Graph — the #1 blocker, analyzed

**Inventory:** zero Graph code, zero MSAL/Graph dependencies. The entire Microsoft surface is:

| Mechanism | What it does | Why it's on borrowed time |
|---|---|---|
| **TeamsBridge** (CDP DOM scraping) | Reads visible chats/messages/transcripts by injecting JS into Teams via remote-debugging port 9223 | Keyed to obfuscated CSS hashes (`c3kee9`) that break on Teams updates; *guesses* transcript existence by topic keywords; poll jitter explicitly written to evade Arctic Wolf EDR — a policy risk on a managed machine |
| **OutlookComBridge** (COM via PowerShell 5.1) | Reads inbox/calendar/contacts, can send/reply/forward | **New Outlook has no COM** — dies entirely on forced migration; requires classic Outlook running; `sendDraft()` is a no-op stub |
| **Google Calendar** | — | Placeholder credentials (`YOUR_CLIENT_ID_HERE`) — non-functional |
| **OneDrive Recordings watcher** | — | Planned (Phase 4), never built — no matching code |

**What Graph unlocks and the gates:**
- **Mail read + send-as-user** (`Mail.ReadWrite`, `Mail.Send`, delegated): the draft-create → review → send pattern is *exactly* your goal-3 flow, cloud-side, independent of Outlook running.
- **Your Teams chats** (`Chat.Read`): works delegated; bulk backfill is throttled by design (~1 req/s) — use Graph Data Connect for backfill, REST for incremental.
- **Meeting transcripts** (`OnlineMeetingTranscript.Read.All`): admin consent; delegated reach ≈ meetings you organized; must have been recorded/transcribed.
- **Copilot AI recaps**: now a real GA API (Meeting AI Insights) — but requires the target user to hold an M365 Copilot license; ~4h post-meeting delay.
- **SharePoint/OneDrive** (`Files.*`/`Sites.*`): admin consent effectively required since Microsoft's July 2025 user-consent default change. `Sites.Selected` is the admin-friendliest ask.
- **Presence** (`Presence.Read`): cheap win for "in a meeting" detection.

**The single unblock:** one public-client Entra app registration with delegated **read-only** scopes (`Mail.Read`, `Calendars.Read`, `Chat.Read`, `Files.Read.All`, `Presence.Read`, `offline_access`, `User.Read`). Read-only maps 1:1 to Guardrail 3 — the easiest yes a security team can give. Write scopes come in a later phase after read quality is proven. MSAL Node auth-code+PKCE can reuse the loopback-OAuth pattern already written in `CalendarManager.ts:72-112`; token cache via the existing `safeStorage` / DPAPI.

**Fallbacks if IT stalls:** Power Automate flows as a sanctioned middle layer writing where Natively reads (fits the brain-repo doctrine perfectly). Do **not** borrow first-party client IDs (Graph Explorer etc.) — ToS-adjacent and a visible red flag in an EDR-monitored tenant.

**Where it lives:** a `GraphIngestService` background lane in the main process — timer-driven delta pulls, normalized artifacts written into the brain-repo read models Natively already consumes via BrainReadModelService. This honors the context-source-authority rule (no live Microsoft calls at widget-time) without re-plumbing anything. Heavy tenant-wide pulls (transcript backfill) go in the external brain pipeline, not the client. COM/CDP bridges demote to fallback behind the existing flag.

**Phases:** (0) the IT ask — gates everything, start now; (1) delegated read ingest lane — retires the New-Outlook-fragile COM reads and EDR-risky CDP scraping; (2) transcripts + AI recaps (license-gated, expect partial coverage); (3) `Mail.Send` via draft-create + approve-to-send action cards — finally making the dead `sendDraft()` stub real, cloud-side.

---

## 7. Prioritized roadmap

**P0 — Stop losing data, stop lying about health (days, highest payoff-per-hour):**
1. Incremental transcript persistence (C1) — meeting row at start, 10-30s segment flush, recovery on by default
2. STT liveness watchdogs + fix Soniox/ElevenLabs code-1000 death + Deepgram backoff storm
3. Wire failure visibility: bind `meeting-audio-error`, render `lastError`, transcription-freshness chip, OCR failure surfacing
4. `powerMonitor` handlers (suspend/resume/lock/unlock) + meeting-time `powerSaveBlocker`

**P1 — Make live assist actually fast (week):**
5. Honor realtime profile on the Claude path (C2) — sonnet/haiku low-effort for live, opus for background
6. Real streaming + AbortSignal cancellation (or migrate CLI spawns to the Claude Agent SDK, which gives both for free)
7. Local OCR engine for the continuous loop; LLM vision on-demand only
8. Gate action-proposal interception to the widget surface

**P2 — Microsoft Graph foundation (parallel; mostly waiting on IT):**
9. Submit the Entra app-registration ask (read-only delegated scopes) — today
10. GraphIngestService background lane → brain repo read models
11. Phase 3 later: Graph draft→approve→send replacing COM execution

**P3 — Build goal 3's front half (week-ish, all small pieces):**
12. `dueAt` + durable commitments + DeadlineSweepService + clickable notifications + proposal generator feeding the existing execute path

**P4 — Ambient surface + monolith discipline (design + steady extraction):**
13. Explicit ambient session type (SQLite persistence, cheap OCR cadence, no reflex lane)
14. main.ts freeze rule + extraction order in §4; per-request stream channels; bootstrap registry with health states

**P5 — Eval/test floor (background, continuous):**
15. vitest + table-driven tests for broker scoring / commitment extraction / transcript prep; JSON-fixture eval replay per the spec

---

## Appendix A — Refuted findings (excluded after adversarial verification)

- *Proactive coach permanently downgrades global model via race* — mutation+restore confirmed present but the permanent-downgrade interleaving claim did not hold up.
- *Autonomy follow-through "gated off" claim (ambient-lifecycle version)* — narrow facts true but overlapped/duplicated the verified autonomy-domain findings.
- *MeetingRepairService is dead code* — factually wrong; it is referenced and reachable.

## Appendix B — Medium/low findings (one-liners)

See `.tmp/audit-digest-tight.md` for the full list with file references. Highlights: unbounded DB growth with no retention policy; migrations advance `user_version` even on failure; `saveMeeting` delete-and-reinsert can wipe transcripts on partial failure; crash-recovery re-dates meetings to recovery time; ContextHubStatusService omits STT and LLM providers (the two sources that matter most); IP Corp mode stuffs a query-independent 12K-char dump + 2.5s live Nexus fetch into every system prompt; content protection defaults off so OCR re-ingests Natively's own overlay as "screen evidence"; OpenAI Realtime interim deltas consumed as cumulative replacements; RateLimiter/postProcessor clamp/`{TEMPORAL_CONTEXT}` are dead code; background-throttling switch is a no-op (set after window creation); meeting save pipeline runs 3+ sequential frontier-LLM calls with no timeout/retry and strands meetings in "Processing…" on crash.
