import type { RecurrenceInput, RecurrenceWeekday } from "../types.js";
import { localToUtc } from "./timezone.js";

const WEEKDAY_CODES: RecurrenceWeekday[] = [
  "SU",
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
];

/**
 * Derive the RFC 5545 two-letter weekday code (MO..SU) from a local
 * DTSTART as observed in the event's timezone. iCloud silently rejects
 * WEEKLY RRULEs that omit BYDAY, so we auto-populate it from DTSTART.
 */
export function weekdayOfStart(
  startLocalISO: string,
  timezone: string,
  isAllDay: boolean
): RecurrenceWeekday {
  const datePart = startLocalISO.split("T")[0] ?? startLocalISO;
  let instant: Date;
  if (isAllDay) {
    instant = new Date(`${datePart}T00:00:00Z`);
    return WEEKDAY_CODES[instant.getUTCDay()]!;
  }
  const utcIso = localToUtc(startLocalISO.replace(/Z$/, ""), timezone);
  instant = new Date(utcIso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const short = fmt.format(instant);
  const map: Record<string, RecurrenceWeekday> = {
    Sun: "SU",
    Mon: "MO",
    Tue: "TU",
    Wed: "WE",
    Thu: "TH",
    Fri: "FR",
    Sat: "SA",
  };
  const code = map[short];
  if (!code) {
    throw new Error(`Could not derive weekday from "${startLocalISO}" in ${timezone}`);
  }
  return code;
}

/**
 * Build an RFC 5545 RRULE property value (without the "RRULE:" prefix) from
 * a structured RecurrenceInput. ical.js prepends "RRULE:" during serialization.
 *
 * RFC 5545 gotcha: when DTSTART has a TZID, UNTIL MUST be in UTC basic form
 * (YYYYMMDDTHHMMSSZ). For all-day events, UNTIL is a DATE (YYYYMMDD).
 */
export function buildRRule(
  r: RecurrenceInput,
  timezone: string,
  isAllDay: boolean
): string {
  const parts: string[] = [`FREQ=${r.frequency}`];

  const interval = r.interval ?? 1;
  if (interval > 1) {
    parts.push(`INTERVAL=${interval}`);
  }

  if (r.byWeekday && r.byWeekday.length > 0) {
    parts.push(`BYDAY=${r.byWeekday.join(",")}`);
  }

  if (r.endType === "after") {
    if (r.count == null) {
      throw new Error("recurrence.endType='after' requires count");
    }
    parts.push(`COUNT=${r.count}`);
  } else if (r.endType === "on") {
    if (!r.until) {
      throw new Error("recurrence.endType='on' requires until");
    }
    parts.push(`UNTIL=${formatUntil(r.until, timezone, isAllDay)}`);
  }

  return parts.join(";");
}

function formatUntil(
  until: string,
  timezone: string,
  isAllDay: boolean
): string {
  if (isAllDay) {
    const datePart = until.split("T")[0] ?? until;
    return datePart.replace(/-/g, "");
  }

  const local = until.includes("T") ? until : `${until}T00:00:00`;
  const utcIso = localToUtc(local, timezone);
  return utcIso
    .replace(/\.\d+/, "")
    .replace(/[-:]/g, "");
}
