import React, { useMemo, useState } from 'react';
import { CalendarPlus2, Mail, MessageSquare, Send } from 'lucide-react';

type EmailProposal = {
  kind: 'email';
  ready: boolean;
  note: string;
  sendIntent: boolean;
  missing?: string[];
  draft: {
    toRecipients: string[];
    ccRecipients: string[];
    subject: string;
    body: string;
    importance: 'low' | 'normal' | 'high';
  };
  resolvedRecipients: Array<{ name: string; email: string }>;
  unresolvedRecipients?: string[];
  unresolvedCc?: string[];
};

type TeamsProposal = {
  kind: 'teams_message';
  ready: boolean;
  note: string;
  sendIntent: boolean;
  missing?: string[];
  target?: {
    chatId: string;
    label: string;
  };
  unresolvedTarget?: string;
  message: string;
};

type CalendarProposal = {
  kind: 'calendar_event';
  ready: boolean;
  note: string;
  sendIntent: boolean;
  missing?: string[];
  event: {
    subject: string;
    start: string;
    end: string;
    location: string;
    body: string;
    required: string[];
    optional: string[];
  };
  unresolvedRequired?: string[];
  unresolvedOptional?: string[];
};

export type InlineActionProposal = EmailProposal | TeamsProposal | CalendarProposal;

interface InlineActionProposalCardProps {
  proposal: InlineActionProposal;
}

const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const InlineActionProposalCard: React.FC<InlineActionProposalCardProps> = ({ proposal }) => {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [emailState, setEmailState] = useState(
    proposal.kind === 'email'
      ? {
          to: proposal.draft.toRecipients.join(', '),
          cc: proposal.draft.ccRecipients.join(', '),
          subject: proposal.draft.subject,
          body: proposal.draft.body,
        }
      : null
  );

  const [teamsState, setTeamsState] = useState(
    proposal.kind === 'teams_message'
      ? {
          chatId: proposal.target?.chatId || '',
          label: proposal.target?.label || proposal.unresolvedTarget || '',
          message: proposal.message,
        }
      : null
  );

  const [calendarState, setCalendarState] = useState(
    proposal.kind === 'calendar_event'
      ? {
          subject: proposal.event.subject,
          start: proposal.event.start,
          end: proposal.event.end,
          location: proposal.event.location,
          body: proposal.event.body,
          required: proposal.event.required.join(', '),
          optional: proposal.event.optional.join(', '),
          sendInvites: proposal.sendIntent,
        }
      : null
  );

  const isReadyNow = useMemo(() => {
    if (proposal.kind === 'email' && emailState) {
      return splitCsv(emailState.to).length > 0 && !!emailState.subject.trim() && !!emailState.body.trim();
    }
    if (proposal.kind === 'teams_message' && teamsState) {
      return !!teamsState.chatId && !!teamsState.message.trim();
    }
    if (proposal.kind === 'calendar_event' && calendarState) {
      return (
        !!calendarState.subject.trim() &&
        !!calendarState.start &&
        !!calendarState.end &&
        calendarState.end > calendarState.start
      );
    }
    return proposal.ready;
  }, [proposal, emailState, teamsState, calendarState]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setStatus('');
    try {
      await work();
    } catch (error: any) {
      setStatus(error?.message || 'Action failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-input/70 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-accent-primary/10 p-2 text-accent-primary">
          {proposal.kind === 'email' ? <Mail size={16} /> : proposal.kind === 'teams_message' ? <MessageSquare size={16} /> : <CalendarPlus2 size={16} />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary">
            {proposal.kind === 'email' ? 'Email Draft' : proposal.kind === 'teams_message' ? 'Teams Message' : 'Calendar Invite'}
          </div>
          <div className="text-xs text-text-secondary mt-1">{proposal.note}</div>
        </div>
      </div>

      {!!proposal.missing?.length && (
        <div className="rounded-xl border border-amber-300/30 bg-amber-100/50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          {proposal.missing.join(' ')}
        </div>
      )}

      {proposal.kind === 'email' && emailState && (
        <div className="space-y-3">
          <input
            value={emailState.to}
            onChange={(event) => setEmailState((current) => current ? { ...current, to: event.target.value } : current)}
            placeholder="To"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={emailState.cc}
            onChange={(event) => setEmailState((current) => current ? { ...current, cc: event.target.value } : current)}
            placeholder="CC"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={emailState.subject}
            onChange={(event) => setEmailState((current) => current ? { ...current, subject: event.target.value } : current)}
            placeholder="Subject"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <textarea
            value={emailState.body}
            onChange={(event) => setEmailState((current) => current ? { ...current, body: event.target.value } : current)}
            rows={6}
            className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
          />
          <div className="flex items-center gap-2">
            <button
              disabled={busy === 'email-draft'}
              onClick={() => run('email-draft', async () => {
                await window.electronAPI.outlookCreateDraft({
                  toRecipients: splitCsv(emailState.to),
                  ccRecipients: splitCsv(emailState.cc),
                  subject: emailState.subject.trim(),
                  body: emailState.body,
                });
                setStatus('Draft opened in Outlook.');
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
            >
              Open Draft
            </button>
            <button
              disabled={!isReadyNow || busy === 'email-send'}
              onClick={() => run('email-send', async () => {
                await window.electronAPI.outlookSendEmail({
                  toRecipients: splitCsv(emailState.to),
                  ccRecipients: splitCsv(emailState.cc),
                  subject: emailState.subject.trim(),
                  body: emailState.body,
                });
                setStatus('Email handed to Outlook send now.');
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Send size={12} />
              Send Email
            </button>
          </div>
        </div>
      )}

      {proposal.kind === 'teams_message' && teamsState && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary">
            {teamsState.label || 'Unresolved Teams chat'}
          </div>
          <textarea
            value={teamsState.message}
            onChange={(event) => setTeamsState((current) => current ? { ...current, message: event.target.value } : current)}
            rows={5}
            className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
          />
          <button
            disabled={!isReadyNow || busy === 'teams-send'}
            onClick={() => run('teams-send', async () => {
              const result = await window.electronAPI.teamsSendMessage(teamsState.chatId, teamsState.message);
              if (!result.success) {
                throw new Error(result.error || 'Teams send failed.');
              }
              setStatus(result.verified === false ? (result.warning || 'Teams send triggered but could not be verified.') : 'Teams message sent.');
            })}
            className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <Send size={12} />
            Send Teams Message
          </button>
        </div>
      )}

      {proposal.kind === 'calendar_event' && calendarState && (
        <div className="space-y-3">
          <input
            value={calendarState.subject}
            onChange={(event) => setCalendarState((current) => current ? { ...current, subject: event.target.value } : current)}
            placeholder="Meeting title"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="datetime-local"
              value={calendarState.start}
              onChange={(event) => setCalendarState((current) => current ? { ...current, start: event.target.value } : current)}
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50"
            />
            <input
              type="datetime-local"
              value={calendarState.end}
              onChange={(event) => setCalendarState((current) => current ? { ...current, end: event.target.value } : current)}
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50"
            />
          </div>
          <input
            value={calendarState.location}
            onChange={(event) => setCalendarState((current) => current ? { ...current, location: event.target.value } : current)}
            placeholder="Location"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={calendarState.required}
            onChange={(event) => setCalendarState((current) => current ? { ...current, required: event.target.value } : current)}
            placeholder="Required attendees"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={calendarState.optional}
            onChange={(event) => setCalendarState((current) => current ? { ...current, optional: event.target.value } : current)}
            placeholder="Optional attendees"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <textarea
            value={calendarState.body}
            onChange={(event) => setCalendarState((current) => current ? { ...current, body: event.target.value } : current)}
            rows={5}
            className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
          />
          <label className="flex items-center gap-2 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={calendarState.sendInvites}
              onChange={(event) => setCalendarState((current) => current ? { ...current, sendInvites: event.target.checked } : current)}
              className="accent-accent-primary"
            />
            Send invites immediately
          </label>
          <div className="flex items-center gap-2">
            <button
              disabled={!isReadyNow || busy === 'calendar-save'}
              onClick={() => run('calendar-save', async () => {
                await window.electronAPI.outlookCreateCalendarEvent({
                  subject: calendarState.subject.trim(),
                  start: calendarState.start,
                  end: calendarState.end,
                  location: calendarState.location.trim(),
                  body: calendarState.body,
                  attendees: {
                    required: splitCsv(calendarState.required),
                    optional: splitCsv(calendarState.optional),
                  },
                  send: false,
                });
                setStatus('Calendar event saved in Outlook.');
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
            >
              Save Event
            </button>
            <button
              disabled={!isReadyNow || busy === 'calendar-send'}
              onClick={() => run('calendar-send', async () => {
                await window.electronAPI.outlookCreateCalendarEvent({
                  subject: calendarState.subject.trim(),
                  start: calendarState.start,
                  end: calendarState.end,
                  location: calendarState.location.trim(),
                  body: calendarState.body,
                  attendees: {
                    required: splitCsv(calendarState.required),
                    optional: splitCsv(calendarState.optional),
                  },
                  send: true,
                });
                setStatus('Calendar invite handed to Outlook send now.');
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Send size={12} />
              Create + Send Invites
            </button>
          </div>
        </div>
      )}

      {status && (
        <div className="rounded-lg border border-emerald-300/30 bg-emerald-100/50 px-3 py-2 text-[11px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
          {status}
        </div>
      )}
    </div>
  );
};
