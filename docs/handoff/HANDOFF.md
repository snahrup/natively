# HANDOFF.md — latest session handoff

---

## Handoff: 2026-06-12 (afternoon)

**Full document: [2026-06-12-dependability-fixes-handoff.md](./2026-06-12-dependability-fixes-handoff.md) — read that, it is the authoritative handoff.**

### Current Task State
68-finding dependability audit COMPLETE (report: `docs/audit/2026-06-12-dependability-audit.md`; work queue: `.tmp/audit-digest-tight.md`). Fix implementation STARTED but no code written yet — Critical #1 (incremental transcript persistence) fully investigated with a ready implementation plan (handoff doc §4).

### Key Decisions
- **Natively is the base** — Prism / prism-v2 abandoned, do not re-evaluate
- **Fix order:** 2 criticals → 32 highs (P0 data-loss/silent-failure cluster first) → mediums
- **Microsoft Graph:** unblock = Entra app registration ask to IP Corp IT (delegated read-only scopes); GraphIngestService → brain repo later, not part of this fix sweep
- Use `@anthropic-ai/claude-agent-sdk` (never raw API) if replacing CLI spawns in the streaming fix
- Steve requires Fable 5 for this work

### Modified Files
None this session (docs/audit/, docs/handoff/, .tmp/ artifacts only). Working tree carries ~5,700 lines of Steve's PRE-EXISTING WIP across 46 files — do not revert; ask Steve about commit strategy before layering fixes.

### Next Steps
1. Ask Steve: commit his WIP first, or stage only fix files
2. Implement Critical #1 per handoff §4 (meetingId at start, 15s incremental flush, before-quit flush, recovery-on-by-default without auto-LLM)
3. Critical #2: honor requestProfile/reasoningEffort on Claude CLI path (LLMHelper.ts:92-95, 751-767)
4. P0 STT cluster, then P1 latency cluster (handoff §6)

### Critical Context
better-sqlite3 is synchronous (safe in before-quit). `saveMeeting()` delete-and-reinserts child rows — final save dedupes incremental flushes for free. SessionTracker compaction slices `fullTranscript` — flush index must survive the slice. Recovery gate exists because of "no auto model calls on launch" — preserve that rationale (recover data always, LLM pass lazily). `npm run build:electron` to typecheck; no tests exist.

---
