import { describe, expect, test } from "bun:test";
import { addMinutesToLocal } from "../src/verbs/schedule.js";

describe("addMinutesToLocal", () => {
  test("adds minutes within the same hour", () => {
    expect(addMinutesToLocal("2026-04-28T14:15:00", 30)).toBe("2026-04-28T14:45:00");
    expect(addMinutesToLocal("2026-04-28T14:15:00", 5)).toBe("2026-04-28T14:20:00");
  });

  test("rolls over to next hour", () => {
    expect(addMinutesToLocal("2026-04-28T14:50:00", 30)).toBe("2026-04-28T15:20:00");
    expect(addMinutesToLocal("2026-04-28T14:00:00", 60)).toBe("2026-04-28T15:00:00");
  });

  test("rolls over to next day", () => {
    expect(addMinutesToLocal("2026-04-28T23:30:00", 60)).toBe("2026-04-29T00:30:00");
    expect(addMinutesToLocal("2026-04-28T23:55:00", 30)).toBe("2026-04-29T00:25:00");
  });

  test("rolls across month boundary", () => {
    expect(addMinutesToLocal("2026-04-30T23:30:00", 60)).toBe("2026-05-01T00:30:00");
  });

  test("rolls across year boundary", () => {
    expect(addMinutesToLocal("2026-12-31T23:30:00", 60)).toBe("2027-01-01T00:30:00");
  });

  test("handles 0 minutes", () => {
    expect(addMinutesToLocal("2026-04-28T14:00:00", 0)).toBe("2026-04-28T14:00:00");
  });

  test("handles default seconds (no seconds in input)", () => {
    expect(addMinutesToLocal("2026-04-28T14:00", 30)).toBe("2026-04-28T14:30:00");
  });

  test("preserves seconds and milliseconds when present", () => {
    expect(addMinutesToLocal("2026-04-28T14:00:30.500", 30)).toBe(
      "2026-04-28T14:30:30.500"
    );
  });

  test("rejects malformed input", () => {
    expect(() => addMinutesToLocal("not a date", 30)).toThrow(/Invalid ISO/);
    expect(() => addMinutesToLocal("2026-04-28", 30)).toThrow(/Invalid ISO/);
  });
});
