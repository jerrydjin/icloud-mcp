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

## Q8: 412 means two different things depending on the precondition

**What:** iCloud returns HTTP 412 Precondition Failed for both `If-Match: <etag>` (concurrent edit) and `If-None-Match: *` (resource with this UID already exists). The status code is the same, but the semantic is opposite: one is an error, the other is a success-with-replay signal.

**Fix:** Two different validators. `requireOkAndEtagOrConflict` throws `ETagConflictError` (caller refreshes and retries). `requireOkOrUidExists` throws `UidExistsError` (caller GETs the existing resource and returns it as `replayed_existing`).

**Where it bit us:** v4.2 (M4.2) triage_commit needs idempotent CalDAV writes. Deterministic UID + `If-None-Match: *` PUT lets retries dedupe at the protocol level: iCloud returns 412 on the second call, the caller GETs the existing resource. Without the disambiguation, the same 412 would look like a concurrent-edit failure and trigger the wrong recovery path.

**Code:** `src/providers/icloud-quirks.ts` — both validators.

---

## Q9: IMAP UIDPLUS support (informational, not load-bearing)

**What:** RFC 4315 UIDPLUS causes `APPEND` to return the assigned UID synchronously via the `APPENDUID` response. `imapflow.append()` exposes this as `result.uid`. iCloud's IMAP server is widely understood to support UIDPLUS; the smoke test in `bun run smoke-test` confirms it.

**Why it matters:** v4.2 triage_commit's draft leg uses deterministic Message-Id + `SEARCH HEADER Message-Id` BEFORE APPEND for idempotency. If UIDPLUS is on, APPEND returns the UID directly. If UIDPLUS is off, the SEARCH path still works (one extra roundtrip on the create path). SEARCH is load-bearing; UIDPLUS is optimization.

**Code:** `src/providers/imap.ts:339` `append()` returns `{uid?: number}`. Optional `uid` populated only when UIDPLUS is on.

---

## Q10: SEARCH HEADER on threading headers + Sent folder name (informational)

**What:** v4.3 daily_brief response-staleness joins INBOX message-ids against
the Sent folder via `client.search({header: {"in-reply-to": id}})` and
`client.search({header: {"references": id}})`, OR'd into a single call. Two
related observations:

1. **iCloud Mail sets the Apple-convention `Sent Messages` path AND the RFC
   6154 `\Sent` SPECIAL-USE flag.** Either resolution path works; the
   provider tries SPECIAL-USE first because it's the standard.
2. **`SEARCH HEADER` on `In-Reply-To` and `References` works against iCloud's
   IMAP server.** Both headers are searchable via the same machinery proven
   in M4.2 (`searchByMessageId` for `Message-Id`).

**Why it matters:** The whole M4.3 response-staleness feature rides on these
two assumptions. `searchSentReplies` makes ONE SEARCH call per `daily_brief`
cold start (single mailbox lock; bounded by 90d SINCE) — fast as long as
the OR'd HEADER criteria are accepted.

**Open concern (OQ#4 in design doc):** The OR clause grows linearly with the
recent-message count. With 10 messages × 2 headers = 20 OR clauses. iCloud's
IMAP server is undocumented on the upper bound; if it ever rejects, the
fallback is two SEARCHes (one per header) each with a multi-id OR — still
one round trip per header instead of N. Not implemented today; design doc
ship gate is "if it works, leave it; if not, narrow."

**Code:** `src/providers/imap.ts` — `resolveSentFolder()` and
`searchSentReplies()`.

**Where it bit us:** N/A so far (M4.3 v1 just shipped). Smoke-test section G
is pre-wired to catch a regression on either assumption against a real
iCloud account. Run `bun run smoke-test` before tagging a release that
touches either method.

---

## Adding a new quirk

When you find one:
1. Reproduce it in the simplest way (a single CalDAV/CardDAV PUT, ideally captured as a fixture).
2. Add a `Q<N>` section here with: What / Symptom / Fix / Code / Where it bit us.
3. If the fix is reusable across providers, add a helper to `src/providers/icloud-quirks.ts`.
4. Add a test to the closest existing `test/*.test.ts` (or `test/icloud-quirks.test.ts` if you create it).
