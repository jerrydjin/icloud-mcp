import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImapProvider } from "../providers/imap.js";
import type { SmtpProvider } from "../providers/smtp.js";
import type { CalDavProvider } from "../providers/caldav.js";
import type { RemindersProvider } from "../providers/reminders.js";
import type { ContactsProvider } from "../providers/contacts.js";
import type { IdentityResolver } from "../providers/identity-cache.js";
import type { CalendarEvent, MessageSummary, Reminder } from "../types.js";
import { resolveTimezone, formatInTimezone } from "../utils/timezone.js";
import { sameEmail } from "../utils/identity.js";

/**
 * Get the UTC offset in milliseconds for a given date and timezone.
 * Positive means ahead of UTC (e.g., +11h for AEDT).
 */
function getTimezoneOffsetMs(dateStr: string, timezone: string): number {
  // Create a date at midnight UTC for the given date
  const utcDate = new Date(dateStr + "T00:00:00Z");
  // Format that UTC instant in the target timezone to get the local representation
  const localStr = utcDate.toLocaleString("en-US", { timeZone: timezone });
  const localDate = new Date(localStr);
  // The difference tells us the offset
  return localDate.getTime() - utcDate.getTime();
}

/**
 * Pure function that composes the daily_brief response object. Extracted for
 * testability and to enforce the R1 regression contract: v2 callers must see
 * `date`, `displayTimezone`, `calendar.events[]`, `calendar.eventCount`,
 * `calendar.nextEvent`, `mail.unreadCount`, `mail.flaggedCount`, and
 * `mail.recentMessages` exactly as before. v3 adds the `reminders` section.
 */
export function composeDailyBrief(input: {
  date: string;
  displayTimezone: string;
  events: Array<CalendarEvent & { startDisplay?: string; endDisplay?: string }>;
  eventCount: number;
  nextEvent: (CalendarEvent & { startDisplay?: string; endDisplay?: string }) | null;
  calendarError?: string;
  unreadCount: number;
  flaggedCount: number;
  recentMessages: MessageSummary[];
  mailError?: string;
  reminders: Reminder[];
  overdueCount: number;
  dueTodayCount: number;
  reminderListCount: number;
  reminderError?: string;
}): Record<string, unknown> {
  const displayedReminders = input.reminders.map((r) => ({
    ...r,
    dueDisplay: r.due ? formatInTimezone(r.due.utc, input.displayTimezone) : null,
  }));

  return {
    date: input.date,
    displayTimezone: input.displayTimezone,
    calendar: {
      events: input.events,
      eventCount: input.eventCount,
      nextEvent: input.nextEvent,
      ...(input.calendarError ? { error: input.calendarError } : {}),
    },
    mail: {
      unreadCount: input.unreadCount,
      flaggedCount: input.flaggedCount,
      recentMessages: input.recentMessages,
      ...(input.mailError ? { error: input.mailError } : {}),
    },
    reminders: {
      items: displayedReminders,
      overdueCount: input.overdueCount,
      dueTodayCount: input.dueTodayCount,
      listCount: input.reminderListCount,
      ...(input.reminderError ? { error: input.reminderError } : {}),
    },
  };
}

export function registerCrossTools(
  server: McpServer,
  imapProvider: ImapProvider,
  smtpProvider: SmtpProvider,
  caldavProvider: CalDavProvider,
  remindersProvider: RemindersProvider,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _contactsProvider: ContactsProvider,
  identityResolver: IdentityResolver,
  email: string
) {
  server.tool(
    "daily_brief",
    "Cross-service morning overview: today's calendar events + unread mail + overdue/due-today reminders. One tool call returns everything Claude needs to triage your day. v2 callers see all original fields preserved; v3 adds a `reminders` section. Times displayed in your timezone.",
    {
      date: z
        .string()
        .optional()
        .describe("Date to brief (ISO 8601 date, default: today)"),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for display and day boundaries (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
    },
    async ({ date, timezone }) => {
      const displayTz = resolveTimezone(timezone);
      const now = new Date();

      // Determine the target date string (YYYY-MM-DD) in the display timezone
      const dateStr =
        date ||
        now.toLocaleDateString("en-CA", { timeZone: displayTz });

      // Compute midnight in the target timezone as a UTC instant
      // Midnight local = midnight UTC minus the timezone offset
      const offsetMs = getTimezoneOffsetMs(dateStr, displayTz);
      const dayStartUtc = new Date(
        new Date(dateStr + "T00:00:00Z").getTime() - offsetMs
      );
      const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60 * 1000);

      // Fetch calendars first, then fan out events across all of them
      let allEvents: CalendarEvent[] = [];
      let calendarError: string | undefined;
      let nextEvent: (CalendarEvent & { startDisplay?: string; endDisplay?: string }) | undefined;

      try {
        const calendars = await caldavProvider.listCalendars();
        const eventResults = await Promise.allSettled(
          calendars.map((cal) =>
            caldavProvider.listEvents(cal.url, dayStartUtc, dayEndUtc)
          )
        );

        for (const result of eventResults) {
          if (result.status === "fulfilled") {
            allEvents.push(...result.value);
          }
        }

        // Sort by start time (UTC instant)
        allEvents.sort(
          (a, b) =>
            new Date(a.start.utc).getTime() - new Date(b.start.utc).getTime()
        );

        // Find next upcoming event
        const nowTime = now.getTime();
        nextEvent = allEvents.find(
          (e) => !e.isAllDay && new Date(e.start.utc).getTime() > nowTime
        );
        if (nextEvent) {
          nextEvent = {
            ...nextEvent,
            startDisplay: formatInTimezone(nextEvent.start.utc, displayTz),
            endDisplay: formatInTimezone(nextEvent.end.utc, displayTz),
          };
        }

        const failedCount = eventResults.filter(
          (r) => r.status === "rejected"
        ).length;
        if (failedCount > 0) {
          calendarError = `${failedCount} calendar(s) failed to fetch`;
        }
      } catch (error) {
        calendarError = `Calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      // Add display times to all events
      const displayedEvents = allEvents.map((e) => ({
        ...e,
        startDisplay: e.isAllDay
          ? e.start.utc
          : formatInTimezone(e.start.utc, displayTz),
        endDisplay: e.isAllDay
          ? e.end.utc
          : formatInTimezone(e.end.utc, displayTz),
      }));

      // Fetch mail in parallel
      let unreadCount = 0;
      let flaggedCount = 0;
      let recentMessages: MessageSummary[] = [];
      let mailError: string | undefined;

      const mailResults = await Promise.allSettled([
        imapProvider.listMessages("INBOX", 10, 0),
        imapProvider.search("INBOX", { unseen: true }, 100),
        imapProvider.search("INBOX", { flagged: true }, 100),
      ]);

      if (mailResults[0].status === "fulfilled") {
        recentMessages = mailResults[0].value.messages.filter((m) =>
          m.flags ? !m.flags.includes("\\Seen") : true
        );
      } else {
        mailError = `Mail fetch failed: ${(mailResults[0] as PromiseRejectedResult).reason}`;
      }

      if (mailResults[1].status === "fulfilled") {
        unreadCount = mailResults[1].value.total;
      }
      if (mailResults[2].status === "fulfilled") {
        flaggedCount = mailResults[2].value.total;
      }

      // Fetch reminders (v3 chief-of-staff): overdue + due-today across all lists
      let dueReminders: Reminder[] = [];
      let reminderListCount = 0;
      let overdueCount = 0;
      let dueTodayCount = 0;
      let reminderError: string | undefined;

      try {
        const lists = await remindersProvider.listLists();
        reminderListCount = lists.length;
        const listResults = await Promise.allSettled(
          lists.map((l) => remindersProvider.listReminders(l.url))
        );

        const allReminders: Reminder[] = [];
        let failedLists = 0;
        for (const r of listResults) {
          if (r.status === "fulfilled") allReminders.push(...r.value);
          else failedLists++;
        }
        if (failedLists > 0) {
          reminderError = `${failedLists} reminder list(s) failed to fetch`;
        }

        const dayEndUtcMs = dayEndUtc.getTime();
        const nowMs = now.getTime();

        for (const r of allReminders) {
          if (r.isCompleted) continue;
          if (!r.due) continue; // Skip undated reminders for the "today" brief
          const dueMs = new Date(r.due.utc).getTime();
          if (dueMs < nowMs) overdueCount++;
          else if (dueMs < dayEndUtcMs) dueTodayCount++;
          else continue; // Future reminders not in scope for today's brief
          dueReminders.push(r);
        }

        dueReminders.sort(
          (a, b) =>
            new Date(a.due!.utc).getTime() - new Date(b.due!.utc).getTime()
        );
        // Cap at 50 to keep the brief readable
        dueReminders = dueReminders.slice(0, 50);
      } catch (error) {
        reminderError = `Reminders fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      const brief = composeDailyBrief({
        date: dateStr,
        displayTimezone: displayTz,
        events: displayedEvents,
        eventCount: allEvents.length,
        nextEvent: nextEvent ?? null,
        calendarError,
        unreadCount,
        flaggedCount,
        recentMessages,
        mailError,
        reminders: dueReminders,
        overdueCount,
        dueTodayCount,
        reminderListCount,
        reminderError,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(brief, null, 2),
          },
        ],
      };
    }
  );

  // v4 M4.1 admin tool: invalidate the identity resolver's per-request Contacts
  // cache. Useful during stdio dogfooding when you've just edited a Contact and
  // want the next verb call to pick up the change without restarting the server.
  // On Vercel the cache is per-request anyway, so this is a no-op there in
  // practice but stays available for parity.
  server.tool(
    "identity_cache_flush",
    "Drop the identity resolver's Contacts cache. The next verb call will refetch Contacts. Use after editing a contact in the iCloud Contacts app if a long-lived MCP session is showing stale name/email resolutions.",
    {},
    async () => {
      identityResolver.flush();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ flushed: true }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "email_attendees",
    "Send an email to all attendees of a calendar event. Automatically extracts attendee emails from the event and sends via SMTP.",
    {
      eventUid: z.string().describe("UID of the calendar event"),
      calendar: z
        .string()
        .optional()
        .describe("Calendar display name or URL (default: primary calendar)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      excludeSelf: z
        .boolean()
        .optional()
        .default(true)
        .describe("Exclude your own email from recipients (default: true)"),
      from: z
        .string()
        .optional()
        .describe("Send from this alias address. Defaults to primary iCloud email."),
      fromName: z
        .string()
        .optional()
        .describe("Display name for the From header."),
    },
    async ({ eventUid, calendar, subject, body, excludeSelf, from, fromName }) => {
      try {
        const calendarUrl =
          await caldavProvider.resolveCalendarUrl(calendar);
        const event = await caldavProvider.getEvent(calendarUrl, eventUid);

        if (!event) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Event with UID "${eventUid}" not found`,
              },
            ],
            isError: true,
          };
        }

        if (event.attendees.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "This event has no attendees to email.",
              },
            ],
            isError: true,
          };
        }

        // Filter recipients
        let recipients = event.attendees
          .map((a) => a.email)
          .filter(Boolean);

        if (excludeSelf) {
          recipients = recipients.filter((addr) => !sameEmail(addr, email));
        }

        if (recipients.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No recipients after filtering (all attendees may be you).",
              },
            ],
            isError: true,
          };
        }

        const result = await smtpProvider.send({
          to: recipients,
          subject,
          body,
          from,
          fromName,
        });

        // Format event time in its original timezone for the response
        const eventTimeTz = event.start.timezone;
        const eventTimeDisplay = event.isAllDay
          ? event.start.utc
          : formatInTimezone(event.start.utc, eventTimeTz);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...result,
                  recipientCount: recipients.length,
                  recipients,
                  eventSummary: event.summary,
                  eventTime: eventTimeDisplay,
                  eventTimezone: eventTimeTz,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isConnectionError =
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("socket");
        const errorText = isConnectionError
          ? `Send may have failed — check your Sent folder before resending. Error: ${msg}`
          : `Failed to email attendees: ${msg}`;
        return {
          content: [{ type: "text" as const, text: errorText }],
          isError: true,
        };
      }
    }
  );
}
