# Natively Capability Register

Last updated: 2026-04-12

Purpose:

- keep a running source of truth for what Natively actually does
- separate shipped capabilities from in-repo work and actively debugged work
- give leadership/demo prep a defensible artifact tied to real code paths and current architectural decisions

Status legend:

- `shipping-now`: available in the current runtime/build path and validated in this session
- `implemented-repo`: implemented in repo and buildable, but still needs another real-world validation or packaging pass before describing it as fully reliable
- `active-debug`: implemented but currently under active debugging because the user observed material issues
- `active-next`: approved and clearly next, but not closed out yet

## 1. Product Positioning

Natively is a local-first desktop context engine and workflow companion. It watches live screen and meeting context, stores durable meeting memory locally, retrieves ranked evidence across multiple sources, prepares pre-meeting packets, assists during meetings, and can propose or execute real communication actions through local Outlook and Teams bridges.

It is no longer productively described as an interview assistant.

## 2. Capability Inventory

### A. Real-Time Guidance

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Floating overlay and widget shell | `shipping-now` | Persistent desktop overlay for live guidance, quick actions, and chat | `src\\components\\NativelyInterface.tsx`, `src\\components\\GlobalChatOverlay.tsx`, `src\\components\\MeetingChatOverlay.tsx` |
| Live transcript-driven guidance | `shipping-now` | Uses meeting transcript flow to generate live suggestions, clarification, recap, and follow-up help | `electron\\IntelligenceEngine.ts`, `electron\\LLMHelper.ts`, `electron\\ipcHandlers.ts` |
| Screen-aware live assistance | `active-debug` | Reads visible screen content and feeds it into context assembly for meeting and reactive assistance | `electron\\services\\ContinuousOCRService.ts`, `electron\\context\\ContextObservationStore.ts`, `src\\components\\settings\\MeetingAISettings.tsx` |
| Meeting AI mode controls | `shipping-now` | Exposes controls for live memory injection and always-on screen watch | `src\\components\\settings\\MeetingAISettings.tsx`, `electron\\ipcHandlers.ts` |
| Model-selected guidance routing | `implemented-repo` | Routes assistance through the selected `Claude` and `ChatGPT` families using the local Claude command path and Codex CLI path, with plain user-facing model names | `electron\\LLMHelper.ts`, `src\\components\\ui\\ModelSelector.tsx`, `src\\utils\\modelUtils.ts` |

### B. Context Engine

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Unified context document model | `shipping-now` | Normalized context types across meetings, OCR, profile, calendar, interactions, commitments, and imports | `electron\\context\\types.ts`, `docs\\architecture\\context-document-schema.md` |
| Ephemeral observation store | `shipping-now` | Stores OCR, live transcript, and chat interaction artifacts with TTL behavior | `electron\\context\\ContextObservationStore.ts` |
| Ranked retrieval broker | `shipping-now` | Retrieves and ranks context across calendar, profile, meetings, OCR, email, Teams, and memory sources | `electron\\context\\ContextRetrievalBroker.ts`, `electron\\context\\ContextSourceAdapters.ts` |
| Hybrid scoring policy | `shipping-now` | Combines lexical overlap, trust, freshness, participant overlap, source boosts, and focus boosts | `electron\\context\\ContextRetrievalBroker.ts` |
| Durable meeting memory | `shipping-now` | Stores meetings, transcripts, summaries, usage, contradictions, and retrieval chunks in SQLite | `electron\\db\\DatabaseManager.ts`, `electron\\services\\MeetingMemoryBrain.ts`, `electron\\services\\ContradictionDetector.ts` |
| Meeting RAG indexing and retrieval | `shipping-now` | Supports chunking, embeddings, vector search, and meeting-level retrieval | `electron\\rag\\RAGManager.ts`, `electron\\rag\\RAGRetriever.ts`, `electron\\rag\\SemanticChunker.ts`, `electron\\rag\\VectorStore.ts` |
| Internal-analysis retrieval bypass | `shipping-now` | Lets background jobs avoid invoking broad mailbox/calendar retrieval unless explicitly needed | `electron\\LLMHelper.ts`, `electron\\services\\ContradictionDetector.ts` |

### C. Meeting Preparation

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Calendar-linked prep packet generation | `shipping-now` | Builds pre-meeting packets with related meetings, profile context, commitments, and likely questions | `electron\\services\\MeetingPrepService.ts` |
| Pre-warm upcoming packet generation | `shipping-now` | Warms packets for upcoming meetings ahead of use | `electron\\services\\MeetingPrepService.ts` |
| Meeting reminders | `shipping-now` | Emits calendar-driven reminders ahead of meetings | `electron\\services\\CalendarManager.ts`, `src\\components\\Launcher.tsx` |
| Source-health visibility for prep state | `implemented-repo` | Exposes enough context state to reason about packet quality and recency | `src\\components\\Launcher.tsx`, `src\\components\\settings\\ContextHubSettings.tsx` |

### D. Communication Actions

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Outlook desktop read access | `shipping-now` | Lists recent emails, searches mailbox context, reads contacts, and reads calendar items | `electron\\services\\OutlookComBridge.ts`, `electron\\services\\MicrosoftLocalManager.ts` |
| Outlook draft/send/reply actions | `implemented-repo` | Creates drafts, sends emails, and replies through local Outlook | `electron\\services\\OutlookComBridge.ts`, `src\\components\\settings\\MicrosoftActionPanel.tsx` |
| Outlook calendar event creation | `implemented-repo` | Creates calendar events and can send invites through local Outlook | `electron\\services\\OutlookComBridge.ts`, `src\\components\\settings\\MicrosoftActionPanel.tsx` |
| Teams local read access | `implemented-repo` | Reads Teams chats and messages through the local Teams desktop path | `electron\\services\\TeamsBridge.ts`, `electron\\services\\MicrosoftLocalManager.ts` |
| Teams send action | `implemented-repo` | Sends Teams messages through the desktop bridge | `electron\\services\\TeamsBridge.ts`, `src\\components\\settings\\MicrosoftActionPanel.tsx` |
| Manual Microsoft Actions panel | `shipping-now` | Gives a user-visible testing and execution surface for email, Teams, and calendar actions | `src\\components\\settings\\MicrosoftActionPanel.tsx`, `src\\components\\SettingsOverlay.tsx` |
| Inline action proposal cards | `implemented-repo` | Chat can render structured action cards instead of raw text proposals | `electron\\services\\AgentActionPlanner.ts`, `src\\components\\ui\\InlineActionProposalCard.tsx`, `src\\components\\NativelyInterface.tsx`, `electron\\ipcHandlers.ts` |
| Cross-model review button flow | `active-next` | Intended review-with-other-model path, but not yet stable enough to present as a closed capability | planned across `src\\components\\NativelyInterface.tsx` and `electron\\ipcHandlers.ts` |

### E. Calendar And Scheduling

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Google Calendar OAuth integration | `shipping-now` | Connects to Google Calendar and fetches upcoming events | `electron\\services\\CalendarManager.ts` |
| Outlook calendar via local Outlook | `shipping-now` | Pulls upcoming Outlook events through the local Outlook bridge | `electron\\services\\CalendarManager.ts`, `electron\\services\\OutlookComBridge.ts` |
| Unified calendar event model | `shipping-now` | Normalizes Google and Outlook events into one structure | `electron\\services\\CalendarManager.ts`, `src\\types\\electron.d.ts` |
| Meeting launch / entry surface | `shipping-now` | Upcoming meetings can trigger the meeting workflow from launcher surfaces | `src\\components\\Launcher.tsx`, `electron\\MeetingPersistence.ts` |

### F. Historical Knowledge And Import

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Manual meeting artifact import | `shipping-now` | Imports transcripts, summaries, notes, and usage text from pasted text or files | `electron\\services\\MeetingImportService.ts` |
| Source-aware import parsing | `shipping-now` | Detects Cluely, Teams, or generic imports and groups artifacts into meetings | `electron\\services\\MeetingImportService.ts` |
| Imported meetings stored in main memory layer | `shipping-now` | Imported meetings land in the same DB and retrieval layer as native meetings | `electron\\services\\MeetingImportService.ts`, `electron\\db\\DatabaseManager.ts`, `electron\\services\\MeetingMemoryBrain.ts` |
| Background post-import enrichment | `shipping-now` | Runs contradiction analysis and follow-up processing asynchronously after visible import completion | `electron\\services\\MeetingImportService.ts`, `electron\\services\\ContradictionDetector.ts` |
| Fail-fast import truthfulness | `shipping-now` | Imports now fail if persistence is unavailable instead of lying about success | `electron\\db\\DatabaseManager.ts`, `electron\\services\\MeetingImportService.ts` |
| Imported meeting visibility in app | `shipping-now` | Context Hub shows recent imported meetings directly in the UI | `src\\components\\settings\\ContextHubSettings.tsx` |
| Cluely one-click importer | `active-debug` | Keeps `cluely-v2` as the primary profile, uses live-capable fallback tokens when available, and now emits explicit stale-token warnings, but Cluely runtime changes still make it unreliable | `electron\\services\\CluelyImportService.ts` and related local evidence |
| Teams historical importer | `implemented-repo` | Teams meeting import path is materially further along and expected to be the stronger transcript source | `electron\\services\\TeamsMeetingImportService.ts`, `electron\\services\\TeamsBridge.ts` |
| Teams-over-Cluely authority strategy | `implemented-repo` | Same-meeting imports now merge into one durable meeting record and prefer Teams transcript authority over Cluely while preserving extra summary/artifact data | `electron\\services\\MeetingImportService.ts`, `docs\\architecture\\context-source-authority.md` |

### G. Context Visibility And Explainability

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Context Engine Overview on launcher | `shipping-now` | Gives an at-a-glance summary of context totals, freshness, and recent imported meetings | `src\\components\\Launcher.tsx` |
| Context Hub imported-history surface | `shipping-now` | Lets the user verify imported meeting records directly | `src\\components\\settings\\ContextHubSettings.tsx` |
| Chat telemetry / debug visibility | `implemented-repo` | Preserves chat timestamps and response timing to support product debugging | current chat logging and debug surfaces across `src` and `electron` |
| Screen-grounding debug snapshot | `implemented-repo` | Durable chat debug now captures explicit screen-read intent plus the freshest OCR excerpt, age, and display count visible at response time | `electron\\ipcHandlers.ts`, `electron\\db\\DatabaseManager.ts`, `src\\components\\settings\\ContextHubSettings.tsx` |
| Refresh propagation after imports | `shipping-now` | Broadcasts meeting updates so launcher/context surfaces refresh immediately | `electron\\ipcHandlers.ts` |

### H. Models And Provider Flexibility

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Claude local command routing | `implemented-repo` | Supports Sonnet 4.6 and Opus 4.6 selection under plain `Claude` naming while routing through the local Claude command flow | `src\\utils\\modelUtils.ts`, `electron\\LLMHelper.ts` |
| ChatGPT local CLI routing | `implemented-repo` | Supports ChatGPT 5.x family selection under plain `ChatGPT` naming while routing through Codex CLI | `src\\utils\\modelUtils.ts`, `electron\\LLMHelper.ts` |
| Ollama local model workflows | `shipping-now` | Supports local inference and embeddings via Ollama | `electron\\services\\OllamaManager.ts`, `electron\\rag\\providers\\OllamaEmbeddingProvider.ts` |

### I. Speech And Audio

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Multi-provider STT stack | `implemented-repo` | Supports multiple STT providers across the Electron audio stack | `electron\\audio\\*`, `src\\config\\stt.constants.ts` |
| Streaming/fallback STT behavior | `implemented-repo` | Supports streaming where available with alternate fallback paths | `electron\\audio\\OpenAIStreamingSTT.ts`, `electron\\audio\\RestSTT.ts`, `electron\\audio\\GoogleSTT.ts`, `electron\\audio\\SonioxStreamingSTT.ts`, `electron\\audio\\NativelyProSTT.ts` |
| Transcript-backed live context | `shipping-now` | Pushes live transcript artifacts into the context engine | `electron\\IntelligenceEngine.ts`, `electron\\context\\ContextObservationStore.ts` |

### J. Privacy, Locality, And Desktop Productization

| Capability | Status | What it does | Primary code paths |
|---|---|---|---|
| Local SQLite meeting memory | `shipping-now` | Stores core meeting and context artifacts locally | `electron\\db\\DatabaseManager.ts` |
| Canonical shared runtime store | `shipping-now` | Current runtime prefers the canonical Natively appData store when present | `electron\\db\\DatabaseManager.ts` |
| Local-first Microsoft integrations | `shipping-now` | Uses local Outlook/Teams surfaces instead of Graph-admin dependency for core flows | `electron\\services\\OutlookComBridge.ts`, `electron\\services\\TeamsBridge.ts` |
| Native packaged desktop app | `shipping-now` | Ships as an Electron desktop app, not just a dev shell | `package.json`, `docs\\RELEASE.md` |
| Auto-update infrastructure | `implemented-repo` | Update surface exists, though release/version hygiene still requires disciplined packaging practice | `src\\components\\UpdateBanner.tsx`, `src\\components\\UpdateModal.tsx` |

## 3. Leadership-Level Highlights

These remain the strongest defensible talking points:

1. Natively is not just a chatbot. It is a local desktop operating layer for meetings and workflow.
2. It combines live transcript, screen context, calendar context, prior meetings, imported history, and durable memory into one ranked context engine.
3. It can already read and act through local Outlook and Teams bridges rather than only generating passive text.
4. It supports pre-meeting prep packets, not just reactive Q&A.
5. It is local-first and can run against local models, local sessions, and local desktop integrations.
6. The architecture is increasingly explicit about source authority, retrieval boundaries, and user-visible inspectability.

## 4. Honest Boundaries

These should be stated clearly:

- Screen-grounding behavior still needs another focused validation pass.
- The local-only Claude/Codex routing still needs one more real runtime validation pass under the current desktop-auth setup.
- Cluely one-click historical import is not yet reliable enough to present as solved.
- The earlier "successful" Cluely imports performed before the SQLite fix were false-success imports and were not persisted.
- Broader service-orchestration work for Nexus/Conductor/Billboard/ClawMem remains unfinished and should not be oversold.

## 5. Maintenance Rule

Every material capability change should update this file, the architecture docs, and the Mermaid maps in the same working session.
