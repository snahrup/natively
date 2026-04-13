# Source Ingestion Contracts

## Durable Sources

### Meetings

- Emits `meeting_summary`
- Emits `meeting_transcript`
- Emits derived `task_or_commitment`

### Manual Imports

- Emits `manual_import`
- Emits derived `meeting_transcript` when transcript-like
- Emits derived `task_or_commitment`

### Calendar

- Emits `calendar_event`
- Must include timing and attendee metadata when available

### Profile Intelligence

- Emits `profile_fact`
- Must stay bounded and structured

### Future Email / Teams

- Emits `email_thread` or `teams_thread`
- Must include participants, timestamps, and durable identifiers

## Ephemeral Sources

### OCR

- Emits `ocr_observation`
- expires automatically
- does not become durable without explicit promotion

### Session Chat

- Emits `interaction`
- used for reactive continuity and recent context

### Live Transcript

- Emits `live_transcript`
- useful during active discussions
- may later be promoted into durable meeting artifacts

## Promotion Rules

A source may become durable only if:

- it is an explicit meeting artifact
- it produces a resolved decision
- it produces a confirmed commitment
- the user explicitly imports or saves it

## Rejection Rules

Do not ingest:

- blank OCR frames
- duplicate transient UI noise
- speculative model output as truth
- unsupported DOM scrape artifacts without timestamps or source identity
