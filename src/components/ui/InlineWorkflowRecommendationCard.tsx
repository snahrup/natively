import React, { useState } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';

export interface InlineWorkflowRecommendation {
  workflowId: string;
  workflowLabel: string;
  signature: string;
  state: string;
  note: string;
  suggestedActionId?: string | null;
  suggestedActionLabel?: string | null;
}

interface InlineWorkflowRecommendationCardProps {
  recommendation: InlineWorkflowRecommendation;
  onApproved?: (summary: string) => void;
  onDismissed?: () => void;
}

export const InlineWorkflowRecommendationCard: React.FC<InlineWorkflowRecommendationCardProps> = ({
  recommendation,
  onApproved,
  onDismissed,
}) => {
  const [busy, setBusy] = useState<'approve' | 'dismiss' | null>(null);
  const [status, setStatus] = useState('');

  const handleApprove = async () => {
    setBusy('approve');
    setStatus('');

    try {
      await window.electronAPI.startAutonomousWorkflow(recommendation.workflowId);

      let summary = `I took over ${recommendation.workflowLabel}.`;
      if (recommendation.suggestedActionId) {
        const result = await window.electronAPI.invokeAutonomousWorkflowAction(
          recommendation.workflowId,
          recommendation.suggestedActionId
        );
        if (!result?.success) {
          throw new Error(result?.summary || `Failed to run ${recommendation.suggestedActionLabel || 'the suggested action'}.`);
        }
        summary = result.summary || summary;
      } else {
        await window.electronAPI.refreshAutonomousOpsStatus?.();
      }

      await window.electronAPI.refreshAutonomousOpsStatus?.();
      setStatus(summary);
      onApproved?.(summary);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleDismiss = () => {
    setBusy('dismiss');
    onDismissed?.();
    setBusy(null);
  };

  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-input/70 p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text-primary">{recommendation.workflowLabel}</div>
        <div className="mt-1 text-xs text-text-secondary leading-relaxed">{recommendation.note}</div>
      </div>

      {recommendation.suggestedActionLabel && (
        <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-2 text-[11px] text-text-secondary">
          Suggested action: <span className="text-text-primary font-medium">{recommendation.suggestedActionLabel}</span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          disabled={busy === 'approve'}
          onClick={handleApprove}
          className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {busy === 'approve' ? <RefreshCw size={12} className="animate-spin" /> : <Check size={12} />}
          Approve
        </button>
        <button
          disabled={busy === 'approve'}
          onClick={handleDismiss}
          className="px-3 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <X size={12} />
          Dismiss
        </button>
      </div>

      {status && (
        <div className="rounded-lg border border-border-subtle bg-bg-item-surface px-3 py-2 text-[11px] text-text-secondary">
          {status}
        </div>
      )}
    </div>
  );
};
