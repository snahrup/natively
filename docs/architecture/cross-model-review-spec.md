# Cross-Model Review Spec

Last updated: 2026-04-11

Purpose:
- Allow the user to manually send a generated answer or draft through a second model for review.
- Preserve the benefits of multiple subscriptions without recreating Prism’s "one agent does everything" problem.

## 1. Product Goal

The feature should feel like:

- "Review this with GPT-5.4 so it sounds more like me"
- "Cross-check this with Codex for technical rigor"
- "Rewrite this meeting answer so I can say it naturally"

It should not feel like:

- a recursive model argument
- a hidden background chain
- a generic "try another model" roulette wheel

## 2. UX Contract

The review action lives on an existing assistant message.

Example controls:

- `Review with GPT-5.4`
- `Cross-check with Codex`
- `Make this sound like me`

The output appears as a sibling review block or message with:

- review intent
- reviewer model
- reviewed content
- optional issues found

User actions:

- `Replace original`
- `Keep both`
- `Copy`

## 3. Hard Rules

1. User-triggered only
2. One review hop only
3. No recursive review on reviewed messages
4. No silent overwrite
5. No auto-send after review
6. Fixed reviewer by intent

## 4. Routing Matrix

### Voice / outbound writing

- primary likely source: any model
- reviewer: `GPT-5.4`
- intent: `voice_pass`

Use cases:
- email draft
- Teams draft
- meeting follow-up
- leadership note

### Technical rigor

- primary likely source: any model
- reviewer: `Codex`
- intent: `technical_check`

Use cases:
- code answer
- system design response
- importer logic explanation
- architecture rationale

### Speakability rewrite

- primary likely source: `Codex` or another technical model
- reviewer: `GPT-5.4`
- intent: `speakable_rewrite`

Use cases:
- what to say in a meeting
- concise executive explanation
- natural spoken reformulation

## 5. Data Contract

The review request should include:

- original message text
- user prompt that led to it
- current surface
- current model
- requested review intent
- optionally the evidence block used to produce the original answer

The review response should include:

```ts
type CrossModelReviewResult = {
  reviewIntent: "voice_pass" | "technical_check" | "speakable_rewrite";
  reviewerModel: string;
  reviewedText: string;
  findings?: string[];
  replaceRecommended?: boolean;
};
```

## 6. Implementation Notes

- renderer:
  - add review buttons to assistant messages
  - suppress review buttons on reviewed outputs
- IPC:
  - add `chat:review-message`
- main process:
  - route review intent to fixed model path
  - preserve provenance in interaction logs
- storage:
  - keep the reviewed output as a separate interaction record, linked to the original

## 7. Safety / Prism Prevention

This feature is allowed specifically because it is bounded:

- manual
- explicit
- fixed reviewer
- fixed schema
- no tool execution

That keeps it from becoming a free-form multi-agent orchestration layer.

