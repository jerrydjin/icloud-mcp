# Changelog

## 4.3.0 — Brief intelligence: response staleness (M4.3 v1)

Every recent inbound message in `daily_brief.mail.recentMessages[]` now knows
whether *you* are the bottleneck. The brief stops being a list of mail and
becomes a status of your outbox: who you've left hanging, who's still waiting
on you, who you've handled. This is M4.1 (identity layer) graduating from
infrastructure to lead actor.

### Added

- `MessageSummary.messageId: string | null` — populated from `envelope.messageId`
  on every IMAP fetch path (`listMessages`, `search`). Required precondition
  for the Sent-folder threading join.
- `MessageSummary.lastReplyFromYou?: string | null` and
  `MessageSummary.awaitingYourReply?: boolean` — populated by `daily_brief`
  on each `recentMessages[]` item. ISO 8601 UTC of your most recent reply, and
  whether the inbound message is newer than your latest reply (ball is in your
  court).
- `imap.resolveSentFolder(): Promise<string | null>` — resolves the Sent
  folder via RFC 6154 SPECIAL-USE flag (`\Sent`) first, falling back to the
  well-known names `Sent Messages` / `Sent` / `INBOX.Sent`. Result is cached
  on the provider instance for the request lifetime; cleared on disconnect.
  iCloud sets specialUse on `Sent Messages` so the SPECIAL-USE path is the
  hot path on Apple accounts.
- `imap.searchSentReplies(folder, messageIds, sinceDays): Promise<SentReplyEntry[]>` —
  ONE bulk `SEARCH HEADER` against the Sent folder OR'd across both
  `In-Reply-To` and `References` for every inbound message-id, scoped by
  `SINCE` to avoid scanning multi-year histories. Single mailbox-lock
  acquisition, single round trip. Returns `{messageId, inReplyTo,
  references[], date}` per match for the caller to do the threading join.
- `parseThreadingHeaders(raw)` — exported pure parser for the
  In-Reply-To/References header buffer that `imapflow` returns from a
  `headers: [...]` fetch. Handles RFC 5322 header folding correctly.
- `enrichResponseStaleness(messages, imap, selfEmail, sinceDays?)` — the
  composeDailyBrief enrichment function (exported from `src/tools/cross.ts`
  for testability). Filters self-sent + no-messageId messages out of the
  IMAP query, runs the bulk SEARCH, joins on In-Reply-To OR References,
  picks the latest reply by date, and stamps the two new fields. Returns
  `{messages, replyLookupError?}` for honest degradation.
- `mail.replyLookupError` on the `daily_brief` response — set when the Sent
  folder is undetectable or the bulk SEARCH throws. Additive field; absent
  on the happy path. v2 callers ignore it; v4.3+ callers can show "couldn't
  check reply history" instead of guessing wrong.

### Changed

- `daily_brief` — wires `enrichResponseStaleness` after the existing
  `mailResults[0]` resolves. No new round trips on the calendar/reminders
  paths. The composeDailyBrief input gains an optional `replyLookupError`
  field; the R1 regression contract (cross.ts:32) is preserved — all v2
  fields still appear unchanged.
- `PRODID` and version strings bumped to `v4.3.0` in `package.json`,
  `src/server.ts`, `api/mcp.ts`.

### Architecture notes (Vercel-serverless honest)

The Sent folder cache lives on the `ImapProvider` instance — per-request on
Vercel (one cold start = one LIST + N searches), per-process on stdio. This
matches the M4.1 IdentityResolver and `discovery-cache` patterns. There is no
cross-invocation cache and no Vercel KV; the design's lock-in (D2 from the
M4.3 eng review) was per-request compute over reuse-the-cache.

Replies older than 90 days return `lastReplyFromYou: null` and
`awaitingYourReply: true` — same shape as never-replied. Honest degradation,
documented in success criteria. Callers wanting longer history can extend the
`sinceDays` parameter (default 90).

### Dropped from M4.3 v1 (gated on dogfood signal)

Reminder @-mention grouping, structured suggestions, priority scoring,
attendee context, anomaly highlighting — all become M4.3.1+ candidates. The
v1 scope deliberately ships ONE sharp wedge: response-staleness. If the
dogfood-gate (5+ days where the field shapes a triage decision) doesn't hold,
the entire feature reverts cleanly: additive fields drop, two new IMAP
methods drop, no other regression.

### Tests

27 new tests across `imap-threading.test.ts` (11 — header parsing edge cases
including RFC 5322 folding) and `response-staleness.test.ts` (16 — empty +
skip cases, folder/search error degradation, never-replied,
matched-via-In-Reply-To, matched-via-References, inbound-newer-than-reply,
multi-match latest-wins, mixed self-sent/answered/unanswered, custom
sinceDays). Extended `daily-brief.test.ts` with `replyLookupError` shape
assertions. Total 313 tests pass; `bun run typecheck` is clean.

### Ship-gate items NOT done in this release

- Live iCloud round-trip via `bun run smoke-test` against a real account to
  confirm SPECIAL-USE flag resolution + bulk SEARCH HEADER works on iCloud.
  Section G of the smoke test is pre-wired for this; run before tagging the
  release.
- Vercel deploy + p95 cold-start measurement on `daily_brief` before vs after.
  Ship gate (per design doc): if p95 doubles, the feature reverts.
- Five-day dogfood window where the field shapes at least one triage decision
  per day. Soft signal; measured by you, not telemetry.

### Known follow-ups

- 20-clause OR criterion on bulk SEARCH (10 messages × 2 headers): if iCloud
  rejects, fallback is two SEARCHes (one per header), each with multi-id OR.
  Documented in `docs/ICLOUD-QUIRKS.md` Q10.

## 4.2.1 — Vercel timeout fix + request logging

Hotfix for triage_commit "shows up then invisible" symptom in MCP clients.
Root cause: `vercel.json` had `maxDuration: 10` capping every function invocation
at 10 seconds. triage_commit does up to three sequential iCloud writes (CalDAV
PUT for reminder, CalDAV PUT for event, IMAP APPEND for draft); each iCloud
operation runs 1-3s on a good day, plus cold-start auth and DNS. Three legs
plus setup easily exceeded 10s, so Vercel killed the function mid-stream — the
MCP client received a partial JSON response, then the connection died and a
504 timeout error overwrote it. The writes usually succeeded in iCloud anyway,
but the LLM caller saw the call as failed.

### Fixed

- `vercel.json` — `maxDuration` raised from 10 to 60. 60s is the hobby-tier
  ceiling and gives 6× headroom for the worst-case three-leg triage_commit.

### Added

- `api/mcp.ts` — minimal request-lifecycle logging on the POST handler. Logs
  `[mcp] ok method=<rpc-method> tool=<tool-name> dur=<ms>` on success and
  `[mcp] err ... msg=<err>` on failure. Visible in `vercel logs` and the
  Vercel dashboard. No auth headers, no request bodies, no secrets — just
  shape and timing. Lets you see "every triage_commit call takes 8.5s" at a
  glance instead of debugging blind.

### Notes

This release does not address the underlying single-hung-iCloud-call risk.
A per-operation timeout pass on the IMAP/CalDAV/SMTP providers is captured in
TODOS.md as defense-in-depth follow-up. The 60s ceiling means a single hung
call still kills the function, but takes 60s instead of 10s. In practice this
is rare with iCloud; the routine timeout cliff is what was hurting daily use.

## 4.2.0 — Triage verb (M4.2)

The cornerstone v3-design verb. Read a mail message, propose cross-service
actions (reminder + event + draft), confirm, then commit with deterministic-UID
idempotency. Re-running commit with the same proposal produces zero duplicate
iCloud resources.

### Added

- `triage(uid, folder?)` MCP tool — analyzes a mail message and returns a
  signed `TriagePlan`. Proposes a reminder when the body contains action verbs
  ("please send", "let me know", "follow up", etc.), an event when an explicit
  datetime is detected via `chrono-node`, and a draft reply when the message is
  a question/request from a known correspondent. Calendar overlaps surface in
  `conflicts` (non-blocking). Identity resolution flows through M4.1's
  `IdentityResolver` so `proposed.contacts` returns canonical entities.
- `triage_commit(confirmToken, proposed)` MCP tool — verifies the HMAC-signed
  token, then executes each leg with deterministic-UID idempotency:
    - Reminder leg: VTODO PUT with `If-None-Match: *` and a UID derived from
      the leg's idempotencyKey. 412 from iCloud means "exists already" — we
      GET-and-return as `replayed_existing`.
    - Event leg: same pattern via `caldav.putEventWithUid`.
    - Draft leg: SEARCH HEADER Message-Id BEFORE APPEND with a deterministic
      Message-Id. If found, return that UID as `replayed_existing`; else
      APPEND a new draft.
  Each leg runs independently; one leg's failure doesn't block others. The
  `partial: true` flag is set when at least one leg failed.
- `triage_commit_retry(legs, payload)` MCP tool — after the 10-min token
  window expires (or when only some legs need retrying), retry specific legs
  by passing the original `idempotencyKeys`. Already-succeeded legs replay
  via the same idempotency mechanism without duplicates.
- `src/utils/proposer.ts` — pure functions: `detectActionVerb`,
  `detectDatetime` (chrono-node + sanity bounds), `detectQuestionOrRequest`.
- `src/utils/confirm-token.ts` — HMAC-SHA256 sign + verify. Hard gate: throws
  if `CONFIRM_TOKEN_SECRET` is unset or under 32 chars. Constant-time MAC
  comparison.
- `src/verbs/triage-types.ts` — envelope types (`TriagePlan`, `CommitResult`,
  `RetrySpec`, leg-result discriminated unions).
- `src/providers/icloud-quirks.ts` — new `UidExistsError` + `requireOkOrUidExists`
  validator for the `If-None-Match: *` 412 path. Distinct from
  `ETagConflictError` so triage_commit's catch blocks can route the two
  semantics correctly.
- `src/providers/reminders.ts` — new `putReminderWithUid(listUrl, uid, input)`
  low-level method. Existing `createReminder` becomes a thin wrapper that
  delegates with `crypto.randomUUID()`.
- `src/providers/caldav.ts` — new `putEventWithUid(calendarUrl, uid, input)`.
  Same wrapper-around-low-level pattern.
- `src/providers/imap.ts` — new `searchByMessageId(folder, messageId)` for
  the draft leg's SEARCH-before-APPEND idempotency check.
- `src/providers/smtp.ts` — `buildRawMessage` accepts optional `messageId` so
  the draft leg can bake in a deterministic header.

### Changed

- `PRODID` in generated VEVENTs bumped to `v4.2`.
- iCloud-MCP version bumped from `4.1.0` to `4.2.0`.

### Architecture notes

The deterministic-UID idempotency mechanism: same proposal content → same
idempotencyKey → same UUID/Message-Id → iCloud dedupes at the protocol level.
Per-leg keys mean a partial-failure retry only re-creates the failed legs;
already-succeeded legs replay as `replayed_existing` without duplicates.

`confirmToken` is HMAC-signed over the canonicalized proposal hash with a
10-min `exp`. Single-use enforcement is best-effort (no shared memory across
Vercel invocations); per-leg idempotency keys do the correctness work. Token
is integrity-only.

`CONFIRM_TOKEN_SECRET` MUST be a separate env var from `AUTH_TOKEN`. A leaked
bearer token alone cannot be used to forge triage proposals.

### Tests

54 new M4.2 tests across `proposer.test.ts` (13), `confirm-token.test.ts`
(13), `triage.test.ts` (22 — fnv1a64, idempotencyKey, UUID/Message-Id
derivation), `triage-commit.test.ts` (6 — happy path, replay safety, partial
failure, expired token, tampered proposal). Total 286 tests pass.

### Ship-gate items NOT done in this release

- Live iCloud round-trip smoke test for replay safety against real Calendar +
  Reminders + Drafts. Run `bun run smoke-test` after deploy with a real
  triage on a real mail message.
- Vercel deploy + p95 cold-start measurement post-`chrono-node` install
  (~80KB bundle delta, well under the 500KB budget — should be fine).
- Set `CONFIRM_TOKEN_SECRET` in Vercel env vars before first production triage.

### Operational note: chrono-node bundle delta

Measured at M4.2.0: chrono-node adds ~80KB to the bundle (well under the
500KB budget). ISO-only fallback was NOT needed.

## 4.1.0 — Identity layer (M4.1)

The first half of the v4 cross-service magic arc. Every name lookup the verbs do
now goes through a single resolver that handles fuzzy matching, multi-email
collapse, and shared-phone collapse. Triage (M4.2) and brief intelligence (M4.3,
candidate) come in later releases.

### Added

- `src/utils/identity.ts` — Levenshtein distance + similarity helpers,
  `normalizeNameTokens`, `canonicalPhone`, `ResolvedIdentity` type,
  `FUZZY_NAME_THRESHOLD` constant (default 0.85).
- `src/providers/identity-cache.ts` — `IdentityResolver` class. Lazily fetches
  the full Contacts list once per request, builds a canonical-email →
  contactUid index plus a phone → contactUid index, exposes
  `resolveIdentity(emailOrName)` returning a single canonical identity, an
  ambiguity envelope, or an unresolved reason. `flush()` invalidates the
  cache for the `identity_cache_flush` admin tool.
- `identity_cache_flush` MCP tool — drops the resolver's Contacts cache so
  the next verb call refetches. Useful during long-lived stdio sessions when
  a Contact has been edited in the iCloud Contacts app.
- Fuzzy fallback in `matchContacts` — fires only when exact + partial yield
  zero AND the query looks like a name (no `@`, no digits). Two-stage:
  prefix-prune the candidate set via 2-character token prefixes, then
  Levenshtein over the pruned set with a configurable threshold.
- `IdentityResolver` is wired into `VerbContext` and instantiated alongside
  providers in both stdio (`src/server.ts`) and Vercel (`api/mcp.ts`).

### Changed

- `draft.ts` and `schedule.ts` route name resolution through
  `ctx.identityResolver.resolveIdentity()` instead of calling
  `searchContacts()` directly. Net effect: fuzzy typos in attendee/recipient
  names now resolve, and a Contact with multiple emails resolves to one
  identity (preferred email) rather than ambiguity.
- `PRODID` in generated vCards bumped from `v3` to `v4`.
- iCloud-MCP `version` reported through MCP handshake bumped from `3.0.0` to
  `4.1.0`.

### Architecture notes (Vercel-serverless honest)

Identity cache lifecycle is **per-request on Vercel** (no cross-invocation
memory) and **per-process on stdio**. This is the same lifecycle pattern as
`src/providers/discovery-cache.ts`. Vercel cold starts pay the full
Contacts-fetch cost on every request — see Open Question #4 in the M4.1
design doc for the measurement-and-revisit gate.

The multi-email collapse rule is **explicit-linkage only**: two emails belong
to the same identity if they appear in the same Contact's `emails[]`, or if
two Contacts share a phone number. Name + domain heuristics are deliberately
NOT used (false-merges common names at large providers).

Phone-number fallback is deferred to v4.1.1. Pre-M4.1 spike confirmed no
verb has a callsite that benefits from phone-only resolution today.

### Tests

- `test/identity.test.ts` — 14 new cases for `canonicalPhone`, `levenshtein`,
  `levenshteinSimilarity`, `normalizeNameTokens`.
- `test/contacts.test.ts` — 9 new cases for fuzzy fallback in `matchContacts`
  and the standalone `fuzzyNameMatches` function.
- `test/identity-resolver.test.ts` — 12 new cases covering email lookup, name
  lookup, fuzzy resolution, ambiguity, multi-email collapse, flush, fetch
  failure handling.
- Total: 232 tests pass, 0 fail. `bun run typecheck` is clean.

### Ship-gate items NOT done in this release

- Vercel deploy + measure p95 cold-start latency on `daily_brief` against the
  real Contacts list. If p95 >5 sec, revisit the per-request cache decision.
- Manual 5-contact dogfood verification on real iCloud (one with multi-email,
  one with fuzzy variants, one phone-only, two control). Run
  `bun run smoke-test` after deploy and walk through each case.
- Levenshtein threshold tuning. 0.85 is a guess; calibrate during dogfooding
  by logging false positives and negatives.

### Fixed

- `src/utils/timezone.ts:57` — `ICAL.TimezoneService.register` argument order
  was swapped (pre-existing typecheck error from before v4 work). Now calls
  `register(timezone, name)` per the ical.js API.

## 3.0.0 — Chief of staff across iCloud

(See git history for the full v3 arc: caldav transport refactor, reminders
provider, contacts provider, find/draft/schedule/defer/daily_brief verbs,
update_event, discovery cache, identity utility v1.)
