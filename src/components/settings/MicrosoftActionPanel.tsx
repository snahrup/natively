import React, { useEffect, useMemo, useState } from 'react';
import { CalendarPlus2, Mail, MessageSquare, Send } from 'lucide-react';

type OutlookEmail = {
  id: string;
  subject: string;
  from?: { name?: string; address?: string };
  bodyPreview?: string;
  receivedDateTime?: string;
};

type TeamsChat = {
  id: string;
  topic: string;
  lastMessage?: string;
  lastMessageTime?: string;
};

type TeamsMessage = {
  id: string;
  sender: string;
  content: string;
  timestamp?: string;
  isFromMe?: boolean;
};

interface MicrosoftActionPanelProps {
  outlookConnected: boolean;
  teamsConnected: boolean;
  onSourcesChanged?: () => Promise<void> | void;
}

const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const toLocalInput = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const MicrosoftActionPanel: React.FC<MicrosoftActionPanelProps> = ({
  outlookConnected,
  teamsConnected,
  onSourcesChanged,
}) => {
  const [emails, setEmails] = useState<OutlookEmail[]>([]);
  const [selectedEmailId, setSelectedEmailId] = useState("");
  const [teamsChats, setTeamsChats] = useState<TeamsChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [teamsMessages, setTeamsMessages] = useState<TeamsMessage[]>([]);
  const [status, setStatus] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [replyAll, setReplyAll] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [teamReply, setTeamReply] = useState("");
  const [emailDraft, setEmailDraft] = useState({
    to: "",
    cc: "",
    subject: "",
    body: "",
  });
  const [meetingDraft, setMeetingDraft] = useState(() => {
    const start = new Date();
    start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    return {
      subject: "",
      start: toLocalInput(start),
      end: toLocalInput(end),
      location: "",
      required: "",
      optional: "",
      body: "",
      sendInvites: false,
    };
  });

  const selectedEmail = useMemo(
    () => emails.find((email) => email.id === selectedEmailId) || emails[0] || null,
    [emails, selectedEmailId]
  );

  const selectedChat = useMemo(
    () => teamsChats.find((chat) => chat.id === selectedChatId) || teamsChats[0] || null,
    [teamsChats, selectedChatId]
  );

  const refreshOutlook = async () => {
    if (!outlookConnected || !window.electronAPI?.outlookListEmails) {
      setEmails([]);
      setSelectedEmailId("");
      return;
    }
    const result = await window.electronAPI.outlookListEmails({ top: 8 });
    const nextEmails = result?.emails || [];
    setEmails(nextEmails);
    setSelectedEmailId((current) => current || nextEmails[0]?.id || "");
  };

  const refreshTeams = async () => {
    if (!teamsConnected || !window.electronAPI?.teamsListChats) {
      setTeamsChats([]);
      setSelectedChatId("");
      setTeamsMessages([]);
      return;
    }
    const chats = await window.electronAPI.teamsListChats(8);
    const nextChats = chats || [];
    setTeamsChats(nextChats);
    setSelectedChatId((current) => current || nextChats[0]?.id || "");
  };

  const refreshTeamsMessages = async (chatId: string) => {
    if (!teamsConnected || !chatId || !window.electronAPI?.teamsGetMessages) {
      setTeamsMessages([]);
      return;
    }
    const messages = await window.electronAPI.teamsGetMessages(chatId, 12);
    setTeamsMessages(messages || []);
  };

  useEffect(() => {
    refreshOutlook().catch(() => undefined);
    refreshTeams().catch(() => undefined);
  }, [outlookConnected, teamsConnected]);

  useEffect(() => {
    if (selectedChat?.id) {
      refreshTeamsMessages(selectedChat.id).catch(() => undefined);
    }
  }, [selectedChat?.id]);

  useEffect(() => {
    if (selectedEmail?.subject && !emailDraft.subject) {
      setEmailDraft((current) => ({ ...current, subject: `Re: ${selectedEmail.subject}` }));
    }
  }, [selectedEmail?.subject, emailDraft.subject]);

  const runAction = async (key: string, work: () => Promise<void>) => {
    setBusyKey(key);
    setStatus("");
    try {
      await work();
      if (onSourcesChanged) {
        await onSourcesChanged();
      }
    } catch (error: any) {
      setStatus(error?.message || "Action failed.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-bold text-text-primary">Microsoft Actions</h4>
          <p className="text-xs text-text-secondary mt-1">
            Use the local Outlook and Teams bridges directly before the next packaged release. Draft actions stay non-destructive. Send actions attempt the real send path.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              refreshOutlook().catch(() => undefined);
              refreshTeams().catch(() => undefined);
            }}
            className="px-3 py-1.5 rounded-full text-[11px] font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors"
          >
            Refresh Sources
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl border border-border-subtle bg-bg-input/50 p-4 space-y-4">
          <div className="flex items-center gap-2 text-text-primary">
            <Mail size={16} />
            <div className="text-sm font-semibold">Send Email / Open Draft</div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            <input
              value={emailDraft.to}
              onChange={(event) => setEmailDraft((current) => ({ ...current, to: event.target.value }))}
              placeholder="To addresses, comma separated"
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
            />
            <input
              value={emailDraft.cc}
              onChange={(event) => setEmailDraft((current) => ({ ...current, cc: event.target.value }))}
              placeholder="CC addresses, comma separated"
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
            />
            <input
              value={emailDraft.subject}
              onChange={(event) => setEmailDraft((current) => ({ ...current, subject: event.target.value }))}
              placeholder="Subject"
              className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
            />
            <textarea
              value={emailDraft.body}
              onChange={(event) => setEmailDraft((current) => ({ ...current, body: event.target.value }))}
              placeholder="Email body"
              rows={5}
              className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              disabled={busyKey === "email-draft"}
              onClick={() => runAction("email-draft", async () => {
                await window.electronAPI.outlookCreateDraft({
                  toRecipients: splitCsv(emailDraft.to),
                  ccRecipients: splitCsv(emailDraft.cc),
                  subject: emailDraft.subject.trim(),
                  body: emailDraft.body,
                });
                setStatus("Email draft opened in Outlook.");
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
            >
              Open Draft
            </button>
                <button
                  disabled={busyKey === "email-send"}
                  onClick={() => runAction("email-send", async () => {
                    await window.electronAPI.outlookSendEmail({
                  toRecipients: splitCsv(emailDraft.to),
                  ccRecipients: splitCsv(emailDraft.cc),
                  subject: emailDraft.subject.trim(),
                  body: emailDraft.body,
                });
                setStatus("Email handed to Outlook send now. Check Outbox or Sent Items if Outlook is syncing.");
              })}
              className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <Send size={12} />
              Send Email Now
            </button>
          </div>

          <div className="border-t border-border-subtle pt-4 space-y-3">
            <div className="text-xs font-semibold text-text-primary">Reply from recent Outlook mail</div>
            <div className="grid grid-cols-1 gap-2 max-h-36 overflow-auto pr-1">
              {emails.length === 0 && (
                <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-[11px] text-text-secondary">
                  {outlookConnected ? "No recent mail loaded yet." : "Outlook local bridge is offline."}
                </div>
              )}
              {emails.map((email) => (
                <button
                  key={email.id}
                  onClick={() => setSelectedEmailId(email.id)}
                  className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                    selectedEmail?.id === email.id
                      ? "border-accent-primary/40 bg-accent-primary/5"
                      : "border-border-subtle bg-bg-input hover:bg-bg-item-hover"
                  }`}
                >
                  <div className="text-[11px] font-medium text-text-primary truncate">{email.subject || "(No subject)"}</div>
                  <div className="text-[10px] text-text-tertiary truncate">
                    {email.from?.name || email.from?.address || "Unknown sender"}
                  </div>
                </button>
              ))}
            </div>
            {selectedEmail && (
              <>
                <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-[11px] text-text-secondary">
                  <div className="text-text-primary font-medium">{selectedEmail.subject || "(No subject)"}</div>
                  <div className="mt-1">{selectedEmail.bodyPreview || "No preview available."}</div>
                </div>
                <textarea
                  value={replyBody}
                  onChange={(event) => setReplyBody(event.target.value)}
                  placeholder="Reply body"
                  rows={4}
                  className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
                />
                <label className="flex items-center gap-2 text-[11px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={replyAll}
                    onChange={(event) => setReplyAll(event.target.checked)}
                    className="accent-accent-primary"
                  />
                  Reply all
                </label>
                <div className="flex items-center gap-2">
                  <button
                    disabled={busyKey === "email-reply-draft"}
                    onClick={() => runAction("email-reply-draft", async () => {
                      await window.electronAPI.outlookReplyEmail(selectedEmail.id, replyBody, replyAll, false);
                      setStatus("Reply draft opened in Outlook.");
                    })}
                    className="px-3 py-2 rounded-full text-xs font-medium bg-bg-input border border-border-subtle text-text-primary hover:bg-bg-item-hover transition-colors disabled:opacity-50"
                  >
                    Open Reply Draft
                  </button>
                  <button
                    disabled={busyKey === "email-reply-send"}
                    onClick={() => runAction("email-reply-send", async () => {
                      await window.electronAPI.outlookReplyEmail(selectedEmail.id, replyBody, replyAll, true);
                      setStatus("Reply handed to Outlook send now. Check Outbox or Sent Items if Outlook is syncing.");
                    })}
                    className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Send size={12} />
                    Send Reply Now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border-subtle bg-bg-input/50 p-4 space-y-4">
          <div className="flex items-center gap-2 text-text-primary">
            <MessageSquare size={16} />
            <div className="text-sm font-semibold">Reply in Teams</div>
          </div>

          <div className="grid grid-cols-1 gap-2 max-h-36 overflow-auto pr-1">
            {teamsChats.length === 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-[11px] text-text-secondary">
                {teamsConnected ? "No chats loaded yet." : "Teams local bridge is offline."}
              </div>
            )}
            {teamsChats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => setSelectedChatId(chat.id)}
                className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                  selectedChat?.id === chat.id
                    ? "border-accent-primary/40 bg-accent-primary/5"
                    : "border-border-subtle bg-bg-input hover:bg-bg-item-hover"
                }`}
              >
                <div className="text-[11px] font-medium text-text-primary truncate">{chat.topic}</div>
                <div className="text-[10px] text-text-tertiary truncate">
                  {chat.lastMessage || "No preview"}{chat.lastMessageTime ? ` • ${chat.lastMessageTime}` : ""}
                </div>
              </button>
            ))}
          </div>

          {selectedChat && (
            <>
              <div className="rounded-lg border border-border-subtle bg-bg-input px-3 py-2 max-h-40 overflow-auto space-y-2">
                <div className="text-[11px] font-medium text-text-primary">{selectedChat.topic}</div>
                {(teamsMessages || []).slice(-6).map((message) => (
                  <div key={message.id} className="text-[11px] text-text-secondary">
                    <span className="text-text-primary font-medium">{message.sender}:</span> {message.content}
                  </div>
                ))}
              </div>
              <textarea
                value={teamReply}
                onChange={(event) => setTeamReply(event.target.value)}
                placeholder="Message to send in this chat"
                rows={4}
                className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
              />
              <button
                disabled={busyKey === "teams-send"}
                onClick={() => runAction("teams-send", async () => {
                  const result = await window.electronAPI.teamsSendMessage(selectedChat.id, teamReply);
                  setTeamReply("");
                  if (result?.success === false) {
                    throw new Error(result.error || "Teams send failed.");
                  }
                  setStatus(result?.verified === false
                    ? (result.warning || "Teams send was attempted but could not be verified yet.")
                    : "Message sent to Teams.");
                  await refreshTeamsMessages(selectedChat.id);
                })}
                className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                <Send size={12} />
                Send to Teams Now
              </button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-bg-input/50 p-4 space-y-4">
        <div className="flex items-center gap-2 text-text-primary">
          <CalendarPlus2 size={16} />
          <div className="text-sm font-semibold">Schedule Outlook Calendar Event</div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            value={meetingDraft.subject}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, subject: event.target.value }))}
            placeholder="Meeting title"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={meetingDraft.location}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, location: event.target.value }))}
            placeholder="Location or call link"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            type="datetime-local"
            value={meetingDraft.start}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, start: event.target.value }))}
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            type="datetime-local"
            value={meetingDraft.end}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, end: event.target.value }))}
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={meetingDraft.required}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, required: event.target.value }))}
            placeholder="Required attendees, comma separated"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
          <input
            value={meetingDraft.optional}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, optional: event.target.value }))}
            placeholder="Optional attendees, comma separated"
            className="w-full bg-bg-input border border-border-subtle rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50"
          />
        </div>

        <textarea
          value={meetingDraft.body}
          onChange={(event) => setMeetingDraft((current) => ({ ...current, body: event.target.value }))}
          placeholder="Agenda or meeting notes"
          rows={4}
          className="w-full bg-bg-input border border-border-subtle rounded-xl px-3 py-3 text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent-primary/50 resize-y"
        />

        <label className="flex items-center gap-2 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={meetingDraft.sendInvites}
            onChange={(event) => setMeetingDraft((current) => ({ ...current, sendInvites: event.target.checked }))}
            className="accent-accent-primary"
          />
          Send invites immediately if attendees are included
        </label>

        <button
          disabled={busyKey === "calendar-create"}
          onClick={() => runAction("calendar-create", async () => {
            await window.electronAPI.outlookCreateCalendarEvent({
              subject: meetingDraft.subject.trim(),
              start: new Date(meetingDraft.start).toISOString(),
              end: new Date(meetingDraft.end).toISOString(),
              location: meetingDraft.location.trim(),
              body: meetingDraft.body,
              attendees: {
                required: splitCsv(meetingDraft.required),
                optional: splitCsv(meetingDraft.optional),
              },
              isMeeting: splitCsv(meetingDraft.required).length > 0 || splitCsv(meetingDraft.optional).length > 0,
              send: meetingDraft.sendInvites,
            });
            setStatus(meetingDraft.sendInvites ? "Meeting created and handed to Outlook invite send." : "Calendar event saved in Outlook without sending invites.");
          })}
          className="px-3 py-2 rounded-full text-xs font-medium bg-accent-primary text-white hover:opacity-90 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <CalendarPlus2 size={12} />
          {meetingDraft.sendInvites ? 'Create + Send Invites' : 'Save Event Only'}
        </button>
      </div>

      {status && (
        <div className="rounded-lg border border-accent-primary/20 bg-accent-primary/10 px-3 py-2 text-[11px] text-accent-primary">
          {status}
        </div>
      )}
    </div>
  );
};
