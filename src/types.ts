export interface EmailAddress {
  name: string;
  address: string;
}

export interface FolderInfo {
  name: string;
  path: string;
  messageCount: number;
  unseenCount: number;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: EmailAddress;
  date: string;
  flags: string[];
  hasAttachments: boolean;
}

export interface MessageFull {
  uid: number;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  date: string;
  textBody: string;
  htmlBody?: string;
  truncated: boolean;
  attachments: AttachmentInfo[];
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

export interface AttachmentInfo {
  filename: string;
  size: number;
  contentType: string;
}

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface DraftResult {
  uid?: number;
  folder: string;
  success: boolean;
}

// --- Calendar types (v2) ---

export interface ServiceProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ensureConnected(): Promise<void>;
}

export interface CalendarInfo {
  displayName: string;
  url: string;
  color?: string;
  ctag?: string;
  description?: string;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: string; // ISO 8601 UTC (Z suffix)
  end: string; // ISO 8601 UTC (Z suffix)
  location?: string;
  description?: string;
  attendees: EventAttendee[];
  status?: string; // CONFIRMED, TENTATIVE, CANCELLED
  isAllDay: boolean;
  recurrenceRule?: string; // raw RRULE for Claude to interpret
  calendarUrl: string;
  calendarName: string;
  url: string; // CalDAV object URL for delete/update
  etag?: string; // for future update_event (v3)
}

export interface EventAttendee {
  name?: string;
  email: string;
  status?: string; // ACCEPTED, DECLINED, TENTATIVE, NEEDS-ACTION
}

export interface CreateEventInput {
  summary: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  location?: string;
  description?: string;
  attendees?: string[]; // email addresses
  isAllDay?: boolean;
  calendar?: string; // display name or URL, default: first VEVENT calendar
}
