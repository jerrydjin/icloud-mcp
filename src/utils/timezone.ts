import { tzlib_get_ical_block } from "timezones-ical-library";
import ICAL from "ical.js";

/**
 * Three-tier timezone resolution cascade:
 * 1. Explicit parameter (per-call)
 * 2. DEFAULT_TIMEZONE env var
 * 3. OS timezone via Intl.DateTimeFormat (fresh each call, not cached)
 */
export function resolveTimezone(explicit?: string): string {
  if (explicit) {
    validateTimezone(explicit);
    return explicit;
  }
  const envTz = process.env.DEFAULT_TIMEZONE;
  if (envTz) {
    validateTimezone(envTz);
    return envTz;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Format a UTC instant as a local time string in the given timezone.
 */
export function formatInTimezone(utcISO: string, timezone: string): string {
  const date = new Date(utcISO);
  return date.toLocaleString("en-US", { timeZone: timezone });
}

/**
 * Generate an RFC 5545 VTIMEZONE string for the given IANA timezone.
 * Returns the raw VTIMEZONE block parseable by ICAL.Component.fromString().
 */
export function buildVTimezone(timezone: string): string {
  const result = tzlib_get_ical_block(timezone);
  if (!result || !result[0]) {
    throw new Error(
      `No VTIMEZONE data available for timezone: "${timezone}"`
    );
  }
  return result[0];
}

/**
 * Register an IANA timezone with ical.js TimezoneService.
 * Returns the ICAL.Timezone instance for use with ICAL.Time.
 */
export function registerTimezone(timezone: string): ICAL.Timezone {
  const existing = ICAL.TimezoneService.get(timezone);
  if (existing && existing.tzid === timezone) {
    return existing;
  }
  const vtimezoneStr = buildVTimezone(timezone);
  const comp = ICAL.Component.fromString(vtimezoneStr);
  const icalTz = new ICAL.Timezone({ component: comp });
  ICAL.TimezoneService.register(timezone, icalTz);
  return icalTz;
}

/**
 * Convert a local time string in a given timezone to a UTC ISO string.
 */
export function localToUtc(localISO: string, timezone: string): string {
  const icalTz = registerTimezone(timezone);
  const time = ICAL.Time.fromDateTimeString(localISO.replace(/Z$/, ""));
  time.zone = icalTz;
  return time.toJSDate().toISOString();
}

/**
 * Convert a UTC ISO string to a local time string (no Z suffix) in the given timezone.
 * Inverse of localToUtc. Used by update_event to preserve original timezone display
 * when the caller doesn't change start/end.
 */
export function utcToLocal(utcISO: string, timezone: string): string {
  const icalTz = registerTimezone(timezone);
  const utcTime = ICAL.Time.fromDateTimeString(utcISO.replace(/Z$/, ""));
  utcTime.zone = ICAL.Timezone.utcTimezone;
  const localTime = utcTime.convertToZone(icalTz);
  return localTime.toString();
}

/**
 * Validate that a string is a valid IANA timezone identifier.
 */
export function validateTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(
      `Invalid IANA timezone: "${tz}". Use format like "Australia/Melbourne" or "Europe/London".`
    );
  }
}
