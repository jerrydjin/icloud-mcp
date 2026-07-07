// Request-scoped identity resolver. Lives for the lifetime of one MCP request.
//
// On Vercel (api/mcp.ts), every HTTP call creates a fresh server + providers +
// resolver and disconnects them all when done. There is NO process-lifetime
// cache. On stdio (server.ts), the resolver lives for the long-lived process.
// Same code, different lifecycle.
//
// What this caches (per request):
//   - The full Contacts list, fetched once on first resolve call. Subsequent
//     calls within the same request reuse it.
//   - A canonical-email → contactUid index for multi-email collapse.
//
// Multi-email collapse rule (M4.1):
//   Two emails belong to the same identity iff they appear on the same
//   Contact record's `emails[]` (i.e., the user has explicitly linked them in
//   their Contacts app). Phone numbers work the same way. We do NOT merge
//   contacts by name+domain heuristics — that false-merges common names at
//   large providers (two unrelated "John Smith"s at gmail.com).

import type { Contact, ContactsProvider } from "./contacts.js";
import { matchContacts } from "./contacts.js";
import {
  canonicalEmail,
  canonicalPhone,
  type ResolvedIdentity,
} from "../utils/identity.js";

export interface IdentityResolutionResult {
  /** Single canonical identity if exactly one resolved. */
  identity?: ResolvedIdentity;
  /** Multiple distinct identities if the input was ambiguous (e.g., "Jane" matched 2 different Janes). */
  ambiguous?: ResolvedIdentity[];
  /** Reason no identity resolved cleanly: "no_match" | "contact_has_no_email". */
  unresolvedReason?: string;
}

export class IdentityResolver {
  private contactsCache: Contact[] | null = null;
  private contactsCacheError: Error | null = null;
  private indexBuilt = false;
  /** canonicalEmail → contactUid */
  private emailIndex = new Map<string, string>();
  /** canonicalPhone → contactUid */
  private phoneIndex = new Map<string, string>();
  /** contactUid → Contact (so we can build identities without re-walking) */
  private contactByUid = new Map<string, Contact>();

  constructor(private readonly contacts: ContactsProvider) {}

  /**
   * Resolve an email address or a name to a single canonical identity.
   *
   * Returns:
   *   - identity: when exactly one Contact (or one canonical email with no
   *     Contact backing) resolves the input.
   *   - ambiguous: when the input matched multiple distinct Contacts whose
   *     emails/phones don't collapse to a single canonical identity.
   *   - unresolvedReason: when no Contact matched AND the input doesn't look
   *     like a usable email.
   */
  async resolveIdentity(input: string): Promise<IdentityResolutionResult> {
    const trimmed = input.trim();
    if (!trimmed) return { unresolvedReason: "no_match" };

    // Email-shaped path: look up Contact by canonical email; if missing, return
    // a Contact-less identity backed only by the email itself.
    if (looksLikeEmail(trimmed)) {
      return this.resolveByEmail(trimmed);
    }

    // Name/phone path: search Contacts.
    return this.resolveByName(trimmed);
  }

  /**
   * Manually drop the Contacts cache. The next resolveIdentity call will
   * re-fetch. Wired to the `identity_cache_flush` admin tool so the user can
   * pick up Contact edits during a long-lived stdio session without restart.
   */
  flush(): void {
    this.contactsCache = null;
    this.contactsCacheError = null;
    this.indexBuilt = false;
    this.emailIndex.clear();
    this.phoneIndex.clear();
    this.contactByUid.clear();
  }

  // ── Internal ──

  private async resolveByEmail(
    rawEmail: string
  ): Promise<IdentityResolutionResult> {
    const canonical = canonicalEmail(rawEmail);
    if (!canonical) return { unresolvedReason: "no_match" };

    await this.ensureIndex();
    const uid = this.emailIndex.get(canonical);
    if (uid) {
      const c = this.contactByUid.get(uid);
      if (c) return { identity: identityFromContact(c) };
    }
    // Email with no Contact backing — still a valid identity, just without
    // multi-email/phone collapse and without a displayName from Contacts.
    return {
      identity: {
        canonical,
        allEmails: [canonical],
        allPhones: [],
        displayName: rawEmail.includes("<")
          ? extractDisplayName(rawEmail)
          : "",
        contactUid: null,
      },
    };
  }

  private async resolveByName(
    name: string
  ): Promise<IdentityResolutionResult> {
    await this.ensureIndex();
    if (this.contactsCacheError) {
      // We failed to fetch Contacts. Surface a graceful failure rather than
      // throwing, so callers can render a clear error to the user.
      return { unresolvedReason: "contacts_lookup_failed" };
    }

    const matches = matchContacts(this.contactsCache ?? [], name);
    if (matches.length === 0) {
      return { unresolvedReason: "no_match" };
    }
    if (matches.length === 1) {
      const c = matches[0]!;
      const id = identityFromContact(c);
      if (id.allEmails.length === 0 && id.allPhones.length === 0) {
        return { unresolvedReason: "contact_has_no_email" };
      }
      return { identity: id };
    }

    // Multiple Contact records matched. Collapse those that share emails/phones
    // (already-merged Contacts surface as one); the remainder are genuinely
    // distinct people and surface as ambiguous.
    const collapsedByUid = new Map<string, ResolvedIdentity>();
    for (const c of matches) {
      // The match itself might point at a Contact whose emails are linked into
      // a different "primary" Contact via the email index. Walk the index
      // first.
      const primaryUid = this.findPrimaryUidForContact(c) ?? c.uid;
      if (!collapsedByUid.has(primaryUid)) {
        const primary = this.contactByUid.get(primaryUid) ?? c;
        collapsedByUid.set(primaryUid, identityFromContact(primary));
      }
    }
    const distinct = [...collapsedByUid.values()];
    if (distinct.length === 1) {
      return { identity: distinct[0]! };
    }
    return { ambiguous: distinct };
  }

  /**
   * If any of this contact's emails/phones is the "primary" entry in a
   * different Contact, return that Contact's UID. Used to collapse near-
   * duplicate Contact entries the user may have created.
   */
  private findPrimaryUidForContact(c: Contact): string | null {
    for (const e of c.emails) {
      const ce = canonicalEmail(e.address);
      const owner = this.emailIndex.get(ce);
      if (owner && owner !== c.uid) return owner;
    }
    for (const p of c.phones) {
      const cp = canonicalPhone(p.number);
      if (!cp) continue;
      const owner = this.phoneIndex.get(cp);
      if (owner && owner !== c.uid) return owner;
    }
    return null;
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexBuilt) return;
    if (this.contactsCacheError) return; // already failed; don't retry within this request

    // Walk every address book to build the FULL contact list. We can't use
    // searchContacts("") because matchContacts short-circuits on empty query;
    // we need the underlying contacts as data, not as a query result.
    try {
      const books = await this.contacts.listAddressBooks();
      const all: Contact[] = [];
      for (const book of books) {
        try {
          const list = await this.contacts.listContacts(book.url);
          all.push(...list);
        } catch {
          // per-book errors non-fatal — we still index whichever books worked
        }
      }
      this.contactsCache = all;
    } catch (err) {
      this.contactsCacheError =
        err instanceof Error ? err : new Error(String(err));
      this.indexBuilt = true;
      return;
    }

    for (const c of this.contactsCache) {
      this.contactByUid.set(c.uid, c);
      for (const e of c.emails) {
        const ce = canonicalEmail(e.address);
        if (ce && !this.emailIndex.has(ce)) {
          this.emailIndex.set(ce, c.uid);
        }
      }
      for (const p of c.phones) {
        const cp = canonicalPhone(p.number);
        if (cp && !this.phoneIndex.has(cp)) {
          this.phoneIndex.set(cp, c.uid);
        }
      }
    }
    this.indexBuilt = true;
  }
}

function identityFromContact(c: Contact): ResolvedIdentity {
  const allEmails: string[] = [];
  for (const e of c.emails) {
    const ce = canonicalEmail(e.address);
    if (ce && !allEmails.includes(ce)) allEmails.push(ce);
  }
  const allPhones: string[] = [];
  for (const p of c.phones) {
    const cp = canonicalPhone(p.number);
    if (cp && !allPhones.includes(cp)) allPhones.push(cp);
  }
  // Primary email = the one marked preferred, else the first.
  const preferredEmail = c.emails.find((e) => e.preferred);
  const canonical =
    canonicalEmail(preferredEmail?.address ?? c.emails[0]?.address ?? "") ||
    allEmails[0] ||
    "";

  return {
    canonical,
    allEmails,
    allPhones,
    displayName: c.fullName,
    contactUid: c.uid,
  };
}

function looksLikeEmail(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at < s.length - 1 && !/\s/.test(s);
}

function extractDisplayName(addr: string): string {
  // "Jane Smith <jane@x.com>" → "Jane Smith"
  const m = addr.match(/^\s*"?([^"<]+?)"?\s*</);
  return m?.[1]?.trim() ?? "";
}
