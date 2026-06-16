# Brain-Side Cortex For Natively Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Natively around a single durable source of truth: the IP Corp architecture brain repo. Natively should be the thin touchpoint that reads prepared context, displays meeting intelligence, captures explicit user feedback, and presents action approval cards. It must not become the analyzer, crawler, or hidden live-source retriever.

**Architecture:** Heavy context processing runs outside the widget and writes read models into `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively`. Natively reads those files, answers from them, and only touches Outlook/Teams/Microsoft APIs for an explicit approved write action. Cortex-style intelligence lives as a brain-side job with a durable insight/action/outcome ledger.

**Tech Stack:** Electron + TypeScript + React + Vite in Natively; JSON/Markdown read models in `ipcorp-architecture-brain`; GPT 5.5 with extra-high reasoning for the Cortex insight job; Claude Opus 4.8 via Claude Agent SDK/OAuth only where Claude-specific work is intentionally chosen.

---

## Non-Negotiable Product Boundary

Natively reads context from:

- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\status.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\meeting-index.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\prep-packets\*.packet.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\cortex\latest-run.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\cortex\insights\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\action-proposals\*.json`
- `C:\Users\snahrup\CascadeProjects\ipcorp-architecture-brain\natively\live-captures\*.jsonl` only as already-written brain input, not as live widget analysis

Natively does not read context from:

- Teams during widget use
- Outlook during widget use
- Notion during widget use
- Semantica
- Cluely
- screenshots/OCR as an authority source for IP Corp memory

The only exception is explicit approved action execution. Example: the brain proposes a Teams reply, Natively renders an approval card, Steve approves, and Natively sends that specific message.

## Why Prism Worked And Prism-v2 Failed

Original Prism Cortex worked because it was a dedicated strategic analyst. It preserved hypotheses, reasoning chains, alternatives considered, confidence factors, provenance, and action recommendations.

Prism-v2 failed because it collapsed Cortex into a generic memory consolidation agent. It kept the word "Cortex" but dropped the actual intelligence contract. It produced thinner insight objects, lost reasoning/provenance/confidence, and never established a reliable action loop.

The rebuild must preserve the original Cortex depth, but move it out of Natively's live runtime.

## Target Read Model Contracts

### Prep Packet

Path: `ipcorp-architecture-brain\natively\prep-packets\<meeting>.packet.json`

Required fields:

```json
{
  "id": "weekly-fabric-margin-standardization",
  "title": "Weekly Fabric Check-in: Margin Standardization",
  "startsAt": null,
  "attendees": ["Steve Nahrup", "Patrick Stiller"],
  "summary": "Short meeting-specific prep summary.",
  "whyItMatters": "Why this meeting matters now.",
  "currentState": ["Known fact or state."],
  "relatedWork": ["Related initiative."],
  "openQuestions": ["Question to clarify."],
  "openCommitments": ["Owner: commitment and source."],
  "talkingPoints": ["Point Steve should be ready to make."],
  "risks": ["Risk with severity."],
  "suggestedPosture": "How Steve should approach the conversation.",
  "evidenceRefs": ["meetings/summaries/..."],
  "liveContextMarkdown": "Compact in-meeting context block."
}
```

### Cortex Insight

Path: `ipcorp-architecture-brain\natively\cortex\insights\<id>.json`

Required fields:

```json
{
  "id": "ctx-2026-05-12-001",
  "type": "pattern|risk|opportunity|blind_spot|relationship|commitment",
  "title": "Insight title",
  "summary": "What was noticed.",
  "createdAt": "2026-05-12T12:00:00-04:00",
  "confidence": 0.82,
  "reasoning": {
    "trigger": "What caused the observation.",
    "observations": ["Evidence point."],
    "connections": ["Cross-meeting connection."],
    "chain": ["Reasoning step."],
    "alternativesConsidered": ["Other explanation."],
    "confidenceFactors": ["Why this confidence is justified."]
  },
  "recommendedAction": "What should happen next.",
  "actionProposalRefs": ["act-2026-05-12-001"],
  "tags": ["fabric", "governance"]
}
```

### Action Proposal

Path: `ipcorp-architecture-brain\natively\action-proposals\<id>.json`

Required fields:

```json
{
  "id": "act-2026-05-12-001",
  "type": "email|teams_message|calendar_event|task|note|follow_up",
  "title": "Draft follow-up to Patrick",
  "summary": "Why this action exists.",
  "status": "proposed",
  "createdAt": "2026-05-12T12:00:00-04:00",
  "relatedInsightIds": ["ctx-2026-05-12-001"],
  "payload": {
    "to": ["person@ip-corp.com"],
    "body": "Draft text here."
  },
  "approval": {
    "required": true,
    "reason": "External communication."
  }
}
```

### Outcome Ledger

Path: `ipcorp-architecture-brain\natively\outcomes\*.jsonl`

Each approval, rejection, edit, snooze, manual override, and autonomous execution gets logged. This is how the system learns Steve's operating model instead of becoming another static note system.

```json
{
  "timestamp": "2026-05-12T12:15:00-04:00",
  "proposalId": "act-2026-05-12-001",
  "decision": "edited_then_approved",
  "originalPayloadHash": "sha256...",
  "finalPayloadHash": "sha256...",
  "editSummary": "Made tone more direct and removed extra explanation.",
  "learningSignals": [
    "Steve prefers direct phrasing with Patrick.",
    "Steve removed generic status language."
  ]
}
```

### Workflow Run

Path: `ipcorp-architecture-brain\natively\workflow-runs\<run-id>.json`

This is the Inferable-style durable execution boundary. A proposal can be displayed by Natively, but every approval or execution creates or updates a workflow run with explicit state, events, autonomy policy, approval metadata, execution receipt, and outcome ledger references.

Required fields:

```json
{
  "id": "run-act-2026-05-12-001-20260512120000",
  "proposalId": "act-2026-05-12-001",
  "proposalType": "email",
  "title": "Draft follow-up to Patrick",
  "state": "waiting_for_approval|approved|executing|completed|failed|rejected|snoozed|blocked",
  "createdAt": "2026-05-12T12:00:00-04:00",
  "updatedAt": "2026-05-12T12:03:00-04:00",
  "payload": {},
  "approval": {
    "required": true,
    "reason": "External communication."
  },
  "autonomy": {
    "level": 1,
    "policy": "explicit-human-approval-required"
  },
  "execution": {
    "adapter": "outlook|teams|ipcorp_architecture_brain|trope_cua",
    "receipt": {}
  },
  "outcomeLedgerRefs": ["natively/outcomes/2026-05-12-natively-outcomes.jsonl"],
  "events": []
}
```

## Implementation Tasks

- [x] Add brain read-model support in `electron/services/BrainReadModelService.ts` for prep packets, Cortex insights, action proposals, and brain-backed context documents.
- [x] Add brain-specific context document types in `electron/context/types.ts`.
- [x] Route `electron/context/ContextRetrievalBroker.ts` through IP Corp brain documents before local memory or ephemeral observations.
- [x] Stop `electron/services/MeetingPrepService.ts` from asking for live Microsoft context while building prep packets.
- [x] Make `electron/services/MeetingPrepService.ts` load matching brain prep packets directly when available.
- [x] Stop active Context Hub status from polling Semantica and mark Semantica as deprecated.
- [x] Stop startup from launching Semantica unless `NATIVELY_ENABLE_SEMANTICA_CONTEXT=1` is explicitly set.
- [x] Update Launcher and Context Hub UI labels from Semantica substrate to IP Corp Brain.
- [x] Pass selected Codex reasoning effort into `electron/LLMHelper.ts` CLI calls so GPT 5.5 extra-high is actually honored.
- [x] Add renderer cards for brain action proposals.
- [x] Add IPC handlers for reading proposals and recording approve/reject/snooze outcomes.
- [x] Add outcome ledger writes for proposal decisions.
- [x] Update the hourly `ip-corp-natively-brain-refresh` automation to GPT 5.5 extra-high and make it responsible for Cortex insights, action proposals, and outcome-learning feedback.
- [x] Add explicit execution handlers for approved email, Teams, and calendar proposals.
- [x] Add explicit execution handlers for approved task and note proposals.
- [ ] Add a brain-side Cortex job prompt/runbook that uses GPT 5.5 extra-high and writes insight/action/outcome-compatible JSON.
- [ ] Add a brain-side packet refresh job that runs before meetings and after transcript/import consolidation.
- [x] Add validation script for brain read models so malformed JSON cannot silently break the widget.
- [ ] Add a small eval set proving original Prism-style Cortex depth is preserved: reasoning chain, alternatives, confidence factors, source refs, and proposed action.

## Autonomy Ladder

Autonomy must be earned per action class.

- Level 0: Observe only.
- Level 1: Propose action card; Steve approves every time.
- Level 2: Propose with learned draft defaults; Steve still approves.
- Level 3: Execute low-risk internal actions after repeated approvals, with post-action notification.
- Level 4: Execute bounded external actions only for narrow, proven patterns.
- Level 5: Broad autonomy is out of scope until the outcome ledger shows durable, repeated alignment.

Promotion requires enough logged outcomes to show that Natively knows what Steve would do in that specific action class. Rejections and edits are as important as approvals.

## Verification

Run these from `C:\Users\snahrup\CascadeProjects\natively`:

```powershell
npm run build:electron
npm run build
```

Manual checks:

- Context Hub shows IP Corp Brain, not Semantica as the active substrate.
- Prep packet loading succeeds from `ipcorp-architecture-brain\natively\prep-packets`.
- Asking the widget a meeting-context question cites brain read models in the ranked context block.
- No widget/prep path calls live Teams, Outlook, Notion, Cluely, or Semantica for context.
- Action proposals are visible but cannot execute without explicit approval.

## Learning Notes

- [2026-05-12] Steve's actual target is a personal operating model, not a chat widget: Natively should learn strengths, gaps, judgment patterns, edits, approvals, rejections, and blind spots over time so it becomes a trusted work partner rather than a crutch.
- [2026-05-12] The Prism-v2 failure mode was promising a cleaner architecture but not enforcing it in code. The rebuild must make the boundary executable: brain repo writes durable intelligence; Natively reads and acts only through explicit contracts.
- [2026-05-12] Upsonic, Inferable, and Trope CUA should be treated as pressure tests, not automatic dependencies. Borrow Inferable's durable run and human approval model most directly; keep Natively thin.
- [2026-05-12] If Nexus is down locally, launch `C:\Users\snahrup\Desktop\Apps\Nexus.bat` and `C:\Users\snahrup\Desktop\Apps\Conductor Launch.bat`, then re-check port 3777 before proceeding without Nexus.
