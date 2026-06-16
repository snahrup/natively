# Header

Read before changing the Natively live widget, overlay controls, meeting coaching behavior, or screen-share stealth behavior.

# Content

The widget should keep high-stakes meeting controls directly accessible in the live overlay instead of hiding them several layers deep in settings. Controls that affect how Steve appears during a meeting, how aggressively Natively assists, or whether Natively appears in screen shares belong in the compact widget control row.

Keep the light theme as a first-class experience. Dark mode should be available instantly, but light mode is not a fallback or secondary path.

# Learnings

- [2026-05-20] Completed Natively meetings should automatically export raw transcript evidence and extractive summaries into `ipcorp-architecture-brain/natively/meeting-captures`, splitting long sessions when topics/time windows shift; canonical project-memory promotion remains a brain/Cortex review step.
- [2026-05-19] Wake-word screen questions such as "Natively, what's on my screen?" should work whenever proactive listening is enabled, not only after the meeting runtime has marked a meeting active.
- [2026-05-19] Persist Steve's profile display name globally, but keep diarized speaker-number mappings meeting-scoped because STT speaker IDs are not stable across meetings.
- [2026-05-19] Proactive meeting coaching must never emit canned instant keyword drafts; speed cannot come from generic scripts that ignore transcript and screen context. If there is no grounded signal, stay quiet.
- [2026-05-19] When live audio cannot reliably separate Steve from other speakers, the widget should expose meeting-scoped speaker labels so Steve can name diarized speakers and mark his own voice as self before proactive coaching acts on the transcript.
- [2026-05-19] Proactive meeting coaching must not depend only on the system-audio lane; when system audio is unavailable but microphone transcription is flowing, mic transcript frames should still be eligible to trigger live coaching.
- [2026-05-18] If Nexus is unreachable during Natively work, treat it as an immediate recovery task: inspect the Nexus/Conductor launch state, start the desktop launchers if needed, and only then continue feature work.
- [2026-05-13] Steve wants screen-share hiding/undetectable mode exposed as a widget button beside theme and proactive coaching controls.
- [2026-05-13] Live proactive meeting coaching must optimize for voice-agent-speed first responses; deeper GPT 5.5 xhigh reasoning belongs in prep, digestion, and insight jobs instead of the live reflex lane.
- [2026-05-13] Proactive meeting cards must show live relative age and auto-scroll to the newest card so Steve does not accidentally read stale guidance.
- [2026-05-13] Interim proactive meeting triggers must be governed by overlap-aware dedupe and repeated draft suppression so the widget does not loop on the same guidance while the transcript is still changing.
- [2026-05-13] Natively should borrow Pipecat's explicit realtime pipeline boundary for live audio routing and Inferable's durable workflow-run ledger for prep, digestion, approval, and execution jobs instead of letting background work happen invisibly.
- [2026-05-13] Startup should not perform automatic LLM recovery work by default; stale meeting recovery must be explicit or feature-flagged so opening Natively does not unexpectedly launch Codex/Claude requests.
- [2026-05-13] Meeting prep should infer intent automatically from invite title, description, attendees, location, and brain matches; asking Steve for a one-line summary should be an optional low-confidence enhancement, not a required prep step.
- [2026-05-13] Natively is one resident runtime with multiple surfaces: the live widget, signal dashboard, and tray controls must not behave like mutually exclusive modes. Opening the launcher during an active meeting should not hide or downgrade the live overlay/runtime.
- [2026-05-13] The live widget needs an explicit bottom-row dashboard button; relying on the logo as the only way back to the main Natively dashboard is too hidden during real use.
- [2026-05-13] Calendar-backed meetings can produce NotebookLM infographics after normal meeting save/indexing, but only as a non-blocking post-meeting artifact job and only when the meeting duration is at least 10 minutes.
- [2026-05-29] Shared Claude model defaults should come from `C:\Users\snahrup\CascadeProjects\.env`; Opus 4.8 effort labels are Low, Medium, High (default), Extra, and Max, with CLI/env values stored lowercase such as `max`.
