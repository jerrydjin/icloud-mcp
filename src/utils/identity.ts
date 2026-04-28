// Identity utilities for cross-service entity resolution.
//
// v3 ships a minimal email-based dedup (per ENG-15). The full version with
// fuzzy name matching, multi-email contacts, and phone-number fallback is
// deferred to v4 (see TODOS.md). For v3, the rule is simple: same canonical
// email = same person.
//
// This is the DRY-promotion of the case-insensitive email comparison already
// used at src/tools/cross.ts:238 for excludeSelf filtering.

/**
 * Canonicalize an email address for cross-service comparison.
 *
 * - Lowercase the entire address (RFC 5321 says local parts are case-sensitive
 *   but in practice every major provider treats them case-insensitively, and
 *   iCloud is the case here).
 * - Trim whitespace.
 * - Strip surrounding angle brackets if present (`<jane@example.com>` → `jane@example.com`).
 * - Strip a leading "mailto:" if present (CalDAV ATTENDEE values use `mailto:` prefix).
 * - Strip Gmail-style plus-addressing (`jane+tag@example.com` → `jane@example.com`)
 *   ONLY for known-aliasing domains (gmail.com, googlemail.com). For other
 *   domains the plus-tag may be load-bearing (some providers treat it as a
 *   distinct address).
 *
 * Returns "" for inputs that don't look like emails (no @ sign).
 */
export function canonicalEmail(addr: string): string {
  if (!addr) return "";
  let s = addr.trim().toLowerCase();

  // Strip mailto: prefix (CalDAV ATTENDEE values)
  if (s.startsWith("mailto:")) s = s.slice(7);

  // Strip surrounding angle brackets
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);

  // Strip "Display Name <email@host>" — keep only what's inside the brackets
  const bracketMatch = s.match(/<([^>]+)>/);
  if (bracketMatch) s = bracketMatch[1]!;

  s = s.trim();

  // Must have an @
  const atIdx = s.indexOf("@");
  if (atIdx === -1 || atIdx === 0 || atIdx === s.length - 1) return "";

  const localPart = s.slice(0, atIdx);
  const domain = s.slice(atIdx + 1);

  // Plus-address stripping for known-aliasing domains
  const domainAliases = new Set(["gmail.com", "googlemail.com"]);
  let effectiveLocal = localPart;
  if (domainAliases.has(domain)) {
    const plusIdx = localPart.indexOf("+");
    if (plusIdx > 0) effectiveLocal = localPart.slice(0, plusIdx);
    // Gmail also ignores dots in the local part
    effectiveLocal = effectiveLocal.replace(/\./g, "");
  }

  return `${effectiveLocal}@${domain}`;
}

/**
 * True if two email addresses canonicalize to the same value. Convenience wrapper
 * around canonicalEmail for the common case.
 */
export function sameEmail(a: string, b: string): boolean {
  const ca = canonicalEmail(a);
  const cb = canonicalEmail(b);
  return ca !== "" && ca === cb;
}
