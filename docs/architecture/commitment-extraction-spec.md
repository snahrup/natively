# Commitment Extraction Spec

## Purpose

Durable reminders should come from extracted commitments, not just vibes or OCR fragments.

## Sources

- meeting action items
- imported summaries
- transcript lines with explicit commitments
- future email / Teams asks

## Output

Emits `task_or_commitment` documents.

## Minimum Fields

- normalized commitment text
- source meeting or thread
- created time
- participants when known

## Rules

- prefer explicit action-item lists over heuristics
- transcript heuristics are fallback only
- duplicate commitments should collapse
- a commitment without provenance should not surface as high-confidence
