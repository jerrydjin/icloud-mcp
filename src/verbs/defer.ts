import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Reminder } from "../types.js";
import {
  type VerbContext,
  type VerbResult,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";

// ── defer: reschedule a reminder to a later time ──
//
// v3 only supports reminder defer (the simplest, well-defined case). Mail
// snooze isn't natively supported by iCloud and would require a custom
// "Snoozed" folder convention; out of scope for v3.
//
// The verb is convenience over `update_reminder` (which doesn't exist as a
// per-service tool per ENG-5). It locates the reminder across all VTODO
// lists if listUrl isn't provided.

export interface DeferResult {
  reminder: Reminder;
}

export function registerDeferVerb(server: McpServer, ctx: VerbContext): void {
  server.tool(
    "defer",
    "Snooze a reminder to a later due date. Pass the reminder uid and an ISO 8601 datetime. If listUrl isn't provided, all reminder lists are searched. Returns the updated reminder envelope.",
    {
      uid: z.string().describe("Reminder UID"),
      until: z
        .string()
        .describe(
          "New due date (ISO 8601 local time, no Z suffix when using timezone)"
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone for the new due date. Defaults to system timezone."
        ),
      listUrl: z
        .string()
        .optional()
        .describe(
          "CalDAV URL of the list containing the reminder. If omitted, all lists are searched."
        ),
    },
    async (input) => {
      try {
        const result = await deferHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("defer", error);
      }
    }
  );
}

async function deferHandler(
  input: { uid: string; until: string; timezone?: string; listUrl?: string },
  ctx: VerbContext
): Promise<VerbResult<DeferResult>> {
  const targetListUrl = input.listUrl ?? (await locateReminder(input.uid, ctx));
  if (!targetListUrl) {
    return {
      items: { reminder: null as unknown as Reminder },
      degraded: true,
      errors: [
        {
          source: "reminders",
          message: `Reminder ${input.uid} not found in any list`,
        },
      ],
      userMessage: `Reminder ${input.uid} not found. List the user's reminders first to find a valid uid.`,
    };
  }

  const updated = await ctx.reminders.updateReminder(targetListUrl, input.uid, {
    due: input.until,
    timezone: input.timezone,
  });

  return {
    items: { reminder: updated },
    degraded: false,
    errors: [],
  };
}

/**
 * Search all reminder lists for a UID. Returns the listUrl that contains it,
 * or undefined if not found.
 */
async function locateReminder(
  uid: string,
  ctx: VerbContext
): Promise<string | undefined> {
  const lists = await ctx.reminders.listLists();
  for (const list of lists) {
    const reminder = await ctx.reminders.getReminder(list.url, uid);
    if (reminder) return list.url;
  }
  return undefined;
}
