# Retrieval Broker Spec

## Purpose

One broker ranks evidence for:

- reactive Q&A
- proactive nudges
- meeting coaching
- prep packets

## Inputs

```ts
type ContextRetrievalRequest = {
  query: string;
  surface: "reactive" | "proactive" | "prep" | "meeting";
  activeMeetingId?: string;
  activeCalendarEventId?: string;
  participantHints?: string[];
  includeSourceTypes?: string[];
  excludeSourceTypes?: string[];
  limit?: number;
  maxAgeMs?: number;
};
```

## Ranking Features

- lexical overlap
- source retrieval score when available
- participant overlap
- freshness
- trust tier
- focus boosts for active meeting and active event
- supersession penalties

## Contract

- returns ranked `ContextDocument`s with score breakdowns
- returns a `situation` summary
- returns a coarse `confidence`

## Rules

- no output surface may bypass the broker for evidence selection
- broker ranking must be deterministic enough to debug
- every ranked result must retain provenance
