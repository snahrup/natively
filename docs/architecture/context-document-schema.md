# Context Document Schema

## Purpose

Every context source must normalize into the same document contract before retrieval.

## Document Shape

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
    | "interaction"
    | "live_transcript";
  sourceSystem: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  eventTimeStart?: string;
  eventTimeEnd?: string;
  participants?: string[];
  entities?: string[];
  relatedMeetingIds?: string[];
  relatedCalendarEventIds?: string[];
  trustTier: "authoritative" | "durable" | "observed";
  visibility: "private" | "workspace" | "external";
  freshnessClass: "live" | "recent" | "historical";
  lexicalTerms?: string[];
  sourceScore?: number;
  metadata?: Record<string, unknown>;
};
```

## Rules

- `ocr_observation`, `interaction`, and `live_transcript` are ephemeral by default.
- `meeting_summary`, `meeting_transcript`, `manual_import`, `profile_fact`, and `task_or_commitment` are durable.
- `calendar_event` is authoritative for timing and attendees.
- `email_thread` and `teams_thread` are durable once the connectors are enabled.
- A document may be derivable from another source, but it still has to conform to this shape.

## Prohibitions

- no feature-specific hidden context shape
- no raw prompt stuffing as a substitute for normalization
- no source may bypass this schema if it wants retrieval priority
