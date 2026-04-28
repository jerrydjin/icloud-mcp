# iCloud CalDAV/CardDAV Quirks

Things iCloud does that CalDAV (RFC 4791) and CardDAV (RFC 6352) specs don't say. This file is the canonical record. When you hit a new quirk, add it here.

The shared utility lives at `src/providers/icloud-quirks.ts`. New providers (RemindersProvider via VTODO, ContactsProvider via CardDAV) MUST import from there rather than re-implementing.

---

## Q1: Successful PUT requires 2xx AND an ETag header

**What:** `tsdav` returns the raw fetch `Response` without throwing on 4xx/5xx. iCloud's CalDAV server returns 2xx on successful writes WITH an `ETag` header. If you only check `response.ok`, you can fake-succeed on rejections.

**Symptom we hit:** Recurring events silently dropped. Calendar object showed up in iCloud webapp briefly, then disappeared. iCloud was rejecting our write but `response.ok` was true (or the rejection was conveyed via missing ETag, depending on the failure mode).

**Fix:** Validate BOTH `response.ok === true` AND `response.headers.get("etag")` is non-empty. Throw with a payload excerpt if either is missing.

**Code:** `requireOkAndEtag(response, payloadExcerpt)` in `src/providers/icloud-quirks.ts`.

**Where it bit us:** commits 48d1415, 98612fd, c1de7d8 (three rounds of recurring-event fixes).

---

## Q2: WEEKLY RRULE without BYDAY is silently dropped

**What:** Per RFC 5545 § 3.8.5.3, `RRULE:FREQ=WEEKLY;COUNT=10` is valid — it should repeat weekly on the same weekday as DTSTART. iCloud refuses this. The PUT succeeds, but the recurrence never fires.

**Fix:** Always include `BYDAY` for WEEKLY rules. Infer the weekday from DTSTART if the caller didn't specify one.

**Code:** `weekdayOfStart()` in `src/utils/rrule.ts`. The CalendarProvider's `createEvent` injects BYDAY when `frequency === "WEEKLY"` and `byWeekday` is missing or empty.

---

## Q3: DTSTAMP, CREATED, LAST-MODIFIED MUST be UTC

**What:** Per RFC 5545 these properties are always UTC ("Z" suffix). iCloud rejects events where these are timezone-local.

**Fix:** When building VEVENT/VTODO components, use `ICAL.Time.fromJSDate(new Date(), true)` (the `true` means UTC). Always.

**Where:** Every property setter for `dtstamp`, `created`, `last-modified` in CalendarProvider and (future) RemindersProvider.

---

## Q4: SEQUENCE 0 is required for recurring events

**What:** Spec says SEQUENCE is optional for new events; iCloud expects it on recurring writes.

**Fix:** Always set `SEQUENCE: 0` on new VEVENT/VTODO with RRULE. Bump on every update_event.

**Harmless when:** SEQUENCE is set on non-recurring events too. Just always include it.

---

## Q5: VTIMEZONE name mismatches reject UTC-recurring events

**What:** If you write a recurring event with timezone "UTC" but emit a VTIMEZONE component named "Etc/UTC" (or vice versa), iCloud rejects the write. The mismatch isn't checked on non-recurring events but blows up when RRULE is present.

**Fix:** UTC events are emitted as Z-suffix DATE-TIME with NO `TZID` parameter and NO `VTIMEZONE` subcomponent. The CalendarProvider has an explicit `isUtcTimezone(tz)` branch that takes this path.

---

## Q6: VTODO has analogous quirks (deferred from VEVENT, expected to bite)

VTODO writes will hit the same patterns as VEVENT. When implementing RemindersProvider:
- Use `requireOkAndEtag()` for writes (Q1)
- DTSTAMP/CREATED/LAST-MODIFIED in UTC (Q3)
- SEQUENCE on every write, bump on update (Q4)
- DUE dates: same TZID rules as DTSTART/DTEND from Q5

**Test against real iCloud** before declaring it shipped — the quirks are not the same in their specifics, just in their shape.

---

## Q7: ETag conditional PUT for safe updates

**What:** When updating an existing event/reminder, send `If-Match: <stored-etag>` to detect conflicts. iCloud returns 412 Precondition Failed if anything else modified the object since you read it (your phone marking a reminder complete, for instance).

**Fix:** `requireOkAndEtagOrConflict()` distinguishes 412 (throws `ETagConflictError`) from other failures. Callers can catch the conflict, refresh, and retry.

**Code:** `src/providers/icloud-quirks.ts`.

---

## Adding a new quirk

When you find one:
1. Reproduce it in the simplest way (a single CalDAV/CardDAV PUT, ideally captured as a fixture).
2. Add a `Q<N>` section here with: What / Symptom / Fix / Code / Where it bit us.
3. If the fix is reusable across providers, add a helper to `src/providers/icloud-quirks.ts`.
4. Add a test to the closest existing `test/*.test.ts` (or `test/icloud-quirks.test.ts` if you create it).
