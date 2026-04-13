import React, { useState, useEffect, useCallback } from 'react';
import { Zap, Eye, Brain, CheckCircle, XCircle, Loader2, Monitor, Database } from 'lucide-react';

type ClaudeSessionState = 'ready' | 'expired' | 'missing' | 'invalid';

interface ToggleRowProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    enabled: boolean;
    loading?: boolean;
    disabled?: boolean;
    disabledReason?: string;
    onChange: (val: boolean) => void;
}

const ToggleRow: React.FC<ToggleRowProps> = ({
    icon, title, description, enabled, loading, disabled, disabledReason, onChange,
}) => (
    <div className={`flex items-start justify-between gap-4 p-4 rounded-xl border transition-all ${
        enabled ? 'bg-accent-primary/5 border-accent-primary/20' : 'bg-bg-item-surface border-border-subtle'
    } ${disabled ? 'opacity-50' : ''}`}>
        <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`mt-0.5 p-2 rounded-lg shrink-0 ${enabled ? 'bg-accent-primary/15 text-accent-primary' : 'bg-bg-elevated text-text-secondary'}`}>
                {icon}
            </div>
            <div className="min-w-0">
                <div className="text-sm font-medium text-text-primary">{title}</div>
                <div className="text-xs text-text-tertiary mt-0.5 leading-relaxed">
                    {disabled && disabledReason ? disabledReason : description}
                </div>
            </div>
        </div>
        <button
            disabled={!!disabled || !!loading}
            onClick={() => onChange(!enabled)}
            className={`relative shrink-0 mt-1 w-11 h-6 rounded-full transition-colors focus:outline-none ${
                enabled ? 'bg-accent-primary' : 'bg-bg-elevated border border-border-subtle'
            } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
            {loading ? (
                <Loader2 size={12} className="absolute inset-0 m-auto animate-spin text-white" />
            ) : (
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                }`} />
            )}
        </button>
    </div>
);

export const MeetingAISettings: React.FC = () => {
    const [ipCorpMode, setIPCorpMode] = useState(false);
    const [continuousOCR, setContinuousOCR] = useState(false);
    const [claudeMaxAvailable, setClaudeMaxAvailable] = useState(false);
    const [claudeSessionState, setClaudeSessionState] = useState<ClaudeSessionState>('missing');
    const [ipCorpWarning, setIPCorpWarning] = useState<string | null>(null);
    const [loading, setLoading] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);

    // Load current state on mount
    useEffect(() => {
        (async () => {
            try {
                const aiStatus = await window.electronAPI?.getMeetingAIStatus?.();
                if (aiStatus) {
                    setClaudeMaxAvailable(aiStatus.claudeMaxAvailable);
                    setClaudeSessionState(aiStatus.claudeMaxStatus ?? (aiStatus.claudeMaxAvailable ? 'ready' : 'missing'));
                    setContinuousOCR(aiStatus.ocrRunning);
                    setIPCorpMode(aiStatus.ipCorpMode);
                    setIPCorpWarning(aiStatus.ipCorpWarning ?? null);
                }
            } catch {}
        })();
    }, []);

    const claudeBannerClass = claudeSessionState === 'ready'
        ? 'bg-green-500/8 border-green-500/20 text-green-400'
        : 'bg-yellow-500/8 border-yellow-500/20 text-yellow-400';

    const claudeBannerContent = (() => {
        switch (claudeSessionState) {
            case 'ready':
                return <><CheckCircle size={14} /> Claude ready — local Claude session is active</>;
            case 'expired':
                return <><XCircle size={14} /> Claude session found, but the local OAuth token expired. Open Claude Code and refresh the session.</>;
            case 'invalid':
                return <><XCircle size={14} /> Claude credentials were found but could not be read cleanly. Refresh the local Claude Code login.</>;
            case 'missing':
            default:
                return <><XCircle size={14} /> Claude is not configured on this machine yet. Log in to Claude Code to enable the meeting model.</>;
        }
    })();

    const ipCorpDisabledReason = claudeSessionState === 'expired'
        ? 'Requires an active Claude session. The current local Claude token is expired.'
        : claudeSessionState === 'invalid'
            ? 'Requires a readable Claude session. Refresh the local Claude Code login first.'
            : 'Requires Claude. Log in to Claude Code first.';

    const handleIPCorpToggle = useCallback(async (val: boolean) => {
        setLoading('ipcorp');
        try {
            const result = await window.electronAPI?.setIPCorpMode?.(val);
            if (result?.success === false) throw new Error(result.error ?? 'Unknown error');
            setIPCorpMode(val);
            setIPCorpWarning(val ? (result?.warning ?? null) : null);
            setStatus(val
                ? (result?.warning ?? `IP Corp mode on — Natively local memory and session context are injected into every Claude call`)
                : 'IP Corp mode off');
        } catch (e: any) {
            setStatus(`Failed: ${e.message}`);
        } finally {
            setLoading(null);
            setTimeout(() => setStatus(null), 3500);
        }
    }, []);

    const handleOCRToggle = useCallback(async (val: boolean) => {
        setLoading('ocr');
        try {
            const result = await window.electronAPI?.setContinuousOCR?.(val);
            if (result?.success === false) throw new Error(result.error ?? 'Unknown error');
            setContinuousOCR(val);
            setStatus(val
                ? 'Screen watching started — all displays captured every 5s and fed into context'
                : 'Screen watching stopped');
        } catch (e: any) {
            setStatus(`Failed: ${e.message}`);
        } finally {
            setLoading(null);
            setTimeout(() => setStatus(null), 3500);
        }
    }, []);

    return (
        <div className="space-y-6 animated fadeIn">

            {/* Header */}
            <div>
                <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                    <Zap size={20} className="text-accent-primary" />
                    Meeting AI
                </h3>
                <p className="text-xs text-text-tertiary mt-1">
                    Turns Natively into a proactive meeting coach that watches your workflow, tracks context, and tells you what to say in real time.
                </p>
            </div>

            {/* Claude status banner */}
            <div className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-medium border ${claudeBannerClass}`}>
                {claudeBannerContent}
            </div>

            {/* Toggles */}
            <div className="space-y-3">

                <ToggleRow
                    icon={<Brain size={16} />}
                    title="IP Corp Mode"
                    description="Injects Natively's local meeting memory, imported history, background reference, and session context into the meeting coach so it already knows your projects, people, and decisions."
                    enabled={ipCorpMode}
                    loading={loading === 'ipcorp'}
                    disabled={!claudeMaxAvailable}
                    disabledReason={ipCorpDisabledReason}
                    onChange={handleIPCorpToggle}
                />

                <ToggleRow
                    icon={<Monitor size={16} />}
                    title="Always-On Screen Watch"
                    description="Captures all your monitors every 5 seconds, extracts visible text, and feeds it into context automatically. The meeting coach sees what is on your screens without manual screenshots."
                    enabled={continuousOCR}
                    loading={loading === 'ocr'}
                    onChange={handleOCRToggle}
                />

            </div>

            {ipCorpMode && ipCorpWarning && (
                <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-medium border bg-yellow-500/8 border-yellow-500/20 text-yellow-400">
                    <Database size={14} />
                    {ipCorpWarning}
                </div>
            )}

            {/* How it works */}
            <div className="bg-bg-item-surface border border-border-subtle rounded-xl p-4 space-y-3">
                <div className="text-xs font-semibold text-text-secondary uppercase tracking-wider">How it works</div>
                <div className="space-y-2.5 text-xs text-text-tertiary">
                    <div className="flex gap-3">
                        <div className="w-5 h-5 rounded-full bg-accent-primary/15 text-accent-primary flex items-center justify-center shrink-0 text-[10px] font-bold">1</div>
                        <span>Select <span className="text-text-primary font-medium">Claude</span> in the model selector once your local Claude session is active</span>
                    </div>
                    <div className="flex gap-3">
                        <div className="w-5 h-5 rounded-full bg-accent-primary/15 text-accent-primary flex items-center justify-center shrink-0 text-[10px] font-bold">2</div>
                        <span>Turn on <span className="text-text-primary font-medium">IP Corp Mode</span> — Natively's local context engine replaces the generic system prompt</span>
                    </div>
                    <div className="flex gap-3">
                        <div className="w-5 h-5 rounded-full bg-accent-primary/15 text-accent-primary flex items-center justify-center shrink-0 text-[10px] font-bold">3</div>
                        <span>Turn on <span className="text-text-primary font-medium">Screen Watch</span> — Natively reads every window on every monitor and feeds it into context automatically</span>
                    </div>
                    <div className="flex gap-3">
                        <div className="w-5 h-5 rounded-full bg-accent-primary/15 text-accent-primary flex items-center justify-center shrink-0 text-[10px] font-bold">4</div>
                        <span>Talk in your meeting — Natively hears it via the transcript, combines screen + memory context, and proactively tells you what to say</span>
                    </div>
                </div>
            </div>

            {/* Status toast */}
            {status && (
                <div className="text-xs text-accent-primary bg-accent-primary/10 border border-accent-primary/20 rounded-lg px-4 py-2.5 animated fadeIn">
                    {status}
                </div>
            )}
        </div>
    );
};
