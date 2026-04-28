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
  rawMessage?: Buffer;
}

export interface DraftResult {
  uid?: number;
  folder: string;
  success: boolean;
}

// --- Calendar types (v2) ---

export interface TimezoneAwareTime {
  utc: string; // ISO 8601 UTC (Z suffix) — the canonical instant
  timezone: string; // IANA timezone (e.g., "Australia/Melbourne")
}

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
  start: TimezoneAwareTime;
  end: TimezoneAwareTime;
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

export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type RecurrenceWeekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface RecurrenceInput {
  frequency: RecurrenceFrequency;
  interval?: number; // default 1
  endType: "never" | "after" | "on";
  count?: number; // required when endType="after"
  until?: string; // required when endType="on"; ISO local date or datetime
  byWeekday?: RecurrenceWeekday[]; // WEEKLY only
}

export interface CreateEventInput {
  summary: string;
  start: string; // ISO 8601 local time (no Z suffix when timezone provided)
  end: string; // ISO 8601 local time (no Z suffix when timezone provided)
  timezone?: string; // IANA timezone — resolved via cascade if omitted
  location?: string;
  description?: string;
  attendees?: string[]; // email addresses
  isAllDay?: boolean;
  calendar?: string; // display name or URL, default: first VEVENT calendar
  recurrence?: RecurrenceInput;
}

// --- Reminders types (v3) ---
//
// Reminders are CalDAV VTODO objects. iCloud exposes them through the same CalDAV
// endpoint as calendar events, but on calendars whose `components` array contains
// "VTODO" (or includes both "VEVENT" and "VTODO" — iCloud is inconsistent here).
//
// Apple's iOS 13+ Reminders introduced features (smart lists, nested subtasks,
// location triggers, attachments) that are NOT exposed via CalDAV. v3 ships
// VTODO-basic only; smart list / subtask access is deferred to v4 pending an
// Apple Developer cert for EventKit (see TODOS.md and eventkit-cli/spike/).

export interface ReminderListInfo {
  displayName: string;
  url: string;
  color?: string;
  ctag?: string;
  description?: string;
}

export interface Reminder {
  uid: string;
  summary: string; // VTODO SUMMARY — the reminder text
  description?: string;
  due?: TimezoneAwareTime; // VTODO DUE — when it's due
  isCompleted: boolean; // STATUS:COMPLETED present
  completedAt?: string; // ISO 8601 UTC — VTODO COMPLETED, set when isCompleted=true
  priority?: number; // 1-9 (1=highest, 9=lowest, 0/undefined=none)
  percentComplete?: number; // 0-100
  listUrl: string;
  listName: string;
  url: string; // CalDAV object URL for delete/update
  etag?: string; // for conditional PUT
}

export interface CreateReminderInput {
  summary: string;
  description?: string;
  due?: string; // ISO 8601 local time (no Z suffix when timezone provided)
  timezone?: string; // IANA timezone — resolved via cascade if omitted
  priority?: number; // 1-9
  list?: string; // display name or URL, default: first VTODO list
}

export interface UpdateReminderInput {
  summary?: string;
  description?: string;
  due?: string | null; // null clears the due date; undefined leaves it unchanged
  timezone?: string;
  priority?: number;
  isCompleted?: boolean; // toggling true sets STATUS:COMPLETED + COMPLETED:<now-UTC>
}
