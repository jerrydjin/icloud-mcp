// Identity utilities for cross-service entity resolution.
//
// v4 (M4.1) extends the v3 minimal email-based dedup with:
//   - Levenshtein-based fuzzy name matching (handles typos like "Jaen" -> "Jane")
//   - Multi-email collapse (a Contact with work + home emails resolves to one identity)
//   - Stateful resolver (IdentityResolver in providers/identity-cache.ts) that
//     caches a Contacts index for the request lifetime
//
// This file holds the pure helpers. The stateful resolver lives in
// providers/identity-cache.ts so it can be instantiated per-request alongside
// the existing DiscoveryCache pattern.

/**
 * Canonicalize an email address for cross-service comparison.
 *
 * - Lowercase the entire address.
 * - Trim whitespace.
 * - Strip surrounding angle brackets (`<jane@example.com>` → `jane@example.com`).
 * - Strip a leading "mailto:" if present (CalDAV ATTENDEE values use `mailto:` prefix).
 * - Strip Gmail-style plus-addressing and dots (`jane+tag@gmail.com` → `jane@gmail.com`)
 *   ONLY for known-aliasing domains (gmail.com, googlemail.com).
 *
 * Returns "" for inputs that don't look like emails (no @ sign).
 */
export function canonicalEmail(addr: string): string {
  if (!addr) return "";
  let s = addr.trim().toLowerCase();

  if (s.startsWith("mailto:")) s = s.slice(7);
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);

  const bracketMatch = s.match(/<([^>]+)>/);
  if (bracketMatch) s = bracketMatch[1]!;

  s = s.trim();

  const atIdx = s.indexOf("@");
  if (atIdx === -1 || atIdx === 0 || atIdx === s.length - 1) return "";

  const localPart = s.slice(0, atIdx);
  const domain = s.slice(atIdx + 1);

  const domainAliases = new Set(["gmail.com", "googlemail.com"]);
  let effectiveLocal = localPart;
  if (domainAliases.has(domain)) {
    const plusIdx = localPart.indexOf("+");
    if (plusIdx > 0) effectiveLocal = localPart.slice(0, plusIdx);
    effectiveLocal = effectiveLocal.replace(/\./g, "");
  }

  return `${effectiveLocal}@${domain}`;
}

/**
 * True if two email addresses canonicalize to the same value.
 */
export function sameEmail(a: string, b: string): boolean {
  const ca = canonicalEmail(a);
  const cb = canonicalEmail(b);
  return ca !== "" && ca === cb;
}

/**
 * Canonicalize a phone number for comparison: keep digits only, drop a leading
 * "1" for US/CA numbers (loose heuristic — collisions across countries are
 * accepted as the cost of not parsing every locale).
 */
export function canonicalPhone(phone: string): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/**
 * Levenshtein edit distance between two strings. Iterative two-row DP.
 * Returns the number of single-character edits (insert/delete/substitute).
 *
 * Used for fuzzy name matching after a prefix-prune step has narrowed the
 * candidate set, so the O(N*M) cost is bounded.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insert
        prev[j] + 1, // delete
        prev[j - 1] + cost // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * Normalized similarity in [0, 1]. 1 = identical; 0 = nothing in common.
 *   similarity = 1 - (distance / maxLen)
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  if (aL === bL) return 1;
  const maxLen = Math.max(aL.length, bL.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(aL, bL) / maxLen;
}

/**
 * Default similarity threshold for fuzzy name matching. 0.85 means a single
 * 1-character typo on a 7+ character name still matches; longer typos don't.
 * Tunable; will be calibrated against real Contacts data during dogfooding.
 */
export const FUZZY_NAME_THRESHOLD = 0.85;

/**
 * Split a name into normalized lowercase tokens. Used for prefix-pruning the
 * candidate set before applying the more expensive Levenshtein distance.
 *
 *   normalizeNameTokens("Jane O'Neill")  →  ["jane", "o'neill"]
 *   normalizeNameTokens("J. Smith")      →  ["j", "smith"]   (dot stripped)
 */
export function normalizeNameTokens(name: string): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/[.]/g, "").trim())
    .filter((t) => t.length > 0);
}

/**
 * A resolved cross-service identity. The canonical handle for a person across
 * Mail / Calendar / Reminders / Contacts.
 *
 * - `canonical` is the primary email when one exists, lowercased.
 * - `allEmails` is every email belonging to the same Contact record (multi-
 *   email collapse). Already canonicalized.
 * - `allPhones` is every phone belonging to the same Contact record, digit-only.
 * - `displayName` is the Contact's FN (Full Name) field, when known.
 * - `contactUid` is the iCloud Contact UID, or null when the identity was
 *   constructed from an email/name without a Contact backing it.
 */
export interface ResolvedIdentity {
  canonical: string;
  allEmails: string[];
  allPhones: string[];
  displayName: string;
  contactUid: string | null;
}
