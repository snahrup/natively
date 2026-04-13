export type BusyStatus = "free" | "tentative" | "busy" | "oof" | "working-elsewhere";
export type MeetingResponse = "accept" | "tentative" | "decline";

export interface OutlookRecipient {
  name: string;
  address: string;
}

export interface OutlookAttachment {
  filename: string;
  size: number;
}

export interface OutlookEmail {
  id: string;
  subject: string;
  from: OutlookRecipient;
  toRecipients: OutlookRecipient[];
  ccRecipients: OutlookRecipient[];
  bodyPreview: string;
  body: {
    contentType: "text" | "html";
    content: string;
  };
  receivedDateTime: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: "low" | "normal" | "high";
  flag?: {
    flagStatus: "flagged" | "notFlagged";
  };
  conversationId?: string;
  parentFolderId?: string;
  webLink?: string;
  attachments?: OutlookAttachment[];
}

export interface OutlookDraft {
  subject: string;
  body: string;
  bodyType?: "text" | "html";
  toRecipients: string[];
  ccRecipients?: string[];
  importance?: "low" | "normal" | "high";
}

export interface OutlookCalendarAttendee {
  name: string;
  email: string;
  type: "required" | "optional";
  responseStatus?: string;
}

export interface OutlookCalendarEvent {
  entryId: string;
  subject: string;
  start: string;
  end: string;
  duration: number;
  location?: string;
  body?: string;
  organizer?: string;
  busyStatus: BusyStatus;
  isRecurring?: boolean;
  allDayEvent?: boolean;
  meetingStatus?: string;
  responseStatus?: string;
  attendees: OutlookCalendarAttendee[];
  categories?: string[];
  reminder?: number;
}

export interface CalendarCreateRequest {
  subject: string;
  start: string;
  end: string;
  location?: string;
  body?: string;
  attendees?: {
    required?: string[];
    optional?: string[];
  };
  busyStatus?: BusyStatus;
  reminder?: number;
  categories?: string[];
  isMeeting?: boolean;
  send?: boolean;
}

export interface FreeBusySlot {
  start: string;
  end: string;
  status: BusyStatus;
}

export interface AvailabilityResult {
  email: string;
  freeSlots: FreeBusySlot[];
}

export interface OutlookContact {
  name: string;
  email: string;
}

export interface ComBridgeStatus {
  outlookRunning: boolean;
  comAvailable: boolean;
  userEmail?: string;
  userName?: string;
  lastPoll?: number;
  lastError?: string;
}

export type TeamsBridgeStatus = "disconnected" | "connecting" | "connected" | "error";

export interface TeamsChatParticipant {
  name: string;
  email?: string;
}

export interface TeamsChat {
  id: string;
  topic: string;
  chatType: "1:1" | "group" | "channel" | "meeting";
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  participants: TeamsChatParticipant[];
}

export interface TeamsMessage {
  id: string;
  chatId: string;
  sender: string;
  senderEmail?: string;
  content: string;
  htmlContent?: string;
  timestamp: string;
  isFromMe: boolean;
  type: "message";
  reactions?: Array<{ emoji: string; count: number }>;
  hasAttachments: boolean;
}

export interface TeamsBridgeInfo {
  status: TeamsBridgeStatus;
  cdpConnected?: boolean;
  targetUrl?: string;
  userName?: string;
  chatCount?: number;
  lastPoll?: number;
  error?: string;
}

export interface TeamsSendResult {
  success: boolean;
  error?: string;
  warning?: string;
  verified?: boolean;
}
