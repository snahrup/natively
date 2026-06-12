import React, { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react';
import {
    Sparkles,
    Pencil,
    MessageSquare,
    RefreshCw,
    Settings,
    ArrowUp,
    ArrowRight,
    HelpCircle,
    ChevronUp,
    ChevronDown,
    Lightbulb,
    CornerDownLeft,
    Mic,
    MicOff,
    Image,
    Camera,
    X,
    LogOut,
    Zap,
    Edit3,
    SlidersHorizontal,
    Ghost,
    Link,
    Code,
    Copy,
    Check,
    PointerOff,
    Moon,
    Sun,
    Radio,
    LayoutDashboard
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
// import { ModelSelector } from './ui/ModelSelector'; // REMOVED
import TopPill from './ui/TopPill';
import RollingTranscript from './ui/RollingTranscript';
import { InlineActionProposalCard, type InlineActionProposal } from './ui/InlineActionProposalCard';
import { InlineWorkflowRecommendationCard, type InlineWorkflowRecommendation } from './ui/InlineWorkflowRecommendationCard';
import { NegotiationCoachingCard } from '../premium';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { analytics, detectProviderType } from '../lib/analytics/analytics.service';
import { useShortcuts } from '../hooks/useShortcuts';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { getOverlayAppearance, OVERLAY_OPACITY_DEFAULT } from '../lib/overlayAppearance';
import { getDisplayModelName, resolvePreferredVisibleModelId } from '../utils/modelUtils';

interface Message {
    id: string;
    role: 'user' | 'system' | 'external';
    text: string;
    createdAt?: number;
    chatDebugIssueId?: number;
    isStreaming?: boolean;
    hasScreenshot?: boolean;
    screenshotPreview?: string;
    isCode?: boolean;
    intent?: string;
    isNegotiationCoaching?: boolean;
    negotiationCoachingData?: {
        tacticalNote: string;
        exactScript: string;
        showSilenceTimer: boolean;
        phase: string;
        theirOffer: number | null;
        yourTarget: number | null;
        currency: string;
    };
    actionProposal?: InlineActionProposal;
    workflowRecommendation?: InlineWorkflowRecommendation;
    reviewMeta?: {
        reviewType: 'voice_pass' | 'technical_check';
        reviewedBy: string;
        sourceMessageId: string;
    };
}

interface NativelyInterfaceProps {
    onEndMeeting?: () => void;
    overlayOpacity?: number;
}

const LIVE_TRANSCRIPT_KEY = 'natively_live_transcript';
const LEGACY_TRANSCRIPT_KEY = ['natively_', 'inter', 'viewer_transcript'].join('');
const RAG_PREFLIGHT_TIMEOUT_MS = 2500;
const NO_SPEECH_WARNING_COOLDOWN_MS = 20_000;
type ScreenshotAttachment = { path: string; preview: string };

function resolveMessageCreatedAt(message: Message, fallbackNow: number): number {
    if (typeof message.createdAt === 'number' && Number.isFinite(message.createdAt)) {
        return message.createdAt;
    }

    const timestampFromId = Number(message.id);
    if (
        Number.isFinite(timestampFromId) &&
        timestampFromId > 946684800000 &&
        timestampFromId < fallbackNow + 60_000
    ) {
        return timestampFromId;
    }

    return fallbackNow;
}

function formatRelativeAge(createdAt: number, now: number): string {
    const elapsedMs = Math.max(0, now - createdAt);
    const elapsedSeconds = Math.floor(elapsedMs / 1000);

    if (elapsedSeconds < 5) return 'now';
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;

    return `${Math.floor(elapsedHours / 24)}d ago`;
}

type RuntimeCheckStatus = 'ready' | 'warming' | 'warning' | 'failed';
type TranscriptSpeakerIdentity = 'self' | 'other' | 'unknown';

interface NativeAudioTranscriptPayload {
    speaker: string;
    sourceSpeaker?: string;
    speakerKey?: string;
    speakerLabel?: string | null;
    displaySpeakerLabel?: string;
    diarizedSpeaker?: string | null;
    speakerIdentity?: TranscriptSpeakerIdentity;
    text: string;
    final: boolean;
    timestamp?: number;
    confidence?: number;
}

interface LiveTranscriptTurn {
    id: string;
    speakerKey: string;
    speakerLabel: string;
    speakerIdentity: TranscriptSpeakerIdentity;
    sourceSpeaker: string;
    text: string;
    final: boolean;
    timestamp: number;
}

interface RuntimeReadinessCheck {
    id: string;
    label: string;
    status: RuntimeCheckStatus;
    detail: string;
}

interface RuntimeReadinessStatus {
    overall?: RuntimeCheckStatus;
    generatedAt?: string;
    checks?: RuntimeReadinessCheck[];
    audio?: any;
    prep?: any;
    proactiveModeEnabled?: boolean;
}

function compactReadinessLabel(status?: RuntimeCheckStatus): string {
    if (status === 'ready') return 'ok';
    if (status === 'warming') return 'wait';
    if (status === 'failed') return 'blocked';
    return 'check';
}

function formatReadinessAge(iso?: string | null): string {
    if (!iso) return 'status pending';
    return formatRelativeAge(new Date(iso).getTime(), Date.now());
}

function getMessageLabel(message: Message): string {
    if (message.role === 'user') return 'You';
    if (message.role === 'external') return 'Context';
    if (message.intent === 'what_to_answer') return 'Say this';
    if (message.intent === 'clarify') return 'Clarify';
    if (message.intent === 'follow_up_questions') return 'Follow up';
    if (message.intent === 'recap') return 'Summary';
    if (message.intent === 'brainstorm') return 'Brainstorm';
    return 'Natively';
}

function makeMessageId(suffix = 'message'): string {
    return `${Date.now()}-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
}

function appendRollingTranscript(base: string, segment?: string): string {
    const cleanBase = base.trim();
    const cleanSegment = (segment || '').replace(/\s+/g, ' ').trim();
    const combined = cleanSegment
        ? cleanBase
            ? `${cleanBase}  ·  ${cleanSegment}`
            : cleanSegment
        : cleanBase;

    return combined.length > 1400 ? combined.slice(-1400) : combined;
}

function getTranscriptSpeakerKey(transcript: NativeAudioTranscriptPayload): string {
    if (transcript.speakerKey?.trim()) return transcript.speakerKey.trim();
    if (transcript.diarizedSpeaker) return `${transcript.speaker}:${transcript.diarizedSpeaker}`;
    return transcript.speaker;
}

function formatDiarizedSpeakerLabel(diarizedSpeaker?: string | null): string | null {
    if (!diarizedSpeaker) return null;
    const numeric = String(diarizedSpeaker).match(/(\d+)$/)?.[1];
    if (numeric !== undefined) return `Speaker ${Number(numeric) + 1}`;
    return String(diarizedSpeaker)
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function resolveTranscriptSpeakerLabel(
    transcript: NativeAudioTranscriptPayload,
    speakerLabels: Record<string, string>
): string {
    const speakerKey = getTranscriptSpeakerKey(transcript);
    const assigned = speakerLabels[speakerKey] || transcript.speakerLabel || '';
    if (assigned.trim()) return assigned.trim();
    if (transcript.displaySpeakerLabel?.trim()) return transcript.displaySpeakerLabel.trim();
    return formatDiarizedSpeakerLabel(transcript.diarizedSpeaker) || (transcript.speaker === 'external' ? 'Meeting' : 'Mic');
}

function updateTranscriptTurns(
    previous: LiveTranscriptTurn[],
    nextTurn: LiveTranscriptTurn
): LiveTranscriptTurn[] {
    const next = [...previous];
    const lastIndex = next.length - 1;
    const lastTurn = lastIndex >= 0 ? next[lastIndex] : null;

    if (lastTurn && !lastTurn.final && lastTurn.speakerKey === nextTurn.speakerKey) {
        next[lastIndex] = { ...nextTurn, id: lastTurn.id };
    } else if (
        nextTurn.final &&
        lastTurn &&
        !lastTurn.final &&
        lastTurn.speakerKey === nextTurn.speakerKey
    ) {
        next[lastIndex] = { ...nextTurn, id: lastTurn.id, final: true };
    } else {
        next.push(nextTurn);
    }

    return next.slice(-16);
}

async function withFallbackTimeout<T>(
    promise: Promise<T> | undefined,
    timeoutMs: number,
    fallback: T,
    onTimeout?: () => void
): Promise<T> {
    if (!promise) return fallback;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<T>((resolve) => {
            timeoutId = setTimeout(() => {
                onTimeout?.();
                resolve(fallback);
            }, timeoutMs);
        }),
    ]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
}

const NativelyInterface: React.FC<NativelyInterfaceProps> = ({ onEndMeeting, overlayOpacity = OVERLAY_OPACITY_DEFAULT }) => {
    const isLightTheme = useResolvedTheme() === 'light';
    const [isExpanded, setIsExpanded] = useState(true);
    const [inputValue, setInputValue] = useState('');
    const { shortcuts, isShortcutPressed } = useShortcuts();
    const [messages, setMessages] = useState<Message[]>([]);
    const [relativeAgeNow, setRelativeAgeNow] = useState(() => Date.now());
    const [reviewingMessageId, setReviewingMessageId] = useState<string | null>(null);
    const [reviewingType, setReviewingType] = useState<'voice_pass' | 'technical_check' | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingStatus, setProcessingStatus] = useState('');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [conversationContext, setConversationContext] = useState<string>('');
    const [isManualRecording, setIsManualRecording] = useState(false);
    const isRecordingRef = useRef(false);  // Ref to track recording state (avoids stale closure)
    const [manualTranscript, setManualTranscript] = useState('');
    const manualTranscriptRef = useRef<string>('');
    const [showTranscript, setShowTranscript] = useState(() => {
        const stored = localStorage.getItem(LIVE_TRANSCRIPT_KEY) ?? localStorage.getItem(LEGACY_TRANSCRIPT_KEY);
        return stored !== 'false';
    });

    // Analytics State
    const requestStartTimeRef = useRef<number | null>(null);

    // Sync transcript setting
    useEffect(() => {
        const handleStorage = () => {
            const stored = localStorage.getItem(LIVE_TRANSCRIPT_KEY) ?? localStorage.getItem(LEGACY_TRANSCRIPT_KEY);
            setShowTranscript(stored !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    const [rollingTranscript, setRollingTranscript] = useState('');
    const rollingTranscriptFinalRef = useRef('');
    const [liveTranscriptTurns, setLiveTranscriptTurns] = useState<LiveTranscriptTurn[]>([]);
    const [speakerLabels, setSpeakerLabels] = useState<Record<string, string>>({});
    const speakerLabelsRef = useRef<Record<string, string>>({});
    const [userDisplayName, setUserDisplayName] = useState('Steve');
    const userDisplayNameRef = useRef('Steve');
    const [editingSpeakerKey, setEditingSpeakerKey] = useState<string | null>(null);
    const [editingSpeakerValue, setEditingSpeakerValue] = useState('');
    const [speakerLabelSavingKey, setSpeakerLabelSavingKey] = useState<string | null>(null);
    const [isContextSpeaking, setIsContextSpeaking] = useState(false);
    const [voiceInput, setVoiceInput] = useState('');  // Accumulated user voice input
    const voiceInputRef = useRef<string>('');  // Ref for capturing in async handlers
    const lastNoSpeechWarningAtRef = useRef(0);
    const offeredWorkflowRecommendationSignaturesRef = useRef<Set<string>>(new Set());
    const dismissedWorkflowRecommendationSignaturesRef = useRef<Set<string>>(new Set());
    const notifiedWorkflowCompletionSignaturesRef = useRef<Set<string>>(new Set());
    const textInputRef = useRef<HTMLInputElement>(null); // Ref for input focus
    const isStealthRef = useRef<boolean>(false); // Tracks if the next expansion should be stealthy
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    // Captures data from onCaptureAndProcess before the React state flush so
    // handleWhatToSay() can access it even in React 18 concurrent mode (where
    // a plain setTimeout(0) may fire before setAttachedContext flushes).
    const pendingCaptureRef = useRef<{ path: string; preview: string } | null>(null);

    // Latent Context State (Screenshots attached but not sent)
    const [attachedContext, setAttachedContext] = useState<Array<{ path: string, preview: string }>>([]);

    // Settings State with Persistence
    const [isUndetectable, setIsUndetectable] = useState(false);
    const [isProactiveMode, setIsProactiveMode] = useState(false);
    const [meetingReadiness, setMeetingReadiness] = useState<RuntimeReadinessStatus | null>(null);
    const [hideChatHidesWidget, setHideChatHidesWidget] = useState(() => {
        const stored = localStorage.getItem('natively_hideChatHidesWidget');
        return stored ? stored === 'true' : true;
    });

    // Model Selection State
    const [currentModel, setCurrentModel] = useState<string>('');

    // Dynamic Action Button Mode (Recap vs Brainstorm)
    const [actionButtonMode, setActionButtonMode] = useState<'recap' | 'brainstorm'>('recap');

    useEffect(() => {
        // Load persisted mode
        window.electronAPI?.getActionButtonMode?.()?.then((mode: 'recap' | 'brainstorm') => {
            if (mode) setActionButtonMode(mode);
        }).catch(() => {});

        // Listen for live changes from SettingsPopup / IPC
        const unsubscribe = window.electronAPI?.onActionButtonModeChanged?.((mode: 'recap' | 'brainstorm') => {
            setActionButtonMode(mode);
        });
        return () => { unsubscribe?.(); };
    }, []);

    const codeTheme = isLightTheme ? oneLight : vscDarkPlus;
    const codeLineNumberColor = isLightTheme ? 'rgba(15,23,42,0.35)' : 'rgba(255,255,255,0.2)';
    const appearance = useMemo(
        () => getOverlayAppearance(overlayOpacity, isLightTheme ? 'light' : 'dark'),
        [overlayOpacity, isLightTheme]
    );
    const overlayPanelClass = 'overlay-text-primary';
    const subtleSurfaceClass = 'overlay-subtle-surface';
    const codeBlockClass = 'overlay-code-block-surface';
    const codeHeaderClass = 'overlay-code-header-surface';
    const codeHeaderTextClass = 'overlay-text-muted';
    const quickActionClass = 'overlay-chip-surface overlay-text-interactive';
    const inputClass = `${isLightTheme ? 'focus:ring-black/10' : 'focus:ring-white/10'} overlay-input-surface overlay-input-text`;
    const controlSurfaceClass = 'overlay-control-surface overlay-text-interactive';

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            setRelativeAgeNow(Date.now());
        }, 1000);
        return () => window.clearInterval(intervalId);
    }, []);

    useEffect(() => {
        let mounted = true;
        window.electronAPI?.getMeetingSpeakerLabels?.()
            .then((labels) => {
                if (mounted && labels) {
                    speakerLabelsRef.current = labels;
                    setSpeakerLabels(labels);
                }
            })
            .catch(() => {});

        const unsubscribe = window.electronAPI?.onMeetingSpeakerLabelsChanged?.((labels) => {
            const nextLabels = labels || {};
            speakerLabelsRef.current = nextLabels;
            setSpeakerLabels(nextLabels);
        });

        return () => {
            mounted = false;
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        let mounted = true;

        window.electronAPI?.getUserProfile?.()
            .then((profile) => {
                const nextName = profile?.userDisplayName?.trim();
                if (mounted && nextName) {
                    userDisplayNameRef.current = nextName;
                    setUserDisplayName(nextName);
                }
            })
            .catch(() => {});

        const unsubscribe = window.electronAPI?.onUserProfileChanged?.((profile) => {
            const nextName = profile?.userDisplayName?.trim();
            if (!nextName) return;
            userDisplayNameRef.current = nextName;
            setUserDisplayName(nextName);
        });

        return () => {
            mounted = false;
            unsubscribe?.();
        };
    }, []);

    useEffect(() => {
        setLiveTranscriptTurns(prev => prev.map(turn => ({
            ...turn,
            speakerLabel: speakerLabels[turn.speakerKey] || turn.speakerLabel
        })));
    }, [speakerLabels]);

    useEffect(() => {
        let mounted = true;
        const refreshReadiness = async () => {
            if (!window.electronAPI?.getMeetingReadinessStatus) return;
            try {
                const status = await window.electronAPI.getMeetingReadinessStatus();
                if (mounted) {
                    setMeetingReadiness(status || null);
                }
            } catch {
                if (mounted) {
                    setMeetingReadiness(null);
                }
            }
        };

        refreshReadiness();
        const intervalId = window.setInterval(refreshReadiness, 5000);
        return () => {
            mounted = false;
            window.clearInterval(intervalId);
        };
    }, []);

    useEffect(() => {
        setMessages(prev => {
            let changed = false;
            const now = Date.now();
            const next = prev.map(message => {
                if (typeof message.createdAt === 'number') {
                    return message;
                }
                changed = true;
                return {
                    ...message,
                    createdAt: resolveMessageCreatedAt(message, now)
                };
            });
            return changed ? next : prev;
        });
    }, [messages.length]);

    useLayoutEffect(() => {
        const scrollContainer = scrollContainerRef.current;
        if (!scrollContainer) return;

        requestAnimationFrame(() => {
            scrollContainer.scrollTo({
                top: scrollContainer.scrollHeight,
                behavior: 'smooth'
            });
        });
    }, [messages, isManualRecording, isProcessing]);

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

    const buildScreenReadContext = (question: string): string => {
        const recentChat = conversationContext.trim();
        const parts = [
            'The user is asking about what is visible on their screen right now.',
            'Use the attached screenshot as the primary source of truth.',
            'Describe the active window(s), the main task underway, and any obvious errors, blockers, or next steps.',
            'If something is partially obscured or unreadable, say that directly instead of guessing.',
            `User question: ${question}`,
        ];

        if (recentChat) {
            parts.push(`Recent chat context:\n${recentChat}`);
        }

        return parts.join('\n\n');
    };

    const ensureFreshScreenAttachment = async (
        question: string,
        attachments: ScreenshotAttachment[]
    ): Promise<ScreenshotAttachment[]> => {
        if (attachments.length > 0 || !isExplicitScreenReadRequest(question)) {
            return attachments;
        }

        try {
            const capture = await window.electronAPI.takeContextScreenshot();
            return capture ? [capture] : attachments;
        } catch (error) {
            console.error('[NativelyInterface] Failed to auto-capture screen for explicit screen-read request:', error);
            return attachments;
        }
    };

    const recentSpeakerChips = useMemo(() => {
        const byKey = new Map<string, LiveTranscriptTurn>();
        liveTranscriptTurns.forEach(turn => {
            byKey.set(turn.speakerKey, {
                ...turn,
                speakerLabel: speakerLabels[turn.speakerKey] || turn.speakerLabel
            });
        });
        return Array.from(byKey.values()).slice(-4);
    }, [liveTranscriptTurns, speakerLabels]);

    const beginSpeakerLabelEdit = (turn: LiveTranscriptTurn) => {
        setEditingSpeakerKey(turn.speakerKey);
        const assignedLabel = speakerLabels[turn.speakerKey] || '';
        const suggestedLabel = turn.sourceSpeaker === 'user' ? (userDisplayName || userDisplayNameRef.current) : '';
        setEditingSpeakerValue(assignedLabel || suggestedLabel);
    };

    const cancelSpeakerLabelEdit = () => {
        setEditingSpeakerKey(null);
        setEditingSpeakerValue('');
    };

    const saveSpeakerLabel = async (speakerKey: string, nextLabel: string) => {
        const cleanLabel = nextLabel.replace(/\s+/g, ' ').trim();
        const nextLabels = { ...speakerLabelsRef.current };
        if (cleanLabel) {
            nextLabels[speakerKey] = cleanLabel;
        } else {
            delete nextLabels[speakerKey];
        }

        speakerLabelsRef.current = nextLabels;
        setSpeakerLabels(nextLabels);
        setSpeakerLabelSavingKey(speakerKey);

        try {
            const result = await window.electronAPI?.setMeetingSpeakerLabel?.(speakerKey, cleanLabel);
            if (result?.labels) {
                speakerLabelsRef.current = result.labels;
                setSpeakerLabels(result.labels);
            }
            setEditingSpeakerKey(null);
            setEditingSpeakerValue('');
        } catch (error) {
            setMessages(prev => [...prev, {
                id: makeMessageId('speaker-label-error'),
                role: 'system',
                text: `Could not save speaker label: ${error instanceof Error ? error.message : String(error)}`
            }]);
        } finally {
            setSpeakerLabelSavingKey(null);
        }
    };

    const pushNoSpeechWarning = () => {
        const now = Date.now();
        if (now - lastNoSpeechWarningAtRef.current < NO_SPEECH_WARNING_COOLDOWN_MS) {
            return;
        }
        lastNoSpeechWarningAtRef.current = now;
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'system',
            text: '⚠️ No speech detected. Try speaking closer to your microphone.'
        }]);
    };

    useEffect(() => {
        // Load the persisted default model unless proactive mode is already active.
        // Proactive mode owns the runtime model because it needs the fast coach lane.
        if (window.electronAPI?.getDefaultModel) {
            Promise.all([
                window.electronAPI.getDefaultModel(),
                window.electronAPI?.getStoredCredentials?.(),
                window.electronAPI?.getProactiveMode?.(),
            ])
                .then(([result, creds, proactiveEnabled]: any) => {
                    if (proactiveEnabled) {
                        setCurrentModel('gpt-5.4-mini');
                        return;
                    }

                    const resolvedModel = resolvePreferredVisibleModelId(result?.model, creds);
                    if (resolvedModel) {
                        setCurrentModel(resolvedModel);
                        window.electronAPI.setModel(resolvedModel).catch(() => { });
                    }
                })
                .catch((err: any) => console.error("Failed to fetch default model:", err));
        }
    }, []);

    const handleModelSelect = (modelId: string) => {
        setCurrentModel(modelId);
        // Session-only: update runtime but don't persist as default
        window.electronAPI.setModel(modelId)
            .catch((err: any) => console.error("Failed to set model:", err));
    };

    const toggleThemeMode = () => {
        const nextMode = isLightTheme ? 'dark' : 'light';
        window.electronAPI?.setThemeMode?.(nextMode).catch((err: any) => {
            console.error("Failed to set theme mode:", err);
        });
    };

    const toggleProactiveMode = () => {
        const nextState = !isProactiveMode;
        setIsProactiveMode(nextState);
        if (nextState) {
            setCurrentModel('gpt-5.4-mini');
            window.electronAPI?.setModel?.('gpt-5.4-mini').catch((err: any) => {
                console.error("Failed to switch proactive mode to GPT 5.4 Mini:", err);
            });
            window.electronAPI?.setReasoningEffort?.('low').catch((err: any) => {
                console.error("Failed to switch proactive reasoning effort:", err);
            });
        }
        window.electronAPI?.setProactiveMode?.(nextState).catch((err: any) => {
            console.error("Failed to set proactive mode:", err);
            setIsProactiveMode(!nextState);
        });
    };

    const toggleUndetectableMode = () => {
        const nextState = !isUndetectable;
        setIsUndetectable(nextState);
        window.electronAPI?.setUndetectable?.(nextState).catch((err: any) => {
            console.error("Failed to set undetectable mode:", err);
            setIsUndetectable(!nextState);
        });
    };

    // Listen for default model changes from Settings
    useEffect(() => {
        if (!window.electronAPI?.onModelChanged) return;
        const unsubscribe = window.electronAPI.onModelChanged((modelId: string) => {
            setCurrentModel(prev => prev === modelId ? prev : modelId);
        });
        return () => unsubscribe();
    }, []);

    // Global State Sync
    useEffect(() => {
        // Fetch initial state
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then(setIsUndetectable);
        }

        if (window.electronAPI?.onUndetectableChanged) {
            const unsubscribe = window.electronAPI.onUndetectableChanged((state) => {
                setIsUndetectable(state);
            });
            return () => unsubscribe();
        }
    }, []);

    // Proactive coaching mode
    useEffect(() => {
        window.electronAPI?.getProactiveMode?.().then(setIsProactiveMode).catch(() => {});
        const unsubscribe = window.electronAPI?.onProactiveModeChanged?.((enabled) => {
            setIsProactiveMode(enabled);
        });
        return () => unsubscribe?.();
    }, []);

    // Persist Settings
    useEffect(() => {
        localStorage.setItem('natively_undetectable', String(isUndetectable));
        localStorage.setItem('natively_hideChatHidesWidget', String(hideChatHidesWidget));
    }, [isUndetectable, hideChatHidesWidget]);

    // Mouse Passthrough State
    const [isMousePassthrough, setIsMousePassthrough] = useState(false);
    useEffect(() => {
        window.electronAPI?.getOverlayMousePassthrough?.().then(setIsMousePassthrough).catch(() => {});
        const unsub = window.electronAPI?.onOverlayMousePassthroughChanged?.((v) => setIsMousePassthrough(v));
        return () => unsub?.();
    }, []);

    useEffect(() => {
        if (!isProcessing) {
            setProcessingStatus('');
        }
    }, [isProcessing]);

    // Auto-resize Window
    useLayoutEffect(() => {
        if (!contentRef.current) return;

        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                // Use getBoundingClientRect to get the exact rendered size including padding
                const rect = entry.target.getBoundingClientRect();

                // Send exact dimensions to Electron
                // Removed buffer to ensure tight fit
                console.log('[NativelyInterface] ResizeObserver:', Math.ceil(rect.width), Math.ceil(rect.height));
                window.electronAPI?.updateContentDimensions({
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height)
                });
            }
        });

        observer.observe(contentRef.current);
        return () => observer.disconnect();
    }, []);

    // Force resize when attachedContext changes (screenshots added/removed)
    useEffect(() => {
        if (!contentRef.current) return;
        // Let the DOM settle, then measure and push new dimensions
        requestAnimationFrame(() => {
            if (!contentRef.current) return;
            const rect = contentRef.current.getBoundingClientRect();
            window.electronAPI?.updateContentDimensions({
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height)
            });
        });
    }, [attachedContext]);

    // Force initial sizing safety check
    useEffect(() => {
        const timer = setTimeout(() => {
            if (contentRef.current) {
                const rect = contentRef.current.getBoundingClientRect();
                window.electronAPI?.updateContentDimensions({
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height)
                });
            }
        }, 600);
        return () => clearTimeout(timer);
    }, []);

    // Build conversation context from messages
    useEffect(() => {
        const context = messages
            .filter(m => m.role !== 'user' || !m.hasScreenshot)
            .map(m => `${m.role === 'external' ? 'Context' : m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
            .slice(-20)
            .join('\n');
        setConversationContext(context);
    }, [messages]);

    // Listen for settings window visibility changes
    useEffect(() => {
        if (!window.electronAPI?.onSettingsVisibilityChange) return;
        const unsubscribe = window.electronAPI.onSettingsVisibilityChange((isVisible) => {
            setIsSettingsOpen(isVisible);
        });
        return () => unsubscribe();
    }, []);

    // Sync Window Visibility with Expanded State
    useEffect(() => {
        if (isExpanded) {
            window.electronAPI.showWindow(isStealthRef.current);
            isStealthRef.current = false; // Reset back to default
        } else {
            requestAnimationFrame(() => {
                if (!contentRef.current) return;
                const rect = contentRef.current.getBoundingClientRect();
                window.electronAPI?.updateContentDimensions({
                    width: Math.ceil(rect.width),
                    height: Math.ceil(rect.height),
                });
            });
        }
    }, []);

    // Keyboard shortcut to toggle expanded state (via Main Process)
    useEffect(() => {
        if (!window.electronAPI?.onToggleExpand) return;
        const unsubscribe = window.electronAPI.onToggleExpand(() => {
            setIsExpanded(prev => !prev);
        });
        return () => unsubscribe();
    }, []);

    // Ensure overlay is expanded when requested by main process (e.g. after switching to overlay mode).
    // IMPORTANT: set isStealthRef before setIsExpanded so that if isExpanded was false, the
    // isExpanded effect fires showWindow(true) instead of showWindow(false). Without this,
    // ensure-expanded on a collapsed overlay would trigger show()+focus(), breaking stealth.
    useEffect(() => {
        if (!window.electronAPI?.onEnsureExpanded) return;
        const unsubscribe = window.electronAPI.onEnsureExpanded(() => {
            isStealthRef.current = true;
            setIsExpanded(true);
        });
        return () => unsubscribe();
    }, []);

    // Session Reset Listener - Clears UI when a NEW meeting starts
    useEffect(() => {
        if (!window.electronAPI?.onSessionReset) return;
        const unsubscribe = window.electronAPI.onSessionReset(() => {
            console.log('[NativelyInterface] Resetting session state...');
            setMessages([]);
            setInputValue('');
            setAttachedContext([]);
            setManualTranscript('');
            setVoiceInput('');
            rollingTranscriptFinalRef.current = '';
            setRollingTranscript('');
            setLiveTranscriptTurns([]);
            speakerLabelsRef.current = {};
            setSpeakerLabels({});
            setEditingSpeakerKey(null);
            setEditingSpeakerValue('');
            setIsProcessing(false);
            // Optionally reset connection status if needed, but connection persists

            // Track new conversation/session if applicable?
            // Actually 'app_opened' is global, 'assistant_started' is overlay.
            // Maybe 'conversation_started' event?
            analytics.trackConversationStarted();
        });
        return () => unsubscribe();
    }, []);


    const handleScreenshotAttach = (data: { path: string; preview: string }) => {
        setIsExpanded(true);
        setAttachedContext(prev => {
            // Prevent duplicates and cap at 5
            if (prev.some(s => s.path === data.path)) return prev;
            const updated = [...prev, data];
            return updated.slice(-5); // Keep last 5
        });
    };

    // Connect to Native Audio Backend
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Connection Status
        window.electronAPI.getNativeAudioStatus().then((status) => {
            setIsConnected(status.connected);
        }).catch(() => setIsConnected(false));

        cleanups.push(window.electronAPI.onNativeAudioConnected(() => {
            setIsConnected(true);
        }));
        cleanups.push(window.electronAPI.onNativeAudioDisconnected(() => {
            setIsConnected(false);
        }));

        // Real-time Transcripts
        cleanups.push(window.electronAPI.onNativeAudioTranscript((transcript: NativeAudioTranscriptPayload) => {
            // When Answer button is active, capture USER transcripts for voice input
            // Use ref to avoid stale closure issue
            if (isRecordingRef.current && transcript.speaker === 'user') {
                if (transcript.final) {
                    // Accumulate final transcripts
                    setVoiceInput(prev => {
                        const updated = prev + (prev ? ' ' : '') + transcript.text;
                        voiceInputRef.current = updated;
                        return updated;
                    });
                    setManualTranscript('');  // Clear partial preview
                    manualTranscriptRef.current = '';
                } else {
                    // Show live partial transcript
                    setManualTranscript(transcript.text);
                    manualTranscriptRef.current = transcript.text;
                }
                return;  // Don't add to messages while recording
            }

            if (transcript.speaker !== 'external' && transcript.speaker !== 'user') {
                return;  // Safety check for any other speaker types
            }

            const speakerKey = getTranscriptSpeakerKey(transcript);
            const speakerLabel = resolveTranscriptSpeakerLabel(transcript, speakerLabelsRef.current);
            const transcriptLine = `${speakerLabel}: ${transcript.text}`;
            const timestamp = transcript.timestamp || Date.now();

            setLiveTranscriptTurns(prev => updateTranscriptTurns(prev, {
                id: `${timestamp}-${speakerKey}-${Math.random().toString(36).slice(2, 6)}`,
                speakerKey,
                speakerLabel,
                speakerIdentity: transcript.speakerIdentity || (transcript.speaker === 'external' ? 'other' : 'unknown'),
                sourceSpeaker: transcript.sourceSpeaker || transcript.speaker,
                text: transcript.text,
                final: transcript.final,
                timestamp
            }));

            // Route to rolling transcript bar - accumulate text continuously
            setIsContextSpeaking(!transcript.final);

            if (transcript.final) {
                // Append finalized text to accumulated transcript
                setRollingTranscript(() => {
                    const next = appendRollingTranscript(rollingTranscriptFinalRef.current, transcriptLine);
                    rollingTranscriptFinalRef.current = next;
                    return next;
                });

                // Clear speaking indicator after pause
                setTimeout(() => {
                    setIsContextSpeaking(false);
                }, 3000);
            } else {
                // For partial transcripts, append the current live segment to the
                // finalized base without corrupting prior finalized lines.
                setRollingTranscript(() => appendRollingTranscript(rollingTranscriptFinalRef.current, transcriptLine));
            }
        }));

        // AI Suggestions from native audio (legacy)
        cleanups.push(window.electronAPI.onSuggestionProcessingStart(() => {
            setIsProcessing(true);
            setIsExpanded(true);
        }));

        cleanups.push(window.electronAPI.onSuggestionGenerated((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: data.suggestion
            }]);
        }));

        cleanups.push(window.electronAPI.onSuggestionError((err) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `Error: ${err.error}`
            }]);
        }));

        if (window.electronAPI.onChatDebugIssue) {
            cleanups.push(window.electronAPI.onChatDebugIssue((issue) => {
                setMessages(prev => {
                    if (prev.some((msg) => msg.chatDebugIssueId === issue.id)) {
                        return prev;
                    }

                    const detail = issue.error || issue.aiResponse || 'A chat turn was flagged as an issue.';
                    const modelLabel = [issue.provider, issue.modelId].filter(Boolean).join(' • ');
                    const detailLine = modelLabel ? `${detail}\n\nSource: ${issue.surfaceLabel} • ${modelLabel}` : `${detail}\n\nSource: ${issue.surfaceLabel}`;

                    return [...prev, {
                        id: `chat-debug-issue-${issue.id}`,
                        chatDebugIssueId: issue.id,
                        role: 'system',
                        text: `Issue detected.\n\n${detailLine}`,
                    }];
                });
            }));
        }



        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswerToken((data) => {
            // Progressive update for 'what_to_answer' mode
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If we already have a streaming message for this intent, append
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_to_answer') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }

                // Otherwise, start a new one (First token)
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'what_to_answer',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceSuggestedAnswer((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If we were streaming, finalize it
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'what_to_answer') {
                    // Start new array to avoid mutation
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer, // Ensure final consistency
                        isStreaming: false
                    };
                    return updated;
                }

                // If we missed the stream (or not streaming), append fresh
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,  // Plain text, no markdown - ready to speak
                    intent: 'what_to_answer'
                }];
            });
        }));

        // STREAMING: Refinement
        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswerToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === data.intent) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                // New stream start (e.g. user clicked Shorten)
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: data.intent,
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceRefinedAnswer((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === data.intent) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.answer,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.answer,
                    intent: data.intent
                }];
            });
        }));

        // STREAMING: Recap
        cleanups.push(window.electronAPI.onIntelligenceRecapToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'recap') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'recap',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceRecap((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'recap') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.summary,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.summary,
                    intent: 'recap'
                }];
            });
        }));

        // STREAMING: Follow-Up Questions (Rendered as message? Or specific UI?)
        // Currently interface typically renders follow-up Qs as a message or button update.
        // Let's assume message for now based on existing 'follow_up_questions_update' handling
        // But wait, existing handle just sets state?
        // Let's check how 'follow_up_questions_update' was handled.
        // It was handled separate locally in this component maybe?
        // Ah, I need to see the existing listener for 'onIntelligenceFollowUpQuestionsUpdate'

        // Let's implemented token streaming for it anyway, likely it updates a message bubble 
        // OR it might update a specialized "Suggested Questions" area.
        // Assuming it's a message for consistency with "Copilot" approach.

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'follow_up_questions') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + data.token
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.token,
                    intent: 'follow_up_questions',
                    isStreaming: true
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceFollowUpQuestionsUpdate((data) => {
            // This event name is slightly different ('update' vs 'answer')
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'follow_up_questions') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: data.questions,
                        isStreaming: false
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: data.questions,
                    intent: 'follow_up_questions'
                }];
            });
        }));

        cleanups.push(window.electronAPI.onIntelligenceManualResult((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `🎯 **Answer:**\n\n${data.answer}`
            }]);
        }));

        cleanups.push(window.electronAPI.onIntelligenceError((data) => {
            setIsProcessing(false);
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: `❌ Error (${data.mode}): ${data.error}`
            }]);
        }));
        // Screenshot taken - attach to chat input instead of auto-analyzing
        cleanups.push(window.electronAPI.onScreenshotTaken(handleScreenshotAttach));

        // Selective Screenshot (Latent Context)
        if (window.electronAPI.onScreenshotAttached) {
            cleanups.push(window.electronAPI.onScreenshotAttached(handleScreenshotAttach));
        }


        return () => cleanups.forEach(fn => fn());
    }, []);

    // Stable mount-only effect for clarify streaming listeners.
    // These MUST NOT be inside the [isExpanded] effect — if the user
    // expands/collapses the panel while a clarify stream is in-flight,
    // the [isExpanded] effect would tear down and re-register listeners,
    // orphaning the final 'clarify' event and leaving isProcessing=true forever.
    useEffect(() => {
        const cleanupToken = window.electronAPI.onIntelligenceClarifyToken((data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'clarify') {
                    const updated = [...prev];
                    updated[prev.length - 1] = { ...lastMsg, text: lastMsg.text + data.token };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system' as const,
                    text: data.token,
                    intent: 'clarify',
                    isStreaming: true
                }];
            });
        });

        const cleanupFinal = window.electronAPI.onIntelligenceClarify((data) => {
            setIsProcessing(false);
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.intent === 'clarify') {
                    const updated = [...prev];
                    updated[prev.length - 1] = { ...lastMsg, text: data.clarification, isStreaming: false };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system' as const,
                    text: data.clarification,
                    intent: 'clarify'
                }];
            });
        });

        return () => {
            cleanupToken();
            cleanupFinal();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // intentionally empty — these listeners must survive isExpanded changes

    useEffect(() => {
        const unsubscribe = window.electronAPI.onAutonomousOpsUpdated((status) => {
            processAutonomousStatus(status);
        });

        window.electronAPI.getAutonomousOpsStatus?.()
            .then((status) => {
                processAutonomousStatus(status);
            })
            .catch(() => {});

        return () => {
            unsubscribe?.();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Quick Actions - Updated to use new Intelligence APIs

    const handleCopy = (text: string) => {
        navigator.clipboard.writeText(text);
        analytics.trackCopyAnswer();
        // Optional: Trigger a small toast or state change for visual feedback
    };

    const handleReviewMessage = async (message: Message, reviewType: 'voice_pass' | 'technical_check') => {
        if (!message.text.trim()) return;

        setReviewingMessageId(message.id);
        setReviewingType(reviewType);

        try {
            const result = await window.electronAPI.reviewChatMessage({
                text: message.text,
                reviewType,
                sourceIntent: message.intent,
            });

            if (!result?.text?.trim()) {
                throw new Error(result?.error || 'Review returned no content.');
            }

            setMessages((prev) => [
                ...prev,
                {
                    id: `${Date.now()}-${reviewType}`,
                    role: 'system',
                    text: result.text.trim(),
                    reviewMeta: {
                        reviewType,
                        reviewedBy: result.reviewerModel,
                        sourceMessageId: message.id,
                    },
                },
            ]);

            setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }, 50);
        } catch (error: any) {
            setMessages((prev) => [
                ...prev,
                {
                    id: `${Date.now()}-review-error`,
                    role: 'system',
                    text: `Review failed: ${error?.message || 'Unknown error'}`,
                },
            ]);
        } finally {
            setReviewingMessageId(null);
            setReviewingType(null);
        }
    };

    const handleWhatToSay = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Drafting what to say...');
        analytics.trackCommandExecuted('what_to_say');

        // Capture and clear attached image context.
        // Also merge in any screenshot from the capture-and-process shortcut that
        // arrived via pendingCaptureRef before the React state flush (React 18 fix).
        const pending = pendingCaptureRef.current;
        let currentAttachments = attachedContext;
        if (pending && !currentAttachments.some(s => s.path === pending.path)) {
            currentAttachments = [...currentAttachments, pending].slice(-5);
        }

        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: makeMessageId('user-screenshot'),
                role: 'user',
                text: 'What should I say about this?',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
            // Scroll to bottom when user sends message
            setTimeout(() => {
            	messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }, 50);
        }

        try {
            // Pass imagePath if attached
            const result = await window.electronAPI.generateWhatToSay(undefined, currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
            if (!result?.answer) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('what-to-say-empty'),
                    role: 'system',
                    text: currentAttachments.length > 0
                        ? 'I could not generate a reply from that screenshot yet. Try again, or ask in the text box with one sentence of what you need.'
                        : 'No fresh meeting context is available yet. Start listening, wait for transcript text to appear, or ask a direct question in the box.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('what-to-say-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleLiveHelp = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Reading the room...');
        analytics.trackCommandExecuted('live_help');

        const pending = pendingCaptureRef.current;
        let currentAttachments = attachedContext;
        if (pending && !currentAttachments.some(s => s.path === pending.path)) {
            currentAttachments = [...currentAttachments, pending].slice(-5);
        }

        if (currentAttachments.length === 0) {
            const capture = await withFallbackTimeout<ScreenshotAttachment | null>(
                window.electronAPI.takeContextScreenshot?.(),
                900,
                null
            );
            if (capture) {
                currentAttachments = [capture];
            }
        }

        if (currentAttachments.length > 0) {
            setAttachedContext([]);
        }

        try {
            const result = await window.electronAPI.generateWhatToSay(
                'Help me answer the latest question or fill the silence with the most useful thing I can say now. Use the live transcript first and the current screen only when it adds useful context.',
                currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined,
                { force: true }
            );
            if (!result?.answer) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('live-help-empty'),
                    role: 'system',
                    text: 'I need a little more live context. Let the transcript run for a few seconds, or ask one sentence in the box.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('live-help-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleFollowUp = async (intent: string = 'rephrase') => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Refining the last answer...');
        analytics.trackCommandExecuted('follow_up_' + intent);

        try {
            const result = await window.electronAPI.generateFollowUp(intent);
            if (!result?.refined) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('follow-up-empty'),
                    role: 'system',
                    text: 'There is not a previous Natively answer to refine yet.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('follow-up-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleRecap = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Summarizing live context...');
        analytics.trackCommandExecuted('recap');

        try {
            const result = await window.electronAPI.generateRecap();
            if (!result?.summary) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('recap-empty'),
                    role: 'system',
                    text: 'There is not enough live transcript context to summarize yet.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('recap-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleFollowUpQuestions = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Finding useful follow-up questions...');
        analytics.trackCommandExecuted('suggest_questions');

        try {
            const result = await window.electronAPI.generateFollowUpQuestions();
            if (!result?.questions) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('follow-up-questions-empty'),
                    role: 'system',
                    text: 'No meeting context has landed yet, so there are no useful follow-up questions to suggest.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('follow-up-questions-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleClarify = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Preparing a clarifying question...');
        analytics.trackCommandExecuted('clarify');

        try {
            const result = await window.electronAPI.generateClarify();
            void result;
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('clarify-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleCodeHint = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Looking at code context...');
        analytics.trackCommandExecuted('code_hint');

        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: makeMessageId('code-hint-user'),
                role: 'user',
                text: 'Give me a code hint for this',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
        	// Scroll to bottom when user sends message
        	setTimeout(() => {
        		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        	}, 50);
        }

        try {
            const result = await window.electronAPI.generateCodeHint(currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
            if (!result?.hint) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('code-hint-empty'),
                    role: 'system',
                    text: 'I could not generate a code hint from the available screen or transcript context.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('code-hint-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };

    const handleBrainstorm = async () => {
        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Exploring options...');
        analytics.trackCommandExecuted('brainstorm');

        const currentAttachments = attachedContext;
        if (currentAttachments.length > 0) {
            setAttachedContext([]);
            // Show the attached image in chat
            setMessages(prev => [...prev, {
                id: makeMessageId('brainstorm-user'),
                role: 'user',
                text: 'Brainstorm with this context',
                hasScreenshot: true,
                screenshotPreview: currentAttachments[0].preview
            }]);
        	// Scroll to bottom when user sends message
        	setTimeout(() => {
        		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        	}, 50);
        }

        try {
            const result = await window.electronAPI.generateBrainstorm(currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined);
            if (!result?.script) {
                setMessages(prev => [...prev, {
                    id: makeMessageId('brainstorm-empty'),
                    role: 'system',
                    text: 'I could not explore options yet because there is not enough screen or transcript context.'
                }]);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                id: makeMessageId('brainstorm-error'),
                role: 'system',
                text: `Error: ${err}`
            }]);
        } finally {
            setIsProcessing(false);
            setProcessingStatus('');
        }
    };


    // Setup Streaming Listeners
    useEffect(() => {
        const cleanups: (() => void)[] = [];

        // Stream Token
        cleanups.push(window.electronAPI.onGeminiStreamToken((token) => {
            // Guard: if this token is the negotiation coaching JSON sentinel, accumulate it
            // silently. The JSON is always emitted as a single complete `yield JSON.stringify(...)`
            // call, so one parse attempt is sufficient. The onGeminiStreamDone handler will
            // detect the accumulated JSON and render the proper card UI — we just prevent the
            // raw JSON characters from ever appearing in the chat bubble.
            try {
                const parsed = JSON.parse(token);
                if (parsed?.__negotiationCoaching) {
                    // Store the raw JSON text (Done handler needs it) but don't show it.
                    setMessages(prev => {
                        const lastMsg = prev[prev.length - 1];
                        if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                            const updated = [...prev];
                            updated[prev.length - 1] = { ...lastMsg, text: token };
                            return updated;
                        }
                        return prev;
                    });
                    return; // Skip the normal append below
                }
                if (parsed?.__actionProposal) {
                    setMessages(prev => {
                        const lastMsg = prev[prev.length - 1];
                        if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                            const updated = [...prev];
                            updated[prev.length - 1] = { ...lastMsg, text: token };
                            return updated;
                        }
                        return prev;
                    });
                    return;
                }
            } catch {
                // Not JSON — normal text token, fall through to the standard append.
            }

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        text: lastMsg.text + token,
                        // re-check code status on every token? Expensive but needed for progressive highlighting
                        isCode: (lastMsg.text + token).includes('```') || (lastMsg.text + token).includes('def ') || (lastMsg.text + token).includes('function ')
                    };
                    return updated;
                }
                return prev;
            });
        }));

        // Stream Done
        cleanups.push(window.electronAPI.onGeminiStreamDone(() => {
            setIsProcessing(false);

            // Calculate latency if we have a start time
            let latency = 0;
            if (requestStartTimeRef.current) {
                latency = Date.now() - requestStartTimeRef.current;
                requestStartTimeRef.current = null;
            }

            // Track Usage
            analytics.trackModelUsed({
                model_name: currentModel,
                provider_type: detectProviderType(currentModel),
                latency_ms: latency
            });

            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                    // Detect negotiation coaching response
                    try {
                        const parsed = JSON.parse(lastMsg.text);
                        if (parsed?.__negotiationCoaching) {
                            const coaching = parsed.__negotiationCoaching;
                            return [...prev.slice(0, -1), {
                                ...lastMsg,
                                isStreaming: false,
                                isNegotiationCoaching: true,
                                negotiationCoachingData: coaching,
                                text: '',
                            }];
                        }
                        if (parsed?.__actionProposal) {
                            return [...prev.slice(0, -1), {
                                ...lastMsg,
                                isStreaming: false,
                                actionProposal: parsed.__actionProposal,
                                text: '',
                            }];
                        }
                    } catch {}
                    // Normal completion
                    return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
                }
                return prev;
            });
        }));

        // Stream Error
        cleanups.push(window.electronAPI.onGeminiStreamError((error) => {
            setIsProcessing(false);
            requestStartTimeRef.current = null; // Clear timer on error
            setMessages(prev => {
                // Append error to the current message or add new one?
                // Let's add a new error block if the previous one confusing,
                // or just update status.
                // Ideally we want to show the partial response AND the error.
                const lastMsg = prev[prev.length - 1];
                if (lastMsg && lastMsg.isStreaming) {
                    const updated = [...prev];
                    updated[prev.length - 1] = {
                        ...lastMsg,
                        isStreaming: false,
                        text: lastMsg.text + `\n\n[Error: ${error}]`
                    };
                    return updated;
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error: ${error}`
                }];
            });
        }));

        // JIT RAG Stream listeners (for live meeting RAG responses)
        if (window.electronAPI.onRAGStreamChunk) {
            cleanups.push(window.electronAPI.onRAGStreamChunk((data: { chunk: string }) => {
                // Same guard as onGeminiStreamToken: suppress raw JSON if this chunk is
                // the negotiation coaching sentinel. The onRAGStreamComplete handler will
                // convert it to the proper card UI.
                try {
                    const parsed = JSON.parse(data.chunk);
                    if (parsed?.__negotiationCoaching) {
                        setMessages(prev => {
                            const lastMsg = prev[prev.length - 1];
                            if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                                const updated = [...prev];
                                updated[prev.length - 1] = { ...lastMsg, text: data.chunk };
                                return updated;
                            }
                            return prev;
                        });
                        return; // Skip normal append
                    }
                    if (parsed?.__actionProposal) {
                        setMessages(prev => {
                            const lastMsg = prev[prev.length - 1];
                            if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                                const updated = [...prev];
                                updated[prev.length - 1] = { ...lastMsg, text: data.chunk };
                                return updated;
                            }
                            return prev;
                        });
                        return;
                    }
                } catch {
                    // Normal text chunk — fall through.
                }

                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                        const updated = [...prev];
                        updated[prev.length - 1] = {
                            ...lastMsg,
                            text: lastMsg.text + data.chunk,
                            isCode: (lastMsg.text + data.chunk).includes('```')
                        };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI.onRAGStreamComplete) {
            cleanups.push(window.electronAPI.onRAGStreamComplete(() => {
                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming && lastMsg.role === 'system') {
                        // Detect negotiation coaching response
                        try {
                            const parsed = JSON.parse(lastMsg.text);
                            if (parsed?.__negotiationCoaching) {
                                const coaching = parsed.__negotiationCoaching;
                                return [...prev.slice(0, -1), {
                                    ...lastMsg,
                                    isStreaming: false,
                                    isNegotiationCoaching: true,
                                    negotiationCoachingData: coaching,
                                    text: '',
                                }];
                            }
                            if (parsed?.__actionProposal) {
                                return [...prev.slice(0, -1), {
                                    ...lastMsg,
                                    isStreaming: false,
                                    actionProposal: parsed.__actionProposal,
                                    text: '',
                                }];
                            }
                        } catch {}
                        // Normal completion
                        return [...prev.slice(0, -1), { ...lastMsg, isStreaming: false }];
                    }
                    if (lastMsg && lastMsg.isStreaming) {
                        const updated = [...prev];
                        updated[prev.length - 1] = { ...lastMsg, isStreaming: false };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        if (window.electronAPI.onRAGStreamError) {
            cleanups.push(window.electronAPI.onRAGStreamError((data: { error: string }) => {
                setIsProcessing(false);
                requestStartTimeRef.current = null;
                setMessages(prev => {
                    const lastMsg = prev[prev.length - 1];
                    if (lastMsg && lastMsg.isStreaming) {
                        const updated = [...prev];
                        updated[prev.length - 1] = {
                            ...lastMsg,
                            isStreaming: false,
                            text: lastMsg.text + `\n\n[RAG Error: ${data.error}]`
                        };
                        return updated;
                    }
                    return prev;
                });
            }));
        }

        return () => cleanups.forEach(fn => fn());
    }, [currentModel]); // Ensure tracking captures correct model


    const handleAnswerNow = async () => {
        if (isManualRecording) {
            // Ask the STT provider to flush before we close the capture window.
            // Some providers emit the final segment shortly after finalize().
            await window.electronAPI.finalizeMicSTT().catch(err => console.error('[NativelyInterface] Failed to send finalizeMicSTT:', err));
            await new Promise(resolve => setTimeout(resolve, 350));

            isRecordingRef.current = false;
            setIsManualRecording(false);
            setManualTranscript('');
            window.electronAPI.stopMicSTT?.().catch(err => console.error('[NativelyInterface] Failed to stop mic STT:', err));

            let currentAttachments = attachedContext;
            setAttachedContext([]); // Clear context immediately on send

            const question = (voiceInputRef.current + (manualTranscriptRef.current ? ' ' + manualTranscriptRef.current : '')).trim();
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            manualTranscriptRef.current = '';

            currentAttachments = await ensureFreshScreenAttachment(question, currentAttachments);
            const isScreenReadRequest = isExplicitScreenReadRequest(question);

            if (!question && currentAttachments.length === 0) {
                // No voice input and no image
                pushNoSpeechWarning();
                return;
            }

            // Show user's spoken question
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'user',
                text: question,
                hasScreenshot: currentAttachments.length > 0,
                screenshotPreview: currentAttachments[0]?.preview
            }]);
            
            // Scroll to bottom when user sends message
            setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            }, 50);

            // Add placeholder for streaming response
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: '',
                isStreaming: true
            }]);

            setIsProcessing(true);

            try {
                let prompt = '';

                if (currentAttachments.length > 0) {
                    // Image + Voice Context
                    if (isScreenReadRequest) {
                        prompt = `You are reading the user's live screen.
User said: "${question}"

Instructions:
1. Use the attached screenshot as the primary source of truth.
2. Describe what is visible right now, not what was visible earlier.
3. Name obvious errors, blockers, or next steps if they are on screen.
4. If a detail is unclear or obscured, say so instead of guessing.
5. Be concise and direct.`;
                    } else {
                        prompt = `You are a helper. The user has provided a screenshot and a spoken question/command.
User said: "${question}"

Instructions:
1. Analyze the screenshot in the context of what the user said.
2. Provide a direct, helpful answer.
3. Be concise.`;
                    }
                } else {
                    // JIT RAG pre-flight: try to use indexed meeting context first
                    setProcessingStatus('Checking prepared meeting context...');
                    const ragResult = await withFallbackTimeout(
                        window.electronAPI.ragQueryLive?.(question),
                        RAG_PREFLIGHT_TIMEOUT_MS,
                        { fallback: true },
                        () => window.electronAPI.ragCancelQuery?.({ live: true }).catch(() => {})
                    );
                    if (ragResult?.success) {
                        // JIT RAG handled it — response streamed via rag:stream-chunk events
                        return;
                    }

                    // Voice Only (Smart Extract) — fallback
                    setProcessingStatus(`Asking ${getDisplayModelName(currentModel) || 'the selected model'}...`);
                    prompt = `You are a real-time meeting coach. The user just repeated or paraphrased a question from the live conversation.
Instructions:
1. Extract the core question being asked
2. Provide a clear, concise, and professional answer that the user can say out loud
3. Keep the answer conversational but informative (2-4 sentences ideal)
4. Do NOT include phrases like "The question is..." - just give the answer directly
5. Format for speaking out loud, not for reading

Provide only the answer, nothing else.`;
                }

                // Call Streaming API: message = question, context = instructions
                requestStartTimeRef.current = Date.now();
                await window.electronAPI.streamGeminiChat(question, currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined, prompt, { skipSystemPrompt: true, surface: 'widget' });

            } catch (err) {
                // Initial invocation failing (e.g. IPC error before stream starts)
                setIsProcessing(false);
                setMessages(prev => {
                    const last = prev[prev.length - 1];
                    // If we just added the empty streaming placeholder, remove it or fill it with error
                    if (last && last.isStreaming && last.text === '') {
                        return prev.slice(0, -1).concat({
                            id: Date.now().toString(),
                            role: 'system',
                            text: `❌ Error starting stream: ${err}`
                        });
                    }
                    return [...prev, {
                        id: Date.now().toString(),
                        role: 'system',
                        text: `❌ Error: ${err}`
                    }];
                });
            }
        } else {
            setVoiceInput('');
            voiceInputRef.current = '';
            setManualTranscript('');
            try {
                const result = await window.electronAPI.startMicSTT?.();
                if (result && result.success === false) {
                    throw new Error(result.error || 'Unable to start microphone capture.');
                }
                isRecordingRef.current = true;
                setIsManualRecording(true);
            } catch (err) {
                isRecordingRef.current = false;
                setIsManualRecording(false);
                setMessages(prev => [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `⚠️ Microphone did not start: ${err instanceof Error ? err.message : String(err)}`
                }]);
            }
        }
    };

    const handleManualSubmit = async () => {
        if (!inputValue.trim() && attachedContext.length === 0) return;

        const userText = inputValue;
        let currentAttachments = attachedContext;
        const isScreenReadRequest = isExplicitScreenReadRequest(userText);

        currentAttachments = await ensureFreshScreenAttachment(userText, currentAttachments);

        // Clear inputs immediately
        setInputValue('');
        setAttachedContext([]);

        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'user',
            text: userText || (currentAttachments.length > 0 ? 'Analyze this screenshot' : ''),
            hasScreenshot: currentAttachments.length > 0,
            screenshotPreview: currentAttachments[0]?.preview
        }]);

        // Scroll to bottom when user sends message
        setTimeout(() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }, 50);

            // Add placeholder for streaming response
            setMessages(prev => [...prev, {
                id: Date.now().toString(),
                role: 'system',
                text: '',
            isStreaming: true
        }]);

        setIsExpanded(true);
        setIsProcessing(true);
        setProcessingStatus('Checking prepared meeting context...');

        try {
            // JIT RAG pre-flight: try to use indexed meeting context first
            if (currentAttachments.length === 0) {
                const ragResult = await withFallbackTimeout(
                    window.electronAPI.ragQueryLive?.(userText || ''),
                    RAG_PREFLIGHT_TIMEOUT_MS,
                    { fallback: true },
                    () => window.electronAPI.ragCancelQuery?.({ live: true }).catch(() => {})
                );
                if (ragResult?.success) {
                    // JIT RAG handled it — response streamed via rag:stream-chunk events
                    return;
                }
            }

            // Pass imagePath if attached, AND conversation context
            requestStartTimeRef.current = Date.now();
            setProcessingStatus(`Asking ${getDisplayModelName(currentModel) || 'the selected model'}...`);
            await window.electronAPI.streamGeminiChat(
                userText || 'Analyze this screenshot',
                currentAttachments.length > 0 ? currentAttachments.map(s => s.path) : undefined,
                isScreenReadRequest && currentAttachments.length > 0
                    ? buildScreenReadContext(userText || 'Describe the screen')
                    : conversationContext,
                { surface: 'widget' }
            );
        } catch (err) {
            setIsProcessing(false);
            setMessages(prev => {
                const last = prev[prev.length - 1];
                if (last && last.isStreaming && last.text === '') {
                    // remove the empty placeholder
                    return prev.slice(0, -1).concat({
                        id: Date.now().toString(),
                        role: 'system',
                        text: `❌ Error starting stream: ${err}`
                    });
                }
                return [...prev, {
                    id: Date.now().toString(),
                    role: 'system',
                    text: `❌ Error: ${err}`
                }];
            });
        }
    };

    const clearChat = () => {
        setMessages([]);
    };

    const chooseWorkflowRecommendationAction = (workflow: any): { id: string | null; label: string | null } => {
        const availableActions = Array.isArray(workflow?.availableActions) ? workflow.availableActions : [];
        const byId = (actionId: string) => availableActions.find((action: any) => action?.id === actionId) || null;
        const runId = workflow?.structuredState?.currentRunId || workflow?.structuredState?.runId;

        if (workflow?.state === 'ready-to-take-over') {
            const action = byId('start_run');
            if (action) return { id: action.id, label: action.label };
        }

        if (workflow?.state === 'blocked' && runId) {
            const action = byId('resume_run');
            if (action) return { id: action.id, label: action.label };
        }

        if (workflow?.state === 'blocked') {
            const action = byId('retry_failed_entities');
            if (action) return { id: action.id, label: action.label };
        }

        const nextActionIds = Array.isArray(workflow?.nextActionIds) ? workflow.nextActionIds : [];
        const nextControlAction = nextActionIds
            .map((actionId: string) => byId(actionId))
            .find((action: any) => action && action.policyClass !== 'read');

        if (nextControlAction) {
            return { id: nextControlAction.id, label: nextControlAction.label };
        }

        return { id: null, label: null };
    };

    const buildWorkflowRecommendation = (workflow: any): InlineWorkflowRecommendation => {
        const action = chooseWorkflowRecommendationAction(workflow);
        const runId = workflow?.structuredState?.currentRunId || workflow?.structuredState?.runId || '';
        const signature = [
            workflow?.workflowId || 'workflow',
            workflow?.state || 'unknown',
            workflow?.summary || '',
            runId,
        ].join('::');

        const note = action.id
            ? `I noticed ${workflow.label} looks stuck or incomplete. Approve this and I’ll take it over, run ${action.label?.toLowerCase()}, and let you know when it finishes.`
            : `I noticed ${workflow.label} needs attention. Approve this and I’ll take it over and keep an eye on it for you.`;

        return {
            workflowId: workflow.workflowId,
            workflowLabel: workflow.label,
            signature,
            state: workflow.state || 'unknown',
            note,
            suggestedActionId: action.id,
            suggestedActionLabel: action.label,
        };
    };

    const dismissWorkflowRecommendation = (messageId: string, signature: string) => {
        dismissedWorkflowRecommendationSignaturesRef.current.add(signature);
        setMessages(prev => prev.filter((msg) => msg.id !== messageId));
    };

    const approveWorkflowRecommendation = (messageId: string, workflowLabel: string, signature: string, summary: string) => {
        offeredWorkflowRecommendationSignaturesRef.current.add(signature);
        setMessages(prev => prev.map((msg) => {
            if (msg.id !== messageId) return msg;
            return {
                ...msg,
                workflowRecommendation: undefined,
                text: `${summary} I’ll keep watching ${workflowLabel} and tell you when it finishes.`,
                intent: 'workflow_recommendation_approved',
            };
        }));
    };

    const processAutonomousStatus = (status: any) => {
        const workflows = Array.isArray(status?.workflows) ? status.workflows : [];

        workflows.forEach((workflow: any) => {
            const runId = workflow?.structuredState?.currentRunId || workflow?.structuredState?.runId || '';
            const signature = [
                workflow?.workflowId || 'workflow',
                workflow?.state || 'unknown',
                workflow?.summary || '',
                runId,
            ].join('::');

            const shouldRecommendTakeover =
                !workflow?.manual
                && (workflow?.state === 'blocked' || workflow?.state === 'ready-to-take-over');

            if (
                shouldRecommendTakeover
                && !offeredWorkflowRecommendationSignaturesRef.current.has(signature)
                && !dismissedWorkflowRecommendationSignaturesRef.current.has(signature)
            ) {
                const recommendation = buildWorkflowRecommendation(workflow);
                offeredWorkflowRecommendationSignaturesRef.current.add(signature);
                setIsExpanded(true);
                setMessages(prev => {
                    if (prev.some((msg) => msg.workflowRecommendation?.signature === signature)) {
                        return prev;
                    }
                    return [...prev, {
                        id: `workflow-recommendation-${Date.now()}`,
                        role: 'system',
                        text: '',
                        workflowRecommendation: recommendation,
                        intent: 'workflow_recommendation',
                    }];
                });
            }

            if (workflow?.manual && workflow?.state === 'completed' && !notifiedWorkflowCompletionSignaturesRef.current.has(signature)) {
                notifiedWorkflowCompletionSignaturesRef.current.add(signature);
                setMessages(prev => [...prev, {
                    id: `workflow-complete-${Date.now()}`,
                    role: 'system',
                    text: `${workflow.label} finished. ${workflow.summary}`,
                    intent: 'workflow_complete',
                }]);
            }
        });
    };




    const renderReviewBanner = (msg: Message) => {
        if (!msg.reviewMeta) return null;

        const reviewLabel = msg.reviewMeta.reviewType === 'voice_pass' ? 'Voice Pass' : 'Technical Cross-Check';
        return (
            <div className={`mb-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                <Sparkles className="w-3 h-3" />
                <span>{reviewLabel}</span>
                <span className="opacity-70">|</span>
                <span className="normal-case tracking-normal">{msg.reviewMeta.reviewedBy}</span>
            </div>
        );
    };

    const canReviewMessage = (msg: Message) =>
        msg.role === 'system'
        && !msg.isStreaming
        && !!msg.text.trim()
        && !msg.reviewMeta
        && !msg.actionProposal
        && !msg.isNegotiationCoaching;

    const renderReviewControls = (msg: Message) => {
        if (msg.role !== 'system' || msg.isStreaming) return null;

        const reviewable = canReviewMessage(msg);
        const reviewInFlight = reviewingMessageId === msg.id;

        return (
            <div className="absolute top-2 right-2 flex flex-col items-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {reviewable && (
                    <div
                        className={`flex items-center gap-1 rounded-full border px-1.5 py-1 backdrop-blur-md ${
                            isLightTheme ? 'bg-white/85 border-black/10' : 'bg-slate-950/75 border-white/10'
                        }`}
                    >
                        <button
                            onClick={() => handleReviewMessage(msg, 'voice_pass')}
                            disabled={reviewInFlight}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors ${
                                reviewInFlight
                                    ? 'cursor-wait text-text-tertiary'
                                    : 'hover:bg-black/5 dark:hover:bg-white/10 overlay-text-interactive'
                            }`}
                            title="Review with GPT-5.4"
                        >
                            {reviewInFlight && reviewingType === 'voice_pass' ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                                <Sparkles className="w-3 h-3" />
                            )}
                            <span>GPT-5.4</span>
                        </button>
                        <button
                            onClick={() => handleReviewMessage(msg, 'technical_check')}
                            disabled={reviewInFlight}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium transition-colors ${
                                reviewInFlight
                                    ? 'cursor-wait text-text-tertiary'
                                    : 'hover:bg-black/5 dark:hover:bg-white/10 overlay-text-interactive'
                            }`}
                            title="Cross-check with Codex"
                        >
                            {reviewInFlight && reviewingType === 'technical_check' ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                            ) : (
                                <Code className="w-3 h-3" />
                            )}
                            <span>Codex</span>
                        </button>
                    </div>
                )}
                <button
                    onClick={() => handleCopy(msg.text)}
                    className="p-1.5 rounded-md overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                    title="Copy to clipboard"
                    style={appearance.iconStyle}
                >
                    <Copy className="w-3.5 h-3.5" />
                </button>
            </div>
        );
    };

    const renderMessageText = (msg: Message) => {
        // Negotiation coaching card takes priority
        if (msg.isNegotiationCoaching && msg.negotiationCoachingData) {
            return (
                <NegotiationCoachingCard
                    {...msg.negotiationCoachingData}
                    phase={msg.negotiationCoachingData.phase as any}
                    onSilenceTimerEnd={() => {
                        setMessages(prev => prev.map(m =>
                            m.id === msg.id
                                ? { ...m, negotiationCoachingData: m.negotiationCoachingData ? { ...m.negotiationCoachingData, showSilenceTimer: false } : undefined }
                                : m
                        ));
                    }}
                />
            );
        }

        if (msg.actionProposal) {
            return (
                <>
                    {renderReviewBanner(msg)}
                    <InlineActionProposalCard proposal={msg.actionProposal} />
                </>
            );
        }

        if (msg.workflowRecommendation) {
            return (
                <>
                    {renderReviewBanner(msg)}
                    <InlineWorkflowRecommendationCard
                        recommendation={msg.workflowRecommendation}
                        onApproved={(summary) => approveWorkflowRecommendation(
                            msg.id,
                            msg.workflowRecommendation?.workflowLabel || 'this workflow',
                            msg.workflowRecommendation?.signature || '',
                            summary
                        )}
                        onDismissed={() => dismissWorkflowRecommendation(
                            msg.id,
                            msg.workflowRecommendation?.signature || ''
                        )}
                    />
                </>
            );
        }

        // Code-containing messages get special styling
        // We split by code blocks to keep the "Code Solution" UI intact for the code parts
        // But use ReactMarkdown for the text parts around it
        if (msg.isCode || (msg.role === 'system' && msg.text.includes('```'))) {
            const parts = msg.text.split(/(```[\s\S]*?```)/g);
            return (
                <div className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                    {renderReviewBanner(msg)}
                    <div className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? 'text-violet-600' : 'text-purple-300'}`}>
                        <Code className="w-3.5 h-3.5" />
                        <span>Technical Response</span>
                    </div>
                    <div className={`space-y-2 text-[13px] leading-relaxed ${isLightTheme ? 'text-slate-800' : 'text-slate-200'}`}>
                        {parts.map((part, i) => {
                            if (part.startsWith('```')) {
                                const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
                                if (match) {
                                    const lang = match[1] || 'python';
                                    const code = match[2].trim();
                                    return (
                                        <details key={i} className={`my-3 rounded-xl overflow-hidden border ${codeBlockClass}`} style={appearance.codeBlockStyle}>
                                            <summary className={`px-3 py-2 cursor-pointer list-none flex items-center justify-between ${codeHeaderClass}`} style={appearance.codeHeaderStyle}>
                                                <span className={`text-[10px] uppercase tracking-widest font-semibold font-mono ${codeHeaderTextClass}`}>
                                                    Show Technical Details • {lang || 'CODE'}
                                                </span>
                                            </summary>
                                            <div className="bg-transparent border-t" style={appearance.codeHeaderStyle}>
                                                <SyntaxHighlighter
                                                    language={lang}
                                                    style={codeTheme}
                                                    customStyle={{
                                                        margin: 0,
                                                        borderRadius: 0,
                                                        fontSize: '13px',
                                                        lineHeight: '1.6',
                                                        background: 'transparent',
                                                        padding: '16px',
                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                    }}
                                                    wrapLongLines={true}
                                                    showLineNumbers={true}
                                                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: codeLineNumberColor, textAlign: 'right', fontSize: '11px' }}
                                                >
                                                    {code}
                                                </SyntaxHighlighter>
                                            </div>
                                        </details>
                                    );
                                }
                            }
                            // Regular text - Render with Markdown
                            return (
                                <div key={i} className="markdown-content">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkMath]}
                                        rehypePlugins={[rehypeKatex]}
                                        components={{
                                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                                            strong: ({ node, ...props }: any) => <strong className="font-bold overlay-text-strong" {...props} />,
                                            em: ({ node, ...props }: any) => <em className="italic overlay-text-secondary" {...props} />,
                                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                            ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                                            h1: ({ node, ...props }: any) => <h1 className="text-lg font-bold mb-2 mt-3 overlay-text-strong" {...props} />,
                                            h2: ({ node, ...props }: any) => <h2 className="text-base font-bold mb-2 mt-3 overlay-text-strong" {...props} />,
                                            h3: ({ node, ...props }: any) => <h3 className="text-sm font-bold mb-1 mt-2 overlay-text-primary" {...props} />,
                                            code: ({ node, ...props }: any) => <code className={`overlay-inline-code-surface rounded px-1 py-0.5 text-xs font-mono whitespace-pre-wrap ${isLightTheme ? 'text-violet-700' : 'text-purple-200'}`} {...props} />,
                                            blockquote: ({ node, ...props }: any) => <blockquote className={`border-l-2 pl-3 italic my-2 ${isLightTheme ? 'border-violet-500/30 text-slate-600' : 'border-purple-500/50 text-slate-400'}`} {...props} />,
                                            a: ({ node, ...props }: any) => <a className={`hover:underline ${isLightTheme ? 'text-blue-600 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'}`} target="_blank" rel="noopener noreferrer" {...props} />,
                                        }}
                                    >
                                        {part}
                                    </ReactMarkdown>
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        }

        // Custom Styled Labels (Shorten, Recap, Follow-up) - also use Markdown for content
        if (msg.intent === 'shorten') {
            return (
                <div className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                    <div className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? 'text-cyan-700' : 'text-cyan-300'}`}>
                        <MessageSquare className="w-3.5 h-3.5" />
                        <span>Shortened</span>
                    </div>
                    <div className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? 'text-slate-800' : 'text-slate-200'}`}>
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className={`font-bold ${isLightTheme ? 'text-cyan-800' : 'text-cyan-100'}`} {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                        }}>
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'recap') {
            return (
                <div className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                    <div className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? 'text-indigo-700' : 'text-indigo-300'}`}>
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Recap</span>
                    </div>
                    <div className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? 'text-slate-800' : 'text-slate-200'}`}>
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className={`font-bold ${isLightTheme ? 'text-indigo-800' : 'text-indigo-100'}`} {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                        }}>
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'follow_up_questions') {
            return (
                <div className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                    <div className={`flex items-center gap-2 mb-2 font-semibold text-xs uppercase tracking-wide ${isLightTheme ? 'text-amber-700' : 'text-[#FFD60A]'}`}>
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>Follow-Up Questions</span>
                    </div>
                    <div className={`text-[13px] leading-relaxed markdown-content ${isLightTheme ? 'text-slate-800' : 'text-slate-200'}`}>
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className={`font-bold ${isLightTheme ? 'text-amber-800' : 'text-[#FFF9C4]'}`} {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                        }}>
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            );
        }

        if (msg.intent === 'what_to_answer') {
            // Split text by code blocks (Handle unclosed blocks at EOF)
            const parts = msg.text.split(/(```[\s\S]*?(?:```|$))/g);

            return (
                <div className={`rounded-lg p-3 my-1 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                    <div className="flex items-center gap-2 mb-2 text-emerald-400 font-semibold text-xs uppercase tracking-wide">
                        <span>Say this</span>
                    </div>
                    <div className="text-[14px] leading-relaxed overlay-text-primary">
                        {parts.map((part, i) => {
                            if (part.startsWith('```')) {
                                // Robust matching: handles unclosed blocks for streaming (```...$)
                                const match = part.match(/```(\w*)\s+([\s\S]*?)(?:```|$)/);

                                // Fallback logic: if it starts with ticks, treat as code (even if unclosed)
                                if (match || part.startsWith('```')) {
                                    const lang = (match && match[1]) ? match[1] : 'python';
                                    let code = '';

                                    if (match && match[2]) {
                                        code = match[2].trim();
                                    } else {
                                        // Manual strip if regex failed
                                        code = part.replace(/^```\w*\s*/, '').replace(/```$/, '').trim();
                                    }

                                    return (
                                        <details key={i} className={`my-3 rounded-xl overflow-hidden border ${codeBlockClass}`} style={appearance.codeBlockStyle}>
                                            <summary className={`px-3 py-2 cursor-pointer list-none flex items-center justify-between ${codeHeaderClass}`} style={appearance.codeHeaderStyle}>
                                                <span className={`text-[10px] uppercase tracking-widest font-semibold font-mono ${codeHeaderTextClass}`}>
                                                    Show Technical Details • {lang || 'CODE'}
                                                </span>
                                            </summary>

                                            <div className="bg-transparent border-t" style={appearance.codeHeaderStyle}>
                                                <SyntaxHighlighter
                                                    language={lang}
                                                    style={codeTheme}
                                                    customStyle={{
                                                        margin: 0,
                                                        borderRadius: 0,
                                                        fontSize: '13px',
                                                        lineHeight: '1.6',
                                                        background: 'transparent',
                                                        padding: '16px',
                                                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                                                    }}
                                                    wrapLongLines={true}
                                                    showLineNumbers={true}
                                                    lineNumberStyle={{ minWidth: '2.5em', paddingRight: '1.2em', color: codeLineNumberColor, textAlign: 'right', fontSize: '11px' }}
                                                >
                                                    {code}
                                                </SyntaxHighlighter>
                                            </div>
                                        </details>
                                    );
                                }
                            }
                            // Regular text - Render Markdown
                            return (
                                <div key={i} className="markdown-content">
                                    <ReactMarkdown
                                        remarkPlugins={[remarkGfm, remarkMath]}
                                        rehypePlugins={[rehypeKatex]}
                                        components={{
                                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
                                            strong: ({ node, ...props }: any) => <strong className={`font-bold ${isLightTheme ? 'text-emerald-700' : 'text-emerald-100'}`} {...props} />,
                                            em: ({ node, ...props }: any) => <em className={`italic ${isLightTheme ? 'text-emerald-700/80' : 'text-emerald-200/80'}`} {...props} />,
                                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                                            ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                                        }}
                                    >
                                        {part}
                                    </ReactMarkdown>
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        }

        // Standard text messages
        // We still want basic markdown support here too
        return (
            <div>
                {renderReviewBanner(msg)}
                <div className="markdown-content">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkMath]}
                        rehypePlugins={[rehypeKatex]}
                        components={{
                            p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0 whitespace-pre-wrap" {...props} />,
                            strong: ({ node, ...props }: any) => <strong className="font-bold opacity-100 overlay-text-strong" {...props} />,
                            em: ({ node, ...props }: any) => <em className="italic opacity-90 overlay-text-secondary" {...props} />,
                            ul: ({ node, ...props }: any) => <ul className="list-disc ml-4 mb-2 space-y-1" {...props} />,
                            ol: ({ node, ...props }: any) => <ol className="list-decimal ml-4 mb-2 space-y-1" {...props} />,
                            li: ({ node, ...props }: any) => <li className="pl-1" {...props} />,
                            code: ({ node, ...props }: any) => <code className={`overlay-inline-code-surface rounded px-1 py-0.5 text-xs font-mono ${isLightTheme ? 'text-slate-800' : ''}`} {...props} />,
                            a: ({ node, ...props }: any) => <a className="underline hover:opacity-80" target="_blank" rel="noopener noreferrer" {...props} />,
                        }}
                    >
                        {msg.text}
                    </ReactMarkdown>
                </div>
            </div>
        );
    };


    // We use a ref to hold the latest handlers to avoid re-binding the event listener on every render
    const handlersRef = useRef({
        handleWhatToSay,
        handleFollowUp,
        handleLiveHelp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow,
        handleClarify,
        handleCodeHint,
        handleBrainstorm
    });

    // Update ref on every render so the event listener always access latest state/props
    handlersRef.current = {
        handleWhatToSay,
        handleFollowUp,
        handleLiveHelp,
        handleFollowUpQuestions,
        handleRecap,
        handleAnswerNow,
        handleClarify,
        handleCodeHint,
        handleBrainstorm
    };

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const { handleWhatToSay, handleLiveHelp, handleRecap, handleAnswerNow, handleClarify, handleCodeHint, handleBrainstorm } = handlersRef.current;

            // Chat Shortcuts (Scope: Local to Chat/Overlay usually, but we allow them here if focused)
            if (isShortcutPressed(e, 'whatToAnswer')) {
                e.preventDefault();
                handleWhatToSay();
            } else if (isShortcutPressed(e, 'clarify')) {
                e.preventDefault();
                handleClarify();
            } else if (isShortcutPressed(e, 'followUp')) {
                e.preventDefault();
                handleLiveHelp();
            } else if (isShortcutPressed(e, 'dynamicAction4')) {
                e.preventDefault();
                if (actionButtonMode === 'brainstorm') {
                    handleBrainstorm();
                } else {
                    handleRecap();
                }
            } else if (isShortcutPressed(e, 'answer')) {
                e.preventDefault();
                handleAnswerNow();
            } else if (isShortcutPressed(e, 'clarify')) {
                e.preventDefault();
                handleClarify();
            } else if (isShortcutPressed(e, 'codeHint')) {
                e.preventDefault();
                handleCodeHint();
            } else if (isShortcutPressed(e, 'brainstorm')) {
                e.preventDefault();
                handleBrainstorm();
            } else if (isShortcutPressed(e, 'scrollUp')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'scrollDown')) {
                e.preventDefault();
                scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            } else if (isShortcutPressed(e, 'moveWindowUp') || isShortcutPressed(e, 'moveWindowDown')) {
                // Prevent default scrolling when moving window
                e.preventDefault();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isShortcutPressed]);

    // General Global Shortcuts (Rebindable)
    // We listen here to handle them when the window is focused (renderer side)
    // Global shortcuts (when window blurred) are handled by Main process -> GlobalShortcuts
    // But Main process events might not reach here if we don't listen, or we want unified handling.
    // Actually, KeybindManager registers global shortcuts. If they are registered as global, 
    // Electron might consume them before they reach here?
    // 'toggle-app' is Global.
    // 'toggle-visibility' is NOT Global in default config (isGlobal: false), so it depends on focus.
    // So we MUST listen for them here.

    const generalHandlersRef = useRef({
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        toggleMousePassthrough: () => {
            const newState = !isMousePassthrough;
            setIsMousePassthrough(newState);
            window.electronAPI?.setOverlayMousePassthrough?.(newState);
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering selective screenshot:", err);
            }
        }
    });

    // Update ref
    generalHandlersRef.current = {
        toggleVisibility: () => window.electronAPI.toggleWindow(),
        processScreenshots: handleWhatToSay,
        resetCancel: async () => {
            if (isProcessing) {
                setIsProcessing(false);
            } else {
                await window.electronAPI.resetIntelligence();
                setMessages([]);
                setAttachedContext([]);
                setInputValue('');
            }
        },
        toggleMousePassthrough: () => {
            const newState = !isMousePassthrough;
            setIsMousePassthrough(newState);
            window.electronAPI?.setOverlayMousePassthrough?.(newState);
        },
        takeScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeScreenshot();
                if (data && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering screenshot:", err);
            }
        },
        selectiveScreenshot: async () => {
            try {
                const data = await window.electronAPI.takeSelectiveScreenshot();
                if (data && !data.cancelled && data.path) {
                    handleScreenshotAttach(data as { path: string; preview: string });
                }
            } catch (err) {
                console.error("Error triggering selective screenshot:", err);
            }
        }
    };

    useEffect(() => {
        const handleGeneralKeyDown = (e: KeyboardEvent) => {
            const handlers = generalHandlersRef.current;
            const target = e.target as HTMLElement;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

            if (isShortcutPressed(e, 'toggleVisibility')) {
                // Always allow toggling visibility
                e.preventDefault();
                handlers.toggleVisibility();
            } else if (isShortcutPressed(e, 'processScreenshots')) {
                if (!isInput) {
                    e.preventDefault();
                    handlers.processScreenshots();
                }
                // If input focused, let default behavior (Enter) happen or handle it via onKeyDown in Input
            } else if (isShortcutPressed(e, 'resetCancel')) {
                e.preventDefault();
                handlers.resetCancel();
            } else if (isShortcutPressed(e, 'takeScreenshot')) {
                e.preventDefault();
                handlers.takeScreenshot();
            } else if (isShortcutPressed(e, 'selectiveScreenshot')) {
                e.preventDefault();
                handlers.selectiveScreenshot();
            } else if (isShortcutPressed(e, 'toggleMousePassthrough')) {
                e.preventDefault();
                handlers.toggleMousePassthrough();
            }
        };

        window.addEventListener('keydown', handleGeneralKeyDown);
        return () => window.removeEventListener('keydown', handleGeneralKeyDown);
    }, [isShortcutPressed]);

    // Global "Capture & Process" shortcut handler (issue #90)
    // Registered separately so it always has the latest handlersRef via stable ref access.
    // Main process takes the screenshot and sends "capture-and-process" with path+preview;
    // we attach the screenshot to context and immediately trigger AI analysis.
    useEffect(() => {
        if (!window.electronAPI.onCaptureAndProcess) return;
        const unsubscribe = window.electronAPI.onCaptureAndProcess((data) => {
            setIsExpanded(true);

            // Store screenshot in a stable ref BEFORE updating React state.
            // This fixes the React 18 concurrent mode timing race where setTimeout(0)
            // could fire before setAttachedContext had flushed, leaving handleWhatToSay
            // with an empty attachedContext and causing silent failures.
            pendingCaptureRef.current = data;

            setAttachedContext(prev => {
                if (prev.some(s => s.path === data.path)) return prev;
                return [...prev, data].slice(-5);
            });

            // Use requestAnimationFrame so we wait for at least one paint cycle —
            // more reliable than setTimeout(0) under React 18 concurrent scheduling.
            // The ref guarantees handleWhatToSay has the screenshot regardless of
            // whether the state update has flushed yet.
            requestAnimationFrame(() => {
                try {
                    handlersRef.current.handleWhatToSay();
                } finally {
                    pendingCaptureRef.current = null;
                }
            });
        });
        return unsubscribe;
    }, []);

    // Stealth Global Shortcuts Handler
    // Listens for shortcuts triggered when the app is in the background
    useEffect(() => {
        if (!window.electronAPI.onGlobalShortcut) return;
        const unsubscribe = window.electronAPI.onGlobalShortcut(({ action }) => {
            const handlers = handlersRef.current;
            const generalHandlers = generalHandlersRef.current;

            isStealthRef.current = true;

            if (action === 'whatToAnswer') handlers.handleWhatToSay();
            else if (action === 'shorten') handlers.handleFollowUp('shorten');
            else if (action === 'followUp') handlers.handleLiveHelp();
            else if (action === 'recap') handlers.handleRecap();
            else if (action === 'dynamicAction4') {
                if (actionButtonMode === 'brainstorm') handlers.handleBrainstorm();
                else handlers.handleRecap();
            }
            else if (action === 'answer') handlers.handleAnswerNow();
            else if (action === 'clarify') handlers.handleClarify();
            else if (action === 'codeHint') handlers.handleCodeHint();
            else if (action === 'brainstorm') handlers.handleBrainstorm();
            else if (action === 'scrollUp') scrollContainerRef.current?.scrollBy({ top: -100, behavior: 'smooth' });
            else if (action === 'scrollDown') scrollContainerRef.current?.scrollBy({ top: 100, behavior: 'smooth' });
            else if (action === 'processScreenshots') generalHandlers.processScreenshots();
            else if (action === 'resetCancel') generalHandlers.resetCancel();
            
            // Safety reset if it didn't trigger an expansion
            setTimeout(() => { isStealthRef.current = false; }, 500);
        });
        return unsubscribe;
    }, []);

    const readinessChipTargets = [
        { id: 'microphone', label: 'Mic' },
        { id: 'meeting_audio', label: 'Audio' },
        { id: 'prep', label: 'Prep' },
        { id: 'coach', label: 'Coach' },
    ];
    const readinessChipClass = (status?: RuntimeCheckStatus) => {
        if (status === 'ready') {
            return isLightTheme
                ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
                : 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300';
        }
        if (status === 'warming') {
            return isLightTheme
                ? 'border-sky-500/25 bg-sky-500/10 text-sky-700'
                : 'border-sky-400/25 bg-sky-400/10 text-sky-300';
        }
        if (status === 'failed') {
            return isLightTheme
                ? 'border-red-500/25 bg-red-500/10 text-red-700'
                : 'border-red-400/25 bg-red-400/10 text-red-300';
        }
        return isLightTheme
            ? 'border-amber-500/25 bg-amber-500/10 text-amber-700'
            : 'border-amber-400/25 bg-amber-400/10 text-amber-300';
    };

    return (
        <div ref={contentRef} className="flex flex-col items-center w-fit mx-auto h-fit min-h-0 bg-transparent p-0 rounded-[24px] font-sans gap-2 overlay-text-primary">
            <TopPill
                expanded={isExpanded}
                onToggle={() => setIsExpanded(!isExpanded)}
                onQuit={() => onEndMeeting ? onEndMeeting() : window.electronAPI.quitApp()}
                appearance={appearance}
                onLogoClick={() => window.electronAPI?.setWindowMode?.('launcher')}
            />

            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.95 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="flex flex-col items-center gap-2 w-full"
                    >
                        <div
                            className={`relative w-[600px] max-w-full backdrop-blur-2xl border rounded-[24px] overflow-hidden flex flex-col overlay-shell-surface ${overlayPanelClass}`}
                            style={appearance.shellStyle}
                        >




                            {/* Rolling Transcript Bar */}
                            {(rollingTranscript || isContextSpeaking) && showTranscript && (
                                <RollingTranscript
                                    text={rollingTranscript}
                                    isActive={isContextSpeaking}
                                    surfaceStyle={appearance.transcriptStyle}
                                />
                            )}

                            {/* Chat History - Only show if there are messages OR active states */}
                            {(messages.length > 0 || isManualRecording || isProcessing) && (
                                <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[clamp(300px,35vh,450px)] no-drag" style={{ scrollbarWidth: 'none' }}>
                                    {messages.map((msg) => {
                                        const messageCreatedAt = resolveMessageCreatedAt(msg, relativeAgeNow);
                                        const messageAge = formatRelativeAge(messageCreatedAt, relativeAgeNow);
                                        const isStaleMessage = relativeAgeNow - messageCreatedAt > 2 * 60 * 1000;
                                        return (
                                        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in-up`}>
                                            <div className={`
                      ${msg.role === 'user' ? 'max-w-[72.25%] px-[13.6px] py-[10.2px]' : 'max-w-[85%] px-4 py-3'} text-[14px] leading-relaxed relative group whitespace-pre-wrap
                      ${msg.role === 'user'
                                                    ? (isLightTheme
                                                        ? 'bg-blue-500/10 backdrop-blur-md border border-blue-500/20 text-blue-900 rounded-[20px] rounded-tr-[4px] shadow-sm font-medium'
                                                        : 'bg-blue-600/20 backdrop-blur-md border border-blue-500/30 text-blue-100 rounded-[20px] rounded-tr-[4px] shadow-sm font-medium')
                                                    : ''
                                                }
                      ${msg.role === 'system'
                                                    ? 'overlay-text-primary font-normal'
                                                    : ''
                                                }
                                                  ${msg.role === 'external'
                                                    ? 'overlay-text-muted italic pl-0 text-[13px]'
                                                    : ''
                                                }
                    `}>
                                                <div className={`mb-1 flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-wider ${msg.role === 'user' ? (isLightTheme ? 'text-blue-900/55' : 'text-blue-100/60') : 'overlay-text-muted'}`}>
                                                    <span className="inline-flex items-center gap-1.5">
                                                        {getMessageLabel(msg)}
                                                        {msg.isStreaming && <span className="w-1 h-1 bg-green-500 rounded-full animate-pulse" />}
                                                    </span>
                                                    <span className={isStaleMessage ? 'text-amber-400/90' : ''}>{messageAge}</span>
                                                </div>
                                                {msg.role === 'user' && msg.hasScreenshot && (
                                                    <div className={`flex items-center gap-1 text-[10px] opacity-70 mb-1 border-b pb-1 ${isLightTheme ? 'border-black/10' : 'border-white/10'}`}>
                                                        <Image className="w-2.5 h-2.5" />
                                                        <span>Screenshot attached</span>
                                                    </div>
                                                )}
                                                {renderReviewControls(msg)}
                                                {renderMessageText(msg)}
                                            </div>
                                        </div>
                                        );
                                    })}

                                    {/* Active Recording State with Live Transcription */}
                                    {isManualRecording && (
                                        <div className="flex flex-col items-end gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
                                            {/* Live transcription preview */}
                                            {(manualTranscript || voiceInput) && (
                                                <div className="max-w-[85%] px-3.5 py-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-[18px] rounded-tr-[4px]">
                                                    <span className="text-[13px] text-emerald-300">
                                                        {voiceInput}{voiceInput && manualTranscript ? ' ' : ''}{manualTranscript}
                                                    </span>
                                                </div>
                                            )}
                                            <div className="px-3 py-2 flex gap-1.5 items-center">
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                <div className="w-2 h-2 bg-emerald-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                <span className="text-[10px] text-emerald-400/70 ml-1">Listening...</span>
                                            </div>
                                        </div>
                                    )}

                                    {isProcessing && (
                                        <div className="flex justify-start">
                                            <div className="px-3 py-2 flex items-center gap-2 overlay-text-muted">
                                                <div className="flex gap-1.5">
                                                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                    <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                </div>
                                                <span className="text-[11px]">
                                                    {processingStatus || `Asking ${getDisplayModelName(currentModel) || 'the selected model'}...`}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                    <div ref={messagesEndRef} />
                                </div>
                            )}

                            {recentSpeakerChips.length > 0 && (
                                <div className="flex items-center gap-1.5 px-4 pt-2 pb-1 overflow-x-auto no-drag">
                                    {recentSpeakerChips.map((turn) => {
                                        const isEditing = editingSpeakerKey === turn.speakerKey;
                                        const isAssigned = Boolean(speakerLabels[turn.speakerKey]);
                                        const identityTint =
                                            turn.speakerIdentity === 'self'
                                                ? (isLightTheme ? 'text-blue-700 border-blue-500/25 bg-blue-500/10' : 'text-blue-200 border-blue-400/25 bg-blue-400/10')
                                                : turn.speakerIdentity === 'other'
                                                    ? (isLightTheme ? 'text-emerald-700 border-emerald-500/25 bg-emerald-500/10' : 'text-emerald-200 border-emerald-400/25 bg-emerald-400/10')
                                                    : (isLightTheme ? 'text-slate-700 border-slate-300 bg-slate-100/70' : 'text-slate-200 border-white/15 bg-white/10');

                                        if (isEditing) {
                                            return (
                                                <div key={turn.speakerKey} className={`flex items-center gap-1 rounded-full border px-2 py-1 ${identityTint}`}>
                                                    <input
                                                        value={editingSpeakerValue}
                                                        onChange={(event) => setEditingSpeakerValue(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') {
                                                                event.preventDefault();
                                                                saveSpeakerLabel(turn.speakerKey, editingSpeakerValue);
                                                            }
                                                            if (event.key === 'Escape') {
                                                                event.preventDefault();
                                                                cancelSpeakerLabelEdit();
                                                            }
                                                        }}
                                                        placeholder="Name"
                                                        autoFocus
                                                        className="w-20 bg-transparent text-[11px] font-semibold outline-none placeholder:opacity-50"
                                                    />
                                                    <button
                                                        onClick={() => saveSpeakerLabel(turn.speakerKey, editingSpeakerValue)}
                                                        className="rounded-full p-0.5 hover:bg-white/10"
                                                        title="Save speaker label"
                                                    >
                                                        <Check className="w-3 h-3" />
                                                    </button>
                                                    <button
                                                        onClick={cancelSpeakerLabelEdit}
                                                        className="rounded-full p-0.5 hover:bg-white/10"
                                                        title="Cancel"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </div>
                                            );
                                        }

                                        return (
                                            <button
                                                key={turn.speakerKey}
                                                onClick={() => beginSpeakerLabelEdit(turn)}
                                                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all hover:scale-[1.02] ${identityTint}`}
                                                title={isAssigned ? 'Rename this speaker for this meeting' : 'Name this speaker for this meeting'}
                                            >
                                                <Mic className="w-3 h-3 opacity-70" />
                                                <span>{turn.speakerLabel}</span>
                                                {speakerLabelSavingKey === turn.speakerKey ? (
                                                    <RefreshCw className="w-3 h-3 animate-spin opacity-70" />
                                                ) : (
                                                    <Edit3 className="w-3 h-3 opacity-50" />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Quick Actions - Minimal & Clean */}
                            <div className={`flex flex-nowrap justify-center items-center gap-1.5 px-4 pb-3 overflow-x-hidden ${rollingTranscript && showTranscript ? 'pt-1' : 'pt-3'}`}>
                                <button onClick={handleWhatToSay} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`} style={appearance.chipStyle}>
                                    <Pencil className="w-3 h-3 opacity-70" /> Draft Reply
                                </button>
                                <button onClick={handleClarify} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`} style={appearance.chipStyle}>
                                    <MessageSquare className="w-3 h-3 opacity-70" /> Clarify Context
                                </button>
                                <button onClick={actionButtonMode === 'brainstorm' ? handleBrainstorm : handleRecap} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`} style={appearance.chipStyle}>
                                    {actionButtonMode === 'brainstorm'
                                        ? <><Lightbulb className="w-3 h-3 opacity-70" /> Explore Options</>
                                        : <><RefreshCw className="w-3 h-3 opacity-70" /> Summarize</>
                                    }
                                </button>
                                <button onClick={handleLiveHelp} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium border transition-all active:scale-95 duration-200 interaction-base interaction-press whitespace-nowrap shrink-0 ${quickActionClass}`} style={appearance.chipStyle}>
                                    <HelpCircle className="w-3 h-3 opacity-70" /> Help
                                </button>
                                <button
                                    onClick={handleAnswerNow}
                                    className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all active:scale-95 duration-200 interaction-base interaction-press min-w-[74px] whitespace-nowrap shrink-0 ${isManualRecording
                                        ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20'
                                        : 'overlay-chip-surface overlay-text-interactive hover:text-emerald-500 hover:bg-emerald-500/10'
                                        }`}
                                    style={isManualRecording ? undefined : appearance.chipStyle}
                                >
                                    {isManualRecording ? (
                                        <>
                                            <div className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
                                            Stop
                                        </>
                                    ) : (
                                        <><Zap className="w-3 h-3 opacity-70" /> Voice Ask</>
                                    )}
                                </button>
                            </div>

                            {/* Input Area */}
                            <div className="p-3 pt-0">
                                {/* Latent Context Preview (Attached Screenshot) */}
                                {attachedContext.length > 0 && (
                                    <div className={`mb-2 rounded-lg p-2 transition-all duration-200 border ${subtleSurfaceClass}`} style={appearance.subtleStyle}>
                                        <div className="flex items-center justify-between mb-1.5">
                                            <span className="text-[11px] font-medium overlay-text-primary">
                                                {attachedContext.length} screenshot{attachedContext.length > 1 ? 's' : ''} attached
                                            </span>
                                            <button
                                                onClick={() => setAttachedContext([])}
                                                className="p-1 rounded-full transition-colors overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive"
                                                title="Remove all"
                                                style={appearance.iconStyle}
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                        <div className="flex gap-1.5 overflow-x-auto max-w-full pb-1">
                                            {attachedContext.map((ctx, idx) => (
                                                <div key={ctx.path} className="relative group/thumb flex-shrink-0">
                                                    <img
                                                        src={ctx.preview}
                                                        alt={`Screenshot ${idx + 1}`}
                                                        className={`h-10 w-auto rounded border ${isLightTheme ? 'border-black/15' : 'border-white/20'}`}
                                                    />
                                                    <button
                                                        onClick={() => setAttachedContext(prev => prev.filter((_, i) => i !== idx))}
                                                        className="absolute -top-1 -right-1 w-4 h-4 bg-red-500/80 hover:bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                                                        title="Remove"
                                                    >
                                                        <X className="w-2.5 h-2.5 text-white" />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                        <span className="text-[10px] overlay-text-muted">Ask a question or click Ask AI</span>
                                    </div>
                                )}

                                {meetingReadiness && (
                                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                                        {readinessChipTargets.map((target) => {
                                            const check = meetingReadiness.checks?.find((item) => item.id === target.id);
                                            return (
                                                <div
                                                    key={target.id}
                                                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] ${readinessChipClass(check?.status)}`}
                                                    title={check?.detail || target.label}
                                                >
                                                    <span className={`h-1.5 w-1.5 rounded-full ${check?.status === 'ready' ? 'bg-emerald-400' : check?.status === 'failed' ? 'bg-red-400' : check?.status === 'warming' ? 'bg-sky-400 animate-pulse' : 'bg-amber-400'}`} />
                                                    <span>{target.label}</span>
                                                    <span className="opacity-75">{compactReadinessLabel(check?.status)}</span>
                                                </div>
                                            );
                                        })}
                                        <span className="ml-auto text-[10px] overlay-text-muted whitespace-nowrap">
                                            {formatReadinessAge(meetingReadiness.generatedAt)}
                                        </span>
                                    </div>
                                )}

                                <div className="relative group">
                                    <input
                                        ref={textInputRef}
                                        type="text"
                                        value={inputValue}
                                        onChange={(e) => setInputValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                void handleManualSubmit();
                                            }
                                        }}

                                        className={`w-full border focus:ring-1 rounded-xl pl-3 pr-10 py-2.5 focus:outline-none transition-all duration-200 ease-sculpted text-[13px] leading-relaxed ${inputClass}`}
                                        style={appearance.inputStyle}
                                    />

                                    {/* Custom Rich Placeholder */}
                                    {!inputValue && (
                                        <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none text-[13px] overlay-text-muted">
                                            <span>Ask anything on screen or conversation, or</span>
                                            <div className="flex items-center gap-1 opacity-80">
                                                {(shortcuts.selectiveScreenshot || ['⌘', 'Shift', 'H']).map((key, i) => (
                                                    <React.Fragment key={i}>
                                                        {i > 0 && <span className="text-[10px]">+</span>}
                                                        <kbd className="px-1.5 py-0.5 rounded border text-[10px] font-sans min-w-[20px] text-center overlay-control-surface overlay-text-secondary" style={appearance.controlStyle}>{key}</kbd>
                                                    </React.Fragment>
                                                ))}
                                            </div>
                                            <span>for selective screenshot</span>
                                        </div>
                                    )}

                                    {!inputValue && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1 pointer-events-none opacity-20">
                                            <span className="text-[10px]">↵</span>
                                        </div>
                                    )}
                                </div>

                                {/* Bottom Row */}
                                <div className="flex items-center justify-between mt-3 px-0.5">
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={(e) => {
                                                // Calculate position for detached window
                                                const buttonRect = e.currentTarget.getBoundingClientRect();
                                                const GAP = 8;

                                                const x = window.screenX + buttonRect.left;
                                                const y = window.screenY + buttonRect.bottom + GAP;

                                                window.electronAPI.toggleModelSelector({ x, y });
                                            }}
                                            className={`
                                                flex items-center gap-2 px-3 py-1.5
                                                border rounded-lg transition-colors
                                                text-xs font-medium w-[140px]
                                                interaction-base interaction-press
                                                ${controlSurfaceClass}
                                            `}
                                            style={appearance.controlStyle}
                                        >
                                            <span className="truncate min-w-0 flex-1">
                                                {getDisplayModelName(currentModel) || 'Select model'}
                                            </span>
                                            <ChevronDown size={14} className="shrink-0 transition-transform" />
                                        </button>

                                        <div className="w-px h-3 mx-1" style={appearance.dividerStyle} />

                                        {/* Dashboard Button */}
                                        <div className="relative">
                                            <button
                                                onClick={() => window.electronAPI?.setWindowMode?.('launcher')}
                                                className={`
                                                    flex items-center gap-1.5 px-2.5 py-1.5
                                                    border rounded-lg transition-colors
                                                    text-xs font-medium
                                                    interaction-base interaction-press
                                                    ${controlSurfaceClass}
                                                `}
                                                style={appearance.controlStyle}
                                                title="Open Natively dashboard"
                                            >
                                                <LayoutDashboard className="w-3.5 h-3.5 shrink-0" />
                                                <span>Dashboard</span>
                                            </button>
                                        </div>

                                        <div className="w-px h-3 mx-1" style={appearance.dividerStyle} />

                                        <div className="relative">
                                            <button
                                                onClick={(e) => {
                                                    if (isSettingsOpen) {
                                                        // If open, just close it (toggle will handle logic but we can be explicit or just toggle)
                                                        // Actually toggle-settings-window handles hiding if visible, so logic is same.
                                                        window.electronAPI.toggleSettingsWindow();
                                                        return;
                                                    }

                                                    if (!contentRef.current) return;

                                                    const contentRect = contentRef.current.getBoundingClientRect();
                                                    const buttonRect = e.currentTarget.getBoundingClientRect();
                                                    const POPUP_WIDTH = 270; // Matches SettingsWindowHelper actual width
                                                    const GAP = 8; // Same gap as between TopPill and main body (gap-2 = 8px)

                                                    // X: Left-aligned relative to the Settings Button
                                                    const x = window.screenX + buttonRect.left;

                                                    // Y: Below the main content + gap
                                                    const y = window.screenY + contentRect.bottom + GAP;

                                                    window.electronAPI.toggleSettingsWindow({ x, y });
                                                }}
                                                className={`
                                            w-7 h-7 flex items-center justify-center rounded-lg
                                            interaction-base interaction-press
                                            ${isSettingsOpen
                                                    ? 'overlay-icon-surface overlay-icon-surface-hover overlay-text-primary'
                                                    : 'overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive'}
                                        `}

                                                style={appearance.iconStyle}
                                            >
                                                <SlidersHorizontal className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                        <div className="w-px h-3 mx-1" style={appearance.dividerStyle} />

                                        {/* Theme Toggle */}
                                        <div className="relative">
                                            <button
                                                onClick={toggleThemeMode}
                                                className="
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    interaction-base interaction-press
                                                    overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive
                                                "
                                                style={appearance.iconStyle}
                                                title={isLightTheme ? 'Switch to dark mode' : 'Switch to light mode'}
                                            >
                                                {isLightTheme
                                                    ? <Moon className="w-3.5 h-3.5" />
                                                    : <Sun className="w-3.5 h-3.5" />}
                                            </button>
                                        </div>

                                        {/* Proactive Coaching Toggle */}
                                        <div className="relative">
                                            <button
                                                onClick={toggleProactiveMode}
                                                className={`
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    interaction-base interaction-press
                                                    overlay-icon-surface overlay-icon-surface-hover
                                                    ${isProactiveMode ? 'text-emerald-500 opacity-100' : 'overlay-text-interactive'}
                                                `}
                                                style={{
                                                    ...appearance.iconStyle,
                                                    ...(isProactiveMode ? { boxShadow: isLightTheme ? '0 0 0 1px rgba(16, 185, 129, 0.35)' : '0 0 0 1px rgba(52, 211, 153, 0.35)' } : {})
                                                }}
                                                title={isProactiveMode ? 'Proactive meeting coaching is on' : 'Turn on proactive meeting coaching'}
                                            >
                                                <Radio className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                        {/* Undetectable Toggle */}
                                        <div className="relative">
                                            <button
                                                onClick={toggleUndetectableMode}
                                                className={`
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    interaction-base interaction-press
                                                    overlay-icon-surface overlay-icon-surface-hover
                                                    ${isUndetectable ? 'text-cyan-500 opacity-100' : 'overlay-text-interactive'}
                                                `}
                                                style={{
                                                    ...appearance.iconStyle,
                                                    ...(isUndetectable ? { boxShadow: isLightTheme ? '0 0 0 1px rgba(6, 182, 212, 0.34)' : '0 0 0 1px rgba(34, 211, 238, 0.35)' } : {})
                                                }}
                                                title={isUndetectable ? 'Screen-share hiding is on' : 'Hide Natively from screen captures'}
                                            >
                                                <Ghost className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                        <div className="w-px h-3 mx-1" style={appearance.dividerStyle} />

                                        {/* Mouse Passthrough Toggle */}
                                        <div className="relative">
                                            <button
                                                onClick={() => {
                                                    const newState = !isMousePassthrough;
                                                    setIsMousePassthrough(newState);
                                                    window.electronAPI?.setOverlayMousePassthrough?.(newState);
                                                }}
                                                className={`
                                                    w-7 h-7 flex items-center justify-center rounded-lg
                                                    interaction-base interaction-press
                                                    ${isMousePassthrough
                                                        ? 'overlay-icon-surface overlay-icon-surface-hover text-sky-400 opacity-100'
                                                        : 'overlay-icon-surface overlay-icon-surface-hover overlay-text-interactive'}
                                                `}

                                                style={appearance.iconStyle}
                                            >
                                                <PointerOff className="w-3.5 h-3.5" />
                                            </button>
                                        </div>

                                    </div>

                                    <button
                                        onClick={handleManualSubmit}
                                        disabled={!inputValue.trim() && attachedContext.length === 0}
                                    className={`
                                    w-7 h-7 rounded-full flex items-center justify-center
                                    interaction-base interaction-press
                                    ${inputValue.trim() || attachedContext.length > 0
                                                ? 'bg-[#007AFF] text-white shadow-lg shadow-blue-500/20 hover:bg-[#0071E3]'
                                                : 'overlay-icon-surface overlay-text-muted cursor-not-allowed'
                                            }
                                `}
                                    style={inputValue.trim() || attachedContext.length > 0 ? undefined : appearance.iconStyle}
                                    >
                                        <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default NativelyInterface;
