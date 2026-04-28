import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarEvent } from "../types.js";
import type { Contact } from "../providers/contacts.js";
import { canonicalEmail, sameEmail } from "../utils/identity.js";
import {
  type VerbContext,
  type VerbResult,
  type VerbError,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";

// ── schedule: create a calendar event with attendee resolution + conflict detection ──
//
// v3 schedule takes an explicit start time. Free-slot search ("find me time
// next Tuesday afternoon") is intentionally NOT in scope — the LLM can pick a
// specific time after seeing the user's calendar, and that's a cleaner
// separation than building a slot-search engine into this verb.
//
// What schedule DOES do:
//  - Resolve attendees by name OR email (same semantics as the draft verb)
//  - Detect conflicts: events in any user calendar overlapping [start, end]
//  - Create the event via caldavProvider.createEvent
//  - Return { event, conflicts, unresolved } so the LLM can ask the user to
//    confirm if conflicts exist
//
// On unresolved attendees, the event is NOT created (matches draft semantics).
// Conflicts DO NOT block creation — they're informational; the LLM decides
// whether to warn the user.

export interface ScheduleResult {
  event?: CalendarEvent;
  conflicts: CalendarEvent[];
  unresolved: { input: string; reason: string; candidates?: string[] }[];
  resolvedAttendees: string[];
  success: boolean;
}

export function registerScheduleVerb(
  server: McpServer,
  ctx: VerbContext
): void {
  server.tool(
    "schedule",
    "Create a calendar event. Each attendee can be a literal email or a contact name (resolved via Contacts). Conflicts in the user's calendars during [start, end] are returned alongside the created event so the LLM can warn the user if needed. On any unresolved attendee, the event is NOT created.",
    {
      title: z.string().describe("Event title (SUMMARY)"),
      start: z
        .string()
        .describe(
          "Start time (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      durationMin: z
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .optional()
        .describe(
          "Duration in minutes. Default 30. Use this OR `end`, not both."
        ),
      end: z
        .string()
        .optional()
        .describe(
          "End time (ISO 8601 local). Use this OR `durationMin`, not both."
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
      attendees: z
        .array(z.string())
        .optional()
        .describe(
          "Attendees. Each entry is either an email or a contact name to look up."
        ),
      location: z.string().optional().describe("Event location"),
      description: z.string().optional().describe("Event description"),
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary VEVENT calendar)"
        ),
    },
    async (input) => {
      try {
        const result = await scheduleHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("schedule", error);
      }
    }
  );
}

async function scheduleHandler(
  input: {
    title: string;
    start: string;
    durationMin?: number;
    end?: string;
    timezone?: string;
    attendees?: string[];
    location?: string;
    description?: string;
    calendar?: string;
  },
  ctx: VerbContext
): Promise<VerbResult<ScheduleResult>> {
  const errors: VerbError[] = [];
  const unresolved: ScheduleResult["unresolved"] = [];

  // Resolve attendees
  const resolvedAttendees = input.attendees
    ? await resolveAttendees(input.attendees, ctx, unresolved, errors)
    : [];

  if (unresolved.length > 0) {
    return {
      items: {
        conflicts: [],
        unresolved,
        resolvedAttendees,
        success: false,
      },
      degraded: true,
      errors,
      userMessage: `${unresolved.length} attendee(s) couldn't be resolved. Ask the user to clarify before retrying: ${unresolved
        .map((u) => `'${u.input}' (${u.reason})`)
        .join("; ")}`,
    };
  }

  // Compute end if duration is provided
  const startStripped = input.start.replace(/Z$/, "");
  let endStripped: string;
  if (input.end) {
    endStripped = input.end.replace(/Z$/, "");
  } else {
    const durationMin = input.durationMin ?? 30;
    endStripped = addMinutesToLocal(startStripped, durationMin);
  }

  // Detect conflicts BEFORE creating (informational; doesn't block)
  let conflicts: CalendarEvent[] = [];
  try {
    conflicts = await detectConflicts(
      ctx,
      startStripped,
      endStripped,
      input.timezone
    );
  } catch (e) {
    errors.push({
      source: "calendar",
      message: `Conflict detection failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    // Continue with creation even if conflict check failed
  }

  // Resolve target calendar
  const calendarUrl = await ctx.caldav.resolveCalendarUrl(input.calendar);

  // Create the event
  const event = await ctx.caldav.createEvent(calendarUrl, {
    summary: input.title,
    start: startStripped,
    end: endStripped,
    timezone: input.timezone,
    location: input.location,
    description: input.description,
    attendees: resolvedAttendees,
  });

  const userMessage =
    conflicts.length > 0
      ? `Event created, but it overlaps with ${conflicts.length} other event(s) in your calendar. Tell the user about the conflict so they can adjust if needed.`
      : undefined;

  return {
    items: {
      event,
      conflicts,
      unresolved: [],
      resolvedAttendees,
      success: true,
    },
    degraded: errors.length > 0,
    errors,
    userMessage,
  };
}

/**
 * Detect calendar events that overlap [start, end] across all user calendars.
 * Pure conflict detection — informational only.
 */
async function detectConflicts(
  ctx: VerbContext,
  startLocal: string,
  endLocal: string,
  timezone?: string
): Promise<CalendarEvent[]> {
  const calendars = await ctx.caldav.listCalendars();

  // Convert local times to UTC for the listEvents range query
  let startUtc: Date;
  let endUtc: Date;
  if (timezone) {
    const { localToUtc } = await import("../utils/timezone.js");
    startUtc = new Date(localToUtc(startLocal, timezone));
    endUtc = new Date(localToUtc(endLocal, timezone));
  } else {
    startUtc = new Date(startLocal);
    endUtc = new Date(endLocal);
  }

  const eventResults = await Promise.allSettled(
    calendars.map((cal) => ctx.caldav.listEvents(cal.url, startUtc, endUtc))
  );

  const conflicts: CalendarEvent[] = [];
  const startMs = startUtc.getTime();
  const endMs = endUtc.getTime();

  for (const r of eventResults) {
    if (r.status !== "fulfilled") continue;
    for (const event of r.value) {
      // Skip declined events
      if (event.status === "CANCELLED") continue;
      const eventStart = new Date(event.start.utc).getTime();
      const eventEnd = new Date(event.end.utc).getTime();
      // Overlap check: A and B overlap iff A.start < B.end and B.start < A.end
      if (eventStart < endMs && startMs < eventEnd) {
        conflicts.push(event);
      }
    }
  }

  return conflicts;
}

/**
 * Add minutes to an ISO local time string. Returns a new ISO local string.
 * Pure function — exported for testing.
 */
export function addMinutesToLocal(localISO: string, minutes: number): string {
  // Parse without timezone interpretation: interpret as a "local" wallclock
  // and add minutes. We avoid Date() roundtrips because Date assumes the
  // local timezone of the JS runtime, which may not match the user's
  // intended event timezone.
  const match = localISO.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/
  );
  if (!match) {
    throw new Error(`Invalid ISO local datetime: ${localISO}`);
  }
  const [, y, mo, d, h, mi, s, fr] = match;
  const totalMinutes =
    parseInt(h!, 10) * 60 + parseInt(mi!, 10) + minutes;
  const dayOffset = Math.floor(totalMinutes / (24 * 60));
  const remMin = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const newH = String(Math.floor(remMin / 60)).padStart(2, "0");
  const newMi = String(remMin % 60).padStart(2, "0");

  // Day arithmetic via Date (UTC) — safe since we're not crossing DST
  // boundaries for the date portion (only the wallclock).
  const baseDate = new Date(
    Date.UTC(parseInt(y!, 10), parseInt(mo!, 10) - 1, parseInt(d!, 10))
  );
  baseDate.setUTCDate(baseDate.getUTCDate() + dayOffset);
  const newY = baseDate.getUTCFullYear();
  const newMo = String(baseDate.getUTCMonth() + 1).padStart(2, "0");
  const newD = String(baseDate.getUTCDate()).padStart(2, "0");

  const seconds = s ? `:${s}${fr ? `.${fr}` : ""}` : ":00";
  return `${newY}-${newMo}-${newD}T${newH}:${newMi}${seconds}`;
}

// ── Attendee resolution (similar to draft, but emits ATTENDEE-shaped strings) ──

async function resolveAttendees(
  inputs: string[],
  ctx: VerbContext,
  unresolved: ScheduleResult["unresolved"],
  errors: VerbError[]
): Promise<string[]> {
  const out: string[] = [];

  for (const raw of inputs) {
    const entry = raw.trim();
    if (!entry) continue;

    if (looksLikeEmail(entry)) {
      // Don't add the user themselves as an attendee
      if (sameEmail(entry, ctx.email)) continue;
      out.push(entry);
      continue;
    }

    let matches: Contact[] = [];
    try {
      matches = await ctx.contacts.searchContacts(entry);
    } catch (e) {
      errors.push({
        source: "contacts",
        message: `Contacts lookup for '${entry}' failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      unresolved.push({ input: entry, reason: "contacts_lookup_failed" });
      continue;
    }

    if (matches.length === 0) {
      unresolved.push({ input: entry, reason: "no_match" });
      continue;
    }

    if (matches.length > 1) {
      const candidates = matches.slice(0, 5).map((c) => {
        const primary = c.emails.find((e) => e.preferred) ?? c.emails[0];
        return `${c.fullName}${primary ? ` <${primary.address}>` : ""}`;
      });
      unresolved.push({ input: entry, reason: "ambiguous", candidates });
      continue;
    }

    const contact = matches[0]!;
    const primary = contact.emails.find((e) => e.preferred) ?? contact.emails[0];
    if (!primary) {
      unresolved.push({
        input: entry,
        reason: "contact_has_no_email",
        candidates: [contact.fullName],
      });
      continue;
    }
    const canonical = canonicalEmail(primary.address) || primary.address;
    if (sameEmail(canonical, ctx.email)) continue; // skip self
    out.push(canonical);
  }

  return out;
}

function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}
