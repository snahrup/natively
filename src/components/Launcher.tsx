import React, { useState, useEffect, useRef } from 'react';
import { ToggleLeft, ToggleRight, Search, Zap, Calendar, ArrowRight, ArrowLeft, MoreHorizontal, Globe, Clock, ChevronRight, Settings, RefreshCw, Eye, EyeOff, Ghost, Plus, Mail, Link as LinkIcon, ChevronDown, Trash2, Bell, Check, Download, DownloadCloud, CheckCircle, AlertCircle, MessageSquare, Monitor, Activity, Mic, Speaker } from 'lucide-react';
import { generateMeetingPDF } from '../utils/pdfGenerator';
import icon from "./icon.png";
import MeetingDetails from './MeetingDetails';
import TopSearchPill from './TopSearchPill';
import GlobalChatOverlay from './GlobalChatOverlay';
import { motion, AnimatePresence } from 'framer-motion';
import { analytics } from '../lib/analytics/analytics.service'; // Added analytics import
import { useShortcuts } from '../hooks/useShortcuts';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import { isMac } from '../utils/platformUtils';
import { getDisplayModelName } from '../utils/modelUtils';
import WindowControls from './WindowControls';

interface Meeting {
    id: string;
    title: string;
    date: string;
    duration: string;
    summary: string;
    source?: 'manual' | 'calendar' | 'teams' | 'cluely' | 'imported';
    importMetadata?: {
        sourceFormat?: 'cluely' | 'teams' | 'generic';
        importedAt?: string;
        fidelity?: string;
    };
    detailedSummary?: {
        actionItems: string[];
        keyPoints: string[];
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: Array<{
        type: 'assist' | 'followup' | 'chat' | 'followup_questions';
        timestamp: number;
        question?: string;
        answer?: string;
        items?: string[];
    }>;
    active?: boolean; // UI state
    time?: string; // Optional for compatibility
}

interface UpcomingEvent {
    id: string;
    title: string;
    startTime: string;
    endTime: string;
    link?: string;
    description?: string;
    location?: string;
    attendees?: Array<{
        email: string;
        displayName?: string;
    }>;
    source: 'google' | 'outlook';
}

interface MeetingPrepPacket {
    event: UpcomingEvent;
    generatedAt: string;
    timing: {
        startsInMinutes: number;
        durationMinutes: number;
    };
    sourceHealth: {
        calendar: boolean;
        memory: boolean;
        backgroundContext: boolean;
        roleBrief: boolean;
        liveResearch: boolean;
    };
    summary: string;
    contextBullets: string[];
    profileSnapshot: string[];
    relatedMeetings: Array<{
        id: string;
        title: string;
        date: string;
        summary: string;
        matchScore: number;
    }>;
    memoryHighlights: Array<{
        title: string;
        excerpt: string;
        source: string;
        type: string;
        date?: string;
        score: number;
    }>;
    prepChecklist: string[];
    openQuestions: string[];
    openCommitments: string[];
}

interface BrainActionProposal {
    id: string;
    type: string;
    title: string;
    summary: string;
    status: string;
    createdAt: string;
    updatedAt?: string;
    payload?: Record<string, any>;
    evidenceRefs?: string[];
    relatedInsightIds?: string[];
    workflowRun?: {
        id: string;
        state: string;
        updatedAt?: string;
    };
}

const prepHealthLabels: Record<keyof MeetingPrepPacket['sourceHealth'], string> = {
    calendar: 'Calendar',
    memory: 'Memory',
    backgroundContext: 'Background',
    roleBrief: 'Role Brief',
    liveResearch: 'Live Research',
};

const prepHealthKeys: Array<keyof MeetingPrepPacket['sourceHealth']> = [
    'calendar',
    'memory',
    'backgroundContext',
    'roleBrief',
    'liveResearch',
];

interface LauncherProps {
    onStartMeeting: () => void;
    onOpenSettings: (tab?: string) => void;
    onPageChange?: (isMain: boolean) => void;
    ollamaPullStatus?: 'idle' | 'downloading' | 'complete' | 'failed';
    ollamaPullPercent?: number;
    ollamaPullMessage?: string;
}

// Helper to format date groups
const getGroupLabel = (dateStr: string) => {
    if (dateStr === "Today") return "Today"; // Backward compatibility

    const date = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const checkDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (checkDate.getTime() === today.getTime()) return "Today";
    if (checkDate.getTime() === yesterday.getTime()) return "Yesterday";

    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

// Helper to format time (e.g. 3:14pm)
const formatTime = (dateStr: string) => {
    if (dateStr === "Today") return "Just now"; // Legacy
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
};

const formatFreshness = (dateStr?: string | null) => {
    if (!dateStr) return 'No signal yet';
    const value = new Date(dateStr);
    if (Number.isNaN(value.getTime())) return 'No signal yet';

    const diffMs = Date.now() - value.getTime();
    const diffMinutes = Math.max(0, Math.round(diffMs / 60000));

    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes} min ago`;

    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} hr ago`;

    const diffDays = Math.round(diffHours / 24);
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
};

const formatPrepTimestamp = (dateStr?: string | null) => {
    if (!dateStr) return 'Just now';
    const value = new Date(dateStr);
    if (Number.isNaN(value.getTime())) return 'Just now';

    return value.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
};

const formatPrepSourceLabel = (value: string) =>
    value
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());

const getMeetingSourceBadge = (meeting: Meeting) => {
    switch (meeting.source) {
        case 'calendar':
            return { label: 'Calendar', className: 'bg-blue-500/10 text-blue-400 border-blue-500/20' };
        case 'teams':
            return { label: 'Teams Import', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' };
        case 'cluely':
            return { label: 'Cluely Import', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20' };
        case 'imported':
            return { label: 'Imported', className: 'bg-violet-500/10 text-violet-400 border-violet-500/20' };
        default:
            return { label: 'Natively', className: 'bg-bg-elevated text-text-secondary border-border-subtle' };
    }
};

type ReadinessCheckStatus = 'ready' | 'warming' | 'warning' | 'failed';

interface MeetingReadinessStatus {
    generatedAt?: string;
    overall?: ReadinessCheckStatus;
    meetingActive?: boolean;
    proactiveModeEnabled?: boolean;
    model?: string | null;
    reasoningEffort?: string | null;
    prep?: any;
    audio?: any;
    checks?: Array<{
        id: string;
        label: string;
        status: ReadinessCheckStatus;
        detail: string;
    }>;
}

interface AudioDeviceOption {
    id: string;
    name: string;
}

const readinessLabel = (status?: ReadinessCheckStatus) => {
    switch (status) {
        case 'ready':
            return 'Ready';
        case 'warming':
            return 'Warming';
        case 'failed':
            return 'Blocked';
        case 'warning':
        default:
            return 'Needs attention';
    }
};

const readinessStyles = (status?: ReadinessCheckStatus, isLight = false) => {
    if (status === 'ready') {
        return isLight
            ? 'border-emerald-500/25 bg-emerald-500/8 text-emerald-700'
            : 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300';
    }
    if (status === 'warming') {
        return isLight
            ? 'border-sky-500/25 bg-sky-500/8 text-sky-700'
            : 'border-sky-400/25 bg-sky-400/10 text-sky-300';
    }
    if (status === 'failed') {
        return isLight
            ? 'border-red-500/25 bg-red-500/8 text-red-700'
            : 'border-red-400/25 bg-red-400/10 text-red-300';
    }
    return isLight
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-700'
        : 'border-amber-400/25 bg-amber-400/10 text-amber-300';
};

const formatReadinessAge = (iso?: string | null) => {
    if (!iso) return 'never';
    const elapsedMs = Math.max(0, Date.now() - new Date(iso).getTime());
    const seconds = Math.floor(elapsedMs / 1000);
    if (seconds < 5) return 'now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
};

const readinessActionGuides: Record<string, { meaning: string; fix: string }> = {
    brain: {
        meaning: 'This is the durable IP Corp context Natively should use before it answers or prepares for a meeting.',
        fix: 'Reload the brain context. If it is blocked, confirm the IP Corp brain repo exists on this machine and then refresh this panel.',
    },
    prep: {
        meaning: 'This shows whether Natively has already built the short meeting packet it should use in the next live session.',
        fix: 'Refresh the meeting list, then prepare the upcoming meeting so the live coach does not have to scan broad context during the call.',
    },
    microphone: {
        meaning: 'This proves Natively can hear you. Green means recent microphone audio reached the app.',
        fix: 'Select the microphone you actually want, run a voice check, and confirm Windows or your headset has not muted the device.',
    },
    meeting_audio: {
        meaning: 'This proves Natively can hear the other people or system audio in the meeting.',
        fix: 'Select the output device Teams or Zoom is using. If this changes during a meeting, restart the widget so capture rebinds cleanly.',
    },
    transcripts: {
        meaning: 'This proves audio is turning into usable text. Proactive guidance depends on this more than raw audio alone.',
        fix: 'Open audio settings and confirm the speech provider/key is saved, then start the widget and watch for transcript activity.',
    },
    coach: {
        meaning: 'This tells you whether the proactive coach is enabled and recently generated something useful.',
        fix: 'Turn proactive mode on, start the widget, and keep the mic/transcript checks green for real-time guidance.',
    },
    screen: {
        meaning: 'This confirms Natively can attach or read screen context when you ask about what is visible.',
        fix: 'Run a quick screen check or open Meeting AI settings to enable always-on screen watch.',
    },
};

const Launcher: React.FC<LauncherProps> = ({ onStartMeeting, onOpenSettings, onPageChange, ollamaPullStatus = 'idle', ollamaPullPercent = 0, ollamaPullMessage = '' }) => {
    const [meetings, setMeetings] = useState<Meeting[]>([]);
    const [isDetectable, setIsDetectable] = useState(false);
    const [isMeetingActive, setIsMeetingActive] = useState(false);
    const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
    const [upcomingEvents, setUpcomingEvents] = useState<UpcomingEvent[]>([]);
    const [isPrepared, setIsPrepared] = useState(false);
    const [preparedEvent, setPreparedEvent] = useState<UpcomingEvent | null>(null);
    const [preparedPacket, setPreparedPacket] = useState<MeetingPrepPacket | null>(null);
    const [isPreparing, setIsPreparing] = useState(false);
    const [prepareError, setPrepareError] = useState('');
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [showNotification, setShowNotification] = useState(false);
    const [contextHubOverview, setContextHubOverview] = useState<any>(null);
    const [contextHubBusy, setContextHubBusy] = useState(false);
    const [meetingReadiness, setMeetingReadiness] = useState<MeetingReadinessStatus | null>(null);
    const [readinessBusy, setReadinessBusy] = useState(false);
    const [selectedReadinessCheckId, setSelectedReadinessCheckId] = useState<string | null>(null);
    const [inputDeviceOptions, setInputDeviceOptions] = useState<AudioDeviceOption[]>([]);
    const [outputDeviceOptions, setOutputDeviceOptions] = useState<AudioDeviceOption[]>([]);
    const [selectedInputDeviceId, setSelectedInputDeviceId] = useState(() => localStorage.getItem('preferredInputDeviceId') || '');
    const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState(() => localStorage.getItem('preferredOutputDeviceId') || '');
    const [audioDeviceBusy, setAudioDeviceBusy] = useState(false);
    const [voiceCheckActive, setVoiceCheckActive] = useState(false);
    const [readinessActionMessage, setReadinessActionMessage] = useState('');
    const [brainActionProposals, setBrainActionProposals] = useState<BrainActionProposal[]>([]);
    const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
    const [proposalNotice, setProposalNotice] = useState('');
    const prepBriefRef = useRef<HTMLElement | null>(null);

    // Global search state (for AI chat overlay)
    const [isGlobalChatOpen, setIsGlobalChatOpen] = useState(false);
    const [submittedGlobalQuery, setSubmittedGlobalQuery] = useState('');

    const fetchMeetings = () => {
        if (window.electronAPI && window.electronAPI.getRecentMeetings) {
            window.electronAPI.getRecentMeetings().then(setMeetings).catch(err => console.error("Failed to fetch meetings:", err));
        }
    };

    const fetchEvents = () => {
        if (window.electronAPI && window.electronAPI.getUpcomingEvents) {
            window.electronAPI.getUpcomingEvents().then(setUpcomingEvents).catch(err => console.error("Failed to fetch events:", err));
        }
    }

    const fetchContextHubOverview = async () => {
        if (!window.electronAPI?.getContextHubStatus) return;
        try {
            setContextHubBusy(true);
            const status = await window.electronAPI.getContextHubStatus();
            setContextHubOverview(status || null);
            if (window.electronAPI?.listBrainActionProposals) {
                const proposals = await window.electronAPI.listBrainActionProposals(8);
                setBrainActionProposals((proposals || [])
                    .filter((proposal: BrainActionProposal) => ['proposed', 'snoozed'].includes(proposal.status || 'proposed'))
                    .slice(0, 4));
            }
        } catch (err) {
            console.error("Failed to fetch context hub overview:", err);
        } finally {
            setContextHubBusy(false);
        }
    };

    const fetchMeetingReadiness = async () => {
        if (!window.electronAPI?.getMeetingReadinessStatus) return;
        try {
            setReadinessBusy(true);
            const status = await window.electronAPI.getMeetingReadinessStatus();
            setMeetingReadiness(status || null);
        } catch (err) {
            console.error("Failed to fetch meeting readiness:", err);
        } finally {
            setReadinessBusy(false);
        }
    };

    const handleBrainProposalDecision = async (proposal: BrainActionProposal, decision: 'approved' | 'rejected' | 'snoozed') => {
        if (!window.electronAPI?.recordBrainActionOutcome) return;
        setProposalBusyId(proposal.id);
        setProposalNotice('');
        try {
            await window.electronAPI.recordBrainActionOutcome({
                proposalId: proposal.id,
                decision,
                finalPayload: proposal.payload,
                learningSignals: [
                    `Steve ${decision} ${proposal.type} proposal ${proposal.id}.`,
                ],
            });
            setProposalNotice(`${proposal.title}: ${decision} recorded to the brain outcome ledger.`);
            setBrainActionProposals((current) => current.filter((item) => item.id !== proposal.id));
            fetchContextHubOverview().catch(() => { });
        } catch (error) {
            console.error('Failed to record brain action outcome:', error);
            setProposalNotice(`${proposal.title}: failed to record outcome.`);
        } finally {
            setProposalBusyId(null);
        }
    };

    const handleBrainProposalExecute = async (proposal: BrainActionProposal) => {
        if (!window.electronAPI?.executeBrainActionProposal) return;
        setProposalBusyId(proposal.id);
        setProposalNotice('');
        try {
            const result = await window.electronAPI.executeBrainActionProposal({
                proposalId: proposal.id,
                payload: proposal.payload,
            });
            if (!result?.success) {
                throw new Error(result?.error || 'Action execution failed.');
            }
            setProposalNotice(`${proposal.title}: ${result.summary || 'executed'}`);
            setBrainActionProposals((current) => current.filter((item) => item.id !== proposal.id));
            fetchContextHubOverview().catch(() => { });
        } catch (error: any) {
            console.error('Failed to execute brain action proposal:', error);
            setProposalNotice(`${proposal.title}: ${error?.message || 'execution failed.'}`);
        } finally {
            setProposalBusyId(null);
        }
    };

    const handleRefresh = async () => {
        setIsRefreshing(true);
        analytics.trackCommandExecuted('refresh_calendar');
        try {
            if (window.electronAPI && window.electronAPI.calendarRefresh) {
                setShowNotification(true);
                await window.electronAPI.calendarRefresh();
                fetchEvents();
                fetchMeetings();
                fetchContextHubOverview().catch(() => { });
                fetchMeetingReadiness().catch(() => { });
                setTimeout(() => {
                    setShowNotification(false);
                }, 3000);
            } else {
                console.warn("electronAPI.calendarRefresh not found");
            }
        } catch (e) {
            console.error("Refresh failed in handleRefresh:", e);
        } finally {
            // Ensure distinct feedback provided (min 500ms spin)
            setTimeout(() => setIsRefreshing(false), 500);
        }
    };

    const handleOpenChatLogViewer = () => {
        analytics.trackCommandExecuted('open_chat_log_viewer');
        window.electronAPI?.openChatLogViewer?.().catch((err) => {
            console.error('Failed to open chat log viewer:', err);
        });
    };

    // Keybinds
    const { isShortcutPressed } = useShortcuts();
    const isLight = useResolvedTheme() === 'light';
    const readinessActionButtonClass = `rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
        isLight
            ? 'border-black/10 bg-white/80 text-text-primary hover:bg-black/[0.04]'
            : 'border-white/10 bg-white/6 text-text-primary hover:bg-white/10'
    }`;
    const readinessPrimaryButtonClass = 'rounded-full border border-blue-500/30 bg-blue-500 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-blue-500/20 transition-colors hover:bg-blue-400';

    const setTimedReadinessMessage = (message: string) => {
        setReadinessActionMessage(message);
        window.setTimeout(() => setReadinessActionMessage(''), 3500);
    };

    const loadAudioDevices = async () => {
        if (!window.electronAPI) return;
        setAudioDeviceBusy(true);
        try {
            const [inputs, outputs] = await Promise.all([
                window.electronAPI.getInputDevices?.() || Promise.resolve([]),
                window.electronAPI.getOutputDevices?.() || Promise.resolve([]),
            ]);
            setInputDeviceOptions(inputs || []);
            setOutputDeviceOptions(outputs || []);

            const savedInput = localStorage.getItem('preferredInputDeviceId') || '';
            const savedOutput = localStorage.getItem('preferredOutputDeviceId') || '';
            setSelectedInputDeviceId(savedInput || inputs?.[0]?.id || '');
            setSelectedOutputDeviceId(savedOutput || outputs?.[0]?.id || '');
        } catch (error) {
            console.error('Failed to load audio devices:', error);
            setTimedReadinessMessage('Could not load audio devices from Windows right now.');
        } finally {
            setAudioDeviceBusy(false);
        }
    };

    const handleReadinessCardClick = (checkId: string) => {
        setSelectedReadinessCheckId((current) => current === checkId ? null : checkId);
        setReadinessActionMessage('');
        if (checkId === 'microphone' || checkId === 'meeting_audio') {
            loadAudioDevices().catch(() => { });
        }
    };

    const savePreferredAudioDevice = (kind: 'input' | 'output', deviceId: string) => {
        if (kind === 'input') {
            setSelectedInputDeviceId(deviceId);
            localStorage.setItem('preferredInputDeviceId', deviceId);
            setTimedReadinessMessage('Microphone saved. The widget will use it the next time listening starts.');
        } else {
            setSelectedOutputDeviceId(deviceId);
            localStorage.setItem('preferredOutputDeviceId', deviceId);
            setTimedReadinessMessage('Meeting audio device saved. Restart the widget if a meeting is already running.');
        }
        fetchMeetingReadiness().catch(() => { });
    };

    const toggleVoiceCheck = async () => {
        try {
            if (voiceCheckActive) {
                await window.electronAPI?.stopMicSTT?.();
                setVoiceCheckActive(false);
                setTimedReadinessMessage('Voice check stopped.');
            } else {
                const result = await window.electronAPI?.startMicSTT?.();
                if (result?.success === false) throw new Error(result.error || 'Voice check failed.');
                setVoiceCheckActive(true);
                setTimedReadinessMessage('Voice check started. Speak normally and watch the microphone status refresh.');
            }
            window.setTimeout(() => fetchMeetingReadiness().catch(() => { }), 800);
        } catch (error: any) {
            setTimedReadinessMessage(error?.message || 'Voice check could not start.');
        }
    };

    const reloadBrainForReadiness = async () => {
        try {
            const result = await window.electronAPI?.reloadMeetingMemory?.();
            if (result?.success === false) throw new Error(result.error || 'Brain reload failed.');
            setTimedReadinessMessage(result?.chunks ? `Brain reloaded with ${result.chunks} context chunks.` : 'Brain context reloaded.');
            await Promise.all([fetchContextHubOverview(), fetchMeetingReadiness()]);
        } catch (error: any) {
            setTimedReadinessMessage(error?.message || 'Brain reload failed.');
        }
    };

    const enableProactiveCoach = async () => {
        try {
            const result = await window.electronAPI?.setProactiveMode?.(true);
            if (result?.success === false) throw new Error(result.error || 'Could not enable proactive mode.');
            setTimedReadinessMessage('Proactive mode is on. Start the widget for live coaching.');
            fetchMeetingReadiness().catch(() => { });
        } catch (error: any) {
            setTimedReadinessMessage(error?.message || 'Could not enable proactive mode.');
        }
    };

    const runScreenCheck = async () => {
        try {
            await window.electronAPI?.takeContextScreenshot?.();
            setTimedReadinessMessage('Screen check captured. The widget can attach current screen context.');
            fetchMeetingReadiness().catch(() => { });
        } catch (error: any) {
            setTimedReadinessMessage(error?.message || 'Screen capture failed.');
        }
    };

    useEffect(() => {
        let mounted = true;
        console.log("Launcher mounted");
        // Seed demo data if needed (safe to call always — runs ONCE on mount)
        if (window.electronAPI && window.electronAPI.seedDemo) {
            window.electronAPI.seedDemo().catch(err => console.error("Failed to seed demo:", err));
        }

        // Sync initial undetectable state
        if (window.electronAPI?.getUndetectable) {
            window.electronAPI.getUndetectable().then((undetectable) => {
                if (mounted) setIsDetectable(!undetectable);
            });
        }

        // Listen for undetectable changes
        let removeUndetectableListener: (() => void) | undefined;
        if (window.electronAPI?.onUndetectableChanged) {
            removeUndetectableListener = window.electronAPI.onUndetectableChanged((undetectable) => {
                setIsDetectable(!undetectable);
            });
        }

        fetchMeetings();
        fetchEvents();
        fetchContextHubOverview().catch(() => { });
        fetchMeetingReadiness().catch(() => { });

        // Sync initial meeting active state — guarded so unmounted component isn't written to
        if (window.electronAPI?.getMeetingActive) {
            window.electronAPI.getMeetingActive()
                .then((active) => { if (mounted) setIsMeetingActive(active); })
                .catch(() => {});
        }

        // Listen for meeting state changes (e.g. meeting started/ended from overlay)
        let removeMeetingStateListener: (() => void) | undefined;
        if (window.electronAPI?.onMeetingStateChanged) {
            removeMeetingStateListener = window.electronAPI.onMeetingStateChanged(({ isActive }) => {
                setIsMeetingActive(isActive);
                fetchMeetingReadiness().catch(() => { });
            });
        }

        // Listen for background updates (e.g. after meeting processing finishes)
        const removeMeetingsListener = window.electronAPI.onMeetingsUpdated(() => {
            console.log("Received meetings-updated event");
            fetchMeetings();
            fetchContextHubOverview().catch(() => { });
            fetchMeetingReadiness().catch(() => { });
        });

        // Simple polling for events every minute
        const interval = setInterval(() => {
            fetchEvents();
            fetchMeetings();
            fetchContextHubOverview().catch(() => { });
        }, 60000);

        const readinessInterval = setInterval(() => {
            fetchMeetingReadiness().catch(() => { });
        }, 5000);

        return () => {
            mounted = false;
            if (removeMeetingsListener) removeMeetingsListener();
            if (removeUndetectableListener) removeUndetectableListener();
            if (removeMeetingStateListener) removeMeetingStateListener();
            clearInterval(interval);
            clearInterval(readinessInterval);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Mount-only: stable setup that must run exactly once

    // Separate effect for keyboard listener — re-registers when isShortcutPressed changes
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isShortcutPressed(e, 'toggleVisibility')) {
                e.preventDefault();
                window.electronAPI.toggleWindow();
            } else if (isShortcutPressed(e, 'moveWindowUp')) {
                e.preventDefault();
                window.electronAPI.moveWindowUp?.();
            } else if (isShortcutPressed(e, 'moveWindowDown')) {
                e.preventDefault();
                window.electronAPI.moveWindowDown?.();
            } else if (isShortcutPressed(e, 'moveWindowLeft')) {
                e.preventDefault();
                window.electronAPI.moveWindowLeft?.();
            } else if (isShortcutPressed(e, 'moveWindowRight')) {
                e.preventDefault();
                window.electronAPI.moveWindowRight?.();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isShortcutPressed]);

    // Filter next meeting (within 60 mins)
    const nextMeeting = upcomingEvents.find(e => {
        const diff = new Date(e.startTime).getTime() - Date.now();
        return diff > -5 * 60000 && diff < 60 * 60000; // -5 min to +60 min
    });
    const readinessChecks = meetingReadiness?.checks || [];
    const readinessLastUpdated = formatReadinessAge(meetingReadiness?.generatedAt);
    const readinessCheckById = (id: string) => readinessChecks.find((check) => check.id === id);
    const selectedReadinessCheck = selectedReadinessCheckId
        ? readinessChecks.find((check) => check.id === selectedReadinessCheckId) || null
        : null;
    const selectedReadinessGuide = selectedReadinessCheck
        ? readinessActionGuides[selectedReadinessCheck.id]
        : null;
    const readinessBlockingChecks = readinessChecks.filter((check) => check.status === 'failed');
    const prepCheck = readinessCheckById('prep');
    const brainCheck = readinessCheckById('brain');
    const audioCheck = readinessCheckById('meeting_audio');
    const transcriptCheck = readinessCheckById('transcripts');
    const isLiveRuntime = !!meetingReadiness?.meetingActive;
    const startGuidance = readinessBlockingChecks.length > 0
        ? {
            status: 'failed' as ReadinessCheckStatus,
            title: 'Do not rely on it yet',
            detail: `${readinessBlockingChecks[0].label} is blocked. Fix that before using Natively in a real meeting.`,
        }
        : !isLiveRuntime
            ? prepCheck?.status === 'warning' || brainCheck?.status !== 'ready'
                ? {
                    status: 'warning' as ReadinessCheckStatus,
                    title: 'You can start the widget, but prep is degraded',
                    detail: 'The live widget can still listen and answer, but meeting-specific context may be thin until prep/brain checks are ready.',
                }
                : {
                    status: 'ready' as ReadinessCheckStatus,
                    title: 'Safe to start the widget',
                    detail: 'Before a meeting, audio and transcript checks may stay blue because they only prove themselves after the widget is listening.',
                }
            : audioCheck?.status === 'warning' || transcriptCheck?.status === 'warning'
                ? {
                    status: 'warning' as ReadinessCheckStatus,
                    title: 'Widget is running, but live capture is degraded',
                    detail: 'Natively may answer manual asks, but proactive coaching will be unreliable until audio/transcript checks turn green.',
                }
                : {
                    status: 'ready' as ReadinessCheckStatus,
                    title: 'Widget is running and usable',
                    detail: 'Live capture, transcript, prep, and coach signals are either ready or in expected warm-up state.',
                };

    const indexedMeetingsPreview = meetings.slice(0, 6);
    const contextCounts = {
        meetings: contextHubOverview?.meetings?.total ?? meetings.length,
        teams: contextHubOverview?.meetings?.teamsImports ?? meetings.filter((m) => m.source === 'teams').length,
        cluely: contextHubOverview?.meetings?.cluelyImports ?? meetings.filter((m) => m.source === 'cluely').length,
        imported: contextHubOverview?.meetings?.genericImports ?? meetings.filter((m) => m.source === 'imported').length,
        liveSignals: ((contextHubOverview?.live?.ocrObservations || 0) + (contextHubOverview?.live?.liveTranscriptSegments || 0) + (contextHubOverview?.live?.chatTurns || 0)),
    };
    const lastIndexedAt = contextHubOverview?.meetings?.lastMeetingAt
        ? new Date(contextHubOverview.meetings.lastMeetingAt).toLocaleString()
        : 'No indexed meetings yet';
    const lastObservedAt = contextHubOverview?.live?.lastObservedAt
        ? new Date(contextHubOverview.live.lastObservedAt).toLocaleString()
        : 'No live observations yet';
    const sourceHealthCards = [
        {
            label: 'Outlook Desktop',
            value: contextHubOverview?.localSources?.outlookConnected ? 'Connected' : 'Offline',
            meta: `${contextHubOverview?.localSources?.upcomingEvents || 0} upcoming events • ${contextHubOverview?.localSources?.recentEmails || 0} recent emails`,
            active: !!contextHubOverview?.localSources?.outlookConnected,
            icon: Mail,
        },
        {
            label: 'Teams Desktop',
            value: contextHubOverview?.localSources?.teamsConnected ? 'Connected' : 'Offline',
            meta: `${contextHubOverview?.localSources?.teamsChats || 0} visible chats`,
            active: !!contextHubOverview?.localSources?.teamsConnected,
            icon: MessageSquare,
        },
        {
            label: 'IP Corp Brain',
            value: contextHubOverview?.brain?.available ? 'Ready' : 'Missing',
            meta: `${contextHubOverview?.brain?.prepPacketsReady || 0} prep packets • ${contextHubOverview?.brain?.cortexInsights || 0} Cortex insights • ${contextHubOverview?.brain?.openActionProposals || 0} proposals`,
            active: !!contextHubOverview?.brain?.available,
            icon: Globe,
        },
        {
            label: 'Live Watch',
            value: contextCounts.liveSignals > 0 ? 'Streaming' : 'Quiet',
            meta: `${contextHubOverview?.live?.ocrObservations || 0} OCR • ${contextHubOverview?.live?.liveTranscriptSegments || 0} transcript • ${contextHubOverview?.live?.chatTurns || 0} chat turns`,
            active: contextCounts.liveSignals > 0,
            icon: Activity,
        },
    ];
    const metricCards = [
        {
            label: 'Meetings Indexed',
            value: contextCounts.meetings,
            accent: 'from-sky-500/25 via-sky-400/10 to-transparent',
            icon: Calendar,
        },
        {
            label: 'Teams Imports',
            value: contextCounts.teams,
            accent: 'from-emerald-500/25 via-emerald-400/10 to-transparent',
            icon: MessageSquare,
        },
        {
            label: 'Cluely Imports',
            value: contextCounts.cluely,
            accent: 'from-amber-500/25 via-amber-400/10 to-transparent',
            icon: Bell,
        },
        {
            label: 'Prep Packets',
            value: contextHubOverview?.brain?.prepPacketsReady || 0,
            accent: 'from-violet-500/25 via-violet-400/10 to-transparent',
            icon: Monitor,
        },
    ];

    const handlePrepare = async (event: UpcomingEvent) => {
        setPrepareError('');
        setIsPreparing(true);
        try {
            const packet = await window.electronAPI?.getMeetingPrepPacket?.(event.id);
            setPreparedEvent(event);
            setPreparedPacket(packet || null);
            setIsPrepared(true);
            fetchMeetingReadiness().catch(() => { });
        } catch (error: any) {
            console.error("Failed to build meeting prep packet", error);
            setPrepareError(error?.message || 'Prep packet failed to load.');
        } finally {
            setIsPreparing(false);
        }
    };

    const handleStartPreparedMeeting = async () => {
        if (!preparedEvent) return;
        analytics.trackCommandExecuted('start_prepared_meeting');
        try {
            const inputDeviceId = localStorage.getItem('preferredInputDeviceId');
            const outputDeviceId = localStorage.getItem('preferredOutputDeviceId');

            await window.electronAPI.startMeeting({
                title: preparedEvent.title,
                calendarEventId: preparedEvent.id,
                source: 'calendar',
                audio: { inputDeviceId, outputDeviceId }
            });
            setIsPrepared(false);
            setPreparedEvent(null);
            setPreparedPacket(null);
        } catch (e) {
            console.error("Failed to start prepared meeting", e);
        }
    };

    if (!window.electronAPI) {
        return <div className="text-white p-10">Error: Electron API not initialized. Check preload script.</div>;
    }

    const toggleDetectable = () => {
        const newState = !isDetectable;
        setIsDetectable(newState);
        window.electronAPI?.setUndetectable(!newState); // Note: setUndetectable takes the *undetectable* state, which is inverse of *detectable*
        analytics.trackModeSelected(newState ? 'launcher' : 'undetectable'); // If visible (detectable), mode is normal/launcher. If not detectable, mode is undetectable.
    };

    // Group meetings
    const groupedMeetings = meetings.reduce((acc, meeting) => {
        const label = getGroupLabel(meeting.date);
        if (!acc[label]) acc[label] = [];
        acc[label].push(meeting);
        return acc;
    }, {} as Record<string, Meeting[]>);

    // Group order (Today, Yesterday, then others sorted new to old is implicit via API return order ideally, 
    // but JS object key order isn't guaranteed. We can use a Map or just known keys.)
    // Simple sort for keys:
    const sortedGroups = Object.keys(groupedMeetings).sort((a, b) => {
        if (a === 'Today') return -1;
        if (b === 'Today') return 1;
        if (a === 'Yesterday') return -1;
        if (b === 'Yesterday') return 1;
        // Approximation for others: parse date
        return new Date(b).getTime() - new Date(a).getTime();
    });


    const [forwardMeeting, setForwardMeeting] = useState<Meeting | null>(null);
    const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
    const [menuEntered, setMenuEntered] = useState(false);

    useEffect(() => {
        setMenuEntered(false);
    }, [activeMenuId]);

    // Global click listener to close menu
    useEffect(() => {
        const handleClickOutside = () => setActiveMenuId(null);
        window.addEventListener('click', handleClickOutside);
        return () => window.removeEventListener('click', handleClickOutside);
    }, []);

    useEffect(() => {
        if (!isPrepared || !preparedEvent) return;
        const rafId = window.requestAnimationFrame(() => {
            prepBriefRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return () => window.cancelAnimationFrame(rafId);
    }, [isPrepared, preparedEvent, preparedPacket]);

    // Notify parent if we are on the main launcher list view
    useEffect(() => {
        if (onPageChange) {
            onPageChange(!selectedMeeting && !isGlobalChatOpen);
        }
    }, [selectedMeeting, isGlobalChatOpen, onPageChange]);

    const handleOpenMeeting = async (meeting: Meeting) => {
        setForwardMeeting(null); // Clear forward history on new navigation
        console.log("[Launcher] Opening meeting:", meeting.id);
        analytics.trackCommandExecuted('open_meeting_details');

        // Fetch full meeting details including transcript and usage
        if (window.electronAPI && window.electronAPI.getMeetingDetails) {
            try {
                console.log("[Launcher] Fetching full meeting details...");
                const fullMeeting = await window.electronAPI.getMeetingDetails(meeting.id);
                console.log("[Launcher] Got meeting details:", fullMeeting);
                console.log("[Launcher] Transcript count:", fullMeeting?.transcript?.length);
                console.log("[Launcher] Usage count:", fullMeeting?.usage?.length);
                if (fullMeeting) {
                    setSelectedMeeting(fullMeeting);
                    return;
                }
            } catch (err) {
                console.error("[Launcher] Failed to fetch meeting details:", err);
            }
        } else {
            console.warn("[Launcher] getMeetingDetails not available on electronAPI");
        }
        // Fallback to list-view data if fetch fails
        setSelectedMeeting(meeting);
    };

    const handleBack = () => {
        setForwardMeeting(selectedMeeting);
        setSelectedMeeting(null);
    };

    const handleForward = () => {
        if (forwardMeeting) {
            setSelectedMeeting(forwardMeeting);
            setForwardMeeting(null);
        }
    };

    // Helper to format duration to mm:ss or mmm:ss
    // Helper to format duration to mm:ss or mmm:ss
    const formatDurationPill = (durationStr: string) => {
        if (!durationStr) return "00:00";

        // Check if it's already in colon format (e.g. "5:30", "105:20")
        if (durationStr.includes(':')) {
            const parts = durationStr.split(':');
            const mins = parts[0];
            const secs = parts[1] || "00";

            // Allow 3 digits for mins if >= 100, otherwise pad to 2
            const formattedMins = mins.length >= 3 ? mins : mins.padStart(2, '0');
            return `${formattedMins}:${secs}`;
        }

        // Fallback for "X min" format (legacy)
        const minutes = parseInt(durationStr.replace('min', '').trim()) || 0;
        const mm = minutes.toString().padStart(2, '0');
        return `${mm}:00`;
    };

    return (
        <div className="h-full w-full flex flex-col bg-bg-primary text-text-primary font-sans overflow-hidden selection:bg-accent-secondary/30">
            {/* 1. Header (Static) */}
            <header className="relative w-full h-[40px] shrink-0 flex items-center justify-between pl-0 drag-region select-none bg-bg-secondary border-b border-border-subtle z-[200]">
                {/* Left: Spacing for Traffic Lights + Navigation Arrows */}
                <div className="flex items-center gap-1 no-drag">
                    {isMac && <div className="w-[70px]" />} {/* Traffic Light Spacer (macOS only) */}

                    {/* Back Button */}
                    <button
                        onClick={selectedMeeting ? handleBack : undefined}
                        disabled={!selectedMeeting}
                        className={`
                            transition-all duration-300 p-1 flex items-center justify-center mt-1 ml-2
                            ${selectedMeeting
                                ? `text-text-secondary hover:text-text-primary ${isLight ? 'hover:drop-shadow-[0_0_6px_rgba(0,0,0,0.25)]' : 'hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]'}`
                                : 'text-text-tertiary opacity-50 cursor-default'}
                        `}
                    >
                        <ArrowLeft size={16} />
                    </button>

                    {/* Forward Button */}
                    <button
                        onClick={handleForward}
                        disabled={!forwardMeeting}
                        className={`
                            transition-all duration-300 p-1 flex items-center justify-center mt-1
                            ${forwardMeeting
                                ? `text-text-secondary hover:text-text-primary ${isLight ? 'hover:drop-shadow-[0_0_6px_rgba(0,0,0,0.25)]' : 'hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]'}`
                                : 'text-text-tertiary opacity-0 cursor-default'}
                        `}
                    >
                        <ArrowRight size={16} />
                    </button>
                </div>


                {/* Center: Spotlight-style Search Pill */}
                <TopSearchPill
                    meetings={meetings}
                    onAIQuery={(query) => {
                        analytics.trackCommandExecuted('ai_query_search');
                        setSubmittedGlobalQuery(query);
                        setIsGlobalChatOpen(true);
                    }}
                    onLiteralSearch={(query) => {
                        // For now, also use AI query for literal search
                        // Could be enhanced to do fuzzy filtering in the UI
                        analytics.trackCommandExecuted('literal_search');
                        setSubmittedGlobalQuery(query);
                        setIsGlobalChatOpen(true);
                    }}
                    onOpenMeeting={(meetingId) => {
                        const meeting = meetings.find(m => m.id === meetingId);
                        if (meeting) {
                            handleOpenMeeting(meeting);
                            analytics.trackCommandExecuted('open_meeting_from_search');
                        }
                    }}
                />

                {/* Right: Actions */}
                <div className={`flex items-center gap-3 no-drag shrink-0 ${isMac ? 'mr-1' : ''}`}>
                    <button
                        onClick={() => {
                            onOpenSettings();
                            // analytics.trackCommandExecuted('open_settings'); // Optional, high volume
                        }}
                        className={`p-2 text-text-secondary hover:text-text-primary transition-all duration-300 ${isLight ? 'hover:drop-shadow-[0_0_6px_rgba(0,0,0,0.25)]' : 'hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]'}`}
                    >
                        <Settings size={18} />
                    </button>
                    {!isMac && <WindowControls />}
                </div>
            </header>

            <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
                {!isDetectable && (
                    <div className={`absolute inset-1 border-2 border-dashed rounded-2xl pointer-events-none z-[100] ${isLight ? 'border-black/15' : 'border-white/20'}`} />
                )}
                <AnimatePresence mode="wait">
                    {selectedMeeting ? (
                        <motion.div
                            key="details"
                            className="flex-1 min-h-0 overflow-hidden"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >
                            <MeetingDetails
                                meeting={selectedMeeting}
                                onBack={handleBack}
                                onOpenSettings={onOpenSettings}
                            />
                        </motion.div>
                    ) : (
                        <motion.div
                            key="launcher"
                            className="flex-1 min-h-0 overflow-y-auto custom-scrollbar bg-bg-primary"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.15 }}
                        >

                            {/* Main Area */}
                            <section className={`${isLight ? 'bg-bg-primary' : 'bg-bg-elevated'} px-8 pt-6 pb-8 border-b border-border-subtle`}>
                                <div className="max-w-4xl mx-auto space-y-6">
                                    {/* 1.5. Hero Header (Title + Controls + CTA) */}
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <h1 className="text-3xl font-celeb-light font-medium text-text-primary tracking-wide drop-shadow-sm">My Natively</h1>

                                            {/* Refresh Button */}
                                            <button
                                                onClick={handleRefresh}
                                                disabled={isRefreshing}
                                                className={`p-2 text-text-secondary hover:text-text-primary rounded-full transition-colors ${isRefreshing ? 'animate-spin text-blue-400' : ''} ${isLight ? 'hover:bg-black/8' : 'hover:bg-white/10'}`}
                                                title="Refresh State"
                                            >
                                                <RefreshCw size={18} />
                                            </button>

                                            {/* Detectable Toggle Pill */}
                                            <div className={`flex items-center gap-3 border rounded-full px-3 py-1.5 min-w-[140px] transition-colors ${isLight ? 'bg-bg-elevated border-border-muted shadow-sm' : 'bg-[#101011] border-border-muted'}`}>
                                                {isDetectable ? (
                                                    <Ghost
                                                        size={14}
                                                        strokeWidth={2}
                                                        className="text-text-secondary transition-colors"
                                                    />
                                                ) : (
                                                    <svg
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        xmlns="http://www.w3.org/2000/svg"
                                                        className="transition-colors"
                                                    >
                                                        <path
                                                            d="M12 2C7.58172 2 4 5.58172 4 10V22L7 19L9.5 21.5L12 19L14.5 21.5L17 19L20 22V10C20 5.58172 16.4183 2 12 2Z"
                                                            fill={isLight ? '#48484A' : 'white'}
                                                        />
                                                        <circle cx="9" cy="10" r="1.5" fill={isLight ? 'white' : 'black'} />
                                                        <circle cx="15" cy="10" r="1.5" fill={isLight ? 'white' : 'black'} />
                                                    </svg>
                                                )}
                                                <span className="text-xs font-medium flex-1 transition-colors text-text-secondary">
                                                    {isDetectable ? "Detectable" : "Undetectable"}
                                                </span>
                                                <div
                                                    className={`w-8 h-4 rounded-full relative transition-colors cursor-pointer ${!isDetectable ? 'bg-accent-primary' : 'bg-bg-toggle-switch'}`}
                                                    onClick={toggleDetectable}
                                                >
                                                    <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all ${!isDetectable ? 'left-[18px]' : 'left-0.5'}`} />
                                                </div>
                                            </div>
                                        </div>

                                        {/* Center: legacy pull-status pill slot (flex-1 to center evenly) */}
                                        <div className="flex-1 flex justify-center mx-4">
                                            <AnimatePresence>
                                                {ollamaPullStatus !== 'idle' && (
                                                    <motion.div
                                                        initial={{ opacity: 0, scale: 0.9, y: 10 }}
                                                        animate={{ opacity: 1, scale: 1, y: 0 }}
                                                        exit={{ opacity: 0, scale: 0.9, y: 10 }}
                                                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                                                        className={`flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-xl ${isLight ? 'bg-bg-elevated border border-border-muted shadow-[0_4px_16px_rgba(0,0,0,0.1)]' : 'bg-bg-elevated/80 border border-white/10 shadow-[0_4px_16px_rgba(0,0,0,0.3)]'}`}
                                                    >
                                                        {ollamaPullStatus === 'downloading' ? (
                                                            <DownloadCloud size={14} className="text-blue-400 animate-pulse shrink-0" />
                                                        ) : ollamaPullStatus === 'complete' ? (
                                                            <CheckCircle size={14} className="text-emerald-400 shrink-0" />
                                                        ) : (
                                                            <AlertCircle size={14} className="text-red-400 shrink-0" />
                                                        )}
                                                        <div className="flex flex-col">
                                                            <span className="text-[11px] font-medium text-text-secondary whitespace-nowrap">
                                                                {ollamaPullStatus === 'downloading' ? `Setting up AI memory... ${ollamaPullPercent}%` : ollamaPullMessage}
                                                            </span>
                                                            {ollamaPullStatus === 'downloading' && (
                                                                <div className="w-full h-[3px] bg-white/10 rounded-full mt-1 overflow-hidden">
                                                                    <div
                                                                        className="h-full bg-blue-500 rounded-full transition-all duration-300"
                                                                        style={{ width: `${ollamaPullPercent}%` }}
                                                                    />
                                                                </div>
                                                            )}
                                                        </div>
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>

                                        {/* Unified CTA pill — same jelly shape, morphs between idle and active-meeting state */}
                                        <motion.button
                                            onClick={() => {
                                                if (isMeetingActive) {
                                                    // inactive=true: overlay appears on top but doesn't activate
                                                    // the Natively app or steal OS focus — preserves stealth.
                                                    // setWindowMode (not showWindow) is required because
                                                    // logo-click set currentWindowMode='launcher', so showWindow()
                                                    // would re-show the launcher rather than switch to overlay.
                                                    window.electronAPI?.setWindowMode?.('overlay', true);
                                                    analytics.trackCommandExecuted('resume_meeting_from_launcher');
                                                } else {
                                                    onStartMeeting();
                                                    analytics.trackCommandExecuted('start_natively_cta');
                                                }
                                            }}
                                            whileHover={{ scale: 1.01, filter: 'brightness(1.1)' }}
                                            whileTap={{ scale: 0.99 }}
                                            transition={{ duration: 0.18, ease: 'easeOut' }}
                                            className="group relative overflow-hidden text-white px-6 py-3 rounded-full font-celeb font-medium tracking-normal flex items-center justify-center gap-3 backdrop-blur-xl shrink-0"
                                            style={{
                                                boxShadow: isMeetingActive
                                                    ? 'inset 0 1px 1px rgba(255,255,255,0.7), inset 0 -1px 2px rgba(0,0,0,0.1), 0 2px 10px rgba(16,185,129,0.45), 0 0 0 1px rgba(255,255,255,0.15)'
                                                    : 'inset 0 1px 1px rgba(255,255,255,0.7), inset 0 -1px 2px rgba(0,0,0,0.1), 0 2px 10px rgba(14,165,233,0.4), 0 0 0 1px rgba(255,255,255,0.15)',
                                                transition: 'box-shadow 0.5s ease-out',
                                            }}
                                        >
                                            {/* Blue gradient layer (idle) */}
                                            <div
                                                className="absolute inset-0 bg-gradient-to-b from-sky-400 via-sky-500 to-blue-600 transition-opacity duration-500 ease-out"
                                                style={{ opacity: isMeetingActive ? 0 : 1 }}
                                            />
                                            {/* Green gradient layer (meeting active) */}
                                            <div
                                                className="absolute inset-0 bg-gradient-to-b from-emerald-400 via-emerald-500 to-green-600 transition-opacity duration-500 ease-out"
                                                style={{ opacity: isMeetingActive ? 1 : 0 }}
                                            />

                                            {/* Top highlight band — shared between both states */}
                                            <div className="absolute inset-x-3 top-0 h-[40%] bg-gradient-to-b from-white/40 to-transparent blur-[2px] rounded-b-lg opacity-80 pointer-events-none z-10" />
                                            {/* Internal suspended-light hover glow */}
                                            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none z-10" />

                                            {/* Button content — crossfade between idle and meeting states */}
                                            <div className="relative z-20 flex items-center gap-3">
                                                <AnimatePresence mode="wait" initial={false}>
                                                    {isMeetingActive ? (
                                                        <motion.div
                                                            key="meeting"
                                                            initial={{ opacity: 0, y: 6 }}
                                                            animate={{ opacity: 1, y: 0 }}
                                                            exit={{ opacity: 0, y: -6 }}
                                                            transition={{ duration: 0.22, ease: 'easeOut' }}
                                                            className="flex items-center gap-3"
                                                        >
                                                            {/* Ping live-indicator dot */}
                                                            <span className="relative flex h-[9px] w-[9px] shrink-0">
                                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
                                                                <span className="relative inline-flex rounded-full h-[9px] w-[9px] bg-white" />
                                                            </span>
                                                            <span className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.1)] text-[20px] leading-none">Meeting ongoing</span>
                                                        </motion.div>
                                                    ) : (
                                                        <motion.div
                                                            key="start"
                                                            initial={{ opacity: 0, y: 6 }}
                                                            animate={{ opacity: 1, y: 0 }}
                                                            exit={{ opacity: 0, y: -6 }}
                                                            transition={{ duration: 0.22, ease: 'easeOut' }}
                                                            className="flex items-center gap-3"
                                                        >
                                                            <img src={icon} alt="Logo" className="w-[18px] h-[18px] object-contain brightness-0 invert drop-shadow-[0_1px_2px_rgba(0,0,0,0.1)] opacity-90" />
                                                            <span className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.1)] text-[20px] leading-none">Start Natively</span>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        </motion.button>
                                    </div>

                                    {/* Readiness Preflight */}
                                    <div className={`rounded-2xl border p-4 ${isLight ? 'bg-bg-elevated border-border-muted shadow-sm' : 'bg-[#10141c] border-white/10'}`}>
                                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                            <div className="min-w-0">
                                                <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-text-secondary">
                                                    <Activity size={13} className={readinessBusy ? 'animate-pulse text-sky-400' : ''} />
                                                    Preflight guidance
                                                </div>
                                                <h2 className="mt-1 text-xl font-semibold text-text-primary">
                                                    {startGuidance.title}
                                                </h2>
                                                <p className="mt-1 text-sm text-text-secondary leading-relaxed">
                                                    {startGuidance.detail}
                                                </p>
                                            </div>
                                            <div className="flex flex-col items-start md:items-end gap-2 shrink-0">
                                                <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${readinessStyles(startGuidance.status, isLight)}`}>
                                                    {startGuidance.status === 'ready' ? <CheckCircle size={14} /> : startGuidance.status === 'failed' ? <AlertCircle size={14} /> : <Clock size={14} />}
                                                    {readinessLabel(startGuidance.status)}
                                                </span>
                                                <span className="text-[11px] text-text-secondary">
                                                    Updated {readinessLastUpdated}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="mt-4 grid grid-cols-2 lg:grid-cols-6 gap-2">
                                            {readinessChecks.slice(0, 6).map((check) => (
                                                <button
                                                    type="button"
                                                    key={check.id}
                                                    onClick={() => handleReadinessCardClick(check.id)}
                                                    aria-pressed={selectedReadinessCheckId === check.id}
                                                    className={`rounded-xl border px-3 py-2 min-h-[86px] text-left transition-all hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-blue-400/40 ${readinessStyles(check.status, isLight)} ${selectedReadinessCheckId === check.id ? 'ring-2 ring-blue-400/50 shadow-sm' : ''}`}
                                                    title={check.detail}
                                                >
                                                    <div className="flex items-center justify-between gap-2">
                                                        <span className="text-[10px] font-bold uppercase tracking-[0.14em] opacity-80 truncate">{check.label}</span>
                                                        {check.status === 'ready' ? <Check size={13} /> : check.status === 'failed' ? <AlertCircle size={13} /> : <Clock size={13} />}
                                                    </div>
                                                    <div className="mt-2 text-sm font-semibold">{readinessLabel(check.status)}</div>
                                                    <p className="mt-1 text-[11px] leading-snug opacity-80 line-clamp-2">{check.detail}</p>
                                                </button>
                                            ))}
                                        </div>

                                        <AnimatePresence initial={false}>
                                            {selectedReadinessCheck && (
                                                <motion.div
                                                    key={selectedReadinessCheck.id}
                                                    initial={{ opacity: 0, y: -6 }}
                                                    animate={{ opacity: 1, y: 0 }}
                                                    exit={{ opacity: 0, y: -6 }}
                                                    transition={{ duration: 0.18, ease: 'easeOut' }}
                                                    className={`mt-3 rounded-2xl border p-4 ${isLight ? 'border-blue-500/20 bg-blue-500/[0.045]' : 'border-blue-400/20 bg-blue-400/[0.08]'}`}
                                                >
                                                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                                        <div className="min-w-0">
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-text-tertiary">Action panel</span>
                                                                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${readinessStyles(selectedReadinessCheck.status, isLight)}`}>
                                                                    {selectedReadinessCheck.status === 'ready' ? <Check size={11} /> : selectedReadinessCheck.status === 'failed' ? <AlertCircle size={11} /> : <Clock size={11} />}
                                                                    {readinessLabel(selectedReadinessCheck.status)}
                                                                </span>
                                                            </div>
                                                            <h3 className="mt-1 text-base font-semibold text-text-primary">{selectedReadinessCheck.label}</h3>
                                                            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{selectedReadinessCheck.detail}</p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setSelectedReadinessCheckId(null)}
                                                            className={readinessActionButtonClass}
                                                        >
                                                            Close
                                                        </button>
                                                    </div>

                                                    <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[0.9fr_1.1fr]">
                                                        <div className={`rounded-xl border px-3 py-3 ${isLight ? 'border-black/8 bg-white/60' : 'border-white/10 bg-black/10'}`}>
                                                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-tertiary">What this means</div>
                                                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                                                                {selectedReadinessGuide?.meaning || 'This is one of the checks Natively uses to decide whether the widget is ready for a live meeting.'}
                                                            </p>
                                                        </div>
                                                        <div className={`rounded-xl border px-3 py-3 ${isLight ? 'border-black/8 bg-white/60' : 'border-white/10 bg-black/10'}`}>
                                                            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-text-tertiary">Fix path</div>
                                                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                                                                {selectedReadinessGuide?.fix || 'Use the actions below, then refresh readiness.'}
                                                            </p>

                                                            {selectedReadinessCheck.id === 'microphone' && (
                                                                <div className="mt-3 space-y-3">
                                                                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                                                                        Microphone
                                                                    </label>
                                                                    <div className="flex flex-col gap-2 sm:flex-row">
                                                                        <select
                                                                            value={selectedInputDeviceId}
                                                                            onChange={(event) => savePreferredAudioDevice('input', event.target.value)}
                                                                            className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm outline-none ${isLight ? 'border-black/10 bg-white text-text-primary' : 'border-white/10 bg-bg-input text-text-primary'}`}
                                                                        >
                                                                            {inputDeviceOptions.length === 0 ? (
                                                                                <option value="">No microphones found</option>
                                                                            ) : inputDeviceOptions.map((device) => (
                                                                                <option key={device.id} value={device.id}>{device.name || 'Unnamed microphone'}</option>
                                                                            ))}
                                                                        </select>
                                                                        <button type="button" onClick={() => loadAudioDevices()} className={readinessActionButtonClass} disabled={audioDeviceBusy}>
                                                                            <RefreshCw size={12} className={audioDeviceBusy ? 'inline animate-spin' : 'inline'} /> Refresh
                                                                        </button>
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-2">
                                                                        <button type="button" onClick={toggleVoiceCheck} className={readinessPrimaryButtonClass}>
                                                                            <Mic size={12} className="inline" /> {voiceCheckActive ? 'Stop voice check' : 'Start voice check'}
                                                                        </button>
                                                                        <button type="button" onClick={() => onOpenSettings('audio')} className={readinessActionButtonClass}>
                                                                            <Settings size={12} className="inline" /> Audio settings
                                                                        </button>
                                                                    </div>
                                                                    <p className="text-[11px] leading-relaxed text-text-tertiary">
                                                                        If the headset or Windows has muted this device, unmute it in Windows sound controls or on the hardware.
                                                                    </p>
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'meeting_audio' && (
                                                                <div className="mt-3 space-y-3">
                                                                    <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                                                                        Meeting audio output
                                                                    </label>
                                                                    <div className="flex flex-col gap-2 sm:flex-row">
                                                                        <select
                                                                            value={selectedOutputDeviceId}
                                                                            onChange={(event) => savePreferredAudioDevice('output', event.target.value)}
                                                                            className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm outline-none ${isLight ? 'border-black/10 bg-white text-text-primary' : 'border-white/10 bg-bg-input text-text-primary'}`}
                                                                        >
                                                                            {outputDeviceOptions.length === 0 ? (
                                                                                <option value="">No output devices found</option>
                                                                            ) : outputDeviceOptions.map((device) => (
                                                                                <option key={device.id} value={device.id}>{device.name || 'Unnamed output device'}</option>
                                                                            ))}
                                                                        </select>
                                                                        <button type="button" onClick={() => loadAudioDevices()} className={readinessActionButtonClass} disabled={audioDeviceBusy}>
                                                                            <RefreshCw size={12} className={audioDeviceBusy ? 'inline animate-spin' : 'inline'} /> Refresh
                                                                        </button>
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-2">
                                                                        <button type="button" onClick={() => onOpenSettings('audio')} className={readinessActionButtonClass}>
                                                                            <Speaker size={12} className="inline" /> Audio settings
                                                                        </button>
                                                                        <button type="button" onClick={onStartMeeting} className={readinessPrimaryButtonClass}>
                                                                            <ArrowRight size={12} className="inline" /> Start widget
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'prep' && (
                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                    <button type="button" onClick={handleRefresh} className={readinessActionButtonClass} disabled={isRefreshing}>
                                                                        <RefreshCw size={12} className={isRefreshing ? 'inline animate-spin' : 'inline'} /> Refresh meetings
                                                                    </button>
                                                                    {nextMeeting && (
                                                                        <button type="button" onClick={() => handlePrepare(nextMeeting)} className={readinessPrimaryButtonClass} disabled={isPreparing}>
                                                                            <Zap size={12} className="inline" /> {isPreparing ? 'Preparing...' : 'Prepare next meeting'}
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'brain' && (
                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                    <button type="button" onClick={reloadBrainForReadiness} className={readinessPrimaryButtonClass}>
                                                                        <RefreshCw size={12} className="inline" /> Reload brain context
                                                                    </button>
                                                                    <button type="button" onClick={() => onOpenSettings('profile')} className={readinessActionButtonClass}>
                                                                        <Globe size={12} className="inline" /> Context hub
                                                                    </button>
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'transcripts' && (
                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                    <button type="button" onClick={() => onOpenSettings('audio')} className={readinessPrimaryButtonClass}>
                                                                        <Settings size={12} className="inline" /> Open speech settings
                                                                    </button>
                                                                    <button type="button" onClick={toggleVoiceCheck} className={readinessActionButtonClass}>
                                                                        <Mic size={12} className="inline" /> {voiceCheckActive ? 'Stop voice check' : 'Test transcription'}
                                                                    </button>
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'coach' && (
                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                    <button type="button" onClick={enableProactiveCoach} className={readinessPrimaryButtonClass}>
                                                                        <Zap size={12} className="inline" /> Enable proactive mode
                                                                    </button>
                                                                    <button type="button" onClick={onStartMeeting} className={readinessActionButtonClass}>
                                                                        <ArrowRight size={12} className="inline" /> Start widget
                                                                    </button>
                                                                    <button type="button" onClick={() => onOpenSettings('meeting-ai')} className={readinessActionButtonClass}>
                                                                        <Settings size={12} className="inline" /> Meeting AI settings
                                                                    </button>
                                                                </div>
                                                            )}

                                                            {selectedReadinessCheck.id === 'screen' && (
                                                                <div className="mt-3 flex flex-wrap gap-2">
                                                                    <button type="button" onClick={runScreenCheck} className={readinessPrimaryButtonClass}>
                                                                        <Monitor size={12} className="inline" /> Run screen check
                                                                    </button>
                                                                    <button type="button" onClick={() => onOpenSettings('meeting-ai')} className={readinessActionButtonClass}>
                                                                        <Settings size={12} className="inline" /> Screen watch settings
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {readinessActionMessage && (
                                                        <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${isLight ? 'border-emerald-500/20 bg-emerald-500/8 text-emerald-700' : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'}`}>
                                                            {readinessActionMessage}
                                                        </div>
                                                    )}
                                                </motion.div>
                                            )}
                                        </AnimatePresence>

                                        <div className={`mt-3 rounded-xl border px-3 py-2 ${isLight ? 'border-border-subtle bg-black/[0.025]' : 'border-white/10 bg-black/10'}`}>
                                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-secondary">
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                                                    Green means working now
                                                </span>
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="h-2 w-2 rounded-full bg-sky-400" />
                                                    Blue means waiting or warming
                                                </span>
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="h-2 w-2 rounded-full bg-amber-400" />
                                                    Amber means usable but degraded
                                                </span>
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="h-2 w-2 rounded-full bg-red-400" />
                                                    Red means do not rely yet
                                                </span>
                                            </div>
                                        </div>

                                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-secondary">
                                            <span>
                                                Next meeting: {meetingReadiness?.prep?.nextMeeting?.title || nextMeeting?.title || 'none in range'}
                                            </span>
                                            <span>
                                                Prep packets: {meetingReadiness?.prep?.cachedPacketCount ?? 0}
                                            </span>
                                            <span>
                                                Model: {getDisplayModelName(meetingReadiness?.model || '') || 'not selected'}
                                                {meetingReadiness?.reasoningEffort ? ` / ${meetingReadiness.reasoningEffort}` : ''}
                                            </span>
                                            <span>
                                                Proactive: {meetingReadiness?.proactiveModeEnabled ? 'on' : 'off'}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Meeting prep card. Hidden when there is no actionable meeting context. */}
                                    {(isPrepared && preparedEvent) || nextMeeting ? (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                        {/* PREPARED STATE CARD */}
                                        {isPrepared && preparedEvent ? (
                                            <div className={`md:col-span-3 relative group rounded-xl overflow-hidden border border-emerald-500/30 ${isLight ? 'bg-bg-elevated' : 'bg-bg-secondary'} p-5 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-emerald-900/40 ${isLight ? 'via-bg-elevated to-bg-elevated' : 'via-bg-secondary to-bg-secondary'}`}>

                                                <div className="absolute top-4 right-4 text-emerald-400">
                                                    <Zap size={16} className="text-yellow-400" />
                                                </div>

                                                <div className="relative z-10 grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr] gap-4 h-full">
                                                    <div className="flex flex-col justify-between">
                                                        <div>
                                                            <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-wider mb-3 border border-emerald-500/20">
                                                                READY TO JOIN
                                                            </span>
                                                            <h2 className="text-2xl font-bold text-text-primary mb-2">{preparedEvent.title}</h2>
                                                            <p className="text-xs text-text-secondary mb-3 flex items-center gap-2 flex-wrap">
                                                                <Calendar size={12} />
                                                                {new Date(preparedEvent.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - {new Date(preparedEvent.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                                {preparedEvent.link && " • Link Ready"}
                                                                {preparedPacket && ` • ${preparedPacket.timing.durationMinutes} min`}
                                                            </p>
                                                            <p className="text-sm text-text-secondary leading-relaxed line-clamp-3">
                                                                {preparedPacket?.summary || 'Prep packet is ready. Use the live coach for concise talk tracks and corrections once the meeting starts.'}
                                                            </p>
                                                        </div>

                                                        <div className="flex items-center gap-3 mt-4">
                                                            <button
                                                                onClick={handleStartPreparedMeeting}
                                                                className="bg-emerald-500 hover:bg-emerald-400 text-white px-8 py-3 rounded-xl text-sm font-semibold transition-all shadow-lg hover:shadow-emerald-500/25 active:scale-95 flex items-center gap-2"
                                                            >
                                                                Start Meeting
                                                                <ArrowRight size={16} />
                                                            </button>
                                                            <button
                                                                onClick={() => {
                                                                    setIsPrepared(false);
                                                                    setPreparedEvent(null);
                                                                    setPreparedPacket(null);
                                                                    setPrepareError('');
                                                                }}
                                                                className="px-4 py-3 rounded-xl text-xs font-medium text-text-tertiary hover:text-white transition-colors"
                                                            >
                                                                Close Prep
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div className={`rounded-xl border ${isLight ? 'bg-bg-item-surface/90 border-border-subtle' : 'bg-white/5 border-white/10'} p-4 flex flex-col`}>
                                                        <div className="flex items-center justify-between mb-2">
                                                            <span className="text-[10px] font-bold tracking-[0.18em] uppercase text-text-secondary">Prep Snapshot</span>
                                                            {preparedPacket?.sourceHealth.memory ? (
                                                                <span className="text-[10px] text-emerald-400 flex items-center gap-1"><CheckCircle size={12} /> Context loaded</span>
                                                            ) : (
                                                                <span className="text-[10px] text-amber-400 flex items-center gap-1"><AlertCircle size={12} /> Lightweight</span>
                                                            )}
                                                        </div>

                                                        <div className="space-y-2 flex-1">
                                                            {(preparedPacket?.contextBullets || []).slice(0, 3).map((bullet, index) => (
                                                                <div key={`${bullet}-${index}`} className="text-xs text-text-secondary leading-relaxed">
                                                                    <span className="text-emerald-400 mr-2">•</span>
                                                                    {bullet}
                                                                </div>
                                                            ))}
                                                            {preparedPacket?.contextBullets?.length === 0 && (
                                                                <div className="text-xs text-text-secondary leading-relaxed">
                                                                    No matched notes yet. This meeting will still start with calendar timing and live observation.
                                                                </div>
                                                            )}
                                                        </div>

                                                        {preparedPacket?.prepChecklist?.[0] && (
                                                            <div className={`mt-3 rounded-lg ${isLight ? 'bg-emerald-500/6' : 'bg-emerald-500/10'} border border-emerald-500/15 px-3 py-2`}>
                                                                <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400 mb-1">Next Best Move</div>
                                                                <div className="text-xs text-text-secondary leading-relaxed">{preparedPacket.prepChecklist[0]}</div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Glows */}
                                                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[300px] h-[300px] bg-emerald-500/10 blur-[100px] pointer-events-none" />
                                            </div>
                                        ) : (
                                            /* Dynamic Next Meeting OR Default Intro */
                                            nextMeeting ? (
                                                <div className={`md:col-span-3 relative group rounded-xl overflow-hidden ${isLight ? 'bg-bg-elevated' : 'bg-bg-secondary'} flex flex-col shadow-[0_1px_3px_rgba(0,0,0,0.07),0_1px_2px_rgba(0,0,0,0.04)]`}>
                                                    {/* Header */}
                                                    <div className="p-5 flex-1 relative z-10">
                                                        <div className="flex items-center gap-2 mb-2">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                                            <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">Up Next</span>
                                                            <span className="text-[11px] text-text-tertiary">• Starts in {Math.max(0, Math.ceil((new Date(nextMeeting.startTime).getTime() - Date.now()) / 60000))} min</span>
                                                        </div>

                                                        <h2 className="text-xl font-bold text-text-primary leading-tight mb-1 line-clamp-2">
                                                            {nextMeeting.title}
                                                        </h2>

                                                        <div className="flex items-center gap-2 text-text-secondary text-xs mt-2">
                                                            <Calendar size={12} />
                                                            <span>{new Date(nextMeeting.startTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} - {new Date(nextMeeting.endTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                                                            {nextMeeting.link && (
                                                                <>
                                                                    <span className="opacity-20">|</span>
                                                                    <LinkIcon size={12} />
                                                                    <span className="truncate max-w-[150px]">Meeting Link Found</span>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>

                                                    {/* Actions */}
                                                    <div className="p-4 bg-bg-elevated/50 border-t border-border-subtle flex items-center gap-3">
                                                        <button
                                                            onClick={() => handlePrepare(nextMeeting)}
                                                            disabled={isPreparing}
                                                            className={`flex-1 border px-4 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-wait ${isLight ? 'bg-bg-item-surface hover:bg-bg-item-active border-border-muted text-text-primary' : 'bg-white/10 hover:bg-white/20 border-white/10 text-white'}`}
                                                        >
                                                            <Zap size={13} className="text-yellow-400" />
                                                            {isPreparing ? 'Building prep...' : 'Prepare'}
                                                        </button>
                                                        <button
                                                            onClick={onStartMeeting}
                                                            className={`px-4 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary transition-all ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/5'}`}
                                                        >
                                                            Start now
                                                        </button>
                                                    </div>

                                                    {prepareError && (
                                                        <div className="px-4 pb-4 text-[11px] text-amber-500">
                                                            {prepareError}
                                                        </div>
                                                    )}

                                                    {/* Background Decoration */}
                                                    <div className="absolute top-0 right-0 w-[150px] h-[150px] bg-emerald-500/10 blur-[60px] pointer-events-none" />
                                                </div>
                                            ) : null
                                        )}
                                    </div>
                                    ) : null}
                                </div>
                            </section>

                            <main className="bg-bg-primary">
                                <section className="px-8 py-8">
                                    <div className="max-w-4xl mx-auto space-y-8">
                                        {isPrepared && preparedEvent && (
                                            <section
                                                ref={prepBriefRef}
                                                className={`relative overflow-hidden rounded-[28px] border ${isLight ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(244,250,247,0.93))] border-emerald-500/15 shadow-[0_24px_80px_rgba(16,185,129,0.08)]' : 'bg-[linear-gradient(180deg,rgba(17,31,28,0.94),rgba(9,18,17,0.9))] border-emerald-500/20 shadow-[0_30px_90px_rgba(0,0,0,0.45)]'} p-5 md:p-6`}
                                            >
                                                <div className="absolute inset-0 pointer-events-none">
                                                    <div className="absolute -top-12 right-8 h-40 w-40 rounded-full bg-emerald-500/10 blur-3xl" />
                                                    <div className="absolute bottom-0 left-0 h-36 w-36 rounded-full bg-sky-500/10 blur-3xl" />
                                                </div>

                                                <div className="relative z-10 space-y-5">
                                                    <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                                        <div className="max-w-2xl">
                                                            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/15 bg-emerald-500/8 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-emerald-400">
                                                                <Zap size={12} />
                                                                Meeting Prep Brief
                                                            </div>
                                                            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-text-primary">{preparedEvent.title}</h3>
                                                            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">
                                                                {preparedPacket?.summary || 'Prep is ready. Review the context below before you join the call.'}
                                                            </p>
                                                        </div>

                                                        <div className={`rounded-2xl border px-4 py-3 ${isLight ? 'bg-white/80 border-black/8' : 'bg-white/5 border-white/10'}`}>
                                                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Prep Generated</div>
                                                            <div className="mt-1 text-sm font-semibold text-text-primary">{formatPrepTimestamp(preparedPacket?.generatedAt)}</div>
                                                            <div className="text-[11px] text-text-secondary">
                                                                Starts in {preparedPacket?.timing.startsInMinutes ?? Math.max(0, Math.ceil((new Date(preparedEvent.startTime).getTime() - Date.now()) / 60000))} min
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {preparedPacket && (
                                                        <div className="flex flex-wrap gap-2">
                                                            {prepHealthKeys.map((key) => {
                                                                const active = preparedPacket.sourceHealth[key];
                                                                return (
                                                                    <div
                                                                        key={key}
                                                                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium ${active
                                                                            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                                                                            : isLight
                                                                                ? 'border-black/8 bg-white/70 text-text-secondary'
                                                                                : 'border-white/10 bg-white/5 text-text-secondary'
                                                                            }`}
                                                                    >
                                                                        {active ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                                                                        {prepHealthLabels[key]}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}

                                                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_0.95fr]">
                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-400">
                                                                <Activity size={13} />
                                                                Context To Carry In
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.contextBullets || []).length > 0 ? (
                                                                    (preparedPacket?.contextBullets || []).map((bullet, index) => (
                                                                        <div key={`${bullet}-${index}`} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                                                                            <span className="mt-1 text-emerald-400">•</span>
                                                                            <span>{bullet}</span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No extra context was ranked for this event yet, so this prep stays lightweight.
                                                                    </p>
                                                                )}
                                                            </div>

                                                            {preparedPacket?.profileSnapshot?.length ? (
                                                                <div className="mt-5 border-t border-border-subtle pt-4">
                                                                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">Profile Snapshot</div>
                                                                    <div className="mt-2 space-y-2">
                                                                        {preparedPacket.profileSnapshot.map((entry, index) => (
                                                                            <div key={`${entry}-${index}`} className="text-sm leading-relaxed text-text-secondary">
                                                                                {entry}
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            ) : null}
                                                        </div>

                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">
                                                                <CheckCircle size={13} />
                                                                Before You Join
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.prepChecklist || []).length > 0 ? (
                                                                    (preparedPacket?.prepChecklist || []).map((item, index) => (
                                                                        <div key={`${item}-${index}`} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                                                                            <CheckCircle size={14} className="mt-0.5 shrink-0 text-emerald-400" />
                                                                            <span>{item}</span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No specific checklist yet. Join ready to set the objective and decision path in the first minute.
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-400">
                                                                <AlertCircle size={13} />
                                                                Open Questions
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.openQuestions || []).length > 0 ? (
                                                                    (preparedPacket?.openQuestions || []).map((question, index) => (
                                                                        <div key={`${question}-${index}`} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                                                                            <span className="mt-0.5 shrink-0 text-amber-400">?</span>
                                                                            <span>{question}</span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No unresolved questions were surfaced from nearby context.
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-400">
                                                                <Clock size={13} />
                                                                Open Commitments
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.openCommitments || []).length > 0 ? (
                                                                    (preparedPacket?.openCommitments || []).map((commitment, index) => (
                                                                        <div key={`${commitment}-${index}`} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                                                                            <span className="mt-0.5 shrink-0 text-violet-400">•</span>
                                                                            <span>{commitment}</span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No open commitments were linked to this meeting context.
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-400">
                                                                <Calendar size={13} />
                                                                Related Meetings
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.relatedMeetings || []).length > 0 ? (
                                                                    (preparedPacket?.relatedMeetings || []).map((meeting) => (
                                                                        <div
                                                                            key={meeting.id}
                                                                            className={`rounded-2xl border p-3 ${isLight ? 'bg-white/80 border-black/8' : 'bg-white/5 border-white/10'}`}
                                                                        >
                                                                            <div className="flex items-start justify-between gap-3">
                                                                                <div>
                                                                                    <div className="text-sm font-semibold text-text-primary">{meeting.title}</div>
                                                                                    <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-text-tertiary">{formatFreshness(meeting.date)}</div>
                                                                                </div>
                                                                                <div className="text-[11px] font-medium text-sky-400">{formatPrepTimestamp(meeting.date)}</div>
                                                                            </div>
                                                                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">{meeting.summary}</p>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No close prior meetings were matched to this invite.
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>

                                                        <div className={`rounded-[22px] border ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-400">
                                                                <MessageSquare size={13} />
                                                                Ranked Memory
                                                            </div>
                                                            <div className="mt-4 space-y-3">
                                                                {(preparedPacket?.memoryHighlights || []).length > 0 ? (
                                                                    (preparedPacket?.memoryHighlights || []).map((item, index) => (
                                                                        <div
                                                                            key={`${item.title}-${index}`}
                                                                            className={`rounded-2xl border p-3 ${isLight ? 'bg-white/80 border-black/8' : 'bg-white/5 border-white/10'}`}
                                                                        >
                                                                            <div className="flex items-start justify-between gap-3">
                                                                                <div>
                                                                                    <div className="text-sm font-semibold text-text-primary">{item.title}</div>
                                                                                    <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-text-tertiary">
                                                                                        {formatPrepSourceLabel(item.type)} • {item.source}
                                                                                    </div>
                                                                                </div>
                                                                                {item.date && (
                                                                                    <div className="text-[11px] font-medium text-emerald-400">{formatFreshness(item.date)}</div>
                                                                                )}
                                                                            </div>
                                                                            <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.excerpt}</p>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <p className="text-sm leading-relaxed text-text-secondary">
                                                                        No ranked memory highlights were returned for this meeting yet.
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </section>
                                        )}

                                        <section className={`relative overflow-hidden rounded-[28px] border ${isLight ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(246,248,252,0.92))] border-black/8 shadow-[0_24px_80px_rgba(15,23,42,0.08)]' : 'bg-[linear-gradient(180deg,rgba(16,23,35,0.92),rgba(10,14,24,0.88))] border-white/10 shadow-[0_30px_90px_rgba(0,0,0,0.45)]'} p-5 md:p-6`}>
                                            <div className="absolute inset-0 pointer-events-none">
                                                <div className="absolute -top-16 left-1/3 h-40 w-40 rounded-full bg-sky-500/15 blur-3xl" />
                                                <div className="absolute right-0 top-0 h-48 w-48 rounded-full bg-emerald-500/10 blur-3xl" />
                                                <div className="absolute bottom-0 left-0 h-36 w-36 rounded-full bg-violet-500/10 blur-3xl" />
                                            </div>

                                            <div className="relative z-10 space-y-5">
                                                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                                    <div className="max-w-2xl">
                                                        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-400">
                                                            <Activity size={12} />
                                                            Context Engine
                                                        </div>
                                                        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-text-primary">What Natively can actually use right now</h3>
                                                        <p className="mt-2 max-w-xl text-sm leading-relaxed text-text-secondary">
                                                            This surface shows the live state of your durable memory, local source connections, and the newest indexed meeting records available to recall, prep, and proactive guidance.
                                                        </p>
                                                    </div>

                                                    <div className="flex items-center gap-3 self-start">
                                                        <div className={`rounded-2xl border px-4 py-3 ${isLight ? 'bg-white/75 border-black/8' : 'bg-white/5 border-white/10'}`}>
                                                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Freshness</div>
                                                            <div className="mt-1 text-sm font-semibold text-text-primary">{formatFreshness(contextHubOverview?.brain?.latestRunAt || contextHubOverview?.meetings?.lastMeetingAt || contextHubOverview?.live?.lastObservedAt)}</div>
                                                            <div className="text-[11px] text-text-secondary">Latest brain or indexed signal</div>
                                                        </div>
                                                        <button
                                                            onClick={handleOpenChatLogViewer}
                                                            className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition-all ${isLight ? 'bg-white/80 border-black/8 text-text-primary hover:bg-white' : 'bg-white/5 border-white/10 text-text-primary hover:bg-white/10'}`}
                                                            title="Open trace viewer"
                                                        >
                                                            <MessageSquare size={14} className="text-sky-400" />
                                                            Trace Viewer
                                                        </button>
                                                        <button
                                                            onClick={() => fetchContextHubOverview().catch(() => { })}
                                                            className={`inline-flex h-11 items-center gap-2 rounded-2xl border px-4 text-sm font-medium transition-all ${isLight ? 'bg-white/75 border-black/8 text-text-primary hover:bg-white' : 'bg-white/5 border-white/10 text-text-primary hover:bg-white/10'}`}
                                                            title="Refresh context overview"
                                                        >
                                                            <RefreshCw size={14} className={contextHubBusy ? 'animate-spin' : ''} />
                                                            Refresh
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                                    {metricCards.map((card) => {
                                                        const Icon = card.icon;
                                                        return (
                                                            <div
                                                                key={card.label}
                                                                className={`group relative overflow-hidden rounded-[22px] border ${isLight ? 'bg-white/70 border-black/8' : 'bg-white/5 border-white/10'} px-4 py-4`}
                                                            >
                                                                <div className={`absolute inset-0 bg-gradient-to-br ${card.accent} opacity-70 transition-opacity duration-300 group-hover:opacity-100`} />
                                                                <div className="relative z-10">
                                                                    <div className="flex items-center justify-between">
                                                                        <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">{card.label}</span>
                                                                        <Icon size={15} className="text-text-secondary" />
                                                                    </div>
                                                                    <div className="mt-4 text-3xl font-semibold tracking-tight text-text-primary">{card.value}</div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>

                                                {brainActionProposals.length > 0 && (
                                                    <div className={`rounded-[24px] border ${isLight ? 'bg-white/70 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div>
                                                                <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Brain Action Queue</div>
                                                                <div className="mt-1 text-lg font-semibold text-text-primary">Proposals waiting for your signal</div>
                                                            </div>
                                                            <div className="text-[11px] text-text-secondary">
                                                                {brainActionProposals.length} visible
                                                            </div>
                                                        </div>
                                                        {proposalNotice && (
                                                            <div className={`mt-3 rounded-2xl border px-3 py-2 text-[11px] ${isLight ? 'bg-black/[0.025] border-black/8 text-slate-700' : 'bg-black/10 border-white/8 text-text-secondary'}`}>
                                                                {proposalNotice}
                                                            </div>
                                                        )}
                                                        <div className="mt-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
                                                            {brainActionProposals.map((proposal) => (
                                                                <div
                                                                    key={proposal.id}
                                                                    className={`rounded-[20px] border px-4 py-3 ${isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8'}`}
                                                                >
                                                                    <div className="flex items-start justify-between gap-3">
                                                                        <div className="min-w-0">
                                                                            <div className="text-sm font-semibold text-text-primary">{proposal.title}</div>
                                                                            <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-text-tertiary">
                                                                                {proposal.type} • {formatFreshness(proposal.updatedAt || proposal.createdAt)}
                                                                            </div>
                                                                        </div>
                                                                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                                                                            {proposal.status || 'proposed'}
                                                                        </span>
                                                                    </div>
                                                                    <p className="mt-2 text-sm leading-relaxed text-text-secondary">{proposal.summary || 'No summary provided.'}</p>
                                                                    {proposal.workflowRun && (
                                                                        <div className="mt-2 text-[11px] text-text-tertiary">
                                                                            Run {proposal.workflowRun.id} • {proposal.workflowRun.state}
                                                                        </div>
                                                                    )}
                                                                    {proposal.payload && (
                                                                        <div className="mt-3 rounded-2xl border border-border-subtle bg-bg-input/60 px-3 py-2 text-[11px] text-text-secondary">
                                                                            {Object.entries(proposal.payload).slice(0, 4).map(([key, value]) => (
                                                                                <div key={key} className="truncate">
                                                                                    <span className="text-text-tertiary">{key}:</span> {typeof value === 'string' ? value : JSON.stringify(value)}
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                    <div className="mt-3 flex flex-wrap gap-2">
                                                                        <button
                                                                            onClick={() => handleBrainProposalExecute(proposal)}
                                                                            disabled={proposalBusyId === proposal.id || !proposal.payload}
                                                                            className="inline-flex items-center gap-1.5 rounded-full bg-accent-primary px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                                                                        >
                                                                            <Zap size={12} />
                                                                            Approve & Execute
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleBrainProposalDecision(proposal, 'approved')}
                                                                            disabled={proposalBusyId === proposal.id}
                                                                            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-3 py-1.5 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/18 disabled:opacity-50"
                                                                        >
                                                                            <Check size={12} />
                                                                            Approve Signal
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleBrainProposalDecision(proposal, 'snoozed')}
                                                                            disabled={proposalBusyId === proposal.id}
                                                                            className="rounded-full bg-bg-input px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-50"
                                                                        >
                                                                            Snooze
                                                                        </button>
                                                                        <button
                                                                            onClick={() => handleBrainProposalDecision(proposal, 'rejected')}
                                                                            disabled={proposalBusyId === proposal.id}
                                                                            className="rounded-full bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-400 hover:bg-red-500/15 disabled:opacity-50"
                                                                        >
                                                                            Reject
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                                                    <div className={`rounded-[24px] border ${isLight ? 'bg-white/70 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                        <div className="flex items-center justify-between gap-3">
                                                            <div>
                                                                <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Source Health</div>
                                                                <div className="mt-1 text-lg font-semibold text-text-primary">Local and persistent context status</div>
                                                            </div>
                                                            <div className="text-[11px] text-text-secondary">
                                                                {contextHubOverview?.profile?.summary || 'No profile summary loaded yet'}
                                                            </div>
                                                        </div>

                                                        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                                                            {sourceHealthCards.map((item) => {
                                                                const Icon = item.icon;
                                                                return (
                                                                    <div
                                                                        key={item.label}
                                                                        className={`rounded-[20px] border px-4 py-3 ${item.active ? (isLight ? 'bg-emerald-500/6 border-emerald-500/20' : 'bg-emerald-500/10 border-emerald-500/20') : (isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8')}`}
                                                                    >
                                                                        <div className="flex items-start gap-3">
                                                                            <div className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl ${item.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-bg-item-surface text-text-tertiary'}`}>
                                                                                <Icon size={16} />
                                                                            </div>
                                                                            <div className="min-w-0">
                                                                                <div className="flex items-center gap-2">
                                                                                    <span className="text-sm font-medium text-text-primary">{item.label}</span>
                                                                                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.active ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-text-tertiary'}`}>
                                                                                        {item.value}
                                                                                    </span>
                                                                                </div>
                                                                                <div className="mt-1 text-[11px] leading-relaxed text-text-secondary">{item.meta}</div>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-1 gap-4">
                                                        <div className={`rounded-[24px] border ${isLight ? 'bg-white/70 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Freshest Signals</div>
                                                            <div className="mt-3 space-y-3">
                                                                <div className={`rounded-2xl border px-4 py-3 ${isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8'}`}>
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <span className="text-sm font-medium text-text-primary">Last meeting indexed</span>
                                                                        <span className="text-[11px] font-medium text-sky-400">{formatFreshness(contextHubOverview?.meetings?.lastMeetingAt)}</span>
                                                                    </div>
                                                                    <div className="mt-1 text-[11px] text-text-secondary">{lastIndexedAt}</div>
                                                                </div>
                                                                <div className={`rounded-2xl border px-4 py-3 ${isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8'}`}>
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <span className="text-sm font-medium text-text-primary">Latest brain run</span>
                                                                        <span className="text-[11px] font-medium text-emerald-400">{formatFreshness(contextHubOverview?.brain?.latestRunAt)}</span>
                                                                    </div>
                                                                    <div className="mt-1 text-[11px] text-text-secondary">{contextHubOverview?.brain?.latestRunAt ? new Date(contextHubOverview.brain.latestRunAt).toLocaleString() : lastObservedAt}</div>
                                                                </div>
                                                                <div className={`rounded-2xl border px-4 py-3 ${isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8'}`}>
                                                                    <div className="text-sm font-medium text-text-primary">Brain footprint</div>
                                                                    <div className="mt-1 text-[11px] text-text-secondary">
                                                                        {`${contextHubOverview?.brain?.prepPacketsReady || 0} prep packets • ${contextHubOverview?.brain?.cortexInsights || 0} Cortex insights • ${contextHubOverview?.brain?.openActionProposals || 0} open proposals`}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        <div className={`rounded-[24px] border ${isLight ? 'bg-white/70 border-black/8' : 'bg-white/5 border-white/10'} p-4`}>
                                                            <div className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">Newest Indexed Meetings</div>
                                                            <div className="mt-3 space-y-2">
                                                                {indexedMeetingsPreview.length === 0 ? (
                                                                    <div className={`rounded-2xl border px-4 py-6 text-sm text-text-secondary ${isLight ? 'bg-black/[0.025] border-black/8' : 'bg-black/10 border-white/8'}`}>
                                                                        No meeting history is visible yet. As soon as a manual, Teams, Cluely, or native meeting is indexed, it will surface here.
                                                                    </div>
                                                                ) : (
                                                                    indexedMeetingsPreview.map((meeting) => (
                                                                        <button
                                                                            key={`context-preview-${meeting.id}`}
                                                                            onClick={() => handleOpenMeeting(meeting)}
                                                                            className={`w-full rounded-[18px] border px-4 py-3 text-left transition-all ${isLight ? 'bg-black/[0.025] border-black/8 hover:bg-black/[0.04]' : 'bg-black/10 border-white/8 hover:bg-white/6'}`}
                                                                        >
                                                                            <div className="flex items-start justify-between gap-3">
                                                                                <div className="min-w-0">
                                                                                    <div className="truncate text-sm font-medium text-text-primary">{meeting.title}</div>
                                                                                    <div className="mt-1 text-[11px] text-text-secondary">
                                                                                        {new Date(meeting.date).toLocaleString()}
                                                                                    </div>
                                                                                </div>
                                                                                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${getMeetingSourceBadge(meeting).className}`}>
                                                                                    {getMeetingSourceBadge(meeting).label}
                                                                                </span>
                                                                            </div>
                                                                        </button>
                                                                    ))
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </section>

                                        {/* Iterating Date Groups */}
                                        {sortedGroups.map((label) => (
                                            <section key={label}>
                                                <h3 className="text-[13px] font-medium text-text-secondary mb-3 pl-1">{label}</h3>
                                                <div className="space-y-1">
                                                    {groupedMeetings[label].map((m) => (
                                                        <motion.div
                                                            key={m.id}
                                                            layoutId={`meeting-${m.id}`}
                                                            className="group relative flex items-center justify-between px-3 py-2 rounded-lg bg-transparent hover:bg-bg-elevated transition-colors"
                                                            onClick={() => handleOpenMeeting(m)}
                                                        >
                                                            <div className="max-w-[60%] min-w-0">
                                                                <div className={`font-medium text-[14px] truncate ${m.title === 'Processing...' ? 'text-blue-400 italic animate-pulse' : 'text-text-primary'}`}>
                                                                    {m.title}
                                                                </div>
                                                                <div className="mt-1">
                                                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium border ${getMeetingSourceBadge(m).className}`}>
                                                                        {getMeetingSourceBadge(m).label}
                                                                    </span>
                                                                </div>
                                                            </div>

                                                            {/* Time & Duration Section */}
                                                            <div className="flex items-center gap-4">
                                                                {m.title === 'Processing...' ? (
                                                                    <div className="flex items-center gap-2 transition-all duration-200 ease-out group-hover:opacity-0 group-hover:translate-x-2 delayed-hover-exit">
                                                                        <RefreshCw size={12} className="animate-spin text-blue-500" />
                                                                        <span className="text-xs text-blue-500 font-medium">Finalizing...</span>
                                                                    </div>
                                                                ) : (
                                                                    <>
                                                                        <span className="relative z-10 bg-bg-elevated text-text-secondary text-[9px] px-1.5 py-0.5 rounded-full font-medium min-w-[35px] text-center tracking-wide">
                                                                            {formatDurationPill(m.duration)}
                                                                        </span>

                                                                        {/* Time Text (Should fade out on hover) */}
                                                                        <span className="text-[13px] text-text-secondary font-medium min-w-[60px] text-right transition-all duration-200 ease-out group-hover:opacity-0 group-hover:translate-x-2 delayed-hover-exit">
                                                                            {formatTime(m.date)}
                                                                        </span>
                                                                    </>
                                                                )}
                                                            </div>

                                                            {/* Context Menu Trigger (Slides in on hover) */}
                                                            <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 translate-x-4 transition-all duration-300 ease-out group-hover:opacity-100 group-hover:translate-x-0">
                                                                <button
                                                                    className="p-1.5 text-text-secondary hover:text-text-primary transition-colors"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setActiveMenuId(activeMenuId === m.id ? null : m.id);
                                                                    }}
                                                                >
                                                                    <MoreHorizontal size={16} />
                                                                </button>
                                                            </div>

                                                            {/* Dropdown Menu */}
                                                            <AnimatePresence>
                                                                {activeMenuId === m.id && (
                                                                    <motion.div
                                                                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                                                                        animate={{ opacity: 1, scale: 1, y: 0 }}
                                                                        exit={{ opacity: 0, scale: 0.95, y: 5 }}
                                                                        transition={{ duration: 0.1 }}
                                                                        className={`absolute right-0 top-full mt-1 w-[90px] backdrop-blur-xl rounded-lg shadow-2xl z-50 overflow-hidden border ${isLight ? 'bg-bg-elevated border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.12)]' : 'bg-[#1E1E1E]/80 border-white/10'}`}
                                                                        onClick={(e) => e.stopPropagation()}
                                                                        onMouseEnter={() => setMenuEntered(true)}
                                                                        onMouseLeave={() => {
                                                                            if (menuEntered) setActiveMenuId(null);
                                                                        }}
                                                                    >
                                                                        <div className="p-1 flex flex-col gap-0.5">
                                                                            <button
                                                                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary rounded-lg transition-colors text-left ${isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/10'}`}
                                                                                onClick={async () => {
                                                                                    setActiveMenuId(null);
                                                                                    analytics.trackPdfExported();
                                                                                    // Fetch full details if needed
                                                                                    if (window.electronAPI && window.electronAPI.getMeetingDetails) {
                                                                                        try {
                                                                                            const fullMeeting = await window.electronAPI.getMeetingDetails(m.id);
                                                                                            if (fullMeeting) {
                                                                                                generateMeetingPDF(fullMeeting);
                                                                                            } else {
                                                                                                generateMeetingPDF(m);
                                                                                            }
                                                                                        } catch (e) {
                                                                                            console.error("Failed to fetch details for PDF", e);
                                                                                            generateMeetingPDF(m);
                                                                                        }
                                                                                    } else {
                                                                                        generateMeetingPDF(m);
                                                                                    }
                                                                                }}
                                                                            >
                                                                                <Download size={13} />
                                                                                Export
                                                                            </button>
                                                                            <button
                                                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 hover:text-red-300 rounded-lg transition-colors text-left"
                                                                                onClick={async () => {
                                                                                    if (window.electronAPI && window.electronAPI.deleteMeeting) {
                                                                                        const success = await window.electronAPI.deleteMeeting(m.id);
                                                                                        if (success) {
                                                                                            // Optimistic update or refetch
                                                                                            setMeetings(prev => prev.filter(meeting => meeting.id !== m.id));
                                                                                        }
                                                                                    }
                                                                                    setActiveMenuId(null);
                                                                                }}
                                                                            >
                                                                                <Trash2 size={13} />
                                                                                Delete
                                                                            </button>
                                                                        </div>
                                                                    </motion.div>
                                                                )}
                                                            </AnimatePresence>
                                                        </motion.div>
                                                    ))}
                                                </div>
                                            </section>
                                        ))}

                                        {meetings.length === 0 && (
                                            <div className="p-4 text-text-tertiary text-sm">No recent meetings.</div>
                                        )}

                                    </div>
                                </section>
                            </main>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>



            {/* Notification Toast - Liquid Glass (macOS 26 Tahoe Concept) */}
            <AnimatePresence>
                {showNotification && (
                    <motion.div
                        initial={{ x: 300, opacity: 0, scale: 0.9 }}
                        animate={{ x: 0, opacity: 1, scale: 1 }}
                        exit={{ x: 300, opacity: 0, scale: 0.95 }}
                        transition={{ type: "spring", stiffness: 350, damping: 30, mass: 1 }}
                        className={`fixed bottom-10 right-10 z-[2000] flex items-center gap-4 pl-4 pr-6 py-3.5 rounded-[18px] backdrop-blur-xl saturate-[180%] ring-1 ring-black/10 ${isLight ? 'bg-bg-elevated/90 border border-border-muted shadow-[0_8px_32px_rgba(0,0,0,0.15),inset_0_1px_0_rgba(255,255,255,0.9)]' : 'bg-[#2A2A2E]/40 border border-white/10 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-1px_0_rgba(255,255,255,0.05)]'}`}
                    >
                        {/* Liquid Icon Orb */}
                        <div className="relative flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-b from-blue-400/20 to-blue-600/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)] border border-white/5">
                            <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-md" />
                            <RefreshCw size={15} className="text-blue-300 animate-[spin_2s_linear_infinite] drop-shadow-[0_0_5px_rgba(59,130,246,0.6)]" />
                        </div>

                        {/* Text Content */}
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[14px] font-semibold text-text-primary leading-none tracking-tight">Refreshed</span>
                            <span className="text-[11px] text-text-tertiary font-medium leading-none tracking-wide">Synced with calendar</span>
                        </div>

                        {/* Specular Highlight Overlay */}
                        <div className="absolute inset-0 rounded-[18px] bg-gradient-to-tr from-white/5 via-transparent to-transparent pointer-events-none" />
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Global Chat Overlay */}
            <GlobalChatOverlay
                isOpen={isGlobalChatOpen}
                onClose={() => {
                    setIsGlobalChatOpen(false);
                    setSubmittedGlobalQuery('');
                }}
                initialQuery={submittedGlobalQuery}
            />
        </div >
    );
};

export default Launcher;
