import React, { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
    AlertCircle,
    ArrowUp,
    Bot,
    CalendarClock,
    Check,
    Copy,
    FileText,
    History,
    ListTodo,
    MessageSquareText,
    Monitor,
    RefreshCw,
    Search,
    Sparkles,
    X,
    Zap,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MeetingChatOverlay from './MeetingChatOverlay';
import EditableTextBlock from './EditableTextBlock';

interface MeetingContextOverviewEvidence {
    title: string;
    sourceType: string;
    excerpt: string;
    date?: string;
    score?: number;
}

interface MeetingContextOverview {
    synopsis: string;
    significance: string;
    value: string;
    continuity: string[];
    upcomingSignals: string[];
    evidence: MeetingContextOverviewEvidence[];
    generatedAt: string;
    confidence?: 'low' | 'medium' | 'high';
    model?: string;
}

interface MeetingUsageScreenCapture {
    path: string;
    capturedAt: number;
    displayId: number;
    displayLabel: string;
    alias: string;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    isPrimary: boolean;
}

interface MeetingUsageInteraction {
    type: 'assist' | 'followup' | 'chat' | 'followup_questions';
    timestamp: number;
    question?: string;
    answer?: string;
    items?: string[];
    screenCaptures?: MeetingUsageScreenCapture[];
}

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
        relatedArtifacts?: string[];
        sourceMeetingId?: string;
    };
    detailedSummary?: {
        overview?: string;
        actionItems: string[];
        keyPoints: string[];
        actionItemsTitle?: string;
        keyPointsTitle?: string;
        contextOverview?: MeetingContextOverview;
    };
    transcript?: Array<{
        speaker: string;
        text: string;
        timestamp: number;
    }>;
    usage?: MeetingUsageInteraction[];
}

interface MeetingDetailsProps {
    meeting: Meeting;
    onBack: () => void;
    onOpenSettings: () => void;
}

interface TranscriptGroup {
    speaker: string;
    label: string;
    entries: Array<{ text: string; timestamp: number }>;
    startTimestamp: number;
    endTimestamp: number;
}

interface ScreenGalleryState {
    title: string;
    captures: Array<MeetingUsageScreenCapture & { preview: string | null }>;
}

const markdownComponents = {
    h1: ({ node, ...props }: any) => <h1 className="mb-3 text-xl font-semibold text-text-primary" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="mb-3 text-lg font-semibold text-text-primary" {...props} />,
    h3: ({ node, ...props }: any) => <h3 className="mb-2 text-base font-semibold text-text-primary" {...props} />,
    p: ({ node, ...props }: any) => <p className="mb-3 text-sm leading-7 text-text-secondary last:mb-0 whitespace-pre-wrap" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="mb-3 ml-5 list-disc space-y-2 text-sm text-text-secondary" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="mb-3 ml-5 list-decimal space-y-2 text-sm text-text-secondary" {...props} />,
    li: ({ node, ...props }: any) => <li className="leading-7" {...props} />,
    strong: ({ node, ...props }: any) => <strong className="font-semibold text-text-primary" {...props} />,
    a: ({ node, ...props }: any) => <a className="text-accent-primary hover:underline" {...props} />,
    code: ({ node, inline, className, children, ...props }: any) => (
        <code className="rounded-md border border-border-subtle bg-bg-input px-1.5 py-0.5 text-[13px] text-text-primary" {...props}>
            {children}
        </code>
    ),
};

const emptyOverview: MeetingContextOverview = {
    synopsis: '',
    significance: '',
    value: '',
    continuity: [],
    upcomingSignals: [],
    evidence: [],
    generatedAt: '',
};

const formatMeetingDate = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
};

const formatShortDate = (value?: string) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    });
};

const formatTimestamp = (ms: number) => {
    if (!Number.isFinite(ms)) return '--';
    if (ms >= 0 && ms < 24 * 60 * 60 * 1000) {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '--';
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
};

const getMeetingSourceBadge = (meeting: Meeting) => {
    switch (meeting.source) {
        case 'calendar':
            return { label: 'Calendar', className: 'bg-blue-500/10 text-blue-500 border-blue-500/20' };
        case 'teams':
            return { label: 'Teams', className: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' };
        case 'cluely':
            return { label: 'Cluely', className: 'bg-amber-500/10 text-amber-500 border-amber-500/20' };
        case 'imported':
            return { label: 'Imported', className: 'bg-violet-500/10 text-violet-500 border-violet-500/20' };
        default:
            return { label: 'Natively', className: 'bg-bg-item-surface text-text-secondary border-border-subtle' };
    }
};

const getSourceTypeLabel = (sourceType: string) => {
    switch (sourceType) {
        case 'calendar_event':
            return 'Upcoming event';
        case 'meeting_summary':
        case 'manual_import':
            return 'Meeting record';
        case 'meeting_transcript':
            return 'Transcript';
        case 'task_or_commitment':
            return 'Commitment';
        case 'profile_fact':
            return 'Profile';
        case 'email_thread':
            return 'Email';
        case 'teams_thread':
            return 'Teams';
        default:
            return sourceType.replace(/_/g, ' ');
    }
};

const compactWhitespace = (value: string) => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeSpeaker = (speaker: string) => compactWhitespace(speaker || '').toLowerCase();

const getSpeakerLabel = (speaker: string) => {
    const normalized = normalizeSpeaker(speaker);
    if (!normalized || normalized === 'external' || normalized === 'them' || normalized === 'participant') return 'Participant';
    if (normalized === 'user' || normalized === 'me') return 'Me';
    if (normalized === 'assistant' || normalized === 'model' || normalized === 'ai' || normalized === 'system') return 'System';
    return speaker.split(/\s+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
};

const getSpeakerAccentClass = (speaker: string) => {
    const normalized = normalizeSpeaker(speaker);
    if (normalized === 'user' || normalized === 'me') return 'border-blue-500/20 bg-blue-500/10 text-blue-500';
    if (normalized === 'assistant' || normalized === 'model' || normalized === 'ai' || normalized === 'system') return 'border-violet-500/20 bg-violet-500/10 text-violet-500';
    return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500';
};

const shouldHideSpeaker = (speaker: string) => ['system', 'assistant', 'model', 'ai'].includes(normalizeSpeaker(speaker));

const getStaggerStyle = (index: number): CSSProperties => ({ ['--i' as any]: Math.min(index, 15) });

const getInteractionLabel = (interaction: Pick<MeetingUsageInteraction, 'type'>) => interaction.type.replace(/_/g, ' ');

const normalizeTranscriptBlobText = (value: string) => compactWhitespace(
    String(value || '')
        .replace(/\*\*([^*]+)\*\*\s*\*\(\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\)\*/g, '$1 [$2]:')
        .replace(/\*\*([^*]+)\*\*\s*\[\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\]/g, '$1 [$2]:')
);

const parseTranscriptTimestampMs = (value?: string | null) => {
    if (!value) return null;
    const parts = value.split(':').map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return null;
    if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
    if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
    return null;
};

const splitInlineTranscriptBlob = (entry: NonNullable<Meeting['transcript']>[number]) => {
    const normalizedText = normalizeTranscriptBlobText(entry.text);
    const inlineMarkerRegex = /([A-Z][A-Za-z0-9.'&/-]*(?:\s+[A-Z][A-Za-z0-9.'&/-]*){0,4})\s*(?:\[\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\]|\(\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*\))\s*:/g;
    const matches = Array.from(normalizedText.matchAll(inlineMarkerRegex));

    if (matches.length === 0) {
        return [{
            speaker: entry.speaker,
            text: compactWhitespace(entry.text),
            timestamp: entry.timestamp,
        }];
    }

    const segments = matches
        .map((match, index) => {
            const start = match.index ?? 0;
            const bodyStart = start + match[0].length;
            const nextStart = index + 1 < matches.length ? (matches[index + 1].index ?? normalizedText.length) : normalizedText.length;
            const body = compactWhitespace(normalizedText.slice(bodyStart, nextStart));
            if (!body) return null;

            return {
                speaker: match[1] || entry.speaker,
                text: body,
                timestamp: parseTranscriptTimestampMs(match[2] || match[3]) ?? (entry.timestamp + (index * 15000)),
            };
        })
        .filter((segment): segment is { speaker: string; text: string; timestamp: number } => Boolean(segment));

    return segments.length > 0
        ? segments
        : [{
            speaker: entry.speaker,
            text: compactWhitespace(entry.text),
            timestamp: entry.timestamp,
        }];
};

const normalizeTranscriptEntries = (entries: Meeting['transcript'] = []) => (
    (entries || [])
        .flatMap((entry) => splitInlineTranscriptBlob(entry))
        .map((entry) => ({
            speaker: entry.speaker,
            text: compactWhitespace(entry.text),
            timestamp: entry.timestamp,
        }))
        .filter((entry) => entry.text)
);

const ensureDetailedSummary = (meeting: Meeting) => ({
    overview: meeting.detailedSummary?.overview || '',
    actionItems: meeting.detailedSummary?.actionItems || [],
    keyPoints: meeting.detailedSummary?.keyPoints || [],
    actionItemsTitle: meeting.detailedSummary?.actionItemsTitle,
    keyPointsTitle: meeting.detailedSummary?.keyPointsTitle,
    contextOverview: meeting.detailedSummary?.contextOverview,
});

const groupTranscriptEntries = (entries: Meeting['transcript'] = [], filterValue: string): TranscriptGroup[] => {
    const filter = compactWhitespace(filterValue).toLowerCase();
    const filteredEntries = normalizeTranscriptEntries(entries)
        .filter((entry) => !shouldHideSpeaker(entry.speaker))
        .filter((entry) => !filter || `${entry.speaker} ${entry.text}`.toLowerCase().includes(filter));

    const groups: TranscriptGroup[] = [];
    for (const entry of filteredEntries) {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup && normalizeSpeaker(lastGroup.speaker) === normalizeSpeaker(entry.speaker)) {
            lastGroup.entries.push({ text: entry.text, timestamp: entry.timestamp });
            lastGroup.endTimestamp = entry.timestamp;
            continue;
        }

        groups.push({
            speaker: entry.speaker,
            label: getSpeakerLabel(entry.speaker),
            entries: [{ text: entry.text, timestamp: entry.timestamp }],
            startTimestamp: entry.timestamp,
            endTimestamp: entry.timestamp,
        });
    }

    return groups;
};

const MeetingDetails: React.FC<MeetingDetailsProps> = ({ meeting: initialMeeting, onBack, onOpenSettings }) => {
    void onBack;
    void onOpenSettings;
    const [meeting, setMeeting] = useState<Meeting>(initialMeeting);
    const [activeTab, setActiveTab] = useState<'overview' | 'transcript' | 'usage'>('overview');
    const [query, setQuery] = useState('');
    const [transcriptFilter, setTranscriptFilter] = useState('');
    const [isCopied, setIsCopied] = useState(false);
    const [isChatOpen, setIsChatOpen] = useState(false);
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [isGeneratingOverview, setIsGeneratingOverview] = useState(false);
    const [overviewError, setOverviewError] = useState('');
    const [screenGallery, setScreenGallery] = useState<ScreenGalleryState | null>(null);
    const [isLoadingScreenGallery, setIsLoadingScreenGallery] = useState(false);
    const [screenGalleryError, setScreenGalleryError] = useState('');

    const detailedSummary = useMemo(() => ensureDetailedSummary(meeting), [meeting]);
    const contextOverview = detailedSummary.contextOverview || emptyOverview;
    const transcriptGroups = useMemo(() => groupTranscriptEntries(meeting.transcript || [], transcriptFilter), [meeting.transcript, transcriptFilter]);

    const transcriptStats = useMemo(() => {
        const speakers = new Set((meeting.transcript || []).filter((entry) => !shouldHideSpeaker(entry.speaker)).map((entry) => getSpeakerLabel(entry.speaker)));
        return {
            segmentCount: (meeting.transcript || []).filter((entry) => !shouldHideSpeaker(entry.speaker)).length,
            speakerCount: speakers.size,
            actionCount: detailedSummary.actionItems.filter(Boolean).length,
            usageCount: (meeting.usage || []).length,
        };
    }, [meeting.transcript, meeting.usage, detailedSummary.actionItems]);

    const artifacts = meeting.importMetadata?.relatedArtifacts || [];

    useEffect(() => {
        setMeeting(initialMeeting);
        setActiveTab('overview');
        setTranscriptFilter('');
        setQuery('');
        setSubmittedQuery('');
        setOverviewError('');
        setScreenGallery(null);
        setScreenGalleryError('');
        setIsLoadingScreenGallery(false);
    }, [initialMeeting]);

    const mergeContextOverview = (nextOverview: MeetingContextOverview) => {
        setMeeting((prev) => ({
            ...prev,
            detailedSummary: {
                ...ensureDetailedSummary(prev),
                contextOverview: nextOverview,
            },
        }));
    };

    const generateOverview = async (force = false) => {
        if (!window.electronAPI?.generateMeetingOverview) return;

        try {
            setIsGeneratingOverview(true);
            setOverviewError('');
            const overview = await window.electronAPI.generateMeetingOverview(meeting.id, { force });
            if (overview) mergeContextOverview(overview);
        } catch (error: any) {
            console.error('[MeetingDetails] Failed to generate meeting overview:', error);
            setOverviewError(error?.message || 'Unable to generate the meeting overview right now.');
        } finally {
            setIsGeneratingOverview(false);
        }
    };

    useEffect(() => {
        if (!meeting.id || detailedSummary.contextOverview || isGeneratingOverview || !window.electronAPI?.generateMeetingOverview) return;
        void generateOverview(false);
    }, [meeting.id, detailedSummary.contextOverview]);

    const handleSubmitQuestion = () => {
        if (!query.trim()) return;
        setSubmittedQuery(query);
        if (!isChatOpen) setIsChatOpen(true);
        setQuery('');
    };

    const handleInputKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && query.trim()) {
            e.preventDefault();
            handleSubmitQuestion();
        }
    };

    const handleCopy = async () => {
        let textToCopy = '';

        if (activeTab === 'overview') {
            textToCopy = [
                `Meeting: ${meeting.title}`,
                `Date: ${formatMeetingDate(meeting.date)}`,
                '',
                `Synopsis: ${contextOverview.synopsis || 'None'}`,
                `Why it matters: ${contextOverview.significance || 'None'}`,
                `Value: ${contextOverview.value || 'None'}`,
                '',
                'Continuity:',
                ...(contextOverview.continuity.length ? contextOverview.continuity.map((item) => `- ${item}`) : ['- None']),
                '',
                'Upcoming signals:',
                ...(contextOverview.upcomingSignals.length ? contextOverview.upcomingSignals.map((item) => `- ${item}`) : ['- None']),
                '',
                'Key points:',
                ...(detailedSummary.keyPoints.length ? detailedSummary.keyPoints.map((item) => `- ${item}`) : ['- None']),
                '',
                'Action items:',
                ...(detailedSummary.actionItems.length ? detailedSummary.actionItems.map((item) => `- ${item}`) : ['- None']),
            ].join('\n');
        } else if (activeTab === 'transcript') {
            textToCopy = transcriptGroups.map((group) => [`${group.label} [${formatTimestamp(group.startTimestamp)}]`, ...group.entries.map((entry) => entry.text)].join('\n')).join('\n\n');
        } else {
            textToCopy = (meeting.usage || []).map((item) => [item.question ? `Q: ${item.question}` : '', item.answer ? `A: ${item.answer}` : '', item.items?.length ? `Items: ${item.items.join(' | ')}` : ''].filter(Boolean).join('\n')).join('\n\n');
        }

        if (!textToCopy.trim()) return;

        try {
            await navigator.clipboard.writeText(textToCopy);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch (error) {
            console.error('[MeetingDetails] Failed to copy content:', error);
        }
    };

    const handleTitleSave = async (newTitle: string) => {
        setMeeting((prev) => ({ ...prev, title: newTitle }));
        await window.electronAPI?.updateMeetingTitle?.(meeting.id, newTitle);
    };

    const handleActionItemSave = async (index: number, nextValue: string) => {
        const nextItems = [...detailedSummary.actionItems];
        nextItems[index] = nextValue;
        setMeeting((prev) => ({ ...prev, detailedSummary: { ...ensureDetailedSummary(prev), actionItems: nextItems } }));
        await window.electronAPI?.updateMeetingSummary?.(meeting.id, { actionItems: nextItems });
    };

    const handleKeyPointSave = async (index: number, nextValue: string) => {
        const nextItems = [...detailedSummary.keyPoints];
        nextItems[index] = nextValue;
        setMeeting((prev) => ({ ...prev, detailedSummary: { ...ensureDetailedSummary(prev), keyPoints: nextItems } }));
        await window.electronAPI?.updateMeetingSummary?.(meeting.id, { keyPoints: nextItems });
    };

    const openScreenGallery = async (interaction: MeetingUsageInteraction) => {
        if (!interaction.screenCaptures?.length) return;

        const title = interaction.question || getInteractionLabel(interaction);
        setScreenGallery({ title, captures: [] });
        setIsLoadingScreenGallery(true);
        setScreenGalleryError('');

        try {
            const captures = await Promise.all(
                interaction.screenCaptures.map(async (capture) => ({
                    ...capture,
                    preview: await window.electronAPI?.getImagePreview?.(capture.path) ?? null,
                }))
            );
            setScreenGallery({ title, captures });
        } catch (error) {
            console.error('[MeetingDetails] Failed to load screen gallery previews:', error);
            setScreenGalleryError('Unable to load the saved screen captures for this turn.');
        } finally {
            setIsLoadingScreenGallery(false);
        }
    };

    return (
        <div className="relative h-full w-full flex flex-col overflow-hidden bg-bg-secondary text-text-secondary">
            <main className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="mx-auto max-w-6xl px-8 py-8 pb-36 gs-page-enter">
                    <section className="mb-6">
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${getMeetingSourceBadge(meeting).className}`}>
                                {getMeetingSourceBadge(meeting).label}
                            </span>
                            <span className="text-xs text-text-tertiary">{formatMeetingDate(meeting.date)}</span>
                            {meeting.importMetadata?.importedAt && (
                                <span className="text-xs text-text-tertiary">Imported {formatShortDate(meeting.importMetadata.importedAt)}</span>
                            )}
                        </div>

                        <EditableTextBlock
                            initialValue={meeting.title}
                            onSave={handleTitleSave}
                            tagName="h1"
                            className="text-4xl font-celeb-light text-text-primary tracking-[0.02em] leading-tight"
                            multiline={false}
                        />
                    </section>

                    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(290px,0.85fr)]">
                        <section className="rounded-[28px] border border-border-subtle bg-bg-main p-6 md:p-7 gs-stagger-card" style={getStaggerStyle(0)}>
                            <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
                                <div className="max-w-2xl">
                                    <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-text-tertiary">
                                        <Sparkles size={14} />
                                        Overview Deck
                                    </div>
                                    <h2 className="text-2xl font-semibold tracking-tight text-text-primary">Read the significance before the evidence.</h2>
                                    <p className="mt-2 text-sm leading-7 text-text-secondary">
                                        This briefing is generated with Claude from the meeting record plus related context already stored in Natively.
                                    </p>
                                </div>

                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => void generateOverview(true)}
                                        disabled={isGeneratingOverview}
                                        className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-item-surface px-4 py-2 text-xs font-semibold text-text-primary transition-colors hover:border-border-muted disabled:opacity-60"
                                    >
                                        <RefreshCw size={14} className={isGeneratingOverview ? 'animate-spin' : ''} />
                                        {isGeneratingOverview ? 'Refreshing brief...' : 'Refresh brief'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleCopy}
                                        className="inline-flex items-center gap-2 rounded-full border border-border-subtle px-4 py-2 text-xs font-semibold text-text-secondary transition-colors hover:border-border-muted hover:text-text-primary"
                                    >
                                        {isCopied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                        {isCopied ? 'Copied' : `Copy ${activeTab}`}
                                    </button>
                                </div>
                            </div>

                            {overviewError && (
                                <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-600">
                                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                                    <div>{overviewError}</div>
                                </div>
                            )}

                            {isGeneratingOverview && !detailedSummary.contextOverview ? (
                                <div className="grid gap-4 md:grid-cols-2">
                                    {[0, 1, 2].map((index) => (
                                        <div key={index} className={`rounded-3xl border border-border-subtle bg-bg-card p-5 animate-pulse ${index === 0 ? 'md:col-span-2' : ''}`}>
                                            <div className="mb-3 h-3 w-24 rounded-full bg-bg-item-surface" />
                                            <div className="space-y-2">
                                                <div className="h-3 rounded-full bg-bg-item-surface" />
                                                <div className="h-3 rounded-full bg-bg-item-surface" />
                                                <div className="h-3 w-2/3 rounded-full bg-bg-item-surface" />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <article className="rounded-3xl border border-border-subtle bg-bg-card p-5 md:col-span-2">
                                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <Sparkles size={14} />
                                                Synopsis
                                            </div>
                                            <p className="text-[15px] leading-8 text-text-primary">
                                                {contextOverview.synopsis || 'A structured synopsis will appear here once the meeting brief finishes generating.'}
                                            </p>
                                        </article>

                                        <article className="rounded-3xl border border-border-subtle bg-bg-card p-5">
                                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <History size={14} />
                                                Why It Matters
                                            </div>
                                            <p className="text-sm leading-7 text-text-secondary">
                                                {contextOverview.significance || 'The meeting significance will be derived from prior context and linked work.'}
                                            </p>
                                        </article>

                                        <article className="rounded-3xl border border-border-subtle bg-bg-card p-5">
                                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <Zap size={14} />
                                                Value Created
                                            </div>
                                            <p className="text-sm leading-7 text-text-secondary">
                                                {contextOverview.value || 'The operational value of the meeting will appear here once the brief is ready.'}
                                            </p>
                                        </article>
                                    </div>

                                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                        <article className="rounded-3xl border border-border-subtle bg-bg-card p-5">
                                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <History size={14} />
                                                Continuity
                                            </div>
                                            <ul className="space-y-3">
                                                {(contextOverview.continuity.length ? contextOverview.continuity : ['No strong continuity signal was found yet.']).map((item, index) => (
                                                    <li key={`${item}-${index}`} className="flex items-start gap-3">
                                                        <div className="mt-2 h-1.5 w-1.5 rounded-full bg-accent-primary shrink-0" />
                                                        <p className="text-sm leading-7 text-text-secondary">{item}</p>
                                                    </li>
                                                ))}
                                            </ul>
                                        </article>

                                        <article className="rounded-3xl border border-border-subtle bg-bg-card p-5">
                                            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <CalendarClock size={14} />
                                                Upcoming Signals
                                            </div>
                                            <ul className="space-y-3">
                                                {(contextOverview.upcomingSignals.length ? contextOverview.upcomingSignals : ['No likely upcoming meeting link surfaced from the current calendar signal.']).map((item, index) => (
                                                    <li key={`${item}-${index}`} className="flex items-start gap-3">
                                                        <div className="mt-2 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                                                        <p className="text-sm leading-7 text-text-secondary">{item}</p>
                                                    </li>
                                                ))}
                                            </ul>
                                        </article>
                                    </div>
                                </>
                            )}
                        </section>

                        <aside className="space-y-4">
                            <section className="rounded-[28px] border border-border-subtle bg-bg-main p-5 gs-stagger-card" style={getStaggerStyle(1)}>
                                <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Meeting signal</div>
                                <div className="grid grid-cols-2 gap-3">
                                    {[
                                        { label: 'Transcript lines', value: transcriptStats.segmentCount },
                                        { label: 'Speakers', value: transcriptStats.speakerCount },
                                        { label: 'Action items', value: transcriptStats.actionCount },
                                        { label: 'Assistant turns', value: transcriptStats.usageCount },
                                    ].map((stat, index) => (
                                        <div key={stat.label} className="rounded-2xl border border-border-subtle bg-bg-card px-4 py-3">
                                            <div className="text-2xl font-semibold text-text-primary gs-hero-enter" style={getStaggerStyle(index)}>{stat.value}</div>
                                            <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-text-tertiary">{stat.label}</div>
                                        </div>
                                    ))}
                                </div>
                            </section>

                            <section className="rounded-[28px] border border-border-subtle bg-bg-main p-5 gs-stagger-card" style={getStaggerStyle(2)}>
                                <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                    <Sparkles size={14} />
                                    Context evidence
                                </div>
                                <div className="space-y-3">
                                    {(contextOverview.evidence.length ? contextOverview.evidence : []).map((item, index) => (
                                        <article key={`${item.title}-${index}`} className="rounded-2xl border border-border-subtle bg-bg-card p-4 gs-stagger-row gs-row-hover" style={getStaggerStyle(index)}>
                                            <div className="mb-1 flex items-center justify-between gap-2">
                                                <div className="text-sm font-semibold text-text-primary">{item.title}</div>
                                                <span className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">{getSourceTypeLabel(item.sourceType)}</span>
                                            </div>
                                            <p className="text-sm leading-6 text-text-secondary">{item.excerpt}</p>
                                            {item.date && <div className="mt-2 text-xs text-text-tertiary">{formatShortDate(item.date)}</div>}
                                        </article>
                                    ))}
                                    {!contextOverview.evidence.length && (
                                        <div className="rounded-2xl border border-dashed border-border-subtle px-4 py-6 text-center">
                                            <Sparkles size={18} className="mx-auto mb-3 gs-float text-text-tertiary" />
                                            <p className="text-sm text-text-tertiary">Evidence cards appear here after the overview is generated.</p>
                                        </div>
                                    )}
                                </div>
                            </section>

                            <section className="rounded-[28px] border border-border-subtle bg-bg-main p-5 gs-stagger-card" style={getStaggerStyle(3)}>
                                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Storage & provenance</div>
                                <div className="space-y-2 text-sm leading-6 text-text-secondary">
                                    <p>Model: <span className="text-text-primary">{contextOverview.model || 'Claude'}</span></p>
                                    <p>Confidence: <span className="text-text-primary uppercase">{contextOverview.confidence || 'n/a'}</span></p>
                                    <p>Generated: <span className="text-text-primary">{contextOverview.generatedAt ? formatShortDate(contextOverview.generatedAt) : 'Pending'}</span></p>
                                </div>

                                {artifacts.length > 0 && (
                                    <div className="mt-4 space-y-2">
                                        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Artifacts</div>
                                        {artifacts.slice(0, 4).map((artifact, index) => (
                                            <div key={`${artifact}-${index}`} className="rounded-2xl border border-border-subtle bg-bg-card px-3 py-2 text-xs text-text-secondary break-all">
                                                {artifact}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </section>
                        </aside>
                    </div>

                    <section className="mt-8">
                        <div className="mb-5 flex flex-wrap items-center gap-5 border-b border-border-subtle pb-3">
                            {[
                                { id: 'overview', label: 'Source Notes', icon: FileText },
                                { id: 'transcript', label: 'Transcript', icon: MessageSquareText },
                                { id: 'usage', label: 'Assistant Usage', icon: Bot },
                            ].map((tab) => {
                                const Icon = tab.icon;
                                const isActive = activeTab === tab.id;
                                return (
                                    <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id as 'overview' | 'transcript' | 'usage')} className={`relative inline-flex items-center gap-2 pb-3 text-sm transition-colors ${isActive ? 'font-semibold text-text-primary' : 'font-medium text-text-tertiary hover:text-text-secondary'}`}>
                                        <Icon size={16} />
                                        {tab.label}
                                        {isActive && <span className="absolute inset-x-0 bottom-0 h-[2.5px] rounded-t-full bg-accent-primary" />}
                                    </button>
                                );
                            })}
                        </div>

                        {activeTab === 'overview' && (
                            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(270px,0.75fr)]">
                                <section className="space-y-6">
                                    <article className="rounded-[28px] border border-border-subtle bg-bg-main p-6">
                                        <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                            <FileText size={14} />
                                            Source summary
                                        </div>
                                        {detailedSummary.overview ? (
                                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                {detailedSummary.overview}
                                            </ReactMarkdown>
                                        ) : (
                                            <p className="text-sm text-text-tertiary">No source summary was stored for this meeting.</p>
                                        )}
                                    </article>

                                    <div className="grid gap-6 lg:grid-cols-2">
                                        <article className="rounded-[28px] border border-border-subtle bg-bg-main p-6">
                                            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <Zap size={14} />
                                                {detailedSummary.keyPointsTitle || 'Key points'}
                                            </div>
                                            <ul className="space-y-3">
                                                {detailedSummary.keyPoints.length > 0 ? detailedSummary.keyPoints.map((item, index) => (
                                                    <li key={`${item}-${index}`} className="flex items-start gap-3">
                                                        <div className="mt-2 h-1.5 w-1.5 rounded-full bg-violet-500 shrink-0" />
                                                        <div className="flex-1">
                                                            <EditableTextBlock
                                                                initialValue={item}
                                                                onSave={(nextValue) => void handleKeyPointSave(index, nextValue)}
                                                                tagName="p"
                                                                className="text-sm leading-7 text-text-secondary"
                                                                placeholder="Add a key point..."
                                                            />
                                                        </div>
                                                    </li>
                                                )) : <p className="text-sm text-text-tertiary">No key points were saved.</p>}
                                            </ul>
                                        </article>

                                        <article className="rounded-[28px] border border-border-subtle bg-bg-main p-6">
                                            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <ListTodo size={14} />
                                                {detailedSummary.actionItemsTitle || 'Action items'}
                                            </div>
                                            <ul className="space-y-3">
                                                {detailedSummary.actionItems.length > 0 ? detailedSummary.actionItems.map((item, index) => (
                                                    <li key={`${item}-${index}`} className="flex items-start gap-3">
                                                        <div className="mt-2 h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                                                        <div className="flex-1">
                                                            <EditableTextBlock
                                                                initialValue={item}
                                                                onSave={(nextValue) => void handleActionItemSave(index, nextValue)}
                                                                tagName="p"
                                                                className="text-sm leading-7 text-text-secondary"
                                                                placeholder="Add an action item..."
                                                            />
                                                        </div>
                                                    </li>
                                                )) : <p className="text-sm text-text-tertiary">No action items were saved.</p>}
                                            </ul>
                                        </article>
                                    </div>
                                </section>

                                <aside className="space-y-4">
                                    <article className="rounded-[28px] border border-border-subtle bg-bg-main p-5">
                                        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Meeting metadata</div>
                                        <dl className="space-y-3 text-sm">
                                            <div className="flex items-start justify-between gap-4">
                                                <dt className="text-text-tertiary">Duration</dt>
                                                <dd className="text-right text-text-primary">{meeting.duration}</dd>
                                            </div>
                                            <div className="flex items-start justify-between gap-4">
                                                <dt className="text-text-tertiary">Meeting date</dt>
                                                <dd className="text-right text-text-primary">{formatShortDate(meeting.date)}</dd>
                                            </div>
                                            <div className="flex items-start justify-between gap-4">
                                                <dt className="text-text-tertiary">Source format</dt>
                                                <dd className="text-right text-text-primary uppercase">{meeting.importMetadata?.sourceFormat || meeting.source || 'manual'}</dd>
                                            </div>
                                        </dl>
                                    </article>
                                </aside>
                            </div>
                        )}

                        {activeTab === 'transcript' && (
                            <section className="space-y-5">
                                <div className="flex flex-col gap-4 rounded-[28px] border border-border-subtle bg-bg-main p-5 md:flex-row md:items-center md:justify-between">
                                    <div>
                                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">Evidence lane</div>
                                        <p className="text-sm text-text-secondary">Grouped by speaker turns so you can scan the conversation without reading a raw wall of text.</p>
                                    </div>

                                    <div className="relative w-full max-w-sm">
                                        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                                        <input
                                            type="text"
                                            value={transcriptFilter}
                                            onChange={(e) => setTranscriptFilter(e.target.value)}
                                            placeholder="Search transcript"
                                            className="w-full rounded-full border border-border-subtle bg-bg-card py-2.5 pl-10 pr-4 text-sm text-text-primary outline-none transition-colors focus:border-border-muted"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-4">
                                    {transcriptGroups.length > 0 ? transcriptGroups.map((group, index) => (
                                        <article key={`${group.label}-${index}`} className="rounded-[28px] border border-border-subtle bg-bg-main p-5 gs-stagger-row gs-row-hover" style={getStaggerStyle(index)}>
                                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                                <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${getSpeakerAccentClass(group.speaker)}`}>
                                                    {group.label}
                                                </div>
                                                <div className="text-xs text-text-tertiary">
                                                    {formatTimestamp(group.startTimestamp)}
                                                    {group.endTimestamp !== group.startTimestamp ? ` to ${formatTimestamp(group.endTimestamp)}` : ''}
                                                </div>
                                            </div>

                                            <div className="space-y-3">
                                                {group.entries.map((entry, entryIndex) => (
                                                    <div key={`${entry.timestamp}-${entryIndex}`} className={`rounded-2xl border px-4 py-3 text-sm leading-7 ${entryIndex % 2 === 0 ? 'border-border-subtle bg-bg-card' : 'border-transparent bg-bg-item-surface'}`}>
                                                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">{formatTimestamp(entry.timestamp)}</div>
                                                        <p className="text-text-primary">{entry.text}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </article>
                                    )) : (
                                        <div className="rounded-[28px] border border-dashed border-border-subtle bg-bg-main px-6 py-12 text-center">
                                            <MessageSquareText size={20} className="mx-auto mb-4 gs-float text-text-tertiary" />
                                            <p className="text-sm text-text-tertiary">{(meeting.transcript || []).length > 0 ? 'No transcript lines match that filter.' : 'No transcript was saved for this meeting.'}</p>
                                        </div>
                                    )}
                                </div>
                            </section>
                        )}

                        {activeTab === 'usage' && (
                            <section className="space-y-4">
                                {(meeting.usage || []).length > 0 ? (meeting.usage || []).map((interaction, index) => (
                                    <article key={`${interaction.timestamp}-${index}`} className="rounded-[28px] border border-border-subtle bg-bg-main p-5 gs-stagger-card" style={getStaggerStyle(index)}>
                                        <div className="mb-4 flex items-center justify-between gap-3">
                                            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                                <Bot size={14} />
                                                {getInteractionLabel(interaction)}
                                            </div>
                                            <div className="text-xs text-text-tertiary">{formatTimestamp(interaction.timestamp)}</div>
                                        </div>

                                        {interaction.question && (
                                            <div className="mb-4 rounded-2xl border border-blue-500/20 bg-blue-500/10 px-4 py-3">
                                                <p className="text-sm leading-7 text-text-primary">{interaction.question}</p>
                                                {interaction.screenCaptures?.length ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => void openScreenGallery(interaction)}
                                                        className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-accent-primary transition-colors hover:text-text-primary"
                                                    >
                                                        <Monitor size={13} />
                                                        View screens ({interaction.screenCaptures.length})
                                                    </button>
                                                ) : null}
                                            </div>
                                        )}

                                        {interaction.answer && (
                                            <div className="rounded-2xl border border-border-subtle bg-bg-card px-4 py-4">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                    {interaction.answer}
                                                </ReactMarkdown>
                                            </div>
                                        )}

                                        {interaction.items?.length ? (
                                            <ul className="mt-4 space-y-2">
                                                {interaction.items.map((item, itemIndex) => (
                                                    <li key={`${item}-${itemIndex}`} className="flex items-start gap-3 text-sm text-text-secondary">
                                                        <div className="mt-2 h-1.5 w-1.5 rounded-full bg-accent-primary shrink-0" />
                                                        <span>{item}</span>
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : null}
                                    </article>
                                )) : (
                                    <div className="rounded-[28px] border border-dashed border-border-subtle bg-bg-main px-6 py-12 text-center">
                                        <Bot size={20} className="mx-auto mb-4 gs-float text-text-tertiary" />
                                        <p className="text-sm text-text-tertiary">No assistant usage was saved for this meeting.</p>
                                    </div>
                                )}
                            </section>
                        )}
                    </section>
                </div>
            </main>

            <div className={`pointer-events-none absolute bottom-0 left-0 right-0 flex justify-center p-6 ${isChatOpen ? 'z-50' : 'z-20'}`}>
                <div className="pointer-events-auto relative w-full max-w-[460px]">
                    <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleInputKeyDown}
                        placeholder="Ask about this meeting..."
                        className="w-full rounded-full border border-white/20 bg-transparent py-3 pl-5 pr-12 text-sm text-text-primary shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-[24px] backdrop-saturate-[140%] placeholder:text-text-tertiary/70 focus:outline-none"
                    />
                    <button
                        type="button"
                        onClick={handleSubmitQuestion}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-full border border-white/5 p-1.5 transition-all duration-200 ${query.trim() ? 'bg-text-primary text-bg-primary hover:scale-105' : 'bg-bg-item-active text-text-primary'}`}
                    >
                        <ArrowUp size={16} className="rotate-45" />
                    </button>
                </div>
            </div>

            <MeetingChatOverlay
                isOpen={isChatOpen}
                onClose={() => {
                    setIsChatOpen(false);
                    setQuery('');
                    setSubmittedQuery('');
                }}
                meetingContext={{
                    id: meeting.id,
                    title: meeting.title,
                    summary: contextOverview.synopsis || detailedSummary.overview,
                    keyPoints: detailedSummary.keyPoints,
                    actionItems: detailedSummary.actionItems,
                    transcript: meeting.transcript,
                }}
                initialQuery={submittedQuery}
                onNewQuery={(nextQuery) => setSubmittedQuery(nextQuery)}
            />

            {screenGallery && (
                <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm" onClick={() => setScreenGallery(null)}>
                    <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-[32px] border border-border-subtle bg-bg-main shadow-[0_24px_80px_rgba(0,0,0,0.28)]" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-5">
                            <div>
                                <div className="mb-2 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                                    <Monitor size={14} />
                                    Screen State
                                </div>
                                <h3 className="text-lg font-semibold text-text-primary">{screenGallery.title}</h3>
                                <p className="mt-1 text-sm text-text-secondary">Captured across every visible display when this assistant turn was recorded.</p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setScreenGallery(null)}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle text-text-secondary transition-colors hover:border-border-muted hover:text-text-primary"
                            >
                                <X size={16} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6">
                            {screenGalleryError ? (
                                <div className="rounded-3xl border border-amber-500/20 bg-amber-500/10 px-5 py-4 text-sm text-amber-600">{screenGalleryError}</div>
                            ) : isLoadingScreenGallery ? (
                                <div className="grid gap-4 lg:grid-cols-2">
                                    {[0, 1].map((index) => (
                                        <div key={index} className="rounded-3xl border border-border-subtle bg-bg-card p-4 animate-pulse">
                                            <div className="mb-3 h-4 w-40 rounded-full bg-bg-item-surface" />
                                            <div className="aspect-[16/10] rounded-2xl bg-bg-item-surface" />
                                        </div>
                                    ))}
                                </div>
                            ) : screenGallery.captures.length > 0 ? (
                                <div className="grid gap-5 lg:grid-cols-2">
                                    {screenGallery.captures.map((capture, index) => (
                                        <article key={`${capture.path}-${index}`} className="overflow-hidden rounded-3xl border border-border-subtle bg-bg-card">
                                            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-4 py-4">
                                                <div>
                                                    <div className="text-sm font-semibold text-text-primary">
                                                        {capture.alias}
                                                        {capture.isPrimary ? ' (primary)' : ''}
                                                    </div>
                                                    <div className="mt-1 text-xs text-text-tertiary">
                                                        OS display {capture.displayLabel} • {capture.bounds.width} x {capture.bounds.height}
                                                    </div>
                                                </div>
                                                <div className="text-xs text-text-tertiary">{formatTimestamp(capture.capturedAt)}</div>
                                            </div>
                                            {capture.preview ? (
                                                <img
                                                    src={capture.preview}
                                                    alt={`${capture.alias} captured at ${formatTimestamp(capture.capturedAt)}`}
                                                    className="h-auto w-full bg-black object-contain"
                                                />
                                            ) : (
                                                <div className="flex aspect-[16/10] items-center justify-center bg-bg-item-surface px-6 text-center text-sm text-text-tertiary">
                                                    Preview unavailable for this capture.
                                                </div>
                                            )}
                                        </article>
                                    ))}
                                </div>
                            ) : (
                                <div className="rounded-3xl border border-dashed border-border-subtle bg-bg-card px-6 py-12 text-center text-sm text-text-tertiary">
                                    No screen captures were stored for this turn.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MeetingDetails;
