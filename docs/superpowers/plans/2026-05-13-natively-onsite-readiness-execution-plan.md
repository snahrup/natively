# Natively Onsite Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Natively reliable enough for IP Corp onsite use by stabilizing launch behavior, widget chat, voice capture, model routing, brain-first context, meeting prep display, and action approval flow.

**Architecture:** Natively is the local desktop touchpoint. The IP Corp architecture brain is the durable intelligence authority. Natively reads brain models, renders guidance, captures feedback, and executes only approved actions. Heavy source ingestion and Cortex-style analysis happen outside the widget and write durable outputs to the brain.

**Tech Stack:** Electron, React, TypeScript, Vite, Tailwind, local filesystem brain read models, Claude Agent SDK OAuth, Codex/OpenAI model path, Deepgram streaming STT.

---

## Phase 0: Protect The Current App

### Task 0.1: Confirm Baseline And Dirty Worktree

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\package.json`
- `C:\Users\snahrup\CascadeProjects\natively\CODEBASE.md`
- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\context-source-authority.md`

**Steps:**

- [ ] Inspect current git status and identify files already modified by Steve or other sessions.
- [ ] Do not revert unrelated dirty files.
- [ ] Confirm package version and active scripts.
- [ ] Confirm whether packaged app is being launched from `release\win-unpacked\Natively.exe` or installer.
- [ ] Record baseline errors from app logs before changing runtime behavior.

**Validation:**

- [ ] Baseline notes identify launch, chat, voice, and model failures separately.

## Phase 1: Stop Launch Side Effects

### Task 1.1: Disable Legacy Autonomous Monitors By Default

**Problem:** Natively currently has legacy autonomous workflow adapters such as FMD. The user-facing notification "FMD Clean Load Run" should never appear during normal Natively launch.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\autonomy\AutonomousOpsService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\autonomy\NotificationService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\adapters\fmd\adapter.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\types\electron.d.ts`

**Steps:**

- [ ] Add a single explicit feature gate for legacy app monitors, default disabled.
- [ ] Do not register `FmdAdapter` unless the feature gate is enabled.
- [ ] Suppress non-Natively workflow notifications when the feature gate is disabled.
- [ ] Add a diagnostic log line showing legacy monitors are disabled by default.
- [ ] Ensure disabling monitors does not break action proposal rendering.

**Validation:**

- [ ] Launch packaged Natively and confirm no FMD notification appears.
- [ ] Launch dev Natively and confirm no FMD notification appears.
- [ ] Enable the feature gate manually and confirm the adapter can still be started intentionally.

### Task 1.2: Prevent External App Auto-Launch

**Problem:** Natively should not open Cluely, Teams, Outlook, or Calendar during normal app startup.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\services\ContextStackBootstrapService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\main.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\SettingsOverlay.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\context-source-authority.md`

**Steps:**

- [ ] Verify current bootstrap service only observes desktop processes and does not start them.
- [ ] If any launcher path still exists, move it behind explicit user action.
- [ ] Add a visible setting for external app launch assistance only if it is already supported cleanly.
- [ ] Update copy so Cluely/Teams/Outlook status means "detected", not "managed by Natively".
- [ ] Confirm packaged launch does not trigger Cluely through app code.
- [ ] If Cluely still opens, inspect Windows shortcut/app alias/start menu target outside the Natively code path.

**Validation:**

- [ ] Open Natively from Start Menu and confirm only Natively opens.
- [ ] Open Natively from `release\win-unpacked\Natively.exe` and confirm only Natively opens.

## Phase 2: Make Widget Chat Trustworthy

### Task 2.1: Add Chat Request Lifecycle And Timeout

**Problem:** A prompt like "What should I say about this?" can sit for minutes without a useful response or diagnosis.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\LLMHelper.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\ipcHandlers.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\hooks\useStreamBuffer.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\types\electron.d.ts`

**Steps:**

- [ ] Assign every chat request a request ID.
- [ ] Emit lifecycle events: queued, context-loading, model-routing, thinking, streaming, completed, stopped, failed.
- [ ] Display the current lifecycle state in the widget.
- [ ] Add a hard timeout for non-streaming silence.
- [ ] Wire the Stop button to abort the active request in main and renderer.
- [ ] Make provider/model/auth/context failures render distinct messages.
- [ ] Log request ID, model, provider, reasoning effort, brain files loaded, and failure category.

**Validation:**

- [ ] Submit a normal GPT 5.5 prompt and see status within 500 ms.
- [ ] Stop an in-flight request and confirm it ends cleanly.
- [ ] Force an invalid model/provider state and confirm the error is specific.
- [ ] Confirm no request can silently run for five minutes.

### Task 2.2: Ensure Brain-First Context Injection

**Problem:** Meeting answers should use the brain repo and not live scrape external apps.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\services\BrainReadModelService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\services\ContextRetrievalService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\LLMHelper.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\scripts\validate-brain-read-models.cjs`

**Steps:**

- [ ] Confirm `BrainReadModelService` reads the expected brain paths.
- [ ] Normalize current brain action proposal shapes instead of rejecting them.
- [ ] Ensure context retrieval defaults to IP Corp brain first.
- [ ] Ensure Semantica is deprecated or opt-in only.
- [ ] Include packet/insight/action provenance in trace metadata.
- [ ] Add a renderer-visible trace summary showing which brain files informed the answer.

**Validation:**

- [ ] Ask "What should I say about this?" and confirm the response uses brain prep/insight context.
- [ ] Disconnect Semantica and confirm core response still works.
- [ ] Run `npm run validate:brain`.

## Phase 3: Fix Model Routing And Dropdown UX

### Task 3.1: Lock Model Defaults And Reasoning Effort

**Problem:** GPT 5.5 and Claude Opus 4.8 must route correctly, and GPT 5.4 Mini must not be used accidentally for high-quality meeting work.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\LLMHelper.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\utils\modelUtils.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\ModelSelectorWindow.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`

**Steps:**

- [ ] Confirm default Codex/OpenAI model is `gpt-5.5`.
- [ ] Confirm default Claude model is `claude-opus-4-8`.
- [ ] Confirm meeting insight jobs use GPT 5.5 with extra-high reasoning effort.
- [ ] Persist selected model and effective reasoning effort.
- [ ] Display the actual resolved provider/model in the widget.
- [ ] Add a warning when a mini model is selected for meeting guidance.

**Validation:**

- [ ] Select GPT 5.5 and confirm request logs show GPT 5.5.
- [ ] Select GPT 5.4 Mini and confirm request logs show GPT 5.4 Mini.
- [ ] Select Claude Opus 4.8 and confirm it routes through the Claude Agent SDK path.

### Task 3.2: Fix Dropdown Visibility In Light Theme

**Problem:** Widget dropdowns are currently hard to see.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\src\components\ModelSelectorWindow.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\ui\*.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\styles\*.css`
- `C:\Users\snahrup\CascadeProjects\natively\tailwind.config.*`

**Steps:**

- [ ] Identify the exact dropdown components used inside the widget.
- [ ] Fix menu background, border, text, hover, selected, and disabled contrast.
- [ ] Ensure menu popovers render above the widget surface.
- [ ] Ensure dropdowns reposition or constrain inside small widget viewports.
- [ ] Keep the preferred light theme as the primary target.

**Validation:**

- [ ] Capture widget screenshot in light theme with model dropdown open.
- [ ] Confirm all options are readable.
- [ ] Confirm no controls overlap at the current widget size.

## Phase 4: Make Voice Diagnosable

### Task 4.1: Add Deepgram And Microphone Health States

**Problem:** Voice can fail even when the Deepgram key and Windows mic settings appear correct.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\audio\DeepgramStreamingSTT.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\ipcHandlers.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\SettingsOverlay.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\types\electron.d.ts`

**Steps:**

- [ ] Add connection states: not-configured, connecting, connected, disconnected, error.
- [ ] Add microphone signal states: no-device, no-signal, signal-detected, speech-detected.
- [ ] Add transcript states: interim-received, final-received, timeout.
- [ ] Show mic level while listening.
- [ ] Rate-limit no-speech warnings.
- [ ] Add a "test voice" flow that does not require sending a chat prompt.
- [ ] Ensure final transcript can be sent to GPT 5.5 chat path.

**Validation:**

- [ ] Start listening and confirm mic level moves when speaking.
- [ ] Confirm Deepgram connected state appears.
- [ ] Confirm interim/final transcript events appear.
- [ ] Confirm no-speech warning appears at most once every 20 seconds.
- [ ] Confirm a transcribed question can produce a GPT 5.5 response.

### Task 4.2: Add Optional Transcript Dump Lane

**Problem:** Steve wants the option for always-listening capture to dump transcript segments into the brain for later hourly processing without forcing live analysis.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\audio\DeepgramStreamingSTT.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\services\BrainReadModelService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\SettingsOverlay.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\context-source-authority.md`

**Steps:**

- [ ] Add an explicit setting for local transcript capture to brain.
- [ ] Write transcript segments to `natively\live-captures\*.jsonl`.
- [ ] Include timestamp, source, text, confidence if available, and optional meeting ID.
- [ ] Do not trigger full analysis on every segment.
- [ ] Add a manual marker for reminder/task/note/thought if simple to support.

**Validation:**

- [ ] Enable capture and confirm transcript segments append to brain live-capture file.
- [ ] Disable capture and confirm no file writes occur.

## Phase 5: Meeting Prep And Cortex Read Models

### Task 5.1: Render Prep Packet Readiness

**Problem:** Natively should show whether meeting intelligence is ready before the meeting starts.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\services\BrainReadModelService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\MeetingPrepPanel.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\types\brain.ts`

**Steps:**

- [ ] Load current/upcoming meeting packet from the brain.
- [ ] Display readiness, freshness, source counts, and packet age.
- [ ] Show missing/stale packet as a readiness warning.
- [ ] Add manual refresh that rereads the brain, not live Microsoft sources.

**Validation:**

- [ ] At least one sample brain prep packet renders.
- [ ] Missing packet state is clear and non-fatal.

### Task 5.2: Write Brain-Side Cortex Runbook

**Problem:** The brain-side Cortex job needs a precise contract so it preserves the original Prism quality instead of becoming generic summarization.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\brain-side-cortex-runbook.md`
- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\prism-shortfalls-and-guardrails.md`
- `C:\Users\snahrup\CascadeProjects\natively\scripts\validate-brain-read-models.cjs`

**Steps:**

- [ ] Define Cortex input set from brain repo only.
- [ ] Define GPT 5.5 extra-high effort as required for insightful job.
- [ ] Define output schema for insight, action proposal, workflow run, and outcome hooks.
- [ ] Include quality bar examples: observation, implication, alternatives, confidence, action.
- [ ] Add validator coverage for required insight fields.

**Validation:**

- [ ] Runbook is clear enough for another agent or automation to implement.
- [ ] `npm run validate:brain` verifies existing sample insights.

### Task 5.3: Write Prep Refresh Runbook

**Problem:** Prep should happen before the meeting, not during it.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\docs\architecture\brain-prep-refresh-runbook.md`

**Steps:**

- [ ] Define triggers: 15 minutes before meeting, after consolidated imports, manual refresh, action outcome update.
- [ ] Define that source ingestion happens outside Natively.
- [ ] Define freshness/staleness rules.
- [ ] Define expected packet fields.
- [ ] Define failure behavior when source automation is late.

**Validation:**

- [ ] Runbook explains how Natively can be ready without live calls during meetings.

## Phase 6: Action Cards And Learning Loop

### Task 6.1: Render Action Proposal Cards

**Problem:** Cortex-style insights need a way to turn into action without jumping straight to unsafe autonomy.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\services\BrainReadModelService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\ActionProposalCard.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\NativelyInterface.tsx`
- `C:\Users\snahrup\CascadeProjects\natively\src\types\brain.ts`

**Steps:**

- [ ] Load open action proposals from the brain.
- [ ] Normalize existing nested proposal shape.
- [ ] Render compact cards with approve, edit, reject, defer, and explain.
- [ ] Show risk level and source insight refs.
- [ ] Avoid executing anything from card render alone.

**Validation:**

- [ ] Existing brain proposal files render as cards.
- [ ] Buttons update local UI state without accidental external execution.

### Task 6.2: Write Outcomes To Brain

**Problem:** Natively must learn from Steve's approvals, edits, rejections, and outcomes.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\electron\services\BrainReadModelService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\electron\services\ActionExecutionService.ts`
- `C:\Users\snahrup\CascadeProjects\natively\src\components\ActionProposalCard.tsx`

**Steps:**

- [ ] Create outcome records for approve, edit, reject, defer, execute-success, and execute-failure.
- [ ] Store user edits as learning signal.
- [ ] Store execution receipts where available.
- [ ] Link outcome records back to proposal IDs.
- [ ] Do not mark external action complete unless durable write succeeds.

**Validation:**

- [ ] Rejecting a proposal writes an outcome.
- [ ] Editing a proposal writes the original and final text.
- [ ] Approval without execution is distinguishable from executed success.

## Phase 7: Eval And Regression Gates

### Task 7.1: Add Cortex Depth Eval

**Problem:** Future builds must not regress back to generic summaries.

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\scripts\eval-cortex-depth.cjs`
- `C:\Users\snahrup\CascadeProjects\natively\docs\evals\cortex-depth\*.json`
- `C:\Users\snahrup\CascadeProjects\natively\package.json`

**Steps:**

- [ ] Add fixtures based on current brain insights and prep packets.
- [ ] Score specificity, cross-meeting connection, confidence calibration, alternatives, provenance, and actionability.
- [ ] Add script `npm run eval:cortex`.
- [ ] Fail when required depth dimensions are missing.

**Validation:**

- [ ] `npm run eval:cortex` passes with current quality examples.
- [ ] A generic summary-only fixture fails.

### Task 7.2: Add Onsite Readiness Checklist

**Files:**

- `C:\Users\snahrup\CascadeProjects\natively\docs\ONSITE-READINESS.md`

**Steps:**

- [ ] List exact launch, widget, voice, model, brain, prep, action card, and packaging checks.
- [ ] Include manual test prompts.
- [ ] Include expected output for each check.
- [ ] Include known fallback if a check fails onsite.

**Validation:**

- [ ] Checklist can be run in under 15 minutes before leaving for IP Corp.

## Phase 8: Build And Package

### Task 8.1: Run Build Gates

**Commands:**

```powershell
npm run validate:brain
npm run build
npm run build:electron
```

**Steps:**

- [ ] Run brain validator.
- [ ] Run renderer/type build.
- [ ] Run Electron build.
- [ ] Fix failures directly tied to this work.
- [ ] Do not chase unrelated pre-existing failures without noting them.

**Validation:**

- [ ] All required gates pass or failures are documented with owner and reason.

### Task 8.2: Verify Packaged App

**Commands:**

```powershell
npm run app:build
```

**Steps:**

- [ ] Build packaged app.
- [ ] Launch packaged app.
- [ ] Confirm no Cluely launch.
- [ ] Confirm no FMD notification.
- [ ] Confirm widget opens.
- [ ] Confirm GPT 5.5 chat response.
- [ ] Confirm Deepgram voice diagnostic state.
- [ ] Confirm model dropdown readability.
- [ ] Confirm prep packet and action proposal render.

**Validation:**

- [ ] Packaged app is the version Steve should use.
- [ ] If installer is required, document the exact installer path.
- [ ] If unpacked build is sufficient, document the exact executable path.

## Implementation Notes

- Inline execution is preferred for this pass unless Steve explicitly asks to split work across agents.
- Do not add new framework dependencies unless they remove a real blocker.
- Do not make Semantica, Teams, Outlook, Calendar, Notion, or Cluely required for normal widget answers.
- Do not move heavy Cortex reasoning into the live widget.
- Prioritize visible failures over hidden cleverness.
