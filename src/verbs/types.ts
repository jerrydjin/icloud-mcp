import type { ImapProvider } from "../providers/imap.js";
import type { SmtpProvider } from "../providers/smtp.js";
import type { CalDavProvider } from "../providers/caldav.js";
import type { RemindersProvider } from "../providers/reminders.js";
import type { ContactsProvider } from "../providers/contacts.js";
import type { IdentityResolver } from "../providers/identity-cache.js";

// ── VerbContext: providers + identity, passed to every verb handler ──

export interface VerbContext {
  imap: ImapProvider;
  smtp: SmtpProvider;
  caldav: CalDavProvider;
  reminders: RemindersProvider;
  contacts: ContactsProvider;
  identityResolver: IdentityResolver;
  email: string; // user's own iCloud address — for self-filtering (sameEmail)
}

// ── Verb response envelope ──
//
// Per ENG-4 (rich envelope) and ENG-21 (EventKit dropped):
// v3 verbs run cloud-only, so capability negotiation is simpler. The envelope
// retains:
//   - items: the verb's payload
//   - degraded: true if any provider failed
//   - errors: per-source failures so the LLM can explain partial results
//   - userMessage: optional plain-English nudge the LLM relays to the user
//
// `capabilities` and `missingCapabilities` from the original envelope design
// are reserved for v4 when EventKit returns; v3 verbs don't populate them.

export interface VerbError {
  source: "mail" | "calendar" | "reminders" | "contacts";
  message: string;
}

export interface VerbResult<TItems> {
  items: TItems;
  degraded: boolean;
  errors: VerbError[];
  userMessage?: string;
}

/**
 * Wrap a typed VerbResult into the MCP tool response shape. All verbs in
 * src/verbs/ go through this so the envelope stays consistent.
 */
export function wrapVerbResult<T>(result: VerbResult<T>): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * Wrap a thrown error into the MCP tool response shape. Returns isError:true
 * with a clear message identifying which verb failed.
 */
export function wrapVerbError(
  verbName: string,
  error: unknown
): { content: { type: "text"; text: string }[]; isError: true } {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text" as const,
        text: `Verb '${verbName}' failed: ${msg}`,
      },
    ],
    isError: true,
  };
}
