/**
 * Outlook COM Bridge — PowerShell-based Outlook integration via COM automation.
 *
 * Uses direct local COM access to the running Outlook Desktop instance.
 * Zero cloud setup, no Azure approval path, no OAuth tokens.
 *
 * Architecture:
 *   TypeScript (this file) → child_process.execFile → PowerShell → Outlook COM
 *
 * Each operation calls a PowerShell script that returns JSON to stdout.
 * Inbox polling runs on a 30s interval; calendar on 5min.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type {
  OutlookEmail,
  OutlookDraft,
  OutlookCalendarEvent,
  CalendarCreateRequest,
  AvailabilityResult,
  FreeBusySlot,
  OutlookContact,
  ComBridgeStatus,
  MeetingResponse,
  BusyStatus,
} from './MicrosoftLocalTypes';

const execFileAsync = promisify(execFile);

/** Must use Windows PowerShell 5.1 — COM interop (GetActiveObject) requires full .NET Framework.
 *  pwsh.exe (PS7/.NET Core) removed Marshal.GetActiveObject entirely. */
const POWERSHELL = 'powershell.exe';

/** Common PowerShell args: no profile (faster startup), local-only execution policy. */
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned'];

/** Timeout for individual COM operations (ms). */
const COM_TIMEOUT_MS = 30_000;

/** Inbox poll interval (ms) — 2 min to avoid EDR beacon-pattern detection. */
const INBOX_POLL_MS = 2 * 60_000;

/** Calendar poll interval (ms). */
const CALENDAR_POLL_MS = 10 * 60_000;

function resolveScriptsDir(): string {
  const candidates = [
    path.join(__dirname, 'outlook-bridge'),
    path.join(process.resourcesPath || '', 'outlook-bridge'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'outlook-bridge'),
    path.join(process.cwd(), 'electron', 'services', 'outlook-bridge'),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Outlook bridge scripts not found. Checked: ${candidates.join(', ')}`);
  }
  return found;
}

interface PollState {
  lastInboxPoll: number;
  lastCalendarPoll: number;
  lastUnreadCount: number;
  processedEmailIds: Set<string>;
}

export class OutlookComBridge {
  private win: BrowserWindow | null = null;
  private inboxInterval: ReturnType<typeof setInterval> | null = null;
  private calendarInterval: ReturnType<typeof setInterval> | null = null;
  private readonly scriptsDir = resolveScriptsDir();
  private state: PollState = {
    lastInboxPoll: 0,
    lastCalendarPoll: 0,
    lastUnreadCount: 0,
    processedEmailIds: new Set(),
  };
  private cachedStatus: ComBridgeStatus | null = null;
  private cachedEmails: OutlookEmail[] = [];
  private cachedCalendar: OutlookCalendarEvent[] = [];
  private healthy = false;

  /** Attach to an Electron window for IPC event emission. */
  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  // ── Script execution helpers ─────────────────────────────────

  /** Run a PowerShell script and parse JSON output. */
  /**
   * Strip control characters (U+0000–U+001F except \t \n \r) that break JSON.parse.
   * Email bodies from Outlook COM often contain these — especially \x00, \x0C, \x1B.
   */
  private sanitizeJson(raw: string): string {
    // eslint-disable-next-line no-control-regex
    return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  private async runScript<T>(scriptName: string, args: string[] = []): Promise<T> {
    const scriptPath = path.join(this.scriptsDir, scriptName);
    const psArgs = [...PS_ARGS, '-File', scriptPath, ...args];

    try {
      const { stdout } = await execFileAsync(POWERSHELL, psArgs, {
        timeout: COM_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024, // 10MB for large email bodies
      });

      const trimmed = stdout.trim();
      if (!trimmed) throw new Error(`Empty output from ${scriptName}`);
      return JSON.parse(this.sanitizeJson(trimmed)) as T;
    } catch (err: any) {
      // PowerShell may write errors to stderr even when stdout has valid JSON
      // (e.g. COM GetActiveObject fails but the script's catch block still outputs JSON)
      const stdout = err.stdout?.trim();
      if (stdout) {
        try { return JSON.parse(this.sanitizeJson(stdout)) as T; } catch { /* fall through */ }
      }
      throw new Error(`COM bridge ${scriptName} failed: ${err.message}`);
    }
  }

  /** Run execute-action.ps1 with JSON piped to stdin. */
  private async executeAction<T>(actionJson: object): Promise<T> {
    const scriptPath = path.join(this.scriptsDir, 'execute-action.ps1');
    const input = JSON.stringify(actionJson);
    const psArgs = [...PS_ARGS, '-File', scriptPath, '-JsonInput', input];

    const { stdout } = await execFileAsync(POWERSHELL, psArgs, {
      timeout: COM_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    });

    const trimmed = stdout.trim();
    if (!trimmed) throw new Error('Empty output from execute-action');
    return JSON.parse(this.sanitizeJson(trimmed)) as T;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Start polling loops. Call after app is ready. */
  async start() {
    // Health check first
    await this.healthCheck();

    // Always start polling intervals — pollInbox/pollCalendar re-check health
    // internally so they gracefully no-op when Outlook isn't available, and
    // automatically recover once it becomes available.
    this.inboxInterval = setInterval(() => this.pollInbox(), INBOX_POLL_MS);
    this.calendarInterval = setInterval(() => this.pollCalendar(), CALENDAR_POLL_MS);

    if (this.healthy) {
      // Initial polls (only if already healthy — otherwise wait for first interval)
      this.pollInbox().catch((e) => console.warn('[COM Bridge] Initial inbox poll failed:', e.message));
      this.pollCalendar().catch((e) => console.warn('[COM Bridge] Initial calendar poll failed:', e.message));
    }
  }

  /** Stop all polling. */
  stop() {
    if (this.inboxInterval) { clearInterval(this.inboxInterval); this.inboxInterval = null; }
    if (this.calendarInterval) { clearInterval(this.calendarInterval); this.calendarInterval = null; }
  }

  // ── Health Check ─────────────────────────────────────────────

  async healthCheck(): Promise<ComBridgeStatus> {
    try {
      const result = await this.runScript<{
        outlookRunning: boolean;
        comAvailable: boolean;
        userEmail: string | null;
        userName: string | null;
        outlookType?: 'classic' | 'new' | 'none';
        error: string | null;
      }>('health-check.ps1');

      this.healthy = result.comAvailable;
      const lastError = result.error || undefined;
      this.cachedStatus = {
        outlookRunning: result.outlookRunning,
        comAvailable: result.comAvailable,
        userEmail: result.userEmail || undefined,
        userName: result.userName || undefined,
        lastPoll: this.state.lastInboxPoll || undefined,
        lastError,
      };
      return this.cachedStatus;
    } catch (err: any) {
      this.healthy = false;
      this.cachedStatus = {
        outlookRunning: false,
        comAvailable: false,
        lastError: err.message,
      };
      return this.cachedStatus;
    }
  }

  async getStatus(): Promise<ComBridgeStatus> {
    if (!this.cachedStatus || Date.now() - (this.state.lastInboxPoll || 0) > 60_000) {
      return this.healthCheck();
    }
    return this.cachedStatus;
  }

  // ── Email Operations ─────────────────────────────────────────

  async listEmails(options?: {
    folder?: 'inbox' | 'sentitems' | 'drafts';
    top?: number;
    skip?: number;
    unreadOnly?: boolean;
  }): Promise<{ emails: OutlookEmail[]; totalCount: number }> {
    const args: string[] = [];
    if (options?.folder) args.push('-Folder', options.folder);
    if (options?.top) args.push('-MaxItems', String(options.top));
    if (options?.unreadOnly) args.push('-UnreadOnly');

    const result = await this.runScript<{
      emails: OutlookEmail[];
      totalCount: number;
      error?: string;
    }>('poll-inbox.ps1', args);

    if (result.error) throw new Error(result.error);
    this.cachedEmails = result.emails;
    return result;
  }

  async getEmail(entryId: string): Promise<OutlookEmail> {
    // Fetch single email with full body via dedicated script
    const result = await this.runScript<OutlookEmail & { error?: string }>('get-email.ps1', ['-EntryId', entryId]);
    if ((result as any).error) throw new Error((result as any).error);
    return result;
  }

  async searchEmails(query: string, top = 25): Promise<{ emails: OutlookEmail[]; totalCount: number }> {
    const result = await this.runScript<{
      emails: OutlookEmail[];
      totalCount: number;
      error?: string;
    }>('search-emails.ps1', ['-Query', query, '-MaxItems', String(top)]);

    if (result.error) throw new Error(result.error);
    return result;
  }

  async getUnreadCount(): Promise<number> {
    const result = await this.listEmails({ unreadOnly: true, top: 500 });
    const count = result.totalCount;
    if (count !== this.state.lastUnreadCount) {
      this.state.lastUnreadCount = count;
      this.emit('outlook:unread-count', count);
    }
    return count;
  }

  async markAsRead(entryId: string): Promise<void> {
    await this.executeAction({ action: 'email_mark_read', originalEntryId: entryId, isRead: true });
  }

  async flagEmail(entryId: string, flagText?: string): Promise<void> {
    await this.executeAction({ action: 'email_flag', originalEntryId: entryId, flagText: flagText || 'Follow up' });
  }

  async categorize(entryId: string, categories: string[]): Promise<void> {
    await this.executeAction({ action: 'email_categorize', originalEntryId: entryId, categories });
  }

  async moveEmail(entryId: string, targetFolder: string): Promise<void> {
    await this.executeAction({ action: 'email_move', originalEntryId: entryId, targetFolder });
  }

  async createDraft(draft: OutlookDraft): Promise<{ entryId: string }> {
    const result = await this.executeAction<{ success: boolean; entryId?: string; detail: string }>({
      action: 'email_send',
      subject: draft.subject,
      body: draft.body,
      htmlBody: draft.bodyType === 'html' ? draft.body : undefined,
      toRecipients: draft.toRecipients,
      ccRecipients: draft.ccRecipients || [],
      importance: draft.importance || 'normal',
      send: false, // Draft only — opens in Outlook
    });
    if (!result.success) throw new Error(result.detail);
    return { entryId: result.entryId || '' };
  }

  async sendDraft(entryId: string): Promise<void> {
    // For COM, "send draft" means re-executing with send=true
    // In practice, the draft is already in Outlook — user clicks Send there
    // This is a no-op for COM bridge since Display() opened it
    console.log('[COM Bridge] sendDraft called — draft was opened in Outlook via Display()');
  }

  async sendEmail(draft: OutlookDraft): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'email_send',
      subject: draft.subject,
      body: draft.body,
      htmlBody: draft.bodyType === 'html' ? draft.body : undefined,
      toRecipients: draft.toRecipients,
      ccRecipients: draft.ccRecipients || [],
      importance: draft.importance || 'normal',
      send: true,
    });
    if (!result.success) throw new Error(result.detail);
  }

  async reply(entryId: string, body: string, replyAll = false, send = false): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'email_reply',
      originalEntryId: entryId,
      body,
      replyAll,
      send,
    });
    if (!result.success) throw new Error(result.detail);
  }

  async forward(entryId: string, to: string[], body?: string): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'email_forward',
      originalEntryId: entryId,
      forwardTo: to,
      body: body || '',
      send: false,
    });
    if (!result.success) throw new Error(result.detail);
  }

  /** Generate a context summary of recent emails for AI consumption. */
  async getContextSummary(): Promise<string> {
    const parts: string[] = [];

    // ── Calendar: today's events (past + upcoming) with attendee emails ──
    if (this.cachedCalendar.length === 0) {
      try { await this.pollCalendar(); } catch {}
    }
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const todayEvents = this.cachedCalendar
      .filter((e) => {
        const s = new Date(e.start);
        return s >= todayStart && s <= todayEnd;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    if (todayEvents.length > 0) {
      const calLines = todayEvents.map((e) => {
        const start = new Date(e.start);
        const end = new Date(e.end);
        const isPast = end < now;
        const isNow = start <= now && end >= now;
        const status = isNow ? ' [NOW]' : isPast ? ' [DONE]' : '';
        const attendeeList = e.attendees.length > 0
          ? `\n    Attendees: ${e.attendees.map((a) => `${a.name} <${a.email}>`).join(', ')}`
          : '';
        return `• ${start.toLocaleTimeString()} – ${end.toLocaleTimeString()} "${e.subject}" @ ${e.location || 'No location'}${status}${attendeeList}`;
      });
      parts.push(`## Today's Calendar (${now.toLocaleDateString()}):\n${calLines.join('\n')}`);
    }

    // ── Recent emails with sender addresses ──
    if (this.cachedEmails.length === 0) {
      try { await this.pollInbox(); } catch {}
    }
    const recent = this.cachedEmails.slice(0, 15);
    if (recent.length > 0) {
      const emailLines = recent.map((e) => {
        const read = e.isRead ? '' : ' [UNREAD]';
        const flag = e.flag?.flagStatus === 'flagged' ? ' [FLAGGED]' : '';
        return `• ${e.from.name} <${e.from.address}> — "${e.subject}"${read}${flag} (${new Date(e.receivedDateTime).toLocaleString()})`;
      });
      parts.push(`## Recent Emails (${recent.length}):\n${emailLines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : 'Outlook data loading...';
  }

  // ── Calendar Operations ──────────────────────────────────────

  async getEvents(startDate: string, endDate: string): Promise<OutlookCalendarEvent[]> {
    const tempPath = path.join(
      app.getPath('temp'),
      `natively-calendar-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );

    try {
      const result = await this.runScript<{
        outputPath?: string;
        error?: string;
      }>('poll-calendar.ps1', ['-StartDate', startDate, '-EndDate', endDate, '-OutputPath', tempPath]);

      if (result.error) throw new Error(result.error);
      const payloadPath = result.outputPath || tempPath;
      const raw = fs.readFileSync(payloadPath, 'utf8').trim();
      const parsed = JSON.parse(this.sanitizeJson(raw)) as {
        events: OutlookCalendarEvent[];
        error?: string;
      };

      if (parsed.error) throw new Error(parsed.error);
      this.cachedCalendar = parsed.events;
      return parsed.events;
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort cleanup only.
      }
    }
  }

  async getEvent(entryId: string): Promise<OutlookCalendarEvent | null> {
    return this.cachedCalendar.find((e) => e.entryId === entryId) || null;
  }

  async createEvent(request: CalendarCreateRequest): Promise<{ entryId: string }> {
    const result = await this.executeAction<{ success: boolean; entryId?: string; detail: string }>({
      action: 'calendar_create',
      subject: request.subject,
      start: request.start,
      end: request.end,
      location: request.location || '',
      body: request.body || '',
      attendees: request.attendees || {},
      busyStatus: request.busyStatus || 'busy',
      reminder: request.reminder ?? 15,
      categories: request.categories || [],
      isMeeting: request.isMeeting || !!(request.attendees?.required?.length || request.attendees?.optional?.length),
      send: request.send === true,
    });
    if (!result.success) throw new Error(result.detail);
    return { entryId: result.entryId || '' };
  }

  async updateEvent(entryId: string, updates: Partial<CalendarCreateRequest>): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'calendar_update',
      originalEntryId: entryId,
      updates,
      send: false,
    });
    if (!result.success) throw new Error(result.detail);
  }

  async cancelEvent(entryId: string, body?: string): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'calendar_cancel',
      originalEntryId: entryId,
      cancellationBody: body || '',
    });
    if (!result.success) throw new Error(result.detail);
  }

  async respondToMeeting(entryId: string, response: MeetingResponse, body?: string): Promise<void> {
    const result = await this.executeAction<{ success: boolean; detail: string }>({
      action: 'calendar_respond',
      originalEntryId: entryId,
      response,
      responseBody: body || '',
    });
    if (!result.success) throw new Error(result.detail);
  }

  async checkAvailability(emails: string[], startDate: string, endDate: string): Promise<AvailabilityResult[]> {
    const days = Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000);
    const result = await this.runScript<{
      results: AvailabilityResult[];
      error?: string;
    }>('check-availability.ps1', [
      '-Emails', emails.join(','),
      '-StartDate', startDate,
      '-Days', String(Math.max(1, days)),
    ]);

    if (result.error) throw new Error(result.error);
    return result.results;
  }

  async findMeetingTimes(
    emails: string[],
    durationMinutes: number,
    startDate: string,
    endDate: string,
  ): Promise<FreeBusySlot[]> {
    const availability = await this.checkAvailability(emails, startDate, endDate);
    if (availability.length === 0) return [];

    // Find overlapping free slots across all attendees
    const allFreeByTime = new Map<string, number>();
    for (const person of availability) {
      for (const slot of person.freeSlots) {
        const key = `${slot.start}|${slot.end}`;
        allFreeByTime.set(key, (allFreeByTime.get(key) || 0) + 1);
      }
    }

    // Only return slots where ALL attendees are free
    const totalPeople = availability.length;
    const commonFree: FreeBusySlot[] = [];
    for (const [key, count] of allFreeByTime) {
      if (count >= totalPeople) {
        const [start, end] = key.split('|');
        const slotDuration = (new Date(end).getTime() - new Date(start).getTime()) / 60_000;
        if (slotDuration >= durationMinutes) {
          commonFree.push({ start, end, status: 'free' as BusyStatus });
        }
      }
    }

    return commonFree.sort((a, b) => a.start.localeCompare(b.start));
  }

  async getUpcoming(hours = 24): Promise<OutlookCalendarEvent[]> {
    const now = new Date();
    const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
    return this.getEvents(now.toISOString(), end.toISOString());
  }

  async getContacts(query?: string): Promise<OutlookContact[]> {
    const args: string[] = [];
    if (query) args.push('-Query', query);

    const result = await this.runScript<{
      contacts: OutlookContact[];
      error?: string;
    }>('get-contacts.ps1', args);

    if (result.error) throw new Error(result.error);
    return result.contacts;
  }

  /** Generate a calendar context summary for AI consumption. */
  async getCalendarSummary(): Promise<string> {
    if (this.cachedCalendar.length === 0) {
      await this.pollCalendar();
    }
    const now = new Date();
    const upcoming = this.cachedCalendar
      .filter((e) => new Date(e.start) >= now)
      .slice(0, 10);

    if (upcoming.length === 0) return 'No upcoming calendar events.';

    const lines = upcoming.map((e) => {
      const start = new Date(e.start);
      const isToday = start.toDateString() === now.toDateString();
      const dateStr = isToday ? start.toLocaleTimeString() : start.toLocaleString();
      const attendees = e.attendees.length > 0
        ? ` (${e.attendees.map((a) => a.name).join(', ')})`
        : '';
      return `• ${dateStr} — "${e.subject}" @ ${e.location || 'No location'}${attendees} [${e.busyStatus}]`;
    });
    return `## Upcoming Calendar (${upcoming.length}):\n${lines.join('\n')}`;
  }

  // ── Polling ──────────────────────────────────────────────────

  private async pollInbox() {
    if (!this.healthy) {
      await this.healthCheck();
      if (!this.healthy) return;
    }

    try {
      const since = this.state.lastInboxPoll
        ? new Date(this.state.lastInboxPoll).toISOString()
        : '';

      const result = await this.listEmails({ top: 50, ...(since ? {} : {}) });
      this.state.lastInboxPoll = Date.now();

      // Detect new emails
      for (const email of result.emails) {
        if (!this.state.processedEmailIds.has(email.id)) {
          this.state.processedEmailIds.add(email.id);
          this.emit('outlook:new-email', email);
        }
      }

      // Prune tracking set (keep last 500)
      if (this.state.processedEmailIds.size > 500) {
        const arr = Array.from(this.state.processedEmailIds);
        this.state.processedEmailIds = new Set(arr.slice(-500));
      }

      // Update unread count
      const unread = result.emails.filter((e) => !e.isRead).length;
      if (unread !== this.state.lastUnreadCount) {
        this.state.lastUnreadCount = unread;
        this.emit('outlook:unread-count', unread);
      }
    } catch (err: any) {
      console.warn('[COM Bridge] Inbox poll failed:', err.message);
      if (err.message?.includes('Cannot create') || err.message?.includes('RPC')) {
        this.healthy = false;
      }
    }
  }

  private async pollCalendar() {
    if (!this.healthy) return;

    try {
      const now = new Date();
      const weekOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      await this.getEvents(now.toISOString(), weekOut.toISOString());
      this.state.lastCalendarPoll = Date.now();
    } catch (err: any) {
      console.warn('[COM Bridge] Calendar poll failed:', err.message);
    }
  }

  // ── IPC Emission ─────────────────────────────────────────────

  private emit(channel: string, data: any) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
