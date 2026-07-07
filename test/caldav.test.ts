import { describe, expect, test } from "bun:test";
import ICAL from "ical.js";
import {
  resolveTimezone,
  validateTimezone,
  formatInTimezone,
  buildVTimezone,
  registerTimezone,
  localToUtc,
} from "../src/utils/timezone.js";
import { buildRRule } from "../src/utils/rrule.js";

// ── VTODO Filtering ──
// Mirrors the filter in CalDavProvider.listCalendars()

function isVEventCalendar(cal: { components?: string[] }): boolean {
  return !cal.components || cal.components.includes("VEVENT");
}

describe("VTODO filtering", () => {
  test("includes calendar with VEVENT component", () => {
    expect(isVEventCalendar({ components: ["VEVENT"] })).toBe(true);
  });

  test("includes calendar with VEVENT + VTODO", () => {
    expect(isVEventCalendar({ components: ["VEVENT", "VTODO"] })).toBe(true);
  });

  test("excludes calendar with only VTODO (Reminders)", () => {
    expect(isVEventCalendar({ components: ["VTODO"] })).toBe(false);
  });

  test("includes calendar with undefined components", () => {
    expect(isVEventCalendar({})).toBe(true);
  });

  test("excludes empty components array", () => {
    expect(isVEventCalendar({ components: [] })).toBe(false);
  });
});

// ── resolveCalendarUrl logic ──
// Tests the 5 branches: default, URL passthrough, exact match, no match, ambiguous

interface CalInfo {
  displayName: string;
  url: string;
}

function resolveCalendarUrl(
  calendars: CalInfo[],
  nameOrUrl?: string
): string {
  if (calendars.length === 0) throw new Error("No calendars found");
  if (!nameOrUrl) return calendars[0]!.url;
  if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://"))
    return nameOrUrl;

  const matches = calendars.filter(
    (cal) => cal.displayName.toLowerCase() === nameOrUrl.toLowerCase()
  );
  if (matches.length === 0) {
    const available = calendars.map((c) => c.displayName).join(", ");
    throw new Error(
      `Calendar "${nameOrUrl}" not found. Available: ${available}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous calendar name "${nameOrUrl}" matches ${matches.length} calendars. Use the calendar URL instead.`
    );
  }
  return matches[0]!.url;
}

const testCalendars: CalInfo[] = [
  { displayName: "Home", url: "https://caldav.icloud.com/home/" },
  { displayName: "Work", url: "https://caldav.icloud.com/work/" },
];

describe("resolveCalendarUrl", () => {
  test("returns first calendar when no param", () => {
    expect(resolveCalendarUrl(testCalendars)).toBe(
      "https://caldav.icloud.com/home/"
    );
  });

  test("passes through https URL directly", () => {
    const url = "https://caldav.icloud.com/custom/";
    expect(resolveCalendarUrl(testCalendars, url)).toBe(url);
  });

  test("passes through http URL directly", () => {
    const url = "http://localhost:5232/cal/";
    expect(resolveCalendarUrl(testCalendars, url)).toBe(url);
  });

  test("matches by display name (case-insensitive)", () => {
    expect(resolveCalendarUrl(testCalendars, "work")).toBe(
      "https://caldav.icloud.com/work/"
    );
    expect(resolveCalendarUrl(testCalendars, "WORK")).toBe(
      "https://caldav.icloud.com/work/"
    );
    expect(resolveCalendarUrl(testCalendars, "Work")).toBe(
      "https://caldav.icloud.com/work/"
    );
  });

  test("throws on no match", () => {
    expect(() => resolveCalendarUrl(testCalendars, "Vacation")).toThrow(
      'Calendar "Vacation" not found'
    );
  });

  test("throws on ambiguous match", () => {
    const dupes: CalInfo[] = [
      { displayName: "Work", url: "https://example.com/a/" },
      { displayName: "Work", url: "https://example.com/b/" },
    ];
    expect(() => resolveCalendarUrl(dupes, "Work")).toThrow("Ambiguous");
  });

  test("throws on empty calendars", () => {
    expect(() => resolveCalendarUrl([])).toThrow("No calendars found");
  });
});

// ── iCalendar Parsing ──
// Tests the parseVEvent logic using ical.js directly

interface TimezoneAwareTime {
  utc: string;
  timezone: string;
}

function parseVEvent(vcalendarData: string) {
  const jcalData = ICAL.parse(vcalendarData);
  const comp = new ICAL.Component(jcalData);
  const vevent = comp.getFirstSubcomponent("vevent");
  if (!vevent) return null;

  const event = new ICAL.Event(vevent);
  const startDate = event.startDate;
  const endDate = event.endDate;
  const isAllDay = startDate.isDate;

  const startTzid = startDate.zone?.tzid || "UTC";
  const endTzid = endDate.zone?.tzid || "UTC";

  let start: TimezoneAwareTime;
  let end: TimezoneAwareTime;

  if (isAllDay) {
    start = { utc: startDate.toString(), timezone: startTzid };
    end = { utc: endDate.toString(), timezone: endTzid };
  } else {
    start = { utc: startDate.toJSDate().toISOString(), timezone: startTzid };
    end = { utc: endDate.toJSDate().toISOString(), timezone: endTzid };
  }

  const attendees: { email: string; name?: string; status?: string }[] = [];
  const attendeeProps = vevent.getAllProperties("attendee");
  for (const prop of attendeeProps) {
    const val = prop.getFirstValue();
    const emailStr =
      typeof val === "string" ? val.replace("mailto:", "") : "";
    const cn = prop.getParameter("cn");
    const partstat = prop.getParameter("partstat");
    attendees.push({
      email: emailStr,
      name: typeof cn === "string" ? cn : undefined,
      status: typeof partstat === "string" ? partstat : undefined,
    });
  }

  const rruleProp = vevent.getFirstProperty("rrule");
  let recurrenceRule: string | undefined;
  if (rruleProp) {
    const rruleVal = rruleProp.getFirstValue();
    recurrenceRule = rruleVal ? String(rruleVal) : undefined;
  }

  return {
    uid: event.uid,
    summary: event.summary || "(no title)",
    start,
    end,
    isAllDay,
    attendees,
    recurrenceRule,
    location: event.location || undefined,
    description: event.description || undefined,
  };
}

const SIMPLE_EVENT = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-uid-123
SUMMARY:Team Meeting
DTSTART:20260415T140000Z
DTEND:20260415T150000Z
LOCATION:Conference Room B
DESCRIPTION:Weekly sync
END:VEVENT
END:VCALENDAR`;

const ALLDAY_EVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:allday-001
SUMMARY:Company Holiday
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260502
END:VEVENT
END:VCALENDAR`;

const EVENT_WITH_ATTENDEES = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:attendee-001
SUMMARY:Planning Session
DTSTART:20260420T100000Z
DTEND:20260420T110000Z
ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@example.com
ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com
END:VEVENT
END:VCALENDAR`;

const RECURRING_EVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:recur-001
SUMMARY:Daily Standup
DTSTART:20260413T090000Z
DTEND:20260413T091500Z
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
END:VCALENDAR`;

const NO_TITLE_EVENT = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:notitle-001
DTSTART:20260415T120000Z
DTEND:20260415T130000Z
END:VEVENT
END:VCALENDAR`;

describe("parseVEvent", () => {
  test("parses simple timed event with TimezoneAwareTime", () => {
    const result = parseVEvent(SIMPLE_EVENT);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe("test-uid-123");
    expect(result!.summary).toBe("Team Meeting");
    expect(result!.start.utc).toBe("2026-04-15T14:00:00.000Z");
    expect(result!.start.timezone).toBe("UTC");
    expect(result!.end.utc).toBe("2026-04-15T15:00:00.000Z");
    expect(result!.end.timezone).toBe("UTC");
    expect(result!.location).toBe("Conference Room B");
    expect(result!.description).toBe("Weekly sync");
    expect(result!.isAllDay).toBe(false);
  });

  test("parses all-day event with TimezoneAwareTime", () => {
    const result = parseVEvent(ALLDAY_EVENT);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe("allday-001");
    expect(result!.isAllDay).toBe(true);
    expect(result!.start.utc).toBe("2026-05-01");
    expect(result!.end.utc).toBe("2026-05-02");
  });

  test("parses attendees", () => {
    const result = parseVEvent(EVENT_WITH_ATTENDEES);
    expect(result).not.toBeNull();
    expect(result!.attendees).toHaveLength(2);
    expect(result!.attendees[0]!.email).toBe("alice@example.com");
    expect(result!.attendees[0]!.name).toBe("Alice");
    expect(result!.attendees[0]!.status).toBe("ACCEPTED");
    expect(result!.attendees[1]!.email).toBe("bob@example.com");
    expect(result!.attendees[1]!.status).toBe("NEEDS-ACTION");
  });

  test("parses recurrence rule", () => {
    const result = parseVEvent(RECURRING_EVENT);
    expect(result).not.toBeNull();
    expect(result!.recurrenceRule).toBeDefined();
    expect(result!.recurrenceRule).toContain("DAILY");
  });

  test("handles missing title", () => {
    const result = parseVEvent(NO_TITLE_EVENT);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("(no title)");
  });

  test("returns null for VCALENDAR without VEVENT", () => {
    const vtodo = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:todo-001
SUMMARY:Buy groceries
END:VTODO
END:VCALENDAR`;
    expect(parseVEvent(vtodo)).toBeNull();
  });

  test("handles floating time (no TZID, no Z)", () => {
    const floating = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:float-001
SUMMARY:Floating Event
DTSTART:20260415T140000
DTEND:20260415T150000
END:VEVENT
END:VCALENDAR`;
    const result = parseVEvent(floating);
    expect(result).not.toBeNull();
    expect(result!.start.utc).toContain("2026-04-15");
    // Floating times have no zone, ical.js reports "floating" or similar
    expect(result!.isAllDay).toBe(false);
  });

  test("preserves TZID from event with VTIMEZONE", () => {
    const melbourneEvent = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Australia/Melbourne
BEGIN:STANDARD
TZNAME:AEST
TZOFFSETFROM:+1100
TZOFFSETTO:+1000
DTSTART:19700405T030000
RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU
END:STANDARD
BEGIN:DAYLIGHT
TZNAME:AEDT
TZOFFSETFROM:+1000
TZOFFSETTO:+1100
DTSTART:19701004T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:tz-001
SUMMARY:Melbourne Meeting
DTSTART;TZID=Australia/Melbourne:20260415T150000
DTEND;TZID=Australia/Melbourne:20260415T160000
END:VEVENT
END:VCALENDAR`;
    const result = parseVEvent(melbourneEvent);
    expect(result).not.toBeNull();
    expect(result!.start.timezone).toBe("Australia/Melbourne");
    expect(result!.end.timezone).toBe("Australia/Melbourne");
    // UTC should be the converted instant (AEST is +10 in April = standard time)
    expect(result!.start.utc).toBe("2026-04-15T05:00:00.000Z");
    expect(result!.end.utc).toBe("2026-04-15T06:00:00.000Z");
  });

  test("UTC event has timezone 'UTC'", () => {
    const result = parseVEvent(SIMPLE_EVENT);
    expect(result).not.toBeNull();
    expect(result!.start.timezone).toBe("UTC");
  });
});

// ── Recurrence Expansion ──

describe("recurrence expansion", () => {
  test("expands daily recurrence within range", () => {
    const jcalData = ICAL.parse(RECURRING_EVENT);
    const comp = new ICAL.Component(jcalData);
    const vevent = comp.getFirstSubcomponent("vevent");
    expect(vevent).not.toBeNull();

    const event = new ICAL.Event(vevent!);
    const iterator = event.iterator();
    const occurrences: string[] = [];

    let next = iterator.next();
    let count = 0;
    while (next && count < 10) {
      occurrences.push(next.toJSDate().toISOString());
      next = iterator.next();
      count++;
    }

    // RRULE:FREQ=DAILY;COUNT=5 should produce 5 occurrences
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0]).toBe("2026-04-13T09:00:00.000Z");
    expect(occurrences[4]).toBe("2026-04-17T09:00:00.000Z");
  });
});

// ── Timezone Utilities ──

describe("timezone utilities", () => {
  test("validateTimezone accepts valid IANA timezone", () => {
    expect(() => validateTimezone("Australia/Melbourne")).not.toThrow();
    expect(() => validateTimezone("Europe/London")).not.toThrow();
    expect(() => validateTimezone("America/New_York")).not.toThrow();
    expect(() => validateTimezone("UTC")).not.toThrow();
  });

  test("validateTimezone rejects invalid timezone", () => {
    expect(() => validateTimezone("Not/A/Timezone")).toThrow(
      "Invalid IANA timezone"
    );
    expect(() => validateTimezone("AEST")).toThrow("Invalid IANA timezone");
    expect(() => validateTimezone("")).toThrow();
  });

  test("resolveTimezone returns explicit param when provided", () => {
    expect(resolveTimezone("Australia/Melbourne")).toBe("Australia/Melbourne");
  });

  test("resolveTimezone falls back to env var", () => {
    const original = process.env.DEFAULT_TIMEZONE;
    process.env.DEFAULT_TIMEZONE = "Europe/London";
    try {
      expect(resolveTimezone()).toBe("Europe/London");
    } finally {
      if (original) {
        process.env.DEFAULT_TIMEZONE = original;
      } else {
        delete process.env.DEFAULT_TIMEZONE;
      }
    }
  });

  test("resolveTimezone falls back to OS timezone", () => {
    const original = process.env.DEFAULT_TIMEZONE;
    delete process.env.DEFAULT_TIMEZONE;
    try {
      const result = resolveTimezone();
      // Should return a valid IANA timezone
      expect(() => validateTimezone(result)).not.toThrow();
    } finally {
      if (original) {
        process.env.DEFAULT_TIMEZONE = original;
      }
    }
  });

  test("formatInTimezone converts UTC to Melbourne time", () => {
    // 2026-04-15T05:00:00Z = 3:00 PM AEST (April is standard time, +10)
    const result = formatInTimezone(
      "2026-04-15T05:00:00.000Z",
      "Australia/Melbourne"
    );
    expect(result).toContain("3:00:00 PM");
  });

  test("formatInTimezone converts UTC to London time", () => {
    // 2026-04-15T05:00:00Z = 6:00 AM BST (April is summer time, +1)
    const result = formatInTimezone(
      "2026-04-15T05:00:00.000Z",
      "Europe/London"
    );
    expect(result).toContain("6:00:00 AM");
  });

  test("buildVTimezone returns valid VTIMEZONE string", () => {
    const vtimezone = buildVTimezone("Australia/Melbourne");
    expect(vtimezone).toContain("BEGIN:VTIMEZONE");
    expect(vtimezone).toContain("TZID:Australia/Melbourne");
    expect(vtimezone).toContain("END:VTIMEZONE");
  });

  test("buildVTimezone result is parseable by ical.js", () => {
    const vtimezone = buildVTimezone("Europe/London");
    const comp = ICAL.Component.fromString(vtimezone);
    expect(comp.name).toBe("vtimezone");
    expect(comp.getFirstPropertyValue("tzid")).toBe("Europe/London");
  });

  test("registerTimezone creates usable ICAL.Timezone", () => {
    const tz = registerTimezone("America/New_York");
    expect(tz.tzid).toBe("America/New_York");

    // Create a time in this timezone
    const time = ICAL.Time.fromDateTimeString("2026-04-15T15:00:00");
    time.zone = tz;
    const utc = time.toJSDate().toISOString();
    // 3pm EDT (UTC-4 in April) = 7pm UTC
    expect(utc).toBe("2026-04-15T19:00:00.000Z");
  });

  test("registerTimezone is idempotent", () => {
    const tz1 = registerTimezone("Australia/Melbourne");
    const tz2 = registerTimezone("Australia/Melbourne");
    expect(tz1.tzid).toBe(tz2.tzid);
  });
});

// ── VCALENDAR generation with VTIMEZONE ──

describe("VCALENDAR generation with timezone", () => {
  test("creates event with TZID and VTIMEZONE", () => {
    const timezone = "Australia/Melbourne";
    const icalTz = registerTimezone(timezone);
    const vtimezoneStr = buildVTimezone(timezone);

    const vcalendar = new ICAL.Component(["vcalendar", [], []]);
    vcalendar.updatePropertyWithValue("prodid", "-//test//EN");
    vcalendar.updatePropertyWithValue("version", "2.0");
    vcalendar.addSubcomponent(ICAL.Component.fromString(vtimezoneStr));

    const vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", "tz-test-001");
    vevent.updatePropertyWithValue("summary", "Melbourne Meeting");

    const startTime = ICAL.Time.fromDateTimeString("2026-04-15T15:00:00");
    startTime.zone = icalTz;
    vevent.updatePropertyWithValue("dtstart", startTime);
    vevent.getFirstProperty("dtstart")!.setParameter("tzid", timezone);

    const endTime = ICAL.Time.fromDateTimeString("2026-04-15T16:00:00");
    endTime.zone = icalTz;
    vevent.updatePropertyWithValue("dtend", endTime);
    vevent.getFirstProperty("dtend")!.setParameter("tzid", timezone);

    vcalendar.addSubcomponent(vevent);
    const icalString = vcalendar.toString();

    // Verify the output contains TZID and VTIMEZONE
    expect(icalString).toContain("TZID=Australia/Melbourne");
    expect(icalString).toContain("BEGIN:VTIMEZONE");
    expect(icalString).toContain("TZID:Australia/Melbourne");

    // Round-trip: parse the output and verify timezone is preserved
    const parsed = parseVEvent(icalString);
    expect(parsed).not.toBeNull();
    expect(parsed!.start.timezone).toBe("Australia/Melbourne");
    // 3pm AEST (+10) = 5am UTC
    expect(parsed!.start.utc).toBe("2026-04-15T05:00:00.000Z");
  });
});

// ── VEVENT generation with RRULE (create side) ──
// Mirrors the approach used in CalDavProvider.createEvent():
// build a VEVENT, attach an ICAL.Recur rrule, serialize, then verify
// occurrences expand correctly via ICAL.Event.iterator().

function buildVeventWithRrule(
  timezone: string,
  startLocal: string,
  endLocal: string,
  rruleStr: string
): string {
  const icalTz = registerTimezone(timezone);
  const vtimezoneStr = buildVTimezone(timezone);

  const vcalendar = new ICAL.Component(["vcalendar", [], []]);
  vcalendar.updatePropertyWithValue("prodid", "-//test//EN");
  vcalendar.updatePropertyWithValue("version", "2.0");
  vcalendar.addSubcomponent(ICAL.Component.fromString(vtimezoneStr));

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", "rrule-test-001");
  vevent.updatePropertyWithValue("summary", "Standup");

  const startTime = ICAL.Time.fromDateTimeString(startLocal);
  startTime.zone = icalTz;
  vevent.updatePropertyWithValue("dtstart", startTime);
  vevent.getFirstProperty("dtstart")!.setParameter("tzid", timezone);

  const endTime = ICAL.Time.fromDateTimeString(endLocal);
  endTime.zone = icalTz;
  vevent.updatePropertyWithValue("dtend", endTime);
  vevent.getFirstProperty("dtend")!.setParameter("tzid", timezone);

  const recur = ICAL.Recur.fromString(rruleStr);
  vevent.updatePropertyWithValue("rrule", recur);

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}

describe("create-side RRULE", () => {
  test("WEEKLY BYDAY with COUNT expands to expected weekdays", () => {
    const rrule = buildRRule(
      {
        frequency: "WEEKLY",
        endType: "after",
        count: 6,
        byWeekday: ["MO", "WE", "FR"],
      },
      "Australia/Melbourne",
      false
    );
    // 2026-04-13 is a Monday
    const ics = buildVeventWithRrule(
      "Australia/Melbourne",
      "2026-04-13T09:00:00",
      "2026-04-13T09:15:00",
      rrule
    );

    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const event = new ICAL.Event(vevent);
    const iterator = event.iterator();

    const occs: Date[] = [];
    let next = iterator.next();
    while (next && occs.length < 20) {
      occs.push(next.toJSDate());
      next = iterator.next();
    }

    expect(occs).toHaveLength(6);
    // Mon 13, Wed 15, Fri 17, Mon 20, Wed 22, Fri 24 in Australia/Melbourne (AEST, +10 in April).
    // 9am Melbourne = 23:00 UTC the prior day, so UTC-date is one less.
    const days = occs.map((d) => d.getUTCDate());
    expect(days).toEqual([12, 14, 16, 19, 21, 23]);
    // And each occurrence's UTC weekday should be Sun/Tue/Thu
    const weekdays = occs.map((d) => d.getUTCDay());
    expect(weekdays).toEqual([0, 2, 4, 0, 2, 4]);
  });

  test("DAILY with UTC-converted UNTIL stops at the right instant", () => {
    const rrule = buildRRule(
      {
        frequency: "DAILY",
        endType: "on",
        until: "2026-04-17T09:00:00",
      },
      "Australia/Melbourne",
      false
    );
    const ics = buildVeventWithRrule(
      "Australia/Melbourne",
      "2026-04-13T09:00:00",
      "2026-04-13T09:15:00",
      rrule
    );

    const jcal = ICAL.parse(ics);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent("vevent")!;
    const event = new ICAL.Event(vevent);
    const iterator = event.iterator();

    const occs: Date[] = [];
    let next = iterator.next();
    while (next && occs.length < 20) {
      occs.push(next.toJSDate());
      next = iterator.next();
    }

    // 13, 14, 15, 16, 17 = 5 occurrences inclusive of UNTIL
    expect(occs).toHaveLength(5);
    expect(occs[0]!.toISOString()).toContain("2026-04-12T23:00:00");
  });

  test("localToUtc utility converts Melbourne time to UTC", () => {
    // 2026-04-15 3pm Melbourne (AEST, +10) = 5am UTC
    expect(localToUtc("2026-04-15T15:00:00", "Australia/Melbourne")).toBe(
      "2026-04-15T05:00:00.000Z"
    );
  });
});
