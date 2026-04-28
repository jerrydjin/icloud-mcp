// iCloud-specific quirks and CalDAV/CardDAV response validation.
//
// iCloud's CalDAV/CardDAV servers deviate from the spec in subtle ways. This module
// captures the quirks once so providers don't re-debug them. See docs/ICLOUD-QUIRKS.md
// for the full backstory.

/**
 * Validate a CalDAV/CardDAV PUT response. iCloud returns 2xx + ETag header on success.
 *
 * iCloud quirk: tsdav returns the raw fetch Response without throwing on 4xx/5xx.
 * A successful PUT returns 2xx AND an ETag header. Absence of either means iCloud
 * rejected the object (often a malformed RRULE, e.g. WEEKLY without BYDAY).
 *
 * @throws Error with status, status text, response body excerpt, and a hint of the
 *         iCalendar payload that was rejected.
 */
export async function requireOkAndEtag(
  response: Response,
  payloadExcerpt: string
): Promise<string> {
  const etag = response.headers.get("etag") ?? undefined;
  if (response.ok && etag) return etag;

  let body = "";
  try {
    body = await response.text();
  } catch {
    /* ignore */
  }

  throw new Error(
    `CalDAV/CardDAV PUT rejected (status ${response.status} ${response.statusText}` +
      `${etag ? "" : ", no ETag"}). ` +
      `Response: ${body.slice(0, 500) || "<empty>"}. ` +
      `Payload: ${payloadExcerpt}`
  );
}

/**
 * Build a single-line excerpt of an iCalendar payload for inclusion in error messages.
 * Filters to UID, SUMMARY, DTSTART, DTEND, RRULE, SEQUENCE, TZID lines.
 */
export function iCalErrorExcerpt(iCalString: string): string {
  return iCalString
    .split(/\r?\n/)
    .filter((l) =>
      /^(UID|SUMMARY|DTSTART|DTEND|DUE|RRULE|SEQUENCE|TZID|STATUS|COMPLETED|PERCENT-COMPLETE)/i.test(l)
    )
    .join(" | ");
}

/**
 * iCloud rejects CalDAV/CardDAV updates that include a stale `If-Match` ETag with HTTP 412.
 * This sentinel is thrown when the server reports an ETag conflict so callers can
 * surface a "refresh and retry" hint to the user.
 */
export class ETagConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ETagConflictError";
  }
}

/**
 * Throw a typed conflict error if the response is HTTP 412 (Precondition Failed).
 * Otherwise pass through to requireOkAndEtag for the standard validation.
 */
export async function requireOkAndEtagOrConflict(
  response: Response,
  payloadExcerpt: string
): Promise<string> {
  if (response.status === 412) {
    throw new ETagConflictError(
      `Resource changed elsewhere (HTTP 412 Precondition Failed). ` +
        `Refresh and retry. Payload: ${payloadExcerpt}`
    );
  }
  return requireOkAndEtag(response, payloadExcerpt);
}
