import { describe, expect, test } from "bun:test";
import { buildRRule, weekdayOfStart } from "../src/utils/rrule.js";
import type { RecurrenceInput } from "../src/types.js";

describe("buildRRule", () => {
  test("DAILY with endType=never", () => {
    const r: RecurrenceInput = { frequency: "DAILY", endType: "never" };
    expect(buildRRule(r, "UTC", false)).toBe("FREQ=DAILY");
  });

  test("DAILY with endType=after produces COUNT", () => {
    const r: RecurrenceInput = {
      frequency: "DAILY",
      endType: "after",
      count: 10,
    };
    expect(buildRRule(r, "UTC", false)).toBe("FREQ=DAILY;COUNT=10");
  });

  test("MONTHLY with interval=2 produces INTERVAL", () => {
    const r: RecurrenceInput = {
      frequency: "MONTHLY",
      interval: 2,
      endType: "never",
    };
    expect(buildRRule(r, "UTC", false)).toBe("FREQ=MONTHLY;INTERVAL=2");
  });

  test("interval=1 is omitted (default)", () => {
    const r: RecurrenceInput = {
      frequency: "WEEKLY",
      interval: 1,
      endType: "never",
    };
    expect(buildRRule(r, "UTC", false)).toBe("FREQ=WEEKLY");
  });

  test("WEEKLY with BYDAY and endType=on produces UTC UNTIL", () => {
    const r: RecurrenceInput = {
      frequency: "WEEKLY",
      endType: "on",
      until: "2026-12-31T00:00:00",
      byWeekday: ["MO", "WE", "FR"],
    };
    const rule = buildRRule(r, "Australia/Melbourne", false);
    expect(rule).toStartWith("FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=");
    const untilMatch = rule.match(/UNTIL=(\d{8}T\d{6}Z)$/);
    expect(untilMatch).not.toBeNull();
    // Dec 31 2026 midnight Melbourne (AEDT, +11) → Dec 30 2026 13:00:00 UTC
    expect(untilMatch![1]).toBe("20261230T130000Z");
  });

  test("all-day with endType=on produces DATE-form UNTIL", () => {
    const r: RecurrenceInput = {
      frequency: "YEARLY",
      endType: "on",
      until: "2030-01-01",
    };
    expect(buildRRule(r, "UTC", true)).toBe("FREQ=YEARLY;UNTIL=20300101");
  });

  test("all-day strips time portion if provided in until", () => {
    const r: RecurrenceInput = {
      frequency: "DAILY",
      endType: "on",
      until: "2026-12-31T23:59:59",
    };
    expect(buildRRule(r, "UTC", true)).toBe("FREQ=DAILY;UNTIL=20261231");
  });

  test("endType=after without count throws", () => {
    const r: RecurrenceInput = {
      frequency: "DAILY",
      endType: "after",
    };
    expect(() => buildRRule(r, "UTC", false)).toThrow(/requires count/);
  });

  test("endType=on without until throws", () => {
    const r: RecurrenceInput = {
      frequency: "DAILY",
      endType: "on",
    };
    expect(() => buildRRule(r, "UTC", false)).toThrow(/requires until/);
  });

  test("multiple BYDAY weekdays preserve order", () => {
    const r: RecurrenceInput = {
      frequency: "WEEKLY",
      endType: "never",
      byWeekday: ["TU", "TH"],
    };
    expect(buildRRule(r, "UTC", false)).toBe("FREQ=WEEKLY;BYDAY=TU,TH");
  });
});

describe("weekdayOfStart", () => {
  test("derives MO for Monday in UTC", () => {
    // 2026-04-13 is a Monday
    expect(weekdayOfStart("2026-04-13T09:00:00", "UTC", false)).toBe("MO");
  });

  test("derives the wall-clock weekday in the event's timezone", () => {
    // 2026-04-21T10:00:00 Melbourne (AEST +10) → Tuesday there,
    // but the UTC instant is Tue 00:00 UTC — still Tuesday.
    expect(
      weekdayOfStart("2026-04-21T10:00:00", "Australia/Melbourne", false)
    ).toBe("TU");
  });

  test("timezone can flip the weekday relative to UTC", () => {
    // 2026-04-20T23:00:00 in Australia/Sydney is Monday local time,
    // but 13:00 UTC Monday — both Monday, same answer.
    // For a flip: 2026-04-21T02:00:00 Sydney = Tue 2am local = Mon 16:00 UTC.
    // Function should return TU (Sydney wall-clock), not MO (UTC).
    expect(
      weekdayOfStart("2026-04-21T02:00:00", "Australia/Sydney", false)
    ).toBe("TU");
  });

  test("all-day uses the date as-is", () => {
    // 2030-01-01 is a Tuesday
    expect(weekdayOfStart("2030-01-01", "UTC", true)).toBe("TU");
  });
});
