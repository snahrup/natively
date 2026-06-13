import React, { useEffect, useMemo, useState } from 'react';
import { Activity, Bot, Calendar, ExternalLink, MessageSquare, Monitor, RefreshCw, Trash2, Upload } from 'lucide-react';

interface ChatDebugEntry {
  id: number;
  meetingId?: string | null;
  type: string;
  timestamp: number;
  userQuery: string;
  aiResponse: string;
  metadata?: {
    surface?: string;
    status?: 'completed' | 'error' | 'proposal' | 'superseded' | string;
    provider?: string | null;
    modelId?: string | null;
    reasoningEffort?: string | null;
    hadImages?: boolean;
    imagePaths?: string[];
    firstTokenLatencyMs?: number | null;
    totalLatencyMs?: number | null;
    error?: string | null;
    ragMode?: 'meeting' | 'live' | 'global' | null;
    proposalKind?: string | null;
    completedAt?: string | null;
    screenReadRequest?: boolean;
    ocrObservationCount?: number;
    latestOcrCapturedAt?: string | null;
    latestOcrAgeMs?: number | null;
    latestOcrExcerpt?: string | null;
    latestOcrDisplayCount?: number | null;
  };
}

type ContextHubLoadOptions = {
  refreshStatus?: boolean;
  refreshTeams?: boolean;
  refreshCluely?: boolean;
  source?: 'all' | 'teams' | 'cluely';
};

interface ContextHubSettingsProps {
  loadContextHubData: (options?: ContextHubLoadOptions) => Promise<void> | void;
  contextHubRefreshBusy: boolean;
  contextHubStatus: any;
  calendarStatus: any;
  microsoftLocalStatus: any;
  chatDebugEntries: ChatDebugEntry[];
  resumeUploading: boolean;
  resumeError: string;
  profileStatus: any;
  profileData: any;
  onRemoveReference: () => Promise<void> | void;
  onReplaceReference: () => Promise<void> | void;
  teamsImportBusy: boolean;
  teamsImportError: string;
  teamsImportResult: any;
  teamsImportCandidates: any[];
  onRunTeamsImport: () => Promise<void> | void;
  cluelyImportBusy: boolean;
  cluelyImportError: string;
  cluelyImportResult: any;
  cluelyImportCandidates: any[];
  cluelyImportStatus: any;
  cluelyDiscoveryBusy: boolean;
  teamsDiscoveryBusy: boolean;
  onRunCluelyImport: () => Promise<void> | void;
  onRefreshCluelyList: () => Promise<void> | void;
  onRefreshTeamsList: () => Promise<void> | void;
  meetingImportFiles: string[];
  onSelectMeetingImportFiles: () => Promise<void> | void;
  onRemoveMeetingImportFile: (filePath: string) => void;
  meetingImportSourceFormat: 'auto' | 'cluely' | 'teams' | 'generic';
  setMeetingImportSourceFormat: (value: 'auto' | 'cluely' | 'teams' | 'generic') => void;
  meetingImportTitle: string;
  setMeetingImportTitle: (value: string) => void;
  meetingImportDate: string;
  setMeetingImportDate: (value: string) => void;
  meetingImportSummaryText: string;
  setMeetingImportSummaryText: (value: string) => void;
  meetingImportTranscriptText: string;
  setMeetingImportTranscriptText: (value: string) => void;
  meetingImportUsageText: string;
  setMeetingImportUsageText: (value: string) => void;
  meetingImportError: string;
  meetingImportResult: any;
  meetingImportBusy: boolean;
  onPasteMeetingImportClipboard: (target: 'summary' | 'transcript' | 'usage', append: boolean) => Promise<void> | void;
  onClearMeetingImportDraft: () => void;
  onRunMeetingImport: () => Promise<void> | void;
}

const padDatePart = (value: number): string => value.toString().padStart(2, '0');
const MEETING_IMPORT_TIMEZONE = 'America/New_York';

const getTimeZoneParts = (date: Date, timeZone: string): Record<string, string> => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return formatter.formatToParts(date).reduce<Record<string, string>>((parts, part) => {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
    return parts;
  }, {});
};

const getTimeZoneOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return (asUtc - date.getTime()) / 60000;
};

const toDateTimeLocalValue = (value?: string): string => {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const parts = getTimeZoneParts(parsed, MEETING_IMPORT_TIMEZONE);
  return [`${parts.year}-${parts.month}-${parts.day}`, `${parts.hour}:${parts.minute}`].join('T');
};

const fromDateTimeLocalValue = (value: string): string => {
  if (!value) return '';
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return value;

  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  if ([year, month, day, hour, minute].some((part) => Number.isNaN(part))) {
    return value;
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcGuess), MEETING_IMPORT_TIMEZONE);
  let resolvedUtcMs = utcGuess - (offsetMinutes * 60_000);

  const resolvedOffsetMinutes = getTimeZoneOffsetMinutes(new Date(resolvedUtcMs), MEETING_IMPORT_TIMEZONE);
  if (resolvedOffsetMinutes !== offsetMinutes) {
    offsetMinutes = resolvedOffsetMinutes;
    resolvedUtcMs = utcGuess - (offsetMinutes * 60_000);
  }

  return new Date(resolvedUtcMs).toISOString();
};

export const ContextHubSettings: React.FC<ContextHubSettingsProps> = ({
  loadContextHubData,
  contextHubRefreshBusy,
  contextHubStatus,
  calendarStatus,
  microsoftLocalStatus,
  chatDebugEntries,
  resumeUploading,
  resumeError,
  profileStatus,
  profileData,
  onRemoveReference,
  onReplaceReference,
  teamsImportBusy,
  teamsImportError,
  teamsImportResult,
  teamsImportCandidates,
  onRunTeamsImport,
  cluelyImportBusy,
  cluelyImportError,
  cluelyImportResult,
  cluelyImportCandidates,
  cluelyImportStatus,
  cluelyDiscoveryBusy,
  teamsDiscoveryBusy,
  onRunCluelyImport,
  onRefreshCluelyList,
  onRefreshTeamsList,
  meetingImportFiles,
  onSelectMeetingImportFiles,
  onRemoveMeetingImportFile,
  meetingImportSourceFormat,
  setMeetingImportSourceFormat,
  meetingImportTitle,
  setMeetingImportTitle,
  meetingImportDate,
  setMeetingImportDate,
  meetingImportSummaryText,
  setMeetingImportSummaryText,
  meetingImportTranscriptText,
  setMeetingImportTranscriptText,
  meetingImportUsageText,
  setMeetingImportUsageText,
  meetingImportError,
  meetingImportResult,
  meetingImportBusy,
  onPasteMeetingImportClipboard,
  onClearMeetingImportDraft,
  onRunMeetingImport,
}) => {
  const [recentImportedMeetings, setRecentImportedMeetings] = useState<Array<{
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
  }>>([]);
  const [autonomousBusy, setAutonomousBusy] = useState<string | null>(null);
  const [autonomousFeedback, setAutonomousFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const chatDebugSummary = useMemo(() => {
    const turns = chatDebugEntries || [];
    return {
      total: turns.length,
      completed: turns.filter((entry) => (entry.metadata?.status || 'completed') === 'completed').length,
      errors: turns.filter((entry) => (entry.metadata?.status || 'completed') === 'error').length,
      withScreenshots: turns.filter((entry) => !!entry.metadata?.hadImages).length,
      screenReads: turns.filter((entry) => !!entry.metadata?.screenReadRequest).length,
      latest: turns[0] || null,
    };
  }, [chatDebugEntries]);

  useEffect(() => {
    let cancelled = false;

    const loadImportedMeetings = async () => {
      try {
        const meetings = await window.electronAPI?.getRecentMeetings?.();
        if (cancelled || !Array.isArray(meetings)) return;

        const imported = meetings.filter((meeting) => meeting.source === 'cluely' || meeting.source === 'teams' || meeting.source === 'imported');
        setRecentImportedMeetings(imported.slice(0, 12));
      } catch (error) {
        console.warn('[ContextHubSettings] Failed to load recent imported meetings:', error);
      }
    };

    loadImportedMeetings().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meetingImportResult, cluelyImportResult, teamsImportResult, contextHubStatus?.meetings?.total]);

  const autonomousOps = contextHubStatus?.autonomousOps || null;
  const autonomousWorkflows = Array.isArray(autonomousOps?.workflows) ? autonomousOps.workflows : [];

  const refreshAutonomousPanel = async () => {
    try {
      await window.electronAPI?.refreshAutonomousOpsStatus?.();
    } catch (error) {
      console.warn('[ContextHubSettings] Failed to refresh autonomous ops directly:', error);
    }

    await Promise.resolve(loadContextHubData({
      refreshStatus: true,
      refreshTeams: false,
      refreshCluely: false,
      source: 'all',
    }));
  };

  const runAutonomousMutation = async (busyKey: string, runner: () => Promise<{ success?: boolean; summary?: string; error?: string } | null>) => {
    setAutonomousBusy(busyKey);
    setAutonomousFeedback(null);

    try {
      const result = await runner();
      if (!result) {
        throw new Error('Autonomous operations bridge is unavailable.');
      }
      if (result.success === false) {
        throw new Error(result.error || result.summary || 'Autonomous operation failed.');
      }
      setAutonomousFeedback({
        tone: 'success',
        text: result.summary || 'Autonomous operations updated.',
      });
    } catch (error) {
      setAutonomousFeedback({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setAutonomousBusy(null);
      await refreshAutonomousPanel();
    }
  };

  const handleStartWorkflow = async (workflowId: string) => {
    await runAutonomousMutation(`start:${workflowId}`, async () => {
      const snapshot = await window.electronAPI?.startAutonomousWorkflow?.(workflowId);
      if (!snapshot) {
        throw new Error(`Unable to start monitoring for ${workflowId}.`);
      }
      return {
        success: true,
        summary: `Monitoring started for ${snapshot.label || workflowId}.`,
      };
    });
  };

  const handleStopWorkflow = async (workflowId: string, workflowLabel: string) => {
    if (!window.confirm(`Pause manual monitoring for ${workflowLabel}?`)) return;

    await runAutonomousMutation(`stop:${workflowId}`, async () => {
      const result = await window.electronAPI?.stopAutonomousWorkflow?.(workflowId);
      return {
        success: result?.success,
        error: result?.error,
        summary: result?.success ? `Monitoring paused for ${workflowLabel}.` : undefined,
      };
    });
  };

  const handleWorkflowAction = async (workflowId: string, workflowLabel: string, action: any) => {
    if (action?.confirmationRequired) {
      const confirmed = window.confirm(`Run "${action.label}" for ${workflowLabel}?`);
      if (!confirmed) return;
    }

    await runAutonomousMutation(`action:${workflowId}:${action.id}`, async () => {
      return await window.electronAPI?.invokeAutonomousWorkflowAction?.(workflowId, action.id);
    });
  };

  return (
    <div className="space-y-6 animated fadeIn">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-text-primary mb-1">Context Hub</h3>
          <p className="text-xs text-text-secondary max-w-[580px]">
            Review what Natively can currently see, what has been indexed into durable memory, and what imported meeting history is available to future prep and guidance flows.
          </p>
        </div>
        <button
          onClick={() => loadContextHubData()}
          disabled={contextHubRefreshBusy}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full border border-border-subtle bg-bg-subtle/30 hover:bg-bg-subtle transition-all duration-200 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          <RefreshCw size={13} className={contextHubRefreshBusy ? 'animate-spin' : ''} />
          {contextHubRefreshBusy ? 'Refreshing...' : 'Refresh Sources'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[
          {
            label: 'Meetings Indexed',
            active: (contextHubStatus?.meetings?.total || 0) > 0,
            detail: `${contextHubStatus?.meetings?.total || 0} total`,
            meta: `Native ${contextHubStatus?.meetings?.natively || 0} • Teams ${contextHubStatus?.meetings?.teamsImports || 0} • Cluely ${contextHubStatus?.meetings?.cluelyImports || 0} • Other ${contextHubStatus?.meetings?.genericImports || 0}`,
            icon: <Calendar size={16} />,
          },
          {
            label: 'IP Corp Brain',
            active: !!contextHubStatus?.brain?.available,
            detail: contextHubStatus?.brain?.available
              ? `${contextHubStatus?.brain?.prepPacketsReady || 0} prep packets • ${contextHubStatus?.brain?.cortexInsights || 0} Cortex insights`
              : 'Missing',
            meta: contextHubStatus?.brain?.available
              ? `${contextHubStatus?.brain?.openActionProposals || 0} open proposals • ${contextHubStatus?.brain?.rootPath || 'brain repo'}`
              : (contextHubStatus?.brain?.warning || 'Brain read models are not available yet'),
            icon: <Bot size={16} />,
          },
          {
            label: 'Live Context',
            active: ((contextHubStatus?.live?.ocrObservations || 0) + (contextHubStatus?.live?.liveTranscriptSegments || 0) + (contextHubStatus?.live?.chatTurns || 0)) > 0,
            detail: `${contextHubStatus?.live?.ocrObservations || 0} OCR • ${contextHubStatus?.live?.liveTranscriptSegments || 0} transcript • ${contextHubStatus?.live?.chatTurns || 0} chat turns`,
            meta: contextHubStatus?.live?.lastObservedAt
              ? `Last observed ${new Date(contextHubStatus.live.lastObservedAt).toLocaleString()}`
              : 'No recent observations yet',
            icon: <Activity size={16} />,
          },
          {
            label: 'Outlook Desktop',
            active: !!contextHubStatus?.localSources?.outlookConnected,
            detail: contextHubStatus?.localSources?.outlookConnected
              ? (calendarStatus?.email || 'Connected locally')
              : 'Not connected',
            meta: `${contextHubStatus?.localSources?.upcomingEvents || 0} upcoming events • ${contextHubStatus?.localSources?.recentEmails || 0} recent emails`,
            icon: <Monitor size={16} />,
          },
          {
            label: 'Teams Desktop',
            active: !!contextHubStatus?.localSources?.teamsConnected,
            detail: contextHubStatus?.localSources?.teamsConnected
              ? (microsoftLocalStatus?.teams?.userName || 'Connected locally')
              : 'Not connected',
            meta: `${contextHubStatus?.localSources?.teamsChats || 0} visible chats • ${contextHubStatus?.meetings?.teamsImports || 0} imported meetings`,
            icon: <MessageSquare size={16} />,
          },
          {
            label: 'Autonomous Ops',
            active: !!autonomousOps?.resident,
            detail: autonomousOps?.resident
              ? `${autonomousOps?.summary?.active || 0} active • ${autonomousOps?.summary?.blocked || 0} blocked`
              : 'Runtime idle',
            meta: `${autonomousWorkflows.length} workflows • ${autonomousOps?.summary?.approvalRequired || 0} approval-required • ${autonomousOps?.summary?.completed || 0} completed`,
            icon: <RefreshCw size={16} />,
          },
        ].map((item) => (
          <div
            key={item.label}
            className={`rounded-xl border px-4 py-4 ${item.active ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-bg-item-surface border-border-subtle'}`}
          >
            <div className="flex items-start gap-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${item.active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-bg-input text-text-tertiary'}`}>
                {item.icon}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-wide">{item.label}</div>
                <div className={`mt-1 text-sm font-semibold ${item.active ? 'text-emerald-400' : 'text-text-primary'}`}>{item.detail}</div>
                <div className="mt-1 text-[11px] text-text-secondary leading-relaxed">{item.meta}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {Array.isArray(contextHubStatus?.services) && contextHubStatus.services.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-bg-item-surface px-4 py-3 text-xs text-text-secondary leading-relaxed">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">Service Health</div>
          {contextHubStatus.services.filter((s: any) => s.status !== 'ok').length === 0 ? (
            <div className="text-emerald-400">All {contextHubStatus.services.length} background services healthy.</div>
          ) : (
            contextHubStatus.services
              .filter((s: any) => s.status !== 'ok')
              .map((s: any) => (
                <div key={s.name} className="mt-1 text-red-400">
                  <span className="font-semibold">{s.name}</span>
                  {' '}{s.status}{s.detail ? ` — ${s.detail}` : ''}
                </div>
              ))
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-border-subtle bg-bg-item-surface px-4 py-3 text-xs text-text-secondary leading-relaxed">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">Freshness</div>
          <div>
            Last meeting indexed: {contextHubStatus?.meetings?.lastMeetingAt ? new Date(contextHubStatus.meetings.lastMeetingAt).toLocaleString() : 'No meeting history indexed yet'}
          </div>
          <div className="mt-1">
            Last live observation: {contextHubStatus?.live?.lastObservedAt ? new Date(contextHubStatus.live.lastObservedAt).toLocaleString() : 'No live observations captured yet'}
          </div>
          <div className="mt-1">
            Brain run: {contextHubStatus?.brain?.latestRunAt ? new Date(contextHubStatus.brain.latestRunAt).toLocaleString() : 'No brain run visible yet'}
          </div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-bg-item-surface px-4 py-3 text-xs text-text-secondary leading-relaxed">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">Reference Materials</div>
          <div>
            {contextHubStatus?.profile?.loaded
              ? (contextHubStatus.profile.summary || 'Background context loaded')
              : 'No persistent background context loaded yet'}
          </div>
          <div className="mt-1">
            {`${contextHubStatus?.profile?.experienceCount || 0} experience • ${contextHubStatus?.profile?.projectCount || 0} projects • ${contextHubStatus?.profile?.nodeCount || 0} nodes`}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-text-primary">Autonomous Ops</h4>
            <p className="text-xs text-text-secondary mt-1 max-w-[640px]">
              Resident workflow supervision for opted-in repo-local systems. IP Corp mode keeps legacy monitors disabled by default, preserves artifacts when enabled, and only escalates controls that need explicit confirmation.
            </p>
          </div>
          <button
            onClick={() => refreshAutonomousPanel()}
            disabled={!!autonomousBusy}
            className="shrink-0 px-4 py-2 rounded-full border border-border-subtle bg-bg-input text-xs font-semibold text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
          >
            {autonomousBusy ? 'Working...' : 'Refresh Workflows'}
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-text-secondary">
          <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Resident</div>
            <div className="text-text-primary font-semibold">{autonomousOps?.resident ? 'Online' : 'Offline'}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Active</div>
            <div className="text-text-primary font-semibold">{autonomousOps?.summary?.active || 0}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Blocked</div>
            <div className="text-text-primary font-semibold">{autonomousOps?.summary?.blocked || 0}</div>
          </div>
          <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
            <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Approvals</div>
            <div className="text-text-primary font-semibold">{autonomousOps?.summary?.approvalRequired || 0}</div>
          </div>
        </div>

        {autonomousFeedback && (
          <div className={`rounded-lg border px-3 py-2 text-[11px] ${
            autonomousFeedback.tone === 'error'
              ? 'border-red-500/20 bg-red-500/10 text-red-300'
              : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
          }`}>
            {autonomousFeedback.text}
          </div>
        )}

        {autonomousWorkflows.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-bg-input/50 px-4 py-4 text-xs text-text-secondary">
            No repo-local autonomous workflows are currently registered. Legacy app monitors stay off unless explicitly enabled.
          </div>
        ) : (
          <div className="space-y-3">
            {autonomousWorkflows.map((workflow: any) => {
              const state = workflow?.state || 'idle';
              const nextActionIds = Array.isArray(workflow?.nextActionIds) ? workflow.nextActionIds : [];
              const availableActions = Array.isArray(workflow?.availableActions) ? workflow.availableActions : [];
              const prioritizedActions = [...availableActions].sort((left: any, right: any) => {
                const leftPriority = nextActionIds.includes(left.id) ? 0 : 1;
                const rightPriority = nextActionIds.includes(right.id) ? 0 : 1;
                if (leftPriority !== rightPriority) return leftPriority - rightPriority;
                return String(left.label || '').localeCompare(String(right.label || ''));
              });
              const integritySummary = workflow?.structuredState?.integritySummary || {};
              const runId = workflow?.structuredState?.currentRunId || workflow?.structuredState?.runId || 'none';
              const engineStatus = workflow?.structuredState?.engineStatus || 'unknown';
              const statusSource = workflow?.structuredState?.statusSource || 'unknown';
              const stale = !!workflow?.structuredState?.stale;
              const busyStartKey = `start:${workflow.workflowId}`;
              const busyStopKey = `stop:${workflow.workflowId}`;
              const canStopManualMonitor = !!workflow?.manual && !workflow?.autoDetected && workflow?.state !== 'working-in-background';

              return (
                <div key={workflow.workflowId} className="rounded-xl border border-border-subtle bg-bg-input/40 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="text-sm font-semibold text-text-primary">{workflow.label}</div>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                          state === 'completed'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : state === 'blocked'
                              ? 'bg-red-500/10 text-red-400 border-red-500/20'
                              : state === 'working-in-background'
                                ? 'bg-sky-500/10 text-sky-400 border-sky-500/20'
                                : state === 'needs-approval' || state === 'ready-to-take-over'
                                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                  : 'bg-bg-item-surface text-text-secondary border-border-subtle'
                        }`}>
                          {state}
                        </span>
                        {workflow?.autoDetected && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-sky-500/20 bg-sky-500/10 text-sky-300">
                            auto-detected
                          </span>
                        )}
                        {workflow?.manual && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold border border-border-subtle bg-bg-item-surface text-text-secondary">
                            manual monitor
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-text-secondary leading-relaxed">{workflow.summary}</div>
                    </div>
                    <div className="text-right text-[10px] text-text-tertiary shrink-0">
                      <div>{workflow?.active ? 'Active' : 'Passive'}</div>
                      <div className="mt-1">{workflow?.updatedAt ? new Date(workflow.updatedAt).toLocaleString() : 'No timestamp'}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-text-secondary">
                    <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-3 space-y-1">
                      <div><span className="text-text-tertiary">Run:</span> <span className="text-text-primary font-medium">{runId}</span></div>
                      <div><span className="text-text-tertiary">Engine:</span> <span className="text-text-primary font-medium">{engineStatus}</span></div>
                      <div><span className="text-text-tertiary">Source:</span> <span className="text-text-primary font-medium">{statusSource}{stale ? ' • stale' : ''}</span></div>
                      <div><span className="text-text-tertiary">Autonomy:</span> <span className="text-text-primary font-medium">{workflow?.autonomyLevel || 'observe'}</span></div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-3 space-y-1">
                      <div><span className="text-text-tertiary">Latest full chain:</span> <span className="text-text-primary font-medium">{integritySummary?.latestFullChain ?? 0}</span></div>
                      <div><span className="text-text-tertiary">In scope:</span> <span className="text-text-primary font-medium">{integritySummary?.inScope ?? 0}</span></div>
                      <div><span className="text-text-tertiary">Historical only:</span> <span className="text-text-primary font-medium">{integritySummary?.historicalOnly ?? 0}</span></div>
                      <div><span className="text-text-tertiary">Policy:</span> <span className="text-text-primary font-medium">{workflow?.policySummary || 'Policy not evaluated yet.'}</span></div>
                    </div>
                  </div>

                  {workflow?.lastActionResult?.summary && (
                    <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                      workflow?.lastActionResult?.success
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                        : 'border-red-500/20 bg-red-500/10 text-red-300'
                    }`}>
                      {workflow.lastActionResult.summary}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {!workflow?.active && (
                      <button
                        onClick={() => handleStartWorkflow(workflow.workflowId)}
                        disabled={autonomousBusy === busyStartKey}
                        className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-accent-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        {autonomousBusy === busyStartKey ? 'Starting…' : 'Start Monitor'}
                      </button>
                    )}
                    {canStopManualMonitor && (
                      <button
                        onClick={() => handleStopWorkflow(workflow.workflowId, workflow.label)}
                        disabled={autonomousBusy === busyStopKey}
                        className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
                      >
                        {autonomousBusy === busyStopKey ? 'Stopping…' : 'Stop Monitor'}
                      </button>
                    )}
                    {prioritizedActions.map((action: any) => {
                      const busyKey = `action:${workflow.workflowId}:${action.id}`;
                      const highlighted = nextActionIds.includes(action.id);
                      return (
                        <button
                          key={action.id}
                          onClick={() => handleWorkflowAction(workflow.workflowId, workflow.label, action)}
                          disabled={autonomousBusy === busyKey}
                          className={`px-3 py-1.5 rounded-full text-[11px] font-medium border transition-colors disabled:opacity-50 ${
                            highlighted
                              ? 'bg-sky-500/10 border-sky-500/20 text-sky-300 hover:bg-sky-500/15'
                              : 'bg-bg-item-surface border-border-subtle text-text-primary hover:bg-bg-item-hover'
                          }`}
                          title={action.description}
                        >
                          {autonomousBusy === busyKey ? 'Working…' : action.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-text-primary">Recent Chat Debug</h4>
            <p className="text-xs text-text-secondary mt-1 max-w-[620px]">
              View the durable operator log in a dedicated debugger window with full prompt/response records, screenshot previews, OCR snapshots, and model trace metadata.
            </p>
          </div>
          <button
            onClick={() => window.electronAPI?.openChatLogViewer?.()}
            className="shrink-0 px-4 py-2 rounded-full border border-border-subtle bg-bg-input text-xs font-semibold text-text-primary hover:bg-bg-subtle-hover transition-colors inline-flex items-center gap-1.5"
          >
            Open Viewer
            <ExternalLink size={12} />
          </button>
        </div>

        {chatDebugSummary.total === 0 ? (
          <div className="rounded-xl border border-border-subtle bg-bg-input/50 px-4 py-4 text-xs text-text-secondary">
            No durable widget or overlay chat has been captured yet in this profile.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px] text-text-secondary">
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Turns</div>
              <div className="text-text-primary font-semibold">{chatDebugSummary.total}</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Completed</div>
              <div className="text-text-primary font-semibold">{chatDebugSummary.completed}</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Errors</div>
              <div className="text-text-primary font-semibold">{chatDebugSummary.errors}</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">With Screenshots</div>
              <div className="text-text-primary font-semibold">{chatDebugSummary.withScreenshots}</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1">Screen Reads</div>
              <div className="text-text-primary font-semibold">{chatDebugSummary.screenReads}</div>
            </div>
          </div>
        )}

        {chatDebugSummary.latest && (
          <div className="rounded-lg border border-border-subtle bg-bg-input/50 px-3 py-3 text-xs text-text-secondary">
            Latest turn: <span className="text-text-primary font-medium">{new Date(chatDebugSummary.latest.timestamp).toLocaleString()}</span>
            <span className="mx-2">•</span>
            {chatDebugSummary.latest.metadata?.provider || 'unknown provider'}
            <span className="mx-2">•</span>
            {chatDebugSummary.latest.metadata?.modelId || 'unknown model'}
          </div>
        )}
      </div>

      {Array.isArray(calendarStatus?.warnings) && calendarStatus.warnings.length > 0 && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-xs text-yellow-300 leading-relaxed">
          {calendarStatus.warnings.join(' ')}
        </div>
      )}

      <div className={`rounded-xl transition-all border ${resumeUploading ? 'border-green-500/50 ring-1 ring-green-500/20 bg-bg-item-surface' : profileStatus?.hasProfile ? 'border-green-500/30 bg-green-500/5' : 'border-border-subtle bg-bg-item-surface'}`}>
        <div className="p-5 flex items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${resumeUploading ? 'bg-green-500/15 text-green-400 animate-pulse' : profileStatus?.hasProfile ? 'bg-green-500/10 text-green-400' : 'bg-bg-input text-text-tertiary'}`}>
              {resumeUploading ? <RefreshCw size={18} className="animate-spin" /> : <Upload size={18} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-text-primary">Background Reference</h4>
                {profileStatus?.hasProfile && !resumeUploading && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-500/10 text-green-400 border border-green-500/20">Loaded</span>
                )}
              </div>
              <p className="text-xs text-text-secondary mt-1 max-w-[460px]">
                {profileStatus?.hasProfile
                  ? (profileStatus?.role || profileStatus?.name || 'Structured context is loaded and available to prep and meeting guidance.')
                  : 'Upload a background document, project brief, account notes, or operating context that Natively should remember long-term.'}
              </p>
              {profileData?.skills && profileData.skills.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {profileData.skills.slice(0, 8).map((skill: string, i: number) => (
                    <span key={i} className="px-2.5 py-1 rounded-full text-[10px] font-medium bg-bg-input border border-border-subtle text-text-secondary">
                      {skill}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {profileStatus?.hasProfile && (
              <button
                onClick={() => onRemoveReference()}
                className="px-4 py-2 rounded-full text-xs font-medium text-text-tertiary hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Remove
              </button>
            )}
            <button
              onClick={() => onReplaceReference()}
              disabled={resumeUploading}
              className="px-5 py-2.5 rounded-full text-xs font-semibold bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-all disabled:opacity-50 disabled:cursor-wait"
            >
              {resumeUploading ? 'Parsing...' : profileStatus?.hasProfile ? 'Replace Reference' : 'Choose Document'}
            </button>
          </div>
        </div>
        {resumeError && (
          <div className="px-5 pb-4">
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{resumeError}</div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-text-primary">Cluely Meeting History</h4>
            <p className="text-xs text-text-secondary mt-1 max-w-[520px]">
              Discover prior Cluely sessions through the local authenticated session first. If the Cluely token is stale, Natively falls back to cached discovery and tells you exactly what is missing.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRefreshCluelyList()}
              disabled={cluelyDiscoveryBusy}
              className={`px-4 py-2 rounded-full text-xs font-medium border transition-colors whitespace-nowrap ${
                cluelyDiscoveryBusy
                  ? 'bg-bg-input text-text-tertiary cursor-wait border-border-subtle'
                  : 'bg-bg-input border-border-subtle text-text-primary hover:bg-bg-item-hover'
              }`}
            >
              {cluelyDiscoveryBusy ? 'Refreshing...' : 'Refresh List'}
            </button>
            <button
              onClick={() => onRunCluelyImport()}
              disabled={cluelyImportBusy || cluelyImportStatus?.mode !== 'live'}
              className={`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap ${
                cluelyImportBusy
                  ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle'
                  : cluelyImportStatus?.mode === 'live'
                    ? 'bg-accent-primary text-white hover:opacity-90 shadow-sm'
                    : 'bg-bg-input text-text-tertiary border border-border-subtle cursor-not-allowed'
              }`}
            >
              {cluelyImportBusy ? 'Importing...' : 'Import Recent Cluely Meetings'}
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3 text-xs text-text-secondary leading-relaxed">
          <div>
            Mode: <span className="text-text-primary font-medium">{cluelyImportStatus?.mode || 'unavailable'}</span>
            {cluelyImportStatus?.sessionEmail ? ` • ${cluelyImportStatus.sessionEmail}` : ''}
            {typeof cluelyImportStatus?.tokenFresh === 'boolean' ? ` • token ${cluelyImportStatus.tokenFresh ? 'fresh' : 'stale'}` : ''}
          </div>
          <div className="mt-1">
            {cluelyImportStatus?.warning || 'No Cluely warning reported.'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(cluelyImportCandidates.length > 0 ? cluelyImportCandidates : [{ meetingTitle: 'No Cluely sessions discovered yet', sessionId: 'none', hasTranscript: false, hasSummary: false, hasUsage: false, source: 'cached' }]).slice(0, 6).map((candidate: any) => (
            <div key={candidate.sessionId} className="rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary truncate">{candidate.meetingTitle}</div>
                  <div className="mt-1 text-[11px] text-text-secondary">
                    {candidate.date ? new Date(candidate.date).toLocaleString() : 'Meeting date unavailable'}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${candidate.source === 'live' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-300 border-amber-500/20'}`}>
                    {candidate.source === 'live' ? 'Live' : 'Cached'}
                  </span>
                  {(candidate.hasTranscript || candidate.hasSummary || candidate.hasUsage) && (
                    <span className="text-[10px] text-text-secondary">
                      {[candidate.hasTranscript ? 'Transcript' : null, candidate.hasSummary ? 'Summary' : null, candidate.hasUsage ? 'Usage' : null].filter(Boolean).join(' • ')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {cluelyImportError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            {cluelyImportError}
          </div>
        )}

        {cluelyImportResult && (
          <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3">
            <div className="text-xs font-semibold text-text-primary">
              Imported {cluelyImportResult.importedMeetings?.length || 0} Cluely meeting{(cluelyImportResult.importedMeetings?.length || 0) === 1 ? '' : 's'}
            </div>
            {(cluelyImportResult.importedMeetings || []).slice(0, 6).map((meeting: any) => (
              <div key={meeting.meetingId} className="text-[11px] text-text-secondary">
                <span className="text-text-primary font-medium">{meeting.title}</span>
                {` • ${meeting.transcriptSegments} transcript segments`}
              </div>
            ))}
            {cluelyImportResult.warning && (
              <div className="text-[11px] text-yellow-300">{cluelyImportResult.warning}</div>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-text-primary">Teams Meeting History</h4>
            <p className="text-xs text-text-secondary mt-1 max-w-[520px]">
              Discover recent Teams meeting chats that expose transcript content, then normalize them into durable meeting memory with provenance.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRefreshTeamsList()}
              disabled={teamsDiscoveryBusy}
              className={`px-4 py-2 rounded-full text-xs font-medium border transition-colors whitespace-nowrap ${
                teamsDiscoveryBusy
                  ? 'bg-bg-input text-text-tertiary cursor-wait border-border-subtle'
                  : 'bg-bg-input border-border-subtle text-text-primary hover:bg-bg-item-hover'
              }`}
            >
              {teamsDiscoveryBusy ? 'Refreshing...' : 'Refresh List'}
            </button>
            <button
              onClick={() => onRunTeamsImport()}
              disabled={teamsImportBusy}
              className={`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap ${teamsImportBusy ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-accent-primary text-white hover:opacity-90 shadow-sm'}`}
            >
              {teamsImportBusy ? 'Importing...' : 'Import Recent Teams Meetings'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(teamsImportCandidates.length > 0 ? teamsImportCandidates : [{ meetingTitle: 'No transcript-bearing Teams chats discovered yet', chatId: 'none', hasTranscript: false }]).slice(0, 6).map((candidate: any) => (
            <div key={candidate.chatId} className="rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary truncate">{candidate.meetingTitle}</div>
                  <div className="mt-1 text-[11px] text-text-secondary">
                    {candidate.date ? new Date(candidate.date).toLocaleString() : 'Meeting date unavailable'}
                  </div>
                </div>
                {candidate.hasTranscript && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Transcript</span>
                )}
              </div>
            </div>
          ))}
        </div>

        {teamsImportError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            {teamsImportError}
          </div>
        )}

        {teamsImportResult && (
          <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3">
            <div className="text-xs font-semibold text-text-primary">
              Imported {teamsImportResult.importedMeetings?.length || 0} Teams meeting{(teamsImportResult.importedMeetings?.length || 0) === 1 ? '' : 's'}
            </div>
            {(teamsImportResult.importedMeetings || []).slice(0, 6).map((meeting: any) => (
              <div key={meeting.meetingId} className="text-[11px] text-text-secondary">
                <span className="text-text-primary font-medium">{meeting.title}</span>
                {` • ${meeting.transcriptSegments} transcript segments`}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-bold text-text-primary">Manual Meeting Import</h4>
            <p className="text-xs text-text-secondary mt-1">
              Use this when Cluely refuses to export. Copy transcript or recap text while scrolling, append it here from the clipboard, then import it into durable meeting memory.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPasteMeetingImportClipboard('transcript', false)}
              className="px-4 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors whitespace-nowrap"
            >
              Paste Transcript
            </button>
            <button
              onClick={() => onSelectMeetingImportFiles()}
              className="px-4 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors whitespace-nowrap"
            >
              Select Files
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-[11px] text-blue-200 leading-relaxed">
          Best workflow for Cluely: open the old meeting, copy the recap or transcript chunks as you scroll, click <span className="font-semibold text-blue-100">Append Clipboard</span> after each copy, then import the combined draft once the meeting is complete.
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3 text-xs text-text-secondary">
          {meetingImportFiles.length > 0
            ? `${meetingImportFiles.length} file${meetingImportFiles.length === 1 ? '' : 's'} selected`
            : 'No files selected yet.'}
        </div>

        {meetingImportFiles.length > 0 && (
          <div className="max-h-32 overflow-auto space-y-2 pr-1">
            {meetingImportFiles.map((filePath) => (
              <div key={filePath} className="flex items-center justify-between gap-3 rounded-lg bg-bg-input px-3 py-2 text-[11px] text-text-secondary">
                <span className="truncate">{filePath}</span>
                <button
                  onClick={() => onRemoveMeetingImportFile(filePath)}
                  className="text-text-tertiary hover:text-red-400 transition-colors shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1.5">Source</label>
              <select
                value={meetingImportSourceFormat}
                onChange={(e) => setMeetingImportSourceFormat(e.target.value as 'auto' | 'cluely' | 'teams' | 'generic')}
                className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
              >
                <option value="cluely">Cluely</option>
                <option value="teams">Teams</option>
                <option value="generic">Generic</option>
                <option value="auto">Auto detect</option>
              </select>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-input/60 px-3 py-2 text-[11px] text-text-secondary flex items-center">
              A complete meeting record can include a summary, transcript, and usage log. You can import any subset.
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              value={meetingImportTitle}
              onChange={(e) => setMeetingImportTitle(e.target.value)}
              placeholder="Meeting title override"
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
            />
            <div className="space-y-1.5">
              <input
                type="datetime-local"
                step={60}
                value={toDateTimeLocalValue(meetingImportDate)}
                onChange={(e) => setMeetingImportDate(fromDateTimeLocalValue(e.target.value))}
                className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all"
              />
              <div className="text-[10px] text-text-tertiary">
                Meeting date and time in Eastern Time.
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-border-subtle bg-bg-input/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-text-primary">Summary / recap</div>
                  <div className="text-[11px] text-text-secondary">Paste Cluely’s summary, recap, or top-level notes.</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onPasteMeetingImportClipboard('summary', false)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Paste</button>
                  <button onClick={() => onPasteMeetingImportClipboard('summary', true)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Append</button>
                </div>
              </div>
              <textarea
                value={meetingImportSummaryText}
                onChange={(e) => setMeetingImportSummaryText(e.target.value)}
                placeholder="Paste the meeting summary here"
                rows={4}
                className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all resize-y"
              />
            </div>
            <div className="rounded-xl border border-border-subtle bg-bg-input/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-text-primary">Transcript</div>
                  <div className="text-[11px] text-text-secondary">Paste the speaker-attributed transcript text. This is the highest-value part.</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onPasteMeetingImportClipboard('transcript', false)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Paste</button>
                  <button onClick={() => onPasteMeetingImportClipboard('transcript', true)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Append</button>
                </div>
              </div>
              <textarea
                value={meetingImportTranscriptText}
                onChange={(e) => setMeetingImportTranscriptText(e.target.value)}
                placeholder="Paste the transcript here"
                rows={8}
                className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all resize-y"
              />
            </div>
            <div className="rounded-xl border border-border-subtle bg-bg-input/40 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-text-primary">Usage log</div>
                  <div className="text-[11px] text-text-secondary">Paste the in-meeting AI chat history if you want Natively to preserve those interactions too.</div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => onPasteMeetingImportClipboard('usage', false)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Paste</button>
                  <button onClick={() => onPasteMeetingImportClipboard('usage', true)} className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-item-surface border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors">Append</button>
                </div>
              </div>
              <textarea
                value={meetingImportUsageText}
                onChange={(e) => setMeetingImportUsageText(e.target.value)}
                placeholder="Paste the AI chat log here"
                rows={5}
                className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 focus:ring-1 focus:ring-accent-primary/20 transition-all resize-y"
              />
            </div>
          </div>
        </div>

        {meetingImportError && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
            {meetingImportError}
          </div>
        )}

      {meetingImportResult && (
          <div className="space-y-2 rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3">
            <div className="text-xs font-semibold text-text-primary">
              Imported {meetingImportResult.importedMeetings?.length || 0} meeting{(meetingImportResult.importedMeetings?.length || 0) === 1 ? '' : 's'}
            </div>
            {(meetingImportResult.importedMeetings || []).slice(0, 6).map((meeting: any) => (
              <div key={meeting.meetingId} className="text-[11px] text-text-secondary">
                <span className="text-text-primary font-medium">{meeting.title}</span>
                {` • ${meeting.transcriptSegments} transcript segments • ${meeting.attendees?.length || 0} attendees`}
              </div>
            ))}
            {(meetingImportResult.skippedArtifacts || []).length > 0 && (
              <div className="text-[11px] text-yellow-300">
                Skipped: {meetingImportResult.skippedArtifacts.map((item: any) => `${item.name} (${item.reason})`).join('; ')}
              </div>
            )}
          </div>
        )}

        <div className="rounded-xl border border-border-subtle bg-bg-input/60 px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-text-primary">Imported Meeting History In Natively</div>
              <div className="text-[11px] text-text-secondary mt-1">
                This is the durable imported meeting history currently visible to the active app session.
              </div>
            </div>
            <div className="text-[11px] text-text-tertiary">
              {recentImportedMeetings.length} visible
            </div>
          </div>

          {recentImportedMeetings.length === 0 ? (
            <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-3 text-[11px] text-text-secondary">
              No imported Cluely, Teams, or generic meeting records are visible in the active Natively database yet.
            </div>
          ) : (
            <div className="space-y-2">
              {recentImportedMeetings.map((meeting) => (
                <div key={meeting.id} className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">{meeting.title}</div>
                      <div className="mt-1 text-[11px] text-text-secondary">
                        {new Date(meeting.date).toLocaleString()} • {meeting.duration}
                      </div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                      meeting.source === 'cluely'
                        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                        : meeting.source === 'teams'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : 'bg-violet-500/10 text-violet-400 border-violet-500/20'
                    }`}>
                      {meeting.source === 'cluely' ? 'Cluely' : meeting.source === 'teams' ? 'Teams' : 'Imported'}
                    </span>
                  </div>
                  {meeting.summary && (
                    <div className="mt-2 text-[11px] text-text-secondary leading-relaxed line-clamp-3">
                      {meeting.summary}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] text-text-tertiary">
            Imported files and pasted text are normalized into durable meeting records, then reloaded into meeting memory automatically.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onClearMeetingImportDraft()}
              disabled={meetingImportBusy}
              className="px-4 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-item-hover transition-colors whitespace-nowrap disabled:opacity-50"
            >
              Clear Draft
            </button>
            <button
              onClick={() => onRunMeetingImport()}
              disabled={meetingImportBusy}
              className={`px-4 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap ${meetingImportBusy ? 'bg-bg-input text-text-tertiary cursor-wait border border-border-subtle' : 'bg-accent-primary text-white hover:opacity-90 shadow-sm'}`}
            >
              {meetingImportBusy ? 'Importing...' : 'Import Into Natively'}
            </button>
          </div>
        </div>
      </div>

    </div>
  );
};
