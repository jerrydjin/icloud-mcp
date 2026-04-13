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
