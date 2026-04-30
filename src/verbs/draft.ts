import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type VerbContext,
  type VerbResult,
  type VerbError,
  wrapVerbResult,
  wrapVerbError,
} from "./types.js";

// ── draft: cross-service email draft with contact resolution ──
//
// Each `to` entry can be either:
//   - An email address (contains "@") → used directly
//   - A name → searched in Contacts; if exactly one match, the contact's
//     primary email is used. If zero or multiple matches, the entry surfaces
//     in `errors` and `unresolved` so the LLM can ask the user to clarify.
//
// On any unresolved recipient, the draft is NOT created. The LLM should ask
// the user to disambiguate before retrying.
//
// Edit mode (editUid set): IMAP messages are immutable, so an "edit" is
// fetch-existing → overlay the fields the caller passed → append a new draft
// → delete the old one. Fields the caller omits are preserved from the
// existing draft. The old version moves to Trash (Apple Mail behavior).

export interface DraftResult {
  draftUid?: number;
  folder?: string;
  replacedUid?: number;
  to: string[];
  unresolved: { input: string; reason: string; candidates?: string[] }[];
  success: boolean;
}

export function registerDraftVerb(server: McpServer, ctx: VerbContext): void {
  server.tool(
    "draft",
    "Save an email draft to the Drafts folder, resolving contact names to emails when possible. Each `to` entry is either a literal email or a contact name; ambiguous or unknown names surface in `unresolved` and the draft is NOT created. Pass `editUid` to patch an existing draft: only the fields you provide change, the rest are preserved from the existing draft (the old version moves to Trash). Use send_draft to send it later.",
    {
      to: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          "Recipients. Each entry is either an email (contains @) or a contact name to look up. Required when creating; optional when patching (editUid is set)."
        ),
      subject: z
        .string()
        .optional()
        .describe(
          "Email subject. Required when creating; optional when patching."
        ),
      body: z
        .string()
        .optional()
        .describe(
          "Email body text. Required when creating; optional when patching."
        ),
      cc: z
        .array(z.string())
        .optional()
        .describe(
          "CC recipients (same name-or-email semantics as `to`). When patching, pass [] to clear."
        ),
      bcc: z
        .array(z.string())
        .optional()
        .describe(
          "BCC recipients (same name-or-email semantics). When patching, pass [] to clear."
        ),
      from: z
        .string()
        .optional()
        .describe(
          "Send from this alias address. Defaults to primary iCloud email (or, when patching, the existing draft's From)."
        ),
      fromName: z
        .string()
        .optional()
        .describe("Display name for the From header."),
      editUid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "UID of an existing draft in the Drafts folder to patch. Omit to create a new draft."
        ),
    },
    async (input) => {
      try {
        const result = await draftHandler(input, ctx);
        return wrapVerbResult(result);
      } catch (error) {
        return wrapVerbError("draft", error);
      }
    }
  );
}

export async function draftHandler(
  input: {
    to?: string[];
    subject?: string;
    body?: string;
    cc?: string[];
    bcc?: string[];
    from?: string;
    fromName?: string;
    editUid?: number;
  },
  ctx: VerbContext
): Promise<VerbResult<DraftResult>> {
  const errors: VerbError[] = [];
  const unresolved: DraftResult["unresolved"] = [];

  // In edit mode, load the existing draft so we can fall back to its values
  // for any field the caller didn't pass. fetchAndParseMessage throws if the
  // UID isn't in Drafts; the verb wrapper turns that into a tool error.
  const existing = input.editUid
    ? await ctx.imap.fetchAndParseMessage(input.editUid, "Drafts")
    : undefined;

  // Validate required fields for create mode. Edit mode tolerates omissions
  // because the existing draft fills them in.
  if (!existing) {
    if (!input.to || input.to.length === 0) {
      throw new Error("`to` is required when creating a draft");
    }
    if (input.subject === undefined) {
      throw new Error("`subject` is required when creating a draft");
    }
    if (input.body === undefined) {
      throw new Error("`body` is required when creating a draft");
    }
  }

  // Resolve only the recipient lists the caller actually passed; for edit
  // mode, omitted lists fall back to the existing draft's values (already
  // canonical email addresses, no resolution needed).
  const toResolved = input.to
    ? await resolveRecipients(input.to, ctx, unresolved, errors)
    : existing!.to.map((a) => a.address).filter(Boolean);
  const ccResolved = input.cc
    ? await resolveRecipients(input.cc, ctx, unresolved, errors)
    : existing
      ? existing.cc.map((a) => a.address).filter(Boolean)
      : undefined;
  const bccResolved = input.bcc
    ? await resolveRecipients(input.bcc, ctx, unresolved, errors)
    : existing
      ? existing.bcc.map((a) => a.address).filter(Boolean)
      : undefined;

  if (unresolved.length > 0) {
    return {
      items: {
        to: toResolved,
        unresolved,
        success: false,
      },
      degraded: true,
      errors,
      userMessage: `${unresolved.length} recipient(s) couldn't be resolved. Ask the user to clarify before retrying: ${unresolved
        .map((u) => `'${u.input}' (${u.reason})`)
        .join("; ")}`,
    };
  }

  // Patch fields against the existing draft when in edit mode.
  const subject = input.subject ?? existing?.subject ?? "";
  const body = input.body ?? existing?.textBody ?? "";
  const from = input.from ?? existing?.from.address ?? undefined;
  const fromName = input.fromName ?? existing?.from.name ?? undefined;

  const rawMessage = await ctx.smtp.buildRawMessage({
    to: toResolved,
    subject,
    body,
    cc: ccResolved && ccResolved.length > 0 ? ccResolved : undefined,
    bcc: bccResolved && bccResolved.length > 0 ? bccResolved : undefined,
    from,
    fromName: fromName || undefined,
  });

  const result = await ctx.imap.append("Drafts", rawMessage, [
    "\\Draft",
    "\\Seen",
  ]);

  // After the new version is safely appended, retire the old one. If this
  // step fails the user has a duplicate draft, but the new version is
  // already saved — surface the failure as a degraded result rather than
  // throwing away the successful append.
  let replacedUid: number | undefined;
  if (existing) {
    try {
      await ctx.imap.deleteMessage(existing.uid, "Drafts");
      replacedUid = existing.uid;
    } catch (e) {
      errors.push({
        source: "mail",
        message: `Failed to delete old draft UID ${existing.uid}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return {
    items: {
      draftUid: result.uid,
      folder: "Drafts",
      ...(replacedUid !== undefined ? { replacedUid } : {}),
      to: toResolved,
      unresolved: [],
      success: true,
    },
    degraded: errors.length > 0,
    errors,
  };
}

/**
 * Resolve each entry of a recipient list via the identity layer. Email-shaped
 * entries pass through with canonicalization; names get an IdentityResolver
 * lookup that handles fuzzy matching, multi-email collapse, and ambiguity.
 */
async function resolveRecipients(
  inputs: string[],
  ctx: VerbContext,
  unresolved: DraftResult["unresolved"],
  errors: VerbError[]
): Promise<string[]> {
  const out: string[] = [];

  for (const raw of inputs) {
    const entry = raw.trim();
    if (!entry) continue;

    let result;
    try {
      result = await ctx.identityResolver.resolveIdentity(entry);
    } catch (e) {
      errors.push({
        source: "contacts",
        message: `Identity resolution for '${entry}' failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      unresolved.push({ input: entry, reason: "contacts_lookup_failed" });
      continue;
    }

    if (result.unresolvedReason) {
      unresolved.push({ input: entry, reason: result.unresolvedReason });
      continue;
    }

    if (result.ambiguous) {
      const candidates = result.ambiguous
        .slice(0, 5)
        .map((id) =>
          id.canonical
            ? `${id.displayName} <${id.canonical}>`
            : id.displayName
        );
      unresolved.push({ input: entry, reason: "ambiguous", candidates });
      continue;
    }

    const id = result.identity!;
    if (!id.canonical) {
      unresolved.push({
        input: entry,
        reason: "contact_has_no_email",
        candidates: [id.displayName || entry],
      });
      continue;
    }
    out.push(id.canonical);
  }

  return out;
}

/**
 * True if the input looks like an email address. Kept exported for any
 * downstream caller that imported it from this module.
 */
export function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}
