# TODOS

## v2: IMAP IDLE for push notifications
**What:** Add IMAP IDLE support so the MCP server watches for new mail in real-time and can notify Claude proactively.
**Why:** Turns the MCP from a pull-based tool (Claude asks for mail) into a push-based agent (Claude gets notified of new mail). Enables workflows like "watch for emails from X and summarize them."
**Context:** imapflow supports IDLE natively. Requires switching from stdio to SSE transport since stdio is request-response only. The cross-model second opinion called this the "coolest version not yet considered."
**Depends on:** v1 complete and working. SSE transport support in MCP SDK.

## ~~v2: Provider interface abstraction for ecosystem bridge~~ DONE
Shipped in v2.0.0. ServiceProvider interface in types.ts, implemented by ImapProvider, SmtpProvider, CalDavProvider.

## ~~v3: Tool namespacing~~ HANDLED BY v3 VERB REFACTOR
The v3 design (chief-of-staff identity, ENG-5 decision: verbs-only for new providers) makes flat tool naming a non-issue. Verb count stays low (~6); legacy v2 per-service tools stay as-is until v4 cleanup. Tool namespacing concern resolved without an explicit namespacing pass.

## v3: DST oracle / "what time is it really?" tool
**What:** A standalone tool that answers "what time is it in X timezone right now?" and "when does DST change next in X?" without needing a calendar event context.
**Why:** Users scheduling across zones need to check current offsets and upcoming DST transitions. Currently they have to create a throwaway event to see how timezones resolve.
**Context:** The timezone utility module (src/utils/timezone.ts) already has resolveTimezone, formatInTimezone, and IANA validation. A DST oracle would layer on top: use Intl.DateTimeFormat to detect current offset, then probe future dates to find the next transition. Pure computation, no external API needed.
**Depends on:** v2.1 timezone intelligence shipped.

## ~~v3: update_event with ETag conditional PUT~~ BUNDLED INTO v3 M1
Per ENG-6 decision: the same conditional-PUT machinery is needed for VTODO writes (completeReminder, updateReminder), so update_event for VEVENT lands in M1 alongside the new providers. Single implementation of the etag/If-Match pattern shared across VTODO and VEVENT updates.

## v4: Cross-service magic arc — M4.1 + M4.2 + M4.3 v1 shipped, hotfix in 4.2.1

**M4.1 (Identity Layer): SHIPPED in v4.1.0 (2026-04-30).** Levenshtein fuzzy name match + multi-email collapse + IdentityResolver wired through draft + schedule. identity_cache_flush admin tool added. See CHANGELOG.md.

**M4.2 (Triage Verb): SHIPPED in v4.2.0 (2026-05-02).** Triage proposer + triage_commit + triage_commit_retry. Deterministic-UID idempotency on all three legs (CalDAV reminder, CalDAV event, IMAP draft). HMAC-signed confirmToken with 10-min replay window. Dogfooded same day; surfaced the Vercel timeout cliff (see 4.2.1 hotfix below).

**v4.2.1 hotfix (2026-05-02):** Bumped `vercel.json` maxDuration from 10s to 60s. The 10s ceiling was killing triage_commit mid-stream — the MCP client saw the partial response then a 504 overwrote it ("shows up then invisible" symptom). Added minimal request-lifecycle logging in `api/mcp.ts` so the next debug round isn't blind.

**M4.3 v1 (Response Staleness): SHIPPED in v4.3.0 (2026-05-05).** Per-item `lastReplyFromYou: ISO | null` + `awaitingYourReply: boolean` on `daily_brief.mail.recentMessages[]`, computed via ONE bulk IMAP `SEARCH HEADER` against the Sent folder per cold start (90d SINCE). New `MessageSummary.messageId`, `imap.resolveSentFolder()`, `imap.searchSentReplies()`, `parseThreadingHeaders()` (exported pure parser), and `enrichResponseStaleness()` helper exported from `src/tools/cross.ts`. Self-sent INBOX messages get `awaitingYourReply: false`; never-replied gets `awaitingYourReply: true`; honest degradation via `mail.replyLookupError` when Sent folder undetectable. R1 contract preserved (additive fields only). 27 new tests across `imap-threading.test.ts` + `response-staleness.test.ts`; smoke-test section G pre-wired. New ICLOUD-QUIRKS Q10 documents the SPECIAL-USE / SEARCH HEADER / 20-clause OR assumptions.

**M4.3 v1 ship-gate items NOT yet done:** (1) live iCloud round-trip via `bun run smoke-test`; (2) Vercel deploy + p95 cold-start delta; (3) 5-day dogfood window where the field shapes ≥1 triage decision/day.

**M4.2 (Triage Verb): SHIPPED — historical implementation order kept for context.** Two-eng-review-cycles design locked. Implementation kicked off after 3-5 days of M4.1 dogfooding. Implementation order:
- **M4.2.0** — Install `chrono-node`, measure bundle delta + cold-start delta on Vercel before committing. If delta pushes p95 cold-start past 5 sec, fall back to ISO-8601-only regex datetime detection.
- **M4.2.1** — IMAP UIDPLUS spike: verify iCloud APPEND returns UID via UIDPLUS APPENDUID. Document in `docs/ICLOUD-QUIRKS.md`. Verify `SEARCH HEADER Message-Id` works against iCloud Drafts folder.
- **M4.2.2** — Add `UidExistsError` + `requireOkOrUidExists` to `src/providers/icloud-quirks.ts` (handle 412 on `If-None-Match: *` PUT as success-with-existing-resource, not error).
- **M4.2.3** — Add `putReminderWithUid` (reminders.ts) and `putEventWithUid` (caldav.ts) low-level methods. Existing `createReminder`/`createEvent` keep random UUIDs and become thin wrappers around the new methods.
- **M4.2.4** — Add `ImapProvider.searchByMessageId(folder, messageId): Promise<number | null>`.
- **M4.2.5** — `src/utils/proposer.ts` (action-verb regex + chrono-node datetime detection + question/request detection, all pure functions). `src/utils/confirm-token.ts` (HMAC-SHA256 sign/verify with new `CONFIRM_TOKEN_SECRET` env var; reject if unset or <32 bytes).
- **M4.2.6** — `src/verbs/triage-types.ts` (envelope types). `src/verbs/triage.ts` (proposer verb). `src/verbs/triage-commit.ts` (commit + retry handlers, co-located).
- **M4.2.7** — Tests + smoke-test extension. Critical path: idempotent replay (same token re-called within 10 min produces zero duplicate iCloud resources) + partial-failure path (one leg fails, retrySpec retries just that leg).
- **M4.2.8** — Add `CONFIRM_TOKEN_SECRET` to `.env.example`, README, and Vercel env vars before deploy.

**M4.3 (Brief Intelligence): DESIGNED.** Office-hours pass on 2026-05-02 reframed M4.3 from three operational sub-features (priority scoring, reminder grouping, suggestions) to a single sharp wedge: response-staleness on `daily_brief.mail.recentMessages[]`. Each item gets `lastReplyFromYou: ISO | null` and `awaitingYourReply: boolean`, computed via ONE bulk IMAP `SEARCH HEADER` per cold start against the Sent folder (90d SINCE). Spec at `~/.gstack/projects/jerrydjin-icloud-mcp/jerryjin-jerrydjin-next-steps-m43-design-20260502-151027.md` (Status: APPROVED, spec review 8.5/10). Other M4.3 candidates become M4.3.1+ — gated on dogfood signals from v1.

Architectural decisions locked by /plan-eng-review on 2026-05-02 (lightweight pre-flight, supersedes any cache wording in design doc M4.3 section):
- **Priority data:** compute on the fly per request from IMAP Sent folder; no jsonl cache, no Vercel KV. The "rebuilt on first daily_brief of the day" wording in the design doc was pre-Vercel-rev-3 residue and does not apply.
- **Suggestions shape:** structured `{kind, target_uid, args}` objects, not opaque text. Keep the kind enum to 3-4 values in M4.3 v1; version-tag the field for forward-compat.
- **Reminder→contact mapping:** regex `@mention` extraction from reminder title only. No fuzzy substring matching. Opt-in by user behavior; sparse-by-design rather than noisy.

Open concerns for the office-hours design pass to resolve:
- Measure p95 daily_brief cold-start before/after each candidate; if it doubles, drop priority scoring (candidate 1).
- Consider blending sender frequency with reply-rate to avoid newsletter dominance (same Sent folder data, no extra cost).
- Add a one-line jsonl append per suggestion shown so the "act on ≥1 in 5 days" ship gate becomes measurable instead of vibes-only.
- daily_brief response shape: additive fields only — R1 contract at `src/tools/cross.ts:32` freezes v2 fields.
- daily_brief stays read-only: "reschedule past-due reminder" is suggestion-only; user takes a separate verb call to act.

**Depends on:** v4.1 dogfood data lands (3-5 days post-ship), Vercel cold-start measurement validates per-request cache architecture, M4.2 ships and dogfoods for ~1 week before /office-hours opens M4.3 design pass.

## v4: Per-operation iCloud timeouts (defense-in-depth follow-up to 4.2.1)
**What:** Add per-operation request timeouts on the IMAP / CalDAV / SMTP providers so a single hung iCloud call fails fast instead of consuming the whole 60s function budget.
**Why:** v4.2.1 raised `vercel.json maxDuration` from 10 → 60 to fix the routine triage_commit timeout cliff. That eliminates the day-to-day cliff but a single hung iCloud request can still kill the function (now at 60s instead of 10s). Per-operation timeouts (~10-15s each) would let one slow leg fail cleanly while the other legs in triage_commit still return a useful partial result via the existing `partial: true` path.
**Context:** Each provider library handles timeouts differently. `imapflow` has `socketTimeout` constructor option. CalDAV provider uses `fetch` (undici under the hood) — needs `AbortSignal.timeout(ms)` per request. SMTP via `nodemailer` has `connectionTimeout` + `socketTimeout`. Threading a sane default through all three providers is real surgery — needs ~1 weekend including tests against deliberately-slow iCloud responses.
**Pros:** triage_commit's partial-failure path becomes useful in the wild, not just the lab; debugging is sharper (which leg hung); 60s budget is preserved for legs that genuinely need it.
**Cons:** Real implementation work; risk of false-positive timeouts on slow-but-valid iCloud responses; tuning the defaults is a guess until production data backs them.
**Depends on:** 4.2.1 deployed and dogfooded for at least a week so we know whether 60s alone is sufficient. If so, this stays deferred.

## v4: macOS Keychain credential storage
**What:** Replace env-var-based auth with macOS Keychain on Mac, falling back to env vars on Linux/Vercel/missing-Keychain.
**Why:** Env vars in shell config files are crude. Keychain is the macOS-native credential store; iteratio/icloud-mcp uses this pattern. Smoother first-run UX, no plaintext passwords in dotfiles.
**Context:** v3 keeps env-var pattern (matches v2). v4 makes Keychain the default on Mac with env-var fallback. Need a credential resolution priority: Keychain → env var → setup prompt. iteratio/icloud-mcp is the reference implementation.
**Depends on:** v3 ships with env-var pattern stable.

## v4: EventKit-based Reminders depth (smart lists, subtasks, location triggers)
**What:** Add Mac-local Reminders depth via EventKit, accessible via the verb layer's capability negotiation envelope (already designed in v3 ENG-4).
**Why:** Apple removed CalDAV-first design from Reminders in iOS 13+. Smart lists, nested subtasks, location triggers, and attachments only round-trip cleanly via EventKit on a Mac. v3 ships VTODO-basic via CalDAV (no depth); v4 brings back the full depth.
**Context:** The 30-min TCC spike on 2026-04-28 (artifacts at eventkit-cli/spike/) proved that ad-hoc-signed binaries cannot get Reminders TCC permission on macOS 26.4 — silently denied even with embedded Info.plist + entitlements + .app wrapping. Path forward requires a paid Apple Developer Program membership ($99/year) for Developer ID signing + notarytool notarization. That cost is the gating decision for v4.
**Depends on:** Real users on v3 wanting depth; willingness to pay $99/year; OR Apple changing TCC policy for ad-hoc binaries (unlikely).

## v4+: Notes content via AppleScript / Notes scripting bridge
**What:** Read Apple Notes content via AppleScript (or the Notes app's scripting interface) on Mac, exposed as a NotesProvider.
**Why:** Notes is the most-asked-about Apple service that v3 explicitly punts (P4 scope ceiling). Has no remote API; only Mac-local access works. Closes the highest-volume gap from "all Apple products" framing.
**Context:** RafalWilinski/mcp-apple-notes does RAG over Apple Notes — useful prior art. icloud-mcp would shell out to AppleScript via Bun.$ (matching the EventKit shell-out pattern originally planned in v3). Brittle (AppleScript bridge can break on macOS updates); slow (AppleScript IPC is heavyweight). NOTE: AppleScript automation likely hits the same TCC issue as EventKit — see the v3 spike at eventkit-cli/spike/. Will need a developer cert for any real Mac-local Apple service access. Test cheaply via a 30-min AppleScript spike before committing.
**Depends on:** v4 EventKit work proven (validates the dev cert + signed app pattern).

## v2: Semantic search via embedding index
**What:** Build a local embedding index of email content so users can search by meaning ("emails about money I owe") rather than exact keywords ("invoice").
**Why:** IMAP TEXT search is keyword-only. An LLM caller can pick good keywords, but semantic search would catch conceptual matches across synonyms and phrasing. Especially useful for natural language queries from Claude.
**Context:** Requires: (1) fetching + indexing message bodies as embeddings (via an API like Voyage/OpenAI or a local model), (2) storing in a vector DB (SQLite with sqlite-vec, or flat file with cosine similarity), (3) incremental sync (track last-seen UID per folder). Cold start cost is the main concern — indexing thousands of emails on first use takes time + API calls. Lighter alternative already shipped: IMAP TEXT search, which lets Claude pick keywords server-side. Semantic search is the next tier if TEXT search proves insufficient.
**Depends on:** TEXT search shipped (validates the search UX pattern). Decision on embedding provider (API vs local model).
