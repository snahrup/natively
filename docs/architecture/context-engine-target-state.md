# Context Engine Target State

Last updated: 2026-04-12

## Purpose

Natively should not grow by bolting on more prompt injections, sidecar memory systems, or feature-specific retrieval hacks.

The target system is a constrained context engine with:

- one ingestion contract
- one retrieval contract
- one ranking contract
- one assembly contract
- a small number of output surfaces

This is how the product stays legible as more sources and features are added.

## Primary Product Goal

Natively is a proactive desktop companion that:

- understands what the user is doing now
- remembers durable context that matters later
- prepares the user for meetings before they start
- intervenes during meetings with concise, speakable guidance
- reminds the user about follow-ups, risks, and commitments
- gives the user visible, inspectable proof of what context is actually loaded

It is not a generic chatbot, not a magical omniscient agent, and not an uncontrolled automation system.

## Core Principles

1. OCR is opportunistic, not authoritative.
Visible screen content is useful live context, but it is not a system of record.

2. Structured integrations outrank OCR.
Calendar, email, Teams, and stored meeting data are more durable and more trustworthy than whatever happened to be visible on screen.

3. Retrieval must be source-agnostic.
Every source enters the same retrieval pipeline instead of each feature inventing its own ranking logic.

4. Assembly must be bounded.
The model should receive a small, ranked evidence set, not a giant stitched prompt.

5. Surface behavior must be mode-specific.
Meeting coaching, ambient nudges, prep packets, action proposals, and chat should share the same evidence layer but not the same output contract.

6. Proactive behavior must be read-first.
The system should observe, prepare, summarize, and recommend before it ever sends or mutates anything.

7. The user must be able to inspect what the engine knows.
Important context cannot remain invisible if the product is expected to be debuggable or trustworthy.

## Resolved Implementation Decisions As Of 2026-04-12

### Decision 1. Natively Is The Authoritative Context Engine

ClawMem may later enrich retrieval, but Natively owns the authoritative context model, persistence, retrieval, and output assembly path.

### Decision 2. Imported Meetings Must Land In The Same Durable Meeting Model

Historical Cluely, Teams, and manual imports are not second-class artifacts. They must resolve into the same meeting memory layer as native Natively meetings.

### Decision 3. Import Success Means Persistence Succeeded

The product must not display a successful import unless the meeting record was actually written into durable storage and queued for downstream indexing.

### Decision 4. Dev And Installed Builds Should Converge On A Canonical Store

When a canonical `appData\\natively` store exists, the app should prefer it over an isolated `natively-dev` store. A split persistence story makes the product impossible to reason about.

### Decision 5. Internal Background Analysis Must Not Automatically Invoke Full Retrieval

Internal contradiction detection, cleanup, or enrichment jobs should be able to call the LLM without dragging the mailbox/calendar/Teams retrieval path into background processing unless explicitly needed.

### Decision 6. Teams Transcript Authority Outranks Cluely Transcript Authority

For the same meeting, Teams should be treated as the transcript authority because speaker attribution and transcript quality are generally stronger. Cluely may still contribute summary and usage artifacts.

### Decision 7. Important Context Must Be Visible In Product Surfaces

Launcher/home and Context Hub must expose enough state that the user can confirm whether meetings, imports, and freshness signals are actually present.

## System Boundaries

### In Scope

- ingesting durable meeting memory
- ingesting visible OCR context
- ingesting structured calendar context
- ingesting structured email and Teams context where available through local bridges
- building pre-meeting prep packets
- surfacing live guidance during meetings
- surfacing reminders and follow-ups outside meetings
- rendering proposed actions for user review and confirmation

### Out Of Scope By Default

- autonomous message sending without explicit confirmation
- autonomous email replies without explicit confirmation
- autonomous Teams posts without explicit confirmation
- background action execution without explicit user review
- prompt-time stuffing of entire knowledge bases
- feature-specific retrieval code paths that bypass the shared engine

## Target Architecture

### 1. Source Connectors

Every source must produce normalized records.

Source classes:

- `ocr_observation`
- `meeting_transcript`
- `meeting_summary`
- `calendar_event`
- `email_thread`
- `teams_thread`
- `profile_fact`
- `task_or_commitment`
- `manual_import`
- `chat_interaction`

Each source record should normalize into a shared document shape:

```ts
type ContextDocument = {
  id: string;
  sourceType:
    | "ocr_observation"
    | "meeting_transcript"
    | "meeting_summary"
    | "calendar_event"
    | "email_thread"
    | "teams_thread"
    | "profile_fact"
    | "task_or_commitment"
    | "manual_import"
    | "chat_interaction";
  sourceSystem: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  eventTimeStart?: string;
  eventTimeEnd?: string;
  participants?: string[];
  entities?: string[];
  relatedMeetingIds?: string[];
  trustTier: "authoritative" | "durable" | "observed";
  visibility: "private" | "workspace" | "external";
  freshnessClass: "live" | "recent" | "historical";
  embeddingId?: string;
  lexicalTerms?: string[];
  metadata?: Record<string, unknown>;
};
```

### 2. Ingestion Lanes

There should be two lanes.

#### Durable Lane

For things that should be queryable later:

- meetings
- summaries
- calendar events
- email threads
- Teams threads
- commitments
- imported records
- user-approved promoted observations

This lane persists normalized documents, embeddings, lexical terms, and entity links.

#### Ephemeral Lane

For things that are useful now but not automatically durable:

- current OCR frames
- temporary active-window observations
- transient live session notes
- immediate transcript fragments before normalization

This lane expires aggressively and should not silently become long-term memory unless explicitly promoted.

### 3. Retrieval Modes

There should be one broker with multiple modes.

#### Reactive Retrieval

Used when the user asks a direct question.

Inputs:

- current user query
- active meeting ID if any
- current app state
- current visible OCR context
- current active surface/mode

Output:

- ranked evidence set
- confidence
- recommended response surface

#### Proactive Retrieval

Used when the system decides to intervene.

Triggers:

- upcoming meeting window
- calendar event starting soon
- detected user drift or contradiction
- open commitment nearing deadline
- follow-up overdue

Output:

- ranked evidence set
- reason for trigger
- confidence score
- recommended nudge type

#### Internal Analysis Retrieval

Used for background jobs such as contradiction analysis or summarization cleanup.

Rules:

- must be explicit
- must not automatically invoke mailbox/calendar retrieval
- should default to local record evidence already associated with the meeting/job being processed

## Ranking Model

Ranking should not be pure similarity.

Final score should combine:

- semantic similarity
- lexical overlap
- entity overlap
- participant overlap
- meeting/topic locality
- freshness
- source trust tier
- explicit current focus
- contradiction status

Initial practical formula:

```ts
finalScore =
  0.35 * semanticSimilarity +
  0.20 * lexicalSimilarity +
  0.15 * entityOverlap +
  0.10 * participantOverlap +
  0.10 * freshnessScore +
  0.10 * sourceTrustScore;
```

Then add deterministic boosts:

- same active meeting
- same calendar event
- attendee match
- unresolved commitment
- contradiction correction

And deterministic penalties:

- superseded facts
- stale OCR-only observations
- weak participant/topic match

## Assembly Model

No surface should receive arbitrary prompt stuffing.

The assembly layer should produce:

- `evidence`: top ranked normalized snippets
- `situation`: a short synthesized state card
- `constraints`: what style and mode the output must follow
- `confidence`: low, medium, high

Hard rules:

- cap total evidence tokens
- cap evidence per source type
- never dump full background context blindly
- keep contradiction corrections explicit
- attach machine-readable provenance even if hidden from the user

## Output Surfaces

The same retrieval layer feeds multiple surfaces, but each surface has a distinct contract.

### 1. Meeting Coach

Audience: user speaking live in a meeting.

Output:

- `SAY THIS`
- `CORRECTION`
- `DATA`
- `HEADS UP`

Style:

- first person
- immediately speakable
- short
- no tutorial framing

### 2. Ambient Coach

Audience: user outside a meeting.

Output:

- direct-to-user guidance
- reminders
- warnings
- off-track interventions

Style:

- second person
- direct
- minimal

### 3. Meeting Prep Packet

Audience: user before a meeting.

Output:

- purpose
- attendees
- prior related meetings
- open commitments
- likely questions
- suggested framing

Style:

- scannable
- deterministic
- less generative than live coaching

### 4. Reactive Q&A

Audience: user asking a direct question.

Output:

- answer
- uncertainty when needed
- clear attribution when relevant

Style:

- concise
- evidence-bound

### 5. Action Proposal Surface

Audience: user intending to send or create something.

Output:

- editable action card
- structured fields
- explicit confirmation boundary
- execution result state

Style:

- operational
- visible
- not buried in raw markdown

## Memory Rules

Not everything should become memory.

Promote to durable memory only when:

- it is a meeting artifact
- it is a resolved decision
- it is a durable profile fact
- it is a commitment or task
- it is an imported historical record
- it is an explicit user-save action

Do not promote automatically:

- raw OCR noise
- random web page text
- transient UI fragments
- speculative model outputs

## Integrations Strategy

### Calendar

Should be the scheduling spine.

Responsibilities:

- upcoming meeting detection
- attendees
- start/end times
- prep-packet trigger
- post-meeting linking

### Email

Should be treated as correspondence memory, not as a giant prompt dump.

Responsibilities:

- thread ingestion
- participant normalization
- unresolved ask detection
- follow-up and deadline extraction
- meeting-thread linking

### Teams

Should be treated as both correspondence memory and meeting-memory authority where transcript artifacts exist.

Responsibilities:

- DM/thread ingestion
- commitment extraction
- meeting linkage
- pre-meeting recent-thread summary
- transcript authority for duplicated meeting imports

### OCR

Responsibilities:

- live awareness
- active-window assistance
- visual contradiction detection
- capture of context not available through structured integrations

Not responsible for:

- being treated as the durable system of record

## Guardrails For New Features

No new feature should land unless it answers these questions:

1. What normalized document type does it produce?
2. Is it durable or ephemeral?
3. What retrieval mode uses it?
4. How is it ranked against existing sources?
5. What output surface consumes it?
6. What is the user-visible win?
7. What is the failure mode if retrieval gets it wrong?

If a feature cannot answer those questions, it should not be added yet.

## Anti-Patterns To Avoid

- giant system prompts containing everything we know
- separate hidden retrieval logic for each feature
- mixing OCR observations with durable truth without trust weighting
- letting prompt text substitute for architecture
- direct automation before read-only confidence is proven
- shipping "smart" features without visible inspectability
- reporting import/action success when persistence or execution did not actually succeed

## Evaluation Requirements

Before expanding the engine, maintain a small eval set.

Required eval categories:

- pre-meeting prep relevance
- live correction accuracy
- attendee/person matching
- commitment extraction accuracy
- contradiction handling
- false-positive proactive nudges
- stale-context suppression
- import persistence truthfulness
- same-meeting source conflict resolution

Each eval should measure:

- top evidence correctness
- final answer usefulness
- hallucination rate
- wrong-source contamination
- user-visible inspectability

## Product Constraint

If a new feature makes the system harder to reason about than it makes the user more effective, it should not ship.

That rule matters more than feature count.
