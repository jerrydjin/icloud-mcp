import type { RecurrenceInput } from "../types.js";
import { localToUtc } from "./timezone.js";

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
