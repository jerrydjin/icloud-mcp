# Changelog

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
