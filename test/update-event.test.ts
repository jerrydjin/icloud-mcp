import { describe, expect, test } from "bun:test";
import { mergeEventForUpdate } from "../src/providers/caldav.js";
import type { CalendarEvent } from "../src/types.js";

const baseEvent: CalendarEvent = {
  uid: "evt-1",
  summary: "Standup",
  start: {
    utc: "2026-04-28T22:00:00.000Z",
    timezone: "Australia/Melbourne",
  },
  end: {
    utc: "2026-04-28T22:30:00.000Z",
    timezone: "Australia/Melbourne",
  },
  location: "Office",
  description: "Daily sync",
  attendees: [
    { email: "alice@example.com", status: "ACCEPTED" },
    { email: "bob@example.com", status: "NEEDS-ACTION" },
  ],
  status: "CONFIRMED",
  isAllDay: false,
  recurrenceRule: undefined,
  calendarUrl: "https://example.com/cal/",
  calendarName: "Work",
  url: "https://example.com/cal/evt-1.ics",
  etag: "etag-1",
};

const utcEvent: CalendarEvent = {
  ...baseEvent,
  uid: "evt-utc",
  start: { utc: "2026-04-28T22:00:00.000Z", timezone: "UTC" },
  end: { utc: "2026-04-28T22:30:00.000Z", timezone: "UTC" },
};

const allDayEvent: CalendarEvent = {
  ...baseEvent,
  uid: "evt-allday",
  start: { utc: "2026-04-28", timezone: "Australia/Melbourne" },
  end: { utc: "2026-04-29", timezone: "Australia/Melbourne" },
  isAllDay: true,
};

const recurringEvent: CalendarEvent = {
  ...baseEvent,
  uid: "evt-recurring",
  recurrenceRule: "FREQ=WEEKLY;BYDAY=MO;COUNT=10",
};

describe("mergeEventForUpdate — preservation", () => {
  test("empty updates preserves everything", () => {
    const m = mergeEventForUpdate(baseEvent, {});
    expect(m.summary).toBe("Standup");
    expect(m.location).toBe("Office");
    expect(m.description).toBe("Daily sync");
    expect(m.attendees).toEqual(["alice@example.com", "bob@example.com"]);
    expect(m.timezone).toBe("Australia/Melbourne");
    expect(m.isAllDay).toBe(false);
    expect(m.uid).toBe("evt-1");
  });

  test("preserves recurrence rule when not touched", () => {
    const m = mergeEventForUpdate(recurringEvent, {});
    expect(m.rruleStr).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=10");
  });

  test("SEQUENCE bumps to 1 (iCloud quirk Q4)", () => {
    const m = mergeEventForUpdate(baseEvent, {});
    expect(m.sequence).toBe(1);
  });
});

describe("mergeEventForUpdate — scalar replacement", () => {
  test("summary replaces", () => {
    const m = mergeEventForUpdate(baseEvent, { summary: "Renamed" });
    expect(m.summary).toBe("Renamed");
    expect(m.location).toBe("Office"); // preserved
  });

  test("location=null clears, undefined preserves, string replaces", () => {
    expect(mergeEventForUpdate(baseEvent, { location: null }).location).toBeUndefined();
    expect(mergeEventForUpdate(baseEvent, {}).location).toBe("Office");
    expect(mergeEventForUpdate(baseEvent, { location: "Cafe" }).location).toBe(
      "Cafe"
    );
  });

  test("description=null clears, undefined preserves, string replaces", () => {
    expect(
      mergeEventForUpdate(baseEvent, { description: null }).description
    ).toBeUndefined();
    expect(mergeEventForUpdate(baseEvent, {}).description).toBe("Daily sync");
  });

  test("flipping isAllDay requires new start AND end", () => {
    // Flip without providing new times: throws clear error
    expect(() =>
      mergeEventForUpdate(baseEvent, { isAllDay: true })
    ).toThrow(/cannot change isAllDay/i);
    expect(() =>
      mergeEventForUpdate(allDayEvent, { isAllDay: false })
    ).toThrow(/cannot change isAllDay/i);

    // Flipping WITH new times works
    const flippedToAllDay = mergeEventForUpdate(baseEvent, {
      isAllDay: true,
      start: "2026-04-28",
      end: "2026-04-29",
    });
    expect(flippedToAllDay.isAllDay).toBe(true);

    const flippedFromAllDay = mergeEventForUpdate(allDayEvent, {
      isAllDay: false,
      start: "2026-04-28T09:00:00",
      end: "2026-04-28T10:00:00",
    });
    expect(flippedFromAllDay.isAllDay).toBe(false);
  });

  test("preserving isAllDay (no flip) doesn't require start/end", () => {
    expect(mergeEventForUpdate(baseEvent, { isAllDay: false }).isAllDay).toBe(false);
    expect(mergeEventForUpdate(allDayEvent, { isAllDay: true }).isAllDay).toBe(true);
  });
});

describe("mergeEventForUpdate — attendees", () => {
  test("undefined preserves existing attendees", () => {
    const m = mergeEventForUpdate(baseEvent, {});
    expect(m.attendees).toEqual(["alice@example.com", "bob@example.com"]);
  });

  test("empty array clears attendees", () => {
    const m = mergeEventForUpdate(baseEvent, { attendees: [] });
    expect(m.attendees).toEqual([]);
  });

  test("array replaces entirely (no merge)", () => {
    const m = mergeEventForUpdate(baseEvent, {
      attendees: ["new@example.com"],
    });
    expect(m.attendees).toEqual(["new@example.com"]);
  });
});

describe("mergeEventForUpdate — recurrence", () => {
  test("undefined preserves the existing RRULE string", () => {
    const m = mergeEventForUpdate(recurringEvent, {});
    expect(m.rruleStr).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=10");
    expect(m.recurrence).toBeUndefined(); // No structured input was provided
  });

  test("null clears recurrence", () => {
    const m = mergeEventForUpdate(recurringEvent, { recurrence: null });
    expect(m.rruleStr).toBeUndefined();
    expect(m.recurrence).toBeUndefined();
  });

  test("RecurrenceInput replaces — re-derives RRULE string", () => {
    const m = mergeEventForUpdate(recurringEvent, {
      recurrence: {
        frequency: "DAILY",
        endType: "after",
        count: 5,
      },
    });
    expect(m.recurrence?.frequency).toBe("DAILY");
    expect(m.rruleStr).toContain("FREQ=DAILY");
    expect(m.rruleStr).toContain("COUNT=5");
  });

  test("WEEKLY without BYDAY infers from DTSTART (iCloud quirk Q2)", () => {
    const m = mergeEventForUpdate(baseEvent, {
      recurrence: {
        frequency: "WEEKLY",
        endType: "never",
      },
    });
    expect(m.rruleStr).toContain("FREQ=WEEKLY");
    // BYDAY should be inferred — depends on the DTSTART weekday in Melbourne
    expect(m.rruleStr).toMatch(/BYDAY=(MO|TU|WE|TH|FR|SA|SU)/);
  });
});

describe("mergeEventForUpdate — start/end with timezone preservation", () => {
  test("preserves existing start/end when not touched (round-trips through UTC)", () => {
    const m = mergeEventForUpdate(baseEvent, {});
    // The existing event was 2026-04-28T22:00:00Z = 2026-04-29T08:00 in Melbourne (AEST UTC+10)
    expect(m.timezone).toBe("Australia/Melbourne");
    // The startLocal should reflect the local time in Melbourne
    expect(m.startLocal).toMatch(/^2026-04-29T08:00/);
    expect(m.endLocal).toMatch(/^2026-04-29T08:30/);
  });

  test("explicit start/end with timezone replaces", () => {
    const m = mergeEventForUpdate(baseEvent, {
      start: "2026-05-01T15:00:00",
      end: "2026-05-01T16:00:00",
      timezone: "America/New_York",
    });
    expect(m.timezone).toBe("America/New_York");
    expect(m.startLocal).toBe("2026-05-01T15:00:00");
    expect(m.endLocal).toBe("2026-05-01T16:00:00");
  });

  test("UTC-stored event preserves UTC on no-touch update", () => {
    const m = mergeEventForUpdate(utcEvent, {});
    expect(m.timezone).toBe("UTC");
    expect(m.startLocal).toBe("2026-04-28T22:00:00.000");
  });

  test("all-day event preserves date-only on no-touch update", () => {
    const m = mergeEventForUpdate(allDayEvent, {});
    expect(m.isAllDay).toBe(true);
    expect(m.startLocal).toBe("2026-04-28");
    expect(m.endLocal).toBe("2026-04-29");
  });

  test("explicit Z-suffix start gets stripped (caller sent UTC, we strip Z for emission)", () => {
    const m = mergeEventForUpdate(baseEvent, {
      start: "2026-05-01T15:00:00Z",
      end: "2026-05-01T16:00:00Z",
    });
    expect(m.startLocal).toBe("2026-05-01T15:00:00");
    expect(m.endLocal).toBe("2026-05-01T16:00:00");
  });
});

describe("mergeEventForUpdate — uid passthrough", () => {
  test("uid is always preserved from existing", () => {
    const m = mergeEventForUpdate(baseEvent, { summary: "X" });
    expect(m.uid).toBe("evt-1");
    // Caller cannot inject a different UID — UpdateEventInput doesn't have one
  });
});
