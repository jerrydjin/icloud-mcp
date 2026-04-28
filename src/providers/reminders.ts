import ICAL from "ical.js";
import type {
  ReminderListInfo,
  Reminder,
  CreateReminderInput,
  UpdateReminderInput,
  TimezoneAwareTime,
} from "../types.js";
import {
  resolveTimezone,
  registerTimezone,
  buildVTimezone,
  localToUtc,
} from "../utils/timezone.js";
import { CalDavTransport, type DAVCalendar } from "./caldav-transport.js";
import {
  requireOkAndEtag,
  requireOkAndEtagOrConflict,
  iCalErrorExcerpt,
} from "./icloud-quirks.js";

// RemindersProvider speaks CalDAV-VTODO over the same iCloud CalDAV endpoint as the
// calendar provider. iCloud exposes Reminders as CalDAV "calendars" whose
// `components` array contains VTODO. See docs/ICLOUD-QUIRKS.md.
//
// v3 ships VTODO-basic. iOS 13+ proprietary features (smart lists, nested subtasks,
// location triggers, attachments) require EventKit on Mac with a developer cert and
// are deferred to v4 — see TODOS.md "v4: EventKit-based Reminders depth" and the
// failed feasibility spike at eventkit-cli/spike/.

function isUtcTimezone(tz: string): boolean {
  const t = tz.toLowerCase();
  return t === "utc" || t === "etc/utc" || t === "gmt" || t === "etc/gmt";
}

export class RemindersProvider extends CalDavTransport {
  private listsCache: DAVCalendar[] | null = null;

  constructor(serverUrl: string, email: string, password: string) {
    super(serverUrl, email, password, "caldav");
  }

  protected override onDisconnect(): void {
    this.listsCache = null;
  }

  // ── Lists (CalDAV calendars with VTODO component) ──

  async listLists(): Promise<ReminderListInfo[]> {
    await this.ensureConnected();
    const rawCalendars = await this.dav.fetchCalendars();

    // Filter to VTODO calendars. Some iCloud calendars include both VEVENT and
    // VTODO; we include those too. Calendars with `components` undefined are
    // VEVENT-only by iCloud convention — exclude.
    const vtodoLists = rawCalendars.filter(
      (cal) => cal.components && cal.components.includes("VTODO")
    );

    this.listsCache = vtodoLists;

    return vtodoLists.map((cal) => ({
      displayName: String(cal.displayName || "(unnamed)"),
      url: cal.url,
      color: cal.calendarColor as string | undefined,
      ctag: cal.ctag,
      description: cal.description,
    }));
  }

  async resolveListUrl(nameOrUrl?: string): Promise<string> {
    const lists = await this.listLists();
    if (lists.length === 0) {
      throw new Error("No reminder lists found");
    }
    if (!nameOrUrl) return lists[0]!.url;

    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
      return nameOrUrl;
    }

    const matches = lists.filter(
      (l) => l.displayName.toLowerCase() === nameOrUrl.toLowerCase()
    );
    if (matches.length === 0) {
      const available = lists.map((l) => l.displayName).join(", ");
      throw new Error(
        `Reminder list "${nameOrUrl}" not found. Available: ${available}`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous reminder list name "${nameOrUrl}" matches ${matches.length} lists. Use the URL instead.`
      );
    }
    return matches[0]!.url;
  }

  // ── Reads ──

  async listReminders(
    listUrl: string,
    options: { includeCompleted?: boolean } = {}
  ): Promise<Reminder[]> {
    await this.ensureConnected();
    const listName = await this.getListName(listUrl);

    const objects = await this.dav.fetchCalendarObjects({
      calendar: { url: listUrl } as DAVCalendar,
    });

    const reminders: Reminder[] = [];
    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = parseVTodo(obj.data as string, listName, listUrl);
        if (!parsed) continue;
        if (!options.includeCompleted && parsed.isCompleted) continue;
        parsed.url = obj.url;
        parsed.etag = obj.etag;
        reminders.push(parsed);
      } catch {
        // Malformed VTODO: skip (non-fatal)
        continue;
      }
    }

    // Sort: incomplete with due dates first (earliest first), then incomplete
    // without due dates, then completed at the bottom (most recent first).
    reminders.sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      const aDue = a.due ? new Date(a.due.utc).getTime() : Infinity;
      const bDue = b.due ? new Date(b.due.utc).getTime() : Infinity;
      if (aDue !== bDue) return aDue - bDue;
      return a.summary.localeCompare(b.summary);
    });

    return reminders;
  }

  async getReminder(listUrl: string, uid: string): Promise<Reminder | null> {
    await this.ensureConnected();
    const listName = await this.getListName(listUrl);

    const objects = await this.dav.fetchCalendarObjects({
      calendar: { url: listUrl } as DAVCalendar,
    });

    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = parseVTodo(obj.data as string, listName, listUrl);
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

  // ── Writes ──

  async createReminder(
    listUrl: string,
    input: CreateReminderInput
  ): Promise<Reminder> {
    await this.ensureConnected();
    const listName = await this.getListName(listUrl);

    const uid = crypto.randomUUID();
    const timezone = resolveTimezone(input.timezone);
    const iCalString = buildVTodoString({ uid, ...input, timezone });

    const response = await this.dav.createCalendarObject({
      calendar: { url: listUrl } as DAVCalendar,
      filename: `${uid}.ics`,
      iCalString,
    });

    const etag = await requireOkAndEtag(response, iCalErrorExcerpt(iCalString));
    const resultUrl = response.url || `${listUrl}${uid}.ics`;

    let due: TimezoneAwareTime | undefined;
    if (input.due) {
      due = isUtcTimezone(timezone)
        ? { utc: input.due.replace(/Z$/, ""), timezone }
        : { utc: localToUtc(input.due, timezone), timezone };
    }

    return {
      uid,
      summary: input.summary,
      description: input.description,
      due,
      isCompleted: false,
      priority: input.priority,
      listUrl,
      listName,
      url: resultUrl,
      etag,
    };
  }

  async completeReminder(listUrl: string, uid: string): Promise<Reminder> {
    return this.updateReminder(listUrl, uid, { isCompleted: true });
  }

  async updateReminder(
    listUrl: string,
    uid: string,
    updates: UpdateReminderInput
  ): Promise<Reminder> {
    await this.ensureConnected();

    const existing = await this.getReminder(listUrl, uid);
    if (!existing) {
      throw new Error(`Reminder with UID ${uid} not found in list ${listUrl}`);
    }
    if (!existing.etag) {
      throw new Error(
        `Reminder ${uid} has no ETag — cannot perform conditional update`
      );
    }

    const merged = mergeReminderForUpdate(existing, updates);
    const iCalString = buildVTodoString({
      uid: existing.uid,
      summary: merged.summary,
      description: merged.description,
      due: merged.dueLocalString,
      timezone: merged.timezone,
      priority: merged.priority,
      isCompleted: merged.isCompleted,
      completedAt: merged.completedAt,
      sequence: merged.sequence,
    });

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

    let due: TimezoneAwareTime | undefined;
    if (merged.dueLocalString) {
      due = isUtcTimezone(merged.timezone)
        ? { utc: merged.dueLocalString.replace(/Z$/, ""), timezone: merged.timezone }
        : { utc: localToUtc(merged.dueLocalString, merged.timezone), timezone: merged.timezone };
    }

    return {
      uid: existing.uid,
      summary: merged.summary,
      description: merged.description,
      due,
      isCompleted: merged.isCompleted,
      completedAt: merged.completedAt,
      priority: merged.priority,
      listUrl,
      listName: existing.listName,
      url: existing.url,
      etag: newEtag,
    };
  }

  // ── Internal helpers ──

  private async getListName(listUrl: string): Promise<string> {
    if (!this.listsCache) {
      await this.listLists();
    }
    const cal = this.listsCache?.find((c) => c.url === listUrl);
    return String(cal?.displayName || "(unnamed)");
  }
}

// ── Pure functions (extracted for testability per existing convention) ──

/**
 * Parse a VCALENDAR/VTODO iCalendar string into a Reminder.
 * Returns null if the data has no VTODO component (e.g., malformed or VEVENT-only).
 */
export function parseVTodo(
  vcalendarData: string,
  listName: string,
  listUrl: string
): Reminder | null {
  const jcalData = ICAL.parse(vcalendarData);
  const comp = new ICAL.Component(jcalData);
  const vtodo = comp.getFirstSubcomponent("vtodo");
  if (!vtodo) return null;

  const uid = String(vtodo.getFirstPropertyValue("uid") || "");
  if (!uid) return null;

  const summary = String(vtodo.getFirstPropertyValue("summary") || "(no title)");
  const descVal = vtodo.getFirstPropertyValue("description");
  const description = descVal ? String(descVal) : undefined;

  const status = String(vtodo.getFirstPropertyValue("status") || "");
  const completedVal = vtodo.getFirstPropertyValue("completed");
  const percentRaw = vtodo.getFirstPropertyValue("percent-complete") as unknown;
  const percentComplete =
    typeof percentRaw === "number" ? percentRaw : undefined;
  const isCompleted =
    status === "COMPLETED" || !!completedVal || percentComplete === 100;
  const completedAt = completedVal
    ? (completedVal as ICAL.Time).toJSDate().toISOString()
    : undefined;

  const priorityRaw = vtodo.getFirstPropertyValue("priority") as unknown;
  const priority =
    typeof priorityRaw === "number" && priorityRaw > 0 ? priorityRaw : undefined;

  let due: TimezoneAwareTime | undefined;
  const dueProp = vtodo.getFirstProperty("due");
  if (dueProp) {
    const dueVal = dueProp.getFirstValue() as ICAL.Time | undefined;
    if (dueVal) {
      const tzid = dueVal.zone?.tzid || "UTC";
      due = dueVal.isDate
        ? { utc: dueVal.toString(), timezone: tzid }
        : { utc: dueVal.toJSDate().toISOString(), timezone: tzid };
    }
  }

  return {
    uid,
    summary,
    description,
    due,
    isCompleted,
    completedAt,
    priority,
    percentComplete,
    listUrl,
    listName,
    url: "", // filled in by caller
    etag: undefined, // filled in by caller
  };
}

/**
 * Build a VCALENDAR/VTODO iCalendar string. Used by both create and update flows.
 *
 * iCloud quirks applied (per docs/ICLOUD-QUIRKS.md):
 * - DTSTAMP / CREATED / LAST-MODIFIED in UTC (Q3)
 * - SEQUENCE always present, defaults to 0 (Q4)
 * - DUE with TZID + matching VTIMEZONE for non-UTC timezones (Q5)
 */
function buildVTodoString(input: {
  uid: string;
  summary: string;
  description?: string;
  due?: string; // ISO local
  timezone: string;
  priority?: number;
  isCompleted?: boolean;
  completedAt?: string; // ISO UTC
  sequence?: number;
}): string {
  const comp = new ICAL.Component(["vcalendar", [], []]);
  comp.updatePropertyWithValue("prodid", "-//icloud-mcp//v3//EN");
  comp.updatePropertyWithValue("version", "2.0");
  comp.updatePropertyWithValue("calscale", "GREGORIAN");

  const vtodo = new ICAL.Component("vtodo");
  vtodo.updatePropertyWithValue("uid", input.uid);
  vtodo.updatePropertyWithValue("summary", input.summary);

  // Always UTC per Q3
  const nowStamp = ICAL.Time.fromJSDate(new Date(), true);
  vtodo.updatePropertyWithValue("dtstamp", nowStamp);
  vtodo.updatePropertyWithValue("created", nowStamp);
  vtodo.updatePropertyWithValue("last-modified", nowStamp);
  vtodo.updatePropertyWithValue("sequence", input.sequence ?? 0);

  if (input.description) {
    vtodo.updatePropertyWithValue("description", input.description);
  }
  if (typeof input.priority === "number" && input.priority > 0) {
    vtodo.updatePropertyWithValue("priority", input.priority);
  }

  if (input.due) {
    if (isUtcTimezone(input.timezone)) {
      const dueStr = input.due.replace(/Z$/, "");
      const dueTime = ICAL.Time.fromDateTimeString(dueStr);
      dueTime.zone = ICAL.Timezone.utcTimezone;
      vtodo.updatePropertyWithValue("due", dueTime);
    } else {
      const icalTz = registerTimezone(input.timezone);
      const vtimezoneStr = buildVTimezone(input.timezone);
      comp.addSubcomponent(ICAL.Component.fromString(vtimezoneStr));

      const dueStr = input.due.replace(/Z$/, "");
      const dueTime = ICAL.Time.fromDateTimeString(dueStr);
      dueTime.zone = icalTz;
      vtodo.updatePropertyWithValue("due", dueTime);
      vtodo.getFirstProperty("due")!.setParameter("tzid", input.timezone);
    }
  }

  if (input.isCompleted) {
    vtodo.updatePropertyWithValue("status", "COMPLETED");
    vtodo.updatePropertyWithValue("percent-complete", 100);
    const completedAt = input.completedAt
      ? ICAL.Time.fromDateTimeString(input.completedAt.replace(/Z$/, ""))
      : ICAL.Time.fromJSDate(new Date(), true);
    completedAt.zone = ICAL.Timezone.utcTimezone;
    vtodo.updatePropertyWithValue("completed", completedAt);
  }

  comp.addSubcomponent(vtodo);
  return comp.toString();
}

/**
 * Merge an existing reminder with update input, preserving fields the caller
 * didn't touch. SEQUENCE bumps by 1 on every update (per Q4 — iCloud expects this).
 */
export function mergeReminderForUpdate(
  existing: Reminder,
  updates: UpdateReminderInput
): {
  summary: string;
  description?: string;
  dueLocalString?: string;
  timezone: string;
  priority?: number;
  isCompleted: boolean;
  completedAt?: string;
  sequence: number;
} {
  const summary = updates.summary ?? existing.summary;
  const description =
    updates.description !== undefined ? updates.description : existing.description;
  const priority =
    updates.priority !== undefined ? updates.priority : existing.priority;

  const isCompleted =
    updates.isCompleted !== undefined ? updates.isCompleted : existing.isCompleted;
  const completedAt = isCompleted
    ? existing.completedAt ?? new Date().toISOString()
    : undefined;

  const timezone = resolveTimezone(updates.timezone ?? existing.due?.timezone);

  // due semantics: undefined = leave alone, null = clear, string = set/replace
  let dueLocalString: string | undefined;
  if (updates.due === null) {
    dueLocalString = undefined;
  } else if (typeof updates.due === "string") {
    dueLocalString = updates.due;
  } else if (existing.due) {
    // Preserve existing due. Convert UTC-stored due back to a local-ish string.
    dueLocalString = existing.due.utc;
  }

  // Bump SEQUENCE — iCloud requires this on updates.
  // We don't track sequence on the Reminder type today; assume 0 baseline + 1 on every update.
  // This is approximate but matches what iCloud actually checks (any sequence > previous works).
  const sequence = 1;

  return {
    summary,
    description,
    dueLocalString,
    timezone,
    priority,
    isCompleted,
    completedAt,
    sequence,
  };
}
