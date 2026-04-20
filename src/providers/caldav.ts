import { createDAVClient, type DAVCalendar } from "tsdav";
import ICAL from "ical.js";
import type {
  ServiceProvider,
  CalendarInfo,
  CalendarEvent,
  CreateEventInput,
  EventAttendee,
  TimezoneAwareTime,
} from "../types.js";
import {
  resolveTimezone,
  registerTimezone,
  buildVTimezone,
  localToUtc,
} from "../utils/timezone.js";
import { buildRRule } from "../utils/rrule.js";

// CalDAV is stateless HTTP with Basic auth per request.
// No persistent connection, no keepalive, no NOOP equivalent.
// ensureConnected() guards one-time PROPFIND discovery only.

type DAVClientInstance = Awaited<ReturnType<typeof createDAVClient>>;

export class CalDavProvider implements ServiceProvider {
  private client: DAVClientInstance | null = null;
  private connected = false;
  private calendarsCache: DAVCalendar[] | null = null;

  constructor(
    private serverUrl: string,
    private email: string,
    private password: string
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.client = await createDAVClient({
      serverUrl: this.serverUrl,
      credentials: {
        username: this.email,
        password: this.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.connected = false;
    this.calendarsCache = null;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    await this.ensureConnected();
    const rawCalendars = await this.client!.fetchCalendars();

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

    const objects = await this.client!.fetchCalendarObjects({
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

    const objects = await this.client!.fetchCalendarObjects({
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
    comp.updatePropertyWithValue("prodid", "-//icloud-bridge//v2.0.0//EN");
    comp.updatePropertyWithValue("version", "2.0");
    comp.updatePropertyWithValue("calscale", "GREGORIAN");

    const vevent = new ICAL.Component("vevent");
    vevent.updatePropertyWithValue("uid", uid);
    vevent.updatePropertyWithValue("summary", event.summary);
    vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());

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
      rruleStr = buildRRule(event.recurrence, timezone, !!event.isAllDay);
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

    const result = await this.client!.createCalendarObject({
      calendar: { url: calendarUrl } as DAVCalendar,
      filename: `${uid}.ics`,
      iCalString,
    });

    const resultObj = result as unknown as Record<string, unknown> | undefined;

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
      url: (resultObj?.url as string) ?? `${calendarUrl}${uid}.ics`,
      etag: resultObj?.etag as string | undefined,
    };
  }

  async deleteEvent(calendarUrl: string, uid: string): Promise<boolean> {
    await this.ensureConnected();

    // Fetch internally to get the object URL and etag (self-contained)
    const event = await this.getEvent(calendarUrl, uid);
    if (!event) {
      throw new Error(`Event with UID ${uid} not found`);
    }

    await this.client!.deleteCalendarObject({
      calendarObject: {
        url: event.url,
        etag: event.etag,
      },
    });

    return true;
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
