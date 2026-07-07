import { describe, expect, test } from "bun:test";
import { parseVTodo, mergeReminderForUpdate } from "../src/providers/reminders.js";
import type { Reminder } from "../src/types.js";

// ── VTODO list filter ──
// Mirrors the filter in RemindersProvider.listLists()

function isVTodoList(cal: { components?: string[] }): boolean {
  return !!cal.components && cal.components.includes("VTODO");
}

describe("VTODO list filter", () => {
  test("includes calendar with VTODO component only", () => {
    expect(isVTodoList({ components: ["VTODO"] })).toBe(true);
  });

  test("includes calendar with VEVENT + VTODO mixed", () => {
    expect(isVTodoList({ components: ["VEVENT", "VTODO"] })).toBe(true);
  });

  test("excludes calendar with only VEVENT", () => {
    expect(isVTodoList({ components: ["VEVENT"] })).toBe(false);
  });

  test("excludes calendar with undefined components (iCloud convention = VEVENT)", () => {
    expect(isVTodoList({})).toBe(false);
  });

  test("excludes empty components array", () => {
    expect(isVTodoList({ components: [] })).toBe(false);
  });
});

// ── parseVTodo ──

const VCAL_BASIC_VTODO = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//icloud-mcp//v3//EN
BEGIN:VTODO
UID:basic-uid-1
SUMMARY:Buy milk
DTSTAMP:20260428T120000Z
END:VTODO
END:VCALENDAR`;

const VCAL_COMPLETED_VTODO = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//icloud-mcp//v3//EN
BEGIN:VTODO
UID:completed-uid-1
SUMMARY:Pay rent
DTSTAMP:20260428T120000Z
STATUS:COMPLETED
COMPLETED:20260427T140000Z
PERCENT-COMPLETE:100
END:VTODO
END:VCALENDAR`;

const VCAL_DUE_DATE_UTC = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//icloud-mcp//v3//EN
BEGIN:VTODO
UID:due-uid-1
SUMMARY:Tax filing
DTSTAMP:20260428T120000Z
DUE:20260415T230000Z
PRIORITY:1
DESCRIPTION:File quarterly taxes
END:VTODO
END:VCALENDAR`;

const VCAL_NO_VTODO = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//icloud-mcp//v3//EN
BEGIN:VEVENT
UID:event-uid-1
SUMMARY:Just an event
DTSTART:20260428T120000Z
DTEND:20260428T130000Z
DTSTAMP:20260428T120000Z
END:VEVENT
END:VCALENDAR`;

describe("parseVTodo", () => {
  test("parses a basic incomplete VTODO", () => {
    const r = parseVTodo(VCAL_BASIC_VTODO, "Inbox", "https://example.com/inbox/");
    expect(r).not.toBeNull();
    expect(r!.uid).toBe("basic-uid-1");
    expect(r!.summary).toBe("Buy milk");
    expect(r!.isCompleted).toBe(false);
    expect(r!.due).toBeUndefined();
    expect(r!.completedAt).toBeUndefined();
    expect(r!.listName).toBe("Inbox");
    expect(r!.listUrl).toBe("https://example.com/inbox/");
  });

  test("parses a completed VTODO via STATUS:COMPLETED", () => {
    const r = parseVTodo(VCAL_COMPLETED_VTODO, "Inbox", "https://example.com/inbox/");
    expect(r).not.toBeNull();
    expect(r!.isCompleted).toBe(true);
    expect(r!.completedAt).toBe("2026-04-27T14:00:00.000Z");
    expect(r!.percentComplete).toBe(100);
  });

  test("parses due date, description, and priority", () => {
    const r = parseVTodo(VCAL_DUE_DATE_UTC, "Taxes", "https://example.com/taxes/");
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Tax filing");
    expect(r!.priority).toBe(1);
    expect(r!.description).toBe("File quarterly taxes");
    expect(r!.due).toBeDefined();
    expect(r!.due!.utc).toContain("2026-04-15");
  });

  test("returns null for VCALENDAR with no VTODO subcomponent", () => {
    const r = parseVTodo(VCAL_NO_VTODO, "Calendar", "https://example.com/cal/");
    expect(r).toBeNull();
  });

  test("treats PERCENT-COMPLETE=100 as completed even without STATUS", () => {
    const data = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:percent-uid
SUMMARY:Done via percent
DTSTAMP:20260428T120000Z
PERCENT-COMPLETE:100
END:VTODO
END:VCALENDAR`;
    const r = parseVTodo(data, "Inbox", "https://example.com/inbox/");
    expect(r).not.toBeNull();
    expect(r!.isCompleted).toBe(true);
  });

  test("returns null for VTODO missing UID", () => {
    const data = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
SUMMARY:No UID
DTSTAMP:20260428T120000Z
END:VTODO
END:VCALENDAR`;
    const r = parseVTodo(data, "Inbox", "https://example.com/inbox/");
    expect(r).toBeNull();
  });

  test("ignores priority value of 0 (means 'no priority')", () => {
    const data = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:no-priority
SUMMARY:Whatever
DTSTAMP:20260428T120000Z
PRIORITY:0
END:VTODO
END:VCALENDAR`;
    const r = parseVTodo(data, "Inbox", "https://example.com/inbox/");
    expect(r).not.toBeNull();
    expect(r!.priority).toBeUndefined();
  });
});

// ── mergeReminderForUpdate ──
// Tests the partial-update semantics: undefined leaves alone, null clears, value replaces.

const baseReminder: Reminder = {
  uid: "merge-test-uid",
  summary: "Original summary",
  description: "Original description",
  due: { utc: "2026-05-01T15:00:00.000Z", timezone: "Australia/Melbourne" },
  isCompleted: false,
  priority: 5,
  listUrl: "https://example.com/inbox/",
  listName: "Inbox",
  url: "https://example.com/inbox/merge-test-uid.ics",
  etag: "etag-1",
};

describe("mergeReminderForUpdate", () => {
  test("undefined fields preserve existing values", () => {
    const merged = mergeReminderForUpdate(baseReminder, {});
    expect(merged.summary).toBe("Original summary");
    expect(merged.description).toBe("Original description");
    expect(merged.priority).toBe(5);
    expect(merged.isCompleted).toBe(false);
    expect(merged.dueLocalString).toBe("2026-05-01T15:00:00.000Z");
  });

  test("explicit summary replaces existing", () => {
    const merged = mergeReminderForUpdate(baseReminder, { summary: "New summary" });
    expect(merged.summary).toBe("New summary");
    expect(merged.description).toBe("Original description"); // unchanged
  });

  test("due=null clears the due date", () => {
    const merged = mergeReminderForUpdate(baseReminder, { due: null });
    expect(merged.dueLocalString).toBeUndefined();
  });

  test("due=string replaces the due date", () => {
    const merged = mergeReminderForUpdate(baseReminder, {
      due: "2026-06-01T09:00:00",
      timezone: "America/New_York",
    });
    expect(merged.dueLocalString).toBe("2026-06-01T09:00:00");
    expect(merged.timezone).toBe("America/New_York");
  });

  test("isCompleted=true sets completedAt to now if not already set", () => {
    const before = Date.now();
    const merged = mergeReminderForUpdate(baseReminder, { isCompleted: true });
    const after = Date.now();
    expect(merged.isCompleted).toBe(true);
    expect(merged.completedAt).toBeDefined();
    const completedTime = new Date(merged.completedAt!).getTime();
    expect(completedTime).toBeGreaterThanOrEqual(before);
    expect(completedTime).toBeLessThanOrEqual(after);
  });

  test("isCompleted=false clears completedAt", () => {
    const completedReminder: Reminder = {
      ...baseReminder,
      isCompleted: true,
      completedAt: "2026-04-28T10:00:00.000Z",
    };
    const merged = mergeReminderForUpdate(completedReminder, { isCompleted: false });
    expect(merged.isCompleted).toBe(false);
    expect(merged.completedAt).toBeUndefined();
  });

  test("toggling completed twice preserves the original completedAt", () => {
    const completedReminder: Reminder = {
      ...baseReminder,
      isCompleted: true,
      completedAt: "2026-04-28T10:00:00.000Z",
    };
    const merged = mergeReminderForUpdate(completedReminder, { isCompleted: true });
    expect(merged.completedAt).toBe("2026-04-28T10:00:00.000Z");
  });

  test("description=undefined preserves; description=empty-string clears", () => {
    const m1 = mergeReminderForUpdate(baseReminder, {});
    expect(m1.description).toBe("Original description");

    // The current behavior: any defined string (even "") replaces
    const m2 = mergeReminderForUpdate(baseReminder, { description: "" });
    expect(m2.description).toBe("");
  });

  test("SEQUENCE bumps to 1 on every update (iCloud quirk Q4)", () => {
    const merged = mergeReminderForUpdate(baseReminder, {});
    expect(merged.sequence).toBe(1);
  });
});
