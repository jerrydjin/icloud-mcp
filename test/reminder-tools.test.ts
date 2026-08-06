import { describe, expect, test } from "bun:test";
import {
  formatReminderForDisplay,
  locateReminder,
} from "../src/tools/reminders.js";
import type { RemindersProvider } from "../src/providers/reminders.js";
import type { Reminder } from "../src/types.js";

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    uid: "uid-1",
    summary: "Buy milk",
    isCompleted: false,
    listUrl: "https://caldav.icloud.com/123/tasks/",
    listName: "Reminders",
    url: "https://caldav.icloud.com/123/tasks/uid-1.ics",
    ...overrides,
  };
}

// ── formatReminderForDisplay ──

describe("formatReminderForDisplay", () => {
  const NOW = new Date("2026-08-04T12:00:00Z");

  test("undated reminder gets null dueDisplay and is never overdue", () => {
    const out = formatReminderForDisplay(makeReminder(), "UTC", NOW);
    expect(out.dueDisplay).toBeNull();
    expect(out.isOverdue).toBe(false);
  });

  test("datetime due is rendered in the display timezone", () => {
    const out = formatReminderForDisplay(
      makeReminder({
        due: { utc: "2026-08-04T22:00:00.000Z", timezone: "UTC" },
      }),
      "Australia/Melbourne",
      NOW
    );
    // 22:00Z on Aug 4 is Aug 5, 08:00 in Melbourne (AEST, UTC+10)
    expect(out.dueDisplay).toContain("8/5/2026");
    expect(out.displayTimezone).toBe("Australia/Melbourne");
  });

  test("date-only due passes through unformatted (no day-boundary shift)", () => {
    // This is the bug guard: running "2026-08-04" through a timezone formatter
    // would parse it as midnight UTC and render Aug 3 in negative-offset zones.
    const out = formatReminderForDisplay(
      makeReminder({ due: { utc: "2026-08-04", timezone: "UTC" } }),
      "America/Los_Angeles",
      NOW
    );
    expect(out.dueDisplay).toBe("2026-08-04");
  });

  test("past due on an incomplete reminder is overdue", () => {
    const out = formatReminderForDisplay(
      makeReminder({
        due: { utc: "2026-08-01T09:00:00.000Z", timezone: "UTC" },
      }),
      "UTC",
      NOW
    );
    expect(out.isOverdue).toBe(true);
  });

  test("future due is not overdue", () => {
    const out = formatReminderForDisplay(
      makeReminder({
        due: { utc: "2026-08-09T09:00:00.000Z", timezone: "UTC" },
      }),
      "UTC",
      NOW
    );
    expect(out.isOverdue).toBe(false);
  });

  test("completed reminder is never overdue even with a past due date", () => {
    const out = formatReminderForDisplay(
      makeReminder({
        due: { utc: "2026-08-01T09:00:00.000Z", timezone: "UTC" },
        isCompleted: true,
        completedAt: "2026-08-02T10:00:00.000Z",
      }),
      "UTC",
      NOW
    );
    expect(out.isOverdue).toBe(false);
  });

  test("unparseable due date does not throw or report overdue", () => {
    const out = formatReminderForDisplay(
      makeReminder({ due: { utc: "not-a-date", timezone: "UTC" } }),
      "UTC",
      NOW
    );
    expect(out.isOverdue).toBe(false);
  });

  test("preserves all original reminder fields", () => {
    const reminder = makeReminder({ priority: 1, description: "2%" });
    const out = formatReminderForDisplay(reminder, "UTC", NOW);
    expect(out.uid).toBe("uid-1");
    expect(out.priority).toBe(1);
    expect(out.description).toBe("2%");
    expect(out.etag).toBe(reminder.etag);
  });
});

// ── locateReminder ──

function makeMockProvider(opts: {
  lists?: Array<{ displayName: string; url: string }>;
  remindersByList?: Record<string, Reminder[]>;
  onResolveListUrl?: (name?: string) => Promise<string>;
}) {
  const calls: string[] = [];
  const lists = opts.lists ?? [];
  const byList = opts.remindersByList ?? {};

  const provider = {
    listLists: async () => lists,
    resolveListUrl: async (name?: string) => {
      if (opts.onResolveListUrl) return opts.onResolveListUrl(name);
      const match = lists.find((l) => l.displayName === name);
      if (!match) throw new Error(`Reminder list "${name}" not found`);
      return match.url;
    },
    getReminder: async (listUrl: string, uid: string) => {
      calls.push(listUrl);
      return byList[listUrl]?.find((r) => r.uid === uid) ?? null;
    },
  } as unknown as RemindersProvider;

  return { provider, calls };
}

describe("locateReminder", () => {
  const LIST_A = "https://caldav.icloud.com/123/list-a/";
  const LIST_B = "https://caldav.icloud.com/123/list-b/";

  test("searches every list when list is omitted", async () => {
    const target = makeReminder({ uid: "target", listUrl: LIST_B });
    const { provider, calls } = makeMockProvider({
      lists: [
        { displayName: "Personal", url: LIST_A },
        { displayName: "Work", url: LIST_B },
      ],
      remindersByList: { [LIST_A]: [], [LIST_B]: [target] },
    });

    const found = await locateReminder(provider, "target");
    expect(found?.listUrl).toBe(LIST_B);
    expect(found?.reminder.uid).toBe("target");
    expect(calls).toEqual([LIST_A, LIST_B]);
  });

  test("stops at the first list containing the uid", async () => {
    const target = makeReminder({ uid: "target", listUrl: LIST_A });
    const { provider, calls } = makeMockProvider({
      lists: [
        { displayName: "Personal", url: LIST_A },
        { displayName: "Work", url: LIST_B },
      ],
      remindersByList: { [LIST_A]: [target], [LIST_B]: [] },
    });

    await locateReminder(provider, "target");
    expect(calls).toEqual([LIST_A]);
  });

  test("queries only the named list when list is given", async () => {
    const target = makeReminder({ uid: "target", listUrl: LIST_B });
    const { provider, calls } = makeMockProvider({
      lists: [
        { displayName: "Personal", url: LIST_A },
        { displayName: "Work", url: LIST_B },
      ],
      remindersByList: { [LIST_A]: [], [LIST_B]: [target] },
    });

    const found = await locateReminder(provider, "target", "Work");
    expect(found?.listUrl).toBe(LIST_B);
    expect(calls).toEqual([LIST_B]);
  });

  test("list='all' fans out across every list", async () => {
    const target = makeReminder({ uid: "target", listUrl: LIST_B });
    const { provider, calls } = makeMockProvider({
      lists: [
        { displayName: "Personal", url: LIST_A },
        { displayName: "Work", url: LIST_B },
      ],
      remindersByList: { [LIST_A]: [], [LIST_B]: [target] },
    });

    const found = await locateReminder(provider, "target", "all");
    expect(found?.listUrl).toBe(LIST_B);
    expect(calls).toEqual([LIST_A, LIST_B]);
  });

  test("returns null when the uid exists nowhere", async () => {
    const { provider } = makeMockProvider({
      lists: [{ displayName: "Personal", url: LIST_A }],
      remindersByList: { [LIST_A]: [makeReminder({ uid: "other" })] },
    });

    expect(await locateReminder(provider, "missing")).toBeNull();
  });

  test("returns null (not a throw) when the named list has no such uid", async () => {
    const { provider } = makeMockProvider({
      lists: [{ displayName: "Personal", url: LIST_A }],
      remindersByList: { [LIST_A]: [] },
    });

    expect(await locateReminder(provider, "missing", "Personal")).toBeNull();
  });

  test("propagates an unknown list name as an error", async () => {
    const { provider } = makeMockProvider({
      lists: [{ displayName: "Personal", url: LIST_A }],
    });

    expect(locateReminder(provider, "any", "Nonexistent")).rejects.toThrow(
      /not found/
    );
  });
});
