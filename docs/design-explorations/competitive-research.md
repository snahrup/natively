# Natively — competitive & UX research briefing

_Generated 2026-06-14 from a 6-lane web-research sweep (overlay/stealth copilots · notetakers · ambient/recall · coaching · desktop-UX craft · open-source). Cross-referenced against Natively's current feature set._

## Feature gaps worth adding

### HIGH priority

- **Smart area / region selection for 'ask about my screen' — drag a box and the AI reads only that region (a chart, an error, one code block), not the whole screen.**
  - Who does it: LockedIn AI (Smart Area Selection), OpenCluely (rectangular crop + multi-monitor targeting), Pluely/Interview Coder (area-capture modes)
  - Why it fits: Highest-value novel UX in the whole copilot lane and a double win for Natively: more accurate vision answers (no 'it read my messy screen and got confused') AND a privacy/stealth win (the rest of the screen never goes to the model, the drag gesture leaves no visible trace). Natively already has screenshot + ask-about-screen plus content-protection plumbing — this is scoping on top of existing capture, not new infrastructure.
- **Commitment / action-item ROLLOVER: unresolved commitments from prior meetings auto-surface at the TOP of the next related meeting's prep packet and readiness preflight, with owner + due date.**
  - Who does it: Fellow (action-item rollover — the best 'nothing falls through the cracks' mechanic in the notetaker lane), Chorus (commitment-phrase tracking across deal stages)
  - Why it fits: Natively already stores durable commitments with due dates and deadline notifications — they exist but sit in a passive list. Surfacing unresolved ones as the spine of the pre-meeting flow is mostly UX wiring on data Natively already owns, and it turns commitments from a checklist into the reason to open the prep packet. Pure leverage, near-zero new infra.
- **Direct image-to-vision-model path for 'ask about my screen' on non-code screens (diagrams, dashboards, slides, whiteboards, handwriting) instead of OCR-then-text.**
  - Who does it: OpenCluely (sends raw screenshot straight to Gemini, skips OCR), cheating-daddy (Presentation profile reads the slide directly)
  - Why it fits: Natively's screen path is OCR-powered, which silently loses everything that isn't text — exactly the visuals people most need help reasoning about live (architecture diagrams, charts, error UIs). Routing the raw frame to a vision model for non-code captures is a real capability gap, and Natively's multi-model (Claude/ChatGPT CLI) stack already has vision-capable backends. Pairs naturally with region-select above.
- **'Catch me up — what did I miss?' one-tap live recap for late joiners or zone-outs, generated from the transcript-so-far.**
  - Who does it: Amurex (Late Join Recap — its sharpest nameable feature), Glass (continuously-updating live summary)
  - Why it fits: Universal pain (joining a call 10 min late, or drifting) and Natively already has the rolling transcript + recap-suggestion machinery to power it. The gap is purely framing: Natively doesn't surface the join-late moment as one distinct, instant action. Cheap to ship, very nameable, demos well.
- **Persistent Topic Trackers: user registers standing keywords/themes (Pricing, Competitors, a client name, a risk) once and the brain flags every mention across ALL meetings, surfaced on the dashboard between meetings.**
  - Who does it: Fireflies (Topic Trackers), Spinach (recurring-blocker detection), Chorus (champion-quiet / competitor-mention alerts)
  - Why it fits: Pairs perfectly with Natively's global RAG + autonomous-ops engine and creates standing, proactive value BETWEEN meetings (the dead zone for a copilot). It's set-and-forget intelligence the autonomous engine is already built to run. Differentiates hard from passive recorders.

### MEDIUM priority

- **Live talk-time / talk-ratio indicator on the overlay with a single gentle nudge when the user dominates ('you're talking a lot — cede the floor'), benchmarked against a win-correlated target.**
  - Who does it: Gong (real-time talk-ratio nudge, ~43/57 benchmark), Poised (live rambling/monologue detection)
  - Why it fits: Natively coaches the OTHER side of the conversation ('what to say') but gives the user zero feedback on their own delivery. A single high-signal, low-noise momentum cue is on-brand for a coach (not a sentiment graph), and Natively already computes the transcript + speaker labels needed. One alert, clear action — the opposite of overwhelm.
- **Pin-able 'must-say' points before a meeting that the live coach actively tracks and reminds you of if the call is wrapping without hitting them ('Cheatsheet' / coverage tracking).**
  - Who does it: Verve (pinned Cheatsheets), Second Nature (pitch-completeness checklist), Yoodli (benchmarked coverage)
  - Why it fits: Bridges Natively's existing prep-packet → live-overlay gap with one concrete artifact. The prep packet already exists and readiness chips already exist — this adds 'did I cover my own intended points' as live coverage chips, then a post-call 'you hit 6/8 of your planned points' score. Squarely a coach behavior, not a recorder behavior.
- **Per-source context toggles + a live 'what the AI can see right now' panel — expose Context Hub sources (Outlook, Teams, calendar, screen, mic) as individual on/off switches, ideally OS-enforced and shown in the trace viewer.**
  - Who does it: screenpipe (deterministic 3-layer OS-enforced per-pipe permissions), Hyprnote/Char (per-source on/off toggles), Glass
  - Why it fits: This is the privacy MOAT no closed competitor (Cluely) can match, and it directly answers the privacy anxiety a stealth-overlay product inherently raises. Natively already has the Context Hub sources and a chat-log/trace viewer for provability — making source access legible, toggleable, and ideally enforced (not prompt-based) extends 'provability' from 'what the AI said' to 'what it was structurally forbidden to see'. Strongest local-first trust play available.
- **Autonomy slider on summary/deck generation: 'stay close to my words' ↔ 'polish into a refined narrative', controlling how aggressively the AI rewrites.**
  - Who does it: Hyprnote (autonomy setting — the most-loved trust lever in the OSS lane), Granola (augment-not-replace philosophy)
  - Why it fits: Natively auto-generates the overview deck + key points with zero user control over rewrite aggressiveness — the #1 source of 'the AI summary missed the point' distrust. A per-meeting slider is a small UI add on top of existing generation and a direct trust win for a tool whose whole pitch is provability.
- **Plain-language 'extract this from every meeting' rules — user types what they always want pulled (decisions, risks, competitor mentions, commitments) and it runs automatically on every meeting; plus scheduled cross-meeting digests ('every Friday, summarize my week + open commitments').**
  - Who does it: Circleback (no-code 'extract X from every meeting' automations), Khoj (scheduled automations / digests), Limitless (saved queries with proactive notifications)
  - Why it fits: Natively has the brain, commitments engine, and global RAG — this is the UX wrapper that turns autonomous-ops from hard-coded into user-configurable standing value. Combined with notifications Natively already sends, it makes the product work for you between meetings.
- **One global hotkey to drop a live highlight/bookmark during a meeting, which becomes a jump-to-able, copyable snippet (transcript span + the screenshot at that timestamp) and seeds the post-meeting recap (your marked moments first, AI summary second).**
  - Who does it: Fathom (one-click live highlight — most-praised feature in the notetaker lane), Avoma (live bookmarking), Fireflies (shareable Soundbites)
  - Why it fits: Tiny build with outsized love payoff: Natively already captures transcript + timestamps + screenshots, so one keypress mints an anchored clip. Anchoring the recap to the user's own marked moments mirrors the augmentation philosophy and gives the meeting-detail page a spine. No video needed — text/screenshot-anchored clips are Natively's 'reel' equivalent.

### LOW priority

- **Import & enhance orphan audio: drag in an existing recording (or re-transcribe a stored meeting with a better/different STT engine) and run the full transcript → deck → key-points → commitments pipeline.**
  - Who does it: Meetily ('Import & enhance', re-transcribe with a better model), Hyprnote
  - Why it fits: Natively already imports Teams/Cluely and runs multiple STT engines — adding raw audio ingest + re-run reuses ~100% of existing machinery and closes a real gap (a recording someone hands you, or upgrading old meetings as models improve). Low-cost on-ramp for users with a backlog.
- **Context-triggered cue cards: when the transcript hits a user-defined trigger (a competitor name, a pricing question, a known objection), auto-surface the matching battle card / rebuttal / snippet from the prep packet or RAG. Let users author keyword→card rules.**
  - Who does it: Attention & Dialpad (context-triggered cue cards), Salesken, cheating-daddy (profile-scoped triggers)
  - Why it fits: A proven way to make the coach feel PROACTIVE instead of on-demand, and it surfaces help precisely without clutter. Natively has the transcript, RAG, and negotiation/code-hint cards — wiring user-authored triggers to auto-fire is the missing connective tissue. Sales-heavy users will lean on this hard.
- **Markdown-on-disk export per meeting (transcript + notes + key points + screenshots) to a user-owned folder, plus a no-account guest share link for a single meeting (hover-for-context + ask-a-question powered by meeting-scoped RAG).**
  - Who does it: Hyprnote/Char & Meetily (.md on disk, sync via Dropbox/git), Granola (no-account guest share — its primary growth loop)
  - Why it fits: Trivial given Natively's SQLite store, and a strong anti-lock-in / local-first trust signal that matches the product's identity. The guest share link is the proven viral loop in this category and Natively already has the RAG to power the guest chatbox.

## UI/UX polish to steal (final-polish wins)

- **Black-you / gray-AI text distinction in the reconstructed transcript and meeting notes — what the human said/typed renders dark, what the model inferred/added renders gray, so trust is visible at a glance.**
  - Source: Granola
  - Why: It makes provability free and casual — cheaper than opening the trace viewer, and it directly serves Natively's whole 'provable, not hallucinated' thesis. Single highest-ROI trust gesture in the notetaker lane.
- **Hover-to-reveal 'evidence' magnifier on every AI-generated key point and action item — click to jump to the exact transcript span that backs it.**
  - Source: Granola (contextual magnifying-glass) / Avoma (timestamped reasoning)
  - Why: The killer trust gesture. Natively already stores transcript + trace, so each AI claim can link to its source span — provability the user can actually feel, not a buried log.
- **Inline keyboard-shortcut badges on every readiness chip, suggestion card, and recall action (muted pill, shortcut shown next to the action), plus 'Next time, try [key]' nudges that graduate users from mouse to muscle memory.**
  - Source: Raycast (shortcut badges) + Superhuman ('Next time, try…')
  - Why: Critical for an overlay used while hands are busy and eyes are on the camera — passive teaching means power users stop reaching for the mouse during stealth-critical moments (hide, screenshot, voice-ask).
- **Ultra-short, glanceable hero suggestion: the primary 'what to say' renders as a 30–60 char speak-ready sentence (teleprompter/sticky-note framing — 'glance, don't study'), with expand-on-hover for detail.**
  - Source: Cluely + Final Round AI (sticky-note/teleprompter) + cheating-daddy (30–60 char bubbles)
  - Why: You're literally talking while reading it. Natively's suggestions can be verbose; designing the hero card to be readable in a 1-second peripheral glance (short line length, high contrast, one idea) is the difference between usable and useless under pressure.
- **Optimistic UI with a 5-second countdown undo on action-proposal, commitment, and follow-up cards — the action commits instantly, no confirm dialog, with 'Z to undo' during the countdown.**
  - Source: Superhuman
  - Why: A confirm dialog mid-call breaks meeting flow and steals focus. Instant-commit-with-undo keeps the user present in the conversation — exactly what a live tool needs.
- **Inline verbosity dial (Short / Medium / Long / Auto) directly ON the overlay coaching card, plus transcription-delay and temperature knobs, so the user tunes 'how much / how fast / how creative' without a settings trip.**
  - Source: Pluely (Short/Med/Long/Auto on overlay) + Final Round AI (verbosity/delay/temperature dials)
  - Why: The single most-requested control across the entire copilot lane. Makes the streaming coach feel tunable and trustworthy instead of a firehose you can't throttle.
- **'Emergency hide that keeps listening' as one explicit, documented hotkey (instantly clears the overlay for a screen-share without ending the session), plus single-key click-through toggle and arrow-key window nudging with on-screen hints.**
  - Source: cheating-daddy (emergency hide + Cmd/Ctrl+M passthrough + arrow nudge), Glass
  - Why: These are the two interactions power users hit most during a live call. Natively has passthrough and opacity but as buried plumbing — promoting them to first-class single-key toggles is the stealth UX Natively's content-protection story should own and market.
- **Reframe the rolling transcript as selectable 'Blocks' — each speaker turn is a card carrying metadata (speaker, timestamp, confidence) with hover actions: copy, 'ask about this', 'turn into action item', 'flag for follow-up'.**
  - Source: Warp (command/output Blocks)
  - Why: Turns Natively's passive transcript log into the interactive provability surface it's trying to be — and the per-turn 'ask about this / make action item' actions are exactly what a meeting record needs.
- **Smart chapters / topic table-of-contents over the reconstructed transcript — auto-segment into topic chapters so a long meeting becomes a navigable jump-to TOC; group key points BY topic rather than as a flat list.**
  - Source: Avoma (smart chapters) + Circleback (topic-grouped notes — why its output is called the cleanest)
  - Why: The cleanest scannability win for long meetings, and topic-grouped key points are the specific reason Circleback's notes are loved. Pairs directly with the hover-to-evidence idea.
- **Distinct, honest AI status vocabulary instead of spinners: a blinking-cursor 'listening', staggered-dot 'thinking', ease-out reveal for 'writing response' — and give all AI-generated overlay content a dedicated accent color so it reads as machine-authored vs the human transcript.**
  - Source: Warp (status indicators + purple AI accent) + Raycast (skeleton rows, never blocking spinners)
  - Why: Satisfies the never-a-blank-screen / always-show-reasoning mandate with concrete non-spinner animation, and the AI-accent color reinforces provability (you always know what the machine wrote).
- **'Structure felt not seen': dim the transcript and all chrome so the live 'what to say' card is unmistakably the brightest, focal element on screen; move theming to LCH / 3-variable so text stays legible at low overlay opacity.**
  - Source: Linear (calmer-interface refresh + LCH color space)
  - Why: The overlay is the most density- and legibility-sensitive UI a user will ever stare at under pressure, often translucent over arbitrary backgrounds. Perceptually-uniform lightness is precisely what keeps the coach readable while staying stealth-translucent.
- **Expand-in-place editing for key points, action items, and speaker labels — the chip/row morphs into its editor inline (no modal), the way a row becomes an 'empty white paper' editing surface.**
  - Source: Things 3 (expand-in-place) + Granola/Hyprnote ('blank page is sacred' calm editor)
  - Why: Modals steal focus — fatal during a live meeting. In-place editing keeps the user in flow and never pulls attention off the call.
- **Auto-snapshot shared screens at slide-change / meaningful-change moments and embed the image inline in the reconstructed transcript at that timestamp — the user never thinks about capturing it.**
  - Source: Otter (slide auto-capture into notes) + Circleback (captures on-screen content) + screenpipe (event-driven capture)
  - Why: Natively already has screenshot capability — making it event-driven and auto-embedded preserves visual context for free and is a genuinely delightful, low-effort win. Also lighter than continuous recording (helps the RAM-only-transcript fragility).
- **Auto-tag / keyword-highlight the live transcript (objection / question / commitment / next-step / competitor mention) so the eye jumps to what matters instead of reading every line.**
  - Source: Nooks (keyword-highlighted live transcript + auto-tagging)
  - Why: Reduces the cognitive load of watching a streaming transcript during a call and powers both live navigation and the post-meeting recap from one mechanism.
- **System-tray / menu-bar mini surface answering 'what's my next meeting and am I ready?' in one click — upcoming prep packet + readiness preflight + a single 'arm the coach' action, with a one-key quick action.**
  - Source: Notion Calendar / Cron (menu-bar mini window + one-key 'S' action)
  - Why: Makes Natively's prep/readiness features ambient instead of buried in the launcher — the pre-meeting ritual becomes muscle memory rather than a navigation chore.
- **Auto meeting detection → proactive activation: when a call actually starts, the overlay offers 'Start coaching this meeting?' instead of waiting for manual invocation. Default stealth ON automatically, never a per-call toggle.**
  - Source: Parakeet (auto meeting detection) + Verve ('stealth on automatically, no per-call setup')
  - Why: Natively has calendar + prep packets + readiness preflight but doesn't close the loop on the moment the call begins. Proactive activation + always-on protection means the user never forgets to arm the coach or turn on stealth.

## Design references to study

- **Granola** — The provability/trust gestures: black-human / gray-AI text distinction, the hover-to-reveal evidence magnifier on every summarized line, and the 'enhance MY notes' augmentation model (sparse live notes preserved, transcript woven into the user's structure). Also study its 'calm AI for crazy days, almost paranoid about clutter' discipline — that is exactly the bar for Natively's high-cognitive-load overlay. This is the single most important study target; it maps ~1:1 onto Natively's provability + meeting-detail goals.
- **Raycast** — The floating-command-bar pattern Natively's overlay literally lives in: the Cmd+K Action Panel (a contextual menu of actions per item, each with an inline shortcut), the navigation STACK (Enter drills in / Esc pops back — never a new window), inline shortcut badges that teach passively, skeleton loading rows that never block, and the hard sub-50ms hotkey-to-visible budget. The direct template for upgrading Natively's inline action-proposal cards and overlay action surface.
- **Warp** — How it turns a streaming-text surface (terminal output) into structured, navigable, actionable Blocks with per-unit metadata and hover actions — the exact reframe Natively should apply to its rolling transcript. Also study its transparent-inline-AI principle (show the reasoning/source before acting), distinct honest status indicators (blinking cursor / staggered dots), the dedicated AI accent color, and the Workflow step-runner ('Step 1 of 3' with Run/Skip/Cancel) for multi-step agent/autonomous-ops actions. Specific timings/easings are in the teardown.
- **Hyprnote / Char (fastrepl)** — The only architectural twin (local-first, on-device, BYOK, bot-free, open source). Study the two-panel raw-notes-vs-AI-enhanced editor with a visible diff of what the AI changed, the autonomy slider ('stay close to my words' ↔ 'refined narrative'), per-source context toggles, the template picker with re-generate, and markdown-on-disk data ownership. Treat its repo/issues as the early-warning signal for where local-first notetaking UX is heading.
- **Superhuman** — Speed feel and trust mechanics: optimistic UI with a countdown-undo window (the model for commitment/follow-up/action cards), a command bar that trains users out of itself via 'Next time, try [shortcut]' nudges, the explicit 50–60ms interaction latency budget, and the zero-stakes synthetic-inbox onboarding (Natively's analog: a 'mock meeting' rehearsal mode to drill the overlay and shortcuts before a real high-pressure call).
- **Arc Browser (Little Arc)** — Little Arc is the closest visual analog to Natively's floating coach window — copy its disposable-floating-window craft (rounded corners, soft deep shadow 0 8px 32px, minimal 36px chrome, content = window minus chrome) so the overlay looks intentional, not like a generic Electron rectangle. Also study the fading/peeking sidebar (collapse the transcript rail to a thin spine during intense moments, peek on hover, 0.2s ease-out with titles fading to opacity 0) and the concrete motion spec (spring response 0.3 / damping 0.7) as the exact timings to adopt rather than inventing arbitrary durations.
- **screenpipe** — The deterministic, OS-enforced (not prompt-based) per-source permission model (YAML-defined allow/deny by app/window/content-type, enforced at OS layers so even a compromised agent can't read denied data) and the searchable DVR-style timeline that links each captured frame to its concurrent transcript line. These are the two most defensible ideas in the OSS landscape and would make Natively's 'provability' story dramatically stronger — provable access control, not just provable output. Also study its event-driven (not continuous) capture model for the screen-context path.

## Skip (slop / off-strategy)

- Join-the-call bot (the Otter/Fireflies/Zoom-bot model). Directly contradicts Natively's stealth + bot-free + local-first identity and throws away its single biggest positioning differentiator ('no third participant joins, nothing in the roster'). Natively should say 'no bot' LOUDER, not build one.
- Video recording, Clips & Reels, and highlight video stitching (tl;dv, Fathom video clips, Fireflies Soundbites as video). Natively has no video pipeline and shouldn't add one — it's heavy, raises exactly the surveillance/privacy anxiety a stealth tool must avoid, and bloats storage. Natively's 'reel' equivalent is text + screenshot-anchored highlights (already covered as a featureGap), which gets 90% of the value with none of the baggage.
- Real-time sentiment / engagement / 'charisma' graphs and the post-meeting 'report card' with charisma scores (Read AI, Chorus Momentum visualizations). Off-brand for a coach and faintly creepy — reading other participants' emotions edges toward surveillance and undercuts trust. The on-brand subset (a quiet talk-ratio nudge, did-you-cover-your-points coverage) is already captured as gaps; the sentiment theater is slop.
- 3D-avatar / lifelike-persona roleplay training (Second Nature). Massive build, off the core real-time-copilot strategy, and gold-plating. A lightweight text/voice 'mock meeting' rehearsal mode (Superhuman-style synthetic onboarding) delivers the practice value without a graphics engine.
- Re-platforming off Electron to Tauri/Rust for footprint (Pluely's 10MB/<50MB pitch). Not a feature and not realistically actionable for a mature Electron app — chasing it would be a multi-quarter rewrite. The right response is the marketing/perf move: publish honest startup/RAM numbers and trim toward them to pre-empt the 'Electron is bloated' jab, not a re-platform.
- Duo / whisper co-view / remote-assist 'second human silently watches your live meeting' (LockedIn Duo, Nooks whisper coaching). Genuinely tempting as a collaboration wedge, but for a STEALTH meeting copilot it's a reputational/ethics landmine — a hidden human watching a call others can't see is the creepiest possible framing and invites the 'undetectable cheating tool' backlash Natively should be steering away from. Skip unless reframed for explicitly-consented contexts.
- Team/collaboration platform features broadly — leaderboards, manager coaching dashboards, org-wide rollups, multi-player roleploy (Second Nature, Gong, Avoma manager tooling). These pull Natively toward an enterprise CI platform and away from its personal, local-first, on-device identity; the data-centralization they require fights the per-machine privacy story. Stay single-user-first.
- CRM auto-sync / MEDDIC-BANT field auto-fill into Salesforce/HubSpot (Attention, Gong, Chorus). Cloud-integration-heavy, pulls private meeting data off-device, and serves a narrow sales-ops persona — directly at odds with the local-first 'nothing leaves your machine' positioning. Framework-based scorecards as a local artifact are fine; the cloud CRM write-back is off-strategy.
- Generic deliverable-factory expansion into proposals/specs/roadmaps from every meeting (Sembly AI Artifacts). Tempting scope creep — but Natively already does the highest-value artifact (follow-up email) and adding a proposal/spec generator dilutes the copilot focus into a content mill. Worth a single targeted 'generate the thing you owe' action at most, not a deliverable suite.
