# Eval Harness Spec

## Goal

Stop changing retrieval without a regression check.

## Required Eval Sets

- prep packet relevance
- meeting coach correction quality
- stale OCR suppression
- participant matching
- contradiction handling
- commitment extraction quality

## Each Eval Should Measure

- top evidence correctness
- final output usefulness
- hallucination rate
- wrong-source contamination

## Minimum Harness Shape

- fixtures as JSON
- expected top sources
- expected confidence floor
- human-readable failure output
