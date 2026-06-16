# Natively — Design Brief for a Full Visual Redesign

I'm the owner of a desktop app called **Natively** and I want you to reimagine its entire
interface from a blank canvas. I'm deliberately giving you **zero visual direction** — no colors,
no layout opinions, no style references, no "make it look like X." I want your most creative,
original, eye-popping take on what this product could look and feel like. The only thing I'm
locking down is **what the app does and what every screen and feature has to accomplish** — the
function. The form is entirely yours to invent.

Below is a complete functional specification of the product: its purpose, every window/surface,
every feature, every interactive control, and every state those controls move through. Treat it
as the source of truth for *what must exist and work*. Then design freely.

---

## What I need back (read this first — it shapes everything)

I do **not** want flat, static mockups that I then have to reverse-engineer and rebuild from
scratch. I want **working, interactive prototypes** I can lift into the real app with minimal
rework. Concretely:

- **Interactive, not static.** Real, clickable components with real state. Toggles toggle,
  tabs switch, lists scroll, modals open and close, inputs accept text, hover/focus/active states
  exist, transitions and motion are implemented (not just implied in a still frame).
- **Every state, not just the happy path.** For each surface, show and wire: empty state,
  loading/skeleton state, in-progress/streaming state, success state, error state, and any
  "degraded but usable" state. These states are called out per-feature below — they are central
  to this product, not edge cases.
- **Motion and feel are part of the deliverable.** Streaming text, live-updating indicators,
  state transitions, micro-interactions, entrance/exit animation — implement them. How they look
  and move is your call; *that they exist and are wired* is the requirement.
- **Coverage is 1:1.** Every surface and feature in this brief should be represented so the
  result is a true drop-in replacement, not a partial concept. If you must scope down, tell me
  what you cut.
- **Component-structured and integration-ready.** Build it as composable components with clear
  state, so the pieces map onto a real implementation.

**Integration target (so your output drops in cleanly — this is a tech constraint, not a style
constraint):** the current app is an **Electron desktop app** with a **React + TypeScript**
renderer styled with **Tailwind CSS**, using **Framer Motion** for animation and
**lucide-react** for icons; Markdown answers render via **react-markdown** (+ GFM, KaTeX math)
and code via **react-syntax-highlighter**. Output that fits this stack (React/TSX components,
Tailwind, Framer Motion) is ideal. If your environment exports to a different format, that's fine
— just keep it component-based and interactive. **None of this constrains the visual design** —
it only constrains the output format so I can integrate it.

**If you can access the source repository:** please review it end-to-end before designing so your
prototypes are accurate to real behavior. The renderer lives in `src/` (key components:
`src/components/Launcher.tsx`, `NativelyInterface.tsx`, `MeetingDetails.tsx`, `SettingsOverlay.tsx`,
`MeetingChatOverlay.tsx`, `GlobalChatOverlay.tsx`, the `src/components/settings/` folder, and
`src/_pages/`). The desktop/runtime layer is in `electron/` (`main.ts`, `preload.ts`,
`ipcHandlers.ts`) and product-intent docs are in `docs/architecture/`. If you **cannot** access the
repo, this brief is written to be complete enough to build from on its own.

---

## What Natively is

Natively is a **local-first, proactive AI meeting and workflow companion** for the desktop
(Windows and macOS). It runs quietly alongside whatever the user is doing and helps them be
accurate, on-message, and unblocked — especially during live meetings and calls.

Its stated purpose, in the product's own words, is to:
- **understand what the user is doing right now** (live audio, on-screen content),
- **remember durable context that matters later** (meetings, commitments, history),
- **prepare the user for meetings before they start** (a prep packet),
- **intervene during meetings** with concise, *speakable* guidance,
- **remind the user about follow-ups, risks, and commitments** after the fact,
- and **show the user provable, inspectable evidence** of exactly what context it's using.

It is explicitly **not** a generic chatbot and not an autonomous agent that acts without
permission. It's evidence-first and approval-gated: it observes, prepares, and recommends — and
only acts (send an email, reply in Teams, create an event) after the user explicitly approves.

It is **local-first and privacy-conscious**: transcripts, screenshots, and meeting memory stay on
the device unless the user explicitly routes them out. It runs real AI models (Anthropic Claude
and OpenAI via local CLI sessions, plus local models) — the user picks which.

**Who uses it:** a knowledge worker who is in back-to-back meetings and calls (sales, PM,
engineering, negotiations, interviews) and wants a real-time copilot plus durable memory of
everything that was discussed and promised.

---

## The platform reality (this defines the canvas for each surface)

This is the one set of "constraints" that matters, and it's functional, not aesthetic: Natively is
**one app rendering several very different windows**, each with its own size and behavior. Design
each for its actual context:

1. **Launcher / Dashboard** — a normal, full-size application window. The home base. Opened at
   startup. This is where there's room to breathe.
2. **Live Meeting Overlay** — a **small, floating, always-on-top window** that sits *on top of
   other applications* while the user is in a meeting in Zoom/Teams/etc. It is frameless and
   transparent, draggable, can collapse to a thin bar or expand, and can be made click-through and
   semi-transparent. It must be glanceable and unobtrusive — the user is looking at it *while*
   talking to other people. This is the heart of the product.
3. **Settings** — a frameless floating panel.
4. **Model Selector** — a small dropdown-style window that appears at a click point.
5. **Cropper** — a full-screen transparent overlay for selecting a screen region.
6. **Chat Log Viewer** — a wide standalone window for inspecting AI activity.

The overlay also has a **stealth/"undetectable" mode** that hides it from screen-recording and
screen-share capture (so it doesn't show up when the user is sharing their screen), and a
**disguise mode** that can make the app present itself as a generic system utility. The design
should make these states legible to the user without being loud.

---

## Surface 1 — Launcher / Dashboard (the home window)

The control center the user lands on. Its job: show what's coming up, what happened, whether the
system is ready, and let the user start a session or dig into the past. It contains:

**Top bar / navigation**
- Back / forward navigation (enabled only when viewing a meeting's detail; tracks history).
- A **command-style search** (opens via Cmd/Ctrl+K) that expands inline. As the user types it
  live-filters their past meetings by title/summary, shows up to ~5 matches, supports arrow-key
  navigation + Enter, and offers two modes: an **AI query** (natural-language question across all
  meetings → opens a chat overlay) and a literal search. Opening a result jumps to that meeting.
- Settings entry point; on Windows, native window controls (minimize/maximize/close).

**Hero / primary actions**
- A prominent **"Start Natively" call-to-action** that launches a live session. When a meeting is
  already running it transforms into a **"Meeting ongoing"** state (with a live pulse) and clicking
  it brings the floating overlay back to the front.
- A **Detectable / Undetectable** toggle (stealth on/off).
- A **manual refresh** that re-syncs calendar, meetings, readiness, and context (shows a brief
  "synced" confirmation).
- An occasional **download-progress indicator** when a local AI memory model is being fetched
  (downloading % → complete / failed).

**Readiness preflight panel** — a row of status checks the user can act on. The checks are:
**Brain context, Meeting Prep, Microphone, Meeting Audio, Transcripts, Proactive Coach, Screen
Context.** Each check has one of four states — **ready / warming / warning (usable but degraded) /
failed (don't rely on it)** — with a one-line explanation. Clicking a check expands an action panel
with fixes specific to that check (e.g. pick a microphone from a dropdown, run a voice check, open
the relevant settings tab, enable proactive mode, run a screen check, prepare the next meeting).
There's a plain-language legend for what the four states mean, and a footer summarizing the next
meeting, how many prep packets are cached, the selected AI model, and whether proactive mode is on.
A short timed confirmation message appears after an action ("Microphone saved…").

**Meeting prep card** — when a calendar meeting is starting soon (within ~60 min) or the user has
just generated prep, a card appears with the meeting title, time range, and a **"Prepare"** action
(generates a prep packet) and a **"Start Meeting"** action (launches the session with that meeting's
context preloaded and the chosen audio devices). A prepared meeting shows a "ready to join" state
with a context snapshot and a "next best move."

**Meeting prep brief** (full-width, when a packet is generated) — a richer read of the prep packet:
health indicators for which sources fed it (calendar, memory, background, role brief, live
research), "context to carry in," a "before you join" checklist, open questions, open commitments,
related prior meetings, and ranked memory excerpts. Has lightweight/fallback copy when little
context exists.

**Context engine overview** (full-width) — a live view of what the assistant can actually use right
now. Includes: count metrics (meetings indexed, Teams imports, Cluely imports, prep packets); a
**source-health** grid (Outlook desktop connected/offline + event/email counts, Teams desktop
connected/offline + chat count, the knowledge "brain" repo ready/missing + insight counts, and a
"live watch" streaming/quiet state + OCR/transcript/chat-turn counts); freshest-signal timestamps;
a list of the newest indexed meetings (clickable into detail); and a **"Trace Viewer"** entry point
(opens the Chat Log Viewer). A **Brain Action Queue** appears here when the assistant has proposed
actions: each proposal shows a title, type, summary, and optional payload, with **Approve & Execute
/ Approve Signal / Snooze / Reject** buttons; after a decision a short confirmation appears.

**Meeting history list** — the user's past meetings, **grouped by date** (Today, Yesterday, older
dates). Each row shows title, a **source badge** (Calendar / Teams / Cluely / Imported / Natively),
duration, and time; a meeting still being processed shows a "Processing…" state. Hovering reveals a
per-row menu with **Export** (to PDF) and **Delete**. Clicking a row opens that meeting's detail
view. Empty state when there are no meetings.

**Refresh polling:** events/meetings/context refresh on an interval; readiness refreshes every few
seconds. Arrow keys nudge the window position.

---

## Surface 2 — Live Meeting Overlay (the floating real-time coach)

The signature surface. A small floating window over the user's other apps during a live meeting,
delivering real-time, *speakable* AI guidance. It must work at a glance and never get in the way.

**Collapsed vs expanded** — it can shrink to a minimal bar (drag handle, app logo that opens the
dashboard, a show/hide toggle, and a stop/quit control) or expand to the full coaching panel.

**Live rolling transcript** — a continuously updating line of the meeting's transcription with
speaker attribution and a live "audio active" indicator. The user can toggle it on/off.
**Speaker labels are editable** — the user can click a speaker chip and rename "Speaker 1" to a real
name; the relabel applies across the transcript.

**Proactive suggestions ("what to say")** — the assistant's core trick: it watches the live
conversation and proactively drafts concise things the user can say out loud. These **stream in
token-by-token** as they generate. When proactive mode is on, suggestions appear on their own; the
user can also trigger guidance on demand.

**Action buttons** (each kicks off a streaming AI response):
- **Draft Reply / "what to say"** — a suggested spoken response for the current moment.
- **Clarify** — a clarifying question to ask.
- **Recap** — a running summary of the meeting so far. (This button can switch to **Explore /
  Brainstorm** — idea options — based on a setting.)
- **Help** — proactive help for the current moment (auto-captures a screenshot if there's no recent
  screen context).
- **Voice Ask** — push-to-talk: the user speaks a question, sees a **live transcription preview**
  while recording, and on stop the question is sent and answered. Toggles to a **Stop** state
  (with a recording pulse) while listening.

**Manual question input** — a text box ("ask anything on screen or conversation"). On submit it
streams an answer. It's smart about context: if the question is about the screen it auto-captures a
screenshot; the user can also attach screenshots manually (thumbnail previews with remove buttons);
and it first tries a fast retrieval pass against the meeting's own memory before falling back to a
general answer.

**Streaming response rendering** — answers appear progressively as tokens arrive, with a clear
"generating" indicator and the ability for a newer request to supersede an in-flight one. Responses
render Markdown (tables, math) and **code blocks with syntax highlighting** (collapsible "show
technical details" with the detected language). Two special response types render as **rich cards**
instead of plain text: a **negotiation-coaching card** (tactical note, exact script to say, phase,
their-offer/your-target, optional silence timer) and an **inline action-proposal card** (a draftable
action — e.g. an email — with explicit send/approve controls). Each finished answer offers, on
hover: **Copy**, a **"voice pass" review** (re-checks the wording for spoken delivery via a second
model), and a **"technical cross-check"** review.

**Readiness chips** — a compact row mirroring the launcher's checks (mic, meeting audio, transcript,
prep, coach), each in its four-state form, refreshing every few seconds, with a "status N seconds
ago" stamp.

**Audio-error banner** — when transcription or capture fails mid-meeting, a dismissible banner
surfaces the specific problem (e.g. "Transcription stopped: check your device") so failure is never
silent.

**Overlay controls** (bottom row): model selector (opens the dropdown window), open-dashboard,
settings, **theme toggle (light/dark)**, **proactive-mode toggle**, **undetectable/stealth toggle**,
and **mouse-passthrough toggle** (lets clicks pass through the overlay to the app behind it). Each
on/off control should make its active state legible.

**Selective screenshot flow** — a global shortcut opens the full-screen **Cropper**; the user drags
to select a region; the crop is attached as context to the next question. (See Surface 6.)

**Modes the panel moves through:** idle (ready, showing history), generating/streaming (spinner +
status text like "Asking [model]…"), recording (voice input with live preview), and error.

---

## Surface 3 — Meeting Details (a saved meeting record)

The full read/edit view of one past meeting, opened from the history list or context overview.

- **Header:** editable title, source badge, date, and "imported" metadata when applicable.
- **Overview deck:** an AI-generated executive read of the meeting — synopsis, "why it matters,"
  "value created," continuity (links to related prior meetings), and "upcoming signals" (predicted
  follow-ups). Can be regenerated on demand (shows progress; if the AI session isn't authenticated
  it surfaces a "sign in" path). A **context-evidence sidebar** lists the sources that back the
  overview (title, source type, excerpt, date). A **meeting-signal** panel shows quick metrics
  (transcript lines, speakers, action items, assistant turns) and a **storage/provenance** panel
  shows the model used, a confidence level, generation time, transcript-cleanup stats, and artifacts.
- **Tabs:**
  - **Source notes / overview:** long-form summary, plus **editable** Key Points and Action Items
    (click to edit inline; saves to the record).
  - **Transcript:** searchable. Shows a cleaned, "reconstructed" coherent-turn version (with stats:
    "X raw fragments → Y coherent turns") alongside speaker-grouped raw turns with timestamps and
    confidence; system/assistant lines filtered out.
  - **Assistant usage:** a log of every AI interaction during the meeting (type, timestamp, the
    question, the answer rendered as Markdown, and any **screen captures** taken — openable in a
    full-screen gallery showing each display's name/resolution/timestamp/preview).
- **Bottom input:** "ask about this meeting, or add context" — submitting opens the meeting chat
  overlay (Surface 4), or, if the text reads like a correction/note ("Context: …", "Remember: …"),
  saves it as a durable context note instead.
- A path to generate a **follow-up email** from the meeting (Surface 7).

---

## Surface 4 — Meeting Chat & Global Recall

Two closely related conversational overlays:

- **Ask this meeting** — a focused chat scoped to one meeting. The user asks a question; the answer
  **streams** from a retrieval pass over that meeting's transcript/summary, with a graceful fallback
  to a general answer built from the meeting's context. Recognizes "save this as context" style
  inputs and stores them as notes instead of answering. Shows typing indicator, streaming cursor,
  per-message copy, and an error banner.
- **Ask all meetings (global recall)** — the same conversational pattern but searching **across the
  entire meeting history**. Reached from the launcher's command-search "AI query." Streams its
  answer; has its own input bar.

Both are lightweight conversation surfaces (user bubbles + assistant bubbles + streaming state).

---

## Surface 5 — Settings, Model Selection, and the Context Hub

**Settings** (full panel, tabbed) configures the whole product:
- **General:** stealth (undetectable) toggle; live-transcript on/off; a "deep thinking"
  (recap ↔ brainstorm) toggle; a "reference context" toggle (inject the user's background/résumé
  into answers, shown only if a profile exists); read-only display of key global shortcuts.
- **Audio:** choose the **speech-to-text provider** (several options, one recommended) and the
  **recognition language** (can auto-detect); pick **microphone** and **speaker** devices.
- **Appearance:** theme mode (System / Light / Dark); **overlay opacity** slider (with a live
  preview of the overlay); overlay **mouse-passthrough** toggle.
- **Hotkeys:** record/customize global keyboard shortcuts (toggle visibility, screenshot, etc.) with
  a reset-to-defaults action.
- **Account:** status of the local AI (Claude) session (ready / expired / invalid / missing);
  verbose-logging toggle.
- **About / Help / Context Hub** tabs (below).

There is also a **quick settings popup** — a compact version of the most-used toggles
(stealth, transcript, deep thinking, reference context) for in-meeting tweaks, plus shortcut
reminders. It auto-sizes to its content.

**Model Selector** (dropdown window) — lists the available AI models grouped by provider
(Claude models, ChatGPT/Codex models), based on which local sessions are configured; a checkmark
marks the active model; selecting one switches it instantly. Shows a "no models ready" state when
none are configured.

**Context Hub** (within settings) — the inventory and control room for everything the assistant
knows and can do:
- **Source status cards:** meetings indexed (with native/Teams/Cluely/generic breakdown), the
  knowledge "brain" repo (availability + prep packets + insight counts), live context (OCR
  observations, transcript segments, chat turns + last-observed time), Outlook desktop (connected +
  account + event/email counts), Teams desktop (connected + username + chat count), and Autonomous
  Ops (online/offline + active/blocked/approval-required workflow counts).
- **Freshness timestamps** (last meeting indexed / last live observation / last brain run) and a
  **service-health** readout (background services reporting ok/degraded/failed, so a dead subsystem
  is visible rather than silently broken).
- **Autonomous Ops panel:** lists supervised workflows with their state (idle / watching /
  needs-approval / working / blocked / completed), summaries, run metadata, and per-workflow
  start/stop/action controls.
- **Background reference upload:** upload/replace/remove a résumé-style document that personalizes
  answers; shows parsed role/name and extracted skill tags.
- **Meeting import:** discover and import past meetings from **Teams** and **Cluely**, plus a
  **manual import** flow (paste/append summary, transcript, and AI-usage chunks; choose source
  format, title, date; clear/import) with a list of recently imported meetings.
- **Chat debug summary** with an "open viewer" entry point to the Chat Log Viewer.

**Microsoft Action Panel** — compose and send real Outlook/Teams actions: draft or send an
**email** (to/cc/subject/body, plus a list of recent emails to reply to), **reply in a Teams chat**
(pick a chat, see recent messages, type a reply, send), and **schedule an Outlook calendar event**
(subject, location, start/end, required/optional attendees, body, and a choice to send invites
immediately or just save).

**Meeting-AI settings** — toggles for the meeting coach: an **"IP Corp / knowledge mode"** that
injects the local meeting memory and background reference into the live coach, and an
**"always-on screen watch"** that periodically captures the displays, extracts visible text, and
feeds it into context. Both show status and gate on the AI session being available, with a short
"how it works" explainer.

---

## Surface 6 — Cropper (screen-region selection)

A full-screen transparent overlay triggered by a shortcut. The user drags a rectangle to select a
region; a small heads-up hint guides them ("click and drag to select an area"); Escape cancels. The
selected region is captured and attached as context. It must render crisply on high-DPI displays and
work even in stealth mode (no system cursor leaking into a screen share).

---

## Surface 7 — Follow-up Email Modal

Drafts a follow-up email from a meeting. Recipient(s) auto-populate from calendar attendees or by
extracting addresses from the transcript (removable chips). Subject defaults from the meeting title.
The body is **AI-generated** from the meeting's summary/action items/key points (with a regenerate
action). A primary action opens the draft in the user's mail client; close dismisses without sending.

---

## Surface 8 — Chat Log Viewer (trace / inspection)

A wide standalone window for inspecting the assistant's activity — its job is *provability*. It
shows summary metrics (total turns, completed, flagged, surfaces) and a list of recent AI "turns."
Selecting a turn reveals: the surface it came from, status (completed / proposal / superseded /
issue), provider + model, first-token and total latency, the full prompt and response, any **screen
captures** (gallery ordered by physical display position), an **OCR snapshot** (what was read off
screen, with age), and **inference flags** (had images, was a screen-read, reasoning effort, errors).

---

## Surface 9 — Onboarding & ambient/idle states

- **Startup sequence:** a brief branded launch animation as the app boots.
- **Setup guide / Help:** a step-by-step first-run guide (grant OS permissions → set up audio →
  connect an AI model → "you're all set" with the key shortcuts), plus expandable help sections and
  animated explainers of each surface.
- **Feature spotlight:** an auto-rotating carousel of upcoming features the user can express
  interest in (pauses on hover; remembers interest).
- **About:** product identity and principles (private by default, context-aware, a real installed
  desktop app) with resource links.

---

## Surface 10 — Coding/interview assist (a distinct mode)

There's a specialized flow for live coding/technical-interview situations:
- A **capture queue** — screenshots of a problem are taken and managed, with a side chat to ask
  about them.
- A **solution "teleprompter"** — a structured, four-phase script the user can read aloud:
  **(1) Understand the problem, (2) Brainstorm the approach** (options + trade-offs),
  **(3) Code the solution** (a collapsible, syntax-highlighted code block with time/space complexity
  badges), **(4) Dry-run / test** (a walkthrough script). Each spoken phase is framed as "say this
  out loud." A loading/skeleton state shows while it generates.

---

## Cross-cutting behaviors to honor everywhere (functional, not visual)

These run across surfaces and are core to the product's feel — please implement them as live
behaviors in the prototypes:

- **Token-by-token streaming** of every AI response, with a visible generating state, the ability
  for a newer request to supersede an in-flight one, and a clean terminal state (done / error /
  superseded).
- **Real-time, continuously updating indicators:** the rolling transcript, the readiness chips
  (four states, refreshing on an interval), live audio activity, download progress, "syncing"
  confirmations.
- **Four-state readiness** (ready / warming / warning / failed) used consistently wherever system
  health is shown.
- **Approval-gated actions:** anything that sends/changes something in the outside world (email,
  Teams reply, calendar event, a brain action proposal) is presented for explicit user approval with
  clear send-vs-draft distinction — never auto-fired.
- **Stealth / privacy states:** undetectable on/off, disguise, content-protection, mouse-passthrough,
  and overlay opacity — all need legible on/off representations.
- **Theming:** light and dark must both be designed.
- **Local-first / provability:** the UI repeatedly exposes *what context is loaded and where it came
  from* (evidence lists, source health, the trace viewer, OCR snapshots). This transparency is a
  feature — design it as one.
- **Every empty / loading / error / degraded state** named above is in-scope.

---

## To summarize the ask

Reimagine all of Natively — every surface above — as a cohesive, original, striking interface, with
**no constraints from me on how it looks**. Deliver it as **interactive, component-based, motion-rich
prototypes** (ideally React + TypeScript + Tailwind + Framer Motion so it drops into the existing
app) covering **every surface and every state**, so I can integrate your work directly instead of
rebuilding it from a flat picture. Surprise me — the more creative and fresh, the better, as long as
every function described here is present and actually works.
