import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, systemPreferences, screen, desktopCapturer } from "electron"
import path from "path"
import fs from "fs"
import { autoUpdater } from "electron-updater"
if (!app.isPackaged) {
  require('dotenv').config();
}

const earlyTraceFile = path.join(process.env.TEMP || process.cwd(), 'natively_startup_trace.log');
const earlyTrace = (message: string) => {
  try {
    fs.appendFileSync(earlyTraceFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Ignore best-effort startup trace failures.
  }
};

earlyTrace(`module-load packaged=${String(app?.isPackaged)} nodeEnv=${process.env.NODE_ENV ?? ''}`);

// This fork currently ships via local installers, not a managed release feed.
// Keep in-app auto-updates disabled unless a real update channel is configured.
const AUTO_UPDATES_ENABLED = process.env.NATIVELY_ENABLE_AUTO_UPDATES === '1';
const AUTONOMOUS_OPS_ENABLED = process.env.NATIVELY_ENABLE_AUTONOMOUS_OPS === '1';
const CONTEXT_STACK_BOOTSTRAP_ENABLED = process.env.NATIVELY_BOOTSTRAP_CONTEXT_STACK === '1';
const STARTUP_MEETING_RECOVERY_ENABLED = process.env.NATIVELY_ENABLE_STARTUP_MEETING_RECOVERY === '1';

const isDevelopmentElectronApp = !app.isPackaged && process.env.NODE_ENV === 'development';

const SHOW_ARGS = new Set(['--show', '--focus', '-show', '--focus-window', '/show', '/focus']);
const hasStartupShowRequest = process.argv.some((arg) => SHOW_ARGS.has(arg.toLowerCase()));
const CHAT_LOG_VIEWER_ARGS = new Set(['--chat-log-viewer', '--open-chat-log-viewer', '/chat-log-viewer']);
const hasStartupChatLogViewerRequest = process.argv.some((arg) => CHAT_LOG_VIEWER_ARGS.has(arg.toLowerCase()));

const isInvalidGoogleServiceAccountPath = (candidate?: string | null): boolean => {
  if (!candidate) return true;
  const normalized = candidate.replace(/\//g, '\\').toLowerCase();
  if (normalized.includes('\\path\\to\\your\\service-account.json')) {
    return true;
  }
  return !fs.existsSync(candidate);
};

if (isDevelopmentElectronApp) {
  try {
    // Keep dev and installed builds isolated so the packaged app is not blocked
    // by a local `npm start` session holding the same single-instance lock.
    app.setPath('userData', path.join(app.getPath('appData'), 'natively-dev'));
  } catch {
    // Non-fatal: the app can still run even if we fail to relocate dev userData.
  }
}

// Handle stdout/stderr errors at the process level to prevent EIO crashes
// This is critical for Electron apps that may have their terminal detached
process.stdout?.on?.('error', () => { });
process.stderr?.on?.('error', () => { });

process.on('uncaughtException', (err) => {
  logToFile('[CRITICAL] Uncaught Exception: ' + (err.stack || err.message || err));
});

process.on('unhandledRejection', (reason, promise) => {
  logToFile('[CRITICAL] Unhandled Rejection at: ' + promise + ' reason: ' + (reason instanceof Error ? reason.stack : reason));
});

// CQ-04 fix: do NOT call app.getPath() at module load time.
// app.getPath('documents') is not guaranteed to be available before app.whenReady().
// Use a lazy getter instead — the path is resolved on first logToFile() call.
let _logFile: string | null = null;
const getLogFile = (): string | null => {
  if (_logFile) return _logFile;
  try {
    _logFile = path.join(app.getPath('documents'), 'natively_debug.log');
    return _logFile;
  } catch {
    // app.ready not yet fired — return null, logToFile will skip silently
    return null;
  }
};

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

/** Maximum log file size before rotation (10 MB). */
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function logToFile(msg: string) {
  try {
    const logFile = getLogFile();
    // If the app isn't ready yet (path not available), skip silently.
    if (!logFile) return;

    // P2-1: rotate the log file when it exceeds LOG_MAX_BYTES so that long-running
    // sessions (or meetings with dense transcripts) don't fill the user's disk.
    // The previous log is kept as .log.1 for one-generation rollover.
    try {
      const stat = fs.statSync(logFile);
      if (stat.size >= LOG_MAX_BYTES) {
        const rotated = logFile + '.1';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(logFile, rotated);
      }
    } catch {
      // statSync throws if the file doesn't exist yet — that's fine
    }
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {
    // Ignore logging errors
  }
}

async function ensureMacMicrophoneAccess(context: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  try {
    const currentStatus = systemPreferences.getMediaAccessStatus('microphone');
    console.log(`[Main] macOS microphone permission before ${context}: ${currentStatus}`);

    if (currentStatus === 'granted') {
      return true;
    }

    const granted = await systemPreferences.askForMediaAccess('microphone');
    console.log(
      `[Main] macOS microphone permission request during ${context}: ${granted ? 'granted' : 'denied'}`
    );
    return granted;
  } catch (error) {
    console.error(`[Main] Failed to check macOS microphone permission during ${context}:`, error);
    return false;
  }
}

/**
 * Check macOS Screen Recording (kTCCServiceScreenCapture) permission status.
 *
 * Electron has no askForMediaAccess('screen') API — macOS only shows the TCC
 * dialog when the app actually calls a protected API (SCK / CoreAudio tap).
 * If the permission is 'denied', we cannot re-prompt; the user must re-enable
 * manually in System Settings → Privacy & Security → Screen Recording.
 *
 * Returns false only when the permission is explicitly 'denied'. All other
 * statuses ('granted', 'not-determined', 'restricted') return true because:
 *   - 'granted':         already allowed — nothing to do.
 *   - 'not-determined':  macOS will show the dialog when SCK/CoreAudio tap runs.
 *   - 'restricted':      managed device policy — nothing we can do programmatically.
 */
function getMacScreenCaptureStatus(): 'granted' | 'denied' | 'not-determined' | 'restricted' {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') as
      'granted' | 'denied' | 'not-determined' | 'restricted';
  } catch (error) {
    console.error('[Main] Failed to check screen recording permission:', error);
    return 'not-determined';
  }
}

console.log = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[LOG] ' + msg);
  try {
    originalLog.apply(console, args);
  } catch { }
};

console.warn = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[WARN] ' + msg);
  try {
    originalWarn.apply(console, args);
  } catch { }
};

console.error = (...args: any[]) => {
  const msg = args.map(a => (a instanceof Error) ? a.stack || a.message : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  logToFile('[ERROR] ' + msg);
  try {
    originalError.apply(console, args);
  } catch { }
};

import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { SettingsWindowHelper } from "./SettingsWindowHelper"
import { ModelSelectorWindowHelper } from "./ModelSelectorWindowHelper"
import { ChatLogViewerWindowHelper } from "./ChatLogViewerWindowHelper"
import { CropperWindowHelper } from "./CropperWindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { KeybindManager } from "./services/KeybindManager"
import { ProcessingHelper } from "./ProcessingHelper"

import { IntelligenceManager } from "./IntelligenceManager"
import { SystemAudioCapture } from "./audio/SystemAudioCapture"
import { MicrophoneCapture } from "./audio/MicrophoneCapture"
import { GoogleSTT } from "./audio/GoogleSTT"
import { RestSTT } from "./audio/RestSTT"
import { DeepgramStreamingSTT } from "./audio/DeepgramStreamingSTT"
import { SonioxStreamingSTT } from "./audio/SonioxStreamingSTT"
import { ElevenLabsStreamingSTT } from "./audio/ElevenLabsStreamingSTT"
import { OpenAIStreamingSTT } from "./audio/OpenAIStreamingSTT"
import { NativelyProSTT } from "./audio/NativelyProSTT"
import { ThemeManager } from "./ThemeManager"
import { RAGManager } from "./rag/RAGManager"
import { DatabaseManager } from "./db/DatabaseManager"
import { ContradictionDetector } from "./services/ContradictionDetector"
import { warmupIntentClassifier } from "./llm"

/** Unified type for all STT providers with optional extended capabilities */
type STTProvider = (GoogleSTT | RestSTT | DeepgramStreamingSTT | SonioxStreamingSTT | ElevenLabsStreamingSTT | OpenAIStreamingSTT | NativelyProSTT) & {
  finalize?: () => void;
  setAudioChannelCount?: (count: number) => void;
  notifySpeechEnded?: () => void;
};

type TranscriptSpeakerIdentity = "self" | "other" | "unknown";

type STTTranscriptSegment = {
  text: string;
  isFinal: boolean;
  confidence: number;
  diarizedSpeaker?: string | number | null;
  speakerId?: string | number | null;
  speakerLabel?: string | null;
};

type ScreenshotWindowMode = 'launcher' | 'overlay';
type ScreenshotCaptureKind = 'full' | 'selective';

interface ScreenshotCaptureSession {
  captureKind: ScreenshotCaptureKind;
  wasMainWindowVisible: boolean;
  windowMode: ScreenshotWindowMode;
  wasSettingsVisible: boolean;
  wasModelSelectorVisible: boolean;
  wasChatLogViewerVisible: boolean;
  overlayBounds: Electron.Rectangle | null;
  overlayDisplayId: number | null;
  restoreWithoutFocus: boolean;
}

// Premium: Knowledge modules loaded conditionally
let KnowledgeOrchestratorClass: any = null;
let KnowledgeDatabaseManagerClass: any = null;
try {
    KnowledgeOrchestratorClass = require('../premium/electron/knowledge/KnowledgeOrchestrator').KnowledgeOrchestrator;
    KnowledgeDatabaseManagerClass = require('../premium/electron/knowledge/KnowledgeDatabaseManager').KnowledgeDatabaseManager;
} catch {
    console.log('[Main] Knowledge modules not available — profile intelligence disabled.');
}

import { CredentialsManager } from "./services/CredentialsManager"
import { SettingsManager } from "./services/SettingsManager"
import { setVerboseLoggingFlag } from "./verboseLog"
import { ReleaseNotesManager } from "./update/ReleaseNotesManager"
import { OllamaManager } from './services/OllamaManager'
import { ContextRetrievalBroker } from "./context"
import { SemanticaBridgeService } from "./services/SemanticaBridgeService"
import { SemanticaMeetingIndexer } from "./services/SemanticaMeetingIndexer"
import { AutonomousOpsService } from "./autonomy"
import { RealtimeReflexPipeline } from "./services/RealtimeReflexPipeline"

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  public settingsWindowHelper: SettingsWindowHelper
  public modelSelectorWindowHelper: ModelSelectorWindowHelper
  public chatLogViewerWindowHelper: ChatLogViewerWindowHelper
  public cropperWindowHelper: CropperWindowHelper
  private screenshotHelper: ScreenshotHelper
  public processingHelper: ProcessingHelper

  private intelligenceManager: IntelligenceManager
  private themeManager: ThemeManager
  private ragManager: RAGManager | null = null
  private knowledgeOrchestrator: any = null
  private readonly reflexPipeline = new RealtimeReflexPipeline()
  private tray: Tray | null = null
  private updateAvailable: boolean = false
  private disguiseMode: 'terminal' | 'settings' | 'activity' | 'none' = 'none'

  // View management
  private view: "queue" | "solutions" = "queue"
  private isUndetectable: boolean = false

  private problemInfo: {
    problem_statement: string
    input_format: Record<string, any>
    output_format: Record<string, any>
    constraints: Array<Record<string, any>>
    test_cases: Array<Record<string, any>>
  } | null = null // Allow null

  private hasDebugged: boolean = false
  private isMeetingActive: boolean = false; // Guard for session state leaks
  private _isQuitting: boolean = false;
  private _verboseLogging: boolean = false;
  private _disguiseTimers: NodeJS.Timeout[] = []; // Track forceUpdate timeouts
  private _dockDebounceTimer: NodeJS.Timeout | null = null; // Debounce dock state changes
  private _dockReassertTimers: NodeJS.Timeout[] = []; // Re-assert dock-hidden state after show+focus
  private _ollamaBootstrapPromise: Promise<void> | null = null;
  private _semanticaBootstrapPromise: Promise<void> | null = null;
  private screenshotCaptureInProgress: boolean = false;
  private lastProactiveSuggestionAt: number = 0;
  private lastProactiveSuggestionSignature: string | null = null;
  private lastProactiveSuggestionKey: string | null = null;
  private lastProactiveSuggestionKeyAt: number = 0;
  private lastWakeWordVoiceAskAt: number = 0;
  private lastWakeWordVoiceAskSignature: string | null = null;
  private readonly proactiveSuggestionCooldownMs: number = 18_000;
  private readonly aggressiveProactiveSuggestionCooldownMs: number = 5_000;
  private readonly wakeWordVoiceAskCooldownMs: number = 4_000;
  private proactiveModeEnabled: boolean = false;
  private proactiveStartedContinuousOcr: boolean = false;
  private meetingPrepInterval: NodeJS.Timeout | null = null;
  private meetingPrepInFlight: boolean = false;
  private readinessEventsCache: any[] = [];
  private readinessEventsCachedAt: number = 0;
  private meetingStartedAt: number = 0;
  private audioPipelineStartedAt: number = 0;
  private lastAudioPipelineError: string | null = null;
  private lastSystemAudioChunkAt: number = 0;
  private systemAudioChunkCount: number = 0;
  private systemAudioBytes: number = 0;
  private lastMicAudioChunkAt: number = 0;
  private micAudioChunkCount: number = 0;
  private micAudioBytes: number = 0;
  private lastExternalTranscriptAt: number = 0;
  private externalTranscriptCount: number = 0;
  private lastExternalTranscriptText: string | null = null;
  private lastUserTranscriptAt: number = 0;
  private userTranscriptCount: number = 0;
  private lastUserTranscriptText: string | null = null;
  private meetingSpeakerLabels: Map<string, string> = new Map();
  private selfSpeakerKeys: Set<string> = new Set();


  // Processing events
  public readonly PROCESSING_EVENTS = {
    //global states
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",

    //states for generating the initial solution
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",

    //states for processing the debugging
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  constructor() {
    // 1. Load boot-critical settings first (used by WindowHelpers)
    const settingsManager = SettingsManager.getInstance();
    this.isUndetectable = settingsManager.get('isUndetectable') ?? false;
    this.disguiseMode = settingsManager.get('disguiseMode') ?? 'none';
    this._verboseLogging = settingsManager.get('verboseLogging') ?? false;
    this.proactiveModeEnabled = settingsManager.get('proactiveModeEnabled') ?? false;
    setVerboseLoggingFlag(this._verboseLogging);
    console.log(`[AppState] Initialized with isUndetectable=${this.isUndetectable}, disguiseMode=${this.disguiseMode}, verboseLogging=${this._verboseLogging}, proactiveMode=${this.proactiveModeEnabled}`);

    // 2. Initialize Helpers with loaded state
    this.windowHelper = new WindowHelper(this)
    this.settingsWindowHelper = new SettingsWindowHelper()
    this.modelSelectorWindowHelper = new ModelSelectorWindowHelper()
    this.chatLogViewerWindowHelper = new ChatLogViewerWindowHelper()
    this.cropperWindowHelper = new CropperWindowHelper()

    // 3. Initialize other helpers
    this.screenshotHelper = new ScreenshotHelper(this.view)
    this.processingHelper = new ProcessingHelper(this)

    this.windowHelper.setContentProtection(this.isUndetectable);
    this.settingsWindowHelper.setContentProtection(this.isUndetectable);
    this.modelSelectorWindowHelper.setContentProtection(this.isUndetectable);
    this.chatLogViewerWindowHelper.setContentProtection(this.isUndetectable);
    this.cropperWindowHelper.setContentProtection(this.isUndetectable);

    if (process.platform === 'win32' || process.platform === 'darwin') {
      this.cropperWindowHelper.preload();
    }

    // Initialize KeybindManager
    const keybindManager = KeybindManager.getInstance();
    keybindManager.setWindowHelper(this.windowHelper);
    keybindManager.setupIpcHandlers();
    keybindManager.onUpdate(() => {
      this.updateTrayMenu();
    });

    keybindManager.onShortcutTriggered(async (actionId) => {
      console.log(`[Main] Global shortcut triggered: ${actionId}`);
      try {
        if (actionId === 'general:toggle-visibility') {
          this.toggleMainWindow();
        } else if (actionId === 'general:toggle-mouse-passthrough') {
          // Adapted from public PR #113 — verify premium interaction
          this.toggleOverlayMousePassthrough();
        } else if (actionId === 'general:take-screenshot') {
          const screenshotPath = await this.takeScreenshot(false);
          const preview = await this.getImagePreview(screenshotPath);
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("screenshot-taken", {
              path: screenshotPath,
              preview
            });
          }
        } else if (actionId === 'general:selective-screenshot') {
          const screenshotPath = await this.takeSelectiveScreenshot(false);
          const preview = await this.getImagePreview(screenshotPath);
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            // preload.ts maps 'screenshot-attached' to onScreenshotAttached
            mainWindow.webContents.send("screenshot-attached", {
              path: screenshotPath,
              preview
            });
          }
        } else if (actionId === 'general:capture-and-process') {
          // Single-trigger: capture current screen then immediately request AI analysis
          const screenshotPath = await this.takeScreenshot(false);
          const preview = await this.getImagePreview(screenshotPath);
          // Ensure the window is visible so the user can see the response without stealing focus
          this.showMainWindow(true);
          // win.focus() can cause macOS to re-activate the app. Re-hide the dock
          // if we are in undetectable mode.
          if (process.platform === 'darwin' && this.isUndetectable) {
            app.dock.hide();
          }
          const mainWindow = this.getMainWindow();
          if (mainWindow) {
            mainWindow.webContents.send("capture-and-process", {
              path: screenshotPath,
              preview
            });
          }

        // --- STEALTH SHORTCUTS: no focus, no show, pure IPC dispatch ---

        // Chat actions — fire into the renderer without focusing the window
        } else if (
          actionId === 'chat:whatToAnswer' ||
          actionId === 'chat:clarify' ||
          actionId === 'chat:followUp' ||
          actionId === 'chat:answer' ||
          actionId === 'chat:codeHint' ||
          actionId === 'chat:brainstorm' ||
          actionId === 'chat:dynamicAction4' ||
          actionId === 'chat:scrollUp' ||
          actionId === 'chat:scrollDown'
        ) {
          const actionMap: Record<string, string> = {
            'chat:whatToAnswer': 'whatToAnswer',
            'chat:clarify': 'clarify',
            'chat:followUp': 'followUp',
            'chat:answer': 'answer',
            'chat:codeHint': 'codeHint',
            'chat:brainstorm': 'brainstorm',
            'chat:dynamicAction4': 'dynamicAction4',
            'chat:scrollUp': 'scrollUp',
            'chat:scrollDown': 'scrollDown',
          };
          const action = actionMap[actionId];
          // Send to all windows without focusing — stealth operation
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action });
            }
          });

        // Window movement — move window position without focus change
        } else if (actionId === 'window:move-up') {
          this.windowHelper.moveWindowUp();
        } else if (actionId === 'window:move-down') {
          this.windowHelper.moveWindowDown();
        } else if (actionId === 'window:move-left') {
          this.windowHelper.moveWindowLeft();
        } else if (actionId === 'window:move-right') {
          this.windowHelper.moveWindowRight();

        // General actions that are now global (stealth)
        } else if (actionId === 'general:process-screenshots') {
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action: 'processScreenshots' });
            }
          });
        } else if (actionId === 'general:reset-cancel') {
          const allWindows = BrowserWindow.getAllWindows();
          allWindows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('global-shortcut', { action: 'resetCancel' });
            }
          });
        }
      } catch (e: any) {
        if (e.message !== "Selection cancelled" && e.message !== "Screenshot capture already in progress") {
          console.error(`[Main] Error handling global shortcut ${actionId}:`, e);
        }
      }
    });

    // Inject WindowHelper into other helpers
    this.settingsWindowHelper.setWindowHelper(this.windowHelper);
    this.modelSelectorWindowHelper.setWindowHelper(this.windowHelper);
    this.chatLogViewerWindowHelper.setWindowHelper(this.windowHelper);





    // Initialize IntelligenceManager with LLMHelper
    this.intelligenceManager = new IntelligenceManager(this.processingHelper.getLLMHelper())
    this.intelligenceManager.setProactiveModeEnabled(this.proactiveModeEnabled);
    if (this.proactiveModeEnabled) {
      this.applyProactiveCoachModel();
    }

    // Wire ContradictionDetector with LLMHelper for post-meeting processing
    ContradictionDetector.getInstance().setLLMHelper(this.processingHelper.getLLMHelper());

    // Initialize MeetingMemoryBrain so contradiction detection has a populated index
    // even if IP Corp mode is never toggled on (lazy init in IPCorpContextBuilder
    // only fires when the user activates IP Corp mode).
    {
      const { MeetingMemoryBrain } = require('./services/MeetingMemoryBrain');
      try {
        const dbManager = DatabaseManager.getInstance();
        const initializePromise = MeetingMemoryBrain.getInstance().initialize(dbManager);
        if (initializePromise && typeof initializePromise.catch === 'function') {
          initializePromise.catch((e: any) => {
            console.warn('[AppState] MeetingMemoryBrain background init failed:', e?.message || e);
          });
        }
      } catch (e: any) {
        console.warn('[AppState] MeetingMemoryBrain initialization unavailable:', e?.message || e);
      }
    }

    {
      try {
        const { BrainMeetingIngestionService } = require('./services/BrainMeetingIngestionService');
        BrainMeetingIngestionService.getInstance().start(DatabaseManager.getInstance());
      } catch (e: any) {
        console.warn('[AppState] Brain meeting ingestion unavailable:', e?.message || e);
      }
    }

    // Initialize ThemeManager
    this.themeManager = ThemeManager.getInstance()

    // Initialize RAGManager (requires database to be ready)
    this.initializeRAGManager()
    try {
      const { MeetingTranscriptBackfillService } = require('./services/MeetingTranscriptBackfillService');
      MeetingTranscriptBackfillService.getInstance().schedule({
        llmHelper: this.processingHelper.getLLMHelper(),
        ragManager: this.ragManager,
      });
    } catch (e: any) {
      console.warn('[AppState] Meeting transcript backfill unavailable:', e?.message || e);
    }
    if (process.env.NATIVELY_ENABLE_SEMANTICA_CONTEXT === "1") {
      this.initializeSemanticaContext()
    } else {
      console.log("[AppState] Semantica context disabled. Natively reads IP Corp brain repo read models instead.");
    }
    
    // Check and prep Ollama embedding model
    this.bootstrapOllamaEmbeddings()


    this.setupIntelligenceEvents()

    // Pre-warm the zero-shot intent classifier in background
    warmupIntentClassifier();

    // Setup Ollama IPC
    this.setupOllamaIpcHandlers()

    // --- NEW SYSTEM AUDIO PIPELINE (SOX + NODE GOOGLE STT) ---
    // LAZY INIT: Do not setup pipeline here to prevent launch volume surge.
    // this.setupSystemAudioPipeline()

    // Initialize Auto-Updater
    this.setupAutoUpdater()
  }

  private broadcast(channel: string, ...args: any[]): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    });
  }

  public getIsMeetingActive(): boolean {
    return this.isMeetingActive;
  }

  public isQuitting(): boolean {
    return this._isQuitting;
  }

  public setQuitting(value: boolean): void {
    this._isQuitting = value;
  }

  private broadcastMeetingState(): void {
    this.broadcast('meeting-state-changed', { isActive: this.isMeetingActive });
  }

  private maybeTriggerProactiveSuggestion(text: string, confidence: number = 0.8, source: "interim" | "final" = "final"): void {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!this.isMeetingActive) {
      return;
    }

    const shouldTrigger = this.proactiveModeEnabled
      ? source === "interim"
        ? this.shouldTriggerInterimProactiveSuggestion(cleaned)
        : this.shouldTriggerAggressiveProactiveSuggestion(cleaned)
      : this.shouldTriggerProactiveSuggestion(cleaned);

    if (!shouldTrigger) {
      return;
    }

    const activeMode = this.intelligenceManager.getActiveMode();
    if (activeMode !== 'idle' && activeMode !== 'assist') {
      return;
    }

    const now = Date.now();
    const cooldownMs = source === "interim" && this.proactiveModeEnabled
      ? 12_000
      : this.proactiveModeEnabled
      ? this.aggressiveProactiveSuggestionCooldownMs
      : this.proactiveSuggestionCooldownMs;
    if (now - this.lastProactiveSuggestionAt < cooldownMs) {
      return;
    }

    const signature = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(-180);
    if (signature && signature === this.lastProactiveSuggestionSignature) {
      return;
    }

    const suggestionKey = this.buildProactiveSuggestionKey(cleaned);
    if (
      this.proactiveModeEnabled &&
      suggestionKey &&
      this.lastProactiveSuggestionKey &&
      now - this.lastProactiveSuggestionKeyAt < 60_000 &&
      this.areProactiveSuggestionKeysSimilar(suggestionKey, this.lastProactiveSuggestionKey)
    ) {
      return;
    }

    this.lastProactiveSuggestionAt = now;
    this.lastProactiveSuggestionSignature = signature;
    if (suggestionKey) {
      this.lastProactiveSuggestionKey = suggestionKey;
      this.lastProactiveSuggestionKeyAt = now;
    }
    this.getWindowHelper().getOverlayWindow()?.webContents.send('ensure-expanded');
    console.log(`[Main] Proactive meeting suggestion fired (${source}): ${cleaned.slice(0, 120)}`);

    void this.intelligenceManager.handleSuggestionTrigger({
      context: this.intelligenceManager.getFormattedContext(180),
      lastQuestion: cleaned,
      confidence: Math.max(this.proactiveModeEnabled ? (source === "interim" ? 0.5 : 0.55) : 0.7, Math.min(1, confidence || 0.8))
    }).catch((error: any) => {
      console.warn('[Main] Proactive meeting suggestion failed:', error?.message || error);
    });
  }

  private maybeTriggerWakeWordVoiceAsk(text: string, confidence: number = 0.8, isFinal: boolean = false): void {
    if (!this.proactiveModeEnabled) {
      return;
    }

    const cleaned = text.replace(/\s+/g, " ").trim();
    const wakeRequest = this.extractWakeWordRequest(cleaned);
    if (!wakeRequest) {
      return;
    }

    if (this.isSetupVoiceTestUtterance(wakeRequest)) {
      console.log('[Main] Wake-word setup/test utterance ignored.');
      return;
    }

    if (!isFinal && wakeRequest.length < 12) {
      return;
    }

    const activeMode = this.intelligenceManager.getActiveMode();
    if (activeMode !== 'idle' && activeMode !== 'assist') {
      console.log(`[Main] Wake-word voice ask suppressed; active mode=${activeMode}`);
      return;
    }

    const now = Date.now();
    if (now - this.lastWakeWordVoiceAskAt < this.wakeWordVoiceAskCooldownMs) {
      return;
    }

    const signature = wakeRequest.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(-180);
    if (signature && signature === this.lastWakeWordVoiceAskSignature) {
      return;
    }

    this.lastWakeWordVoiceAskAt = now;
    this.lastWakeWordVoiceAskSignature = signature;
    this.getWindowHelper().getOverlayWindow()?.webContents.send('ensure-expanded');
    console.log(`[Main] Wake-word proactive voice ask fired: ${wakeRequest.slice(0, 120)}`);

    void this.runWakeWordVoiceAsk(wakeRequest, confidence).catch((error: any) => {
      console.warn('[Main] Wake-word proactive voice ask failed:', error?.message || error);
    });
  }

  private async runWakeWordVoiceAsk(wakeRequest: string, confidence: number = 0.8): Promise<void> {
    const normalizedConfidence = Math.max(0.72, Math.min(1, confidence || 0.8));

    if (this.isScreenReadRequest(wakeRequest)) {
      const imagePaths: string[] = [];
      try {
        const screenshotPath = await this.takeContextScreenshot(false);
        if (screenshotPath) {
          imagePaths.push(screenshotPath);
        }
      } catch (error: any) {
        console.warn('[Main] Wake-word screen capture failed; falling back to OCR context:', error?.message || error);
      }

      await this.intelligenceManager.runWhatShouldISay(
        wakeRequest,
        normalizedConfidence,
        imagePaths.length ? imagePaths : undefined,
        { force: true }
      );
      return;
    }

    await this.intelligenceManager.handleSuggestionTrigger({
      context: this.intelligenceManager.getFormattedContext(180),
      lastQuestion: wakeRequest,
      confidence: normalizedConfidence,
    });
  }

  private extractWakeWordRequest(text: string): string | null {
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return null;

    const wakeMatch = cleaned.match(/\b(?:hey\s+)?(?:natively|native\s+lee|native\s+ly|nativeley)\b[\s,.:;!-]*/i);
    if (!wakeMatch || wakeMatch.index === undefined) {
      return null;
    }

    const beforeWake = cleaned.slice(0, wakeMatch.index).trim();
    const afterWake = cleaned.slice(wakeMatch.index + wakeMatch[0].length).trim();
    const request = (afterWake || beforeWake).replace(/^[,.:;!-]+|[,.:;!-]+$/g, "").trim();
    return request || "What should I say right now based on the current meeting?";
  }

  private isSetupVoiceTestUtterance(text: string): boolean {
    const lower = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
    return /^(can you hear me|do you hear me|are you listening|testing|test test|mic check|microphone check)$/.test(lower);
  }

  private isScreenReadRequest(text: string): boolean {
    const lower = text.trim().toLowerCase();
    return [
      /what(?:'s| is) on my screen/,
      /what am i looking at/,
      /what do you see/,
      /what(?:'s| is) visible/,
      /describe (?:my|the) screen/,
      /analy(?:s|z)e (?:my|the|this) screen/,
      /summari(?:s|z)e (?:my|the|this) screen/,
      /read (?:my|the|this) screen/,
      /what(?:'s| is) happening on (?:my|the) screen/,
    ].some((pattern) => pattern.test(lower));
  }

  private shouldTriggerProactiveSuggestion(text: string): boolean {
    if (text.length < 12 || text.length > 700) {
      return false;
    }

    const lower = text.toLowerCase();
    const questionLike =
      text.includes('?') ||
      /\b(what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you|does that make sense)\b/.test(lower);
    const ipCorpCue =
      /\b(ip corp|interplastic|molding products|fabric|purview|m3|mes|mdm|citrine|batch id|batch|lakehouse|warehouse|semantic model|power bi|source system|medallion|data product|governance)\b/.test(lower);
    const decisionCue =
      /\b(should we|can we|could we|would we|do we|how do we|what if|what about|recommend|approach|decision|risk|timeline|scope)\b/.test(lower);

    return questionLike && (directedAtSteve || ipCorpCue || decisionCue);
  }

  private shouldTriggerAggressiveProactiveSuggestion(text: string): boolean {
    if (text.length < 10 || text.length > 900) {
      return false;
    }

    const lower = text.toLowerCase();
    if (/^(yeah|yes|yep|ok|okay|right|sure|thanks|thank you|mmhmm|uh huh)[\s.!?]*$/.test(lower)) {
      return false;
    }

    const questionLike =
      text.includes('?') ||
      /\b(what|why|how|when|where|who|which|can|could|would|should|do|does|did|is|are|was|were)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you|does that make sense)\b/.test(lower);
    const ipCorpCue =
      /\b(ip corp|interplastic|molding products|fabric|purview|m3|mes|mdm|citrine|batch id|batch|lakehouse|warehouse|semantic model|power bi|source system|medallion|data product|governance|steward|stewardship|policy|exception|ownership)\b/.test(lower);
    const decisionCue =
      /\b(should we|can we|could we|would we|do we|how do we|what if|what about|recommend|approach|decision|risk|timeline|scope|tradeoff|owner|approval|next step)\b/.test(lower);
    const actionCue =
      /\b(action item|follow up|blocker|dependency|deadline|commit|commitment|need from|walk away with|decide today|align on|proposal|recommendation)\b/.test(lower);

    return questionLike || directedAtSteve || ipCorpCue || decisionCue || actionCue;
  }

  private shouldTriggerInterimProactiveSuggestion(text: string): boolean {
    if (text.length < 28 || text.length > 700) {
      return false;
    }

    const lower = text.toLowerCase();
    if (/^(yeah|yes|yep|ok|okay|right|sure|thanks|thank you|mmhmm|uh huh)[\s.!?]*$/.test(lower)) {
      return false;
    }

    const questionLike =
      text.includes('?') ||
      /\b(what|why|how|when|where|who|which|can|could|would|should)\b/.test(lower);
    const directedAtSteve =
      /\b(steve|any thoughts|what do you think|what's your take|what is your take|do you have thoughts|can you walk|could you walk|can you explain|could you explain|would you recommend|how would you)\b/.test(lower);
    const explicitDecisionAsk =
      /\b(should we|what should|what would|how would|recommend|recommendation|need to decide|decision we need|decision do we|walk out with|decide today|align on|approval boundary|who owns|named owner)\b/.test(lower);

    return directedAtSteve || explicitDecisionAsk || (questionLike && /\b(decision|owner|approval|recommend|risk|next step|follow up|policy|exception|steward)\b/.test(lower));
  }

  private buildProactiveSuggestionKey(text: string): string {
    const stopWords = new Set([
      "about", "after", "again", "also", "because", "being", "could", "from", "have",
      "into", "just", "like", "make", "more", "need", "really", "should", "that",
      "their", "there", "these", "they", "this", "those", "what", "when", "where",
      "which", "with", "would", "your"
    ]);

    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word))
      .slice(-36)
      .join(" ");
  }

  private areProactiveSuggestionKeysSimilar(nextKey: string, previousKey: string): boolean {
    if (!nextKey || !previousKey) {
      return false;
    }

    if (nextKey.includes(previousKey) || previousKey.includes(nextKey)) {
      return true;
    }

    const nextTokens = new Set(nextKey.split(/\s+/).filter(Boolean));
    const previousTokens = new Set(previousKey.split(/\s+/).filter(Boolean));
    if (nextTokens.size < 4 || previousTokens.size < 4) {
      return false;
    }

    let overlap = 0;
    nextTokens.forEach(token => {
      if (previousTokens.has(token)) {
        overlap += 1;
      }
    });

    return overlap / Math.min(nextTokens.size, previousTokens.size) >= 0.72;
  }

  private recordAudioChunk(source: "system" | "microphone", byteLength: number): void {
    const now = Date.now();
    if (source === "system") {
      this.lastSystemAudioChunkAt = now;
      this.systemAudioChunkCount += 1;
      this.systemAudioBytes += byteLength;
      return;
    }

    this.lastMicAudioChunkAt = now;
    this.micAudioChunkCount += 1;
    this.micAudioBytes += byteLength;
  }

  private recordTranscriptFrame(speaker: "external" | "user", text: string, timestamp: number): void {
    const cleanText = (text || "").replace(/\s+/g, " ").trim();
    if (!cleanText) return;

    if (speaker === "external") {
      this.lastExternalTranscriptAt = timestamp;
      this.externalTranscriptCount += 1;
      this.lastExternalTranscriptText = cleanText.slice(-240);
      return;
    }

    this.lastUserTranscriptAt = timestamp;
    this.userTranscriptCount += 1;
    this.lastUserTranscriptText = cleanText.slice(-240);
  }

  private recordAudioPipelineError(scope: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastAudioPipelineError = `${scope}: ${message}`;
  }

  private relativeMs(timestamp: number): number | null {
    return timestamp > 0 ? Math.max(0, Date.now() - timestamp) : null;
  }

  private isFresh(timestamp: number, windowMs: number): boolean {
    return timestamp > 0 && Date.now() - timestamp <= windowMs;
  }

  private normalizeDiarizedSpeaker(segment: STTTranscriptSegment): string | null {
    const candidate = segment.diarizedSpeaker ?? segment.speakerId ?? null;
    if (candidate === null || candidate === undefined || candidate === "") {
      return null;
    }
    return String(candidate).replace(/\s+/g, "_").trim();
  }

  private defaultDiarizedSpeakerLabel(diarizedSpeaker: string | null): string | null {
    if (!diarizedSpeaker) return null;
    const numeric = diarizedSpeaker.match(/(\d+)$/)?.[1];
    if (numeric !== undefined) {
      return `Speaker ${Number(numeric) + 1}`;
    }
    return diarizedSpeaker
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private normalizeSpeakerLabel(label: string): string {
    return (label || "").replace(/\s+/g, " ").trim().slice(0, 60);
  }

  public getUserDisplayName(): string {
    const configured = SettingsManager.getInstance().get('userDisplayName');
    const cleanName = this.normalizeSpeakerLabel(configured || "");
    return cleanName || "Steve";
  }

  public setUserDisplayName(name: string): { success: boolean; userDisplayName: string } {
    const cleanName = this.normalizeSpeakerLabel(name);
    if (!cleanName) {
      throw new Error("Name is required.");
    }
    SettingsManager.getInstance().set('userDisplayName', cleanName);
    this._broadcastToAllWindows("user-profile-changed", { userDisplayName: cleanName });
    return { success: true, userDisplayName: cleanName };
  }

  private maybeRememberUserDisplayName(label: string): void {
    const cleanLabel = this.normalizeSpeakerLabel(label);
    if (!cleanLabel || /^(me|myself|self|you)$/i.test(cleanLabel)) {
      return;
    }
    SettingsManager.getInstance().set('userDisplayName', cleanLabel);
    this._broadcastToAllWindows("user-profile-changed", { userDisplayName: cleanLabel });
  }

  private isSelfSpeakerLabel(label: string): boolean {
    const cleanLabel = this.normalizeSpeakerLabel(label).toLowerCase();
    const userName = this.getUserDisplayName().toLowerCase();
    return /^(me|myself|self|you)$/i.test(cleanLabel) || cleanLabel === userName;
  }

  private resolveSpeakerIdentity(
    speaker: "external" | "user",
    speakerKey: string,
    speakerLabel: string | null
  ): TranscriptSpeakerIdentity {
    if (speaker === "external") return "other";
    if (this.selfSpeakerKeys.has(speakerKey)) return "self";
    if (speakerLabel && this.isSelfSpeakerLabel(speakerLabel)) return "self";
    if (speakerLabel) return "other";
    return "unknown";
  }

  private getSpeakerLabelSnapshot(): Record<string, string> {
    return Object.fromEntries(this.meetingSpeakerLabels.entries());
  }

  public getMeetingSpeakerLabels(): Record<string, string> {
    return this.getSpeakerLabelSnapshot();
  }

  public setMeetingSpeakerLabel(speakerKey: string, label: string): {
    success: boolean;
    speakerKey: string;
    label: string | null;
    labels: Record<string, string>;
  } {
    const key = this.normalizeSpeakerLabel(speakerKey);
    if (!key) {
      throw new Error("Speaker key is required.");
    }

    const cleanLabel = this.normalizeSpeakerLabel(label);
    if (cleanLabel) {
      this.meetingSpeakerLabels.set(key, cleanLabel);
      if (this.isSelfSpeakerLabel(cleanLabel)) {
        this.selfSpeakerKeys.add(key);
        this.maybeRememberUserDisplayName(cleanLabel);
      } else {
        this.selfSpeakerKeys.delete(key);
      }
    } else {
      this.meetingSpeakerLabels.delete(key);
      this.selfSpeakerKeys.delete(key);
    }

    const labels = this.getSpeakerLabelSnapshot();
    this._broadcastToAllWindows("meeting-speaker-labels-changed", labels);
    return { success: true, speakerKey: key, label: cleanLabel || null, labels };
  }

  private isContinuousOcrRunning(): boolean {
    try {
      const { ContinuousOCRService } = require('./services/ContinuousOCRService');
      return Boolean(ContinuousOCRService.getInstance().isRunning());
    } catch {
      return false;
    }
  }

  private startProactiveScreenContext(): void {
    if (!this.proactiveModeEnabled || !this.isMeetingActive) {
      return;
    }

    try {
      const { ContinuousOCRService } = require('./services/ContinuousOCRService');
      const service = ContinuousOCRService.getInstance();
      if (service.isRunning()) {
        return;
      }

      this.processingHelper.getLLMHelper().startContinuousOCR();
      this.proactiveStartedContinuousOcr = true;
      console.log('[Main] Proactive screen context started for active meeting.');
    } catch (error) {
      this.recordAudioPipelineError('Proactive screen context', error);
      console.warn('[Main] Failed to start proactive screen context:', error);
    }
  }

  private stopProactiveScreenContextIfOwned(): void {
    if (!this.proactiveStartedContinuousOcr) {
      return;
    }

    try {
      this.processingHelper.getLLMHelper().stopContinuousOCR();
    } catch (error) {
      console.warn('[Main] Failed to stop proactive screen context:', error);
    } finally {
      this.proactiveStartedContinuousOcr = false;
    }
  }

  public rememberReadinessEvents(events: any[]): void {
    if (!Array.isArray(events)) return;
    this.readinessEventsCache = events;
    this.readinessEventsCachedAt = Date.now();
  }

  public getNativeAudioRuntimeStatus(): any {
    const now = Date.now();
    const systemFresh = this.isFresh(this.lastSystemAudioChunkAt, 10_000);
    const micFresh = this.isFresh(this.lastMicAudioChunkAt, 10_000);
    const externalTranscriptFresh = this.isFresh(this.lastExternalTranscriptAt, 30_000);
    const userTranscriptFresh = this.isFresh(this.lastUserTranscriptAt, 30_000);
    const ocrRunning = this.isContinuousOcrRunning();

    return {
      connected: Boolean(this.googleSTT || this.googleSTT_User),
      meetingActive: this.isMeetingActive,
      pipelineStarted: this.audioPipelineStartedAt > 0,
      pipelineStartedAt: this.audioPipelineStartedAt ? new Date(this.audioPipelineStartedAt).toISOString() : null,
      lastError: this.lastAudioPipelineError,
      system: {
        active: Boolean(this.systemAudioCapture && this.googleSTT),
        chunks: this.systemAudioChunkCount,
        bytes: this.systemAudioBytes,
        lastChunkAt: this.lastSystemAudioChunkAt ? new Date(this.lastSystemAudioChunkAt).toISOString() : null,
        lastChunkAgeMs: this.relativeMs(this.lastSystemAudioChunkAt),
        fresh: systemFresh,
        transcriptCount: this.externalTranscriptCount,
        lastTranscriptAt: this.lastExternalTranscriptAt ? new Date(this.lastExternalTranscriptAt).toISOString() : null,
        lastTranscriptAgeMs: this.relativeMs(this.lastExternalTranscriptAt),
        transcriptFresh: externalTranscriptFresh,
        lastTranscriptText: this.lastExternalTranscriptText,
      },
      microphone: {
        active: Boolean(this.microphoneCapture && this.googleSTT_User),
        chunks: this.micAudioChunkCount,
        bytes: this.micAudioBytes,
        lastChunkAt: this.lastMicAudioChunkAt ? new Date(this.lastMicAudioChunkAt).toISOString() : null,
        lastChunkAgeMs: this.relativeMs(this.lastMicAudioChunkAt),
        fresh: micFresh,
        transcriptCount: this.userTranscriptCount,
        lastTranscriptAt: this.lastUserTranscriptAt ? new Date(this.lastUserTranscriptAt).toISOString() : null,
        lastTranscriptAgeMs: this.relativeMs(this.lastUserTranscriptAt),
        transcriptFresh: userTranscriptFresh,
        lastTranscriptText: this.lastUserTranscriptText,
      },
      screen: {
        ocrRunning,
        startedByProactiveMode: this.proactiveStartedContinuousOcr,
      },
      generatedAt: new Date(now).toISOString(),
    };
  }

  public async getMeetingReadinessStatus(): Promise<any> {
    const checks: Array<{ id: string; label: string; status: "ready" | "warming" | "warning" | "failed"; detail: string }> = [];
    const audio = this.getNativeAudioRuntimeStatus();

    let events: any[] = this.readinessEventsCache;
    let prep: any = null;
    try {
      const { MeetingPrepService } = require("./services/MeetingPrepService");
      const cacheFresh = this.readinessEventsCachedAt > 0 && Date.now() - this.readinessEventsCachedAt < 60_000;
      if (!this.isMeetingActive && !cacheFresh) {
        const { CalendarManager } = require("./services/CalendarManager");
        events = await CalendarManager.getInstance().getUpcomingEvents();
        this.rememberReadinessEvents(events);
      }
      prep = MeetingPrepService.getInstance().getReadinessSnapshot(events);
    } catch (error: any) {
      prep = {
        cachedPacketCount: 0,
        nextMeeting: null,
        nextPacketReady: false,
        lastWarmError: error?.message || "Calendar/prep status unavailable",
      };
    }

    const brainRoot = path.join(app.getPath("home"), "CascadeProjects", "ipcorp-architecture-brain");
    const brainReady = fs.existsSync(brainRoot);
    checks.push({
      id: "brain",
      label: "IP Corp Brain",
      status: brainReady ? "ready" : "failed",
      detail: brainReady ? "Architecture brain repo is reachable." : "Architecture brain repo was not found.",
    });

    if (prep?.nextMeeting) {
      const startsIn = prep.nextMeeting.startsInMinutes;
      checks.push({
        id: "prep",
        label: "Meeting Prep",
        status: prep.nextPacketReady ? "ready" : prep.inAutoPrepWindow || this.meetingPrepInFlight ? "warming" : startsIn <= 60 ? "warning" : "ready",
        detail: prep.nextPacketReady
          ? `${prep.nextMeeting.title} packet ready.`
          : `${prep.nextMeeting.title} starts in ${startsIn} min; prep packet not ready yet.`,
      });
    } else {
      checks.push({
        id: "prep",
        label: "Meeting Prep",
        status: "ready",
        detail: "No upcoming calendar meeting needs prep right now.",
      });
    }

    checks.push({
      id: "microphone",
      label: "Microphone",
      status: !this.isMeetingActive ? "warming" : audio.microphone.fresh ? "ready" : "warning",
      detail: audio.microphone.fresh
        ? `Mic audio flowing; last chunk ${Math.round((audio.microphone.lastChunkAgeMs || 0) / 1000)}s ago.`
        : this.isMeetingActive ? "No fresh microphone audio observed." : "Waiting for a meeting or voice ask.",
    });

    checks.push({
      id: "meeting_audio",
      label: "Meeting Audio",
      status: !this.isMeetingActive ? "warming" : audio.system.fresh ? "ready" : "warning",
      detail: audio.system.fresh
        ? `System audio flowing; last chunk ${Math.round((audio.system.lastChunkAgeMs || 0) / 1000)}s ago.`
        : this.isMeetingActive ? "No fresh system audio observed. Proactive coaching may miss other speakers." : "Waiting for a live meeting.",
    });

    checks.push({
      id: "transcripts",
      label: "Transcripts",
      status: !this.isMeetingActive ? "warming" : audio.system.transcriptFresh || audio.microphone.transcriptFresh ? "ready" : "warning",
      detail: audio.system.transcriptFresh
        ? "Meeting speech is becoming transcript context."
        : audio.microphone.transcriptFresh
          ? "Your speech is becoming transcript context."
          : this.isMeetingActive ? "Audio is not producing fresh transcript context." : "No live transcript expected until a session starts.",
    });

    const activeMode = this.intelligenceManager.getActiveMode();
    const coachFresh = this.isFresh(this.lastProactiveSuggestionAt, 90_000) || this.isFresh(this.lastWakeWordVoiceAskAt, 90_000);
    checks.push({
      id: "coach",
      label: "Proactive Coach",
      status: !this.proactiveModeEnabled ? "warning" : !this.isMeetingActive ? "warming" : coachFresh ? "ready" : "warming",
      detail: !this.proactiveModeEnabled
        ? "Proactive mode is off."
        : coachFresh
          ? "Recent coaching response was generated."
          : activeMode === "idle" || activeMode === "assist"
            ? "Listening for coachable moments."
            : `Coach is busy in ${activeMode} mode.`,
    });

    const proactiveScreenExpected = this.proactiveModeEnabled && this.isMeetingActive;
    checks.push({
      id: "screen",
      label: "Screen Context",
      status: proactiveScreenExpected
        ? audio.screen.ocrRunning
          ? "ready"
          : "warning"
        : this.screenshotCaptureInProgress
          ? "warming"
          : "ready",
      detail: proactiveScreenExpected
        ? audio.screen.ocrRunning
          ? "Live screen context is feeding proactive coaching."
          : "Proactive mode is on, but live screen context is not running."
        : this.screenshotCaptureInProgress
          ? "Screen capture is in progress."
          : "Screen ask and selective screenshot are available.",
    });

    const overall = checks.some((check) => check.status === "failed")
      ? "failed"
      : checks.some((check) => check.status === "warning")
        ? "warning"
        : checks.some((check) => check.status === "warming")
          ? "warming"
          : "ready";

    const llmHelper = this.processingHelper.getLLMHelper();
    return {
      generatedAt: new Date().toISOString(),
      overall,
      meetingActive: this.isMeetingActive,
      meetingStartedAt: this.meetingStartedAt ? new Date(this.meetingStartedAt).toISOString() : null,
      proactiveModeEnabled: this.proactiveModeEnabled,
      activeMode,
      model: llmHelper.getCurrentModel?.() ?? null,
      reasoningEffort: llmHelper.getReasoningEffort?.() ?? null,
      audio,
      prep,
      checks,
    };
  }

  public startMeetingPrepScheduler(): void {
    if (this.meetingPrepInterval) {
      return;
    }

    const run = () => {
      this.warmUpcomingMeetingPrep().catch((error: any) => {
        console.warn('[Main] Meeting prep scheduler failed:', error?.message || error);
      });
    };

    this.meetingPrepInterval = setInterval(run, 2 * 60 * 1000);
    setTimeout(run, 15_000);
  }

  public stopMeetingPrepScheduler(): void {
    if (this.meetingPrepInterval) {
      clearInterval(this.meetingPrepInterval);
      this.meetingPrepInterval = null;
    }
  }

  private async warmUpcomingMeetingPrep(): Promise<void> {
    if (this.isMeetingActive || this.meetingPrepInFlight) {
      return;
    }

    this.meetingPrepInFlight = true;
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      const { MeetingPrepService } = require('./services/MeetingPrepService');
      const events = await CalendarManager.getInstance().getUpcomingEvents();
      this.rememberReadinessEvents(events);
      await MeetingPrepService.getInstance().warmPackets(events, this.getKnowledgeOrchestrator());
    } finally {
      this.meetingPrepInFlight = false;
    }
  }

  private applyPreparedMeetingContext(metadata?: any): void {
    if (!metadata?.calendarEventId) {
      this.intelligenceManager.setPreparedMeetingContext(null);
      return;
    }

    try {
      const { MeetingPrepService } = require('./services/MeetingPrepService');
      const { MeetingContextCapsuleService } = require('./services/MeetingContextCapsuleService');
      const packet = MeetingPrepService.getInstance().getCachedPacket(metadata.calendarEventId);
      const capsule = MeetingContextCapsuleService.getInstance().getCapsuleForEvent(metadata.calendarEventId);
      this.intelligenceManager.setPreparedMeetingContext(
        capsule?.contextMarkdown
          ? capsule.contextMarkdown
          : packet ? this.formatMeetingPrepContext(packet) : null
      );
    } catch (error: any) {
      console.warn('[Main] Failed to attach prepared meeting context:', error?.message || error);
      this.intelligenceManager.setPreparedMeetingContext(null);
    }
  }

  private formatMeetingPrepContext(packet: any): string {
    const event = packet.event || {};
    const lines = [
      `MEETING PREP PACKET: ${event.title || 'Untitled meeting'}`,
      `Generated: ${packet.generatedAt || 'unknown'}`,
      packet.summary ? `Summary: ${packet.summary}` : '',
      Array.isArray(packet.contextBullets) && packet.contextBullets.length
        ? `Context bullets:\n${packet.contextBullets.map((line: string) => `- ${line}`).join('\n')}`
        : '',
      Array.isArray(packet.openCommitments) && packet.openCommitments.length
        ? `Open commitments:\n${packet.openCommitments.map((line: string) => `- ${line}`).join('\n')}`
        : '',
      Array.isArray(packet.openQuestions) && packet.openQuestions.length
        ? `Open questions:\n${packet.openQuestions.map((line: string) => `- ${line}`).join('\n')}`
        : '',
      Array.isArray(packet.memoryHighlights) && packet.memoryHighlights.length
        ? `Relevant memory:\n${packet.memoryHighlights.map((item: any) => `- ${item.title}: ${item.excerpt}`).join('\n')}`
        : ''
    ];
    return lines.filter(Boolean).join('\n\n');
  }

  private pauseMicrosoftContextDuringMeeting(): void {
    try {
      const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
      MicrosoftLocalManager.getInstance().stop();
    } catch (error: any) {
      console.warn('[Main] Failed to pause Microsoft context bridges:', error?.message || error);
    }
  }

  private resumeMicrosoftContextAfterMeeting(): void {
    if (this._isQuitting) {
      return;
    }

    try {
      const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
      MicrosoftLocalManager.getInstance().start().catch((error: any) => {
        console.warn('[Main] Failed to resume Microsoft context bridges:', error?.message || error);
      });
    } catch (error: any) {
      console.warn('[Main] Failed to resume Microsoft context bridges:', error?.message || error);
    }
  }

  private async bootstrapOllamaEmbeddings() {
    this._ollamaBootstrapPromise = (async () => {
      try {
        const { OllamaBootstrap } = require('./rag/OllamaBootstrap');
        const bootstrap = new OllamaBootstrap();

        // Fire and forget — don't await this before showing the window
        const result = await bootstrap.bootstrap('nomic-embed-text', (status: string, percent: number) => {
          // Send progress to renderer via IPC
          this.broadcast('ollama:pull-progress', { status, percent });
        });

        if (result === 'pulled' || result === 'already_pulled') {
          this.broadcast('ollama:pull-complete');
          // Re-resolve the embedding provider given that Ollama might now be available
          if (this.ragManager) {
             console.log('[AppState] Ollama model ready, re-evaluating RAG pipeline provider');
             this.ragManager.initializeEmbeddings({
                ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434"
             });
          }
        }
      } catch (err) {
         console.error('[AppState] Failed to bootstrap Ollama:', err);
      }
    })();
  }

  private initializeSemanticaContext(): void {
    if (this._semanticaBootstrapPromise) {
      return;
    }

    this._semanticaBootstrapPromise = (async () => {
      try {
        await SemanticaBridgeService.getInstance().ensureReady();
        const synced = await SemanticaMeetingIndexer.getInstance().start(DatabaseManager.getInstance());
        console.log(`[AppState] Semantica sidecar ready. Initial meeting sync count=${synced}`);
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("meetings-updated");
          }
        });
      } catch (error: any) {
        console.warn('[AppState] Semantica initialization unavailable:', error?.message || error);
      }
    })().finally(() => {
      this._semanticaBootstrapPromise = null;
    });
  }

  private initializeRAGManager(): void {
    try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb) {
        this.ragManager = new RAGManager({ 
            db: sqliteDb, 
            dbPath: db.getDbPath(),
            extPath: db.getExtPath(),
            ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434'
        });
        this.ragManager.setLLMHelper(this.processingHelper.getLLMHelper());
        console.log('[AppState] RAGManager initialized');
      }
    } catch (error) {
      console.error('[AppState] Failed to initialize RAGManager:', error);
    }

    // Initialize Knowledge Orchestrator
    try {
      const db = DatabaseManager.getInstance();
      const sqliteDb = db.getDb();

      if (sqliteDb && KnowledgeDatabaseManagerClass && KnowledgeOrchestratorClass) {
        const knowledgeDb = new KnowledgeDatabaseManagerClass(sqliteDb);
        this.knowledgeOrchestrator = new KnowledgeOrchestratorClass(knowledgeDb);

        // Wire up LLM functions
        const llmHelper = this.processingHelper.getLLMHelper();

        // generateContent function for LLM calls
        this.knowledgeOrchestrator.setGenerateContentFn(async (contents: any[]) => {
          return await llmHelper.generateContentStructured(
            contents[0]?.text || ''
          );
        });

        // Embedding function — lazily delegate to the cascaded EmbeddingPipeline
        // (OpenAI → Gemini → Ollama → Local bundled model).
        // We await waitForReady() so uploads during boot wait for the pipeline
        // instead of immediately throwing 'not ready'.
        const self = this;
        this.knowledgeOrchestrator.setEmbedFn(async (text: string) => {
          const pipeline = self.ragManager?.getEmbeddingPipeline();
          if (!pipeline) throw new Error('RAG pipeline not available');
          await pipeline.waitForReady();
          return await pipeline.getEmbedding(text);
        });
        if (typeof this.knowledgeOrchestrator.setEmbedQueryFn === 'function') {
          this.knowledgeOrchestrator.setEmbedQueryFn(async (text: string) => {
            const pipeline = self.ragManager?.getEmbeddingPipeline();
            if (!pipeline) throw new Error('RAG pipeline not available');
            await pipeline.waitForReady();
            return await pipeline.getEmbeddingForQuery(text);
          });
        }

        // Attach KnowledgeOrchestrator to LLMHelper
        llmHelper.setKnowledgeOrchestrator(this.knowledgeOrchestrator);
        ContextRetrievalBroker.getInstance().setKnowledgeOrchestrator(this.knowledgeOrchestrator);

        // Restore persisted toggle states so UI reflects what the user left them as.
        // NOTE: groqFastTextMode is now restored unconditionally in the AppState constructor
        // so it is not repeated here.
        const sm = SettingsManager.getInstance();
        if (sm.get('knowledgeMode')) {
          this.knowledgeOrchestrator.setKnowledgeMode(true);
          console.log('[AppState] Knowledge mode restored from settings');
        }

        console.log('[AppState] KnowledgeOrchestrator initialized');
      }
    } catch (error) {
      console.error('[AppState] Failed to initialize KnowledgeOrchestrator:', error);
    }
  }

  private setupAutoUpdater(): void {
    if (!AUTO_UPDATES_ENABLED) {
      console.log('[AutoUpdater] Disabled for this build. Skipping updater initialization.')
      return
    }

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false  // Manual install only via button

    // Default to latest (stable) channel - matches latest.yml generated by electron-builder
    autoUpdater.channel = 'latest'
    console.log(`[AutoUpdater] Channel: ${autoUpdater.channel}`)

    autoUpdater.on("checking-for-update", () => {
      console.log("[AutoUpdater] Checking for update...")
      this.broadcast("update-checking")
    })

    autoUpdater.on("update-available", async (info) => {
      const currentVersion = app.getVersion()
      if (!this.isVersionNewer(currentVersion, info.version)) {
        console.warn(
          `[AutoUpdater] Ignoring non-newer update offer. Current=${currentVersion}, Offered=${info.version}`
        )
        this.broadcast("update-not-available", { version: currentVersion })
        return
      }

      console.log("[AutoUpdater] Update available:", info.version)
      this.updateAvailable = true

      // Fetch structured release notes
      const releaseManager = ReleaseNotesManager.getInstance();
      const notes = await releaseManager.fetchReleaseNotes(info.version);

      // Notify renderer that an update is available with parsed notes if available
      this.broadcast("update-available", {
        ...info,
        parsedNotes: notes
      })
    })

    autoUpdater.on("update-not-available", (info) => {
      console.log("[AutoUpdater] Update not available:", info.version)
      this.broadcast("update-not-available", info)
    })

    autoUpdater.on("error", (err) => {
      console.error("[AutoUpdater] Error:", err)
      // Include more details in the error message for debugging
      const errorMessage = err.message || err.toString() || 'Unknown update error'
      this.broadcast("update-error", errorMessage)
    })

    autoUpdater.on("download-progress", (progressObj) => {
      let log_message = "Download speed: " + progressObj.bytesPerSecond
      log_message = log_message + " - Downloaded " + progressObj.percent + "%"
      log_message = log_message + " (" + progressObj.transferred + "/" + progressObj.total + ")"
      console.log("[AutoUpdater] " + log_message)
      this.broadcast("download-progress", progressObj)
    })

    autoUpdater.on("update-downloaded", (info) => {
      console.log("[AutoUpdater] Update downloaded:", info.version)
      // Notify renderer that update is ready to install
      this.broadcast("update-downloaded", info)
    })

    // Start checking for updates with a 10-second delay
    setTimeout(() => {
      if (process.env.NODE_ENV === "development") {
        console.log("[AutoUpdater] Development mode: Skipping auto check (use manual button)");
      } else {
        autoUpdater.checkForUpdatesAndNotify().catch(err => {
          console.error("[AutoUpdater] Failed to check for updates:", err);
        });
      }
    }, 10000);
  }

  private async checkForUpdatesManual(): Promise<void> {
    try {
      console.log('[AutoUpdater] Checking for updates manually via GitHub API...');
      const releaseManager = ReleaseNotesManager.getInstance();
      // Fetch latest release
      const notes = await releaseManager.fetchReleaseNotes('latest');

      if (notes) {
        const currentVersion = app.getVersion();
        const latestVersionTag = notes.version; // e.g., "v1.2.0" or "1.2.0"
        const latestVersion = latestVersionTag.replace(/^v/, '');

        console.log(`[AutoUpdater] Manual Check: Current=${currentVersion}, Latest=${latestVersion}`);

        if (this.isVersionNewer(currentVersion, latestVersion)) {
          console.log('[AutoUpdater] Manual Check: New version found!');
          this.updateAvailable = true;

          // Mock an info object compatible with electron-updater
          const info = {
            version: latestVersion,
            files: [] as any[],
            path: '',
            sha512: '',
            releaseName: notes.summary,
            releaseNotes: notes.fullBody
          };

          // Notify renderer
          this.broadcast("update-available", {
            ...info,
            parsedNotes: notes
          });
        } else {
          console.log('[AutoUpdater] Manual Check: App is up to date.');
          this.broadcast("update-not-available", { version: currentVersion });
        }
      }
    } catch (err) {
      console.error('[AutoUpdater] Manual update check failed:', err);
    }
  }

  private isVersionNewer(current: string, latest: string): boolean {
    // EC-01 fix: strip pre-release suffixes (e.g. "2.1.0-beta.1" → "2.1.0")
    // before splitting so Number() never returns NaN on comparison.
    const stripPre = (v: string) => v.replace(/-.*$/, '');
    const c = stripPre(current).split('.').map(Number);
    const l = stripPre(latest).split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      const cv = c[i] || 0;
      const lv = l[i] || 0;
      if (lv > cv) return true;
      if (lv < cv) return false;
    }
    return false;
  }


  public async quitAndInstallUpdate(): Promise<void> {
    console.log('[AutoUpdater] quitAndInstall called - applying update...')

    // On macOS, unsigned apps can't auto-restart via quitAndInstall
    // Workaround: Open the folder containing the downloaded update so user can install manually
    if (process.platform === 'darwin') {
      try {
        // Get the downloaded update file path (e.g., .../Natively-1.0.9-mac.zip)
        const updateFile = (autoUpdater as any).downloadedUpdateHelper?.file
        console.log('[AutoUpdater] Downloaded update file:', updateFile)

        if (updateFile) {
          const updateDir = path.dirname(updateFile)
          // Open the directory containing the update in Finder
          await shell.openPath(updateDir)
          console.log('[AutoUpdater] Opened update directory:', updateDir)

          // Quit the app so user can install new version
          setTimeout(() => app.quit(), 1000)
          return
        }
      } catch (err) {
        console.error('[AutoUpdater] Failed to open update directory:', err)
      }
    }

    // Fallback to standard quitAndInstall (works on Windows/Linux or if signed)
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (err) {
        console.error('[AutoUpdater] quitAndInstall failed:', err)
        app.exit(0)
      }
    })
  }

  public async checkForUpdates(): Promise<void> {
    console.log('[AutoUpdater] Manual check for updates requested')
    try {
      if (!AUTO_UPDATES_ENABLED) {
        console.log('[AutoUpdater] Manual check skipped because auto updates are disabled for this build')
        this.broadcast("update-not-available", { version: app.getVersion() })
        return
      }

      // In development mode, use manual GitHub API check (electron-updater skips in dev)
      if (process.env.NODE_ENV === "development") {
        await this.checkForUpdatesManual()
      } else {
        await autoUpdater.checkForUpdatesAndNotify()
      }
    } catch (err: any) {
      console.error('[AutoUpdater] checkForUpdates failed:', err)
      const errorMessage = err.message || err.toString() || 'Update check failed'
      this.broadcast("update-error", errorMessage)
    }
  }

  public downloadUpdate(): void {
    console.log('[AutoUpdater] Starting download...')
    try {
      // Errors during download are surfaced via autoUpdater.on("error") which
      // already broadcasts "update-error". Do not broadcast here to avoid duplicates.
      autoUpdater.downloadUpdate().catch(err => {
        console.error('[AutoUpdater] downloadUpdate failed:', err)
      })
    } catch (err: any) {
      console.error('[AutoUpdater] downloadUpdate exception:', err)
    }
  }

  // New Property for System Audio & Microphone
  private systemAudioCapture: SystemAudioCapture | null = null;
  private microphoneCapture: MicrophoneCapture | null = null;
  private audioTestCapture: MicrophoneCapture | null = null; // For audio settings test
  private _audioTestStarting = false;               // P2-12: in-flight guard against concurrent calls
  private googleSTT: STTProvider | null = null; // External/system audio
  private googleSTT_User: STTProvider | null = null; // User
  private manualVoiceCaptureActive = false;

  private createSTTProvider(speaker: 'external' | 'user'): STTProvider {
    const { CredentialsManager } = require('./services/CredentialsManager');
    const sttProvider = CredentialsManager.getInstance().getSttProvider();
    const sttLanguage = CredentialsManager.getInstance().getSttLanguage();

    let stt: STTProvider;

    if (sttProvider === 'natively') {
      const nativelyKey = CredentialsManager.getInstance().getNativelyApiKey();
      if (!nativelyKey) {
        // Natively is Coming Soon — no key means degrade gracefully like every other provider
        console.warn(`[Main] No Natively API Key configured for ${speaker}, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      } else {
        // 'system' for external audio, 'mic' for user microphone.
        // The server uses ${key}:${channel} as the session key so both streams
        // can coexist without triggering concurrent_session_blocked.
        stt = new NativelyProSTT(nativelyKey, speaker === 'external' ? 'system' : 'mic');
      }
    } else if (sttProvider === 'deepgram') {
      const apiKey = CredentialsManager.getInstance().getDeepgramApiKey();
      if (apiKey) {
        console.log(`[Main] Using DeepgramStreamingSTT for ${speaker}`);
        stt = new DeepgramStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Deepgram STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'soniox') {
      const apiKey = CredentialsManager.getInstance().getSonioxApiKey();
      if (apiKey) {
        console.log(`[Main] Using SonioxStreamingSTT for ${speaker}`);
        stt = new SonioxStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for Soniox STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'elevenlabs') {
      const apiKey = CredentialsManager.getInstance().getElevenLabsApiKey();
      if (apiKey) {
        console.log(`[Main] Using ElevenLabsStreamingSTT for ${speaker}`);
        stt = new ElevenLabsStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for ElevenLabs STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'openai') {
      // OpenAI: WebSocket Realtime (gpt-4o-transcribe → gpt-4o-mini-transcribe) with whisper-1 REST fallback
      const apiKey = CredentialsManager.getInstance().getOpenAiSttApiKey();
      if (apiKey) {
        console.log(`[Main] Using OpenAIStreamingSTT (WebSocket+REST fallback) for ${speaker}`);
        stt = new OpenAIStreamingSTT(apiKey);
      } else {
        console.warn(`[Main] No API key for OpenAI STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else if (sttProvider === 'groq' || sttProvider === 'azure' || sttProvider === 'ibmwatson') {
      let apiKey: string | undefined;
      let region: string | undefined;
      let modelOverride: string | undefined;

      if (sttProvider === 'groq') {
        apiKey = CredentialsManager.getInstance().getGroqSttApiKey();
        modelOverride = CredentialsManager.getInstance().getGroqSttModel();
      } else if (sttProvider === 'azure') {
        apiKey = CredentialsManager.getInstance().getAzureApiKey();
        region = CredentialsManager.getInstance().getAzureRegion();
      } else if (sttProvider === 'ibmwatson') {
        apiKey = CredentialsManager.getInstance().getIbmWatsonApiKey();
        region = CredentialsManager.getInstance().getIbmWatsonRegion();
      }

      if (apiKey) {
        console.log(`[Main] Using RestSTT (${sttProvider}) for ${speaker}`);
        stt = new RestSTT(sttProvider, apiKey, modelOverride, region);
      } else {
        console.warn(`[Main] No API key for ${sttProvider} STT, falling back to GoogleSTT`);
        stt = new GoogleSTT(speaker);
      }
    } else {
      stt = new GoogleSTT(speaker);
    }

    stt.setRecognitionLanguage(sttLanguage);

    // Wire Transcript Events
    stt.on('transcript', (segment: STTTranscriptSegment) => {
      const timestamp = Date.now();
      this.recordTranscriptFrame(speaker, segment.text, timestamp);
      const diarizedSpeaker = this.normalizeDiarizedSpeaker(segment);
      const speakerKey = diarizedSpeaker ? `${speaker}:${diarizedSpeaker}` : speaker;
      const assignedSpeakerLabel = this.meetingSpeakerLabels.get(speakerKey) || segment.speakerLabel || null;
      const defaultSpeakerLabel =
        assignedSpeakerLabel ||
        this.defaultDiarizedSpeakerLabel(diarizedSpeaker) ||
        (speaker === "external" ? "Meeting" : this.getUserDisplayName());
      const speakerIdentity = this.resolveSpeakerIdentity(
        speaker,
        speakerKey,
        assignedSpeakerLabel
      );
      const transcriptSpeaker =
        speakerIdentity === "self"
          ? "user"
          : assignedSpeakerLabel || (diarizedSpeaker ? defaultSpeakerLabel : speaker);
      const decision = this.reflexPipeline.ingestTranscriptFrame({
        speaker,
        speakerKey,
        speakerLabel: assignedSpeakerLabel || defaultSpeakerLabel,
        speakerIdentity,
        text: segment.text,
        isFinal: segment.isFinal,
        confidence: segment.confidence,
        timestamp,
        meetingActive: this.isMeetingActive,
        manualVoiceCaptureActive: this.manualVoiceCaptureActive,
        proactiveModeEnabled: this.proactiveModeEnabled,
        liveCoachAvailable: ['idle', 'assist'].includes(this.intelligenceManager.getActiveMode()),
      });

      if (!decision.shouldRouteTranscript) {
        return;
      }

      const payload = {
        speaker: speaker,
        sourceSpeaker: speaker,
        speakerKey,
        speakerLabel: assignedSpeakerLabel,
        displaySpeakerLabel: defaultSpeakerLabel,
        diarizedSpeaker,
        speakerIdentity,
        text: decision.text,
        timestamp,
        final: segment.isFinal,
        confidence: segment.confidence
      };

      if (decision.routeToSession) {
        this.intelligenceManager.handleTranscript({
          ...payload,
          speaker: transcriptSpeaker,
        });

        // Feed final transcript to JIT RAG indexer
        if (decision.routeToRag && this.ragManager) {
          this.ragManager.feedLiveTranscript([{
            speaker: transcriptSpeaker,
            text: decision.text,
            timestamp
          }]);
        }
      }

      if (decision.captureToBrain) {
        this.appendBrainLiveCapture({
          capturedAt: new Date(timestamp).toISOString(),
          mode: this.isMeetingActive
            ? (this.manualVoiceCaptureActive ? "meeting_voice_ask" : "meeting")
            : "voice_ask",
          speaker: transcriptSpeaker,
          text: decision.text,
          confidence: segment.confidence,
        });
      }

      const helper = this.getWindowHelper();
      helper.getLauncherWindow()?.webContents.send('native-audio-transcript', payload);
      helper.getOverlayWindow()?.webContents.send('native-audio-transcript', payload);

      if (speaker === 'user') {
        this.maybeTriggerWakeWordVoiceAsk(
          decision.text,
          segment.confidence,
          segment.isFinal
        );
      }

      // Feed external/system-audio transcripts to the live coaching lane as early as possible.
      if (decision.proactiveCandidate) {
        if (decision.proactiveCandidate.source === "final") {
          const feedExternalUtterance =
            this.knowledgeOrchestrator?.feedExternalUtterance ??
            this.knowledgeOrchestrator?.feedMeetingUtterance ??
            this.knowledgeOrchestrator?.[['feed', 'Inter', 'viewerUtterance'].join('')];
          if (speakerIdentity !== "self") {
            feedExternalUtterance?.call(this.knowledgeOrchestrator, decision.text);
          }
        }
        this.maybeTriggerProactiveSuggestion(
          decision.proactiveCandidate.text,
          decision.proactiveCandidate.confidence,
          decision.proactiveCandidate.source
        );
      }
    });

    stt.on('error', (err: Error) => {
      console.error(`[Main] STT (${speaker}) Error:`, err);
      this.recordAudioPipelineError(`STT ${speaker}`, err);
    });

    // Auto language detection: NativelyProSTT emits 'languageDetected' when the
    // backend resolves the language from the first audio batch. Notify the renderer
    // so the settings UI can show what was detected.
    if (stt instanceof NativelyProSTT) {
      stt.on('languageDetected', (bcp47: string) => {
        console.log(`[Main] STT language auto-detected (${speaker}): ${bcp47}`);
        const helper = this.getWindowHelper();
        helper.getMainWindow()?.webContents.send('stt-language-auto-detected', bcp47);
        helper.getLauncherWindow()?.webContents.send('stt-language-auto-detected', bcp47);
      });
    }

    return stt;
  }

  private appendBrainLiveCapture(entry: {
    capturedAt: string;
    mode: string;
    speaker: string;
    text: string;
    confidence?: number;
  }): void {
    const text = entry.text.replace(/\s+/g, " ").trim();
    if (!text) return;

    try {
      const brainRoot = path.join(app.getPath("home"), "CascadeProjects", "ipcorp-architecture-brain");
      if (!fs.existsSync(brainRoot)) return;

      const captureDir = path.join(brainRoot, "natively", "live-captures");
      fs.mkdirSync(captureDir, { recursive: true });

      const day = entry.capturedAt.slice(0, 10);
      const filePath = path.join(captureDir, `${day}-natively-live.jsonl`);
      const line = JSON.stringify({
        ...entry,
        text,
        source: "natively",
        schemaVersion: 1,
      }) + "\n";

      fs.appendFile(filePath, line, (error) => {
        if (error) {
          console.warn("[Main] Failed to append brain live capture:", error.message);
        }
      });
    } catch (error: any) {
      console.warn("[Main] Brain live capture unavailable:", error?.message || error);
    }
  }

  private setupSystemAudioPipeline(): void {
    // REMOVED EARLY RETURN: if (this.systemAudioCapture && this.microphoneCapture) return; // Already initialized

    try {
      // 1. Initialize Captures if missing
      // If they already exist (e.g. from reconfigureAudio), they are already wired to write to this.googleSTT/User
      if (!this.systemAudioCapture) {
        this.systemAudioCapture = new SystemAudioCapture();
        // Wire Capture -> STT
        let _sysChunkCount = 0;
        this.systemAudioCapture.on('data', (chunk: Buffer) => {
          this.recordAudioChunk("system", chunk.length);
          _sysChunkCount++;
          if (_sysChunkCount <= 3 || _sysChunkCount % 500 === 0) {
            console.log(`[Main] SystemAudio->STT: chunk #${_sysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
          }
          this.googleSTT?.write(chunk);
        });
        this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] SystemAudioCapture rate updated dynamically to ${rate}Hz`);
          // Forward to ALL active STT providers — STTProvider union includes setSampleRate
          this.googleSTT?.setSampleRate(rate);
        });
        this.systemAudioCapture.on('speech_ended', () => {
          this.googleSTT?.notifySpeechEnded?.();
        });
        this.systemAudioCapture.on('error', (err: Error) => {
          console.error('[Main] SystemAudioCapture Error:', err);
          this.recordAudioPipelineError("System audio capture", err);
        });
      }

      if (!this.microphoneCapture) {
        this.microphoneCapture = new MicrophoneCapture();
        this.microphoneCapture.on('data', (chunk: Buffer) => {
          this.recordAudioChunk("microphone", chunk.length);
          this.googleSTT_User?.write(chunk);
        });
        this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] MicrophoneCapture rate updated dynamically to ${rate}Hz`);
          // Forward to ALL active STT providers — STTProvider union includes setSampleRate
          this.googleSTT_User?.setSampleRate(rate);
        });
        this.microphoneCapture.on('speech_ended', () => {
          this.googleSTT_User?.notifySpeechEnded?.();
        });
        this.microphoneCapture.on('error', (err: Error) => {
          console.error('[Main] MicrophoneCapture Error:', err);
          this.recordAudioPipelineError("Microphone capture", err);
        });
      }

      // 2. Initialize STT Services if missing
      if (!this.googleSTT) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const sttProv = CredentialsManager.getInstance().getSttProvider();
        console.log(`[Main] Creating external STT provider: ${sttProv}`);
        this.googleSTT = this.createSTTProvider('external');
      }

      if (!this.googleSTT_User) {
        const { CredentialsManager } = require('./services/CredentialsManager');
        const sttProv = CredentialsManager.getInstance().getSttProvider();
        console.log(`[Main] Creating user STT provider: ${sttProv}`);
        this.googleSTT_User = this.createSTTProvider('user');
      }

      // --- CRITICAL FIX: SYNC SAMPLE RATES ---
      // Always sync rates, even if just initialized, to ensure consistency

      // 1. Sync System Audio Rate
      const sysRate = this.systemAudioCapture?.getSampleRate() || 48000;
      if (this._verboseLogging) console.log(`[Main] Configuring external STT to ${sysRate}Hz`);
      this.googleSTT?.setSampleRate(sysRate);
      this.googleSTT?.setAudioChannelCount?.(1);

      // 2. Sync Mic Rate
      const micRate = this.microphoneCapture?.getSampleRate() || 48000;
      if (this._verboseLogging) console.log(`[Main] Configuring User STT to ${micRate}Hz`);
      this.googleSTT_User?.setSampleRate(micRate);
      this.googleSTT_User?.setAudioChannelCount?.(1);

      if (this._verboseLogging) console.log('[Main] Full Audio Pipeline (System + Mic) Initialized (Ready)');

    } catch (err) {
      console.error('[Main] Failed to setup System Audio Pipeline:', err);
      this.recordAudioPipelineError("Audio pipeline setup", err);
    }
  }

  private async reconfigureAudio(inputDeviceId?: string, outputDeviceId?: string): Promise<void> {
    console.log(`[Main] Reconfiguring Audio: Input=${inputDeviceId}, Output=${outputDeviceId}`);

    // 1. System Audio (Output Capture)
    if (this.systemAudioCapture) {
      // destroy() calls stop() AND removeAllListeners(), preventing EventEmitter listener leaks.
      // Using stop()+null would orphan all 'data', 'speech_ended', 'sample_rate_changed'
      // closures (they still hold a ref to `this`) and trigger them on the next meeting.
      this.systemAudioCapture.destroy();
      this.systemAudioCapture = null;
    }

    try {
      console.log('[Main] Initializing SystemAudioCapture...');
      this.systemAudioCapture = new SystemAudioCapture(outputDeviceId || undefined);
      const rate = this.systemAudioCapture.getSampleRate();
      console.log(`[Main] SystemAudioCapture rate: ${rate}Hz`);
      this.googleSTT?.setSampleRate(rate);

      let _rcfgSysChunkCount = 0;
      this.systemAudioCapture.on('data', (chunk: Buffer) => {
        this.recordAudioChunk("system", chunk.length);
        _rcfgSysChunkCount++;
        if (_rcfgSysChunkCount <= 3 || _rcfgSysChunkCount % 500 === 0) {
          console.log(`[Main] (Reconfigured) SystemAudio->STT: chunk #${_rcfgSysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
        }
        this.googleSTT?.write(chunk);
      });
      this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
        console.log(`[Main] (Reconfigured) SystemAudioCapture rate updated dynamically to ${rate}Hz`);
        this.googleSTT?.setSampleRate(rate);
      });
      this.systemAudioCapture.on('speech_ended', () => {
        this.googleSTT?.notifySpeechEnded?.();
      });
      this.systemAudioCapture.on('error', (err: Error) => {
        console.error('[Main] SystemAudioCapture Error:', err);
        this.recordAudioPipelineError("System audio capture", err);
      });
      console.log('[Main] SystemAudioCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize SystemAudioCapture with preferred ID. Falling back to default.', err);
      this.recordAudioPipelineError("System audio capture preferred init", err);
      try {
        this.systemAudioCapture = new SystemAudioCapture(); // Default
        const rate = this.systemAudioCapture.getSampleRate();
        console.log(`[Main] SystemAudioCapture (Default) rate: ${rate}Hz`);
        this.googleSTT?.setSampleRate(rate);

        let _dfltSysChunkCount = 0;
        this.systemAudioCapture.on('data', (chunk: Buffer) => {
          this.recordAudioChunk("system", chunk.length);
          _dfltSysChunkCount++;
          if (_dfltSysChunkCount <= 3 || _dfltSysChunkCount % 500 === 0) {
            console.log(`[Main] (Default) SystemAudio->STT: chunk #${_dfltSysChunkCount}, ${chunk.length}B, googleSTT=${this.googleSTT ? 'active' : 'NULL'}`);
          }
          this.googleSTT?.write(chunk);
        });
        this.systemAudioCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] (Reconfigured Default) SystemAudioCapture rate updated dynamically to ${rate}Hz`);
          this.googleSTT?.setSampleRate(rate);
        });
        this.systemAudioCapture.on('speech_ended', () => {
          this.googleSTT?.notifySpeechEnded?.();
        });
        this.systemAudioCapture.on('error', (err: Error) => {
          console.error('[Main] SystemAudioCapture (Default) Error:', err);
          this.recordAudioPipelineError("System audio capture default", err);
        });
      } catch (err2) {
        console.error('[Main] Failed to initialize SystemAudioCapture (Default):', err2);
        this.recordAudioPipelineError("System audio capture default init", err2);
      }
    }

    // 2. Microphone (Input Capture)
    if (this.microphoneCapture) {
      // destroy() calls stop() AND removeAllListeners(), preventing EventEmitter listener leaks.
      this.microphoneCapture.destroy();
      this.microphoneCapture = null;
    }

    try {
      console.log('[Main] Initializing MicrophoneCapture...');
      this.microphoneCapture = new MicrophoneCapture(inputDeviceId || undefined);
      const rate = this.microphoneCapture.getSampleRate();
      console.log(`[Main] MicrophoneCapture rate: ${rate}Hz`);
      this.googleSTT_User?.setSampleRate(rate);

      this.microphoneCapture.on('data', (chunk: Buffer) => {
        // console.log('[Main] Mic chunk', chunk.length);
        this.recordAudioChunk("microphone", chunk.length);
        this.googleSTT_User?.write(chunk);
      });
      this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
        console.log(`[Main] (Reconfigured) MicrophoneCapture rate updated dynamically to ${rate}Hz`);
        this.googleSTT_User?.setSampleRate(rate);
      });
      this.microphoneCapture.on('speech_ended', () => {
        this.googleSTT_User?.notifySpeechEnded?.();
      });
      this.microphoneCapture.on('error', (err: Error) => {
        console.error('[Main] MicrophoneCapture Error:', err);
        this.recordAudioPipelineError("Microphone capture", err);
      });
      console.log('[Main] MicrophoneCapture initialized.');
    } catch (err) {
      console.warn('[Main] Failed to initialize MicrophoneCapture with preferred ID. Falling back to default.', err);
      this.recordAudioPipelineError("Microphone capture preferred init", err);
      try {
        this.microphoneCapture = new MicrophoneCapture(); // Default
        const rate = this.microphoneCapture.getSampleRate();
        console.log(`[Main] MicrophoneCapture (Default) rate: ${rate}Hz`);
        this.googleSTT_User?.setSampleRate(rate);

        this.microphoneCapture.on('data', (chunk: Buffer) => {
          this.recordAudioChunk("microphone", chunk.length);
          this.googleSTT_User?.write(chunk);
        });
        this.microphoneCapture.on('sample_rate_changed', (rate: number) => {
          console.log(`[Main] (Reconfigured Default) MicrophoneCapture rate updated dynamically to ${rate}Hz`);
          this.googleSTT_User?.setSampleRate(rate);
        });
        this.microphoneCapture.on('speech_ended', () => {
          this.googleSTT_User?.notifySpeechEnded?.();
        });
        this.microphoneCapture.on('error', (err: Error) => {
          console.error('[Main] MicrophoneCapture (Default) Error:', err);
          this.recordAudioPipelineError("Microphone capture default", err);
        });
      } catch (err2) {
        console.error('[Main] Failed to initialize MicrophoneCapture (Default):', err2);
        this.recordAudioPipelineError("Microphone capture default init", err2);
      }
    }
  }

  /**
   * Reconfigure STT provider mid-session (called from IPC when user changes provider)
   * Destroys existing STT instances and recreates them with the new provider
   */
  public async reconfigureSttProvider(): Promise<void> {
    console.log('[Main] Reconfiguring STT Provider...');

    // RC-01 fix: pause audio captures FIRST so their EventEmitter queues drain
    // before we null-out the STT instances. Without this, buffered 'data' events
    // still in-flight call this.googleSTT?.write() while googleSTT is already null.
    if (this.isMeetingActive) {
      this.systemAudioCapture?.stop();
      this.microphoneCapture?.stop();
    }

    // Now safe to destroy STT instances — no more audio events incoming
    if (this.googleSTT) {
      this.googleSTT.stop();
      this.googleSTT.removeAllListeners();
      this.googleSTT = null;
    }
    if (this.googleSTT_User) {
      this.googleSTT_User.stop();
      this.googleSTT_User.removeAllListeners();
      this.googleSTT_User = null;
    }

    // Reinitialize the pipeline (will pick up the new provider from CredentialsManager)
    this.setupSystemAudioPipeline();

    // Restart audio captures and new STT instances if a meeting is active
    if (this.isMeetingActive) {
      this.systemAudioCapture?.start();
      this.microphoneCapture?.start();
      this.googleSTT?.start();
      this.googleSTT_User?.start();
    }

    console.log('[Main] STT Provider reconfigured');
  }


  public async startAudioTest(deviceId?: string): Promise<void> {
    // P2-12: guard against two concurrent calls both passing the async permission check
    // before either has created a capture — the second call would orphan the first capture.
    if (this._audioTestStarting) return;
    this._audioTestStarting = true;
    try {
      await this._startAudioTestImpl(deviceId);
    } finally {
      this._audioTestStarting = false;
    }
  }

  private async _startAudioTestImpl(deviceId?: string): Promise<void> {
    console.log(`[Main] Starting Audio Test on device: ${deviceId || 'default'}`);
    this.stopAudioTest(); // Stop any existing test

    if (!(await ensureMacMicrophoneAccess('audio test'))) {
      throw new Error('Microphone access denied. Please allow microphone access in System Settings and try again.');
    }

    const attachAudioTestListeners = (capture: MicrophoneCapture) => {
      capture.on('data', (chunk: Buffer) => {
        const targets = [
          this.settingsWindowHelper.getSettingsWindow(),
          this.getWindowHelper().getLauncherWindow(),
          this.getWindowHelper().getOverlayWindow(),
        ].filter((win): win is BrowserWindow => !!win && !win.isDestroyed());

        if (targets.length === 0) return;

        let sum = 0;
        const step = 10;
        const len = chunk.length;

        for (let i = 0; i < len; i += 2 * step) {
          const val = chunk.readInt16LE(i);
          sum += val * val;
        }

        const count = len / (2 * step);
        if (count > 0) {
          const rms = Math.sqrt(sum / count);
          const level = Math.min(rms / 10000, 1.0);
          for (const target of targets) {
            target.webContents.send('audio-test-level', level);
          }
        }
      });

      capture.on('error', (err: Error) => {
        console.error('[Main] AudioTest Error:', err);
      });
    };

    try {
      this.audioTestCapture = new MicrophoneCapture(deviceId || undefined);
      attachAudioTestListeners(this.audioTestCapture);
      this.audioTestCapture.start();
    } catch (err) {
      console.warn('[Main] Failed to start audio test on preferred device. Falling back to default.', err);
      // RC-02 fix: explicitly stop and null the failed capture before creating
      // the fallback to prevent a brief double-microphone-capture window.
      try { this.audioTestCapture?.stop(); } catch { /* ignore errors on already-failed capture */ }
      this.audioTestCapture = null;
      try {
        this.audioTestCapture = new MicrophoneCapture();
        attachAudioTestListeners(this.audioTestCapture);
        this.audioTestCapture.start();
      } catch (fallbackErr) {
        console.error('[Main] Failed to start audio test:', fallbackErr);
        throw fallbackErr;
      }
    }
  }

  public stopAudioTest(): void {
    if (this.audioTestCapture) {
      console.log('[Main] Stopping Audio Test');
      this.audioTestCapture.stop();
      this.audioTestCapture = null;
    }
  }

  public finalizeMicSTT(): void {
    // We only want to finalize the user microphone, because the context is Manual Answer
    if (this.googleSTT_User?.finalize) {
      console.log('[Main] Finalizing STT');
      this.googleSTT_User.finalize();
    }
  }

  public async startManualVoiceCapture(): Promise<void> {
    if (this.manualVoiceCaptureActive) return;

    if (!(await ensureMacMicrophoneAccess('voice ask'))) {
      throw new Error('Microphone access denied. Please allow microphone access in System Settings and try again.');
    }

    this.manualVoiceCaptureActive = true;
    try {
      this.setupSystemAudioPipeline();

      if (!this.isMeetingActive) {
        this.microphoneCapture?.start();
        this.googleSTT_User?.start();
      }

      this.broadcast('native-audio-connected');
    } catch (error) {
      this.manualVoiceCaptureActive = false;
      throw error;
    }
  }

  public stopManualVoiceCapture(): void {
    if (!this.manualVoiceCaptureActive) return;

    this.finalizeMicSTT();
    this.manualVoiceCaptureActive = false;

    if (!this.isMeetingActive) {
      this.microphoneCapture?.stop();
      this.googleSTT_User?.stop();
      this.broadcast('native-audio-disconnected');
    }
  }

  public async startMeeting(metadata?: any): Promise<void> {
    console.log('[Main] Starting Meeting...', metadata);

    if (!(await ensureMacMicrophoneAccess('meeting start'))) {
      const message = 'Microphone access denied. Please allow microphone access in System Settings.';
      this.broadcast('meeting-audio-error', message);
      throw new Error(message);
    }

    // Check Screen Recording permission required for system audio capture
    // (CoreAudio Global Process Tap + ScreenCaptureKit both need this).
    // NOTE: The 'not-determined' TCC dialog is triggered once at app startup
    // (in initializeApp) so it never pops up mid-meeting here. We only act on
    // explicit 'denied' — in that case warn the user but let the meeting continue
    // with microphone-only transcription.
    if (process.platform === 'darwin') {
      const screenStatus = getMacScreenCaptureStatus();
      console.log(`[Main] macOS screen recording permission status: ${screenStatus}`);
      if (screenStatus === 'denied') {
        // Permission was explicitly denied — open System Settings and warn the user.
        // We don't throw here: meeting continues with microphone-only transcription.
        const message = 'Screen Recording permission denied. System audio will not be captured. To fix: System Settings → Privacy & Security → Screen Recording → enable Natively.';
        console.warn('[Main]', message);
        this.broadcast('system-audio-permission-denied', message);
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
      // 'not-determined': Handled at startup. SCK/CoreAudio will trigger the TCC
      // dialog itself when it first attempts to access screen content.
    }

    this.isMeetingActive = true;
    this.meetingStartedAt = Date.now();
    this.audioPipelineStartedAt = 0;
    this.lastAudioPipelineError = null;
    this.lastSystemAudioChunkAt = 0;
    this.systemAudioChunkCount = 0;
    this.systemAudioBytes = 0;
    this.lastMicAudioChunkAt = 0;
    this.micAudioChunkCount = 0;
    this.micAudioBytes = 0;
    this.lastExternalTranscriptAt = 0;
    this.externalTranscriptCount = 0;
    this.lastExternalTranscriptText = null;
    this.lastUserTranscriptAt = 0;
    this.userTranscriptCount = 0;
    this.lastUserTranscriptText = null;
    this.meetingSpeakerLabels.clear();
    this.selfSpeakerKeys.clear();
    this.broadcastMeetingState()
    this.pauseMicrosoftContextDuringMeeting();
    if (metadata) {
      this.intelligenceManager.setMeetingMetadata(metadata);
    }
    // Incremental transcript persistence: create the meeting row NOW and start
    // the periodic flush, so a crash/quit mid-meeting cannot lose the transcript.
    try {
      this.intelligenceManager.startMeetingPersistence(metadata);
    } catch (e) {
      console.error('[Main] Failed to start incremental meeting persistence (non-fatal):', e);
    }
    this.applyPreparedMeetingContext(metadata);
    this.startProactiveScreenContext();

    // Reset overlay position to default center so each new meeting starts
    // with the overlay in a predictable centered position, regardless of where
    // the user moved it during the previous meeting session.
    this.windowHelper.resetOverlayPosition();
    this.processingHelper.getLLMHelper().resetPersistentCliSessions();

    // Emit session reset to clear UI state immediately
    this.getWindowHelper().getOverlayWindow()?.webContents.send('session-reset');
    this.getWindowHelper().getLauncherWindow()?.webContents.send('session-reset');

    // ★ ASYNC AUDIO INIT: Return INSTANTLY so the IPC response goes back
    // to the renderer immediately, allowing the UI to switch to overlay
    // without waiting for SCK/audio initialization (which takes 5-7 seconds).
    // setTimeout(0) ensures setWindowMode IPC is processed first.
    setTimeout(async () => {
      // BUG-02 fix: a fast start→stop sequence can call endMeeting() before
      // this callback fires, leaving isMeetingActive=false. If that happened,
      // do NOT boot the audio pipeline — it would run forever with no stop signal.
      if (!this.isMeetingActive) {
        console.warn('[Main] Meeting was cancelled before audio pipeline could start — aborting init.');
        this.recordAudioPipelineError("Audio pipeline startup", "Meeting was cancelled before audio pipeline could start");
        return;
      }
      try {
        // Check for audio configuration preference
        if (metadata?.audio) {
          await this.reconfigureAudio(metadata.audio.inputDeviceId, metadata.audio.outputDeviceId);
        }

        // LAZY INIT: Ensure pipeline is ready (if not reconfigured above)
        this.setupSystemAudioPipeline();

        // Start System Audio
        this.systemAudioCapture?.start();
        this.googleSTT?.start();

        // Start Microphone
        this.microphoneCapture?.start();
        this.googleSTT_User?.start();

        // Start JIT RAG live indexing
        if (this.ragManager) {
          this.ragManager.startLiveIndexing('live-meeting-current');
        }

        if (this._verboseLogging) {
          const requestedInput = metadata?.audio?.inputDeviceId || 'default';
          const requestedOutput = metadata?.audio?.outputDeviceId || 'default';
          const backend = requestedOutput === 'sck' ? 'sck' : 'coreaudio';
          const sysRate = this.systemAudioCapture?.getSampleRate() || 48000;
          const micRate = this.microphoneCapture?.getSampleRate() || 48000;
          console.log(`[Main][debug] Audio pipeline: input=${requestedInput} output=${requestedOutput} backend=${backend} sysRate=${sysRate}Hz micRate=${micRate}Hz`);
        }
        this.audioPipelineStartedAt = Date.now();
        this.lastAudioPipelineError = null;
        console.log('[Main] Audio pipeline started successfully.');
      } catch (err) {
        console.error('[Main] Error initializing audio pipeline:', err);
        this.recordAudioPipelineError("Audio pipeline startup", err);
        // Notify UI so user knows microphone/audio failed to start
        this.broadcast('meeting-audio-error', (err as Error).message || 'Audio pipeline failed to start');
      }
    }, 0); // Defer to next event loop tick — ensures IPC response reaches renderer before audio init
  }

  public async endMeeting(): Promise<void> {
    console.log('[Main] Ending Meeting...');
    this.isMeetingActive = false; // Block new data immediately
    this.audioPipelineStartedAt = 0;
    this.broadcastMeetingState();
    this.resumeMicrosoftContextAfterMeeting();
    this.stopProactiveScreenContextIfOwned();

    // Reset Mouse Passthrough so the next meeting overlay starts fresh and focusable
    if (this.overlayMousePassthrough) {
      this.setOverlayMousePassthrough(false);
    }

    // Stop audio captures synchronously — these are fire-and-forget internally
    this.systemAudioCapture?.stop();
    this.googleSTT?.stop();
    this.microphoneCapture?.stop();
    this.googleSTT_User?.stop();

    // Save session state and reset context — MeetingPersistence.stopMeeting() is
    // already fire-and-forget internally (processAndSaveMeeting runs in background).
    // Capture the meetingId NOW so the background IIFE uses a deterministic ID
    // rather than getRecentMeetings(1) which could return a different meeting if the
    // user starts a new session before background processing finishes.
    const meetingId = await this.intelligenceManager.stopMeeting();

    // Revert to Default Model — synchronous, no blocking I/O
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const defaultModel = cm.getDefaultModel();
      console.log(`[Main] Reverting model to default: ${defaultModel}`);
      this.processingHelper.getLLMHelper().setModel(defaultModel);
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-changed', defaultModel);
      });
    } catch (e) {
      console.error('[Main] Failed to revert model:', e);
    }

    // ─── Background post-processing ──────────────────────────────────────────
    // These are the previously blocking operations that caused the stop-button
    // delay. They are pure background tasks with no UI dependency:
    //   • stopLiveIndexing flushes the JIT RAG live stream
    //   • processCompletedMeetingForRAG embeds the full meeting into the vector store
    //   • deleteMeetingData cleans up provisional JIT chunks
    // Chain them sequentially in the background so ordering is preserved,
    // but the IPC call returns immediately and the UI transitions without delay.
    const ragManager = this.ragManager;
    if (meetingId) {
      (async () => {
        try {
          if (ragManager) {
            await ragManager.stopLiveIndexing();
            console.log('[Main] Live RAG indexing stopped.');
          }
          await this.processCompletedMeetingForRAG(meetingId);
          // Guard: only delete live-meeting-current provisional chunks if no new
          // meeting has started while we were processing. If a new meeting IS active,
          // 'live-meeting-current' now belongs to that session — leave it alone.
          if (ragManager && !this.isMeetingActive) {
            ragManager.deleteMeetingData('live-meeting-current');
            console.log('[Main] JIT RAG provisional chunks cleaned up.');
          } else if (this.isMeetingActive) {
            console.log('[Main] New meeting started during cleanup — skipping live-meeting-current deletion.');
          }
        } catch (err) {
          console.error('[Main] Background post-meeting RAG processing failed:', err);
        }
      })();
    } else {
      // Meeting was too short — still flush the live indexer and clean up
      if (ragManager) {
        ragManager.stopLiveIndexing().catch(() => {});
        if (!this.isMeetingActive) ragManager.deleteMeetingData('live-meeting-current');
      }
    }
    // ─────────────────────────────────────────────────────────────────────────
  }

  private async processCompletedMeetingForRAG(meetingId: string): Promise<void> {
    if (!this.ragManager) return;

    try {
      // Use the explicit meetingId passed from endMeeting() — deterministic, never
      // picks up a concurrently started meeting the way getRecentMeetings(1) could.
      const meeting = DatabaseManager.getInstance().getMeetingDetails(meetingId);
      if (!meeting || !meeting.transcript || meeting.transcript.length === 0) return;

      // Convert transcript to RAG format. Prefer GPT-reconstructed turns when
      // available so retrieval indexes coherent speaker turns instead of noisy
      // live-STT fragments.
      const reconstructedTurns = meeting.detailedSummary?.reconstructedTranscript?.turns;
      const segments = Array.isArray(reconstructedTurns) && reconstructedTurns.length > 0
        ? reconstructedTurns.map((t: any, index: number) => ({
          speaker: t.speaker,
          text: t.text,
          timestamp: Number.isFinite(Number(t.startTimestamp))
            ? Number(t.startTimestamp)
            : (new Date(meeting.date).getTime() + index * 15_000)
        }))
        : meeting.transcript.map(t => ({
          speaker: t.speaker,
          text: t.text,
          timestamp: t.timestamp
        }));

      // Generate summary from detailedSummary if available
      let summary: string | undefined;
      if (meeting.detailedSummary) {
        summary = [
          ...(meeting.detailedSummary.keyPoints || []),
          ...(meeting.detailedSummary.actionItems || []).map(a => `Action: ${a}`)
        ].join('. ');
      }

      const result = await this.ragManager.processMeeting(meeting.id, segments, summary);
      console.log(`[AppState] RAG processed meeting ${meeting.id}: ${result.chunkCount} chunks`);

    } catch (error) {
      console.error('[AppState] Failed to process meeting for RAG:', error);
    }
  }

  private setupIntelligenceEvents(): void {
    const mainWindow = this.getMainWindow.bind(this)
    const sendToIntelligenceWindows = (channel: string, payload?: unknown) => {
      const helper = this.getWindowHelper();
      const targets = [
        helper.getLauncherWindow(),
        helper.getOverlayWindow(),
        mainWindow(),
      ];
      const sent = new Set<number>();

      for (const win of targets) {
        if (!win || win.isDestroyed() || sent.has(win.id)) {
          continue;
        }
        sent.add(win.id);
        win.webContents.send(channel, payload);
      }
    };

    // Forward intelligence events to renderer
    this.intelligenceManager.on('assist_update', (insight: string) => {
      sendToIntelligenceWindows('intelligence-assist-update', { insight });
    })

    this.intelligenceManager.on('suggested_answer', (answer: string, question: string, confidence: number) => {
      sendToIntelligenceWindows('intelligence-suggested-answer', { answer, question, confidence });

    })

    this.intelligenceManager.on('suggested_answer_token', (token: string, question: string, confidence: number) => {
      sendToIntelligenceWindows('intelligence-suggested-answer-token', { token, question, confidence });
    })

    this.intelligenceManager.on('refined_answer_token', (token: string, intent: string) => {
      sendToIntelligenceWindows('intelligence-refined-answer-token', { token, intent })
    })

    this.intelligenceManager.on('refined_answer', (answer: string, intent: string) => {
      sendToIntelligenceWindows('intelligence-refined-answer', { answer, intent })

    })

    this.intelligenceManager.on('recap', (summary: string) => {
      sendToIntelligenceWindows('intelligence-recap', { summary })
    })

    this.intelligenceManager.on('recap_token', (token: string) => {
      sendToIntelligenceWindows('intelligence-recap-token', { token })
    })

    this.intelligenceManager.on('clarify', (clarification: string) => {
      sendToIntelligenceWindows('intelligence-clarify', { clarification })
    })

    this.intelligenceManager.on('clarify_token', (token: string) => {
      sendToIntelligenceWindows('intelligence-clarify-token', { token })
    })

    this.intelligenceManager.on('follow_up_questions_update', (questions: string) => {
      sendToIntelligenceWindows('intelligence-follow-up-questions-update', { questions })
    })

    this.intelligenceManager.on('follow_up_questions_token', (token: string) => {
      sendToIntelligenceWindows('intelligence-follow-up-questions-token', { token })
    })

    this.intelligenceManager.on('manual_answer_started', () => {
      sendToIntelligenceWindows('intelligence-manual-started')
    })

    this.intelligenceManager.on('manual_answer_result', (answer: string, question: string) => {
      sendToIntelligenceWindows('intelligence-manual-result', { answer, question })

    })

    this.intelligenceManager.on('mode_changed', (mode: string) => {
      sendToIntelligenceWindows('intelligence-mode-changed', { mode })
    })

    this.intelligenceManager.on('error', (error: Error, mode: string) => {
      console.error(`[IntelligenceManager] Error in ${mode}:`, error)
      sendToIntelligenceWindows('intelligence-error', { error: error.message, mode })
    })
  }





  public updateGoogleCredentials(keyPath: string): void {
    console.log(`[AppState] Updating Google Credentials to: ${keyPath}`);
    // Set global environment variable so new instances pick it up
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

    if (this.googleSTT) {
      this.googleSTT.setCredentials(keyPath);
    }

    if (this.googleSTT_User) {
      this.googleSTT_User.setCredentials(keyPath);
    }
  }

  public setRecognitionLanguage(key: string): void {
    console.log(`[AppState] Setting recognition language to: ${key}`);
    const { CredentialsManager } = require('./services/CredentialsManager');
    CredentialsManager.getInstance().setSttLanguage(key);

    // 'auto' is only meaningful for NativelyProSTT — other providers fall back to en-US.
    const sttProvider = CredentialsManager.getInstance().getSttProvider();
    const effectiveKey = (key === 'auto' && sttProvider !== 'natively') ? 'english-us' : key;

    this.googleSTT?.setRecognitionLanguage(effectiveKey);
    this.googleSTT_User?.setRecognitionLanguage(effectiveKey);
    this.processingHelper.getLLMHelper().setSttLanguage(effectiveKey);
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  public static peekInstance(): AppState | null {
    return AppState.instance;
  }

  // Getters and Setters
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getWindowHelper(): WindowHelper {
    return this.windowHelper
  }

  public getIntelligenceManager(): IntelligenceManager {
    return this.intelligenceManager
  }

  public getThemeManager(): ThemeManager {
    return this.themeManager
  }

  public getRAGManager(): RAGManager | null {
    return this.ragManager;
  }

  public getKnowledgeOrchestrator(): any {
    return this.knowledgeOrchestrator;
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(problemInfo: any): void {
    this.problemInfo = problemInfo
  }

  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  // Window management methods
  public setupOllamaIpcHandlers(): void {
    ipcMain.handle('get-ollama-models', async () => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout for detection

        const response = await fetch('http://localhost:11434/api/tags', {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          // data.models is an array of objects: { name: "llama3:latest", ... }
          return data.models.map((m: any) => m.name);
        }
        return [];
      } catch (error) {
        // console.warn("Ollama detection failed:", error);
        return [];
      }
    });
  }

  public createWindow(): void {
    this.windowHelper.createWindow()
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(inactive?: boolean): void {
    if (this.windowHelper) {
      this.windowHelper.showMainWindow(inactive)
    }
  }

  public toggleMainWindow(): void {
    console.log(
      "Screenshots: ",
      this.screenshotHelper.getScreenshotQueue().length,
      "Extra screenshots: ",
      this.screenshotHelper.getExtraScreenshotQueue().length
    )
    
    const mode = this.windowHelper.getCurrentWindowMode();
    
    if (mode === 'launcher') {
      // In launcher mode, just physically hide/show the window
      this.windowHelper.toggleMainWindow();
    } else {
      // In overlay mode, send toggle-expand IPC to expand/collapse the UI
      const targetWindow = this.windowHelper.getOverlayWindow();
      if (targetWindow && !targetWindow.isDestroyed()) {
        targetWindow.webContents.send('toggle-expand');
      }
    }
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()

    // Clear problem info
    this.problemInfo = null

    // Reset view to initial state
    this.setView("queue")
  }

  private createScreenshotCaptureSession(
    captureKind: ScreenshotCaptureKind,
    restoreFocus: boolean
  ): ScreenshotCaptureSession {
    const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
    const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
    const chatLogViewerWindow = this.chatLogViewerWindowHelper.getWindow();

    return {
      captureKind,
      wasMainWindowVisible: this.windowHelper.isVisible(),
      windowMode: this.windowHelper.getCurrentWindowMode(),
      wasSettingsVisible: !!settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible(),
      wasModelSelectorVisible: !!modelSelectorWindow && !modelSelectorWindow.isDestroyed() && modelSelectorWindow.isVisible(),
      wasChatLogViewerVisible: !!chatLogViewerWindow && !chatLogViewerWindow.isDestroyed() && chatLogViewerWindow.isVisible(),
      overlayBounds: this.windowHelper.getLastOverlayBounds(),
      overlayDisplayId: this.windowHelper.getLastOverlayDisplayId(),
      restoreWithoutFocus: process.platform === 'darwin' || !restoreFocus
    };
  }

  private getDisplayById(displayId: number | null): Electron.Display | undefined {
    if (displayId === null) return undefined;
    return screen.getAllDisplays().find(display => display.id === displayId);
  }

  private getTargetDisplayForFullScreenshot(session: ScreenshotCaptureSession): Electron.Display {
    if (session.windowMode === 'overlay' && session.overlayBounds) {
      return screen.getDisplayMatching(session.overlayBounds);
    }

    const lastOverlayDisplay = this.getDisplayById(session.overlayDisplayId);
    if (lastOverlayDisplay) {
      return lastOverlayDisplay;
    }

    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  private hideWindowsForScreenshot(session: ScreenshotCaptureSession): void {
    if (session.wasChatLogViewerVisible) {
      this.chatLogViewerWindowHelper.hideWindow();
    }

    if (session.wasModelSelectorVisible) {
      this.modelSelectorWindowHelper.hideWindow();
    }

    if (session.wasSettingsVisible) {
      this.settingsWindowHelper.closeWindow();
    }

    if (session.wasMainWindowVisible) {
      this.hideMainWindow();
    }
  }

  private restoreWindowsAfterScreenshot(session: ScreenshotCaptureSession): void {
    const activate = !session.restoreWithoutFocus;
    const shouldRestoreMainWindow = session.wasMainWindowVisible;

    if (shouldRestoreMainWindow) {
      if (session.windowMode === 'overlay') {
        this.windowHelper.switchToOverlay(!activate);
      } else {
        this.windowHelper.switchToLauncher(!activate);
      }
    }

    if (session.wasSettingsVisible) {
      const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        const { x, y } = settingsWindow.getBounds();
        this.settingsWindowHelper.showWindow(x, y, { activate });
      }
    }

    if (session.wasModelSelectorVisible) {
      const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
      if (modelSelectorWindow && !modelSelectorWindow.isDestroyed()) {
        const { x, y } = modelSelectorWindow.getBounds();
        this.modelSelectorWindowHelper.showWindow(x, y, { activate });
      }
    }

    if (session.wasChatLogViewerVisible) {
      this.chatLogViewerWindowHelper.showWindow({ activate });
    }
  }

  private async withScreenshotCaptureSession<T>(
    captureKind: ScreenshotCaptureKind,
    restoreFocus: boolean,
    capture: (session: ScreenshotCaptureSession) => Promise<T>
  ): Promise<T> {
    if (!this.getMainWindow()) {
      throw new Error("No main window available");
    }

    if (this.screenshotCaptureInProgress) {
      throw new Error("Screenshot capture already in progress");
    }

    const session = this.createScreenshotCaptureSession(captureKind, restoreFocus);
    this.screenshotCaptureInProgress = true;

    try {
      this.hideWindowsForScreenshot(session);
      // setOpacity(0) makes the window invisible to the compositor immediately
      // (within the current frame). hide() removes it from the event dispatch
      // tree synchronously. One compositor frame flush (~16ms) is enough for
      // macOS to stop including the window in the next capture frame. We wait
      // 80ms to give the GPU render server one full v-sync cycle + overhead,
      // which consistently avoids the black-frame artifact without the
      // excessive 150ms latency the old value imposed.
      await new Promise(resolve => setTimeout(resolve, process.platform === 'darwin' ? 80 : 40));
      return await capture(session);
    } finally {
      try {
        this.restoreWindowsAfterScreenshot(session);
      } finally {
        this.screenshotCaptureInProgress = false;
      }
    }
  }

  private setTransientScreenshotCaptureProtection(enable: boolean): void {
    const state = enable || this.isUndetectable;
    this.windowHelper.setTransientCaptureProtection(enable);
    this.settingsWindowHelper.setContentProtection(state);
    this.modelSelectorWindowHelper.setContentProtection(state);
    this.chatLogViewerWindowHelper.setContentProtection(state);
    this.cropperWindowHelper.setContentProtection(state);
  }

  // Screenshot management methods
  public async takeScreenshot(restoreFocus: boolean = true): Promise<string> {
    return this.withScreenshotCaptureSession('full', restoreFocus, (session) =>
      this.screenshotHelper.takeScreenshot(this.getTargetDisplayForFullScreenshot(session))
    )
  }

  public async takeContextScreenshot(restoreFocus: boolean = false): Promise<string> {
    if (!this.getMainWindow()) {
      throw new Error("No main window available");
    }

    if (this.screenshotCaptureInProgress) {
      throw new Error("Screenshot capture already in progress");
    }

    const session = this.createScreenshotCaptureSession('full', restoreFocus);
    this.screenshotCaptureInProgress = true;

    try {
      this.setTransientScreenshotCaptureProtection(true);
      await new Promise(resolve => setTimeout(resolve, process.platform === 'win32' ? 80 : 40));
      return await this.screenshotHelper.takeScreenshot(this.getTargetDisplayForFullScreenshot(session));
    } finally {
      try {
        this.setTransientScreenshotCaptureProtection(false);
      } finally {
        this.screenshotCaptureInProgress = false;
      }
    }
  }

  public async takeSelectiveScreenshot(restoreFocus: boolean = true): Promise<string> {
    return this.withScreenshotCaptureSession('selective', restoreFocus, async () => {
      let captureArea: Electron.Rectangle | undefined;

      if (process.platform === 'win32' || process.platform === 'darwin') {
        captureArea = await this.cropperWindowHelper.showCropper();

        if (!captureArea) {
          throw new Error("Selection cancelled");
        }
      }

      return this.screenshotHelper.takeSelectiveScreenshot(captureArea)
    })
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    path: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(path)
  }

  // New methods to move the window
  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }
  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }
  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  public createTray(): void {
    this.showTray();
  }

  public showTray(): void {
    if (this.tray) return;

    // Try to find a template image first for macOS
    const resourcesPath = app.isPackaged ? process.resourcesPath : app.getAppPath();

    // Potential paths for tray icon
    const templatePath = path.join(resourcesPath, 'assets', 'iconTemplate.png');
    const defaultIconPath = app.isPackaged
      ? path.join(resourcesPath, 'src/components/icon.png')
      : path.join(app.getAppPath(), 'src/components/icon.png');

    let iconToUse = defaultIconPath;

    // Check if template exists (sync check is fine for startup/rare toggle)
    try {
      if (require('fs').existsSync(templatePath)) {
        iconToUse = templatePath;
        console.log('[Tray] Using template icon:', templatePath);
      } else {
        // Also check src/components for dev
        const devTemplatePath = path.join(app.getAppPath(), 'src/components/iconTemplate.png');
        if (require('fs').existsSync(devTemplatePath)) {
          iconToUse = devTemplatePath;
          console.log('[Tray] Using dev template icon:', devTemplatePath);
        } else {
          console.log('[Tray] Template icon not found, using default:', defaultIconPath);
        }
      }
    } catch (e) {
      console.error('[Tray] Error checking for icon:', e);
    }

    const trayIcon = nativeImage.createFromPath(iconToUse).resize({ width: 16, height: 16 });
    // IMPORTANT: specific template settings for macOS if needed, but 'Template' in name usually suffices
    trayIcon.setTemplateImage(iconToUse.endsWith('Template.png'));

    this.tray = new Tray(trayIcon)
    this.tray.setToolTip('Natively') // This tooltip might also need update if we change global shortcut, but global shortcut is removed.
    this.updateTrayMenu();

    // Double-click to show window
    this.tray.on('double-click', () => {
      this.centerAndShowWindow()
    })
  }

  public updateTrayMenu() {
    if (!this.tray) return;

    const keybindManager = KeybindManager.getInstance();
    const screenshotAccel = keybindManager.getKeybind('general:take-screenshot') || 'CommandOrControl+H';

    console.log('[Main] updateTrayMenu called. Screenshot Accelerator:', screenshotAccel);

    // Update tooltip for verification
    this.tray.setToolTip('Natively');

    // Helper to format accelerator for display (e.g. CommandOrControl+H -> Cmd+H)
    const formatAccel = (accel: string) => {
      return accel
        .replace('CommandOrControl', 'Cmd')
        .replace('Command', 'Cmd')
        .replace('Control', 'Ctrl')
        .replace('OrControl', '') // Cleanup just in case
        .replace(/\+/g, '+');
    };

    const displayScreenshot = formatAccel(screenshotAccel);
    // We can also get the toggle visibility shortcut if desired
    const toggleKb = keybindManager.getKeybind('general:toggle-visibility');
    const toggleAccel = toggleKb || 'CommandOrControl+B';
    const displayToggle = formatAccel(toggleAccel);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Natively',
        click: () => {
          this.centerAndShowWindow()
        }
      },
      {
        label: `Toggle Window (${displayToggle})`,
        click: () => {
          this.toggleMainWindow()
        }
      },
      {
        type: 'separator'
      },
      {
        label: `Take Screenshot (${displayScreenshot})`,
        accelerator: screenshotAccel,
        click: async () => {
          try {
            const screenshotPath = await this.takeScreenshot()
            const preview = await this.getImagePreview(screenshotPath)
            const mainWindow = this.getMainWindow()
            if (mainWindow) {
              mainWindow.webContents.send("screenshot-taken", {
                path: screenshotPath,
                preview
              })
            }
          } catch (error) {
            console.error("Error taking screenshot from tray:", error)
          }
        }
      },
      {
        type: 'separator'
      },
      {
        label: 'Quit',
        accelerator: 'Command+Q',
        click: () => {
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  public hideTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  public setUndetectable(state: boolean): void {
    // Guard: skip if state hasn't actually changed to prevent
    // duplicate dock hide/show cycles from renderer feedback loops
    if (this.isUndetectable === state) return;

    console.log(`[Stealth] setUndetectable(${state}) called`);

    this.isUndetectable = state
    this.windowHelper.setContentProtection(state)
    this.settingsWindowHelper.setContentProtection(state)
    this.modelSelectorWindowHelper.setContentProtection(state)
    this.chatLogViewerWindowHelper.setContentProtection(state)
    this.cropperWindowHelper.setContentProtection(state)

    // Persist state via SettingsManager
    SettingsManager.getInstance().set('isUndetectable', state);

    // Cancel all pending disguise timers to prevent their app.setName() calls
    // from re-registering the dock icon after we hide it
    if (state) {
      for (const timer of this._disguiseTimers) {
        clearTimeout(timer);
      }
      this._disguiseTimers = [];
    }

    // Broadcast state change to all relevant windows
    this._broadcastToAllWindows('undetectable-changed', state);

    // --- STEALTH MODE LOGIC ---
    // The dock hide/show is debounced: rapid toggles update isUndetectable immediately
    // (so content protection, IPC broadcasts and the guard above are always current),
    // but the actual macOS dock/tray/focus operation only fires once the user stops
    // toggling. This eliminates the race where dock.show() + NSApp.activate() lingers
    // after a subsequent dock.hide() call.
    if (process.platform === 'darwin') {
      if (this._dockDebounceTimer) {
        clearTimeout(this._dockDebounceTimer);
        this._dockDebounceTimer = null;
      }

      this._dockDebounceTimer = setTimeout(() => {
        this._dockDebounceTimer = null;

        // Read the settled state — may differ from the `state` captured above
        // if the user toggled again before the timer fired.
        const settled = this.isUndetectable;

        const activeWindow = this.windowHelper.getMainWindow();
        const settingsWindow = this.settingsWindowHelper.getSettingsWindow();
        let targetFocusWindow = activeWindow;
        if (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isVisible()) {
          targetFocusWindow = settingsWindow;
        }

        const modelSelectorWindow = this.modelSelectorWindowHelper.getWindow();
        const isModelSelectorVisible = modelSelectorWindow && !modelSelectorWindow.isDestroyed() && modelSelectorWindow.isVisible();

        if (targetFocusWindow && targetFocusWindow === settingsWindow) {
          this.settingsWindowHelper.setIgnoreBlur(true);
        }
        if (isModelSelectorVisible) {
          this.modelSelectorWindowHelper.setIgnoreBlur(true);
        }

        if (settled) {
          // Capture whether Natively is currently the frontmost app BEFORE
          // dock.hide() — that call triggers an implicit macOS app-deactivation
          // which shifts keyboard focus to the next frontmost app (Chrome, etc.).
          const nativelyWasFocused =
            targetFocusWindow != null &&
            !targetFocusWindow.isDestroyed() &&
            targetFocusWindow.isFocused();

          console.log('[Stealth] Calling app.dock.hide()');
          app.dock.hide();
          this.hideTray();

          // If Natively was the focused window when the user toggled stealth,
          // restore focus to our window after dock.hide() so macOS does not
          // hand control to Chrome / whatever is behind us.
          // We use win.focus() (not app.focus()) to avoid the heavy-handed
          // [NSApp activateIgnoringOtherApps:YES] side-effect.
          if (nativelyWasFocused && targetFocusWindow && !targetFocusWindow.isDestroyed()) {
            targetFocusWindow.focus();
          }
        } else {
          console.log('[Stealth] Calling app.dock.show()');
          app.dock.show();
          this.showTray();
          // Do NOT call focus() — let the user's current app retain focus
        }

        if (targetFocusWindow && targetFocusWindow === settingsWindow) {
          setTimeout(() => { this.settingsWindowHelper.setIgnoreBlur(false); }, 500);
        }
        if (isModelSelectorVisible) {
          setTimeout(() => { this.modelSelectorWindowHelper.setIgnoreBlur(false); }, 500);
        }
      }, 150);
    }
  }

  public getUndetectable(): boolean {
    return this.isUndetectable
  }

  public getProactiveModeEnabled(): boolean {
    return this.proactiveModeEnabled;
  }

  private applyProactiveCoachModel(): void {
    const llmHelper = this.processingHelper.getLLMHelper();
    llmHelper.setModel('gpt-5.4-mini');
    llmHelper.setReasoningEffort('low');
    this._broadcastToAllWindows('model-changed', llmHelper.getCurrentModel());
    this._broadcastToAllWindows('reasoning-effort-changed', llmHelper.getReasoningEffort());
  }

  public setProactiveModeEnabled(state: boolean): void {
    if (this.proactiveModeEnabled === state) {
      if (state) {
        this.applyProactiveCoachModel();
        this.startProactiveScreenContext();
      } else {
        this.stopProactiveScreenContextIfOwned();
      }
      return;
    }

    this.proactiveModeEnabled = state;
    SettingsManager.getInstance().set('proactiveModeEnabled', state);
    if (state) {
      this.applyProactiveCoachModel();
      this.startProactiveScreenContext();
    } else {
      this.stopProactiveScreenContextIfOwned();
    }
    this.intelligenceManager.setProactiveModeEnabled(state);
    this._broadcastToAllWindows('proactive-mode-changed', state);
    console.log(`[Main] Proactive mode ${state ? 'enabled' : 'disabled'}`);
  }

  // --- Mouse Passthrough (Adapted from public PR #113 — verify premium interaction) ---
  private overlayMousePassthrough: boolean = false;

  public setOverlayMousePassthrough(state: boolean): void {
    if (this.overlayMousePassthrough === state) return;

    console.log(`[Overlay] setOverlayMousePassthrough(${state}) called`);

    this.overlayMousePassthrough = state;
    this.windowHelper.syncOverlayInteractionPolicy();

    // Immediately revalidate global shortcuts after the window interaction-policy
    // changes.  The OS can silently drop Carbon/IOKit hotkey registrations when
    // window focusability or visibility changes; revalidating surgically
    // re-registers any that were lost without clobbering the others.
    KeybindManager.getInstance().revalidateShortcuts();

    this._broadcastToAllWindows('overlay-mouse-passthrough-changed', state);
  }

  public toggleOverlayMousePassthrough(): boolean {
    const next = !this.overlayMousePassthrough;
    this.setOverlayMousePassthrough(next);
    return next;
  }

  public getOverlayMousePassthrough(): boolean {
    return this.overlayMousePassthrough;
  }

  public getVerboseLogging(): boolean {
    return this._verboseLogging;
  }

  public setVerboseLogging(enabled: boolean): void {
    this._verboseLogging = enabled;
    setVerboseLoggingFlag(enabled);
    SettingsManager.getInstance().set('verboseLogging', enabled);
    console.log(`[AppState] verboseLogging set to ${enabled}`);
  }

  public setDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    this.disguiseMode = mode;
    SettingsManager.getInstance().set('disguiseMode', mode);

    // Apply the disguise regardless of undetectable state
    // (disguise affects Activity Monitor name via process.title,
    //  dock icon only updates when NOT in stealth)
    this._applyDisguise(mode);
  }

  public applyInitialDisguise(): void {
    this._applyDisguise(this.disguiseMode);
  }

  private _applyDisguise(mode: 'terminal' | 'settings' | 'activity' | 'none'): void {
    let appName = "Natively";
    let iconPath = "";

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    switch (mode) {
      case 'terminal':
        appName = isWin ? "Command Prompt " : "Terminal ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/terminal.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/terminal.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/terminal.png");
        }
        break;
      case 'settings':
        appName = isWin ? "Settings " : "System Settings ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/settings.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/settings.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/settings.png");
        }
        break;
      case 'activity':
        appName = isWin ? "Task Manager " : "Activity Monitor ";
        if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/win/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/win/activity.png");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/fakeicon/mac/activity.png")
            : path.join(app.getAppPath(), "assets/fakeicon/mac/activity.png");
        }
        break;
      case 'none':
        appName = "Natively";
        if (isMac) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "natively.icns")
            : path.join(app.getAppPath(), "assets/natively.icns");
        } else if (isWin) {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "assets/icons/win/icon.ico")
            : path.join(app.getAppPath(), "assets/icons/win/icon.ico");
        } else {
          iconPath = app.isPackaged
            ? path.join(process.resourcesPath, "icon.png")
            : path.join(app.getAppPath(), "assets/icon.png");
        }
        break;
    }

    console.log(`[AppState] Applying disguise: ${mode} (${appName}) on ${process.platform}`);

    // 1. Update process title (affects Activity Monitor / Task Manager)
    process.title = appName;

    // 2. Update app name (affects macOS Menu / Dock)
    // Skip when undetectable — app.setName() causes macOS to re-register
    // the app and re-show the dock icon even after dock.hide()
    if (!this.isUndetectable) {
      app.setName(appName);
    }

    if (isMac) {
      process.env.CFBundleName = appName.trim();
    }

    // 3. Update App User Model ID (Windows Taskbar grouping)
    if (isWin) {
      const appUserModelId = mode === 'none'
        ? 'com.natively.assistant'
        : `com.natively.assistant.${mode}`;
      app.setAppUserModelId(appUserModelId);
    }

    // 4. Update Icons
    if (fs.existsSync(iconPath)) {
      const image = nativeImage.createFromPath(iconPath);

      if (isMac) {
        // Skip dock icon update when dock is hidden to avoid potential flicker
        if (!this.isUndetectable) {
          app.dock.setIcon(image);
        }
      } else {
        // Windows/Linux: Update all window icons
        this.windowHelper.getLauncherWindow()?.setIcon(image);
        this.windowHelper.getOverlayWindow()?.setIcon(image);
        this.settingsWindowHelper.getSettingsWindow()?.setIcon(image);
      }
    } else {
      console.warn(`[AppState] Disguise icon not found: ${iconPath}`);
    }

    // 5. Update Window Titles
    const launcher = this.windowHelper.getLauncherWindow();
    if (launcher && !launcher.isDestroyed()) {
      launcher.setTitle(appName.trim());
      launcher.webContents.send('disguise-changed', mode);
    }

    const overlay = this.windowHelper.getOverlayWindow();
    if (overlay && !overlay.isDestroyed()) {
      overlay.setTitle(appName.trim());
      overlay.webContents.send('disguise-changed', mode);
    }

    const settingsWin = this.settingsWindowHelper.getSettingsWindow();
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.setTitle(appName.trim());
      settingsWin.webContents.send('disguise-changed', mode);
    }

    // Cancel any stale forceUpdate timeouts from previous disguise changes
    for (const timer of this._disguiseTimers) {
      clearTimeout(timer);
    }
    this._disguiseTimers = [];

    // Periodically re-assert process.title only — it can drift on some systems.
    // NOTE: We intentionally do NOT call app.setName() here — it was already called
    // synchronously above, and repeated calls on macOS cause the system to briefly
    // show a second dock tile while re-registering the app identity.
    const scheduleUpdate = (ms: number) => {
      const ts = setTimeout(() => {
        process.title = appName;
        this._disguiseTimers = this._disguiseTimers.filter(t => t !== ts);
      }, ms);
      this._disguiseTimers.push(ts);
    };

    scheduleUpdate(200);
    scheduleUpdate(1000);
    scheduleUpdate(5000);
  }

  // Helper: broadcast an IPC event to all windows
  private _broadcastToAllWindows(channel: string, ...args: any[]): void {
    const windows = [
      this.windowHelper.getMainWindow(),
      this.windowHelper.getLauncherWindow(),
      this.windowHelper.getOverlayWindow(),
      this.settingsWindowHelper.getSettingsWindow(),
      this.modelSelectorWindowHelper.getWindow(),
      this.chatLogViewerWindowHelper.getWindow(),
    ];
    const sent = new Set<number>();
    for (const win of windows) {
      if (win && !win.isDestroyed() && !sent.has(win.id)) {
        sent.add(win.id);
        win.webContents.send(channel, ...args);
      }
    }
  }

  public getDisguise(): string {
    return this.disguiseMode;
  }
}

// Application initialization

async function initializeApp() {
  earlyTrace('initializeApp enter');
  // 1. Enforce single instance — prevent duplicate dock icons from leftover processes.
  // In development mode with hot-reload this is still safe because electron is restarted
  // by the build step, not re-launched by concurrently while the old process is alive.
  const gotLock = app.requestSingleInstanceLock();
  earlyTrace(`single-instance-lock=${String(gotLock)}`);
  if (!gotLock) {
    console.log('[Main] Another instance is already running. Quitting this instance.');
    earlyTrace('single-instance-lock denied; quitting');
    app.quit();
    return;
  }

  app.on('second-instance', (_event, commandLine) => {
    const args = new Set((commandLine ?? process.argv).map((arg) => arg.toLowerCase()));
    const shouldShow = [...args].some((arg) => SHOW_ARGS.has(arg));
    const shouldOpenChatLogViewer = [...args].some((arg) => CHAT_LOG_VIEWER_ARGS.has(arg));
    console.log(`[Main] Second instance requested — show=${String(shouldShow)} restore attempt`);
    const forceShow = true;

    const existingState = AppState.peekInstance();
    if (existingState) {
      if (existingState.getMainWindow() === null) {
        existingState.createWindow();
      }

      if (forceShow || shouldShow) {
        existingState.centerAndShowWindow();
      }
      if (shouldOpenChatLogViewer) {
        existingState.chatLogViewerWindowHelper.showWindow();
      }
      return;
    }

    const existingWindow = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore();
      }
      existingWindow.show();
      existingWindow.focus();
    }
  });

  // 2. Wait for app to be ready
  await app.whenReady()
  earlyTrace('app.whenReady resolved');

  // 2a. PRE-EMPTIVE dock hide: must happen before ANY operation that causes macOS to
  // register a dock entry (app.setName, BrowserWindow creation, etc.).
  // We read isUndetectable directly from settings here — AppState singleton isn't
  // constructed yet, so we cannot call appState.getUndetectable().
  if (process.platform === 'darwin') {
    // SettingsManager is already statically imported — no require() needed.
    const isUndetectableOnStartup = SettingsManager.getInstance().get('isUndetectable') ?? false;
    if (isUndetectableOnStartup) {
      app.dock.hide();
    }
  }

  // 3. Initialize Managers
  // Initialize CredentialsManager and load keys explicitly
  // This fixes the issue where keys (especially in production) aren't loaded in time for RAG/LLM
  const { CredentialsManager } = require('./services/CredentialsManager');
  CredentialsManager.getInstance().init();

  // 4. Initialize State
  const appState = AppState.getInstance()

  // Explicitly load credentials into helpers
  appState.processingHelper.loadStoredCredentials();
  if (appState.getProactiveModeEnabled()) {
    appState.setProactiveModeEnabled(true);
  }

  // Initialize IPC handlers before window creation
  initializeIpcHandlers(appState)

  if (AUTONOMOUS_OPS_ENABLED) {
    AutonomousOpsService.getInstance().start();
  } else {
    console.log('[Init] Autonomous workflow supervision disabled by default. Set NATIVELY_ENABLE_AUTONOMOUS_OPS=1 to enable repo workflow monitoring.');
  }

  // Apply the full disguise payload (names, dock icon, AUMID) early
  appState.applyInitialDisguise();

  // Start the Ollama lifecycle manager
  OllamaManager.getInstance().init().catch(console.error);

  // NOTE: CredentialsManager.init() and loadStoredCredentials() are already called
  // above before this block — do NOT call them again here to avoid double key-load.

  // Anonymous install ping - one-time, non-blocking
  // See electron/services/InstallPingManager.ts for privacy details
  const { sendAnonymousInstallPing } = require('./services/InstallPingManager');
  sendAnonymousInstallPing();

  // Load stored Google Service Account path (for Speech-to-Text)
  // Fall back to GOOGLE_APPLICATION_CREDENTIALS env var (set in terminal but not Spotlight)
  const storedServiceAccountPath = CredentialsManager.getInstance().getGoogleServiceAccountPath()
    || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (storedServiceAccountPath) {
    if (isInvalidGoogleServiceAccountPath(storedServiceAccountPath)) {
      console.warn('[Init] Ignoring invalid Google Service Account path:', storedServiceAccountPath);
      CredentialsManager.getInstance().setGoogleServiceAccountPath(undefined);
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    } else {
      console.log("[Init] Loading stored Google Service Account path");
      appState.updateGoogleCredentials(storedServiceAccountPath);
      // Persist env-var path so Spotlight launches also work going forward
      if (!CredentialsManager.getInstance().getGoogleServiceAccountPath()) {
        CredentialsManager.getInstance().setGoogleServiceAccountPath(storedServiceAccountPath);
      }
    }
  }

  try {
    const llmHelper = appState.processingHelper.getLLMHelper();
    llmHelper.setIPCorpMode(true);
    console.log('[Init] Meeting AI defaults enabled (IP Corp mode; Continuous OCR disabled by default)');
  } catch (error) {
    console.warn('[Init] Failed to enable Meeting AI defaults:', error);
  }

  console.log("App is ready")
  earlyTrace('app ready; creating launcher window');

  console.log('[Main] creating launcher window now')
  try {
    appState.createWindow()
    console.log('[Main] createWindow returned')
  } catch (error) {
    console.error('[Main] createWindow failed', error)
  }

  if (hasStartupShowRequest) {
    setTimeout(() => {
      const mainWindow = appState.getMainWindow();
      if (appState.getMainWindow() === null) {
        appState.createWindow()
      }
      appState.centerAndShowWindow()
      if (mainWindow?.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow?.focus()
    }, 400)
  }

  if (hasStartupChatLogViewerRequest) {
    setTimeout(() => {
      appState.chatLogViewerWindowHelper.showWindow();
    }, 550);
  }

  // Apply initial stealth state based on isUndetectable setting.
  // NOTE: app.dock.hide() was already called pre-emptively before createWindow()
  // when isUndetectable=true. Here we only need to initialize the tray for non-stealth mode.
  if (!appState.getUndetectable()) {
    // Normal mode: show tray (dock is already showing — no need to call dock.show() again)
    appState.showTray();
  }
  // Stealth mode: dock is already hidden, tray stays hidden, no action needed here.
  // Register global shortcuts using KeybindManager
  KeybindManager.getInstance().registerGlobalShortcuts()

  // Pre-create settings window in background for faster first open
  appState.settingsWindowHelper.preloadWindow()

  if (CONTEXT_STACK_BOOTSTRAP_ENABLED) {
    try {
      const { ContextStackBootstrapService } = require('./services/ContextStackBootstrapService');
      ContextStackBootstrapService.getInstance()
        .ensureRunning()
        .then((status: any) => {
          console.log('[Main] Context stack bootstrap complete:', status);
          try {
            const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
            MicrosoftLocalManager.getInstance().refreshConnections().catch((error: any) => {
              console.warn('[Main] MicrosoftLocalManager refresh after bootstrap failed:', error?.message || error);
            });
          } catch (e) {
            console.warn('[Main] Failed to refresh MicrosoftLocalManager after bootstrap:', e);
          }
        })
        .catch((error: any) => {
          console.warn('[Main] Context stack bootstrap failed:', error?.message || error);
        });
    } catch (e) {
      console.error('[Main] Failed to initialize ContextStackBootstrapService:', e);
    }
  } else {
    console.log('[Init] Context stack bootstrap disabled by default; Outlook, Teams, and Cluely will not be launched on Natively startup.');
  }

  // One-time macOS screen recording permission prompt.
  //
  // We must fire this AFTER createWindow() so that:
  //   1. The Natively launcher window is visible and focused when the TCC dialog
  //      appears — macOS anchors the dialog to the frontmost app window on Ventura+.
  //      Without a visible window the dialog can appear behind other apps (Sequoia).
  //   2. In stealth/undetectable mode the dock icon is hidden, but the window is
  //      still visible — the dialog still has a surface to attach to.
  //
  // The 800ms delay lets the launcher's ready-to-show animation complete so the
  // window is fully composited before the system sheet appears above it.
  //
  // TCC caches the decision permanently after the first response — this block
  // runs exactly ONCE on the first launch of each unique packaged binary.
  // On every subsequent launch the status is 'granted' or 'denied', and we skip.
  if (process.platform === 'darwin') {
    setTimeout(async () => {
      try {
        const screenStatus = systemPreferences.getMediaAccessStatus('screen');
        if (screenStatus === 'not-determined') {
          console.log('[Init] Screen recording permission not-determined — triggering one-time TCC dialog after window is ready...');
          // Minimal thumbnail: we only want the TCC side-effect, not actual image data.
          await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
          const afterStatus = systemPreferences.getMediaAccessStatus('screen');
          console.log(`[Init] Screen recording status after startup TCC prompt: ${afterStatus}`);
          if (afterStatus === 'denied') {
            // Notify all open windows so the renderer can show a non-blocking banner.
            const { BrowserWindow } = require('electron');
            BrowserWindow.getAllWindows().forEach((win: Electron.BrowserWindow) => {
              if (!win.isDestroyed()) {
                win.webContents.send('system-audio-permission-denied',
                  'Screen Recording was denied. Enable it in System Settings > Privacy & Security > Screen Recording, then restart Natively.');
              }
            });
          }
        } else {
          console.log(`[Init] Screen recording permission already resolved at startup: ${screenStatus}`);
        }
      } catch (e) {
        // Log the real OS error so it appears in natively_debug.log for support diagnosis.
        // We do NOT re-throw — a missing screen-capture permission is non-fatal at launch.
        console.warn('[Init] Startup screen recording permission check failed. Screenshots and system audio may not work. Error:', e);
      }
    }, 800);
  }

  // Initialize CalendarManager
  try {
    const { CalendarManager } = require('./services/CalendarManager');
    const calMgr = CalendarManager.getInstance();
    calMgr.init();

    calMgr.on('start-meeting-requested', (event: any) => {
      console.log('[Main] Start meeting requested from calendar notification', event);
      appState.centerAndShowWindow();
      appState.startMeeting({
        title: event.title,
        calendarEventId: event.id,
        source: 'calendar'
      });
    });

    calMgr.on('open-requested', () => {
      appState.centerAndShowWindow();
    });

    console.log('[Main] CalendarManager initialized');
    appState.startMeetingPrepScheduler();
  } catch (e) {
    console.error('[Main] Failed to initialize CalendarManager:', e);
  }

  try {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    const microsoftLocal = MicrosoftLocalManager.getInstance();
    const mainWindow = appState.getMainWindow();
    if (mainWindow) {
      microsoftLocal.setWindow(mainWindow);
    }
    microsoftLocal.start().catch((error: any) => {
      console.warn('[Main] MicrosoftLocalManager start failed:', error?.message || error);
    });
    setTimeout(() => {
      microsoftLocal.refreshConnections().catch((error: any) => {
        console.warn('[Main] MicrosoftLocalManager delayed refresh failed:', error?.message || error);
      });
    }, 5000);
    setTimeout(() => {
      microsoftLocal.refreshConnections().catch((error: any) => {
        console.warn('[Main] MicrosoftLocalManager delayed refresh failed:', error?.message || error);
      });
    }, 15000);
    console.log('[Main] MicrosoftLocalManager initialized');
  } catch (e) {
    console.error('[Main] Failed to initialize MicrosoftLocalManager:', e);
  }

  // Recovery always runs for DATA (finalize crashed meetings from their
  // incrementally-flushed transcripts — zero model calls). The LLM summary
  // pass stays behind the env flag to avoid automatic model calls on launch.
  appState.getIntelligenceManager()
    .recoverUnprocessedMeetings({ llmProcessing: STARTUP_MEETING_RECOVERY_ENABLED })
    .catch(err => {
      console.error('[Main] Failed to recover unprocessed meetings:', err);
    });

  // Note: We do NOT force dock show here anymore, respecting stealth mode.

  app.on("activate", () => {
    console.log("App activated")
    if (process.platform === 'darwin') {
      // Do NOT call dock.show() while a meeting is running — the dock icon
      // appearing mid-meeting is a critical stealth failure.
      if (!appState.getUndetectable() && !appState.getIsMeetingActive()) {
        app.dock.show();
      }
    }
    
    // If no window exists, create it
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    } else {
      // If the window exists but is hidden, clicking the dock icon should restore it
      if (!appState.isVisible()) {
        appState.toggleMainWindow();
      }
    }
  })

  // Quit when all windows are closed, except on macOS
  app.on("window-all-closed", () => {
    earlyTrace('window-all-closed');
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // Scrub API keys from memory on quit to minimize exposure window
  app.on("before-quit", (event) => {
    earlyTrace('before-quit');
    console.log("App is quitting, cleaning up resources...");
    appState.setQuitting(true);

    // Persist any unflushed transcript segments before teardown — better-sqlite3
    // is synchronous, so this completes inside the before-quit handler.
    try {
      appState.getIntelligenceManager().flushActiveMeeting();
    } catch (e) {
      console.error('[Main] Failed to flush meeting transcript on quit:', e);
    }

    appState.stopMeetingPrepScheduler();

    // Dispose CropperWindowHelper to clean up IPC listeners and prevent memory leaks
    // This is critical to prevent resource leaks and ensure proper cleanup
    if (appState?.cropperWindowHelper) {
      appState.cropperWindowHelper.dispose();
    }

    // Kill Ollama if we started it
    OllamaManager.getInstance().stop();

    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().scrubMemory();
      appState.processingHelper.getLLMHelper().scrubKeys();
      console.log('[Main] Credentials scrubbed from memory on quit');
    } catch (e) {
      console.error('[Main] Failed to scrub credentials on quit:', e);
    }

    try {
      const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
      MicrosoftLocalManager.getInstance().stop();
    } catch (e) {
      console.warn('[Main] Failed to stop MicrosoftLocalManager cleanly:', e);
    }
  })



  // app.dock?.hide() // REMOVED: User wants Dock icon visible
  app.commandLine.appendSwitch("disable-background-timer-throttling")
}

// Start the application
initializeApp().catch(console.error)
