import { describe, expect, test } from "bun:test";
import { matchEvents, matchReminders } from "../src/verbs/find.js";
import type { CalendarEvent, Reminder } from "../src/types.js";

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  uid: "evt-1",
  summary: "Standup",
  start: { utc: "2026-04-28T22:00:00.000Z", timezone: "Australia/Melbourne" },
  end: { utc: "2026-04-28T22:30:00.000Z", timezone: "Australia/Melbourne" },
  attendees: [],
  isAllDay: false,
  calendarUrl: "https://example.com/cal/",
  calendarName: "Work",
  url: "https://example.com/cal/evt-1.ics",
  ...overrides,
});

const reminder = (overrides: Partial<Reminder>): Reminder => ({
  uid: "rem-1",
  summary: "Task",
  isCompleted: false,
  listUrl: "https://example.com/inbox/",
  listName: "Inbox",
  url: "https://example.com/inbox/rem-1.ics",
  ...overrides,
});

describe("matchEvents", () => {
  test("matches summary case-insensitively", () => {
    const events = [
      event({ uid: "1", summary: "Q3 Planning" }),
      event({ uid: "2", summary: "Lunch with Bob" }),
    ];
    expect(matchEvents(events, "q3")).toHaveLength(1);
    expect(matchEvents(events, "lunch")).toHaveLength(1);
    expect(matchEvents(events, "LUNCH")).toHaveLength(1);
  });

  test("matches description and location", () => {
    const events = [
      event({ uid: "1", summary: "Meeting", description: "Discuss the migration" }),
      event({ uid: "2", summary: "Coffee", location: "Cafe Nero" }),
    ];
    expect(matchEvents(events, "migration")).toHaveLength(1);
    expect(matchEvents(events, "nero")).toHaveLength(1);
  });

  test("returns [] for empty query", () => {
    const events = [event({ uid: "1", summary: "X" })];
    expect(matchEvents(events, "")).toEqual([]);
  });

  test("no matches returns []", () => {
    const events = [event({ uid: "1", summary: "Standup" })];
    expect(matchEvents(events, "lunch")).toEqual([]);
  });
});

describe("matchReminders", () => {
  test("matches summary case-insensitively", () => {
    const reminders = [
      reminder({ uid: "1", summary: "Buy milk" }),
      reminder({ uid: "2", summary: "Pay rent" }),
    ];
    expect(matchReminders(reminders, "milk")).toHaveLength(1);
    expect(matchReminders(reminders, "MILK")).toHaveLength(1);
  });

  test("matches description", () => {
    const reminders = [
      reminder({ uid: "1", summary: "Tax", description: "Quarterly filing" }),
    ];
    expect(matchReminders(reminders, "quarterly")).toHaveLength(1);
  });

  test("returns [] for empty query", () => {
    expect(matchReminders([reminder({})], "")).toEqual([]);
  });

  test("no match returns []", () => {
    expect(matchReminders([reminder({ summary: "X" })], "y")).toEqual([]);
  });
});
