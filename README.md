# icloud-mcp

Claude as a chief of staff across your iCloud account. An MCP server that bridges Claude Desktop (or any MCP client) to your Mail, Calendar, Reminders, and Contacts so Claude can triage your morning, schedule meetings, draft emails, defer tasks, and search across all four services in a single prompt.

The novelty isn't that it bridges iCloud (a handful of MCPs already do that). The novelty is the cross-service verbs that compose across iCloud silos — moving a Mail thread into a Reminder, scheduling around your calendar, drafting an email by contact name instead of email address, all in one call.

## What you can do

**Cross-service verbs (v3, the chief of staff)**

- `daily_brief` — your morning view. Today's calendar + unread mail + overdue/due-today reminders, all in one tool call. Times in your timezone. Per-source errors don't block the whole brief.
- `find` — search across Mail / Calendar / Reminders / Contacts in parallel. Per-service results; no cross-service dedup yet (v4 work).
- `schedule` — create a calendar event with attendee resolution (names → contact emails) and conflict detection. Tells you what overlaps; lets you confirm.
- `draft` — save an email draft with contact resolution. Names get looked up in Contacts; ambiguous names surface for user clarification before the draft lands.
- `defer` — snooze a reminder to a later due date. ETag conditional PUT means concurrent edits surface as a clear error.

**Per-service tools (v2 surface, kept for direct access)**

Mail: `list_folders`, `list_messages`, `read_message`, `search_messages`, `send_email`, `create_draft`, `create_reply_draft`, `send_draft`, `move_message`, `delete_message`, `mark_seen`, `mark_unseen`, `flag_message`, `unflag_message`.

Calendar: `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event` (v3, new), `delete_event`.

## Setup

Install dependencies:

```bash
bun install
```

Configure credentials. iCloud uses an app-specific password (generate at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords):

```bash
cp .env.example .env
# edit .env: set ICLOUD_EMAIL and ICLOUD_APP_PASSWORD
```

Run the MCP server (stdio transport, for Claude Desktop):

```bash
bun run start
```

Or via Vercel for remote access. Production deployment lives at **`https://icloud.jerryjin.dev/api/mcp`** (StreamableHTTP transport with bearer-token auth — set `AUTH_TOKEN` in your Vercel environment variables; see `api/mcp.ts`).

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "icloud": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/icloud-mcp/src/server.ts"],
      "env": {
        "ICLOUD_EMAIL": "your@icloud.com",
        "ICLOUD_APP_PASSWORD": "xxxx-xxxx-xxxx-xxxx"
      }
    }
  }
}
```

Restart Claude Desktop. Try: *"What's on my plate today?"* (calls `daily_brief`).

## Verifying the install

```bash
bun test               # 188 unit tests, no creds required
bun run smoke-test     # read-only round-trip against your real iCloud
```

The smoke test exercises every provider (IMAP, SMTP, CalDAV calendars + VTODO, CardDAV) without writing anything. It's the live-credential backstop for the recorded-fixture unit tests — fixtures rot when iCloud changes its protocol semantics, and the smoke run catches that drift.

## Architecture

```
src/
  server.ts          MCP server, instantiates providers, registers tools+verbs
  providers/
    caldav-transport.ts    Shared CalDAV/CardDAV connection base class
    icloud-quirks.ts       requireOkAndEtag + ETagConflictError + iCalErrorExcerpt
    discovery-cache.ts     TTL'd cache for PROPFIND discovery
    imap.ts                Mail read
    smtp.ts                Mail send
    caldav.ts              Calendar (VEVENT)
    reminders.ts           Reminders (VTODO via CalDAV)
    contacts.ts            Contacts (CardDAV with hand-rolled vCard parser)
  tools/             v2 per-service MCP tool registrations
  verbs/             v3 cross-service verb registrations + shared envelope
  utils/
    timezone.ts            Resolve / register / convert iCloud-friendly timezones
    rrule.ts               Recurrence rule construction
    identity.ts            canonicalEmail + sameEmail (minimal v3 dedup)
docs/
  ICLOUD-QUIRKS.md         Canonical record of iCloud's CalDAV/CardDAV deviations
eventkit-cli/spike/        TCC feasibility test that proved EventKit needs a paid
                           Apple Developer cert (v3 stayed cloud-only as a result)
```

The verb response envelope is consistent across all v3 verbs:

```ts
{
  items: <verb-specific shape>,
  degraded: boolean,                    // true if any source failed
  errors: { source, message }[],        // per-source failures
  userMessage?: string,                 // what the LLM should tell the user
}
```

## What's NOT here

Reminders smart lists, nested subtasks, location triggers, and attachments — Apple removed those from CalDAV in iOS 13+ and they're EventKit-only on Mac. The TCC spike at `eventkit-cli/spike/` proved ad-hoc-signed CLI binaries can't get Reminders TCC permission on macOS 26.4; v4 will revisit if a paid Apple Developer cert becomes available. See `TODOS.md`.

Notes, Photos, Health, Find My, Wallet, Maps — Apple closed APIs, no remote access at all. Notes via AppleScript is a v4+ TODO.

Cross-service identity dedup beyond email canonicalization (multi-email contacts, fuzzy name matching, phone-number fallback) — v4 TODO.

## Contributing

Push straight to main; no branches/PRs for this project. Solo developer workflow.

iCloud's CalDAV/CardDAV servers deviate from the spec in ways that took multiple commits to figure out. Before adding a new write path, read [`docs/ICLOUD-QUIRKS.md`](docs/ICLOUD-QUIRKS.md) and use the shared `requireOkAndEtag` validator from `icloud-quirks.ts`. New iCloud quirks discovered in the wild should land in that doc.

Tests follow a pure-function-extraction pattern — `test/caldav.test.ts:13-40` is the model. Network-dependent integration tests live in `smoke-test.ts` and run against a real account.

## License

MIT (or whatever you prefer — currently unspecified).
