import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  CalendarEvent,
  MessageSummary,
  Reminder,
} from "../types.js";
import type { Contact } from "../providers/contacts.js";
import {
  type VerbContext,
  type VerbError,
  type VerbResult,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";

// ── find: cross-service search ──
//
// Searches mail / calendar / reminders / contacts in parallel for a query.
// Returns per-service result lists (no cross-service dedup in v3 per ENG-15
// minimal dedup; the find_across_services dedup work is on the v4 TODO).
//
// Search semantics per service:
//  - mail: IMAP TEXT search in INBOX (and optionally Sent), case-insensitive,
//    server-side. Returns recent matches first.
//  - calendar: fetch events in a +/-90-day window around now, filter by
//    case-insensitive substring match on summary/description/location.
//  - reminders: fetch all reminders across all VTODO lists,
//    case-insensitive substring on summary/description.
//  - contacts: ContactsProvider.searchContacts() — fuzzy name + exact-email +
//    phone-digit match.
//
// Per-service failures don't fail the whole verb. The envelope's `errors`
// field captures which sources failed; `degraded` is true if any did.

export interface FindResults {
  mail?: { count: number; samples: MessageSummary[] };
  calendar?: { count: number; samples: CalendarEvent[] };
  reminders?: { count: number; samples: Reminder[] };
  contacts?: { count: number; samples: Contact[] };
}

export function registerFindVerb(server: McpServer, ctx: VerbContext): void {
  server.tool(
    "find",
    "Search across iCloud services for a query. Returns per-service result lists. v3 has no cross-service dedup — the same person may appear as both a Contact and an email sender; if you need to compare, use canonical email matching client-side.",
    {
      query: z.string().describe("What to search for (free text)"),
      services: z
        .array(z.enum(["mail", "calendar", "reminders", "contacts"]))
        .optional()
        .describe(
          "Which services to search. Default: all four. Narrow scope when you know where the answer lives."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Max results per service. Default 20."),
    },
    async (input) => {
      try {
        const result = await findHandler(
          {
            query: input.query,
            services: input.services ?? [
              "mail",
              "calendar",
              "reminders",
              "contacts",
            ],
            limit: input.limit ?? 20,
          },
          ctx
        );
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("find", error);
      }
    }
  );
}

async function findHandler(
  input: {
    query: string;
    services: ("mail" | "calendar" | "reminders" | "contacts")[];
    limit: number;
  },
  ctx: VerbContext
): Promise<VerbResult<FindResults>> {
  const { query, services, limit } = input;
  const errors: VerbError[] = [];
  const results: FindResults = {};
  const q = query.trim();

  if (!q) {
    return {
      items: results,
      degraded: false,
      errors: [],
      userMessage: "Empty query — pass a search string.",
    };
  }

  const tasks: Promise<void>[] = [];

  if (services.includes("mail")) {
    tasks.push(
      ctx.imap
        .search("INBOX", { text: q }, limit)
        .then((r) => {
          results.mail = { count: r.total, samples: r.messages };
        })
        .catch((e) => {
          errors.push({
            source: "mail",
            message: e instanceof Error ? e.message : String(e),
          });
        })
    );
  }

  if (services.includes("calendar")) {
    tasks.push(
      searchCalendar(ctx, q, limit)
        .then((r) => {
          results.calendar = r;
        })
        .catch((e) => {
          errors.push({
            source: "calendar",
            message: e instanceof Error ? e.message : String(e),
          });
        })
    );
  }

  if (services.includes("reminders")) {
    tasks.push(
      searchReminders(ctx, q, limit)
        .then((r) => {
          results.reminders = r;
        })
        .catch((e) => {
          errors.push({
            source: "reminders",
            message: e instanceof Error ? e.message : String(e),
          });
        })
    );
  }

  if (services.includes("contacts")) {
    tasks.push(
      ctx.contacts
        .searchContacts(q)
        .then((r) => {
          results.contacts = { count: r.length, samples: r.slice(0, limit) };
        })
        .catch((e) => {
          errors.push({
            source: "contacts",
            message: e instanceof Error ? e.message : String(e),
          });
        })
    );
  }

  await Promise.all(tasks);

  const degraded = errors.length > 0;
  const userMessage = degraded
    ? `${errors.length} service(s) failed: ${errors.map((e) => e.source).join(", ")}. Other results are still valid.`
    : undefined;

  return { items: results, degraded, errors, userMessage };
}

// ── Per-service search helpers ──

async function searchCalendar(
  ctx: VerbContext,
  query: string,
  limit: number
): Promise<{ count: number; samples: CalendarEvent[] }> {
  const calendars = await ctx.caldav.listCalendars();
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const start = new Date(now - ninetyDaysMs);
  const end = new Date(now + ninetyDaysMs);

  const eventResults = await Promise.allSettled(
    calendars.map((cal) => ctx.caldav.listEvents(cal.url, start, end))
  );

  const allEvents: CalendarEvent[] = [];
  for (const r of eventResults) {
    if (r.status === "fulfilled") allEvents.push(...r.value);
  }

  const matched = matchEvents(allEvents, query);
  return { count: matched.length, samples: matched.slice(0, limit) };
}

async function searchReminders(
  ctx: VerbContext,
  query: string,
  limit: number
): Promise<{ count: number; samples: Reminder[] }> {
  const lists = await ctx.reminders.listLists();
  const reminderResults = await Promise.allSettled(
    lists.map((l) =>
      ctx.reminders.listReminders(l.url, { includeCompleted: true })
    )
  );

  const all: Reminder[] = [];
  for (const r of reminderResults) {
    if (r.status === "fulfilled") all.push(...r.value);
  }

  const matched = matchReminders(all, query);
  return { count: matched.length, samples: matched.slice(0, limit) };
}

/**
 * Case-insensitive substring match against summary, description, and location.
 * Exported for unit testing.
 */
export function matchEvents(
  events: CalendarEvent[],
  query: string
): CalendarEvent[] {
  const q = query.toLowerCase();
  if (!q) return [];
  return events.filter((e) => {
    if (e.summary.toLowerCase().includes(q)) return true;
    if (e.description?.toLowerCase().includes(q)) return true;
    if (e.location?.toLowerCase().includes(q)) return true;
    return false;
  });
}

/**
 * Case-insensitive substring match against summary and description.
 * Exported for unit testing.
 */
export function matchReminders(
  reminders: Reminder[],
  query: string
): Reminder[] {
  const q = query.toLowerCase();
  if (!q) return [];
  return reminders.filter((r) => {
    if (r.summary.toLowerCase().includes(q)) return true;
    if (r.description?.toLowerCase().includes(q)) return true;
    return false;
  });
}
