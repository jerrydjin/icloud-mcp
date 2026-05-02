// triage_commit + triage_commit_retry: execute the proposed writes.
//
// Per-leg idempotency by deterministic UID derivation:
//   - Reminder leg → CalDAV VTODO with UID = uuidFromHash(idempotencyKey).
//     PUT with `If-None-Match: *`. 412 on retry → GET-and-return as
//     `replayed_existing`. Implementation lives in reminders.putReminderWithUid.
//   - Event leg → CalDAV VEVENT with UID = uuidFromHash(idempotencyKey).
//     Same `If-None-Match: *` semantics. caldav.putEventWithUid.
//   - Draft leg → IMAP draft with deterministic Message-Id derived from
//     idempotencyKey. SEARCH HEADER Message-Id BEFORE APPEND; if found, return
//     that UID as replayed_existing.
//
// Failure handling: each leg runs in its own try/catch. One leg's failure
// doesn't block other legs. The CommitResult.partial flag is true if any leg
// failed; the LLM should call triage_commit_retry with the failed legs only.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type VerbContext,
  type VerbResult,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";
import { verifyToken } from "../utils/confirm-token.js";
import { fnv1a64 } from "./triage.js";
import type {
  CommitResult,
  CommitLegResult,
  ProposedReminder,
  ProposedEvent,
  ProposedDraft,
} from "./triage-types.js";

// ── Verb registration: triage_commit ──

export function registerTriageCommitVerb(
  server: McpServer,
  ctx: VerbContext
): void {
  server.tool(
    "triage_commit",
    "Execute a TriagePlan after user confirmation. Pass the confirmToken from triage() and the same `proposed` payload that was returned (so we can verify the hash matches). Each leg (reminder, event, draft) is committed independently with deterministic-UID idempotency: re-calling with the same token within the 10-minute window is safe and produces no duplicates. After expiration, use triage_commit_retry. Returns CommitResult with per-leg status (created / replayed_existing / failed). On any failure, partial=true and the failed legs carry retrySafe=true.",
    {
      confirmToken: z.string().describe("Signed token returned by triage()"),
      proposed: z
        .object({
          reminder: z
            .object({
              title: z.string(),
              due: z.string().optional(),
              list: z.string().optional(),
              idempotencyKey: z.string(),
            })
            .optional(),
          event: z
            .object({
              title: z.string(),
              start: z.string(),
              end: z.string(),
              attendees: z.array(z.string()),
              calendar: z.string().optional(),
              idempotencyKey: z.string(),
            })
            .optional(),
          draft: z
            .object({
              to: z.array(z.string()),
              subject: z.string(),
              body: z.string(),
              idempotencyKey: z.string(),
            })
            .optional(),
          contacts: z.array(z.unknown()).default([]),
        })
        .describe("The `proposed` block from the TriagePlan (verbatim)"),
    },
    async (input) => {
      try {
        const result = await triageCommitHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("triage_commit", error);
      }
    }
  );
}

export async function triageCommitHandler(
  input: {
    confirmToken: string;
    proposed: {
      reminder?: ProposedReminder;
      event?: ProposedEvent;
      draft?: ProposedDraft;
      contacts: unknown[];
    };
  },
  ctx: VerbContext
): Promise<VerbResult<CommitResult>> {
  // Verify the token against the proposal hash. Reject early on any mismatch.
  const verify = await verifyToken(
    input.confirmToken,
    input.proposed,
    process.env.CONFIRM_TOKEN_SECRET
  );
  if (!verify.valid) {
    return failedVerifyResult(verify);
  }

  const legsToRun: ("reminder" | "event" | "draft")[] = [];
  if (input.proposed.reminder) legsToRun.push("reminder");
  if (input.proposed.event) legsToRun.push("event");
  if (input.proposed.draft) legsToRun.push("draft");

  return await runLegs(legsToRun, input.proposed, ctx);
}

// ── Verb registration: triage_commit_retry ──

export function registerTriageCommitRetryVerb(
  server: McpServer,
  ctx: VerbContext
): void {
  server.tool(
    "triage_commit_retry",
    "Retry specific failed legs from a previous triage_commit, after the 10-minute confirmToken window has expired or when only some legs failed. Pass the original idempotencyKeys (from the failed CommitLegResult entries) and the matching payload. Per-leg idempotency keys ensure already-succeeded legs replay as replayed_existing without creating duplicates.",
    {
      legs: z
        .array(z.enum(["reminder", "event", "draft"]))
        .min(1)
        .describe("Which legs to retry"),
      payload: z
        .object({
          reminder: z
            .object({
              title: z.string(),
              due: z.string().optional(),
              list: z.string().optional(),
              idempotencyKey: z.string(),
            })
            .optional(),
          event: z
            .object({
              title: z.string(),
              start: z.string(),
              end: z.string(),
              attendees: z.array(z.string()),
              calendar: z.string().optional(),
              idempotencyKey: z.string(),
            })
            .optional(),
          draft: z
            .object({
              to: z.array(z.string()),
              subject: z.string(),
              body: z.string(),
              idempotencyKey: z.string(),
            })
            .optional(),
        })
        .describe("Same proposed shape as triage_commit, scoped to the legs being retried"),
    },
    async (input) => {
      try {
        const result = await triageCommitRetryHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("triage_commit_retry", error);
      }
    }
  );
}

export async function triageCommitRetryHandler(
  input: {
    legs: ("reminder" | "event" | "draft")[];
    payload: {
      reminder?: ProposedReminder;
      event?: ProposedEvent;
      draft?: ProposedDraft;
    };
  },
  ctx: VerbContext
): Promise<VerbResult<CommitResult>> {
  const proposed = {
    reminder: input.legs.includes("reminder") ? input.payload.reminder : undefined,
    event: input.legs.includes("event") ? input.payload.event : undefined,
    draft: input.legs.includes("draft") ? input.payload.draft : undefined,
    contacts: [] as unknown[],
  };
  return await runLegs(input.legs, proposed, ctx);
}

// ── Per-leg execution ──

async function runLegs(
  legs: ("reminder" | "event" | "draft")[],
  proposed: {
    reminder?: ProposedReminder;
    event?: ProposedEvent;
    draft?: ProposedDraft;
    contacts?: unknown[];
  },
  ctx: VerbContext
): Promise<VerbResult<CommitResult>> {
  const results: CommitLegResult[] = [];

  for (const leg of legs) {
    if (leg === "reminder" && proposed.reminder) {
      results.push(await commitReminderLeg(proposed.reminder, ctx));
    } else if (leg === "event" && proposed.event) {
      results.push(await commitEventLeg(proposed.event, ctx));
    } else if (leg === "draft" && proposed.draft) {
      results.push(await commitDraftLeg(proposed.draft, ctx));
    }
  }

  const partial = results.some((r) => r.status === "failed");
  const userMessage = describeCommitResult(results, partial);
  return {
    items: { results, partial },
    degraded: partial,
    errors: [],
    userMessage,
  };
}

async function commitReminderLeg(
  r: ProposedReminder,
  ctx: VerbContext
): Promise<CommitLegResult> {
  try {
    const lists = await ctx.reminders.listLists();
    const target = r.list
      ? lists.find((l) => l.displayName === r.list) ?? lists[0]
      : lists[0];
    if (!target) {
      return {
        leg: "reminder",
        status: "failed",
        error: "No reminder lists available",
        idempotencyKey: r.idempotencyKey,
        retrySafe: true,
      };
    }
    const uid = uuidFromIdempotencyKey(r.idempotencyKey);
    const before = await ctx.reminders.getReminder(target.url, uid);
    const reminder = await ctx.reminders.putReminderWithUid(target.url, uid, {
      summary: r.title,
      due: r.due,
    });
    return {
      leg: "reminder",
      status: before ? "replayed_existing" : "created",
      uid,
      etag: reminder.etag ?? "",
      idempotencyKey: r.idempotencyKey,
    };
  } catch (e) {
    return {
      leg: "reminder",
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      idempotencyKey: r.idempotencyKey,
      retrySafe: true,
    };
  }
}

async function commitEventLeg(
  e: ProposedEvent,
  ctx: VerbContext
): Promise<CommitLegResult> {
  try {
    const calendarUrl = await ctx.caldav.resolveCalendarUrl(e.calendar);
    const uid = uuidFromIdempotencyKey(e.idempotencyKey);
    const before = await ctx.caldav.getEvent(calendarUrl, uid);
    const event = await ctx.caldav.putEventWithUid(calendarUrl, uid, {
      summary: e.title,
      start: e.start,
      end: e.end,
      attendees: e.attendees,
    });
    return {
      leg: "event",
      status: before ? "replayed_existing" : "created",
      uid,
      etag: event.etag ?? "",
      idempotencyKey: e.idempotencyKey,
    };
  } catch (err) {
    return {
      leg: "event",
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      idempotencyKey: e.idempotencyKey,
      retrySafe: true,
    };
  }
}

async function commitDraftLeg(
  d: ProposedDraft,
  ctx: VerbContext
): Promise<CommitLegResult> {
  try {
    const messageId = messageIdFromIdempotencyKey(d.idempotencyKey);
    // SEARCH HEADER Message-Id BEFORE APPEND for idempotency. If a draft with
    // this Message-Id is already in the Drafts folder, return that UID.
    const existingUid = await ctx.imap.searchByMessageId("Drafts", messageId);
    if (existingUid !== null) {
      return {
        leg: "draft",
        status: "replayed_existing",
        uid: existingUid,
        messageId,
        idempotencyKey: d.idempotencyKey,
      };
    }
    // Build the raw message with the deterministic Message-Id baked in.
    const rawMessage = await ctx.smtp.buildRawMessage({
      to: d.to,
      subject: d.subject,
      body: d.body,
      messageId,
    });
    const result = await ctx.imap.append("Drafts", rawMessage, [
      "\\Draft",
      "\\Seen",
    ]);
    return {
      leg: "draft",
      status: "appended",
      uid: result.uid,
      messageId,
      idempotencyKey: d.idempotencyKey,
    };
  } catch (e) {
    return {
      leg: "draft",
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      idempotencyKey: d.idempotencyKey,
      retrySafe: true,
    };
  }
}

// ── Helpers ──

/**
 * Convert an idempotency key into a UUID-shaped string suitable for use as a
 * CalDAV VTODO/VEVENT UID. iCloud accepts arbitrary URI-ish UIDs but the UUID
 * shape is widely supported and easy to recognize in iCloud's web UI.
 */
export function uuidFromIdempotencyKey(idempotencyKey: string): string {
  // 64-bit fold is ~16 hex chars; we want 32 hex chars in UUID shape. Fold the
  // key twice (once with "a" prefix, once with "b") and concatenate.
  const a = fnv1a64(`a:${idempotencyKey}`);
  const b = fnv1a64(`b:${idempotencyKey}`);
  const hex = (a + b).slice(0, 32);
  // Stamp version 4 bits (0100) and variant bits (10) per RFC 4122 so the UUID
  // identifies as a v4. Strictly cosmetic since the UID is deterministic, but
  // makes the value valid against UUID validators.
  const v4 =
    hex.slice(0, 12) + "4" + hex.slice(13, 16) + "8" + hex.slice(17);
  return (
    `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-` +
    `${v4.slice(16, 20)}-${v4.slice(20, 32)}`
  );
}

/**
 * Derive a deterministic RFC 5322 Message-Id from an idempotency key. The
 * domain part uses a project-local fake domain so the Message-Id is unique to
 * icloud-mcp triage drafts and doesn't collide with anything else in iCloud.
 */
export function messageIdFromIdempotencyKey(idempotencyKey: string): string {
  const fold = fnv1a64(`m:${idempotencyKey}`);
  return `<${fold}@triage.icloud-mcp.local>`;
}

function failedVerifyResult(verify: {
  valid: boolean;
  expired: boolean;
  mismatch: boolean;
  reason?: string;
}): VerbResult<CommitResult> {
  let userMessage: string;
  if (verify.expired) {
    userMessage =
      "confirmToken expired (>10 min since triage). Re-call triage() to get a fresh plan, or use triage_commit_retry with the original idempotencyKeys if you have them.";
  } else if (verify.mismatch) {
    userMessage =
      "Proposal hash doesn't match the signed token. The proposal was modified between triage() and triage_commit(). Re-call triage() to get a fresh plan.";
  } else {
    userMessage = `confirmToken invalid (${verify.reason ?? "unknown"}). Re-call triage().`;
  }
  return {
    items: { results: [], partial: false },
    degraded: true,
    errors: [
      {
        source: "mail",
        message: userMessage,
      },
    ],
    userMessage,
  };
}

function describeCommitResult(
  results: CommitLegResult[],
  partial: boolean
): string {
  if (results.length === 0) return "No legs to commit.";
  const summary = results
    .map((r) => {
      if (r.status === "failed") return `${r.leg} FAILED (${r.error})`;
      if (r.status === "replayed_existing") return `${r.leg} replayed`;
      return `${r.leg} created`;
    })
    .join(", ");
  if (partial) {
    return `Triage commit PARTIAL: ${summary}. Use triage_commit_retry for failed legs.`;
  }
  return `Triage commit complete: ${summary}.`;
}
