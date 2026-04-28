import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalDavProvider } from "../providers/caldav.js";
import type { CalendarEvent } from "../types.js";
import { resolveTimezone, formatInTimezone } from "../utils/timezone.js";

const RecurrenceSchema = z
  .object({
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z
      .number()
      .int()
      .positive()
      .max(365)
      .optional()
      .describe("Repeat every N units of frequency (default 1)"),
    endType: z
      .enum(["never", "after", "on"])
      .describe(
        "How the recurrence ends: 'never' (no end), 'after' (count), or 'on' (until)"
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Number of occurrences when endType='after'"),
    until: z
      .string()
      .optional()
      .describe(
        "ISO local date or datetime when endType='on'. Interpreted in the event's timezone."
      ),
    byWeekday: z
      .array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
      .optional()
      .describe(
        "Weekdays to repeat on (WEEKLY only). E.g., ['MO','WE','FR']."
      ),
  })
  .refine((r) => r.endType !== "after" || r.count != null, {
    message: "recurrence.endType='after' requires count",
  })
  .refine((r) => r.endType !== "on" || r.until != null, {
    message: "recurrence.endType='on' requires until",
  })
  .refine((r) => !(r.count != null && r.until != null), {
    message: "count and until are mutually exclusive (RFC 5545)",
  })
  .refine(
    (r) => !r.byWeekday?.length || r.frequency === "WEEKLY",
    { message: "byWeekday is only supported with frequency='WEEKLY'" }
  );

function formatEventForDisplay(event: CalendarEvent, displayTimezone: string) {
  return {
    ...event,
    startDisplay: event.isAllDay
      ? event.start.utc
      : formatInTimezone(event.start.utc, displayTimezone),
    endDisplay: event.isAllDay
      ? event.end.utc
      : formatInTimezone(event.end.utc, displayTimezone),
    displayTimezone,
  };
}

export function registerCalendarTools(
  server: McpServer,
  caldavProvider: CalDavProvider
) {
  server.tool(
    "list_calendars",
    "List all iCloud calendars (excludes Reminders/VTODO collections)",
    {},
    async () => {
      try {
        const calendars = await caldavProvider.listCalendars();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ calendars }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list calendars: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_events",
    "List calendar events within a time range. Defaults to today if no range specified. Times are displayed in the requested timezone.",
    {
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary calendar)"
        ),
      start: z
        .string()
        .optional()
        .describe("Start of range (ISO 8601). Defaults to start of today."),
      end: z
        .string()
        .optional()
        .describe("End of range (ISO 8601). Defaults to end of today."),
      limit: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum events to return (max 200)"),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for display (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
    },
    async ({ calendar, start, end, limit, timezone }) => {
      try {
        const calendarUrl = await caldavProvider.resolveCalendarUrl(calendar);
        const displayTz = resolveTimezone(timezone);

        const now = new Date();
        const startDate = start
          ? new Date(start)
          : new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endDate = end
          ? new Date(end)
          : new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

        const events = await caldavProvider.listEvents(
          calendarUrl,
          startDate,
          endDate
        );
        const limited = events.slice(0, limit);
        const displayed = limited.map((e) =>
          formatEventForDisplay(e, displayTz)
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { events: displayed, total: events.length, displayTimezone: displayTz },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list events: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_event",
    "Get full details of a calendar event by UID. Times are displayed in the requested timezone.",
    {
      uid: z.string().describe("Event UID"),
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary calendar)"
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for display (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
    },
    async ({ uid, calendar, timezone }) => {
      try {
        const calendarUrl = await caldavProvider.resolveCalendarUrl(calendar);
        const displayTz = resolveTimezone(timezone);
        const event = await caldavProvider.getEvent(calendarUrl, uid);

        if (!event) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Event with UID "${uid}" not found`,
              },
            ],
            isError: true,
          };
        }

        const displayed = formatEventForDisplay(event, displayTz);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(displayed, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to get event: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_event",
    "Create a new calendar event on iCloud Calendar. Pass local time + timezone (e.g., start='2026-04-15T15:00:00', timezone='Australia/Melbourne').",
    {
      summary: z.string().describe("Event title"),
      start: z
        .string()
        .describe(
          "Start time (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      end: z
        .string()
        .describe(
          "End time (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary calendar)"
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g., 'Australia/Melbourne'). Event times are interpreted in this timezone. Defaults to system timezone."
        ),
      location: z.string().optional().describe("Event location"),
      description: z.string().optional().describe("Event description"),
      attendees: z
        .array(z.string())
        .optional()
        .describe("Attendee email addresses"),
      isAllDay: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether this is an all-day event"),
      recurrence: RecurrenceSchema.optional().describe(
        "Make this a repeating event. Provide frequency + endType, plus count (for endType='after') or until (for endType='on'). Omit for a single event."
      ),
    },
    async ({ summary, start, end, calendar, timezone, location, description, attendees, isAllDay, recurrence }) => {
      try {
        const calendarUrl = await caldavProvider.resolveCalendarUrl(calendar);
        const event = await caldavProvider.createEvent(calendarUrl, {
          summary,
          start,
          end,
          timezone,
          location,
          description,
          attendees,
          isAllDay,
          calendar,
          recurrence,
        });

        const displayTz = resolveTimezone(timezone);
        const displayed = formatEventForDisplay(event, displayTz);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { uid: event.uid, success: true, event: displayed },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create event: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_event",
    "Modify an existing calendar event. Only fields you provide are changed; others are preserved. Supports rescheduling (start/end), retitling (summary), adding/replacing attendees, changing location/description, and replacing or clearing recurrence (pass recurrence:null to clear). Uses ETag conditional PUT — throws a clear error if the event was modified elsewhere since you last read it.",
    {
      uid: z.string().describe("Event UID"),
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary calendar)"
        ),
      summary: z.string().optional().describe("New event title"),
      start: z
        .string()
        .optional()
        .describe(
          "New start time (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      end: z
        .string()
        .optional()
        .describe(
          "New end time (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for the new start/end. Preserves the existing timezone if not provided."
        ),
      location: z
        .string()
        .nullable()
        .optional()
        .describe("New location. Pass null to clear, omit to preserve existing."),
      description: z
        .string()
        .nullable()
        .optional()
        .describe("New description. Pass null to clear, omit to preserve existing."),
      attendees: z
        .array(z.string())
        .optional()
        .describe(
          "Replace the attendee list with these email addresses. Pass [] to clear, omit to preserve existing."
        ),
      isAllDay: z
        .boolean()
        .optional()
        .describe("Change all-day flag. Omit to preserve existing."),
      recurrence: RecurrenceSchema.nullable()
        .optional()
        .describe(
          "Replace recurrence rule. Pass null to clear, omit to preserve existing."
        ),
    },
    async ({
      uid,
      calendar,
      summary,
      start,
      end,
      timezone,
      location,
      description,
      attendees,
      isAllDay,
      recurrence,
    }) => {
      try {
        const calendarUrl = await caldavProvider.resolveCalendarUrl(calendar);
        const event = await caldavProvider.updateEvent(calendarUrl, uid, {
          summary,
          start,
          end,
          timezone,
          location,
          description,
          attendees,
          isAllDay,
          recurrence,
        });

        const displayTz = resolveTimezone(timezone ?? event.start.timezone);
        const displayed = formatEventForDisplay(event, displayTz);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { uid: event.uid, success: true, event: displayed },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const conflictHint = msg.includes("412")
          ? " The event was modified by another client since you read it. Re-fetch and retry with the new ETag."
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update event: ${msg}${conflictHint}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_event",
    "Delete a calendar event by UID. Fetches the event internally to resolve the CalDAV object URL.",
    {
      uid: z.string().describe("Event UID"),
      calendar: z
        .string()
        .optional()
        .describe(
          "Calendar display name or URL (default: primary calendar)"
        ),
    },
    async ({ uid, calendar }) => {
      try {
        const calendarUrl = await caldavProvider.resolveCalendarUrl(calendar);
        await caldavProvider.deleteEvent(calendarUrl, uid);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to delete event: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
