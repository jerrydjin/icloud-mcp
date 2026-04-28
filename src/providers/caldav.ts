import ICAL from "ical.js";
import type {
  CalendarInfo,
  CalendarEvent,
  CreateEventInput,
  UpdateEventInput,
  RecurrenceInput,
  EventAttendee,
  TimezoneAwareTime,
} from "../types.js";
import {
  resolveTimezone,
  registerTimezone,
  buildVTimezone,
  localToUtc,
  utcToLocal,
} from "../utils/timezone.js";
import { buildRRule, weekdayOfStart } from "../utils/rrule.js";
import { CalDavTransport, type DAVCalendar } from "./caldav-transport.js";
import {
  requireOkAndEtag,
  requireOkAndEtagOrConflict,
  iCalErrorExcerpt,
} from "./icloud-quirks.js";

function isUtcTimezone(tz: string): boolean {
  const t = tz.toLowerCase();
  return t === "utc" || t === "etc/utc" || t === "gmt" || t === "etc/gmt";
}

export class CalDavProvider extends CalDavTransport {
  private calendarsCache: DAVCalendar[] | null = null;

  constructor(serverUrl: string, email: string, password: string) {
    super(serverUrl, email, password, "caldav");
  }

  protected override onDisconnect(): void {
    this.calendarsCache = null;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.ensureConnected();
    const rawCalendars = await this.dav.fetchCalendars();

    // Filter to VEVENT calendars only (excludes Reminders/VTODO).
    // If components is undefined, include the calendar (assume VEVENT).
    const veventCalendars = rawCalendars.filter(
      (cal) => !cal.components || cal.components.includes("VEVENT")
    );

    this.calendarsCache = veventCalendars;

    return veventCalendars.map((cal) => ({
      displayName: String(cal.displayName || "(unnamed)"),
      url: cal.url,
      color: cal.calendarColor as string | undefined,
      ctag: cal.ctag,
      description: cal.description,
    }));
  }

  async listEvents(
    calendarUrl: string,
    start: Date,
    end: Date
  ): Promise<CalendarEvent[]> {
    await this.ensureConnected();

    const calendarName = await this.getCalendarName(calendarUrl);

    const objects = await this.dav.fetchCalendarObjects({
      calendar: { url: calendarUrl } as DAVCalendar,
      timeRange: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
    });

    const events: CalendarEvent[] = [];

    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = this.parseVEvent(
          obj.data as string,
          calendarName,
          calendarUrl
        );
        if (parsed) {
          parsed.url = obj.url;
          parsed.etag = obj.etag;
          // Expand recurrences within the time range
          const expanded = this.expandRecurrences(
            parsed,
            obj.data as string,
            start,
            end
          );
          events.push(...expanded);
        }
      } catch {
        // Malformed VCALENDAR: skip with warning pattern (non-fatal)
        continue;
      }
    }

    // Sort by start time (using UTC instant)
    events.sort(
      (a, b) =>
        new Date(a.start.utc).getTime() - new Date(b.start.utc).getTime()
    );

    return events;
  }

  async getEvent(
    calendarUrl: string,
    uid: string
  ): Promise<CalendarEvent | null> {
    await this.ensureConnected();

    const calendarName = await this.getCalendarName(calendarUrl);

    const objects = await this.dav.fetchCalendarObjects({
      calendar: { url: calendarUrl } as DAVCalendar,
    });

    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = this.parseVEvent(
          obj.data as string,
          calendarName,
          calendarUrl
        );
        if (parsed && parsed.uid === uid) {
          parsed.url = obj.url;
          parsed.etag = obj.etag;
          return parsed;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async createEvent(
    calendarUrl: string,
    event: CreateEventInput
  ): Promise<CalendarEvent> {
    await this.ensureConnected();

    const timezone = resolveTimezone(event.timezone);

    // Reject ambiguous input: UTC (Z suffix) + explicit timezone
    if (
      event.timezone &&
      !event.isAllDay &&
      (event.start.endsWith("Z") || event.end.endsWith("Z"))
    ) {
      throw new Error(
        "Ambiguous input: UTC time (Z suffix) cannot be combined with a timezone parameter. " +
          "Either pass local time with a timezone, or pass UTC without a timezone."
      );
    }

    const uid = crypto.randomUUID();
    const calendarName = await this.getCalendarName(calendarUrl);

    // Build VCALENDAR with VTIMEZONE component
    const comp = new ICAL.Component(["vcalendar", [], []]);
    comp.updatePropertyWithValue("prodid", "-//icloud-mcp//v2.0.0//EN");
    comp.updatePropertyWithValue("version", "2.0");
    comp.updatePropertyWithValue("calscale", "GREGORIAN");

    const vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", uid);
    vevent.updatePropertyWithValue("summary", event.summary);
    // DTSTAMP/CREATED/LAST-MODIFIED MUST be UTC per RFC 5545.
    const nowStamp = ICAL.Time.fromJSDate(new Date(), true);
    vevent.updatePropertyWithValue("dtstamp", nowStamp);
    // iCloud expects these on recurring events; harmless for single events.
    vevent.updatePropertyWithValue("created", nowStamp);
    vevent.updatePropertyWithValue("last-modified", nowStamp);
    vevent.updatePropertyWithValue("sequence", 0);

    if (event.isAllDay) {
      // All-day events: DATE-only, no timezone (per RFC 5545)
      const startStr = event.start.split("T")[0] ?? event.start;
      const endStr = event.end.split("T")[0] ?? event.end;
      const startTime = ICAL.Time.fromDateString(startStr);
      startTime.isDate = true;
      vevent.updatePropertyWithValue("dtstart", startTime);

      const endTime = ICAL.Time.fromDateString(endStr);
      endTime.isDate = true;
      vevent.updatePropertyWithValue("dtend", endTime);
    } else if (isUtcTimezone(timezone)) {
      // UTC events: emit as Z-suffix DATE-TIME with no TZID or VTIMEZONE.
      // Avoids TZID/VTIMEZONE name mismatches (UTC vs Etc/UTC) that iCloud
      // rejects for recurring events.
      const startStr = event.start.replace(/Z$/, "");
      const endStr = event.end.replace(/Z$/, "");
      const startTime = ICAL.Time.fromDateTimeString(startStr);
      startTime.zone = ICAL.Timezone.utcTimezone;
      vevent.updatePropertyWithValue("dtstart", startTime);

      const endTime = ICAL.Time.fromDateTimeString(endStr);
      endTime.zone = ICAL.Timezone.utcTimezone;
      vevent.updatePropertyWithValue("dtend", endTime);
    } else {
      // Register timezone and add VTIMEZONE to VCALENDAR
      const icalTz = registerTimezone(timezone);
      const vtimezoneStr = buildVTimezone(timezone);
      comp.addSubcomponent(ICAL.Component.fromString(vtimezoneStr));

      // Strip Z suffix if present (for backward compat with UTC inputs)
      const startStr = event.start.replace(/Z$/, "");
      const endStr = event.end.replace(/Z$/, "");

      const startTime = ICAL.Time.fromDateTimeString(startStr);
      startTime.zone = icalTz;
      vevent.updatePropertyWithValue("dtstart", startTime);
      vevent.getFirstProperty("dtstart")!.setParameter("tzid", timezone);

      const endTime = ICAL.Time.fromDateTimeString(endStr);
      endTime.zone = icalTz;
      vevent.updatePropertyWithValue("dtend", endTime);
      vevent.getFirstProperty("dtend")!.setParameter("tzid", timezone);
    }

    let rruleStr: string | undefined;
    if (event.recurrence) {
      let recurrence = event.recurrence;
      // iCloud silently drops WEEKLY RRULEs without BYDAY; infer from DTSTART.
      if (
        recurrence.frequency === "WEEKLY" &&
        (!recurrence.byWeekday || recurrence.byWeekday.length === 0)
      ) {
        recurrence = {
          ...recurrence,
          byWeekday: [
            weekdayOfStart(event.start, timezone, !!event.isAllDay),
          ],
        };
      }
      rruleStr = buildRRule(recurrence, timezone, !!event.isAllDay);
      const recur = ICAL.Recur.fromString(rruleStr);
      vevent.updatePropertyWithValue("rrule", recur);
    }

    if (event.location) {
      vevent.updatePropertyWithValue("location", event.location);
    }
    if (event.description) {
      vevent.updatePropertyWithValue("description", event.description);
    }

    if (event.attendees) {
      for (const attendeeEmail of event.attendees) {
        const attendeeProp = vevent.addProperty(
          new ICAL.Property("attendee")
        );
        attendeeProp.setValue(`mailto:${attendeeEmail}`);
        attendeeProp.setParameter("rsvp", "TRUE");
        attendeeProp.setParameter("partstat", "NEEDS-ACTION");
      }
    }

    comp.addSubcomponent(vevent);
    const iCalString = comp.toString();

    const response = await this.dav.createCalendarObject({
      calendar: { url: calendarUrl } as DAVCalendar,
      filename: `${uid}.ics`,
      iCalString,
    });

    // iCloud quirk: tsdav returns a raw fetch Response on 4xx/5xx. We need 2xx + ETag
    // to confirm the write actually landed. requireOkAndEtag throws with a payload
    // excerpt when iCloud rejects (e.g., malformed RRULE).
    const etag = await requireOkAndEtag(response, iCalErrorExcerpt(iCalString));
    const resultUrl = response.url || `${calendarUrl}${uid}.ics`;

    // Build TimezoneAwareTime for the return value
    let startTz: TimezoneAwareTime;
    let endTz: TimezoneAwareTime;

    if (event.isAllDay) {
      startTz = { utc: event.start.split("T")[0] ?? event.start, timezone };
      endTz = { utc: event.end.split("T")[0] ?? event.end, timezone };
    } else {
      startTz = { utc: localToUtc(event.start, timezone), timezone };
      endTz = { utc: localToUtc(event.end, timezone), timezone };
    }

    return {
      uid,
      summary: event.summary,
      start: startTz,
      end: endTz,
      location: event.location,
      description: event.description,
      attendees: (event.attendees ?? []).map((e) => ({
        email: e,
        status: "NEEDS-ACTION",
      })),
      status: "CONFIRMED",
      isAllDay: event.isAllDay ?? false,
      recurrenceRule: rruleStr,
      calendarUrl,
      calendarName,
      url: resultUrl,
      etag,
    };
  }

  async deleteEvent(calendarUrl: string, uid: string): Promise<boolean> {
    await this.ensureConnected();

    // Fetch internally to get the object URL and etag (self-contained)
    const event = await this.getEvent(calendarUrl, uid);
    if (!event) {
      throw new Error(`Event with UID ${uid} not found`);
    }

    await this.dav.deleteCalendarObject({
      calendarObject: {
        url: event.url,
        etag: event.etag,
      },
    });

    return true;
  }

  async updateEvent(
    calendarUrl: string,
    uid: string,
    updates: UpdateEventInput
  ): Promise<CalendarEvent> {
    await this.ensureConnected();

    const existing = await this.getEvent(calendarUrl, uid);
    if (!existing) {
      throw new Error(`Event with UID ${uid} not found in calendar`);
    }
    if (!existing.etag) {
      throw new Error(
        `Event ${uid} has no ETag — cannot perform conditional update`
      );
    }

    const merged = mergeEventForUpdate(existing, updates);
    const iCalString = buildUpdatedVEventVCalendar(merged);

    const response = await this.dav.updateCalendarObject({
      calendarObject: {
        url: existing.url,
        data: iCalString,
        etag: existing.etag,
      },
    });

    const newEtag = await requireOkAndEtagOrConflict(
      response,
      iCalErrorExcerpt(iCalString)
    );

    // Build the return value. Convert merged local strings back to
    // TimezoneAwareTime for consistency with createEvent's return shape.
    let startTz: TimezoneAwareTime;
    let endTz: TimezoneAwareTime;
    if (merged.isAllDay) {
      startTz = {
        utc: merged.startLocal.split("T")[0] ?? merged.startLocal,
        timezone: merged.timezone,
      };
      endTz = {
        utc: merged.endLocal.split("T")[0] ?? merged.endLocal,
        timezone: merged.timezone,
      };
    } else if (isUtcTimezone(merged.timezone)) {
      startTz = { utc: merged.startLocal.replace(/Z$/, ""), timezone: merged.timezone };
      endTz = { utc: merged.endLocal.replace(/Z$/, ""), timezone: merged.timezone };
    } else {
      startTz = {
        utc: localToUtc(merged.startLocal, merged.timezone),
        timezone: merged.timezone,
      };
      endTz = {
        utc: localToUtc(merged.endLocal, merged.timezone),
        timezone: merged.timezone,
      };
    }

    return {
      uid: existing.uid,
      summary: merged.summary,
      start: startTz,
      end: endTz,
      location: merged.location,
      description: merged.description,
      attendees: merged.attendees.map((a) => ({
        email: a,
        status: "NEEDS-ACTION",
      })),
      status: existing.status,
      isAllDay: merged.isAllDay,
      recurrenceRule: merged.rruleStr,
      calendarUrl,
      calendarName: existing.calendarName,
      url: existing.url,
      etag: newEtag,
    };
  }

  async resolveCalendarUrl(nameOrUrl?: string): Promise<string> {
    const calendars = await this.listCalendars();

    if (calendars.length === 0) {
      throw new Error("No calendars found");
    }

    // No param: return default (first VEVENT calendar)
    if (!nameOrUrl) {
      return calendars[0]!.url;
    }

    // If it looks like a URL, use directly
    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
      return nameOrUrl;
    }

    // Match by display name (case-insensitive)
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

  private async getCalendarName(calendarUrl: string): Promise<string> {
    if (!this.calendarsCache) {
      await this.listCalendars();
    }
    const cal = this.calendarsCache?.find((c) => c.url === calendarUrl);
    return String(cal?.displayName || "(unnamed)");
  }

  private parseVEvent(
    vcalendarData: string,
    calendarName: string,
    calendarUrl: string
  ): CalendarEvent | null {
    const jcalData = ICAL.parse(vcalendarData);
    const comp = new ICAL.Component(jcalData);
    const vevent = comp.getFirstSubcomponent("vevent");

    if (!vevent) return null;

    const event = new ICAL.Event(vevent);

    // Preserve timezone from DTSTART/DTEND
    const startDate = event.startDate;
    const endDate = event.endDate;
    const isAllDay = startDate.isDate;

    // Extract TZID: from the zone property, or fall back to UTC/default
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

    // Extract attendees
    const attendees: EventAttendee[] = [];
    const attendeeProps = vevent.getAllProperties("attendee");
    for (const prop of attendeeProps) {
      const val = prop.getFirstValue();
      const emailStr =
        typeof val === "string" ? val.replace("mailto:", "") : "";
      const cn = prop.getParameter("cn");
      const partstat = prop.getParameter("partstat");
      attendees.push({
        name: typeof cn === "string" ? cn : undefined,
        email: emailStr,
        status: typeof partstat === "string" ? partstat : undefined,
      });
    }

    // Extract recurrence rule
    const rruleProp = vevent.getFirstProperty("rrule");
    let recurrenceRule: string | undefined;
    if (rruleProp) {
      const rruleVal = rruleProp.getFirstValue();
      recurrenceRule = rruleVal ? String(rruleVal) : undefined;
    }

    const statusVal = vevent.getFirstPropertyValue("status");

    return {
      uid: event.uid,
      summary: event.summary || "(no title)",
      start,
      end,
      location: event.location || undefined,
      description: event.description || undefined,
      attendees,
      status: statusVal ? String(statusVal) : undefined,
      isAllDay,
      recurrenceRule,
      calendarUrl,
      calendarName,
      url: "", // filled in by caller
      etag: undefined, // filled in by caller
    };
  }

  private expandRecurrences(
    masterEvent: CalendarEvent,
    vcalendarData: string,
    start: Date,
    end: Date
  ): CalendarEvent[] {
    // No recurrence rule: return the master event as-is
    if (!masterEvent.recurrenceRule) {
      return [masterEvent];
    }

    try {
      const jcalData = ICAL.parse(vcalendarData);
      const comp = new ICAL.Component(jcalData);
      const vevent = comp.getFirstSubcomponent("vevent");
      if (!vevent) return [masterEvent];

      const event = new ICAL.Event(vevent);
      const iterator = event.iterator();
      const events: CalendarEvent[] = [];
      const rangeStart = ICAL.Time.fromJSDate(start);
      const rangeEnd = ICAL.Time.fromJSDate(end);

      // Expand up to 200 occurrences to prevent runaway
      let count = 0;
      let next = iterator.next();
      while (next && count < 200) {
        if (next.compare(rangeEnd) > 0) break;

        if (next.compare(rangeStart) >= 0) {
          const duration = event.duration;
          const occEnd = next.clone();
          occEnd.addDuration(duration);

          // Each occurrence inherits the master event's timezone
          const occTzid = masterEvent.start.timezone;
          events.push({
            ...masterEvent,
            start: masterEvent.isAllDay
              ? { utc: next.toString(), timezone: occTzid }
              : { utc: next.toJSDate().toISOString(), timezone: occTzid },
            end: masterEvent.isAllDay
              ? { utc: occEnd.toString(), timezone: occTzid }
              : { utc: occEnd.toJSDate().toISOString(), timezone: occTzid },
          });
        }

        next = iterator.next();
        count++;
      }

      return events.length > 0 ? events : [masterEvent];
    } catch {
      // Recurrence expansion failed: return master event
      return [masterEvent];
    }
  }
}

// ── Pure functions for update_event (extracted for testability) ──

export interface MergedEventForUpdate {
  uid: string;
  summary: string;
  startLocal: string; // ISO local-ish string ready for VEVENT emission (no Z)
  endLocal: string;
  timezone: string;
  isAllDay: boolean;
  location?: string;
  description?: string;
  attendees: string[];
  recurrence?: RecurrenceInput;
  rruleStr?: string;
  sequence: number;
}

/**
 * Merge an existing CalendarEvent with an UpdateEventInput. Preserves fields
 * the caller didn't touch; clears nullable fields when null is passed; replaces
 * arrays entirely when provided.
 *
 * Recurring events: only the master is updated. RECURRENCE-ID handling for
 * single-occurrence overrides is NOT supported in v3.
 *
 * SEQUENCE bumps to existing+1 on every update (per iCloud quirk Q4).
 */
export function mergeEventForUpdate(
  existing: CalendarEvent,
  updates: UpdateEventInput
): MergedEventForUpdate {
  const summary = updates.summary ?? existing.summary;

  const isAllDay = updates.isAllDay ?? existing.isAllDay;
  const timezone = resolveTimezone(updates.timezone ?? existing.start.timezone);

  // Flipping isAllDay without providing start/end is ambiguous — the time-of-day
  // information needed for a non-all-day event isn't recoverable from a date-only
  // existing event, and vice versa. Require the caller to be explicit.
  if (
    updates.isAllDay !== undefined &&
    updates.isAllDay !== existing.isAllDay &&
    (!updates.start || !updates.end)
  ) {
    throw new Error(
      `Cannot change isAllDay from ${existing.isAllDay} to ${updates.isAllDay} without providing new start AND end times. The time-of-day information needed for the new mode isn't derivable from the existing event.`
    );
  }

  // Compute the local-ish strings we'll emit. Three cases:
  //  - User explicitly set start/end: use as-is (assume local in `timezone`)
  //  - All-day: use date portion of existing UTC
  //  - Otherwise: convert existing UTC back to local in the original timezone
  let startLocal: string;
  let endLocal: string;
  if (updates.start) {
    startLocal = updates.start.replace(/Z$/, "");
  } else if (isAllDay) {
    startLocal = existing.start.utc.split("T")[0] ?? existing.start.utc;
  } else if (isUtcTimezone(existing.start.timezone)) {
    startLocal = existing.start.utc.replace(/Z$/, "");
  } else {
    startLocal = utcToLocal(existing.start.utc, existing.start.timezone);
  }
  if (updates.end) {
    endLocal = updates.end.replace(/Z$/, "");
  } else if (isAllDay) {
    endLocal = existing.end.utc.split("T")[0] ?? existing.end.utc;
  } else if (isUtcTimezone(existing.end.timezone)) {
    endLocal = existing.end.utc.replace(/Z$/, "");
  } else {
    endLocal = utcToLocal(existing.end.utc, existing.end.timezone);
  }

  const location =
    updates.location === null
      ? undefined
      : updates.location !== undefined
        ? updates.location
        : existing.location;
  const description =
    updates.description === null
      ? undefined
      : updates.description !== undefined
        ? updates.description
        : existing.description;

  // Attendees: undefined preserves, [] clears, array replaces.
  const attendees = updates.attendees
    ? [...updates.attendees]
    : existing.attendees.map((a) => a.email).filter(Boolean);

  // Recurrence: undefined preserves existing rrule string, null clears,
  // RecurrenceInput replaces. We re-derive the RRULE string from the input.
  let recurrence: RecurrenceInput | undefined;
  let rruleStr: string | undefined;
  if (updates.recurrence === null) {
    recurrence = undefined;
    rruleStr = undefined;
  } else if (updates.recurrence) {
    recurrence = updates.recurrence;
    if (
      recurrence.frequency === "WEEKLY" &&
      (!recurrence.byWeekday || recurrence.byWeekday.length === 0)
    ) {
      recurrence = {
        ...recurrence,
        byWeekday: [weekdayOfStart(startLocal, timezone, isAllDay)],
      };
    }
    rruleStr = buildRRule(recurrence, timezone, isAllDay);
  } else {
    // Preserve existing recurrence by passing through the raw RRULE string.
    rruleStr = existing.recurrenceRule;
  }

  return {
    uid: existing.uid,
    summary,
    startLocal,
    endLocal,
    timezone,
    isAllDay,
    location,
    description,
    attendees,
    recurrence,
    rruleStr,
    sequence: 1, // iCloud accepts any monotonically-increasing SEQUENCE; "1" beats "0".
  };
}

/**
 * Build a VCALENDAR/VEVENT iCalendar string from a merged update result.
 * Mirrors the createEvent emission logic with iCloud quirks applied.
 */
function buildUpdatedVEventVCalendar(merged: MergedEventForUpdate): string {
  const comp = new ICAL.Component(["vcalendar", [], []]);
  comp.updatePropertyWithValue("prodid", "-//icloud-mcp//v3//EN");
  comp.updatePropertyWithValue("version", "2.0");
  comp.updatePropertyWithValue("calscale", "GREGORIAN");

  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", merged.uid);
  vevent.updatePropertyWithValue("summary", merged.summary);

  // DTSTAMP/CREATED/LAST-MODIFIED MUST be UTC (Q3). We don't have CREATED from
  // the existing event so we use now for both. iCloud treats these advisorily
  // anyway — what matters is DTSTAMP, which represents when the iCalendar was
  // generated, not when the event was created.
  const nowStamp = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue("dtstamp", nowStamp);
  vevent.updatePropertyWithValue("last-modified", nowStamp);
  vevent.updatePropertyWithValue("sequence", merged.sequence);

  if (merged.isAllDay) {
    const startStr = merged.startLocal.split("T")[0] ?? merged.startLocal;
    const endStr = merged.endLocal.split("T")[0] ?? merged.endLocal;
    const startTime = ICAL.Time.fromDateString(startStr);
    startTime.isDate = true;
    vevent.updatePropertyWithValue("dtstart", startTime);
    const endTime = ICAL.Time.fromDateString(endStr);
    endTime.isDate = true;
    vevent.updatePropertyWithValue("dtend", endTime);
  } else if (isUtcTimezone(merged.timezone)) {
    const startTime = ICAL.Time.fromDateTimeString(merged.startLocal);
    startTime.zone = ICAL.Timezone.utcTimezone;
    vevent.updatePropertyWithValue("dtstart", startTime);
    const endTime = ICAL.Time.fromDateTimeString(merged.endLocal);
    endTime.zone = ICAL.Timezone.utcTimezone;
    vevent.updatePropertyWithValue("dtend", endTime);
  } else {
    const icalTz = registerTimezone(merged.timezone);
    const vtimezoneStr = buildVTimezone(merged.timezone);
    comp.addSubcomponent(ICAL.Component.fromString(vtimezoneStr));
    const startTime = ICAL.Time.fromDateTimeString(merged.startLocal);
    startTime.zone = icalTz;
    vevent.updatePropertyWithValue("dtstart", startTime);
    vevent.getFirstProperty("dtstart")!.setParameter("tzid", merged.timezone);
    const endTime = ICAL.Time.fromDateTimeString(merged.endLocal);
    endTime.zone = icalTz;
    vevent.updatePropertyWithValue("dtend", endTime);
    vevent.getFirstProperty("dtend")!.setParameter("tzid", merged.timezone);
  }

  if (merged.rruleStr) {
    const recur = ICAL.Recur.fromString(merged.rruleStr);
    vevent.updatePropertyWithValue("rrule", recur);
  }
  if (merged.location) {
    vevent.updatePropertyWithValue("location", merged.location);
  }
  if (merged.description) {
    vevent.updatePropertyWithValue("description", merged.description);
  }
  for (const attendeeEmail of merged.attendees) {
    const attendeeProp = vevent.addProperty(new ICAL.Property("attendee"));
    attendeeProp.setValue(`mailto:${attendeeEmail}`);
    attendeeProp.setParameter("rsvp", "TRUE");
    attendeeProp.setParameter("partstat", "NEEDS-ACTION");
  }

  comp.addSubcomponent(vevent);
  return comp.toString();
}
