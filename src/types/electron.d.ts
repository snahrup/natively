export interface ElectronAPI {
  updateContentDimensions: (dimensions: {
    width: number
    height: number
  }) => Promise<void>
  onToggleExpand: (callback: () => void) => () => void
  getRecognitionLanguages: () => Promise<Record<string, any>>
  getScreenshots: () => Promise<Array<{ path: string; preview: string }>>
  deleteScreenshot: (
    path: string
  ) => Promise<{ success: boolean; error?: string }>
  onScreenshotTaken: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onScreenshotAttached: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onCaptureAndProcess: (
    callback: (data: { path: string; preview: string }) => void
  ) => () => void
  onSolutionsReady: (callback: (solutions: string) => void) => () => void
  onResetView: (callback: () => void) => () => void
  onSolutionStart: (callback: () => void) => () => void
  onDebugStart: (callback: () => void) => () => void
  onDebugSuccess: (callback: (data: any) => void) => () => void
  onSolutionError: (callback: (error: string) => void) => () => void
  onProcessingNoScreenshots: (callback: () => void) => () => void
  onProblemExtracted: (callback: (data: any) => void) => () => void
  onSolutionSuccess: (callback: (data: any) => void) => () => void
  onUnauthorized: (callback: () => void) => () => void
  onDebugError: (callback: (error: string) => void) => () => void
  takeScreenshot: () => Promise<{ path: string; preview: string }>
  takeContextScreenshot: () => Promise<{ path: string; preview: string }>
  getImagePreview: (path: string) => Promise<string | null>
  takeSelectiveScreenshot: () => Promise<{ path: string; preview: string; cancelled?: boolean }>
  moveWindowLeft: () => Promise<void>
  moveWindowRight: () => Promise<void>
  moveWindowUp: () => Promise<void>
  moveWindowDown: () => Promise<void>
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>

  analyzeImageFile: (path: string) => Promise<void>
  quitApp: () => Promise<void>
  toggleWindow: () => Promise<void>
  showWindow: (inactive?: boolean) => Promise<void>
  hideWindow: () => Promise<void>
  showOverlay: () => Promise<void>
  hideOverlay: () => Promise<void>
  getMeetingActive: () => Promise<boolean>
  onMeetingStateChanged: (callback: (data: { isActive: boolean }) => void) => () => void
  onWindowMaximizedChanged: (callback: (isMaximized: boolean) => void) => () => void
  onEnsureExpanded: (callback: () => void) => () => void
  openExternal: (url: string) => Promise<void>
  setUndetectable: (state: boolean) => Promise<{ success: boolean; error?: string }>
  getUndetectable: () => Promise<boolean>
  setOverlayMousePassthrough: (enabled: boolean) => Promise<{ success: boolean }>
  toggleOverlayMousePassthrough: () => Promise<{ success: boolean; enabled: boolean }>
  getOverlayMousePassthrough: () => Promise<boolean>
  onOverlayMousePassthroughChanged: (callback: (enabled: boolean) => void) => () => void
  getProactiveMode: () => Promise<boolean>
  setProactiveMode: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  onProactiveModeChanged: (callback: (enabled: boolean) => void) => () => void
  setDisguise: (mode: 'terminal' | 'settings' | 'activity' | 'none') => Promise<{ success: boolean; error?: string }>
  getDisguise: () => Promise<'none' | 'terminal' | 'settings' | 'activity'>
  onDisguiseChanged: (callback: (mode: 'terminal' | 'settings' | 'activity' | 'none') => void) => () => void
  setOpenAtLogin: (open: boolean) => Promise<{ success: boolean; error?: string }>
  getOpenAtLogin: () => Promise<boolean>
  onSettingsVisibilityChange: (callback: (isVisible: boolean) => void) => () => void
  toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>
  openChatLogViewer: () => Promise<{ success: boolean; error?: string }>
  closeChatLogViewer: () => Promise<{ success: boolean; error?: string }>
  closeSettingsWindow: () => Promise<void>
  toggleAdvancedSettings: () => Promise<void>
  closeAdvancedSettings: () => Promise<void>

  // LLM Model Management
  getCurrentLlmConfig: () => Promise<{ provider: "claude" | "codex"; model: string; isOllama: false; reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' }>
  selectServiceAccount: () => Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }>

  // API Key Management
  setNativelyApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  getNativelyUsage: () => Promise<{ ok: boolean; error?: string; plan?: string; quota?: { transcription: { used: number; limit: number; remaining: number }; ai: { used: number; limit: number; remaining: number }; search: { used: number; limit: number; remaining: number }; resets_at: string }; member_since?: string }>
  getStoredCredentials: () => Promise<{ hasNativelyKey?: boolean; hasClaudeMax?: boolean; claudeMaxStatus?: 'ready' | 'expired' | 'missing' | 'invalid'; hasCodex?: boolean; googleServiceAccountPath: string | null; sttProvider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively'; hasSttGroqKey: boolean; hasSttOpenaiKey: boolean; hasDeepgramKey: boolean; hasElevenLabsKey: boolean; hasAzureKey: boolean; azureRegion: string; hasIbmWatsonKey: boolean; ibmWatsonRegion: string; groqSttModel?: string; hasSonioxKey?: boolean; hasTavilyKey?: boolean; sttGroqKey?: string; sttOpenaiKey?: string; sttDeepgramKey?: string; sttElevenLabsKey?: string; sttAzureKey?: string; sttIbmKey?: string; sttSonioxKey?: string }>

  // STT Provider Management
  setSttProvider: (provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively') => Promise<{ success: boolean; error?: string }>
  getSttProvider: () => Promise<string>
  setGroqSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setOpenAiSttApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setDeepgramApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setElevenLabsApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setAzureRegion: (region: string) => Promise<{ success: boolean; error?: string }>
  setIbmWatsonApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  setGroqSttModel: (model: string) => Promise<{ success: boolean; error?: string }>
  setSonioxApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>
  testSttConnection: (provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => Promise<{ success: boolean; error?: string }>

  // Native Audio Service Events
  onNativeAudioTranscript: (callback: (transcript: { speaker: string; sourceSpeaker?: string; speakerKey?: string; speakerLabel?: string | null; displaySpeakerLabel?: string; diarizedSpeaker?: string | null; speakerIdentity?: 'self' | 'other' | 'unknown'; text: string; final: boolean; timestamp?: number; confidence?: number }) => void) => () => void
  getMeetingSpeakerLabels: () => Promise<Record<string, string>>
  setMeetingSpeakerLabel: (speakerKey: string, label: string) => Promise<{ success: boolean; speakerKey: string; label: string | null; labels: Record<string, string> }>
  onMeetingSpeakerLabelsChanged: (callback: (labels: Record<string, string>) => void) => () => void
  getUserProfile: () => Promise<{ userDisplayName: string }>
  setUserDisplayName: (name: string) => Promise<{ success: boolean; userDisplayName: string }>
  onUserProfileChanged: (callback: (profile: { userDisplayName: string }) => void) => () => void
  onNativeAudioSuggestion: (callback: (suggestion: { context: string; lastQuestion: string; confidence: number }) => void) => () => void
  onNativeAudioConnected: (callback: () => void) => () => void
  onNativeAudioDisconnected: (callback: () => void) => () => void
  onSuggestionGenerated: (callback: (data: { question: string; suggestion: string; confidence: number }) => void) => () => void
  onSuggestionProcessingStart: (callback: () => void) => () => void
  onSuggestionError: (callback: (error: { error: string }) => void) => () => void
  generateSuggestion: (context: string, lastQuestion: string) => Promise<{ suggestion: string }>
  getInputDevices: () => Promise<Array<{ id: string; name: string }>>
  getOutputDevices: () => Promise<Array<{ id: string; name: string }>>
  setRecognitionLanguage: (key: string) => Promise<{ success: boolean; error?: string }>
  getAiResponseLanguages: () => Promise<Array<{ label: string; code: string }>>
  setAiResponseLanguage: (language: string) => Promise<{ success: boolean; error?: string }>
  getSttLanguage: () => Promise<string>
  getAiResponseLanguage: () => Promise<string>
  onSttLanguageAutoDetected: (callback: (bcp47: string) => void) => () => void

  getNativeAudioStatus: () => Promise<any>
  getMeetingReadinessStatus: () => Promise<any>

  // Intelligence Mode IPC
  generateAssist: () => Promise<{ insight: string | null }>
  generateWhatToSay: (question?: string, imagePaths?: string[], options?: { force?: boolean }) => Promise<{ answer: string | null; question?: string; error?: string }>
  generateClarify: () => Promise<{ clarification: string | null }>
  generateCodeHint: (imagePaths?: string[], problemStatement?: string) => Promise<{ hint: string | null }>
  generateBrainstorm: (imagePaths?: string[], problemStatement?: string) => Promise<{ script: string | null }>
  generateFollowUp: (intent: string, userRequest?: string) => Promise<{ refined: string | null; intent: string }>
  generateFollowUpQuestions: () => Promise<{ questions: string | null }>
  generateRecap: () => Promise<{ summary: string | null }>
  submitManualQuestion: (question: string) => Promise<{ answer: string | null; question: string }>
  getIntelligenceContext: () => Promise<{ context: string; lastAssistantMessage: string | null; activeMode: string }>
  resetIntelligence: () => Promise<{ success: boolean; error?: string }>

  // Dynamic Action Button Mode
  getActionButtonMode: () => Promise<'recap' | 'brainstorm'>
  setActionButtonMode: (mode: 'recap' | 'brainstorm') => Promise<{ success: boolean }>
  onActionButtonModeChanged: (callback: (mode: 'recap' | 'brainstorm') => void) => () => void

  // Meeting AI (IP Corp mode + Continuous OCR)
  setIPCorpMode: (enabled: boolean) => Promise<{ success: boolean; error?: string; warning?: string }>
  setContinuousOCR: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  getMeetingAIStatus: () => Promise<{ claudeMaxAvailable: boolean; claudeMaxStatus?: 'ready' | 'expired' | 'missing' | 'invalid'; ocrRunning: boolean; ipCorpMode: boolean; clawmemAvailable?: boolean; nexusAvailable?: boolean; ipCorpWarning?: string | null }>
  reloadMeetingMemory: () => Promise<{ success: boolean; chunks?: number; error?: string }>

  // Meeting Lifecycle
  startMeeting: (metadata?: any) => Promise<{ success: boolean; error?: string }>
  endMeeting: () => Promise<{ success: boolean; error?: string }>
  finalizeMicSTT: () => Promise<void>
  startMicSTT: () => Promise<{ success: boolean; error?: string }>
  stopMicSTT: () => Promise<{ success: boolean; error?: string }>
  getRecentMeetings: () => Promise<Array<{ id: string; title: string; date: string; duration: string; summary: string; source?: 'manual' | 'calendar' | 'teams' | 'cluely' | 'imported'; importMetadata?: { sourceFormat?: 'cluely' | 'teams' | 'generic'; importedAt?: string; fidelity?: string } }>>
  getMeetingDetails: (id: string) => Promise<any>
  getChatDebugEntries: (limit?: number) => Promise<Array<{ id: number; meetingId?: string | null; type: string; timestamp: number; userQuery: string; aiResponse: string; metadata: any }>>
  onChatDebugIssue: (callback: (issue: { id: number; surface: string; surfaceLabel: string; status: string; timestamp: number; userQuery: string; aiResponse: string; error: string | null; provider: string | null; modelId: string | null }) => void) => () => void
  getDisplayLayout: () => Promise<Array<{ id: number; label: string; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number; isPrimary: boolean }>>
  updateMeetingTitle: (id: string, title: string) => Promise<boolean>
  updateMeetingSummary: (id: string, updates: { overview?: string, actionItems?: string[], keyPoints?: string[], actionItemsTitle?: string, keyPointsTitle?: string, contextOverview?: any, userContextNotes?: any[] }) => Promise<boolean>
  addMeetingContextNote: (meetingId: string, text: string, source?: 'manual' | 'meeting_chat') => Promise<{ success: boolean; requestedMeetingId?: string; meetingId: string; note: any; meeting?: any }>
  generateMeetingOverview: (meetingId: string, options?: { force?: boolean }) => Promise<any>
  startClaudeLogin: () => Promise<{ success: boolean; launched?: boolean; alreadyLoggedIn?: boolean; error?: string }>
  deleteMeeting: (id: string) => Promise<boolean>
  setWindowMode: (mode: 'launcher' | 'overlay', inactive?: boolean) => Promise<void>

  // Intelligence Mode Events
  onIntelligenceAssistUpdate: (callback: (data: { insight: string }) => void) => () => void
  onIntelligenceSuggestedAnswerToken: (callback: (data: { token: string; question: string; confidence: number }) => void) => () => void
  onIntelligenceSuggestedAnswer: (callback: (data: { answer: string; question: string; confidence: number }) => void) => () => void
  onIntelligenceRefinedAnswerToken: (callback: (data: { token: string; intent: string }) => void) => () => void
  onIntelligenceRefinedAnswer: (callback: (data: { answer: string; intent: string }) => void) => () => void
  onIntelligenceFollowUpQuestionsUpdate: (callback: (data: { questions: string }) => void) => () => void
  onIntelligenceFollowUpQuestionsToken: (callback: (data: { token: string }) => void) => () => void
  onIntelligenceRecap: (callback: (data: { summary: string }) => void) => () => void
  onIntelligenceRecapToken: (callback: (data: { token: string }) => void) => () => void
  onIntelligenceClarify: (callback: (data: { clarification: string }) => void) => () => void
  onIntelligenceClarifyToken: (callback: (data: { token: string }) => void) => () => void
  onIntelligenceManualStarted: (callback: () => void) => () => void
  onIntelligenceManualResult: (callback: (data: { answer: string; question: string }) => void) => () => void
  onIntelligenceModeChanged: (callback: (data: { mode: string }) => void) => () => void
  onIntelligenceError: (callback: (data: { error: string, mode: string }) => void) => () => void;
  // Session Management
  onSessionReset: (callback: () => void) => () => void;
  onMeetingAudioError: (callback: (message: string) => void) => () => void;

  // Streaming listeners
  streamGeminiChat: (message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean, ignoreKnowledgeMode?: boolean, surface?: string }) => Promise<void>
  reviewChatMessage: (input: { text: string; reviewType: 'voice_pass' | 'technical_check'; sourceIntent?: string }) => Promise<{ reviewType: 'voice_pass' | 'technical_check'; reviewerModel: string; text: string; error?: string }>
  onGeminiStreamToken: (callback: (token: string) => void) => () => void
  onGeminiStreamDone: (callback: () => void) => () => void
  onGeminiStreamError: (callback: (error: string) => void) => () => void;

  // Model Management
  getDefaultModel: () => Promise<{ model: string }>;
  setModel: (modelId: string) => Promise<{ success: boolean; error?: string }>;
  setDefaultModel: (modelId: string) => Promise<{ success: boolean; error?: string }>;
  getReasoningEffort: () => Promise<{ effort: 'low' | 'medium' | 'high' | 'xhigh' }>;
  setReasoningEffort: (effort: 'low' | 'medium' | 'high' | 'xhigh') => Promise<{ success: boolean; error?: string }>;
  toggleModelSelector: (coords: { x: number; y: number }) => Promise<void>;

  // Settings Window
  toggleSettingsWindow: (coords?: { x: number; y: number }) => Promise<void>;

  // Demo
  seedDemo: () => Promise<{ success: boolean }>;

  // Follow-up Email
  generateFollowupEmail: (input: any) => Promise<string>;
  extractEmailsFromTranscript: (transcript: Array<{ text: string }>) => Promise<string[]>;
  getCalendarAttendees: (eventId: string) => Promise<Array<{ email: string; name: string }>>;
  openMailto: (params: { to: string; subject: string; body: string }) => Promise<{ success: boolean; error?: string }>;

  // Audio Test
  startAudioTest: (deviceId?: string) => Promise<{ success: boolean }>;
  stopAudioTest: () => Promise<{ success: boolean }>;
  onAudioTestLevel: (callback: (level: number) => void) => () => void;

  // Database
  flushDatabase: () => Promise<{ success: boolean }>;

  onUndetectableChanged: (callback: (state: boolean) => void) => () => void;
  onModelChanged: (callback: (modelId: string) => void) => () => void;
  onReasoningEffortChanged: (callback: (effort: 'low' | 'medium' | 'high' | 'xhigh') => void) => () => void;

  onOllamaPullProgress: (callback: (data: { status: string; percent: number }) => void) => () => void;
  onOllamaPullComplete: (callback: () => void) => () => void;

  onMeetingsUpdated: (callback: () => void) => () => void

  // Provider Compatibility
  onIncompatibleProviderWarning: (callback: (data: { count: number, oldProvider: string, newProvider: string }) => void) => () => void;
  reindexIncompatibleMeetings: () => Promise<void>;

  // Theme API
  getThemeMode: () => Promise<{ mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }>
  setThemeMode: (mode: 'system' | 'light' | 'dark') => Promise<void>
  onThemeChanged: (callback: (data: { mode: 'system' | 'light' | 'dark', resolved: 'light' | 'dark' }) => void) => () => void

  // Calendar
  calendarConnect: () => Promise<{ success: boolean; error?: string }>
  calendarDisconnect: () => Promise<{ success: boolean; error?: string }>
  getCalendarStatus: () => Promise<{ connected: boolean; email?: string; providers?: { google: boolean; outlook: boolean; teams: boolean }; warnings?: string[] }>
  getUpcomingEvents: () => Promise<Array<{ id: string; title: string; startTime: string; endTime: string; link?: string; description?: string; location?: string; attendees?: Array<{ email: string; displayName?: string; organizer?: boolean; optional?: boolean; responseStatus?: string }>; source: 'google' | 'outlook' }>>
  calendarRefresh: () => Promise<{ success: boolean; error?: string }>
  getMeetingPrepPacket: (eventId: string) => Promise<{
    event: { id: string; title: string; startTime: string; endTime: string; link?: string; description?: string; location?: string; attendees?: Array<{ email: string; displayName?: string }>; source: 'google' | 'outlook' };
    generatedAt: string;
    timing: { startsInMinutes: number; durationMinutes: number };
    sourceHealth: { calendar: boolean; memory: boolean; backgroundContext: boolean; roleBrief: boolean; liveResearch: boolean };
    summary: string;
    contextBullets: string[];
    profileSnapshot: string[];
    relatedMeetings: Array<{ id: string; title: string; date: string; summary: string; matchScore: number }>;
    memoryHighlights: Array<{ title: string; excerpt: string; source: string; type: string; date?: string; score: number }>;
    prepChecklist: string[];
    openQuestions: string[];
    openCommitments: string[];
    contextCapsule?: { id: string; filePath: string; markdownPath: string; confidence: 'low' | 'medium' | 'high'; needsUserInput: boolean; updatedAt: string };
  } | null>

  // Local Microsoft Bridges
  getMicrosoftLocalStatus: () => Promise<any>
  outlookListEmails: (options?: { top?: number; unreadOnly?: boolean }) => Promise<{ emails: any[]; totalCount: number }>
  outlookSearchEmails: (query: string, top?: number) => Promise<{ emails: any[]; totalCount: number }>
  outlookCreateDraft: (draft: any) => Promise<{ entryId: string }>
  outlookSendEmail: (draft: any) => Promise<{ success: boolean; error?: string }>
  outlookCreateCalendarEvent: (request: any) => Promise<{ entryId: string }>
  outlookReplyEmail: (entryId: string, body: string, replyAll?: boolean, send?: boolean) => Promise<{ success: boolean; error?: string }>
  teamsListChats: (limit?: number) => Promise<any[]>
  teamsGetMessages: (chatId: string, limit?: number) => Promise<any[]>
  teamsSendMessage: (chatId: string, text: string) => Promise<{ success: boolean; error?: string; warning?: string; verified?: boolean }>

  // Auto-Update
  onUpdateAvailable: (callback: (info: any) => void) => () => void
  onUpdateDownloaded: (callback: (info: any) => void) => () => void
  onUpdateChecking: (callback: () => void) => () => void
  onUpdateNotAvailable: (callback: (info: any) => void) => () => void
  onUpdateError: (callback: (err: string) => void) => () => void
  onDownloadProgress: (callback: (progressObj: any) => void) => () => void
  restartAndInstall: () => Promise<void>
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  testReleaseFetch: () => Promise<{ success: boolean; error?: string }>

  // RAG (Retrieval-Augmented Generation) API
  ragQueryMeeting: (meetingId: string, query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryLive: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragQueryGlobal: (query: string) => Promise<{ success?: boolean; fallback?: boolean; error?: string }>
  ragCancelQuery: (options: { meetingId?: string; global?: boolean; live?: boolean }) => Promise<{ success: boolean }>
  ragIsMeetingProcessed: (meetingId: string) => Promise<boolean>
  ragGetQueueStatus: () => Promise<{ pending: number; processing: number; completed: number; failed: number }>
  ragRetryEmbeddings: () => Promise<{ success: boolean }>
  onRAGStreamChunk: (callback: (data: { meetingId?: string; global?: boolean; live?: boolean; chunk: string }) => void) => () => void
  onRAGStreamComplete: (callback: (data: { meetingId?: string; global?: boolean; live?: boolean }) => void) => () => void
  onRAGStreamError: (callback: (data: { meetingId?: string; global?: boolean; live?: boolean; error: string }) => void) => () => void

  // Donation API
  getDonationStatus: () => Promise<{ shouldShow: boolean; hasDonated: boolean; lifetimeShows: number }>;
  markDonationToastShown: () => Promise<{ success: boolean }>;
  setDonationComplete: () => Promise<{ success: boolean }>;

  // Keybind Management
  getKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  setKeybind: (id: string, accelerator: string) => Promise<boolean>
  resetKeybinds: () => Promise<Array<{ id: string; label: string; accelerator: string; isGlobal: boolean; defaultAccelerator: string }>>
  onKeybindsUpdate: (callback: (keybinds: Array<any>) => void) => () => void
  onKeybindRegistrationFailed: (callback: (data: { id: string; accelerator: string }) => void) => () => void
  onGlobalShortcut: (callback: (data: { action: string }) => void) => () => void

  // Profile Engine API
  profileUploadResume: (filePath: string) => Promise<{ success: boolean; error?: string }>
  profileGetStatus: () => Promise<{ hasProfile: boolean; profileMode: boolean; name?: string; role?: string; totalExperienceYears?: number }>
  profileSetMode: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  profileDelete: () => Promise<{ success: boolean; error?: string }>
  profileGetProfile: () => Promise<any>
  profileSelectFile: () => Promise<{ success?: boolean; cancelled?: boolean; filePath?: string; error?: string }>
  meetingImportSelectFiles: () => Promise<{ success?: boolean; cancelled?: boolean; filePaths: string[]; error?: string }>
  meetingImportIngest: (artifacts: any[]) => Promise<{ importedMeetings: any[]; skippedArtifacts: Array<{ name: string; reason: string }>; totalArtifacts: number }>
  teamsImportDiscover: (limit?: number) => Promise<Array<{ chatId: string; meetingTitle: string; date?: string; hasTranscript: boolean }>>
  teamsImportIngest: (options?: { limit?: number; chatIds?: string[] }) => Promise<{ importedMeetings: any[]; skippedArtifacts: Array<{ name: string; reason: string }>; totalArtifacts: number; attemptedChats: number; discoveredCandidates: number }>
  cluelyImportDiscover: (limit?: number) => Promise<{ candidates: Array<{ sessionId: string; meetingTitle: string; date?: string; hasTranscript: boolean; hasSummary: boolean; hasUsage: boolean; source: 'live' | 'cached' }>; mode: 'live' | 'cached' | 'unavailable'; warning?: string; sessionEmail?: string; tokenFresh?: boolean }>
  cluelyImportIngest: (options?: { limit?: number; sessionIds?: string[] }) => Promise<{ importedMeetings: any[]; skippedArtifacts: Array<{ name: string; reason: string }>; totalArtifacts: number; attemptedSessions: number; discoveredCandidates: number; mode: 'live' | 'cached' | 'unavailable'; warning?: string }>
  getContextHubStatus: () => Promise<any>
  listBrainActionProposals: (limit?: number) => Promise<any[]>
  recordBrainActionOutcome: (input: { proposalId: string; decision: string; editSummary?: string; finalPayload?: unknown; error?: string; learningSignals?: string[] }) => Promise<{ success: boolean; filePath?: string; error?: string }>
  executeBrainActionProposal: (input: { proposalId: string; payload?: Record<string, unknown> }) => Promise<{ success: boolean; summary?: string; result?: any; error?: string }>
  getAutonomousOpsStatus: () => Promise<any>
  refreshAutonomousOpsStatus: () => Promise<any>
  startAutonomousWorkflow: (workflowId: string, options?: { goalId?: string; autonomyLevel?: 'observe' | 'assist' | 'bounded-auto' | 'approval-required' }) => Promise<any>
  stopAutonomousWorkflow: (workflowId: string) => Promise<{ success: boolean; error?: string }>
  invokeAutonomousWorkflowAction: (workflowId: string, actionId: string, payload?: Record<string, any>) => Promise<{ success: boolean; summary: string; output?: Record<string, any>; stdout?: string; stderr?: string }>
  onAutonomousOpsUpdated: (callback: (status: any) => void) => () => void
  getDurableWorkflowStatus: (limit?: number) => Promise<any>
  listDurableWorkflowRuns: (limit?: number) => Promise<any[]>

  // JD & Research API
  profileUploadJD: (filePath: string) => Promise<{ success: boolean; error?: string }>
  profileDeleteJD: () => Promise<{ success: boolean; error?: string }>
  profileResearchCompany: (companyName: string) => Promise<{ success: boolean; dossier?: any; error?: string; searchQuotaExhausted?: boolean }>
  profileGenerateNegotiation: (force?: boolean) => Promise<{ success: boolean; script?: any; error?: string }>
  profileGetNegotiationState: () => Promise<{ success: boolean; state?: any; isActive?: boolean; error?: string }>
  profileResetNegotiation: () => Promise<{ success: boolean; error?: string }>

  // Tavily Search API
  setTavilyApiKey: (apiKey: string) => Promise<{ success: boolean; error?: string }>

  // License Management
  licenseActivate: (key: string) => Promise<{ success: boolean; error?: string }>
  licenseCheckPremium: () => Promise<boolean>
  /** Async startup check — calls Dodo validate endpoint to detect server-side revocations. */
  licenseCheckPremiumAsync: () => Promise<boolean>
  licenseDeactivate: () => Promise<void>
  licenseGetHardwareId: () => Promise<string>

  // Overlay Opacity (Stealth Mode)
  setOverlayOpacity: (opacity: number) => Promise<void>;
  onOverlayOpacityChanged: (callback: (opacity: number) => void) => () => void;

  // Verbose / Debug Logging
  getVerboseLogging: () => Promise<boolean>;
  setVerboseLogging: (enabled: boolean) => Promise<{ success: boolean }>;

  // Arch
  getArch: () => Promise<string>;

  // Cropper API
  cropperConfirmed: (bounds: { x: number; y: number; width: number; height: number }) => void;
  cropperCancelled: () => void;
  onResetCropper: (callback: (data: { hudPosition: { x: number; y: number } }) => void) => () => void;

  // Platform
  platform: NodeJS.Platform;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
