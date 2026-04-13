# TODOS

## v2: IMAP IDLE for push notifications
**What:** Add IMAP IDLE support so the MCP server watches for new mail in real-time and can notify Claude proactively.
**Why:** Turns the MCP from a pull-based tool (Claude asks for mail) into a push-based agent (Claude gets notified of new mail). Enables workflows like "watch for emails from X and summarize them."
**Context:** imapflow supports IDLE natively. Requires switching from stdio to SSE transport since stdio is request-response only. The cross-model second opinion called this the "coolest version not yet considered."
**Depends on:** v1 complete and working. SSE transport support in MCP SDK.

## v2: Provider interface abstraction for ecosystem bridge
**What:** Define an abstract provider interface (connect, disconnect, list, read, search, write) that IMAP/SMTP implements and future CalDAV/CardDAV providers would implement.
**Why:** The "Apple ecosystem bridge" vision (Calendar, Contacts, Reminders) depends on the tool layer being provider-agnostic. Without a concrete interface, adding CalDAV may require rewriting the tool layer.
**Context:** Current design has concrete ImapProvider and SmtpProvider classes. The file structure (src/providers/) supports modularity, but there's no TypeScript interface enforcing the contract. Sketch the interface after v1 ships, then validate by prototyping a CalDAV provider.
**Depends on:** v1 complete. Understanding of CalDAV protocol (transfers from IMAP learning).

## v2: Semantic search via embedding index
**What:** Build a local embedding index of email content so users can search by meaning ("emails about money I owe") rather than exact keywords ("invoice").
**Why:** IMAP TEXT search is keyword-only. An LLM caller can pick good keywords, but semantic search would catch conceptual matches across synonyms and phrasing. Especially useful for natural language queries from Claude.
**Context:** Requires: (1) fetching + indexing message bodies as embeddings (via an API like Voyage/OpenAI or a local model), (2) storing in a vector DB (SQLite with sqlite-vec, or flat file with cosine similarity), (3) incremental sync (track last-seen UID per folder). Cold start cost is the main concern — indexing thousands of emails on first use takes time + API calls. Lighter alternative already shipped: IMAP TEXT search, which lets Claude pick keywords server-side. Semantic search is the next tier if TEXT search proves insufficient.
**Depends on:** TEXT search shipped (validates the search UX pattern). Decision on embedding provider (API vs local model).
