import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RemindersProvider } from "../providers/reminders.js";
import type { Reminder } from "../types.js";
import { resolveTimezone, formatInTimezone } from "../utils/timezone.js";

// Per-service Reminders tools (v4.4).
//
// v3's ENG-5 decision routed Reminders access exclusively through cross-service
// verbs (daily_brief / find / triage). That kept the tool count low but left no
// direct surface: there was no way to create a reminder, complete one, or list a
// specific list without going through a verb that wanted a different job done.
// These tools restore parity with the Mail and Calendar per-service surface. The
// verbs still own the cross-service composition.
//
// `update_reminder` also subsumes the old `defer` verb (removed in v4.4):
// defer(uid, until) was update_reminder(uid, due) with an all-lists UID search,
// which this file does too.
//
// VTODO-basic only, same as the provider — iOS 13+ smart lists, nested subtasks,
// location triggers, and attachments are not exposed over CalDAV. See
// docs/ICLOUD-QUIRKS.md and TODOS.md.

/**
 * A VTODO DUE can be a date-only value (all-day reminder), which parseVTodo
 * stores verbatim as "YYYY-MM-DD" rather than as a UTC instant. Running that
 * through formatInTimezone would shift it across a day boundary, so date-only
 * dues are passed through untouched.
 */
function isDateOnly(utc: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(utc);
}

export function formatReminderForDisplay(
  reminder: Reminder,
  displayTimezone: string,
  now: Date = new Date()
) {
  let dueDisplay: string | null = null;
  let isOverdue = false;

  if (reminder.due) {
    dueDisplay = isDateOnly(reminder.due.utc)
      ? reminder.due.utc
      : formatInTimezone(reminder.due.utc, displayTimezone);

    if (!reminder.isCompleted) {
      const dueMs = new Date(reminder.due.utc).getTime();
      isOverdue = !Number.isNaN(dueMs) && dueMs < now.getTime();
    }
  }

  return { ...reminder, dueDisplay, isOverdue, displayTimezone };
}

export function registerReminderTools(
  server: McpServer,
  remindersProvider: RemindersProvider
) {
  server.tool(
    "list_reminder_lists",
    "List all iCloud Reminders lists (CalDAV collections containing VTODO). Use the returned displayName or url as the `list` argument to the other reminder tools.",
    {},
    async () => {
      try {
        const lists = await remindersProvider.listLists();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ lists, total: lists.length }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list reminder lists: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_reminders",
    "List reminders in a list. Incomplete reminders come first (earliest due date first), then undated, then completed. Completed reminders are excluded unless includeCompleted is true. Times are displayed in the requested timezone.",
    {
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL (default: first VTODO list). Pass 'all' to search every list."
        ),
      includeCompleted: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include completed reminders (default: false)"),
      limit: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum reminders to return (max 200)"),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for display (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
    },
    async ({ list, includeCompleted, limit, timezone }) => {
      try {
        const displayTz = resolveTimezone(timezone);
        const now = new Date();

        let reminders: Reminder[];
        let listErrors: string[] = [];

        if (list?.toLowerCase() === "all") {
          // Fan out across every list. A single failing list degrades that list
          // only — matching daily_brief's per-source error handling.
          const lists = await remindersProvider.listLists();
          const results = await Promise.allSettled(
            lists.map((l) =>
              remindersProvider.listReminders(l.url, { includeCompleted })
            )
          );
          reminders = [];
          results.forEach((r, i) => {
            if (r.status === "fulfilled") reminders.push(...r.value);
            else
              listErrors.push(
                `${lists[i]?.displayName ?? "(unknown)"}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
              );
          });
          reminders.sort((a, b) => {
            if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
            const aDue = a.due ? new Date(a.due.utc).getTime() : Infinity;
            const bDue = b.due ? new Date(b.due.utc).getTime() : Infinity;
            if (aDue !== bDue) return aDue - bDue;
            return a.summary.localeCompare(b.summary);
          });
        } else {
          const listUrl = await remindersProvider.resolveListUrl(list);
          reminders = await remindersProvider.listReminders(listUrl, {
            includeCompleted,
          });
        }

        const limited = reminders.slice(0, limit);
        const displayed = limited.map((r) =>
          formatReminderForDisplay(r, displayTz, now)
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  reminders: displayed,
                  total: reminders.length,
                  overdueCount: displayed.filter((r) => r.isOverdue).length,
                  displayTimezone: displayTz,
                  ...(listErrors.length ? { listErrors } : {}),
                },
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
              text: `Failed to list reminders: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_reminder",
    "Get full details of a reminder by UID. If `list` is omitted, every reminder list is searched. Times are displayed in the requested timezone.",
    {
      uid: z.string().describe("Reminder UID"),
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL. If omitted, all lists are searched."
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for display (e.g., 'Australia/Melbourne'). Defaults to system timezone."
        ),
    },
    async ({ uid, list, timezone }) => {
      try {
        const displayTz = resolveTimezone(timezone);
        const found = await locateReminder(remindersProvider, uid, list);

        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reminder with UID "${uid}" not found${list ? ` in list "${list}"` : " in any list"}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                formatReminderForDisplay(found.reminder, displayTz),
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
              text: `Failed to get reminder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_reminder",
    "Create a reminder on an iCloud Reminders list. Pass local time + timezone for the due date (e.g., due='2026-08-10T09:00:00', timezone='Australia/Melbourne'). Omit `due` for an undated reminder.",
    {
      summary: z.string().describe("Reminder title"),
      due: z
        .string()
        .optional()
        .describe(
          "Due date/time (ISO 8601 local time, no Z suffix when using timezone). Omit for an undated reminder."
        ),
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL (default: first VTODO list)"
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g., 'Australia/Melbourne'). The due date is interpreted in this timezone. Defaults to system timezone."
        ),
      description: z.string().optional().describe("Reminder notes"),
      priority: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe(
          "Priority 1-9 (1 = highest, 9 = lowest). Apple Reminders shows 1 as '!!!', 5 as '!!', 9 as '!'. Omit for none."
        ),
    },
    async ({ summary, due, list, timezone, description, priority }) => {
      try {
        const listUrl = await remindersProvider.resolveListUrl(list);
        const reminder = await remindersProvider.createReminder(listUrl, {
          summary,
          due,
          timezone,
          description,
          priority,
          list,
        });

        const displayTz = resolveTimezone(timezone);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uid: reminder.uid,
                  success: true,
                  reminder: formatReminderForDisplay(reminder, displayTz),
                },
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
              text: `Failed to create reminder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "update_reminder",
    "Modify an existing reminder. Only fields you provide are changed; others are preserved. Pass due:null to clear the due date. Uses ETag conditional PUT — returns a clear error if the reminder was modified elsewhere since you last read it. To snooze a reminder, pass just uid + due.",
    {
      uid: z.string().describe("Reminder UID"),
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL. If omitted, all lists are searched."
        ),
      summary: z.string().optional().describe("New reminder title"),
      description: z
        .string()
        .optional()
        .describe("New notes. Omit to preserve existing."),
      due: z
        .string()
        .nullable()
        .optional()
        .describe(
          "New due date (ISO 8601 local time). Pass null to clear, omit to preserve existing."
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for the new due date. Preserves the existing timezone if not provided."
        ),
      priority: z
        .number()
        .int()
        .min(1)
        .max(9)
        .optional()
        .describe("New priority 1-9. Omit to preserve existing."),
      isCompleted: z
        .boolean()
        .optional()
        .describe(
          "Mark complete or reopen. Omit to preserve existing. `complete_reminder` is the shorthand for setting this true."
        ),
    },
    async ({ uid, list, summary, description, due, timezone, priority, isCompleted }) => {
      try {
        const found = await locateReminder(remindersProvider, uid, list);
        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reminder with UID "${uid}" not found${list ? ` in list "${list}"` : " in any list"}`,
              },
            ],
            isError: true,
          };
        }

        const updated = await remindersProvider.updateReminder(
          found.listUrl,
          uid,
          { summary, description, due, timezone, priority, isCompleted }
        );

        const displayTz = resolveTimezone(timezone ?? updated.due?.timezone);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uid: updated.uid,
                  success: true,
                  reminder: formatReminderForDisplay(updated, displayTz),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const conflictHint = msg.includes("412")
          ? " The reminder was modified by another client since you read it. Re-fetch and retry."
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update reminder: ${msg}${conflictHint}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "complete_reminder",
    "Mark a reminder as done. Sets STATUS:COMPLETED and the completion timestamp. If `list` is omitted, all lists are searched for the UID. To reopen a completed reminder, use update_reminder with isCompleted:false.",
    {
      uid: z.string().describe("Reminder UID"),
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL. If omitted, all lists are searched."
        ),
    },
    async ({ uid, list }) => {
      try {
        const found = await locateReminder(remindersProvider, uid, list);
        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reminder with UID "${uid}" not found${list ? ` in list "${list}"` : " in any list"}`,
              },
            ],
            isError: true,
          };
        }

        if (found.reminder.isCompleted) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    uid,
                    success: true,
                    alreadyCompleted: true,
                    completedAt: found.reminder.completedAt,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const completed = await remindersProvider.completeReminder(
          found.listUrl,
          uid
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  uid: completed.uid,
                  success: true,
                  completedAt: completed.completedAt,
                  reminder: completed,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const conflictHint = msg.includes("412")
          ? " The reminder was modified by another client since you read it. Re-fetch and retry."
          : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to complete reminder: ${msg}${conflictHint}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_reminder",
    "Permanently delete a reminder by UID. This does not go to a trash/recently-deleted list — prefer complete_reminder unless the user explicitly wants it gone. If `list` is omitted, all lists are searched.",
    {
      uid: z.string().describe("Reminder UID"),
      list: z
        .string()
        .optional()
        .describe(
          "Reminder list display name or URL. If omitted, all lists are searched."
        ),
    },
    async ({ uid, list }) => {
      try {
        const found = await locateReminder(remindersProvider, uid, list);
        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Reminder with UID "${uid}" not found${list ? ` in list "${list}"` : " in any list"}`,
              },
            ],
            isError: true,
          };
        }

        await remindersProvider.deleteReminder(found.listUrl, uid);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  uid,
                  deleted: {
                    summary: found.reminder.summary,
                    listName: found.reminder.listName,
                  },
                },
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
              text: `Failed to delete reminder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

/**
 * Resolve a reminder UID to its containing list.
 *
 * CalDAV has no cross-collection UID lookup, so an omitted `list` means walking
 * every VTODO collection. Callers that know the list should pass it: the walk is
 * O(lists) round-trips.
 */
export async function locateReminder(
  provider: RemindersProvider,
  uid: string,
  list?: string
): Promise<{ reminder: Reminder; listUrl: string } | null> {
  if (list && list.toLowerCase() !== "all") {
    const listUrl = await provider.resolveListUrl(list);
    const reminder = await provider.getReminder(listUrl, uid);
    return reminder ? { reminder, listUrl } : null;
  }

  const lists = await provider.listLists();
  for (const l of lists) {
    const reminder = await provider.getReminder(l.url, uid);
    if (reminder) return { reminder, listUrl: l.url };
  }
  return null;
}
