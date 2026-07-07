import { describe, expect, test } from "bun:test";
import { composeDailyBrief } from "../src/tools/cross.js";
import type { CalendarEvent, MessageSummary, Reminder } from "../src/types.js";

// ── R1 REGRESSION TEST (mandatory per /plan-eng-review) ──
//
// daily_brief is extended in v3 to include a `reminders` section. v2 callers
// must continue to see all original fields (date, displayTimezone, calendar.*,
// mail.*) with the same shapes. Adding fields is OK; removing or renaming
// breaks v2 contracts.

const sampleEvent: CalendarEvent & { startDisplay?: string; endDisplay?: string } = {
  uid: "evt-1",
  summary: "Standup",
  start: { utc: "2026-04-28T22:00:00.000Z", timezone: "Australia/Melbourne" },
  end: { utc: "2026-04-28T22:30:00.000Z", timezone: "Australia/Melbourne" },
  attendees: [],
  isAllDay: false,
  calendarUrl: "https://example.com/cal/",
  calendarName: "Work",
  url: "https://example.com/cal/evt-1.ics",
  startDisplay: "4/29/2026, 8:00:00 AM",
  endDisplay: "4/29/2026, 8:30:00 AM",
};

const sampleMessage: MessageSummary = {
  uid: 42,
  subject: "Quick question",
  from: { name: "Jane Doe", address: "jane@example.com" },
  date: "2026-04-28T15:00:00.000Z",
  flags: [],
  hasAttachments: false,
  messageId: "<sample-msg-1@example.com>",
};

const sampleReminder: Reminder = {
  uid: "rem-1",
  summary: "Buy milk",
  due: { utc: "2026-04-28T20:00:00.000Z", timezone: "Australia/Melbourne" },
  isCompleted: false,
  listUrl: "https://example.com/inbox/",
  listName: "Inbox",
  url: "https://example.com/inbox/rem-1.ics",
};

const baseInput = {
  date: "2026-04-28",
  displayTimezone: "Australia/Melbourne",
  events: [sampleEvent],
  eventCount: 1,
  nextEvent: sampleEvent,
  unreadCount: 5,
  flaggedCount: 2,
  recentMessages: [sampleMessage],
  reminders: [sampleReminder],
  overdueCount: 0,
  dueTodayCount: 1,
  reminderListCount: 3,
};

describe("R1: daily_brief shape backwards-compat (CRITICAL regression test)", () => {
  test("v2 callers see all original top-level fields", () => {
    const brief = composeDailyBrief(baseInput);
    expect(brief).toHaveProperty("date");
    expect(brief).toHaveProperty("displayTimezone");
    expect(brief).toHaveProperty("calendar");
    expect(brief).toHaveProperty("mail");
  });

  test("calendar section has all original v2 fields", () => {
    const brief = composeDailyBrief(baseInput);
    const cal = brief.calendar as Record<string, unknown>;
    expect(cal).toHaveProperty("events");
    expect(cal).toHaveProperty("eventCount");
    expect(cal).toHaveProperty("nextEvent");
    expect(Array.isArray(cal.events)).toBe(true);
    expect(typeof cal.eventCount).toBe("number");
  });

  test("mail section has all original v2 fields", () => {
    const brief = composeDailyBrief(baseInput);
    const mail = brief.mail as Record<string, unknown>;
    expect(mail).toHaveProperty("unreadCount");
    expect(mail).toHaveProperty("flaggedCount");
    expect(mail).toHaveProperty("recentMessages");
    expect(typeof mail.unreadCount).toBe("number");
    expect(typeof mail.flaggedCount).toBe("number");
    expect(Array.isArray(mail.recentMessages)).toBe(true);
  });

  test("v2 field VALUES match what was passed in (not just keys present)", () => {
    const brief = composeDailyBrief(baseInput);
    expect(brief.date).toBe("2026-04-28");
    expect(brief.displayTimezone).toBe("Australia/Melbourne");
    const cal = brief.calendar as Record<string, unknown>;
    expect(cal.eventCount).toBe(1);
    expect((cal.events as unknown[])).toHaveLength(1);
    expect(cal.nextEvent).toBe(sampleEvent);
    const mail = brief.mail as Record<string, unknown>;
    expect(mail.unreadCount).toBe(5);
    expect(mail.flaggedCount).toBe(2);
  });

  test("calendar.error appears only when calendarError is provided (v2 behavior)", () => {
    const without = composeDailyBrief(baseInput);
    expect((without.calendar as Record<string, unknown>).error).toBeUndefined();

    const withErr = composeDailyBrief({
      ...baseInput,
      calendarError: "1 calendar(s) failed to fetch",
    });
    expect((withErr.calendar as Record<string, unknown>).error).toBe(
      "1 calendar(s) failed to fetch"
    );
  });

  test("mail.error appears only when mailError is provided (v2 behavior)", () => {
    const withErr = composeDailyBrief({
      ...baseInput,
      mailError: "Mail fetch failed: ECONNRESET",
    });
    expect((withErr.mail as Record<string, unknown>).error).toBe(
      "Mail fetch failed: ECONNRESET"
    );
  });

  test("mail.replyLookupError absent when not provided (v4.3 additive)", () => {
    const brief = composeDailyBrief(baseInput);
    expect(
      (brief.mail as Record<string, unknown>).replyLookupError
    ).toBeUndefined();
  });

  test("mail.replyLookupError appears when set (v4.3 honest degradation)", () => {
    const brief = composeDailyBrief({
      ...baseInput,
      replyLookupError: "Sent folder not found",
    });
    expect((brief.mail as Record<string, unknown>).replyLookupError).toBe(
      "Sent folder not found"
    );
  });

  test("nextEvent=null when no upcoming event (v2 behavior)", () => {
    const brief = composeDailyBrief({ ...baseInput, nextEvent: null });
    expect((brief.calendar as Record<string, unknown>).nextEvent).toBeNull();
  });
});

describe("v3: reminders section additions", () => {
  test("reminders section is present", () => {
    const brief = composeDailyBrief(baseInput);
    expect(brief).toHaveProperty("reminders");
    const r = brief.reminders as Record<string, unknown>;
    expect(r).toHaveProperty("items");
    expect(r).toHaveProperty("overdueCount");
    expect(r).toHaveProperty("dueTodayCount");
    expect(r).toHaveProperty("listCount");
  });

  test("reminder items get a dueDisplay field formatted in displayTimezone", () => {
    const brief = composeDailyBrief(baseInput);
    const items = (brief.reminders as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty("dueDisplay");
    expect(items[0]!.dueDisplay).toBeTruthy();
  });

  test("reminders.error appears only when reminderError is provided", () => {
    const without = composeDailyBrief(baseInput);
    expect((without.reminders as Record<string, unknown>).error).toBeUndefined();

    const withErr = composeDailyBrief({
      ...baseInput,
      reminderError: "1 reminder list(s) failed to fetch",
    });
    expect((withErr.reminders as Record<string, unknown>).error).toBe(
      "1 reminder list(s) failed to fetch"
    );
  });

  test("undated reminder still renders cleanly (dueDisplay=null)", () => {
    const undated: Reminder = {
      ...sampleReminder,
      uid: "rem-undated",
      due: undefined,
    };
    const brief = composeDailyBrief({ ...baseInput, reminders: [undated] });
    const items = (brief.reminders as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items[0]!.dueDisplay).toBeNull();
  });

  test("empty reminders array → items=[] (not undefined)", () => {
    const brief = composeDailyBrief({
      ...baseInput,
      reminders: [],
      overdueCount: 0,
      dueTodayCount: 0,
      reminderListCount: 0,
    });
    const items = (brief.reminders as Record<string, unknown>).items;
    expect(Array.isArray(items)).toBe(true);
    expect((items as unknown[]).length).toBe(0);
  });
});
