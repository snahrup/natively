/**
 * Teams CDP Bridge — Microsoft Teams integration via Chrome DevTools Protocol.
 *
 * New Teams is a WebView2 (Edge) app. By enabling remote debugging via registry:
 *   HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments
 *     "ms-teams.exe" = "--remote-debugging-port=9223"
 *
 * We connect to the WebView2 context via CDP WebSocket and inject JS to:
 * - Read chat list and messages from the Teams DOM / React state
 * - Send messages by programmatically interacting with the compose box
 * - Listen for new messages via MutationObserver
 *
 * Architecture:
 *   TeamsBridge (this file) → WebSocket → CDP → Teams WebView2 context
 */
import WebSocket from 'ws';
import http from 'node:http';
import { BrowserWindow } from 'electron';
import type {
  TeamsBridgeStatus,
  TeamsBridgeInfo,
  TeamsChat,
  TeamsMessage,
  TeamsSendResult,
} from './MicrosoftLocalTypes';

const CDP_PORT = 9223;
const CDP_DISCOVERY_URL = `http://127.0.0.1:${CDP_PORT}/json`;
/** Chat poll interval — 2.5 min base + jitter to avoid EDR beacon-pattern detection (Arctic Wolf). */
const POLL_INTERVAL_BASE_MS = 150_000;
const POLL_JITTER_MS = 30_000;
/** New message drain interval — 10s + jitter (observer-based, lightweight). */
const MSG_DRAIN_BASE_MS = 10_000;
const MSG_DRAIN_JITTER_MS = 3_000;
const RECONNECT_DELAY_MS = 30_000;

/** Add random jitter to an interval to break beacon patterns. */
function jitteredInterval(baseMs: number, jitterMs: number): number {
  return baseMs + Math.floor(Math.random() * jitterMs);
}

/**
 * JS to inject into Teams v2 context for extracting chat data.
 *
 * Teams v2 (WebView2 / Fluent UI) renders the chat sidebar as a Tree:
 *   div.fui-TreeItem[role="treeitem"]  ← group headers (Favorites, Chats, Meetings, Teams)
 *     └── div[role="group"]
 *           └── div.fui-TreeItem[role="treeitem"]  ← actual chat entries (leaf items)
 *
 * Chat entries have:
 *   - id="menurXX" — unique identifier for clicking/navigation
 *   - Text content = chat/person name (no preview or timestamp in the tree)
 *   - Class `___c3kee90` on the currently selected chat (vs `___fp7qlp0` for others)
 *   - No data-tid attributes at all
 */
const JS_EXTRACT_CHATS = String.raw`
(function() {
  try {
    var NAV_SKIP = ['Copilot','Mentions','Followed threads','Unread','Channels','See more','See all your teams'];
    var chats = [];

    // Find all group containers in the sidebar tree
    var groups = document.querySelectorAll('[role="group"]');
    for (var g = 0; g < groups.length; g++) {
      var groupEl = groups[g];
      // The group header is the parent treeitem — extract the section name
      var parentTreeItem = groupEl.closest('[role="treeitem"]');
      var sectionName = '';
      if (parentTreeItem) {
        var layout = parentTreeItem.querySelector(':scope > .fui-TreeItemLayout');
        if (layout) sectionName = layout.textContent.trim();
      }

      // Get leaf treeitems inside this group
      var items = groupEl.querySelectorAll(':scope > [role="treeitem"]');
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        // Skip if this item itself contains a group (it's a nested group header, not a chat)
        if (el.querySelector('[role="group"]')) continue;

        var rawText = el.innerText ? el.innerText.trim() : (el.textContent ? el.textContent.trim() : '');
        var lines = rawText.split(/\n+/).map(function(line) { return line.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
        var flatText = rawText.replace(/\s+/g, ' ').trim();
        var timeMatch = flatText.match(/(\d{1,2}:\d{2}\s?(AM|PM)|\d{1,2}\/\d{1,2}|Yesterday|Today)/i);
        var name = lines[0] || flatText;
        var lastMessageTime = '';
        var lastMessage = '';
        if (lines.length >= 2) {
          lastMessageTime = lines[1] || '';
          lastMessage = lines.slice(2).join(' ').trim();
        } else if (timeMatch && typeof timeMatch.index === 'number') {
          name = flatText.slice(0, timeMatch.index).trim();
          lastMessageTime = timeMatch[1] || '';
          lastMessage = flatText.slice(timeMatch.index + timeMatch[0].length).trim();
        }
        // Skip navigation items and "See more" buttons
        if (!name || NAV_SKIP.indexOf(name) >= 0) continue;

        var chatType = '1:1';
        if (sectionName === 'Meetings' || sectionName.indexOf('Meeting') >= 0) chatType = 'meeting';
        else if (name.indexOf(',') >= 0 || name.indexOf(' and ') >= 0) chatType = 'group';
        else if (sectionName.indexOf('Teams') >= 0 || sectionName.indexOf('channel') >= 0) chatType = 'channel';

        // Check if this is the currently active/selected chat
        var isActive = el.className.indexOf('c3kee9') >= 0 || el.className.indexOf('ferormf') >= 0;

        chats.push({
          id: el.id || 'chat-' + g + '-' + i,
          topic: name,
          lastMessage: lastMessage,
          lastMessageTime: lastMessageTime,
          unreadCount: 0,
          chatType: chatType,
          participants: [],
          section: sectionName,
          isActive: isActive
        });
      }
    }

    return JSON.stringify(chats);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

/**
 * JS to extract messages from the currently open chat.
 *
 * Teams v2 (Fluent UI) message structure:
 *   .fui-ChatMessage — wrapper with author name + timestamp (other people's messages)
 *     [data-tid="message-author-name"] — sender display name
 *     [data-tid="chat-pane-message"] — message body (class fui-ChatMessage__body)
 *       div[data-message-content] — actual text (aria-label has full text)
 *
 *   [data-tid="chat-pane-message"].fui-ChatMyMessage__body — MY messages (no .fui-ChatMessage wrapper)
 *     div[data-message-content] — actual text
 *
 *   Timestamps are in aria-label on elements like "Today at 3:57 PM."
 */
const JS_EXTRACT_MESSAGES = String.raw`
(function() {
  try {
    // Find all message body elements
    var msgBodies = document.querySelectorAll('[data-tid="chat-pane-message"]');
    if (msgBodies.length === 0) return JSON.stringify([]);

    var msgs = Array.from(msgBodies).slice(-100).map(function(el, i) {
      // Determine if this is my message or someone else's
      var isFromMe = el.className.indexOf('ChatMyMessage') >= 0;

      // Get message content from the data-message-content div
      var contentEl = el.querySelector('[data-message-content]');
      var content = '';
      if (contentEl) {
        content = contentEl.getAttribute('aria-label') || contentEl.textContent || '';
        content = content.trim();
      } else {
        content = el.textContent ? el.textContent.trim() : '';
      }

      // Get sender — look up the DOM for .fui-ChatMessage wrapper
      var sender = '';
      if (isFromMe) {
        sender = 'Me';
      } else {
        // Walk up to find .fui-ChatMessage parent which has the author
        var parent = el.parentElement;
        for (var d = 0; d < 5 && parent; d++) {
          var authorEl = parent.querySelector('[data-tid="message-author-name"]');
          if (authorEl) {
            sender = authorEl.textContent ? authorEl.textContent.trim() : '';
            break;
          }
          if (parent.classList && parent.classList.contains('fui-ChatMessage')) break;
          parent = parent.parentElement;
        }
        if (!sender) sender = 'Unknown';
      }

      // Get timestamp — look for aria-label with time pattern on ancestors
      var timestamp = '';
      var walker = el.parentElement;
      for (var t = 0; t < 5 && walker; t++) {
        var ariaLabel = walker.getAttribute ? walker.getAttribute('aria-label') : '';
        if (ariaLabel && /\\d{1,2}:\\d{2}/.test(ariaLabel)) {
          timestamp = ariaLabel.trim();
          break;
        }
        // Also check children for time labels
        var timeEls = walker.querySelectorAll('[aria-label]');
        for (var te = 0; te < timeEls.length; te++) {
          var tl = timeEls[te].getAttribute('aria-label') || '';
          if (/\\d{1,2}:\\d{2}/.test(tl) && tl.length < 50) {
            timestamp = tl.trim().replace(/\\.$/, '');
            break;
          }
        }
        if (timestamp) break;
        walker = walker.parentElement;
      }

      // Get message ID from the content element
      var id = (contentEl ? contentEl.id : '') || ('msg-' + i);

      return {
        id: id,
        sender: sender,
        content: content.substring(0, 2000),
        timestamp: timestamp || new Date().toISOString(),
        isFromMe: isFromMe,
        type: 'message',
        hasAttachments: !!el.querySelector('[data-tid*="attachment"], .file-card, [data-tid*="file"]'),
      };
    });

    return JSON.stringify(msgs);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

/** JS to send a message — uses CKEditor 5 instance API to type into compose box and triggers send. */
function jsSendMessage(text: string): string {
  // Escape text for safe injection
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `
(async function() {
  try {
    // Teams v2 uses CKEditor 5 with data-tid="ckeditor" on the compose div
    var compose = document.querySelector('[data-tid="ckeditor"]');
    if (!compose) {
      // Fallback selectors for older Teams versions
      compose = document.querySelector('[role="textbox"][aria-label*="message"], [role="textbox"][aria-label*="Type"], [contenteditable="true"]');
    }
    if (!compose) return JSON.stringify({ success: false, error: 'Could not find compose box. Make sure a chat is open.' });

    compose.focus();

    // Use CKEditor 5 instance API (Teams v2 exposes ckeditorInstance on the DOM element)
    var editor = compose.ckeditorInstance;
    if (editor && typeof editor.execute === 'function') {
      // CKEditor 5: use the input command which properly updates the model
      editor.execute('input', { text: '${escaped}' });
    } else {
      // Fallback for non-CKEditor: try clipboard paste
      var dt = new DataTransfer();
      dt.setData('text/plain', '${escaped}');
      compose.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }

    // Wait for CKEditor to process the input
    await new Promise(r => setTimeout(r, 400));

    // Find and click the send button
    var sendBtn = document.querySelector('[data-tid="newMessageCommands-send"], button[aria-label*="Send"], button[data-tid*="send"]');
    if (sendBtn) {
      sendBtn.click();
      return JSON.stringify({ success: true });
    }

    // Fallback: Ctrl+Enter (Teams v2 default shortcut)
    compose.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
    return JSON.stringify({ success: true, method: 'ctrl-enter' });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
})()
`;
}

/** JS to navigate to a specific chat by clicking it.
 *  Teams v2: chat items have id="menurXX". We also support matching by name text.
 */
function jsNavigateToChat(chatId: string): string {
  const escaped = chatId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `
(function() {
  try {
    // 1. Try direct ID match
    var item = document.getElementById('${escaped}');
    if (item) {
      item.click();
      return JSON.stringify({ success: true, method: 'id' });
    }

    // 2. Try matching by chat name text in leaf treeitems
    var allItems = document.querySelectorAll('[role="group"] > [role="treeitem"]');
    for (var i = 0; i < allItems.length; i++) {
      var el = allItems[i];
      if (el.querySelector('[role="group"]')) continue; // skip group headers
      var name = el.textContent ? el.textContent.trim() : '';
      if (name === '${escaped}' || name.toLowerCase().indexOf('${escaped}'.toLowerCase()) >= 0) {
        el.click();
        return JSON.stringify({ success: true, method: 'name-match', matched: name });
      }
    }

    return JSON.stringify({ success: false, error: 'Chat not found: ${escaped}' });
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
})()
`;
}

/** JS to get the logged-in user's name from Teams v2. */
const JS_GET_USER_INFO = String.raw`
(function() {
  try {
    // Teams v2: me-control uses data-tid="me-control-avatar-trigger" or the avatar button
    var avatar = document.querySelector('[data-tid="me-control-avatar-trigger"], [data-tid="me-control-avatar"], [data-tid="app-bar-me-button"]');
    var name = '';
    if (avatar) {
      name = avatar.getAttribute('aria-label') || avatar.textContent || '';
      name = name.trim();
    }
    var title = document.title || '';
    return JSON.stringify({ name: name, title: title });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

/** JS to install a MutationObserver for new messages (Teams v2). */
const JS_INSTALL_OBSERVER = String.raw`
(function() {
  if (window.__prismTeamsObserver) return JSON.stringify({ installed: true, existing: true });

  window.__prismTeamsNewMessages = [];

  // Teams v2: the message pane is [role="main"] or the closest scrollable ancestor
  var container = document.querySelector('[role="main"], [data-tid="message-pane-list-container"]');
  if (!container) return JSON.stringify({ installed: false, error: 'Message container not found' });

  window.__prismTeamsObserver = new MutationObserver(function(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var added = mutations[m].addedNodes;
      for (var n = 0; n < added.length; n++) {
        var node = added[n];
        if (node.nodeType !== 1) continue;
        // Look for message-like content (contains text, has some structure)
        var text = node.textContent ? node.textContent.trim() : '';
        if (text.length < 2) continue;
        // Skip trivial UI updates
        if (node.matches && (node.matches('[role="treeitem"]') || node.matches('.fui-TreeItem'))) continue;

        window.__prismTeamsNewMessages.push({
          id: 'new-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          sender: 'Unknown',
          content: text.substring(0, 500),
          timestamp: new Date().toISOString(),
          isFromMe: false,
          type: 'message',
          hasAttachments: false
        });
      }
    }
  });

  window.__prismTeamsObserver.observe(container, { childList: true, subtree: true });
  return JSON.stringify({ installed: true });
})()
`;

/** JS to drain queued new messages from the observer. */
const JS_DRAIN_NEW_MESSAGES = String.raw`
(function() {
  const msgs = window.__prismTeamsNewMessages || [];
  window.__prismTeamsNewMessages = [];
  return JSON.stringify(msgs);
})()
`;

/**
 * JS to extract meeting transcript from the current chat.
 *
 * Teams embeds transcripts in several ways:
 * 1. Inline transcript card in the meeting chat thread
 * 2. "Transcript" tab in the meeting details pane
 * 3. Recap/Intelligent recap card with meeting notes
 *
 * We try all approaches and return whatever we find.
 */
const JS_EXTRACT_TRANSCRIPT = String.raw`
(async function() {
  try {
    const result = { success: false, transcript: '', meetingTitle: '', error: '' };

    // Get the meeting/chat title
    const headerEl = document.querySelector('[data-tid="chat-header-title"], .chat-title, [data-tid="conversation-header"] h2');
    result.meetingTitle = headerEl?.textContent?.trim() || document.title || 'Unknown Meeting';

    // Strategy 1: Look for inline transcript card in chat messages
    const transcriptCards = document.querySelectorAll(
      '[data-tid*="transcript"], [data-tid*="meeting-recap"], [data-tid*="meeting-notes"], ' +
      '.transcript-container, .meeting-recap-card, [aria-label*="transcript"], [aria-label*="Transcript"]'
    );

    if (transcriptCards.length > 0) {
      const texts = [];
      for (const card of transcriptCards) {
        // Click to expand if needed
        const expandBtn = card.querySelector('button[aria-expanded="false"], [data-tid*="expand"]');
        if (expandBtn) {
          expandBtn.click();
          await new Promise(r => setTimeout(r, 1000));
        }
        const text = card.textContent?.trim();
        if (text && text.length > 50) texts.push(text);
      }
      if (texts.length > 0) {
        result.success = true;
        result.transcript = texts.join('\\n\\n---\\n\\n');
        return JSON.stringify(result);
      }
    }

    // Strategy 2: Look for the Transcript tab and click it
    const tabs = document.querySelectorAll('[role="tab"], [data-tid*="tab"]');
    let transcriptTab = null;
    for (const tab of tabs) {
      const label = (tab.textContent || tab.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('transcript') || label.includes('recap')) {
        transcriptTab = tab;
        break;
      }
    }

    if (transcriptTab) {
      transcriptTab.click();
      await new Promise(r => setTimeout(r, 2000));

      // Now read the transcript content from the tab panel
      const panel = document.querySelector(
        '[role="tabpanel"], .transcript-panel, [data-tid*="transcript-content"], ' +
        '.meeting-transcript-container'
      );
      if (panel) {
        const lines = panel.querySelectorAll('.transcript-line, [data-tid*="transcript-entry"], p, li');
        if (lines.length > 0) {
          const entries = Array.from(lines).map(line => line.textContent?.trim()).filter(Boolean);
          result.success = true;
          result.transcript = entries.join('\\n');
          return JSON.stringify(result);
        }
        // Fallback: raw text
        const rawText = panel.textContent?.trim();
        if (rawText && rawText.length > 100) {
          result.success = true;
          result.transcript = rawText;
          return JSON.stringify(result);
        }
      }
    }

    // Strategy 3: Scan all messages for embedded transcript/recap content
    const allMessages = document.querySelectorAll('[data-tid*="message"], [role="listitem"]');
    const transcriptMsgs = [];
    for (const msg of allMessages) {
      const text = msg.textContent || '';
      // Meeting recaps and transcripts often contain speaker labels with timestamps
      if (text.match(/\\d{1,2}:\\d{2}\\s*(AM|PM)?.*?:/i) || text.includes('Transcript') || text.includes('Meeting notes')) {
        transcriptMsgs.push(text.trim().substring(0, 2000));
      }
    }
    if (transcriptMsgs.length > 0) {
      result.success = true;
      result.transcript = transcriptMsgs.join('\\n\\n');
      return JSON.stringify(result);
    }

    result.error = 'No transcript found in current chat. Navigate to a meeting chat that has a transcript.';
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ success: false, error: e.message });
  }
})()
`;

/** Lightweight DOM probe used to score candidate Teams CDP targets. */
const JS_PROBE_TARGET = String.raw`
(function() {
  try {
    var bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    return JSON.stringify({
      title: document.title || '',
      href: location.href || '',
      textLength: bodyText.length,
      treeItems: document.querySelectorAll('[role="treeitem"]').length,
      groups: document.querySelectorAll('[role="group"]').length,
      messageBodies: document.querySelectorAll('[data-tid="chat-pane-message"]').length,
      textboxes: document.querySelectorAll('[data-tid="ckeditor"], [role="textbox"]').length,
      hasMainArea: !!document.querySelector('[role="main"], [data-tid="app-layout-area--main"]'),
      hasChatHeader: !!document.querySelector('[data-tid="chat-header-title"], [data-tid="conversation-header"], h2'),
    });
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

interface CDPTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

export class TeamsBridge {
  private win: BrowserWindow | null = null;
  private ws: WebSocket | null = null;
  private status: TeamsBridgeStatus = 'disconnected';
  private targetUrl = '';
  private userName = '';
  private msgId = 0;
  private pendingCallbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private cachedChats: TeamsChat[] = [];
  private lastPoll = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private newMessagePollTimer: ReturnType<typeof setTimeout> | null = null;

  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async connect(): Promise<TeamsBridgeInfo> {
    if (this.ws && this.status === 'connected') {
      return this.getInfo();
    }

    this.setStatus('connecting');

    try {
      // Discover CDP targets
      const targets = await this.discoverTargets();
      if (targets.length === 0) {
        this.setStatus('error');
        return {
          ...this.getInfo(),
          error: 'No CDP targets found. Ensure Teams is running and was restarted after adding the registry key.',
        };
      }

      // Find the Teams chat page with actual content.
      // Teams v2 has multiple page targets at the same URL — the shell (empty, ~50 elements)
      // and the active chat view (2000+ elements, title starts with "Chat |").
      // We must pick the content-rich one, not the shell.
      const teamsPages = targets.filter(
        (t) => t.type === 'page' && (t.url.includes('teams.microsoft.com') || t.url.includes('teams.live.com'))
      );
      const chatTarget = await this.selectBestTeamsTarget(teamsPages, targets);

      console.log('[TeamsBridge] Selected target:', chatTarget?.title, '|', chatTarget?.url?.substring(0, 80));

      if (!chatTarget) {
        this.setStatus('error');
        return {
          ...this.getInfo(),
          error: `Found ${targets.length} CDP targets but none matched Teams. URLs: ${targets.map(t => t.url).join(', ')}`,
        };
      }

      this.targetUrl = chatTarget.url;
      await this.connectWebSocket(chatTarget.webSocketDebuggerUrl);
      await this.waitForTargetContent();

      // Get user info
      try {
        const userInfo = await this.evaluate(JS_GET_USER_INFO);
        if (typeof userInfo === 'string') {
          const parsed = JSON.parse(userInfo);
          if (parsed && typeof parsed === 'object' && 'name' in parsed) {
            this.userName = parsed.name || '';
          }
        }
      } catch { /* non-critical */ }

      // Install message observer
      try {
        await this.evaluate(JS_INSTALL_OBSERVER);
      } catch { /* non-critical, may fail if chat not open */ }

      // Start polling
      this.startPolling();

      this.setStatus('connected');
      return this.getInfo();
    } catch (err: any) {
      this.setStatus('error');
      return {
        ...this.getInfo(),
        error: err.message,
      };
    }
  }

  disconnect() {
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    // Reject all pending
    for (const [, cb] of this.pendingCallbacks) {
      clearTimeout(cb.timer);
      cb.reject(new Error('Disconnected'));
    }
    this.pendingCallbacks.clear();
    this.setStatus('disconnected');
  }

  getInfo(): TeamsBridgeInfo {
    return {
      status: this.status,
      cdpConnected: this.ws?.readyState === WebSocket.OPEN,
      targetUrl: this.targetUrl,
      userName: this.userName || undefined,
      chatCount: this.cachedChats.length || undefined,
      lastPoll: this.lastPoll || undefined,
    };
  }

  // ── Chat Operations ────────────────────────────────────────

  async getChats(limit = 50): Promise<TeamsChat[]> {
    let result = await this.evaluate(JS_EXTRACT_CHATS);
    if (!result || typeof result !== 'string') {
      await this.waitForTargetContent();
      result = await this.evaluate(JS_EXTRACT_CHATS);
    }
    if (!result || typeof result !== 'string') return this.cachedChats;

    try {
      const parsed = JSON.parse(result as string);
      if (Array.isArray(parsed)) {
        this.cachedChats = parsed.slice(0, limit).map((c: any) => ({
          id: c.id || '',
          topic: c.topic || '',
          chatType: c.chatType || '1:1',
          lastMessage: c.lastMessage || '',
          lastMessageTime: c.lastMessageTime || '',
          unreadCount: c.unreadCount || 0,
          participants: c.participants || [],
        }));
        this.lastPoll = Date.now();
        return this.cachedChats;
      }
      if (parsed.error) {
        console.warn('[TeamsBridge] Chat extraction error:', parsed.error);
      }
    } catch (e: any) {
      console.warn('[TeamsBridge] Failed to parse chats:', e.message);
    }
    return this.cachedChats;
  }

  async getMessages(chatId: string, limit = 100): Promise<TeamsMessage[]> {
    // First navigate to the chat
    const navResult = await this.evaluate(jsNavigateToChat(chatId));
    if (navResult) {
      try {
        const nav = JSON.parse(navResult as string);
        if (!nav.success) {
          console.warn('[TeamsBridge] Failed to navigate to chat:', nav.error);
        }
      } catch { /* ignore */ }
    }

    // Wait for messages to load
    await new Promise((r) => setTimeout(r, 500));

    // Refocus Prism — the CDP click on the Teams DOM activates the Teams window
    this.refocusPrism();

    // Extract messages
    const result = await this.evaluate(JS_EXTRACT_MESSAGES);
    if (!result || typeof result !== 'string') return [];

    try {
      const parsed = JSON.parse(result as string);
      if (Array.isArray(parsed)) {
        return parsed.slice(-limit).map((m: any) => ({
          id: m.id || '',
          chatId,
          sender: m.sender || 'Unknown',
          senderEmail: m.senderEmail,
          content: m.content || '',
          htmlContent: m.htmlContent,
          timestamp: m.timestamp || new Date().toISOString(),
          isFromMe: m.isFromMe || false,
          type: m.type || 'message',
          reactions: m.reactions,
          hasAttachments: m.hasAttachments || false,
        }));
      }
    } catch (e: any) {
      console.warn('[TeamsBridge] Failed to parse messages:', e.message);
    }
    return [];
  }

  async sendMessage(chatId: string, text: string): Promise<TeamsSendResult> {
    // Navigate to chat first
    await this.evaluate(jsNavigateToChat(chatId));
    await new Promise((r) => setTimeout(r, 500));

    // Refocus Prism before sending — the navigation click activates Teams
    this.refocusPrism();

    const result = await this.evaluate(jsSendMessage(text));
    if (!result || typeof result !== 'string') {
      return { success: false, error: 'No response from Teams context' };
    }
    try {
      const parsed = JSON.parse(result as string) as TeamsSendResult;
      if (!parsed.success) {
        return parsed;
      }

      const normalizedText = text.trim().replace(/\s+/g, ' ');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const messages = await this.getMessages(chatId, 10);
        const matched = messages.some((message) =>
          message.isFromMe &&
          message.content.trim().replace(/\s+/g, ' ') === normalizedText
        );
        if (matched) {
          return { success: true, verified: true };
        }
      }

      return {
        success: true,
        verified: false,
        warning: 'Message submission was attempted, but send verification was not observed yet in Teams.',
      };
    } catch {
      return { success: false, error: 'Failed to parse send result' };
    }
  }

  async searchChats(query: string): Promise<TeamsChat[]> {
    const all = this.cachedChats.length > 0 ? this.cachedChats : await this.getChats();
    const q = query.toLowerCase();
    return all.filter(
      (c) => c.topic.toLowerCase().includes(q) ||
        c.lastMessage?.toLowerCase().includes(q) ||
        c.participants.some((p) => p.name.toLowerCase().includes(q))
    );
  }

  /**
   * Extract a meeting transcript from Teams.
   *
   * Teams stores meeting transcripts in the meeting chat thread.
   * When a meeting has a transcript, there's a "Transcript" tab or a
   * transcript card in the chat. We inject JS to find and extract it.
   *
   * The caller can specify a meeting chat by name (e.g., "MDM Sync")
   * and we'll navigate to it and pull the transcript text.
   */
  async getMeetingTranscript(meetingChatName?: string): Promise<{
    success: boolean;
    transcript?: string;
    meetingTitle?: string;
    error?: string;
  }> {
    if (this.status !== 'connected') {
      return { success: false, error: 'Teams CDP bridge not connected' };
    }

    try {
      // If a meeting name is provided, navigate to that chat first
      if (meetingChatName) {
        const navResult = await this.evaluate(jsNavigateToChat(meetingChatName));
        if (!navResult || navResult.includes('error')) {
          return { success: false, error: `Could not find meeting chat: ${meetingChatName}` };
        }
        // Wait for navigation to settle
        await new Promise((r) => setTimeout(r, 2000));
        this.refocusPrism();
      }

      // Extract transcript content from the current chat
      const result = await this.evaluate(JS_EXTRACT_TRANSCRIPT);
      if (!result) return { success: false, error: 'No transcript data returned' };

      try {
        const parsed = JSON.parse(result);
        return parsed;
      } catch {
        return { success: false, error: 'Failed to parse transcript data' };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Get all available meeting transcripts from recent meeting chats.
   * Scans visible chats for meeting-type entries that may have transcripts.
   */
  async listMeetingTranscripts(): Promise<Array<{
    chatId: string;
    meetingTitle: string;
    date?: string;
    hasTranscript: boolean;
  }>> {
    const chats = this.cachedChats.length > 0 ? this.cachedChats : await this.getChats();
    // Filter for actual meeting chats first, then fall back to topic heuristics.
    return chats
      .filter((c) =>
        c.chatType === 'meeting' ||
        (
          c.chatType !== 'channel' &&
          (c.topic.toLowerCase().includes('meeting') ||
           c.topic.toLowerCase().includes('sync') ||
           c.topic.toLowerCase().includes('standup') ||
           c.topic.toLowerCase().includes('review') ||
           c.topic.toLowerCase().includes('1:1') ||
           c.topic.toLowerCase().includes('catchup') ||
           c.topic.toLowerCase().includes('retro') ||
           c.topic.toLowerCase().includes('planning'))
        )
      )
      .slice(0, 20)
      .map((c) => ({
        chatId: c.id,
        meetingTitle: c.topic,
        date: c.lastMessageTime,
        hasTranscript: true, // We can't confirm without navigating — assume possible
      }));
  }

  async getContextSummary(): Promise<string> {
    if (this.status !== 'connected') {
      return '[TEAMS] Not connected. Restart Teams with CDP enabled.';
    }

    const chats = this.cachedChats.length > 0 ? this.cachedChats : await this.getChats();
    if (chats.length === 0) return '[TEAMS] Connected but no chats visible.';

    const unreadChats = chats.filter((c) => c.unreadCount > 0);
    const lines = chats.slice(0, 15).map((c) => {
      const unread = c.unreadCount > 0 ? ` [${c.unreadCount} UNREAD]` : '';
      return `• ${c.topic}${unread} — ${c.lastMessage?.substring(0, 100) || 'No preview'} (${c.lastMessageTime || '?'})`;
    });

    return `[TEAMS CONTEXT — ${unreadChats.length} unread chats, ${chats.length} visible]\n${lines.join('\n')}`;
  }

  // ── CDP Internals ─────────────────────────────────────────

  private async discoverTargets(): Promise<CDPTarget[]> {
    return new Promise((resolve) => {
      console.log('[TeamsBridge] Discovering CDP targets at', CDP_DISCOVERY_URL);
      const req = http.get(CDP_DISCOVERY_URL, (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            console.log(`[TeamsBridge] Found ${targets.length} CDP targets`);
            resolve(targets);
          } catch (e: any) {
            console.error('[TeamsBridge] Failed to parse CDP response:', e.message, 'raw:', data.substring(0, 200));
            resolve([]);
          }
        });
      });
      req.on('error', (err: any) => {
        console.error('[TeamsBridge] CDP discovery request failed:', err.message);
        resolve([]);
      });
      req.setTimeout(5000, () => {
        console.error('[TeamsBridge] CDP discovery request timed out');
        req.destroy();
        resolve([]);
      });
    });
  }

  private async selectBestTeamsTarget(teamsPages: CDPTarget[], allTargets: CDPTarget[]): Promise<CDPTarget | undefined> {
    const scoredTargets = await Promise.all(teamsPages.map(async (target) => ({
      target,
      score: await this.probeTargetScore(target),
    })));

    const best = scoredTargets
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0];

    if (best) {
      console.log(
        '[TeamsBridge] Target scores:',
        scoredTargets.map((entry) => `${entry.target.title || '(untitled)'}=${entry.score}`).join(' | ')
      );
      return best.target;
    }

    const nonCalendarTeamsPages = teamsPages.filter((t) => !/calendar/i.test(t.title || ''));
    return (
      teamsPages.find((t) => t.title.startsWith('Chat ')) ||
      teamsPages.find((t) => t.url.includes('#deepLink=default')) ||
      (nonCalendarTeamsPages.length > 0
        ? nonCalendarTeamsPages.reduce((a, b) => a.title.trim().length <= b.title.trim().length ? a : b)
        : undefined) ||
      (teamsPages.length > 1
        ? teamsPages.reduce((a, b) => a.title.length > b.title.length ? a : b)
        : teamsPages[0]) ||
      allTargets.find((t) => t.type === 'page' && !t.url.startsWith('about:'))
    );
  }

  private async probeTargetScore(target: CDPTarget): Promise<number> {
    let ws: WebSocket | null = null;
    let msgId = 0;
    const pendingCallbacks = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    const close = () => {
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    };

    try {
      const result = await new Promise<string | null>((resolve, reject) => {
        ws = new WebSocket(target.webSocketDebuggerUrl);
        const timeout = setTimeout(() => {
          pendingCallbacks.clear();
          close();
          reject(new Error('Target probe timeout'));
        }, 4_000);

        ws.on('open', () => {
          const id = ++msgId;
          pendingCallbacks.set(id, { resolve, reject });
          ws?.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: {
              expression: JS_PROBE_TARGET,
              awaitPromise: true,
              returnByValue: true,
            },
          }));
        });

        ws.on('message', (data: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.id && pendingCallbacks.has(msg.id)) {
              const callback = pendingCallbacks.get(msg.id)!;
              pendingCallbacks.delete(msg.id);
              clearTimeout(timeout);
              close();
              if (msg.error) {
                callback.reject(new Error(msg.error.message || 'CDP probe error'));
              } else {
                callback.resolve(msg.result?.result?.value ?? null);
              }
            }
          } catch (err: any) {
            clearTimeout(timeout);
            close();
            reject(err);
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timeout);
          close();
          reject(err);
        });

        ws.on('close', () => {
          clearTimeout(timeout);
        });
      });

      if (!result) return 0;

      const parsed = JSON.parse(result);
      if (parsed?.error) return 0;

      const textLength = Number(parsed.textLength || 0);
      const treeItems = Number(parsed.treeItems || 0);
      const groups = Number(parsed.groups || 0);
      const messageBodies = Number(parsed.messageBodies || 0);
      const textboxes = Number(parsed.textboxes || 0);
      const mainAreaBoost = parsed.hasMainArea ? 500 : 0;
      const chatHeaderBoost = parsed.hasChatHeader ? 200 : 0;

      return (
        treeItems * 120 +
        groups * 75 +
        messageBodies * 60 +
        textboxes * 40 +
        Math.min(textLength, 10_000) +
        mainAreaBoost +
        chatHeaderBoost
      );
    } catch (err: any) {
      console.warn('[TeamsBridge] Target probe failed:', target.title, err.message);
      return 0;
    } finally {
      close();
    }
  }

  private async connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 10_000);

      ws.on('open', () => {
        clearTimeout(timeout);
        this.ws = ws;
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pendingCallbacks.has(msg.id)) {
            const cb = this.pendingCallbacks.get(msg.id)!;
            this.pendingCallbacks.delete(msg.id);
            clearTimeout(cb.timer);
            if (msg.error) {
              cb.reject(new Error(msg.error.message || 'CDP error'));
            } else {
              cb.resolve(msg.result);
            }
          }
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        this.ws = null;
        if (this.status === 'connected') {
          this.setStatus('disconnected');
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.ws) reject(err);
      });
    });
  }

  private async waitForTargetContent(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const probe = await this.evaluate(JS_PROBE_TARGET);
      if (typeof probe === 'string') {
        try {
          const parsed = JSON.parse(probe);
          const textLength = Number(parsed?.textLength || 0);
          const treeItems = Number(parsed?.treeItems || 0);
          const messageBodies = Number(parsed?.messageBodies || 0);
          if (textLength > 250 || treeItems > 0 || messageBodies > 0) {
            return;
          }
        } catch {
          /* ignore transient parse failures */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  private async cdpSend(method: string, params?: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP not connected');
    }

    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, 15_000);

      this.pendingCallbacks.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate JavaScript in the Teams context. Returns the string value. */
  private async evaluate(expression: string): Promise<string | null> {
    try {
      const result = await this.cdpSend('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result?.result?.value ?? null;
    } catch (err: any) {
      console.warn('[TeamsBridge] Evaluate failed:', err.message);
      return null;
    }
  }

  // ── Polling & Events ──────────────────────────────────────

  private startPolling() {
    this.stopPolling();

    // Poll chats with jittered interval to avoid EDR beacon-pattern detection
    const scheduleChatPoll = () => {
      this.pollTimer = setTimeout(async () => {
        try {
          await this.getChats();
        } catch (e: any) {
          console.warn('[TeamsBridge] Chat poll error:', e.message);
        }
        scheduleChatPoll(); // Schedule next with fresh jitter
      }, jitteredInterval(POLL_INTERVAL_BASE_MS, POLL_JITTER_MS));
    };
    scheduleChatPoll();

    // Drain new messages from MutationObserver (lightweight — just reads a JS var)
    const scheduleMsgDrain = () => {
      this.newMessagePollTimer = setTimeout(async () => {
        try {
          const result = await this.evaluate(JS_DRAIN_NEW_MESSAGES);
          if (result) {
            const msgs = JSON.parse(result);
            if (Array.isArray(msgs)) {
              for (const msg of msgs) {
                this.emit('teams:new-message', {
                  ...msg,
                  chatId: '',
                });
              }
            }
          }
        } catch { /* ignore */ }
        scheduleMsgDrain();
      }, jitteredInterval(MSG_DRAIN_BASE_MS, MSG_DRAIN_JITTER_MS));
    };
    scheduleMsgDrain();
  }

  private stopPolling() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.newMessagePollTimer) { clearTimeout(this.newMessagePollTimer); this.newMessagePollTimer = null; }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log('[TeamsBridge] Attempting reconnect...');
      try {
        await this.connect();
      } catch (e: any) {
        console.warn('[TeamsBridge] Reconnect failed:', e.message);
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  private setStatus(status: TeamsBridgeStatus) {
    this.status = status;
    this.emit('teams:status-change', this.getInfo());
  }

  /** Refocus Prism's window after CDP operations that activate the Teams window. */
  private refocusPrism() {
    if (this.win && !this.win.isDestroyed()) {
      // Small delay to let Teams finish its focus grab, then steal it back
      setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) {
          this.win.focus();
        }
      }, 100);
    }
  }

  private emit(channel: string, data: any) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, data);
    }
  }
}
