# TODOS

## v2: IMAP IDLE for push notifications
**What:** Add IMAP IDLE support so the MCP server watches for new mail in real-time and can notify Claude proactively.
**Why:** Turns the MCP from a pull-based tool (Claude asks for mail) into a push-based agent (Claude gets notified of new mail). Enables workflows like "watch for emails from X and summarize them."
**Context:** imapflow supports IDLE natively. Requires switching from stdio to SSE transport since stdio is request-response only. The cross-model second opinion called this the "coolest version not yet considered."
**Depends on:** v1 complete and working. SSE transport support in MCP SDK.

## ~~v2: Provider interface abstraction for ecosystem bridge~~ DONE
Shipped in v2.0.0. ServiceProvider interface in types.ts, implemented by ImapProvider, SmtpProvider, CalDavProvider.

## v3: Tool namespacing
**What:** Namespace MCP tools by service (e.g. `mail_list_messages`, `cal_list_events`) instead of flat names.
**Why:** v2 ships 23 tools. When Contacts/Reminders push past 30, flat naming gets confusing for Claude and users. Namespacing makes tool discovery predictable.
**Context:** Current flat naming works fine at 23 tools. Revisit when adding CardDAV (Contacts) or VTODO (Reminders) providers.
**Depends on:** A 4th provider being planned.

## v3: update_event with ETag conditional PUT
**What:** Add an `update_event` tool that modifies existing calendar events using CalDAV conditional PUT with If-Match ETag.
**Why:** Users want to reschedule, add attendees, change descriptions on existing events. Currently they must delete + recreate.
**Context:** CalendarEvent already stores `etag` (added in v2). The ETag enables optimistic concurrency: PUT with If-Match header, server rejects if another client modified the event. Requires building a VCALENDAR diff (merge existing fields with updates) rather than full replacement. ical.js handles both parsing and generation.
**Depends on:** v2 Calendar tools shipped and stable.

## v2: Semantic search via embedding index
**What:** Build a local embedding index of email content so users can search by meaning ("emails about money I owe") rather than exact keywords ("invoice").
**Why:** IMAP TEXT search is keyword-only. An LLM caller can pick good keywords, but semantic search would catch conceptual matches across synonyms and phrasing. Especially useful for natural language queries from Claude.
**Context:** Requires: (1) fetching + indexing message bodies as embeddings (via an API like Voyage/OpenAI or a local model), (2) storing in a vector DB (SQLite with sqlite-vec, or flat file with cosine similarity), (3) incremental sync (track last-seen UID per folder). Cold start cost is the main concern — indexing thousands of emails on first use takes time + API calls. Lighter alternative already shipped: IMAP TEXT search, which lets Claude pick keywords server-side. Semantic search is the next tier if TEXT search proves insufficient.
**Depends on:** TEXT search shipped (validates the search UX pattern). Decision on embedding provider (API vs local model).
