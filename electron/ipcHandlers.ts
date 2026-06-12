// ipcHandlers.ts

import { app, ipcMain, shell, dialog, desktopCapturer, systemPreferences, BrowserWindow, Notification, screen } from "electron"
import { AppState } from "./main"
import { GEMINI_FLASH_MODEL } from "./IntelligenceManager"
import { DatabaseManager } from "./db/DatabaseManager"; // Import Database Manager
import { ContextObservationStore } from "./context";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { AudioDevices } from "./audio/AudioDevices";
import { buildClaudeCliEnv } from "./services/ClaudeCliEnvironment";
import { buildLocalCliInvocation, getLocalCliStatus, isLocalCliAvailable } from "./services/CliProviderResolver";


import { RECOGNITION_LANGUAGES, AI_RESPONSE_LANGUAGES } from "./config/languages"

export function initializeIpcHandlers(appState: AppState): void {
  const safeHandle = (channel: string, listener: (event: any, ...args: any[]) => Promise<any> | any) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, listener);
  };
  const broadcastMeetingsUpdated = () => {
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("meetings-updated");
        }
      });
    } catch (error) {
      console.warn("[IPC] Failed to broadcast meetings-updated:", error);
    }
  };

  const broadcastIntelligenceError = (error: string, mode: string) => {
    try {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("intelligence-error", { error, mode });
        }
      });
    } catch (broadcastError) {
      console.warn("[IPC] Failed to broadcast intelligence-error:", broadcastError);
    }
  };

  type ChatDebugStatus = 'completed' | 'error' | 'proposal' | 'superseded';
  type ChatDebugSurface = 'widget' | 'meeting_overlay' | 'global_overlay' | 'widget_live_rag' | 'meeting_rag' | 'global_rag' | string;
  type ChatDebugModelState = {
    provider: string | null;
    modelId: string | null;
    reasoningEffort: string | null;
  };
  type ChatDebugIssuePayload = {
    id: number;
    surface: ChatDebugSurface;
    surfaceLabel: string;
    status: ChatDebugStatus;
    timestamp: number;
    userQuery: string;
    aiResponse: string;
    error: string | null;
    provider: string | null;
    modelId: string | null;
  };

  const CHAT_DEBUG_SURFACE_LABELS: Record<string, string> = {
    widget: "Widget Chat",
    meeting_overlay: "Meeting Overlay",
    global_overlay: "Global Overlay",
    widget_live_rag: "Widget Live RAG",
    meeting_rag: "Meeting Recall RAG",
    global_rag: "Global Recall RAG",
  };

  const getChatDebugModelState = (): ChatDebugModelState => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider?.() ?? null,
        modelId: llmHelper.getCurrentModel?.() ?? null,
        reasoningEffort: llmHelper.getReasoningEffort?.() ?? null,
      };
    } catch {
      return {
        provider: null,
        modelId: null,
        reasoningEffort: null,
      };
    }
  };

  const surfaceLabelForChatDebug = (surface: ChatDebugSurface): string => {
    return CHAT_DEBUG_SURFACE_LABELS[surface] || surface;
  };

  const publishChatDebugIssue = (payload: ChatDebugIssuePayload) => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send("chat-debug:issue", payload);
        }
      }
    } catch (error) {
      console.warn("[IPC] Failed to publish chat debug issue event:", error);
    }

    try {
      const notification = new Notification({
        title: `${payload.surfaceLabel} issue detected`,
        body: payload.error || payload.aiResponse || payload.userQuery || "A chat turn was flagged as an issue.",
        silent: false,
      });
      notification.show();
    } catch (error) {
      console.warn("[IPC] Failed to show chat debug issue notification:", error);
    }
  };

  const isExplicitScreenReadRequest = (value: string): boolean => {
    const text = value.trim().toLowerCase();
    if (!text) return false;

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
    ].some((pattern) => pattern.test(text));
  };

  const getChatDebugOcrSnapshot = (referenceTimestamp: number) => {
    try {
      const observations = ContextObservationStore.getInstance().getDocuments({
        sourceTypes: ['ocr_observation'],
        maxAgeMs: 15 * 60 * 1000,
      });
      const latest = observations
        .slice()
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
      const latestCapturedAtMs = latest ? Date.parse(latest.createdAt) : Number.NaN;

      return {
        ocrObservationCount: observations.length,
        latestOcrCapturedAt: latest?.createdAt || null,
        latestOcrAgeMs: latest && !Number.isNaN(latestCapturedAtMs)
          ? Math.max(0, referenceTimestamp - latestCapturedAtMs)
          : null,
        latestOcrExcerpt: latest?.body
          ? latest.body.replace(/\s+/g, ' ').slice(0, 240)
          : null,
        latestOcrDisplayCount: typeof latest?.metadata?.displayCount === 'number'
          ? latest.metadata.displayCount
          : null,
      };
    } catch {
      return {
        ocrObservationCount: 0,
        latestOcrCapturedAt: null,
        latestOcrAgeMs: null,
        latestOcrExcerpt: null,
        latestOcrDisplayCount: null,
      };
    }
  };

  const saveChatDebugEntry = (input: {
    surface: ChatDebugSurface;
    status: ChatDebugStatus;
    modelState?: ChatDebugModelState;
    meetingId?: string | null;
    timestamp: number;
    userQuery: string;
    aiResponse?: string | null;
    imagePaths?: string[];
    firstTokenAt?: number | null;
    completedAt?: number;
    proposalKind?: string | null;
    error?: string | null;
    contextLength?: number;
    ragMode?: 'meeting' | 'live' | 'global' | null;
    ignoreKnowledgeMode?: boolean;
    skipSystemPrompt?: boolean;
  }) => {
    try {
      const completedAt = input.completedAt ?? Date.now();
      const modelState = input.modelState ?? getChatDebugModelState();
      const ocrSnapshot = getChatDebugOcrSnapshot(completedAt);
      const entryId = DatabaseManager.getInstance().saveChatDebugEntry({
        meetingId: input.meetingId ?? null,
        type: `chat_debug:${input.surface}`,
        timestamp: input.timestamp,
        userQuery: input.userQuery,
        aiResponse: input.aiResponse ?? '',
        metadata: {
          surface: input.surface,
          status: input.status,
          provider: modelState.provider,
          modelId: modelState.modelId,
          reasoningEffort: modelState.reasoningEffort,
          hadImages: (input.imagePaths?.length || 0) > 0,
          imagePaths: input.imagePaths || [],
          firstTokenAt: input.firstTokenAt ? new Date(input.firstTokenAt).toISOString() : null,
          completedAt: new Date(completedAt).toISOString(),
          firstTokenLatencyMs: input.firstTokenAt ? Math.max(0, input.firstTokenAt - input.timestamp) : null,
          totalLatencyMs: Math.max(0, completedAt - input.timestamp),
          proposalKind: input.proposalKind ?? null,
          error: input.error ?? null,
          contextLength: input.contextLength ?? 0,
          ragMode: input.ragMode ?? null,
          ignoreKnowledgeMode: !!input.ignoreKnowledgeMode,
          skipSystemPrompt: !!input.skipSystemPrompt,
          screenReadRequest: isExplicitScreenReadRequest(input.userQuery),
          ...ocrSnapshot,
        },
      });

      if (entryId && input.status === 'error') {
        publishChatDebugIssue({
          id: entryId,
          surface: input.surface,
          surfaceLabel: surfaceLabelForChatDebug(input.surface),
          status: input.status,
          timestamp: input.timestamp,
          userQuery: input.userQuery,
          aiResponse: input.aiResponse ?? '',
          error: input.error ?? null,
          provider: modelState.provider,
          modelId: modelState.modelId,
        });
      }
    } catch (error) {
      console.warn('[IPC] Failed to persist chat debug entry:', error);
    }
  };

  // --- NEW Test Helper ---
  safeHandle("test-release-fetch", async () => {
    try {
      console.log("[IPC] Manual Test Fetch triggered (forcing refresh)...");
      const { ReleaseNotesManager } = require('./update/ReleaseNotesManager');
      const notes = await ReleaseNotesManager.getInstance().fetchReleaseNotes('latest', true);

      if (notes) {
        console.log("[IPC] Notes fetched for:", notes.version);
        const info = {
          version: notes.version || 'latest',
          files: [] as any[],
          path: '',
          sha512: '',
          releaseName: notes.summary,
          releaseNotes: notes.fullBody,
          parsedNotes: notes
        };
        // Send to renderer
        appState.getMainWindow()?.webContents.send("update-available", info);
        return { success: true };
      }
      return { success: false, error: "No notes returned" };
    } catch (err: any) {
      console.error("[IPC] test-release-fetch failed:", err);
      return { success: false, error: err.message };
    }
  });

  safeHandle("license:activate", async (event, key: string) => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return await LicenseManager.getInstance().activateLicense(key);
    } catch (err: any) {
      // Only show generic message if the premium module itself is missing.
      // activateLicense() returns {success:false, error} for all expected failures
      // (bad key, network error, etc.) — it should never throw in normal operation.
      console.error('[IPC] license:activate unexpected error:', err);
      return { success: false, error: 'Premium features not available in this build.' };
    }
  });
  safeHandle("license:check-premium", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return LicenseManager.getInstance().isPremium();
    } catch {
      return false;
    }
  });
  // Async variant: performs Dodo server-side revocation check on startup.
  // Returns false only if the server definitively revokes the key.
  // Network errors fail-open (returns cached sync result).
  safeHandle("license:check-premium-async", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return await LicenseManager.getInstance().isPremiumAsync();
    } catch {
      return false;
    }
  });
  safeHandle("license:deactivate", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      // deactivate() is async — it calls the Dodo server to free the activation slot
      // before removing the local license file. Must be awaited.
      await LicenseManager.getInstance().deactivate();
      // Auto-disable knowledge mode when license is removed
      try {
        const orchestrator = appState.getKnowledgeOrchestrator();
        if (orchestrator) {
          orchestrator.setKnowledgeMode(false);
          console.log('[IPC] Knowledge mode auto-disabled due to license deactivation');
        }
      } catch (e) { /* ignore */ }
    } catch { /* LicenseManager not available */ }
    return { success: true };
  });
  safeHandle("license:get-hardware-id", async () => {
    try {
      const { LicenseManager } = require('../premium/electron/services/LicenseManager');
      return LicenseManager.getInstance().getHardwareId();
    } catch {
      return 'unavailable';
    }
  });

  safeHandle("get-recognition-languages", async () => {
    return RECOGNITION_LANGUAGES;
  });

  safeHandle("get-ai-response-languages", async () => {
    return AI_RESPONSE_LANGUAGES;
  });

  safeHandle("set-ai-response-language", async (_, language: string) => {
    // Validate: must be a non-empty string
    if (!language || typeof language !== 'string' || !language.trim()) {
      console.warn('[IPC] set-ai-response-language: invalid or empty language received, ignoring.');
      return { success: false, error: 'Invalid language value' };
    }
    const sanitizedLanguage = language.trim();
    const { CredentialsManager } = require('./services/CredentialsManager');
    // Persist to disk
    CredentialsManager.getInstance().setAiResponseLanguage(sanitizedLanguage);
    // Update live in-memory LLMHelper (same instance used by IntelligenceEngine)
    const llmHelper = appState.processingHelper?.getLLMHelper?.();
    if (llmHelper) {
      llmHelper.setAiResponseLanguage(sanitizedLanguage);
      console.log(`[IPC] AI response language updated to: ${sanitizedLanguage}`);
    } else {
      console.warn('[IPC] set-ai-response-language: processingHelper or LLMHelper not ready, language saved to disk only.');
    }
    return { success: true };
  });

  safeHandle("get-stt-language", async () => {
    const { CredentialsManager } = require('./services/CredentialsManager');
    return CredentialsManager.getInstance().getSttLanguage();
  });

  safeHandle("get-ai-response-language", async () => {
    const { CredentialsManager } = require('./services/CredentialsManager');
    return CredentialsManager.getInstance().getAiResponseLanguage();
  });
  safeHandle(
    "update-content-dimensions",
    async (event, { width, height }: { width: number; height: number }) => {
      if (!width || !height) return

      const senderWebContents = event.sender
      const settingsWin = appState.settingsWindowHelper.getSettingsWindow()
      const overlayWin = appState.getWindowHelper().getOverlayWindow()
      const launcherWin = appState.getWindowHelper().getLauncherWindow()

      if (settingsWin && !settingsWin.isDestroyed() && settingsWin.webContents.id === senderWebContents.id) {
        appState.settingsWindowHelper.setWindowDimensions(settingsWin, width, height)
      } else if (
        overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.id === senderWebContents.id
      ) {
        // NativelyInterface logic - Resize ONLY the overlay window using dedicated method
        appState.getWindowHelper().setOverlayDimensions(width, height)
      } else if (
        launcherWin && !launcherWin.isDestroyed() && launcherWin.webContents.id === senderWebContents.id
      ) {
        // EC-05 fix: launcher window resize events were previously silently ignored.
        // Log them so that if the launcher ever sends this IPC it's visible in logs.
        console.log(`[IPC] update-content-dimensions: launcher window resize request ${width}x${height} (ignored — launcher has fixed dimensions)`);
      }
    }
  )

  safeHandle("set-window-mode", async (event, mode: 'launcher' | 'overlay', inactive?: boolean) => {
    appState.getWindowHelper().setWindowMode(mode, inactive);
    return { success: true };
  })


  safeHandle("delete-screenshot", async (event, filePath: string) => {
    // Guard: only allow deletion of files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] delete-screenshot: path outside userData rejected:', filePath);
      return { success: false, error: 'Path not allowed' };
    }
    return appState.deleteScreenshot(resolved);
  })

  safeHandle("take-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      // console.error("Error taking screenshot:", error)
      throw error
    }
  })

  safeHandle("take-context-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeContextScreenshot(false)
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      throw error
    }
  })

  safeHandle("take-selective-screenshot", async () => {
    try {
      const screenshotPath = await appState.takeSelectiveScreenshot()
      const preview = await appState.getImagePreview(screenshotPath)
      return { path: screenshotPath, preview }
    } catch (error) {
      // EC-04 fix: cast unknown error to Error before accessing .message
      if ((error as Error).message === "Selection cancelled") {
        return { cancelled: true }
      }
      throw error
    }
  })

  safeHandle("get-screenshots", async () => {
    // console.log({ view: appState.getView() })
    try {
      let previews = []
      if (appState.getView() === "queue") {
        previews = await Promise.all(
          appState.getScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      } else {
        previews = await Promise.all(
          appState.getExtraScreenshotQueue().map(async (path) => ({
            path,
            preview: await appState.getImagePreview(path)
          }))
        )
      }
      // previews.forEach((preview: any) => console.log(preview.path))
      return previews
    } catch (error) {
      // console.error("Error getting screenshots:", error)
      throw error
    }
  })

  safeHandle("get-display-layout", async () => {
    try {
      return screen
        .getAllDisplays()
        .map((display) => ({
          id: display.id,
          label: String(display.label || display.id),
          bounds: display.bounds,
          scaleFactor: display.scaleFactor,
          isPrimary: display.id === screen.getPrimaryDisplay().id,
        }))
        .sort((a, b) => {
          if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
          if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
          return a.id - b.id;
        })
    } catch (error) {
      console.error("[IPC] get-display-layout failed:", error)
      return []
    }
  })

  safeHandle("toggle-window", async () => {
    appState.toggleMainWindow()
  })

  safeHandle("show-window", async (event, inactive?: boolean) => {
    // Default show main window (Launcher usually)
    appState.showMainWindow(inactive)
  })

  safeHandle("hide-window", async () => {
    appState.hideMainWindow()
  })

  safeHandle("show-overlay", async () => {
    appState.getWindowHelper().showOverlay();
  })

  safeHandle("hide-overlay", async () => {
    appState.getWindowHelper().hideOverlay();
  })

  safeHandle("get-meeting-active", async () => {
    return appState.getIsMeetingActive();
  })

  safeHandle("reset-queues", async () => {
    try {
      appState.clearQueues()
      // console.log("Screenshot queues have been cleared.")
      return { success: true }
    } catch (error: any) {
      // console.error("Error resetting queues:", error)
      return { success: false, error: error.message }
    }
  })

  // Donation IPC Handlers
  safeHandle("get-donation-status", async () => {
    const { DonationManager } = require('./DonationManager');
    const manager = DonationManager.getInstance();
    return {
      shouldShow: manager.shouldShowToaster(),
      hasDonated: manager.getDonationState().hasDonated,
      lifetimeShows: manager.getDonationState().lifetimeShows
    };
  });

  safeHandle("mark-donation-toast-shown", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().markAsShown();
    return { success: true };
  });

  safeHandle("set-donation-complete", async () => {
    const { DonationManager } = require('./DonationManager');
    DonationManager.getInstance().setHasDonated(true);
    return { success: true };
  });


  // Generate suggestion from transcript - Natively-style text-only reasoning
  safeHandle("generate-suggestion", async (event, context: string, lastQuestion: string) => {
    try {
      const suggestion = await appState.processingHelper.getLLMHelper().generateSuggestion(context, lastQuestion)
      return { suggestion }
    } catch (error: any) {
      // console.error("Error generating suggestion:", error)
      throw error
    }
  })

  safeHandle("finalize-mic-stt", async () => {
    appState.finalizeMicSTT();
  });

  safeHandle("start-mic-stt", async () => {
    await appState.startManualVoiceCapture();
    return { success: true };
  });

  safeHandle("stop-mic-stt", async () => {
    appState.stopManualVoiceCapture();
    return { success: true };
  });

  // IPC handler for analyzing image from file path
  safeHandle("analyze-image-file", async (event, filePath: string) => {
    // Guard: only allow reading files within the app's own userData directory
    const userDataDir = app.getPath('userData');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(userDataDir + path.sep)) {
      console.warn('[IPC] analyze-image-file: path outside userData rejected:', filePath);
      throw new Error('Path not allowed');
    }
    try {
      const result = await appState.processingHelper.getLLMHelper().analyzeImageFiles([resolved])
      return result
    } catch (error: any) {
      throw error
    }
  })

  safeHandle("gemini-chat", async (event, message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean }) => {
    try {
      const result = await appState.processingHelper.getLLMHelper().chatWithGemini(message, imagePaths, context, options?.skipSystemPrompt);

      console.log(`[IPC] gemini - chat response: `, result ? result.substring(0, 50) : "(empty)");

      // Don't process empty responses
      if (!result || result.trim().length === 0) {
        console.warn("[IPC] Empty response from LLM, not updating IntelligenceManager");
        return "I apologize, but I couldn't generate a response. Please try again.";
      }

      // Sync with IntelligenceManager so Follow-Up/Recap work
      const intelligenceManager = appState.getIntelligenceManager();

      // 1. Add user question to context (as 'user')
      // CRITICAL: Skip refinement check to prevent auto-triggering follow-up logic
      // The user's manual question is a NEW input, not a refinement of previous answer.
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);
      ContextObservationStore.getInstance().recordInteraction({
        role: 'user',
        text: message,
        timestamp: Date.now(),
      });

      // 2. Add assistant response and set as last message
      console.log(`[IPC] Updating IntelligenceManager with assistant message...`);
      intelligenceManager.addAssistantMessage(result);
      console.log(`[IPC] Updated IntelligenceManager.Last message: `, intelligenceManager.getLastAssistantMessage()?.substring(0, 50));

      // Log Usage
      await intelligenceManager.logUsage('chat', message, result);

      return result;
    } catch (error: any) {
      // console.error("Error in gemini-chat handler:", error);
      throw error;
    }
  });

  // Streaming IPC Handler
  // Monotonic stream IDs scoped PER SURFACE: a new request supersedes only
  // in-flight streams on the SAME surface. The previous single global slot
  // meant a widget/proactive request silently froze the meeting overlay's
  // answer mid-sentence with no terminal event. Superseded streams now always
  // emit 'gemini-stream-superseded' so renderers can release their listeners.
  const _chatStreamIds = new Map<string, number>();

  safeHandle("gemini-chat-stream", async (event, message: string, imagePaths?: string[], context?: string, options?: { skipSystemPrompt?: boolean, ignoreKnowledgeMode?: boolean, surface?: ChatDebugSurface }) => {
    const startedAt = Date.now();
    const surface = options?.surface || 'widget';
    const modelState = getChatDebugModelState();
    let firstTokenAt: number | null = null;
    let fullResponse = "";
    try {
      console.log("[IPC] gemini-chat-stream started using LLMHelper.streamChat");
      const llmHelper = appState.processingHelper.getLLMHelper();

      // Claim a new stream ID for this surface — any prior stream on the same
      // surface will detect this and stop emitting. Other surfaces' streams
      // are unaffected.
      const myStreamId = (_chatStreamIds.get(surface) || 0) + 1;
      _chatStreamIds.set(surface, myStreamId);
      const isSuperseded = () => (_chatStreamIds.get(surface) || 0) !== myStreamId;

      // Update IntelligenceManager with USER message immediately
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.addTranscript({
        text: message,
        speaker: 'user',
        timestamp: Date.now(),
        final: true
      }, true);
      ContextObservationStore.getInstance().recordInteraction({
        role: 'user',
        text: message,
        timestamp: Date.now(),
      });

      // Action-card interception for the inline widget.
      // If the user is asking for an Outlook / Teams / calendar action, return a
      // structured proposal instead of freeform chat text so the renderer can
      // show an embedded sendable card.
      // Gated to the widget surface: it is the only surface that renders
      // InlineActionProposalCard. On other surfaces (meeting/global overlay)
      // the JSON payload broke chat, and the serial planner LLM call added
      // seconds of pre-stream latency to any message containing words like
      // 'meeting'/'schedule'/'send' — which is most live-meeting queries.
      if (surface === 'widget' && !imagePaths?.length) {
        try {
          const { AgentActionPlanner } = require('./services/AgentActionPlanner');
          const proposal = await AgentActionPlanner.getInstance().maybeBuildProposal(message, llmHelper);
          if (proposal) {
            const payload = JSON.stringify({ __actionProposal: proposal });
            event.sender.send("gemini-stream-token", payload);
            event.sender.send("gemini-stream-done");
            intelligenceManager.addAssistantMessage(`[Action proposal prepared: ${proposal.kind}]`);
            await intelligenceManager.logUsage('chat', message, `[Action proposal prepared: ${proposal.kind}]`);
            ContextObservationStore.getInstance().recordInteraction({
              role: 'assistant',
              text: `[Action proposal prepared: ${proposal.kind}]`,
              timestamp: Date.now(),
            });
            saveChatDebugEntry({
              surface,
              status: 'proposal',
              modelState,
              timestamp: startedAt,
              userQuery: message,
              aiResponse: `[Action proposal prepared: ${proposal.kind}]`,
              imagePaths,
              completedAt: Date.now(),
              proposalKind: proposal.kind,
              contextLength: context?.length || 0,
              ignoreKnowledgeMode: options?.ignoreKnowledgeMode,
              skipSystemPrompt: options?.skipSystemPrompt,
            });
            return null;
          }
        } catch (proposalError: any) {
          console.warn("[IPC] Action proposal planning failed, falling back to text chat:", proposalError?.message || proposalError);
        }
      }

      // Always merge in recent live context. Renderer chat history is useful, but
      // it should not suppress the rolling live session buffer.
      try {
        const autoContext = intelligenceManager.getFormattedContext(100);
        if (autoContext && autoContext.trim().length > 0) {
          if (!context || !context.includes(autoContext)) {
            context = context?.trim()
              ? `${context}\n\nLIVE SESSION CONTEXT:\n${autoContext}`
              : autoContext;
          }
          console.log(`[IPC] Merged live context into gemini-chat-stream (${autoContext.length} chars)`);
        }
      } catch (ctxErr) {
        console.warn("[IPC] Failed to merge live context:", ctxErr);
      }

      try {
        // USE streamChat which handles routing
        const stream = llmHelper.streamChat(message, imagePaths, context, options?.skipSystemPrompt ? "" : undefined, options?.ignoreKnowledgeMode);

        for await (const token of stream) {
          // Bail if a newer stream on this surface has taken over
          if (isSuperseded()) {
            console.log(`[IPC] gemini-chat-stream ${myStreamId} (${surface}) superseded by ${_chatStreamIds.get(surface)}, stopping.`);
            // ALWAYS emit a terminal event so the renderer can release its
            // per-request listeners (previously they leaked forever and bled
            // future tokens into old message bubbles).
            event.sender.send("gemini-stream-superseded", surface);
            saveChatDebugEntry({
              surface,
              status: 'superseded',
              modelState,
              timestamp: startedAt,
              userQuery: message,
              aiResponse: fullResponse,
              imagePaths,
              firstTokenAt,
              completedAt: Date.now(),
              contextLength: context?.length || 0,
              ignoreKnowledgeMode: options?.ignoreKnowledgeMode,
              skipSystemPrompt: options?.skipSystemPrompt,
            });
            return null;
          }
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
          }
          event.sender.send("gemini-stream-token", token);
          fullResponse += token;
        }

        // Final check: only send done if we are still the active stream
        if (!isSuperseded()) {
          event.sender.send("gemini-stream-done");

          // Update IntelligenceManager with ASSISTANT message after completion
          if (fullResponse.trim().length > 0) {
            intelligenceManager.addAssistantMessage(fullResponse);
            // Log Usage for streaming chat
            await intelligenceManager.logUsage('chat', message, fullResponse);
          }

          saveChatDebugEntry({
            surface,
            status: 'completed',
            modelState,
            timestamp: startedAt,
            userQuery: message,
            aiResponse: fullResponse,
            imagePaths,
            firstTokenAt,
            completedAt: Date.now(),
            contextLength: context?.length || 0,
            ignoreKnowledgeMode: options?.ignoreKnowledgeMode,
            skipSystemPrompt: options?.skipSystemPrompt,
          });
        } else {
          // Completed after being superseded — still emit the terminal event.
          event.sender.send("gemini-stream-superseded", surface);
        }

      } catch (streamError: any) {
        console.error("[IPC] Streaming error:", streamError);
        const sanitizedError = sanitizeErrorMessage(streamError.message || "Unknown streaming error");
        if (!isSuperseded()) {
          event.sender.send("gemini-stream-error", sanitizedError);
        } else {
          event.sender.send("gemini-stream-superseded", surface);
        }
        saveChatDebugEntry({
          surface,
          status: 'error',
          modelState,
          timestamp: startedAt,
          userQuery: message,
          aiResponse: fullResponse,
          imagePaths,
          firstTokenAt,
          completedAt: Date.now(),
          error: sanitizedError,
          contextLength: context?.length || 0,
          ignoreKnowledgeMode: options?.ignoreKnowledgeMode,
          skipSystemPrompt: options?.skipSystemPrompt,
        });
      }

      return null; // Return null as data is sent via events

    } catch (error: any) {
      console.error("[IPC] Error in gemini-chat-stream setup:", error);
      saveChatDebugEntry({
        surface,
        status: 'error',
        modelState,
        timestamp: startedAt,
        userQuery: message,
        aiResponse: fullResponse,
        imagePaths,
        firstTokenAt,
        completedAt: Date.now(),
        error: sanitizeErrorMessage(error?.message || "Unknown setup error"),
        contextLength: context?.length || 0,
        ignoreKnowledgeMode: options?.ignoreKnowledgeMode,
        skipSystemPrompt: options?.skipSystemPrompt,
      });
      throw error;
    }
  });



  safeHandle("quit-app", () => {
    app.quit()
  })

  safeHandle("quit-and-install-update", async () => {
    try {
      console.log('[IPC] Quit and install update requested')
      await appState.quitAndInstallUpdate()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] quit-and-install-update failed:', err)
      return { success: false, error: err.message }
    }
  })

  safeHandle("delete-meeting", async (_, id: string) => {
    return DatabaseManager.getInstance().deleteMeeting(id);
  });

  safeHandle("check-for-updates", async () => {
    try {
      console.log('[IPC] Manual update check requested')
      await appState.checkForUpdates()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] check-for-updates failed:', err)
      return { success: false, error: err.message }
    }
  })

  safeHandle("download-update", async () => {
    try {
      console.log('[IPC] Download update requested')
      appState.downloadUpdate()
      return { success: true }
    } catch (err: any) {
      console.error('[IPC] download-update failed:', err)
      return { success: false, error: err.message }
    }
  })

  // Window movement handlers
  safeHandle("move-window-left", async () => {
    appState.moveWindowLeft()
  })

  safeHandle("move-window-right", async () => {
    appState.moveWindowRight()
  })

  safeHandle("move-window-up", async () => {
    appState.moveWindowUp()
  })

  safeHandle("move-window-down", async () => {
    appState.moveWindowDown()
  })

  safeHandle("center-and-show-window", async () => {
    appState.centerAndShowWindow()
  })

  // Window Controls
  safeHandle("window-minimize", async () => {
    appState.getWindowHelper().minimizeWindow();
  });

  safeHandle("window-maximize", async () => {
    appState.getWindowHelper().maximizeWindow();
  });

  safeHandle("window-close", async () => {
    appState.getWindowHelper().closeWindow();
  });

  safeHandle("window-is-maximized", async () => {
    return appState.getWindowHelper().isMainWindowMaximized();
  });

  // Settings Window
  safeHandle("toggle-settings-window", (event, { x, y } = {}) => {
    appState.settingsWindowHelper.toggleWindow(x, y)
  })

  safeHandle("close-settings-window", () => {
    appState.settingsWindowHelper.closeWindow()
  })

  safeHandle("open-chat-log-viewer", () => {
    appState.chatLogViewerWindowHelper.showWindow()
    return { success: true }
  })

  safeHandle("close-chat-log-viewer", () => {
    appState.chatLogViewerWindowHelper.closeWindow()
    return { success: true }
  })



  safeHandle("set-undetectable", async (_, state: boolean) => {
    appState.setUndetectable(state)
    return { success: true }
  })

  safeHandle("set-disguise", async (_, mode: 'terminal' | 'settings' | 'activity' | 'none') => {
    appState.setDisguise(mode)
    return { success: true }
  })

  safeHandle("get-undetectable", async () => {
    return appState.getUndetectable()
  })

  safeHandle("get-proactive-mode", async () => {
    return appState.getProactiveModeEnabled()
  })

  safeHandle("set-proactive-mode", async (_, enabled: boolean) => {
    appState.setProactiveModeEnabled(!!enabled)
    return { success: true }
  })

  // Adapted from public PR #113 — verify premium interaction
  safeHandle("set-overlay-mouse-passthrough", async (_, enabled: boolean) => {
    appState.setOverlayMousePassthrough(enabled)
    return { success: true }
  })

  safeHandle("toggle-overlay-mouse-passthrough", async () => {
    const enabled = appState.toggleOverlayMousePassthrough()
    return { success: true, enabled }
  })

  safeHandle("get-overlay-mouse-passthrough", async () => {
    return appState.getOverlayMousePassthrough()
  })

  safeHandle("get-disguise", async () => {
    return appState.getDisguise()
  })

  safeHandle("set-open-at-login", async (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      path: app.getPath('exe') // Explicitly point to executable for production reliability
    });
    return { success: true };
  });

  safeHandle("get-open-at-login", async () => {
    const settings = app.getLoginItemSettings();
    return settings.openAtLogin;
  });

  safeHandle("get-verbose-logging", async () => {
    return appState.getVerboseLogging();
  });

  safeHandle("set-verbose-logging", async (_, enabled: boolean) => {
    appState.setVerboseLogging(enabled);
    return { success: true };
  });

  safeHandle("get-arch", async () => {
    return process.arch;
  });

  // LLM Model Management Handlers
  safeHandle("get-current-llm-config", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return {
        provider: llmHelper.getCurrentProvider(),
        model: llmHelper.getCurrentModel(),
        isOllama: llmHelper.isUsingOllama(),
        reasoningEffort: llmHelper.getReasoningEffort?.() ?? 'xhigh',
      };
    } catch (error: any) {
      // console.error("Error getting current LLM config:", error);
      throw error;
    }
  });

  safeHandle("set-natively-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const prevSttProvider = cm.getSttProvider();
      cm.setNativelyApiKey(apiKey);

      // Update LLMHelper immediately (same pattern as other provider keys)
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setNativelyKey(apiKey || null);

      // Sync the model into LLMHelper and notify the UI whenever the effective default changed
      const defaultModel = cm.getDefaultModel();
      llmHelper.setModel(defaultModel);
      const effectiveModelId = llmHelper.getCurrentModel();
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-changed', effectiveModelId);
      });

      // If setNativelyApiKey auto-promoted the STT provider to 'natively', reconfigure
      // the audio pipeline immediately — without this, the in-memory pipeline still uses
      // the old STT provider (e.g. Google) until the app restarts.
      const newSttProvider = cm.getSttProvider();
      if (newSttProvider !== prevSttProvider) {
        console.log(`[IPC] set-natively-api-key: STT provider changed ${prevSttProvider} → ${newSttProvider}, reconfiguring pipeline`);
        await appState.reconfigureSttProvider();
      }

      return { success: true };
    } catch (error: any) {
      console.error("Error saving Natively API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-natively-usage", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const key = CredentialsManager.getInstance().getNativelyApiKey();
      if (!key) return { ok: false, error: 'no_key' };

      const res = await fetch('https://api.natively.software/v1/usage', {
        headers: { 'x-natively-key': key },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any;
        return { ok: false, error: body.error || 'request_failed', status: res.status };
      }
      const data = await res.json() as any;
      return { ok: true, ...data };
    } catch (error: any) {
      return { ok: false, error: error.message || 'network_error' };
    }
  });

  // Get stored API keys (masked for UI display)
  safeHandle("get-stored-credentials", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const creds = CredentialsManager.getInstance().getAllCredentials();

      // Return masked versions for security (just indicate if set)
      const hasKey = (key?: string) => !!(key && key.trim().length > 0);

      return {
        hasNativelyKey: hasKey(creds.nativelyApiKey),
        googleServiceAccountPath: creds.googleServiceAccountPath || null,
        sttProvider: CredentialsManager.getInstance().getSttProvider(),
        groqSttModel: creds.groqSttModel || 'whisper-large-v3-turbo',
        hasSttGroqKey: hasKey(creds.groqSttApiKey),
        hasSttOpenaiKey: hasKey(creds.openAiSttApiKey),
        hasDeepgramKey: hasKey(creds.deepgramApiKey),
        hasElevenLabsKey: hasKey(creds.elevenLabsApiKey),
        hasAzureKey: hasKey(creds.azureApiKey),
        azureRegion: creds.azureRegion || 'eastus',
        hasIbmWatsonKey: hasKey(creds.ibmWatsonApiKey),
        ibmWatsonRegion: creds.ibmWatsonRegion || 'us-south',
        hasSonioxKey: hasKey(creds.sonioxApiKey),
        // STT key values — returned so the settings UI can pre-populate input fields.
        // AI model keys (Gemini/Groq/OpenAI/Claude) remain boolean-only; STT keys are
        // surfaced here because users need to see which key is active when switching providers.
        sttGroqKey: creds.groqSttApiKey || '',
        sttOpenaiKey: creds.openAiSttApiKey || '',
        sttDeepgramKey: creds.deepgramApiKey || '',
        sttElevenLabsKey: creds.elevenLabsApiKey || '',
        sttAzureKey: creds.azureApiKey || '',
        sttIbmKey: creds.ibmWatsonApiKey || '',
        sttSonioxKey: creds.sonioxApiKey || '',
        hasTavilyKey: hasKey(creds.tavilyApiKey),
        hasClaudeMax: isLocalCliAvailable('claude', true),
        claudeMaxStatus: getLocalCliStatus('claude', true).state,
        hasCodex: isLocalCliAvailable('codex', true),
      };
    } catch (error: any) {
      return { hasNativelyKey: false, hasClaudeMax: false, claudeMaxStatus: 'missing', hasCodex: false, googleServiceAccountPath: null, sttProvider: 'google', groqSttModel: 'whisper-large-v3-turbo', hasSttGroqKey: false, hasSttOpenaiKey: false, hasDeepgramKey: false, hasElevenLabsKey: false, hasAzureKey: false, azureRegion: 'eastus', hasIbmWatsonKey: false, ibmWatsonRegion: 'us-south', hasSonioxKey: false, hasTavilyKey: false, sttGroqKey: '', sttOpenaiKey: '', sttDeepgramKey: '', sttElevenLabsKey: '', sttAzureKey: '', sttIbmKey: '', sttSonioxKey: '' };
    }
  });

  // ==========================================
  // STT Provider Management Handlers
  // ==========================================

  const reconfigureIfActiveSttProvider = async (
    provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively'
  ) => {
    const { CredentialsManager } = require('./services/CredentialsManager');
    const activeProvider = CredentialsManager.getInstance().getSttProvider();
    if (activeProvider === provider) {
      console.log(`[IPC] ${provider} STT credentials changed; rebuilding active STT pipeline`);
      await appState.reconfigureSttProvider();
    }
  };

  safeHandle("set-stt-provider", async (_, provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively') => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSttProvider(provider);

      // Reconfigure the audio pipeline to use the new STT provider
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting STT provider:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-stt-provider", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      return CredentialsManager.getInstance().getSttProvider();
    } catch (error: any) {
      return 'google';
    }
  });

  safeHandle("set-groq-stt-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttApiKey(apiKey);
      await reconfigureIfActiveSttProvider('groq');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Groq STT API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-openai-stt-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setOpenAiSttApiKey(apiKey);
      await reconfigureIfActiveSttProvider('openai');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving OpenAI STT API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-deepgram-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setDeepgramApiKey(apiKey);
      await reconfigureIfActiveSttProvider('deepgram');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Deepgram API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-groq-stt-model", async (_, model: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGroqSttModel(model);

      // Reconfigure the audio pipeline to use the new model
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Groq STT model:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-elevenlabs-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setElevenLabsApiKey(apiKey);
      await reconfigureIfActiveSttProvider('elevenlabs');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving ElevenLabs API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-azure-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureApiKey(apiKey);
      await reconfigureIfActiveSttProvider('azure');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Azure API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-azure-region", async (_, region: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setAzureRegion(region);

      // Reconfigure the pipeline since region changes the endpoint URL
      await appState.reconfigureSttProvider();

      return { success: true };
    } catch (error: any) {
      console.error("Error setting Azure region:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-ibmwatson-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setIbmWatsonApiKey(apiKey);
      await reconfigureIfActiveSttProvider('ibmwatson');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving IBM Watson API key:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("set-soniox-api-key", async (_, apiKey: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setSonioxApiKey(apiKey);
      await reconfigureIfActiveSttProvider('soniox');
      return { success: true };
    } catch (error: any) {
      console.error("Error saving Soniox API key:", error);
      return { success: false, error: error.message };
    }
  });

  // Helper to sanitize error messages (remove API key references)
  const sanitizeErrorMessage = (msg: string): string => {
    const cleaned = msg.replace(/:\s*[a-zA-Z0-9*]+\*+[a-zA-Z0-9*]+\.?$/g, '').trim();
    const lower = cleaned.toLowerCase();

    if (lower.includes("spawn codex enonent") || lower.includes("codex cli not found")) {
      return "Codex local session is unavailable. Reopen Codex on this machine and try again.";
    }
    if (lower.includes("spawn claude enonent") || lower.includes("claude cli not found")) {
      return "Claude local session is unavailable. Reopen Claude on this machine and try again.";
    }
    if (lower.includes("not logged in") || lower.includes("/login") || lower.includes("authentication_failed")) {
      return "Claude local session is installed but not logged in. Open Claude Code, run /login, then reopen Natively.";
    }
    if (lower.includes("rate_limit_error") || lower.includes("429") || lower.includes("rate limit")) {
      return "The selected model is temporarily rate limited. Wait a minute and try again.";
    }

    return cleaned;
  };

  const beginClaudeAuthLogin = async (): Promise<{ launched: boolean; alreadyLoggedIn?: boolean }> => {
    if (!isLocalCliAvailable("claude", true)) {
      throw new Error("Claude local session is unavailable. Reopen Claude on this machine and try again.");
    }

    const statusInvocation = buildLocalCliInvocation("claude", ["auth", "status"]);
    const statusResult = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(statusInvocation.command, statusInvocation.args, {
        cwd: process.cwd(),
        env: buildClaudeCliEnv(process.env),
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout, stderr, code }));
    });

    try {
      const parsed = JSON.parse(statusResult.stdout || "{}");
      if (parsed?.loggedIn) {
        return { launched: false, alreadyLoggedIn: true };
      }
    } catch {
      // Fall through to login attempt if status output is malformed.
    }

    const loginInvocation = buildLocalCliInvocation("claude", ["auth", "login", "--claudeai"]);
    const child = spawn(loginInvocation.command, loginInvocation.args, {
      cwd: process.cwd(),
      env: buildClaudeCliEnv(process.env),
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return { launched: true };
  };

  safeHandle("test-stt-connection", async (_, provider: 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox', apiKey: string, region?: string) => {
    console.log(`[IPC] Received test - stt - connection request for provider: ${provider} `);
    try {
      if (provider === 'deepgram') {
        // Test Deepgram via WebSocket connection
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1';
          const ws = new WebSocket(url, {
            headers: { Authorization: `Token ${apiKey} ` },
          });

          const timeout = setTimeout(() => {
            ws.close();
            resolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            clearTimeout(timeout);
            try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { }
            ws.close();
            resolve({ success: true });
          });

          ws.on('error', (err: any) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      if (provider === 'soniox') {
        // Test Soniox via WebSocket connection
        const WebSocket = require('ws');
        return await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');

          const timeout = setTimeout(() => {
            ws.close();
            resolve({ success: false, error: 'Connection timed out' });
          }, 15000);

          ws.on('open', () => {
            // Send a minimal config to validate the API key
            ws.send(JSON.stringify({
              api_key: apiKey,
              model: 'stt-rt-v4',
              audio_format: 'pcm_s16le',
              sample_rate: 16000,
              num_channels: 1,
            }));
          });

          ws.on('message', (msg: any) => {
            clearTimeout(timeout);
            try {
              const res = JSON.parse(msg.toString());
              if (res.error_code) {
                resolve({ success: false, error: `${res.error_code}: ${res.error_message}` });
              } else {
                resolve({ success: true });
              }
            } catch {
              resolve({ success: true });
            }
            ws.close();
          });

          ws.on('error', (err: any) => {
            clearTimeout(timeout);
            resolve({ success: false, error: err.message || 'Connection failed' });
          });
        });
      }

      const axios = require('axios');
      const FormData = require('form-data');

      // Generate a tiny silent WAV (0.5s of silence at 16kHz mono 16-bit)
      const numSamples = 8000;
      const pcmData = Buffer.alloc(numSamples * 2);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(1, 22);
      wavHeader.writeUInt32LE(16000, 24);
      wavHeader.writeUInt32LE(32000, 28);
      wavHeader.writeUInt16LE(2, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);
      const testWav = Buffer.concat([wavHeader, pcmData]);

      if (provider === 'elevenlabs') {
        // ElevenLabs: Use /v1/voices to validate the API key (minimal scope required).
        // Scoped keys may lack speech_to_text or user_read but still be usable once permissions are added.
        try {
          await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey },
            timeout: 10000,
          });
        } catch (elErr: any) {
          const elStatus = elErr?.response?.data?.detail?.status;
          // If the error is "invalid_api_key", the key itself is wrong — fail.
          // Any other error (missing permission, etc.) means the key IS valid, just possibly scoped.
          if (elStatus === 'invalid_api_key') {
            throw elErr;
          }
          // Key is valid but scoped — pass with a warning
          console.log('[IPC] ElevenLabs key is valid but may have restricted scopes. Saving key.');
        }
      } else if (provider === 'azure') {
        // Azure: raw binary with subscription key
        const azureRegion = region || 'eastus';
        await axios.post(
          `https://${azureRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
          testWav,
          {
            headers: { 'Ocp-Apim-Subscription-Key': apiKey, 'Content-Type': 'audio/wav' },
            timeout: 15000,
          }
        );
      } else if (provider === 'ibmwatson') {
        // IBM Watson: raw binary with Basic auth
        const ibmRegion = region || 'us-south';
        await axios.post(
          `https://api.${ibmRegion}.speech-to-text.watson.cloud.ibm.com/v1/recognize`,
          testWav,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`apikey:${apiKey}`).toString('base64')}`,
              'Content-Type': 'audio/wav',
            },
            timeout: 15000,
          }
        );
      } else {
        // Groq / OpenAI: multipart FormData
        const endpoint = provider === 'groq'
          ? 'https://api.groq.com/openai/v1/audio/transcriptions'
          : 'https://api.openai.com/v1/audio/transcriptions';
        const model = provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';

        const form = new FormData();
        form.append('file', testWav, { filename: 'test.wav', contentType: 'audio/wav' });
        form.append('model', model);

        await axios.post(endpoint, form, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...form.getHeaders(),
          },
          timeout: 15000,
        });
      }

      return { success: true };
    } catch (error: any) {
      const respData = error?.response?.data;
      const rawMsg = respData?.error?.message || respData?.detail?.message || respData?.message || error.message || 'Connection failed';
      const msg = sanitizeErrorMessage(rawMsg);
      console.error("STT connection test failed:", msg);
      return { success: false, error: msg };
    }
  });

  safeHandle("set-model", async (_, modelId: string) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setModel(modelId);
      const effectiveModelId = llmHelper.getCurrentModel();

      // Close the selector window if open
      appState.modelSelectorWindowHelper.hideWindow();

      // Broadcast to all windows so NativelyInterface can update its selector (session-only update)
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', effectiveModelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting model:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-reasoning-effort", async () => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return { effort: llmHelper.getReasoningEffort?.() ?? 'xhigh' };
    } catch (error: any) {
      console.error("Error getting reasoning effort:", error);
      return { effort: 'xhigh' };
    }
  });

  safeHandle("set-reasoning-effort", async (_, effort: 'low' | 'medium' | 'high' | 'xhigh') => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setReasoningEffort(effort);

      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setReasoningEffort(effort);

      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('reasoning-effort-changed', effort);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting reasoning effort:", error);
      return { success: false, error: error.message };
    }
  });

  // ── Meeting AI: IP Corp Mode ───────────────────────────────────────────────
  safeHandle("set-ip-corp-mode", async (_, enabled: boolean) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setIPCorpMode(enabled);
      if (enabled) {
        const { warmIPCorpContextCache } = require('./services/IPCorpContextBuilder');
        const health = await warmIPCorpContextCache();
        return { success: true, warning: health.warning ?? undefined };
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Meeting AI: Continuous OCR ─────────────────────────────────────────────
  safeHandle("set-continuous-ocr", async (_, enabled: boolean) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      if (enabled) {
        llmHelper.startContinuousOCR();
      } else {
        llmHelper.stopContinuousOCR();
      }
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Meeting AI: Reload knowledge + transcripts ────────────────────────────
  safeHandle("reload-meeting-memory", async () => {
    try {
      const { MeetingMemoryBrain } = require('./services/MeetingMemoryBrain');
      await MeetingMemoryBrain.getInstance().reload();
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  // ── Meeting AI: Status ─────────────────────────────────────────────────────
  safeHandle("get-meeting-ai-status", async () => {
    try {
      const { ContinuousOCRService } = require('./services/ContinuousOCRService');
      const { getIPCorpContextHealth } = require('./services/IPCorpContextBuilder');
      const ipCorpHealth = getIPCorpContextHealth();
      const claudeStatus = getLocalCliStatus('claude', true);
      return {
        claudeMaxAvailable: claudeStatus.state === 'ready',
        claudeMaxStatus: claudeStatus.state,
        ocrRunning: ContinuousOCRService.getInstance().isRunning(),
        ipCorpMode: appState.processingHelper.getLLMHelper().getIPCorpMode?.() ?? false,
        clawmemAvailable: ipCorpHealth.clawmemAvailable,
        nexusAvailable: ipCorpHealth.nexusAvailable,
        ipCorpWarning: ipCorpHealth.warning,
      };
    } catch (e: any) {
      return { claudeMaxAvailable: false, claudeMaxStatus: 'missing', ocrRunning: false, ipCorpMode: false, clawmemAvailable: false, nexusAvailable: false, ipCorpWarning: 'Unable to read Meeting AI status' };
    }
  });

  // Persist default model (from Settings) + update runtime + broadcast to all windows
  safeHandle("set-default-model", async (_, modelId: string) => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      cm.setDefaultModel(modelId);

      // Also update the runtime model
      const llmHelper = appState.processingHelper.getLLMHelper();
      llmHelper.setModel(modelId);
      const effectiveModelId = llmHelper.getCurrentModel();

      // Close the selector window if open
      appState.modelSelectorWindowHelper.hideWindow();

      // Broadcast to all windows so NativelyInterface can update its selector
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-changed', effectiveModelId);
        }
      });

      return { success: true };
    } catch (error: any) {
      console.error("Error setting default model:", error);
      return { success: false, error: error.message };
    }
  });

  // Read the persisted default model
  safeHandle("get-default-model", async () => {
    try {
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      return { model: cm.getDefaultModel() };
    } catch (error: any) {
      console.error("Error getting default model:", error);
      return { model: 'gemini-3.1-flash-lite-preview' };
    }
  });

  // --- Model Selector Window IPC ---

  safeHandle("show-model-selector", (_, coords: { x: number; y: number }) => {
    appState.modelSelectorWindowHelper.showWindow(coords.x, coords.y);
  });

  safeHandle("hide-model-selector", () => {
    appState.modelSelectorWindowHelper.hideWindow();
  });

  safeHandle("toggle-model-selector", (_, coords: { x: number; y: number }) => {
    appState.modelSelectorWindowHelper.toggleWindow(coords.x, coords.y);
  });



  // Native Audio Service Handlers
  safeHandle("native-audio-status", async () => {
    return appState.getNativeAudioRuntimeStatus();
  });

  safeHandle("meeting-readiness:get-status", async () => {
    return appState.getMeetingReadinessStatus();
  });

  safeHandle("meeting-speaker-labels:get", async () => {
    return appState.getMeetingSpeakerLabels();
  });

  safeHandle("meeting-speaker-labels:set", async (_, speakerKey: string, label: string) => {
    return appState.setMeetingSpeakerLabel(speakerKey, label);
  });

  safeHandle("user-profile:get", async () => {
    return { userDisplayName: appState.getUserDisplayName() };
  });

  safeHandle("user-profile:set-name", async (_, name: string) => {
    return appState.setUserDisplayName(name);
  });

  safeHandle("get-input-devices", async () => {
    return AudioDevices.getInputDevices();
  });

  safeHandle("get-output-devices", async () => {
    return AudioDevices.getOutputDevices();
  });

  safeHandle("start-audio-test", async (event, deviceId?: string) => {
    await appState.startAudioTest(deviceId);
    return { success: true };
  });

  safeHandle("stop-audio-test", async () => {
    appState.stopAudioTest();
    return { success: true };
  });

  safeHandle("set-recognition-language", async (_, key: string) => {
    appState.setRecognitionLanguage(key);
    return { success: true };
  });

  // ==========================================
  // Meeting Lifecycle Handlers
  // ==========================================

  safeHandle("start-meeting", async (event, metadata?: any) => {
    try {
      await appState.startMeeting(metadata);
      return { success: true };
    } catch (error: any) {
      console.error("Error starting meeting:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("end-meeting", async () => {
    try {
      await appState.endMeeting();
      return { success: true };
    } catch (error: any) {
      console.error("Error ending meeting:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("get-recent-meetings", async () => {
    const { BrainReadModelService } = require('./services/BrainReadModelService');
    const brainMeetings = BrainReadModelService.getInstance().getRecentMeetings(50);
    if (brainMeetings.length > 0) {
      return brainMeetings;
    }

    return DatabaseManager.getInstance().getRecentMeetings(50);
  });

  safeHandle("get-meeting-details", async (event, id) => {
    // Helper to fetch full details
    return DatabaseManager.getInstance().getMeetingDetails(id);
  });

  safeHandle("get-chat-debug-entries", async (_, limit?: number) => {
    return DatabaseManager.getInstance().getRecentChatDebugEntries(limit ?? 100);
  });

  safeHandle("update-meeting-title", async (_, { id, title }: { id: string; title: string }) => {
    return DatabaseManager.getInstance().updateMeetingTitle(id, title);
  });

  safeHandle("update-meeting-summary", async (_, { id, updates }: { id: string; updates: any }) => {
    return DatabaseManager.getInstance().updateMeetingSummary(id, updates);
  });

  const resolveWritableMeetingId = (meetingId: string): string | null => {
    const db = DatabaseManager.getInstance();
    if (db.getMeetingDetails(meetingId)) return meetingId;

    try {
      const { BrainReadModelService } = require("./services/BrainReadModelService");
      const brainRecord = BrainReadModelService.getInstance()
        .getRecentMeetings(1000)
        .find((meeting: any) => meeting?.id === meetingId);
      const sourceMeetingId = brainRecord?.importMetadata?.sourceMeetingId;
      if (sourceMeetingId && db.getMeetingDetails(sourceMeetingId)) {
        return sourceMeetingId;
      }
    } catch (error: any) {
      console.warn("[IPC] Failed to resolve writable meeting id:", error?.message || error);
    }

    return null;
  };

  safeHandle("add-meeting-context-note", async (_, input: { meetingId: string; text: string; source?: 'manual' | 'meeting_chat' }) => {
    const meetingId = String(input?.meetingId || "");
    const localMeetingId = resolveWritableMeetingId(meetingId);
    if (!localMeetingId) {
      throw new Error(`Meeting not found: ${meetingId}`);
    }

    const result = DatabaseManager.getInstance().addMeetingContextNote(
      localMeetingId,
      input.text,
      input.source || 'manual'
    );
    if (!result.success) {
      throw new Error(result.error || "Unable to save meeting context.");
    }

    return {
      success: true,
      requestedMeetingId: meetingId,
      meetingId: localMeetingId,
      note: result.note,
      meeting: result.meeting,
    };
  });

  safeHandle("generate-meeting-overview", async (_, { meetingId, force }: { meetingId: string; force?: boolean }) => {
    try {
      const { MeetingOverviewService } = require("./services/MeetingOverviewService");
      return await MeetingOverviewService.generate({
        meetingId,
        force,
        llmHelper: appState.processingHelper.getLLMHelper(),
        knowledgeOrchestrator: appState.getKnowledgeOrchestrator(),
      });
    } catch (error: any) {
      throw new Error(sanitizeErrorMessage(error?.message || "Unable to generate the meeting overview right now."));
    }
  });

  safeHandle("claude-auth-login", async () => {
    try {
      return {
        success: true,
        ...await beginClaudeAuthLogin(),
      };
    } catch (error: any) {
      return {
        success: false,
        error: sanitizeErrorMessage(error?.message || "Unable to start Claude sign-in."),
      };
    }
  });

  safeHandle("seed-demo", async () => {
    DatabaseManager.getInstance().seedDemoMeeting();

    // Ensure RAG embeddings exist for the demo meeting.
    // Use ensureDemoMeetingProcessed so we skip if already embedded
    // (avoids re-clearing 14 queue items on every app launch once processed).
    const ragManager = appState.getRAGManager();
    if (ragManager && ragManager.isReady()) {
      ragManager.ensureDemoMeetingProcessed().catch(console.error);
    }

    return { success: true };
  });

  safeHandle("flush-database", async () => {
    const result = DatabaseManager.getInstance().clearAllData();
    return { success: result };
  });

  safeHandle("open-external", async (event, url: string) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        await shell.openExternal(url);
      } else {
        console.warn(`[IPC] Blocked potentially unsafe open-external: ${url}`);
      }
    } catch {
      console.warn(`[IPC] Invalid URL in open-external: ${url}`);
    }
  });

  safeHandle("get-image-preview", async (_, filePath: string) => {
    try {
      if (!filePath || typeof filePath !== 'string' || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
        return null;
      }
      return await appState.getImagePreview(filePath);
    } catch (error) {
      console.warn('[IPC] get-image-preview failed:', error);
      return null;
    }
  });

  // ==========================================
  // Intelligence Mode Handlers
  // ==========================================

  // MODE 1: Assist (Passive observation)
  safeHandle("generate-assist", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const insight = await intelligenceManager.runAssistMode();
      return { insight };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 2: What Should I Say (Primary auto-answer)
  safeHandle("generate-what-to-say", async (_, question?: string, imagePaths?: string[], options?: { force?: boolean }) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      // Question and imagePaths are now optional - IntelligenceManager infers from transcript
      const answer = await intelligenceManager.runWhatShouldISay(question, 0.8, imagePaths, options);
      return { answer, question: question || 'inferred from context' };
    } catch (error: any) {
      // Return graceful fallback instead of throwing
      return {
        question: question || 'unknown'
      };
    }
  });

  safeHandle("generate-clarify", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const clarification = await intelligenceManager.runClarify();
      // If null returned without throwing, the engine already set mode to idle.
      // We must still ensure the frontend un-sticks — emit an error so onIntelligenceError fires.
      if (clarification === null) {
        broadcastIntelligenceError('Could not generate a clarifying question. Try again after some audio context is available.', 'clarify');
      }
      return { clarification };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-code-hint", async (_, imagePaths?: string[], problemStatement?: string) => {
    try {
      // If no explicit images were passed from the frontend, fall back to the
      // screenshot queue so the AI can always "see" the user's screen.
      const resolvedImagePaths: string[] =
        imagePaths && imagePaths.length > 0
          ? imagePaths
          : appState.getScreenshotQueue();

      console.log(`[IPC] generate-code-hint: using ${resolvedImagePaths.length} image(s) (${imagePaths?.length ? 'explicit' : 'queue fallback'})`);

      const intelligenceManager = appState.getIntelligenceManager();
      const hint = await intelligenceManager.runCodeHint(
        resolvedImagePaths.length > 0 ? resolvedImagePaths : undefined,
        problemStatement
      );
      return { hint };
    } catch (error: any) {
      throw error;
    }
  });

  safeHandle("generate-brainstorm", async (_, imagePaths?: string[], problemStatement?: string) => {
    try {
      // If no explicit images were passed from the frontend, fall back to the
      // screenshot queue so the AI can always "see" the user's screen.
      const resolvedImagePaths: string[] =
        imagePaths && imagePaths.length > 0
          ? imagePaths
          : appState.getScreenshotQueue();

      console.log(`[IPC] generate-brainstorm: using ${resolvedImagePaths.length} image(s) (${imagePaths?.length ? 'explicit' : 'queue fallback'})`);

      const intelligenceManager = appState.getIntelligenceManager();
      const script = await intelligenceManager.runBrainstorm(
        resolvedImagePaths.length > 0 ? resolvedImagePaths : undefined,
        problemStatement
      );
      return { script };
    } catch (error: any) {
      throw error;
    }
  });

  // Dynamic Action Button Mode (Recap vs Brainstorm)
  safeHandle("get-action-button-mode", () => {
    const { SettingsManager } = require('./services/SettingsManager');
    const sm = SettingsManager.getInstance();
    return sm.get('actionButtonMode') ?? 'recap';
  });

  safeHandle("set-action-button-mode", (_, mode: 'recap' | 'brainstorm') => {
    const { SettingsManager } = require('./services/SettingsManager');
    const sm = SettingsManager.getInstance();
    sm.set('actionButtonMode', mode);

    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('action-button-mode-changed', mode);
      }
    });

    return { success: true };
  });

  // MODE 3: Follow-Up (Refinement)
  safeHandle("generate-follow-up", async (_, intent: string, userRequest?: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const refined = await intelligenceManager.runFollowUp(intent, userRequest);
      return { refined, intent };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 4: Recap (Summary)
  safeHandle("generate-recap", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const summary = await intelligenceManager.runRecap();
      return { summary };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 6: Follow-Up Questions
  safeHandle("generate-follow-up-questions", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const questions = await intelligenceManager.runFollowUpQuestions();
      return { questions };
    } catch (error: any) {
      throw error;
    }
  });

  // MODE 5: Manual Answer (Fallback)
  safeHandle("submit-manual-question", async (_, question: string) => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      const answer = await intelligenceManager.runManualAnswer(question);
      return { answer, question };
    } catch (error: any) {
      throw error;
    }
  });

  // Get current intelligence context
  safeHandle("get-intelligence-context", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      return {
        context: intelligenceManager.getFormattedContext(),
        lastAssistantMessage: intelligenceManager.getLastAssistantMessage(),
        activeMode: intelligenceManager.getActiveMode()
      };
    } catch (error: any) {
      throw error;
    }
  });

  // Reset intelligence state
  safeHandle("reset-intelligence", async () => {
    try {
      const intelligenceManager = appState.getIntelligenceManager();
      intelligenceManager.reset();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });


  // Service Account Selection
  safeHandle("select-service-account", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
      }

      const filePath = result.filePaths[0];

      // Update backend state immediately
      appState.updateGoogleCredentials(filePath);

      // Persist the path for future sessions
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setGoogleServiceAccountPath(filePath);

      return { success: true, path: filePath };
    } catch (error: any) {
      console.error("Error selecting service account:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Theme System Handlers
  // ==========================================

  safeHandle("theme:get-mode", () => {
    const tm = appState.getThemeManager();
    return {
      mode: tm.getMode(),
      resolved: tm.getResolvedTheme()
    };
  });

  safeHandle("theme:set-mode", (_, mode: 'system' | 'light' | 'dark') => {
    appState.getThemeManager().setMode(mode);
    return { success: true };
  });

  // ==========================================
  // Calendar Integration Handlers
  // ==========================================

  safeHandle("calendar-connect", async () => {
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      await CalendarManager.getInstance().startAuthFlow();
      return { success: true };
    } catch (error: any) {
      console.error("Calendar auth error:", error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("calendar-disconnect", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().disconnect();
    return { success: true };
  });

  safeHandle("get-calendar-status", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    return CalendarManager.getInstance().getConnectionStatus();
  });

  safeHandle("get-upcoming-events", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    const { MeetingPrepService } = require('./services/MeetingPrepService');
    const events = await CalendarManager.getInstance().getUpcomingEvents();
    appState.rememberReadinessEvents(events);
    MeetingPrepService.getInstance()
      .warmPackets(events, appState.getKnowledgeOrchestrator())
      .catch((error: any) => {
        console.warn('[IPC] Meeting prep warm failed:', error?.message || error);
      });
    return events;
  });

  safeHandle("calendar-refresh", async () => {
    const { CalendarManager } = require('./services/CalendarManager');
    await CalendarManager.getInstance().refreshState();
    const { MeetingPrepService } = require('./services/MeetingPrepService');
    const events = await CalendarManager.getInstance().getUpcomingEvents();
    appState.rememberReadinessEvents(events);
    MeetingPrepService.getInstance()
      .warmPackets(events, appState.getKnowledgeOrchestrator())
      .catch((error: any) => {
        console.warn('[IPC] Meeting prep warm after refresh failed:', error?.message || error);
      });
    return { success: true };
  });

  safeHandle("get-meeting-prep-packet", async (_, eventId: string) => {
    try {
      const { MeetingPrepService } = require('./services/MeetingPrepService');
      return await MeetingPrepService.getInstance().buildPacket(eventId, appState.getKnowledgeOrchestrator());
    } catch (error: any) {
      console.error('[IPC] get-meeting-prep-packet failed:', error);
      return null;
    }
  });

  // ==========================================
  // Follow-up Email Handlers
  // ==========================================

  safeHandle("generate-followup-email", async (_, input: any) => {
    try {
      const { FOLLOWUP_EMAIL_PROMPT, GROQ_FOLLOWUP_EMAIL_PROMPT } = require('./llm/prompts');
      const { buildFollowUpEmailPromptInput } = require('./utils/emailUtils');

      const llmHelper = appState.processingHelper.getLLMHelper();

      // Build the context string from input
      const contextString = buildFollowUpEmailPromptInput(input);

      // Build prompts
      const geminiPrompt = `${FOLLOWUP_EMAIL_PROMPT}\n\nMEETING DETAILS:\n${contextString}`;
      const groqPrompt = `${GROQ_FOLLOWUP_EMAIL_PROMPT}\n\nMEETING DETAILS:\n${contextString}`;

      // Use chatWithGemini with alternateGroqMessage for fallback
      const emailBody = await llmHelper.chatWithGemini(geminiPrompt, undefined, undefined, true, groqPrompt);

      return emailBody;
    } catch (error: any) {
      console.error("Error generating follow-up email:", error);
      throw error;
    }
  });

  safeHandle("extract-emails-from-transcript", async (_, transcript: Array<{ text: string }>) => {
    try {
      const { extractEmailsFromTranscript } = require('./utils/emailUtils');
      return extractEmailsFromTranscript(transcript);
    } catch (error: any) {
      console.error("Error extracting emails:", error);
      return [];
    }
  });

  safeHandle("get-calendar-attendees", async (_, eventId: string) => {
    try {
      const { CalendarManager } = require('./services/CalendarManager');
      const cm = CalendarManager.getInstance();

      // Try to get attendees from the event
      const events = await cm.getUpcomingEvents();
      const event = events?.find((e: any) => e.id === eventId);

      if (event && event.attendees) {
        return event.attendees.map((a: any) => ({
          email: a.email,
          name: a.displayName || a.email?.split('@')[0] || ''
        })).filter((a: any) => a.email);
      }

      return [];
    } catch (error: any) {
      console.error("Error getting calendar attendees:", error);
      return [];
    }
  });

  safeHandle("open-mailto", async (_, { to, subject, body }: { to: string; subject: string; body: string }) => {
    try {
      const { buildMailtoLink } = require('./utils/emailUtils');
      const mailtoUrl = buildMailtoLink(to, subject, body);
      await shell.openExternal(mailtoUrl);
      return { success: true };
    } catch (error: any) {
      console.error("Error opening mailto:", error);
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Local Microsoft Bridge Handlers
  // ==========================================

  safeHandle("microsoft-local-status", async () => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().getStatus();
  });

  safeHandle("outlook-list-emails", async (_, options?: { top?: number; unreadOnly?: boolean }) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    const emails = await MicrosoftLocalManager.getInstance().getRecentEmails(options?.top ?? 25, options?.unreadOnly ?? false);
    return { emails, totalCount: emails.length };
  });

  safeHandle("outlook-search-emails", async (_, query: string, top?: number) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    const emails = await MicrosoftLocalManager.getInstance().searchEmails(query, top ?? 25);
    return { emails, totalCount: emails.length };
  });

  safeHandle("outlook-create-draft", async (_, draft: any) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().createDraft(draft);
  });

  safeHandle("outlook-send-email", async (_, draft: any) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    await MicrosoftLocalManager.getInstance().sendEmail(draft);
    return { success: true };
  });

  safeHandle("outlook-create-calendar-event", async (_, request: any) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().createCalendarEvent(request);
  });

  safeHandle("outlook-reply-email", async (_, entryId: string, body: string, replyAll?: boolean, send?: boolean) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    await MicrosoftLocalManager.getInstance().replyToEmail(entryId, body, replyAll, send ?? false);
    return { success: true };
  });

  safeHandle("teams-list-chats", async (_, limit?: number) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().getTeamsChats(limit ?? 25);
  });

  safeHandle("teams-get-messages", async (_, chatId: string, limit?: number) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().getTeamsMessages(chatId, limit ?? 50);
  });

  safeHandle("teams-send-message", async (_, chatId: string, text: string) => {
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    return MicrosoftLocalManager.getInstance().sendTeamsMessage(chatId, text);
  });

  safeHandle("chat:review-message", async (_, input: { text: string; reviewType: 'voice_pass' | 'technical_check'; sourceIntent?: string }) => {
    try {
      const llmHelper = appState.processingHelper.getLLMHelper();
      return await llmHelper.reviewAssistantOutput(input);
    } catch (error: any) {
      console.error('[IPC] chat:review-message failed:', error);
      return {
        reviewType: input?.reviewType || 'voice_pass',
        reviewerModel: 'error',
        text: '',
        error: error?.message || 'Review failed',
      };
    }
  });

  // ==========================================
  // RAG (Retrieval-Augmented Generation) Handlers
  // ==========================================

  // Store active query abort controllers for cancellation
  const activeRAGQueries = new Map<string, AbortController>();

  // Query meeting with RAG (meeting-scoped)
  safeHandle("rag:query-meeting", async (event, { meetingId, query }: { meetingId: string; query: string }) => {
    const ragManager = appState.getRAGManager();
    const startedAt = Date.now();
    const modelState = getChatDebugModelState();
    let firstTokenAt: number | null = null;
    let fullResponse = "";

    if (!ragManager || !ragManager.isReady()) {
      // Fallback to regular chat if RAG not available
      console.log("[RAG] Not ready, falling back to regular chat");
      return { fallback: true };
    }

    // For completed meetings, check if post-meeting RAG is processed.
    // For live meetings with JIT indexing, let RAGManager.queryMeeting() decide.
    if (!ragManager.isMeetingProcessed(meetingId) && !ragManager.isLiveIndexingActive(meetingId)) {
      console.log(`[RAG] Meeting ${meetingId} not processed and no JIT indexing, falling back to regular chat`);
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `meeting-${meetingId}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting(meetingId, query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
        }
        fullResponse += chunk;
        event.sender.send("rag:stream-chunk", { meetingId, chunk });
      }

      event.sender.send("rag:stream-complete", { meetingId });
      saveChatDebugEntry({
        surface: 'meeting_rag',
        status: 'completed',
        modelState,
        meetingId,
        timestamp: startedAt,
        userQuery: query,
        aiResponse: fullResponse,
        firstTokenAt,
        completedAt: Date.now(),
        ragMode: 'meeting',
      });
      return { success: true };

    } catch (error: any) {
      if (error.name === 'AbortError') {
        saveChatDebugEntry({
          surface: 'meeting_rag',
          status: 'superseded',
          modelState,
          meetingId,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'meeting',
        });
        return { success: false, error: error.message };
      }

      if (error.name !== 'AbortError') {
        const msg = error.message || "";
        // If specific RAG failures, return fallback to use transcript window
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) {
          console.log(`[RAG] Query failed with '${msg}', falling back to regular chat`);
          return { fallback: true };
        }

        console.error("[RAG] Query error:", error);
        event.sender.send("rag:stream-error", { meetingId, error: msg });
        saveChatDebugEntry({
          surface: 'meeting_rag',
          status: 'error',
          modelState,
          meetingId,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'meeting',
          error: msg,
        });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Query live meeting with JIT RAG
  safeHandle("rag:query-live", async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();
    const startedAt = Date.now();
    const modelState = getChatDebugModelState();
    let firstTokenAt: number | null = null;
    let fullResponse = "";

    if (!ragManager || !ragManager.isReady()) {
      return { fallback: true };
    }

    // Check if JIT indexing is active and has chunks
    if (!ragManager.isLiveIndexingActive('live-meeting-current')) {
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `live-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryMeeting('live-meeting-current', query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
        }
        fullResponse += chunk;
        event.sender.send("rag:stream-chunk", { live: true, chunk });
      }

      event.sender.send("rag:stream-complete", { live: true });
      saveChatDebugEntry({
        surface: 'widget_live_rag',
        status: 'completed',
        modelState,
        timestamp: startedAt,
        userQuery: query,
        aiResponse: fullResponse,
        firstTokenAt,
        completedAt: Date.now(),
        ragMode: 'live',
      });
      return { success: true };

    } catch (error: any) {
      if (error.name === 'AbortError') {
        saveChatDebugEntry({
          surface: 'widget_live_rag',
          status: 'superseded',
          modelState,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'live',
        });
        return { success: false, error: error.message };
      }

      if (error.name !== 'AbortError') {
        const msg = error.message || "";
        // If JIT RAG failed (no embeddings yet, no relevant context), fallback to regular chat
        if (msg.includes('NO_RELEVANT_CONTEXT') || msg.includes('NO_MEETING_EMBEDDINGS')) {
          console.log(`[RAG] JIT query failed with '${msg}', falling back to regular live chat`);
          return { fallback: true };
        }
        console.error("[RAG] Live query error:", error);
        event.sender.send("rag:stream-error", { live: true, error: msg });
        saveChatDebugEntry({
          surface: 'widget_live_rag',
          status: 'error',
          modelState,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'live',
          error: msg,
        });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Query global (cross-meeting search)
  safeHandle("rag:query-global", async (event, { query }: { query: string }) => {
    const ragManager = appState.getRAGManager();
    const startedAt = Date.now();
    const modelState = getChatDebugModelState();
    let firstTokenAt: number | null = null;
    let fullResponse = "";

    if (!ragManager || !ragManager.isReady()) {
      return { fallback: true };
    }

    const abortController = new AbortController();
    const queryKey = `global-${Date.now()}`;
    activeRAGQueries.set(queryKey, abortController);

    try {
      const stream = ragManager.queryGlobal(query, abortController.signal);

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
        }
        fullResponse += chunk;
        event.sender.send("rag:stream-chunk", { global: true, chunk });
      }

      event.sender.send("rag:stream-complete", { global: true });
      saveChatDebugEntry({
        surface: 'global_rag',
        status: 'completed',
        modelState,
        timestamp: startedAt,
        userQuery: query,
        aiResponse: fullResponse,
        firstTokenAt,
        completedAt: Date.now(),
        ragMode: 'global',
      });
      return { success: true };

    } catch (error: any) {
      if (error.name === 'AbortError') {
        saveChatDebugEntry({
          surface: 'global_rag',
          status: 'superseded',
          modelState,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'global',
        });
        return { success: false, error: error.message };
      }

      if (error.name !== 'AbortError') {
        event.sender.send("rag:stream-error", { global: true, error: error.message });
        saveChatDebugEntry({
          surface: 'global_rag',
          status: 'error',
          modelState,
          timestamp: startedAt,
          userQuery: query,
          aiResponse: fullResponse,
          firstTokenAt,
          completedAt: Date.now(),
          ragMode: 'global',
          error: error.message,
        });
      }
      return { success: false, error: error.message };
    } finally {
      activeRAGQueries.delete(queryKey);
    }
  });

  // Cancel active RAG query
  safeHandle("rag:cancel-query", async (_, { meetingId, global, live }: { meetingId?: string; global?: boolean; live?: boolean }) => {
    const queryKey = live ? 'live-' : global ? 'global' : `meeting-${meetingId}`;

    // Cancel any matching key
    for (const [key, controller] of activeRAGQueries) {
      if (key.startsWith(queryKey) || (global && key.startsWith('global')) || (live && key.startsWith('live-'))) {
        controller.abort();
        activeRAGQueries.delete(key);
      }
    }

    return { success: true };
  });

  // Check if meeting has RAG embeddings
  safeHandle('rag:is-meeting-processed', async (_, meetingId: string) => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      return ragManager.isMeetingProcessed(meetingId);
    } catch (error: any) {
      console.error('[IPC rag:is-meeting-processed] Error:', error);
      return false;
    }
  });

  safeHandle('rag:reindex-incompatible-meetings', async () => {
    try {
      const ragManager = appState.getRAGManager();
      if (!ragManager) throw new Error('RAGManager not initialized');
      await ragManager.reindexIncompatibleMeetings();
      return { success: true };
    } catch (error: any) {
      console.error('[IPC rag:reindex-incompatible-meetings] Error:', error);
      return { success: false, error: error.message };
    }
  });

  // Get RAG queue status
  safeHandle("rag:get-queue-status", async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { pending: 0, processing: 0, completed: 0, failed: 0 };
    return ragManager.getQueueStatus();
  });

  // Retry pending embeddings
  safeHandle("rag:retry-embeddings", async () => {
    const ragManager = appState.getRAGManager();
    if (!ragManager) return { success: false };
    await ragManager.retryPendingEmbeddings();
    return { success: true };
  });

  // ==========================================
  // Profile Engine IPC Handlers
  // ==========================================

  safeHandle("profile:upload-resume", async (_, filePath: string) => {
    try {
      console.log(`[IPC] profile:upload-resume called with: ${filePath}`);
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      }
      const { DocType } = require('../premium/electron/knowledge/types');
      const result = await orchestrator.ingestDocument(filePath, DocType.RESUME);
      return result;
    } catch (error: any) {
      console.error('[IPC] profile:upload-resume error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-status", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { hasProfile: false, profileMode: false };
      }
      // Map new KnowledgeStatus back to legacy UI shape temporarily
      const status = orchestrator.getStatus();
      return {
        hasProfile: status.hasResume,
        profileMode: status.activeMode,
        name: status.resumeSummary?.name,
        role: status.resumeSummary?.role,
        totalExperienceYears: status.resumeSummary?.totalExperienceYears
      };
    } catch (error: any) {
      return { hasProfile: false, profileMode: false };
    }
  });

  safeHandle("profile:set-mode", async (_, enabled: boolean) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      orchestrator.setKnowledgeMode(enabled);

      const { SettingsManager } = require('./services/SettingsManager');
      SettingsManager.getInstance().set('knowledgeMode', enabled);

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:delete", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const { DocType } = require('../premium/electron/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.RESUME);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-profile", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return null;
      return orchestrator.getProfileData();
    } catch (error: any) {
      return null;
    }
  });

  safeHandle("profile:select-file", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Reference Files', extensions: ['pdf', 'docx', 'txt'] }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true };
      }

      return { success: true, filePath: result.filePaths[0] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("meeting-import:select-files", async () => {
    try {
      const result: any = await dialog.showOpenDialog({
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Meeting Files', extensions: ['txt', 'md', 'pdf', 'docx', 'json', 'srt', 'vtt'] }
        ]
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true, filePaths: [] };
      }

      return { success: true, filePaths: result.filePaths };
    } catch (error: any) {
      return { success: false, error: error.message, filePaths: [] };
    }
  });

  safeHandle("meeting-import:ingest", async (_, artifacts: any[]) => {
    try {
      const { MeetingImportService } = require('./services/MeetingImportService');
      const service = new MeetingImportService();
      const llmHelper = appState.processingHelper.getLLMHelper();
      const ragManager = appState.getRAGManager?.() || null;
      const result = await service.importArtifacts(artifacts || [], { llmHelper, ragManager });
      broadcastMeetingsUpdated();
      return result;
    } catch (error: any) {
      console.error('[IPC] meeting-import:ingest failed:', error);
      return {
        importedMeetings: [],
        skippedArtifacts: [{ name: 'Import', reason: error?.message || 'Import failed' }],
        totalArtifacts: Array.isArray(artifacts) ? artifacts.length : 0,
      };
    }
  });

  safeHandle("teams-import:discover", async (_, limit?: number) => {
    try {
      const { TeamsMeetingImportService } = require('./services/TeamsMeetingImportService');
      const service = new TeamsMeetingImportService();
      return await service.discoverCandidates(limit || 10);
    } catch (error: any) {
      console.error('[IPC] teams-import:discover failed:', error);
      return [];
    }
  });

  safeHandle("teams-import:ingest", async (_, options?: { limit?: number; chatIds?: string[] }) => {
    try {
      const { TeamsMeetingImportService } = require('./services/TeamsMeetingImportService');
      const service = new TeamsMeetingImportService();
      const llmHelper = appState.processingHelper.getLLMHelper();
      const ragManager = appState.getRAGManager?.() || null;
      const result = await service.importRecentCandidates({ llmHelper, ragManager }, options || {});
      broadcastMeetingsUpdated();
      return result;
    } catch (error: any) {
      console.error('[IPC] teams-import:ingest failed:', error);
      return {
        importedMeetings: [],
        skippedArtifacts: [{ name: 'Teams Import', reason: error?.message || 'Teams import failed' }],
        totalArtifacts: 0,
        attemptedChats: 0,
        discoveredCandidates: 0,
      };
    }
  });

  safeHandle("cluely-import:discover", async (_, limit?: number) => {
    try {
      const { CluelyImportService } = require('./services/CluelyImportService');
      const service = new CluelyImportService();
      return await service.discoverCandidates(limit || 10);
    } catch (error: any) {
      console.error('[IPC] cluely-import:discover failed:', error);
      return {
        candidates: [],
        mode: 'unavailable',
        warning: error?.message || 'Cluely discovery failed.',
      };
    }
  });

  safeHandle("cluely-import:ingest", async (_, options?: { limit?: number; sessionIds?: string[] }) => {
    try {
      const { CluelyImportService } = require('./services/CluelyImportService');
      const service = new CluelyImportService();
      const llmHelper = appState.processingHelper.getLLMHelper();
      const ragManager = appState.getRAGManager?.() || null;
      const result = await service.importRecentCandidates({ llmHelper, ragManager }, options || {});
      broadcastMeetingsUpdated();
      return result;
    } catch (error: any) {
      console.error('[IPC] cluely-import:ingest failed:', error);
      return {
        importedMeetings: [],
        skippedArtifacts: [{ name: 'Cluely Import', reason: error?.message || 'Cluely import failed' }],
        totalArtifacts: 0,
        attemptedSessions: 0,
        discoveredCandidates: 0,
        mode: 'unavailable',
      };
    }
  });

  safeHandle("context-hub:get-status", async () => {
    try {
      const { ContextHubStatusService } = require('./services/ContextHubStatusService');
      return await ContextHubStatusService.getStatus(appState.getKnowledgeOrchestrator?.());
    } catch (error: any) {
      console.error('[IPC] context-hub:get-status failed:', error);
      return null;
    }
  });

  safeHandle("brain-action-proposals:list", async (_, limit?: number) => {
    try {
      const { BrainReadModelService } = require('./services/BrainReadModelService');
      return BrainReadModelService.getInstance().getActionProposals(limit ?? 25);
    } catch (error: any) {
      console.error('[IPC] brain-action-proposals:list failed:', error);
      return [];
    }
  });

  safeHandle("brain-action-proposals:record-outcome", async (_, input: {
    proposalId: string;
    decision: string;
    editSummary?: string;
    finalPayload?: unknown;
    error?: string;
    learningSignals?: string[];
  }) => {
    try {
      const { BrainReadModelService } = require('./services/BrainReadModelService');
      return BrainReadModelService.getInstance().recordActionOutcome(input);
    } catch (error: any) {
      console.error('[IPC] brain-action-proposals:record-outcome failed:', error);
      return { success: false, error: error?.message || 'Failed to record action outcome.' };
    }
  });

  safeHandle("brain-action-proposals:execute", async (_, input: {
    proposalId: string;
    payload?: Record<string, unknown>;
  }) => {
    const { BrainReadModelService } = require('./services/BrainReadModelService');
    const { MicrosoftLocalManager } = require('./services/MicrosoftLocalManager');
    const brain = BrainReadModelService.getInstance();
    const proposal = brain.getActionProposalById(input?.proposalId || "");
    if (!proposal) {
      return { success: false, error: 'Brain action proposal was not found.' };
    }

    const payload = {
      ...(proposal.payload || {}),
      ...(input?.payload || {}),
    };
    const workflowRun = brain.getOrCreateWorkflowRunForProposal(proposal, {
      state: "approved",
      actor: "steve",
      eventType: "approval.explicit_execute",
      eventSummary: "Steve explicitly approved this proposal for execution from Natively.",
      payload,
    });

    try {
      const manager = MicrosoftLocalManager.getInstance();
      let summary = "";
      let result: any = null;
      const type = String(proposal.type || "").toLowerCase();
      const adapter = type === "task" || type === "note" || type === "follow_up"
        ? "ipcorp_architecture_brain"
        : type === "teams_message"
          ? "teams"
          : "outlook";

      brain.transitionWorkflowRun(workflowRun.id, "executing", {
        type: "execution.started",
        actor: "natively",
        adapter,
        summary: `Executing ${proposal.type} proposal.`,
        payload,
      });

      if (type === "email") {
        const toRecipients = stringsFromPayload(payload, "toRecipients", "to", "recipients");
        const ccRecipients = stringsFromPayload(payload, "ccRecipients", "cc");
        const subject = stringFromPayload(payload, "subject", "title");
        const body = stringFromPayload(payload, "body", "message", "text");
        if (!toRecipients.length || !subject || !body) {
          throw new Error("Email proposal needs toRecipients/to, subject, and body before it can execute.");
        }
        if (booleanFromPayload(payload, "send", "sendNow")) {
          await manager.sendEmail({ toRecipients, ccRecipients, subject, body });
          summary = "Email sent through Outlook.";
        } else {
          result = await manager.createDraft({ toRecipients, ccRecipients, subject, body });
          summary = "Email draft created in Outlook.";
        }
      } else if (type === "teams_message") {
        const chatId = stringFromPayload(payload, "chatId", "targetChatId");
        const text = stringFromPayload(payload, "message", "text", "body");
        if (!chatId || !text) {
          throw new Error("Teams proposal needs chatId and message before it can execute.");
        }
        result = await manager.sendTeamsMessage(chatId, text);
        if (result?.success === false) {
          throw new Error(result.error || "Teams send failed.");
        }
        summary = "Teams message sent.";
      } else if (type === "calendar_event") {
        const subject = stringFromPayload(payload, "subject", "title");
        const start = stringFromPayload(payload, "start", "startsAt", "startTime");
        const end = stringFromPayload(payload, "end", "endsAt", "endTime");
        if (!subject || !start || !end) {
          throw new Error("Calendar proposal needs subject, start, and end before it can execute.");
        }
        result = await manager.createCalendarEvent({
          subject,
          start,
          end,
          location: stringFromPayload(payload, "location"),
          body: stringFromPayload(payload, "body", "description"),
          attendees: {
            required: stringsFromPayload(payload, "required", "requiredAttendees", "attendees"),
            optional: stringsFromPayload(payload, "optional", "optionalAttendees"),
          },
          send: booleanFromPayload(payload, "send", "sendInvites"),
        });
        summary = booleanFromPayload(payload, "send", "sendInvites")
          ? "Calendar invite created and sent through Outlook."
          : "Calendar event created in Outlook.";
      } else if (type === "task" || type === "follow_up") {
        result = brain.writeTaskFromProposal(proposal, payload, workflowRun.id);
        summary = type === "follow_up"
          ? "Follow-up written to the IP Corp brain task queue."
          : "Task written to the IP Corp brain task queue.";
      } else if (type === "note") {
        result = brain.writeNoteFromProposal(proposal, payload, workflowRun.id);
        summary = "Note written to the IP Corp brain notes ledger.";
      } else {
        throw new Error(`Unsupported brain action proposal type: ${proposal.type}`);
      }

      brain.transitionWorkflowRun(workflowRun.id, "completed", {
        type: "execution.completed",
        actor: "natively",
        adapter,
        summary,
        receipt: result,
      });

      brain.recordActionOutcome({
        proposalId: proposal.id,
        decision: "executed",
        finalPayload: payload,
        learningSignals: [`Steve executed ${proposal.type} proposal ${proposal.id}.`],
      });

      return { success: true, summary, result };
    } catch (error: any) {
      brain.transitionWorkflowRun(workflowRun.id, "failed", {
        type: "execution.failed",
        actor: "natively",
        summary: error?.message || String(error),
        error: error?.message || String(error),
        payload,
      });
      brain.recordActionOutcome({
        proposalId: proposal.id,
        decision: "failed",
        finalPayload: payload,
        error: error?.message || String(error),
      });
      return { success: false, error: error?.message || 'Failed to execute brain action proposal.' };
    }
  });

  safeHandle("autonomous-ops:get-status", async () => {
    try {
      const { AutonomousOpsService } = require('./autonomy');
      return AutonomousOpsService.getInstance().getStatus();
    } catch (error: any) {
      console.error('[IPC] autonomous-ops:get-status failed:', error);
      return null;
    }
  });

  safeHandle("autonomous-ops:refresh", async () => {
    try {
      const { AutonomousOpsService } = require('./autonomy');
      return await AutonomousOpsService.getInstance().refreshNow();
    } catch (error: any) {
      console.error('[IPC] autonomous-ops:refresh failed:', error);
      return null;
    }
  });

  safeHandle("autonomous-ops:start-workflow", async (_, workflowId: string, options?: { goalId?: string; autonomyLevel?: string }) => {
    try {
      const { AutonomousOpsService } = require('./autonomy');
      return await AutonomousOpsService.getInstance().startWorkflow(workflowId, options);
    } catch (error: any) {
      console.error('[IPC] autonomous-ops:start-workflow failed:', error);
      return null;
    }
  });

  safeHandle("autonomous-ops:stop-workflow", async (_, workflowId: string) => {
    try {
      const { AutonomousOpsService } = require('./autonomy');
      AutonomousOpsService.getInstance().stopWorkflow(workflowId);
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] autonomous-ops:stop-workflow failed:', error);
      return { success: false, error: error?.message || 'Failed to stop workflow monitor.' };
    }
  });

  safeHandle("autonomous-ops:invoke-action", async (_, workflowId: string, actionId: string, payload?: Record<string, unknown>) => {
    try {
      const { AutonomousOpsService } = require('./autonomy');
      return await AutonomousOpsService.getInstance().invokeAction(workflowId, actionId, payload);
    } catch (error: any) {
      console.error('[IPC] autonomous-ops:invoke-action failed:', error);
      return { success: false, summary: error?.message || 'Failed to invoke workflow action.' };
    }
  });

  safeHandle("durable-workflows:get-status", async (_, limit?: number) => {
    try {
      const { DurableWorkflowLedger } = require('./services/DurableWorkflowLedger');
      return DurableWorkflowLedger.getInstance().getStatus(limit ?? 25);
    } catch (error: any) {
      console.error('[IPC] durable-workflows:get-status failed:', error);
      return null;
    }
  });

  safeHandle("durable-workflows:list", async (_, limit?: number) => {
    try {
      const { DurableWorkflowLedger } = require('./services/DurableWorkflowLedger');
      return DurableWorkflowLedger.getInstance().listRuns(limit ?? 50);
    } catch (error: any) {
      console.error('[IPC] durable-workflows:list failed:', error);
      return [];
    }
  });

  // ==========================================
  // JD & Research IPC Handlers
  // ==========================================

  safeHandle("profile:upload-jd", async (_, filePath: string) => {
    try {
      console.log(`[IPC] profile:upload-jd called with: ${filePath}`);
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized. Please ensure API keys are configured.' };
      }
      const { DocType } = require('../premium/electron/knowledge/types');
      const result = await orchestrator.ingestDocument(filePath, DocType.JD);
      return result;
    } catch (error: any) {
      console.error('[IPC] profile:upload-jd error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:delete-jd", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const { DocType } = require('../premium/electron/knowledge/types');
      orchestrator.deleteDocumentsByType(DocType.JD);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:research-company", async (_, companyName: string) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const engine = orchestrator.getCompanyResearchEngine();

      // Wire search provider: Tavily (user key) → Natively API (fallback) → none (LLM-only)
      const { CredentialsManager } = require('./services/CredentialsManager');
      const cm = CredentialsManager.getInstance();
      const tavilyApiKey = cm.getTavilyApiKey();
      if (tavilyApiKey) {
        const { TavilySearchProvider } = require('../premium/electron/knowledge/TavilySearchProvider');
        engine.setSearchProvider(new TavilySearchProvider(tavilyApiKey));
      } else {
        const nativelyKey = cm.getNativelyApiKey();
        if (nativelyKey) {
          const { NativelySearchProvider } = require('../premium/electron/knowledge/NativelySearchProvider');
          engine.setSearchProvider(new NativelySearchProvider(nativelyKey));
          console.log('[IPC] Company research: using Natively API search (no Tavily key configured)');
        }
      }

      // Build full JD context so the dossier is tailored to the exact role
      const profileData = orchestrator.getProfileData();
      const activeJD = profileData?.activeJD;
      const jdCtx = activeJD ? {
        title: activeJD.title,
        location: activeJD.location,
        level: activeJD.level,
        technologies: activeJD.technologies,
        requirements: activeJD.requirements,
        keywords: activeJD.keywords,
        compensation_hint: activeJD.compensation_hint,
        min_years_experience: activeJD.min_years_experience,
      } : {};
      const dossier = await engine.researchCompany(companyName, jdCtx, true);
      const searchQuotaExhausted = (engine.searchProvider as any)?.quotaExhausted === true;
      return { success: true, dossier, searchQuotaExhausted };
    } catch (error: any) {
      console.error('[IPC] profile:research-company error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:generate-negotiation", async (_, force: boolean = false) => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) {
        return { success: false, error: 'Knowledge engine not initialized' };
      }
      const status = orchestrator.getStatus();
      if (!status.hasResume) {
        return { success: false, error: 'No background context loaded' };
      }

      // Use cache unless force-regenerating
      let script = force ? null : orchestrator.getNegotiationScript();
      if (!script) {
        script = await orchestrator.generateNegotiationScriptOnDemand();
      }
      if (!script) {
        return { success: false, error: 'Could not generate negotiation script. Ensure background context and a role brief are loaded.' };
      }
      return { success: true, script };
    } catch (error: any) {
      console.error('[IPC] profile:generate-negotiation error:', error);
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:get-negotiation-state", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false, error: 'Engine not ready' };
      const tracker = orchestrator.getNegotiationTracker();
      return {
        success: true,
        state: tracker.getState(),
        isActive: tracker.isActive(),
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  safeHandle("profile:reset-negotiation", async () => {
    try {
      const orchestrator = appState.getKnowledgeOrchestrator();
      if (!orchestrator) return { success: false };
      orchestrator.resetNegotiationSession();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Tavily Search API Credentials
  // ==========================================

  safeHandle("set-tavily-api-key", async (_, apiKey: string) => {
    try {
      if (apiKey && !apiKey.startsWith('tvly-')) {
        return { success: false, error: 'Invalid Tavily API key. Keys must start with "tvly-".' };
      }
      const { CredentialsManager } = require('./services/CredentialsManager');
      CredentialsManager.getInstance().setTavilyApiKey(apiKey);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // Overlay Opacity (Stealth Mode)
  // ==========================================

  safeHandle("set-overlay-opacity", async (_, opacity: number) => {
    // Clamp to valid range
    const clamped = Math.min(1.0, Math.max(0.35, opacity));
    // Broadcast to all renderer windows so the overlay picks it up in real-time
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('overlay-opacity-changed', clamped);
      }
    });
    return;
  });
}

function stringFromPayload(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function stringsFromPayload(payload: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value
        .flatMap((item) => {
          if (typeof item === "string" || typeof item === "number") return [String(item)];
          if (item && typeof item === "object") {
            const record = item as Record<string, unknown>;
            return stringFromPayload(record, "email", "address", "name", "value") || [];
          }
          return [];
        })
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function booleanFromPayload(payload: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(true|yes|1|send)$/i.test(value)) return true;
      if (/^(false|no|0|draft)$/i.test(value)) return false;
    }
    if (typeof value === "number") return value !== 0;
  }
  return false;
}
