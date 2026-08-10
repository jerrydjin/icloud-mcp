import { describe, expect, test } from "bun:test";
import {
  parseVTodo,
  mergeReminderForUpdate,
  RemindersProvider,
  normalizeListName,
} from "../src/providers/reminders.js";
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

// ── CalDAV read filter ──
// Regression guard: tsdav's fetchCalendarObjects defaults to a VCALENDAR > VEVENT
// comp-filter. Against a VTODO collection that matches nothing, so reminder reads
// came back empty from iCloud while every unit test still passed.

class StubRemindersProvider extends RemindersProvider {
  calls: Array<Record<string, any>> = [];

  constructor() {
    super("https://caldav.icloud.com", "test@icloud.com", "pw");
    this.connected = true;
    this.client = {
      fetchCalendarObjects: async (params: Record<string, any>) => {
        this.calls.push(params);
        return [
          {
            url: "https://caldav.icloud.com/1/tasks/uid-1.ics",
            etag: '"abc"',
            data: VCAL_BASIC_VTODO,
          },
        ];
      },
      fetchCalendars: async () => [
        {
          url: "https://caldav.icloud.com/1/tasks/",
          displayName: "Reminders",
          components: ["VTODO"],
        },
      ],
    } as any;
  }
}

function vtodoCompFilter(params: Record<string, any>) {
  return params.filters?.[0]?.["comp-filter"]?.["comp-filter"]?._attributes?.name;
}

describe("reminder reads request VTODO, not VEVENT", () => {
  test("listReminders sends a VCALENDAR > VTODO comp-filter", async () => {
    const p = new StubRemindersProvider();
    const out = await p.listReminders("https://caldav.icloud.com/1/tasks/");

    expect(p.calls.length).toBe(1);
    expect(vtodoCompFilter(p.calls[0]!)).toBe("VTODO");
    expect(out.length).toBe(1);
  });

  test("getReminder sends a VCALENDAR > VTODO comp-filter", async () => {
    const p = new StubRemindersProvider();
    await p.getReminder("https://caldav.icloud.com/1/tasks/", "basic-uid-1");

    expect(p.calls.length).toBe(1);
    expect(vtodoCompFilter(p.calls[0]!)).toBe("VTODO");
  });

  test("no read falls back to tsdav's default VEVENT filter", async () => {
    const p = new StubRemindersProvider();
    await p.listReminders("https://caldav.icloud.com/1/tasks/");
    await p.getReminder("https://caldav.icloud.com/1/tasks/", "basic-uid-1");

    for (const call of p.calls) {
      expect(call.filters).toBeDefined();
      expect(JSON.stringify(call.filters)).not.toContain("VEVENT");
    }
  });
});

// ── List name matching ──
// iCloud appends "⚠️" to the CalDAV display name of upgraded lists, so the server
// name is "Reminders ⚠️" while callers ask for "Reminders".

describe("normalizeListName", () => {
  test("strips iCloud's appended warning marker", () => {
    expect(normalizeListName("Reminders ⚠️")).toBe("reminders");
    expect(normalizeListName("Family ⚠️")).toBe("family");
  });

  test("is a no-op for undecorated names apart from case/whitespace", () => {
    expect(normalizeListName("Reminders")).toBe("reminders");
    expect(normalizeListName("  Groceries  ")).toBe("groceries");
  });

  test("collapses whitespace left behind by a stripped inline emoji", () => {
    expect(normalizeListName("Work 🔴 Urgent")).toBe("work urgent");
  });

  test("distinct names stay distinct", () => {
    expect(normalizeListName("Work ⚠️")).not.toBe(normalizeListName("Home ⚠️"));
  });
});

describe("resolveListUrl name matching", () => {
  class NamedListsProvider extends RemindersProvider {
    constructor(private names: string[]) {
      super("https://caldav.icloud.com", "test@icloud.com", "pw");
      this.connected = true;
      this.client = {
        fetchCalendars: async () =>
          this.names.map((displayName, i) => ({
            url: `https://caldav.icloud.com/1/tasks-${i}/`,
            displayName,
            components: ["VTODO"],
          })),
      } as any;
    }
  }

  test("resolves a bare name against the server's ⚠️-suffixed name", async () => {
    const p = new NamedListsProvider(["Reminders ⚠️", "Family ⚠️"]);
    expect(await p.resolveListUrl("Reminders")).toBe(
      "https://caldav.icloud.com/1/tasks-0/"
    );
    expect(await p.resolveListUrl("Family")).toBe(
      "https://caldav.icloud.com/1/tasks-1/"
    );
  });

  test("the exact server name still resolves", async () => {
    const p = new NamedListsProvider(["Reminders ⚠️"]);
    expect(await p.resolveListUrl("Reminders ⚠️")).toBe(
      "https://caldav.icloud.com/1/tasks-0/"
    );
  });

  test("exact match wins over a normalized collision", async () => {
    const p = new NamedListsProvider(["Reminders ⚠️", "Reminders"]);
    expect(await p.resolveListUrl("Reminders")).toBe(
      "https://caldav.icloud.com/1/tasks-1/"
    );
  });

  test("a genuinely absent list still errors", async () => {
    const p = new NamedListsProvider(["Reminders ⚠️"]);
    expect(p.resolveListUrl("Groceries")).rejects.toThrow(/not found/);
  });
});
