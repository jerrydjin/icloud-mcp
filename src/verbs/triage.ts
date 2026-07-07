// triage: read a mail message, propose cross-service actions, return a signed plan.
//
// The cornerstone v3-design verb that v3 deferred. Reads a single mail message,
// runs the proposer heuristics, resolves identities for thread participants,
// detects calendar conflicts, and returns a TriagePlan with a signed
// confirmToken. The companion verb triage_commit (in triage-commit.ts) executes
// the proposed writes after user confirmation.
//
// Per design (M4.2 eng review):
//   - Reads a SINGLE message by (uid, folder). v1 doesn't walk the full thread
//     — the latest message is what the user is reading anyway.
//   - Identity resolution flows through ctx.identityResolver (M4.1).
//   - Idempotency keys are deterministic hashes so triage_commit retries dedupe.
//   - chrono-node parses natural-language datetime; misparses (>365d future or
//     in past) are dropped per proposer.ts:detectDatetime sanity bounds.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CalendarEvent } from "../types.js";
import {
  type VerbContext,
  type VerbResult,
  type VerbError,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";
import {
  detectActionVerb,
  detectDatetime,
  detectQuestionOrRequest,
} from "../utils/proposer.js";
import { signProposal } from "../utils/confirm-token.js";
import { sameEmail } from "../utils/identity.js";
import type { ResolvedIdentity } from "../utils/identity.js";
import type {
  TriagePlan,
  TriageConflict,
  ProposedReminder,
  ProposedEvent,
  ProposedDraft,
} from "./triage-types.js";

const DEFAULT_EVENT_DURATION_MIN = 30;
const DEFAULT_REMINDER_DUE_DAYS = 1;

export function registerTriageVerb(server: McpServer, ctx: VerbContext): void {
  server.tool(
    "triage",
    "Read a mail message and propose cross-service actions: optionally a reminder (when the message contains action verbs like 'please send'), an event (when an explicit datetime is detected), and a draft reply (when the message is a question or request from a known correspondent). Returns a structured plan + a signed confirmToken. Use triage_commit to execute the plan after the user confirms. Pass uid + optional folder (defaults to INBOX).",
    {
      uid: z
        .number()
        .int()
        .positive()
        .describe("IMAP UID of the message to triage"),
      folder: z
        .string()
        .optional()
        .describe("Folder containing the message (default: INBOX)"),
    },
    async (input) => {
      try {
        const result = await triageHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("triage", error);
      }
    }
  );
}

export async function triageHandler(
  input: { uid: number; folder?: string },
  ctx: VerbContext
): Promise<VerbResult<TriagePlan>> {
  const folder = input.folder ?? "INBOX";
  const errors: VerbError[] = [];

  // Fetch the source message
  const msg = await ctx.imap.fetchAndParseMessage(input.uid, folder);

  // Run proposer heuristics on the body. Use textBody, fall back to empty.
  const body = msg.textBody ?? "";
  const wantsReminder = detectActionVerb(body);
  const parsedDatetime = detectDatetime(body);
  const wantsDraft = detectQuestionOrRequest(body);

  // Resolve identities for the sender + recipients (excluding self)
  const conflicts: TriageConflict[] = [];
  const contacts: ResolvedIdentity[] = await resolveThreadIdentities(
    [
      msg.from?.address,
      ...msg.to.map((a) => a.address),
      ...msg.cc.map((a) => a.address),
    ].filter((a): a is string => !!a && !sameEmail(a, ctx.email)),
    ctx,
    conflicts,
    errors
  );

  // Build the proposed sub-objects with deterministic idempotency keys
  const threadKey = msg.messageId || `uid-${msg.uid}-${msg.subject}`;
  const proposed: TriagePlan["proposed"] = { contacts };

  if (wantsReminder) {
    const dueIso = parsedDatetime?.start ?? defaultReminderDueIso();
    const proposedReminder: ProposedReminder = {
      title: msg.subject || "(no subject)",
      due: dueIso,
      idempotencyKey: idempotencyKey(threadKey, "reminder", { title: msg.subject, due: dueIso }),
    };
    proposed.reminder = proposedReminder;
  }

  if (parsedDatetime) {
    const start = parsedDatetime.start;
    const end = parsedDatetime.end ?? addMinutesIso(start, DEFAULT_EVENT_DURATION_MIN);
    const attendeeEmails = contacts
      .map((c) => c.canonical)
      .filter((c) => c && !sameEmail(c, ctx.email));
    const proposedEvent: ProposedEvent = {
      title: msg.subject || "(no subject)",
      start,
      end,
      attendees: attendeeEmails,
      idempotencyKey: idempotencyKey(threadKey, "event", { title: msg.subject, start, end }),
    };
    proposed.event = proposedEvent;

    // Surface calendar overlaps as informational conflicts
    try {
      const overlaps = await findOverlappingEvents(ctx, start, end);
      for (const ev of overlaps) {
        conflicts.push({
          kind: "calendar_overlap",
          eventUid: ev.uid,
          summary: ev.summary,
          blocking: false,
        });
      }
    } catch (e) {
      errors.push({
        source: "calendar",
        message: `Conflict detection failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  if (wantsDraft) {
    // Default draft body: empty (user fills in via subsequent /draft edit). Subject
    // gets a "Re: " prefix if it isn't already a reply.
    const replySubject = msg.subject?.toLowerCase().startsWith("re:")
      ? msg.subject
      : `Re: ${msg.subject || "(no subject)"}`;
    const replyTo = msg.from?.address;
    if (replyTo && !sameEmail(replyTo, ctx.email)) {
      const proposedDraft: ProposedDraft = {
        to: [replyTo],
        subject: replySubject,
        body: "",
        idempotencyKey: idempotencyKey(threadKey, "draft", {
          to: [replyTo],
          subject: replySubject,
        }),
      };
      proposed.draft = proposedDraft;
    }
  }

  // Sign the proposal hash → confirmToken. Throws if CONFIRM_TOKEN_SECRET is
  // missing or weak; that's the desired security gate.
  const confirmToken = await signProposal(proposed, process.env.CONFIRM_TOKEN_SECRET);

  const plan: TriagePlan = {
    thread: {
      uid: msg.uid,
      folder,
      subject: msg.subject || "(no subject)",
      snippet: body.slice(0, 200),
    },
    proposed,
    confirmToken,
    conflicts,
  };

  const userMessage = describePlan(plan);
  return {
    items: plan,
    degraded: errors.length > 0,
    errors,
    userMessage,
  };
}

// ── Helpers ──

async function resolveThreadIdentities(
  addresses: string[],
  ctx: VerbContext,
  conflicts: TriageConflict[],
  errors: VerbError[]
): Promise<ResolvedIdentity[]> {
  const seen = new Set<string>();
  const out: ResolvedIdentity[] = [];
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = await ctx.identityResolver.resolveIdentity(addr);
      if (result.identity) {
        out.push(result.identity);
      } else if (result.ambiguous) {
        // Multiple possible identities for one address shouldn't happen for an
        // email-shaped input, but if it does, push them all and flag.
        out.push(...result.ambiguous);
      } else if (result.unresolvedReason === "no_match") {
        // Stranger email — already handled inside resolveIdentity which returns
        // a contact-less identity. We don't reach this branch for emails.
      }
    } catch (e) {
      errors.push({
        source: "contacts",
        message: `Identity resolution for '${addr}' failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

async function findOverlappingEvents(
  ctx: VerbContext,
  startLocal: string,
  endLocal: string
): Promise<CalendarEvent[]> {
  const startUtc = new Date(startLocal);
  const endUtc = new Date(endLocal);
  const calendars = await ctx.caldav.listCalendars();
  const eventResults = await Promise.allSettled(
    calendars.map((cal) => ctx.caldav.listEvents(cal.url, startUtc, endUtc))
  );
  const overlaps: CalendarEvent[] = [];
  const startMs = startUtc.getTime();
  const endMs = endUtc.getTime();
  for (const r of eventResults) {
    if (r.status !== "fulfilled") continue;
    for (const ev of r.value) {
      if (ev.status === "CANCELLED") continue;
      const evStart = new Date(ev.start.utc).getTime();
      const evEnd = new Date(ev.end.utc).getTime();
      if (evStart < endMs && startMs < evEnd) overlaps.push(ev);
    }
  }
  return overlaps;
}

/**
 * Deterministic idempotency key for one leg of a triage proposal. Hashes the
 * thread context + leg name + a canonicalized snapshot of the proposal content
 * so that an unchanged retry yields the same key (dedupe at iCloud) and an
 * edited retry yields a different key (treat as a new resource).
 */
export function idempotencyKey(
  threadKey: string,
  leg: "reminder" | "event" | "draft",
  content: unknown
): string {
  const canonical = JSON.stringify(sortKeys(content));
  // Synchronous hash via a simple FNV-like fold; we'll stamp this into a UUID
  // shape for CalDAV. Not cryptographic — idempotency key only needs to be
  // collision-resistant within a single user's space, not adversarially safe.
  const fold = fnv1a64(`${leg}|${threadKey}|${canonical}`);
  return `triage-${leg}-${fold}`;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
  return sorted;
}

/**
 * 64-bit FNV-1a hash, hex output. Deterministic, fast, no deps. Used for
 * idempotency keys and the deterministic UID/Message-Id derivations in
 * triage-commit.
 */
export function fnv1a64(input: string): string {
  let hi = 0xcbf29ce4 >>> 0;
  let lo = 0x84222325 >>> 0;
  const FNV_PRIME_LO = 0x100000001b3 & 0xffffffff;
  const FNV_PRIME_HI = Math.floor(0x100000001b3 / 0x100000000);
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    lo ^= c;
    // 64-bit multiply: (hi:lo) * (FNV_PRIME_HI:FNV_PRIME_LO)
    const a0 = lo & 0xffff,
      a1 = (lo >>> 16) & 0xffff,
      a2 = hi & 0xffff,
      a3 = (hi >>> 16) & 0xffff;
    const b0 = FNV_PRIME_LO & 0xffff,
      b1 = (FNV_PRIME_LO >>> 16) & 0xffff,
      b2 = FNV_PRIME_HI & 0xffff,
      b3 = (FNV_PRIME_HI >>> 16) & 0xffff;
    let c0 = a0 * b0;
    let c1 = (c0 >>> 16) + a0 * b1 + a1 * b0;
    c0 = c0 & 0xffff;
    let c2 = (c1 >>> 16) + a0 * b2 + a1 * b1 + a2 * b0;
    c1 = c1 & 0xffff;
    let c3 = (c2 >>> 16) + a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;
    c2 = c2 & 0xffff;
    c3 = c3 & 0xffff;
    lo = ((c1 << 16) | c0) >>> 0;
    hi = ((c3 << 16) | c2) >>> 0;
  }
  return (
    hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0")
  );
}

function defaultReminderDueIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_REMINDER_DUE_DAYS);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function addMinutesIso(localIso: string, minutes: number): string {
  // Parse as local wallclock (no Z); add minutes; emit local ISO.
  const m = localIso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
  );
  if (!m) throw new Error(`Bad local ISO: ${localIso}`);
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    parseInt(y!, 10),
    parseInt(mo!, 10) - 1,
    parseInt(d!, 10),
    parseInt(h!, 10),
    parseInt(mi!, 10) + minutes,
    s ? parseInt(s, 10) : 0
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function describePlan(plan: TriagePlan): string {
  const parts: string[] = [];
  if (plan.proposed.reminder) parts.push(`reminder ("${plan.proposed.reminder.title}")`);
  if (plan.proposed.event)
    parts.push(`event ("${plan.proposed.event.title}" at ${plan.proposed.event.start})`);
  if (plan.proposed.draft)
    parts.push(`draft reply to ${plan.proposed.draft.to.join(", ")}`);
  if (parts.length === 0) {
    return `Nothing actionable detected in this message. ${plan.proposed.contacts.length} contact(s) resolved.`;
  }
  const conflictNote =
    plan.conflicts.length > 0
      ? ` Note: ${plan.conflicts.length} conflict(s) detected — surface to user before commit.`
      : "";
  return `Proposed: ${parts.join(", ")}.${conflictNote} Call triage_commit with confirmToken to execute.`;
}
