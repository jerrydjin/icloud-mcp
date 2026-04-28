import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Contact } from "../providers/contacts.js";
import { canonicalEmail } from "../utils/identity.js";
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

export interface DraftResult {
  draftUid?: number;
  folder?: string;
  to: string[];
  unresolved: { input: string; reason: string; candidates?: string[] }[];
  success: boolean;
}

export function registerDraftVerb(server: McpServer, ctx: VerbContext): void {
  server.tool(
    "draft",
    "Save an email draft to the Drafts folder, resolving contact names to emails when possible. Each `to` entry can be either a literal email address or a contact name. Names are looked up via Contacts; ambiguous or unknown names surface in `unresolved` and the draft is NOT created. Use send_draft to send it later.",
    {
      to: z
        .array(z.string())
        .min(1)
        .describe(
          "Recipients. Each entry is either an email (contains @) or a contact name to look up."
        ),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      cc: z
        .array(z.string())
        .optional()
        .describe("CC recipients (same name-or-email semantics as `to`)"),
      bcc: z
        .array(z.string())
        .optional()
        .describe("BCC recipients (same name-or-email semantics)"),
      from: z
        .string()
        .optional()
        .describe(
          "Send from this alias address. Defaults to primary iCloud email."
        ),
      fromName: z
        .string()
        .optional()
        .describe("Display name for the From header."),
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

async function draftHandler(
  input: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    from?: string;
    fromName?: string;
  },
  ctx: VerbContext
): Promise<VerbResult<DraftResult>> {
  const errors: VerbError[] = [];
  const unresolved: DraftResult["unresolved"] = [];

  const toResolved = await resolveRecipients(input.to, ctx, unresolved, errors);
  const ccResolved = input.cc
    ? await resolveRecipients(input.cc, ctx, unresolved, errors)
    : undefined;
  const bccResolved = input.bcc
    ? await resolveRecipients(input.bcc, ctx, unresolved, errors)
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

  // Build the raw RFC822 message and append to Drafts. Same pattern as
  // src/tools/write.ts:create_draft to maintain compatibility.
  const rawMessage = await ctx.smtp.buildRawMessage({
    to: toResolved,
    subject: input.subject,
    body: input.body,
    cc: ccResolved,
    bcc: bccResolved,
    from: input.from,
    fromName: input.fromName,
  });

  const result = await ctx.imap.append("Drafts", rawMessage, [
    "\\Draft",
    "\\Seen",
  ]);

  return {
    items: {
      draftUid: result.uid,
      folder: "Drafts",
      to: toResolved,
      unresolved: [],
      success: true,
    },
    degraded: errors.length > 0,
    errors,
  };
}

/**
 * Resolve each entry of a recipient list. Email-shaped entries pass through;
 * names get a Contacts lookup. Mutates `unresolved` and `errors` with anything
 * that didn't resolve cleanly.
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

    // Looks like an email
    if (looksLikeEmail(entry)) {
      out.push(entry);
      continue;
    }

    // Otherwise, search contacts
    let matches: Contact[] = [];
    try {
      matches = await ctx.contacts.searchContacts(entry);
    } catch (e) {
      errors.push({
        source: "contacts",
        message: `Contacts lookup for '${entry}' failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      unresolved.push({
        input: entry,
        reason: "contacts_lookup_failed",
      });
      continue;
    }

    if (matches.length === 0) {
      unresolved.push({
        input: entry,
        reason: "no_match",
      });
      continue;
    }

    if (matches.length > 1) {
      // Disambiguation candidates — surface their FN + first email
      const candidates = matches.slice(0, 5).map((c) => {
        const primary = c.emails.find((e) => e.preferred) ?? c.emails[0];
        return `${c.fullName}${primary ? ` <${primary.address}>` : ""}`;
      });
      unresolved.push({
        input: entry,
        reason: "ambiguous",
        candidates,
      });
      continue;
    }

    // Exactly one match
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
    out.push(canonicalEmail(primary.address) || primary.address);
  }

  return out;
}

/**
 * True if the input looks like an email address (contains @ surrounded by
 * non-space characters). Doesn't validate beyond shape.
 */
export function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}
