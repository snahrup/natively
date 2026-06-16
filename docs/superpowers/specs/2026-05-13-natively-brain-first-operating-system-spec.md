# Natively Brain-First Operating System Spec

**Date:** 2026-05-13
**Status:** Build-ready spec
**Primary target:** IP Corp onsite readiness

## Goal

Natively must become the fast, reliable desktop touchpoint on top of the IP Corp architecture brain.

It should open quickly, keep the widget responsive, answer from the right context, capture voice reliably, render readable controls, and present useful meeting intelligence without doing hidden live-source scraping during the meeting itself.

The durable intelligence layer is the brain repo. Natively is the surface that reads it, guides Steve through it, captures feedback, and routes approved actions.

## Product Promise

Natively is a calm operating layer for Steve's workday:

- It knows what meeting he is in or about to enter.
- It can immediately explain the relevant context from the IP Corp architecture brain.
- It can suggest what to say, what to clarify, and what follow-up to send.
- It can present action cards that Steve can approve, edit, reject, or defer.
- It learns from outcomes and feedback without turning every live interaction into a slow full-context research job.

The key distinction: Natively does not need to be the system that processes every raw source. It needs to be the system that reliably sits on top of the processed intelligence.

## Non-Negotiable Boundaries

During normal widget use, Natively reads from the IP Corp brain and its own local state. It must not rely on live calls to Teams, Outlook, Calendar, Notion, Cluely, Semantica, or screenshot/OCR sources to answer the user.

Allowed normal widget context:

- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\status.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\meeting-index.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\prep-packets\*.packet.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\cortex\latest-run.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\cortex\insights\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\action-proposals\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\workflow-runs\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\outcomes\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\live-captures\*.jsonl` only as already-written input, not as an excuse for live source crawling.

Explicit exceptions:

- Steve approves an action card that sends, drafts, creates, updates, or retrieves something through an external system.
- Steve explicitly triggers a one-time connector action.
- A future Direct Line or Copilot agent integration is enabled for a specific real-time enterprise context lane.

## What Natively Must Not Do By Default

- It must not launch Cluely when Natively opens.
- It must not launch Teams, Outlook, Calendar, or other desktop apps just because Natively opens.
- It must not show unrelated FMD or legacy workflow notifications unless Steve opted into that workflow.
- It must not treat Semantica as the IP Corp authority.
- It must not take screenshots during meetings unless Steve explicitly enables that mode.
- It must not autonomously send emails, Teams messages, calendar updates, or task updates without approval.
- It must not hide slow model calls behind a dead UI.

## Architecture

Natively has four planes.

### 1. Brain Intelligence Plane

Owned by the IP Corp architecture brain.

Responsibilities:

- Ingest already-consolidated meeting, transcript, Notion, Cluely, Teams, and email context from external automation.
- Build meeting prep packets.
- Run Cortex-style insight generation with GPT 5.5 at extra-high reasoning effort.
- Generate action proposals.
- Maintain workflow-run and outcome ledgers.
- Preserve provenance, confidence, alternatives, and reasoning factors.

Natively should consume this plane as a read model, not recreate it inside the widget.

### 2. Natively Touchpoint Plane

Owned by the desktop app.

Responsibilities:

- Fast launch and single-instance behavior.
- Widget UI, chat, voice capture, model selector, and action-card rendering.
- Brain read model loading, caching, filtering, and tracing.
- Meeting detection from already-available local signals.
- Meeting prep display and reactive Q&A.
- Local transcript capture lane when enabled.

### 3. Approved Action Plane

Owned jointly by Natively UI and external executors.

Responsibilities:

- Render action proposal cards.
- Let Steve approve, edit, reject, defer, or request more context.
- Execute only approved actions.
- Record every action attempt and result to the brain.
- Promote recurring approved patterns slowly into stronger autonomy levels.

### 4. Observability Plane

Owned by Natively.

Responsibilities:

- Show which brain files are loaded.
- Show model/provider selected and effective reasoning effort.
- Show voice provider connection state and microphone activity.
- Show chat request lifecycle: queued, thinking, writing, complete, stopped, failed.
- Log request IDs and trace IDs so a failed widget response can be diagnosed quickly.

## Onsite P0 Requirements

These are the first things that must work before IP Corp onsite use.

### P0.1 Launch Reliability

Natively must open as Natively and only Natively.

Acceptance criteria:

- Opening Natively does not open Cluely.
- Opening Natively does not start Teams or Outlook.
- Opening Natively does not show FMD clean-load notifications.
- Only one Natively instance owns the widget and tray state.
- App is usable from the packaged build, not only dev mode.

### P0.2 Widget Responsiveness

The widget cannot feel dead while a model request is running.

Acceptance criteria:

- Sending a prompt shows visible status within 500 ms.
- Streaming begins when the provider supports it.
- If streaming is not available, progress status still changes.
- Stop button cancels the request.
- A request cannot sit silently for five minutes.
- Errors include enough detail to know whether the issue was model routing, auth, provider timeout, brain context loading, or renderer IPC.

### P0.3 Model Routing

The model selector must route to the model it says it is using.

Acceptance criteria:

- `GPT 5.5` uses the Codex/OpenAI path configured for GPT 5.5.
- `GPT 5.4 Mini` is not silently used when GPT 5.5 is selected.
- `Claude Opus 4.8` uses the Claude Agent SDK path, not the raw Anthropic SDK.
- Reasoning effort is visible for models that support it.
- The default high-quality meeting insight path is GPT 5.5 with extra-high effort.

### P0.4 Dropdown And Control Visibility

The widget controls must be readable in the preferred light theme.

Acceptance criteria:

- Model dropdown text has sufficient contrast.
- Menus render above the widget glass layer.
- Selected and hovered states are readable.
- Dropdowns fit inside the widget viewport or reposition.
- Settings buttons, voice controls, and stop/send controls remain visible at small widget sizes.

### P0.5 Voice Capture Reliability

Voice must be diagnosable, not mysterious.

Acceptance criteria:

- Deepgram key validation has a visible pass/fail state.
- Microphone input level is visible while listening.
- The app can distinguish between no mic signal, provider disconnected, speech detected but not transcribed, and final transcript received.
- "No speech detected" warnings are rate-limited and do not spam the widget.
- GPT 5.5 voice mode can receive transcript text and answer.
- Failed model routing cannot look like failed speech detection.

### P0.6 Brain-First Answers

Meeting questions must use the brain repo first.

Acceptance criteria:

- Asking "what should I say about this?" loads relevant meeting/prep/insight context from the brain.
- The answer cites the source type internally and can expose provenance in trace view.
- If no relevant brain context exists, the app says that clearly and offers a direct next action.
- No live Teams, Outlook, Notion, Cluely, Semantica, or screenshot source is required for the response.

### P0.7 Meeting Prep Readiness

The widget should not be doing heavy prep while Steve is already in the meeting.

Acceptance criteria:

- Natively can display the latest prepared packet for the upcoming/current meeting.
- Brain-side prep is expected to run at least 15 minutes before start.
- The app shows packet freshness and readiness.
- If a packet is missing or stale, Natively surfaces that as a readiness issue instead of doing hidden live scraping.

### P0.8 Action Cards And Outcome Learning

The app must begin closing the loop between insight and action.

Acceptance criteria:

- Brain action proposals render as cards.
- Each card supports approve, edit, reject, defer, and explain.
- Approved actions are logged before execution.
- Completed, failed, rejected, and edited outcomes are written back to the brain.
- The brain can later learn from Steve's edits and decisions.

## P1 Requirements

These deepen the product once P0 is stable.

### P1.1 Brain-Side Cortex Job

The Cortex job is the high-quality reasoning engine that preserves what made original Prism valuable.

It must produce:

- Observation.
- Strategic implication.
- Confidence score.
- Confidence factors.
- Alternative interpretations.
- Source references.
- Suggested actions.
- Risk of doing nothing.
- Follow-up questions.
- Outcome hooks.

It should run with GPT 5.5 and extra-high reasoning effort.

### P1.2 Brain-Side Prep Packet Refresh

Prep packets should be refreshed:

- 15 minutes before meetings.
- After new consolidated transcripts or summaries arrive.
- After Steve edits/rejects/approves related actions.
- On manual refresh.

### P1.3 Cortex Depth Eval

The product needs an eval that prevents a future collapse into generic summaries.

Eval dimensions:

- Specificity.
- Cross-meeting connection quality.
- Confidence calibration.
- Alternatives.
- Actionability.
- Provenance.
- Steve-style practical usefulness.

### P1.4 Live Capture Dump Lane

If always-listening mode is enabled, it should primarily dump transcripts to the brain for later processing.

Acceptance criteria:

- Local transcript segments write to brain live-capture files.
- Hourly processing can consume them later.
- The widget does not attempt full analysis on every utterance.
- Steve can mark a segment as reminder, task, meeting note, or thought.

## P2 Requirements

These are later expansion lanes.

### P2.1 Direct Line / Copilot Agent Context Lane

If real-time enterprise context is needed, Natively can call a Steve-configured Copilot agent through Direct Line.

Rules:

- It is opt-in.
- It is clearly labeled as live enterprise retrieval.
- It is not required for normal brain-first response.
- It logs provenance and latency.

### P2.2 Background Computer-Use Actions

Trope CUA or similar tools can be used for approved background workflows.

Rules:

- Only approved workflows.
- No foreground disruption.
- Receipts are stored.
- Failures become action outcomes, not silent state.

### P2.3 Autonomy Ladder

Natively can earn trust over time.

Levels:

- Level 0: Observe only.
- Level 1: Suggest action.
- Level 2: Draft action for approval.
- Level 3: Execute approved repeated action.
- Level 4: Execute narrow low-risk actions with post-hoc review.
- Level 5: Full autonomy for specific proven workflows.

Promotion requires repeated successful outcomes and low edit/rejection rates.

## Data Contracts

### Prep Packet

Required fields:

- `packetId`
- `meetingId`
- `title`
- `window`
- `freshness`
- `summary`
- `keyContext`
- `risks`
- `suggestedTalkingPoints`
- `openQuestions`
- `sourceRefs`

### Cortex Insight

Required fields:

- `insightId`
- `createdAt`
- `topic`
- `observation`
- `strategicImplication`
- `confidence`
- `confidenceFactors`
- `alternativeInterpretations`
- `sourceRefs`
- `suggestedActions`

### Action Proposal

Required fields:

- `proposalId`
- `createdAt`
- `sourceInsightRefs`
- `proposal`
- `approvalState`
- `riskLevel`
- `executionTarget`
- `outcomeRef`

Existing brain proposal files may use nested proposal fields. Natively should support the existing shape and normalize internally instead of forcing the brain to rewrite history.

### Workflow Run

Required fields:

- `runId`
- `workflowName`
- `createdAt`
- `status`
- `trigger`
- `inputs`
- `steps`
- `approvalEvents`
- `executionEvents`
- `outcomeRef`

### Outcome

Required fields:

- `outcomeId`
- `createdAt`
- `proposalId`
- `decision`
- `finalAction`
- `result`
- `userEdits`
- `lessons`

## UX Surface Contracts

### Meeting Coach

Output should be speakable and short.

Allowed formats:

- `Say this`
- `Clarify`
- `Correct`
- `Heads up`
- `Ask`

### Reactive Q&A

Output should answer the question first, then provide context.

Rules:

- No generic summary padding.
- If unsure, say what is missing.
- Prefer one strong answer over five vague options.
- Trace/provenance should be available, but not forced into the main response.

### Meeting Prep

Output should be deterministic.

Required sections:

- Current meeting objective.
- Most relevant recent context.
- Decisions likely to come up.
- Commitments Steve may need to honor.
- Suggested talking points.
- Open questions.
- Risks.

### Action Cards

Cards should be compact and decision-oriented.

Required actions:

- Approve.
- Edit.
- Reject.
- Defer.
- Explain.

## Performance Targets

These are product targets, not theoretical ideals.

- App visible after launch: 3 seconds or less on the packaged build.
- Widget open/close response: 300 ms or less.
- Prompt accepted and status shown: 500 ms or less.
- First streamed token or meaningful status update: 2 seconds or less.
- Brain read model initial load: 1 second or less for current file sizes.
- No silent chat request longer than 90 seconds.
- Voice no-speech warning: no more than once every 20 seconds.
- Dropdown open: 150 ms or less.

## Reliability Targets

- Brain read failure does not crash widget.
- Missing prep packet produces a readiness warning.
- Missing model auth produces a model-specific error.
- Missing microphone permission produces a microphone-specific error.
- External connector failures do not block chat unless Steve explicitly invoked that connector.
- Legacy workflow monitors are disabled unless explicitly enabled.

## Build Order

### First

Make the existing app trustworthy:

- Stop launch side effects.
- Fix widget chat lifecycle.
- Fix model routing visibility.
- Fix dropdown visibility.
- Fix voice diagnostics.
- Validate brain-first answers.

### Second

Make meeting intelligence durable:

- Finish Cortex brain job runbook.
- Finish prep packet refresh runbook.
- Add depth eval.
- Render action proposals and outcomes cleanly.

### Third

Add autonomy carefully:

- Add live capture dump lane.
- Add Direct Line/Copilot lane if needed.
- Add workflow-run approvals.
- Add autonomy ladder promotion rules.

## Release Gates

Before Steve relies on Natively onsite:

- `npm run validate:brain` passes.
- `npm run build` passes.
- `npm run build:electron` passes.
- Packaged app opens without starting Cluely.
- Packaged app opens without FMD notifications.
- Widget can answer a brain-backed question with GPT 5.5.
- Widget can stop a long-running request.
- Deepgram voice flow shows mic input and transcript receipt.
- Model dropdown remains readable in light theme.
- At least one prep packet renders from the brain.
- At least one action proposal renders from the brain.

## Strategic Guardrail

The failure pattern across Prism, Prism-v2, meeting-widget, and early Natively was not ambition. The ambition is correct.

The failure pattern was collapsing too many responsibilities into one live UI runtime before the data contract, trust boundary, and observability were strong enough.

The corrected pattern is:

1. Brain repo owns durable intelligence.
2. Natively owns the fast human touchpoint.
3. Actions require explicit trust states.
4. Outcomes teach the system over time.
5. Every hidden capability needs a visible trace.
