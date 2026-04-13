# Natively Feature System Map

Last updated: 2026-04-12

This file is for product explanation, leadership prep, and architecture storytelling.
It is intentionally visual-first.

Each Mermaid block below is mirrored in a standalone `.mmd` file in `docs/product/` so the diagrams can be reused independently.

## 1. End-To-End Runtime Flow

Source: `feature-system-map-1-user-flow.mmd`

```mermaid
flowchart TD
    U[User] --> A[Open Natively]
    A --> B[Launcher, Context Overview, Overlay]
    B --> C{Current mode}

    C -->|Meeting live| D[Meeting Coach]
    C -->|Before meeting| E[Prep Packet]
    C -->|Ad hoc request| F[Reactive Chat]
    C -->|Import or inspect context| G[Context Hub]
    C -->|Background watch| H[Ambient Capture]

    D --> I[Live transcript]
    D --> J[Screen OCR]
    D --> K[Current calendar event]
    D --> L[Prior meetings and memory]
    D --> M[Profile and role context]

    E --> K
    E --> L
    E --> M
    E --> N[Commitments and contradictions]

    F --> O[Action planner]
    O -->|Answer only| P[Rendered answer]
    O -->|Action requested| Q[Inline action card]
    Q --> R[Outlook action]
    Q --> S[Teams action]
    Q --> T[Calendar invite action]

    G --> U2[Manual import]
    G --> V[Imported meeting history]
    G --> W[Microsoft actions panel]

    H --> J
    H --> X[Chat interaction logging]
    H --> Y[Observation store]

    I --> Z[Retrieval broker]
    J --> Y
    K --> Z
    L --> Z
    M --> Z
    N --> Z
    U2 --> AA[Meeting import service]
    AA --> AB[SQLite meeting memory]
    AB --> AC[RAG index]
    AC --> Z
    X --> Y
    Y --> Z
    V --> AB

    Z --> AD[Ranked evidence set]
    AD --> D
    AD --> E
    AD --> F
```

## 2. Capability Map

Source: `feature-system-map-2-capability-map.mmd`

```mermaid
mindmap
  root((Natively))
    Meeting Guidance
      Live transcript guidance
      Screen-aware coaching
      What to say
      Clarify
      Recap
      Follow-up prompts
    Context Engine
      Observation store
      Durable meeting memory
      Retrieval broker
      Ranking policy
      Contradiction tracking
      Prep packet generation
      Source authority rules
    Historical Knowledge
      Manual meeting import
      Imported transcripts
      Imported summaries
      Imported usage logs
      Teams-first transcript authority
      Cluely recovery path
    Microsoft Desktop Actions
      Outlook read
      Outlook send and reply
      Outlook calendar create
      Teams read
      Teams send
      Action test panel
    Calendar
      Google Calendar
      Outlook Calendar
      Upcoming meetings
      Meeting reminders
      Prep triggers
    Explainability
      Context overview
      Imported meeting history
      Chat timing and logs
      Freshness visibility
    Models and Providers
      Claude local path
      Codex local path
      OpenAI GPT family
      Ollama local models
      Managed fallback
    Desktop Product
      Packaged Electron app
      Canonical shared SQLite store
      Auto-update surface
```

## 3. Communication Action Flow

Source: `feature-system-map-3-action-flow.mmd`

```mermaid
sequenceDiagram
    participant User
    participant Widget as Widget Chat UI
    participant Planner as Agent Action Planner
    participant Card as Inline Action Card
    participant IPC as Electron IPC
    participant Bridge as Local Microsoft Bridge
    participant Outlook as Outlook Desktop
    participant Teams as Teams Desktop

    User->>Widget: Ask for email / Teams / calendar action
    Widget->>Planner: classify and structure request
    Planner-->>Widget: structured action proposal
    Widget->>Card: render editable action card
    User->>Card: review and confirm
    Card->>IPC: invoke approved action
    IPC->>Bridge: route to local bridge
    alt Email
        Bridge->>Outlook: create/send/reply
        Outlook-->>Card: result
    else Teams
        Bridge->>Teams: send message
        Teams-->>Card: result
    else Calendar
        Bridge->>Outlook: create event / invite
        Outlook-->>Card: result
    end
    Card-->>User: success or error state
```

## 4. Historical Ingestion And Memory Flow

Source: `feature-system-map-4-ingestion.mmd`

```mermaid
flowchart LR
    A[Manual pasted artifacts] --> E[MeetingImportService]
    B[Cluely-derived artifacts] --> E
    C[Teams transcript and recap artifacts] --> E
    D[Future recordings and synced files] --> E

    E --> F[Normalize into meeting model]
    F --> G[Persist in SQLite]
    G --> H[Index into RAG and retrieval]
    H --> I[Prep packets]
    H --> J[Meeting coach]
    H --> K[Reactive chat]
    G --> L[Context Hub imported history]
    G --> M[Launcher context overview]
```

## 5. Diagnostics And Trust Loop

Source: `feature-system-map-5-diagnostics.mmd`

```mermaid
flowchart TD
    A[User asks question or imports meeting] --> B[Visible product response]
    B --> C{Looks correct?}

    C -->|Yes| D[Continue using product]
    C -->|No| E[Inspect logs and UI state]

    E --> F[Chat timestamps and response timing]
    E --> G[Context overview freshness]
    E --> H[Imported meeting history]
    E --> I[Terminal and Electron logs]
    E --> J[Database state]

    F --> K[Identify response issue]
    G --> K
    H --> K
    I --> K
    J --> K

    K --> L[Fix provider, retrieval, import, or persistence path]
    L --> M[Rebuild and relaunch]
    M --> A
```

## 6. Suggested Leadership Narrative

Use this framing:

1. Natively observes live work, not just typed prompts.
2. It grounds assistance in ranked context from multiple local and durable sources.
3. It can move from guidance to action through local Outlook and Teams execution surfaces.
4. It is increasingly explicit about source authority, inspectability, and failure handling rather than hiding everything inside prompts.
