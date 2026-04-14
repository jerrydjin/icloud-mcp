import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImapProvider } from "../providers/imap.ts";
import type { SmtpProvider } from "../providers/smtp.ts";
import type { CalDavProvider } from "../providers/caldav.ts";
import type { CalendarEvent, MessageSummary } from "../types.ts";

export function registerCrossTools(
  server: McpServer,
  imapProvider: ImapProvider,
  smtpProvider: SmtpProvider,
  caldavProvider: CalDavProvider,
  email: string
) {
  server.tool(
    "daily_brief",
    "Get a combined daily overview: all calendar events across all calendars + unread mail summary. One tool call, full morning context.",
    {
      date: z
        .string()
        .optional()
        .describe("Date to brief (ISO 8601 date, default: today)"),
    },
    async ({ date }) => {
      const now = new Date();
      const targetDate = date ? new Date(date) : now;
      const dayStart = new Date(
        targetDate.getFullYear(),
        targetDate.getMonth(),
        targetDate.getDate()
      );
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      // Fetch calendars first, then fan out events across all of them
      let allEvents: CalendarEvent[] = [];
      let calendarError: string | undefined;
      let nextEvent: CalendarEvent | undefined;

      try {
        const calendars = await caldavProvider.listCalendars();
        const eventResults = await Promise.allSettled(
          calendars.map((cal) =>
            caldavProvider.listEvents(cal.url, dayStart, dayEnd)
          )
        );

        for (const result of eventResults) {
          if (result.status === "fulfilled") {
            allEvents.push(...result.value);
          }
        }

        // Sort by start time
        allEvents.sort(
          (a, b) =>
            new Date(a.start).getTime() - new Date(b.start).getTime()
        );

        // Find next upcoming event
        const nowTime = now.getTime();
        nextEvent = allEvents.find(
          (e) => !e.isAllDay && new Date(e.start).getTime() > nowTime
        );

        const failedCount = eventResults.filter(
          (r) => r.status === "rejected"
        ).length;
        if (failedCount > 0) {
          calendarError = `${failedCount} calendar(s) failed to fetch`;
        }
      } catch (error) {
        calendarError = `Calendar fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }

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

      const brief: Record<string, unknown> = {
        date: dayStart.toISOString().split("T")[0],
        calendar: {
          events: allEvents,
          eventCount: allEvents.length,
          nextEvent: nextEvent ?? null,
          ...(calendarError ? { error: calendarError } : {}),
        },
        mail: {
          unreadCount,
          flaggedCount,
          recentMessages,
          ...(mailError ? { error: mailError } : {}),
        },
      };

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
          recipients = recipients.filter(
            (addr) => addr.toLowerCase() !== email.toLowerCase()
          );
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
