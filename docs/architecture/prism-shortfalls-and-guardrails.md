# Prism Shortfalls And Natively Guardrails

Last updated: 2026-04-11

Purpose:
- Capture the specific failure modes that made Prism and Prism v2 feel powerful but unreliable.
- Convert those failure modes into explicit guardrails for Natively.
- Prevent architecture drift as more integrations and agent capabilities are added.

## 1. Core Diagnosis

Prism did not fail because it had ambitious ideas.
It failed because too many ambitious ideas were allowed to share the same runtime path without strong boundaries.

The recurring pattern was:

- too many roles inside one product surface
- too many capabilities visible to the model at once
- too many hidden retrieval and prompt injection paths
- too much ambiguity around what was read-only versus action-taking
- too little user visibility into what the system actually knew and why it said what it said

Natively should keep the ambition and remove the ambiguity.

## 2. Primary Prism Shortfalls

### A. Role Confusion

Prism often behaved like several products at once:

- meeting coach
- proactive executive assistant
- Jira/Teams/email operator
- memory engine
- file/system automation agent
- general chat assistant

That made the model uncertain about which behavior contract applied at any given moment.

### B. Capability Overexposure

Too many tools and actions were effectively in the same reasoning surface.
When the model sees too many possible actions, it becomes less decisive and less reliable.

### C. Hidden Side Channels

Prompt-time stuffing, sidecar memory injection, and feature-specific retrieval shortcuts made it hard to predict why the system responded the way it did.

### D. Weak Trust Separation

Observed context, durable context, OCR, memory, chat history, and external system data were not always clearly ranked against each other.

### E. Automation Before Reliability

Prism repeatedly drifted toward “do the thing automatically” before the read-side context, ranking, and confidence model were mature enough.

### F. Poor User Observability

The user could not always tell:

- what context was loaded
- which sources were connected
- why a recommendation appeared
- whether a system action was staged or real
- whether a feature was live, partial, or fallback

### G. Lack Of Evaluation Discipline

Too many important behaviors shipped without enough regression fixtures for:

- retrieval quality
- prep relevance
- contradiction handling
- commitment extraction
- stale-context suppression

## 3. Natively Guardrails

These rules are non-negotiable.

### Guardrail 1: One Shared Context Engine

No new feature gets its own hidden retrieval or prompt injection path.

All meaningful context sources must pass through:

- shared document schema
- shared ingestion rules
- shared retrieval broker
- shared ranking policy
- shared assembly limits

### Guardrail 2: Surface-Specific Behavior Contracts

Every user-facing surface must declare what it is allowed to do.

Approved surfaces:

- `Meeting Coach`
- `Ambient Coach`
- `Meeting Prep`
- `Reactive Chat`
- `Admin / Import / Tools`

No surface should silently inherit the behavior of another.

### Guardrail 3: Read-First Before Write

Every new integration must prove read quality before write-side automation is normalized.

Order:

1. discover
2. read
3. normalize
4. rank
5. explain
6. draft
7. explicit confirm
8. execute

### Guardrail 4: Actions Must Be Explicit

Side-effecting actions must render as explicit user-visible proposals before execution unless there is a narrow, intentionally approved exception.

Examples:

- send email
- send Teams message
- create calendar invite
- edit files
- run MCP/system actions

### Guardrail 5: OCR Is Useful, Not Sovereign

OCR should be treated as opportunistic evidence, not the source of truth.

Ranking order should generally be:

1. native durable system records
2. imported durable records
3. live transcript
4. user-confirmed interaction history
5. OCR observations

### Guardrail 6: Every Capability Must Declare Its Boundaries

Every feature must answer:

1. What documents does it emit?
2. Are they durable or ephemeral?
3. What trust tier do they have?
4. Which surfaces can consume them?
5. Which surfaces are forbidden from consuming them?
6. What user-visible state shows whether it is working?
7. What happens when it fails?

### Guardrail 7: No Giant Capability Dumps Into The Main Prompt

Tooling must be routed and filtered before the model sees it.

The model should not reason over the full universe of Outlook, Teams, MCP, filesystem, calendar, and context tools on every turn.

### Guardrail 8: Every Integration Needs Provenance

Imported or generated records must retain:

- source system
- source artifact ID if available
- imported timestamp
- fidelity status
- exact versus reconstructed status

### Guardrail 9: Ship Visibility With Capability

If a new source matters, the user must be able to see:

- connected / disconnected
- last sync or last ingest
- number of records loaded
- whether data is original or reconstructed
- health / warnings

### Guardrail 10: Release Gates Must Be Concrete

No major integration should be called “done” until it has:

- source discovery working
- deterministic import path
- provenance retention
- context retrieval tests
- UI visibility
- failure-path handling
- packaging verification if it is user-facing

## 4. Integration-Specific Rules

### Cluely Import

- Do not claim perfect fidelity until actual payloads are verified.
- Preserve original artifacts where available.
- Mark reconstructed summaries or usage explicitly.

### Teams Historical Import

- Prefer native Teams transcript/recap over self-generated STT.
- Use local recordings as fallback, not primary truth.
- Keep access limitations explicit when the meeting was recorded by someone else.

### Future Teams Auto-Ingest

- Never ingest a recording on first file-create event.
- Wait for OneDrive sync completion and file stability.
- Calendar-link and dedupe before indexing.

### MCP / Desktop Commander

- Read-only first.
- Separate read, write, and destructive permission tiers.
- Never expose broad filesystem mutation tools to meeting mode.

## 5. Product Litmus Test

A feature is allowed if it makes Natively more decisive, more visible, and more reliable.

A feature is not allowed if it merely makes Natively more impressive on paper while making the actual runtime more ambiguous.

