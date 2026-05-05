import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type {
  ServiceProvider,
  FolderInfo,
  MessageSummary,
  MessageFull,
  EmailAddress,
} from "../types.js";

// NOTE: UIDVALIDITY is not tracked in v1. UIDs are assumed stable for this
// single-user personal tool. If UIDVALIDITY changes (rare on iCloud), UIDs
// from prior tool calls may point to different messages. Revisit if this
// becomes a shared tool.

export class ImapProvider implements ServiceProvider {
  private client: ImapFlow;
  private connected = false;
  private noopInterval: ReturnType<typeof setInterval> | null = null;
  // Resolved Sent folder path. Cached for the lifetime of this provider
  // instance, which on Vercel is one Lambda invocation. `undefined` means
  // not-yet-resolved; `null` means resolution ran and found nothing.
  private sentFolderPath: string | null | undefined = undefined;

  constructor(
    private host: string,
    private port: number,
    private email: string,
    private password: string
  ) {
    this.client = new ImapFlow({
      host: this.host,
      port: this.port,
      secure: true,
      auth: { user: this.email, pass: this.password },
      logger: false,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;

    // Send NOOP every 5 minutes to prevent iCloud idle timeout (~30 min).
    // imapflow uses TCP-level keepalive, but iCloud may expect IMAP-level activity.
    this.noopInterval = setInterval(async () => {
      try {
        await this.client.noop();
      } catch {
        // Connection may have dropped; reconnect will happen on next operation
      }
    }, 5 * 60 * 1000);
  }

  async disconnect(): Promise<void> {
    if (this.noopInterval) {
      clearInterval(this.noopInterval);
      this.noopInterval = null;
    }
    if (this.connected) {
      await this.client.logout();
      this.connected = false;
    }
    // Reset the per-instance Sent folder cache; a fresh connect should
    // re-resolve in case mailbox layout changed.
    this.sentFolderPath = undefined;
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    await this.ensureConnected();
    const mailboxes = await this.client.list();
    const folders: FolderInfo[] = [];

    for (const mailbox of mailboxes) {
      try {
        const status = await this.client.status(mailbox.path, {
          messages: true,
          unseen: true,
        });
        folders.push({
          name: mailbox.name,
          path: mailbox.path,
          messageCount: status.messages ?? 0,
          unseenCount: status.unseen ?? 0,
        });
      } catch {
        // Some virtual folders may not support STATUS
        folders.push({
          name: mailbox.name,
          path: mailbox.path,
          messageCount: 0,
          unseenCount: 0,
        });
      }
    }

    return folders;
  }

  async listMessages(
    folder: string,
    limit: number,
    offset: number
  ): Promise<{ messages: MessageSummary[]; total: number }> {
    await this.ensureConnected();

    // UID-based pagination: fetch all UIDs, sort descending, slice by offset/limit.
    // Stable across concurrent clients (unlike sequence numbers).
    const lock = await this.client.getMailboxLock(folder);
    try {
      // Get all UIDs in folder, sorted newest first
      const allUids: number[] = [];
      try {
        for await (const msg of this.client.fetch("1:*", { uid: true })) {
          allUids.push(msg.uid);
        }
      } catch {
        // Empty folder returns no messages
        return { messages: [], total: 0 };
      }

      const total = allUids.length;
      if (total === 0) return { messages: [], total: 0 };

      // Sort descending (newest first) and paginate
      allUids.sort((a, b) => b - a);
      const pageUids = allUids.slice(offset, offset + limit);

      if (pageUids.length === 0) return { messages: [], total };

      // Fetch details for the page
      const uidSet = pageUids.join(",");
      const messages: MessageSummary[] = [];

      for await (const msg of this.client.fetch(
        uidSet,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        const from = msg.envelope?.from?.[0];
        messages.push({
          uid: msg.uid,
          subject: msg.envelope?.subject ?? "(no subject)",
          from: {
            name: from?.name ?? "",
            address: from?.address ?? "",
          },
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          flags: Array.from(msg.flags ?? []),
          hasAttachments: this.hasAttachments(msg.bodyStructure),
          messageId: msg.envelope?.messageId ?? null,
        });
      }

      // Maintain descending UID order
      messages.sort((a, b) => b.uid - a.uid);
      return { messages, total };
    } finally {
      lock.release();
    }
  }

  async fetchAndParseMessage(
    uid: number,
    folder: string,
    maxBodyLength: number = 10000
  ): Promise<MessageFull> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(folder);
    try {
      const rawSource = await this.client.download(uid.toString(), undefined, {
        uid: true,
      });
      if (!rawSource || !rawSource.content) {
        throw new Error(`Message UID ${uid} not found in folder ${folder}`);
      }

      const parsed: ParsedMail = await simpleParser(rawSource.content);

      let textBody = parsed.text ?? "";
      let truncated = false;
      if (textBody.length > maxBodyLength) {
        textBody = textBody.slice(0, maxBodyLength);
        truncated = true;
      }

      const toAddresses: EmailAddress[] = this.parseAddressList(parsed.to);
      const ccAddresses: EmailAddress[] = this.parseAddressList(parsed.cc);
      const bccAddresses: EmailAddress[] = this.parseAddressList(parsed.bcc);

      const attachments = (parsed.attachments ?? []).map((att) => ({
        filename: att.filename ?? "unnamed",
        size: att.size,
        contentType: att.contentType,
      }));

      return {
        uid,
        subject: parsed.subject ?? "(no subject)",
        from: {
          name: parsed.from?.value?.[0]?.name ?? "",
          address: parsed.from?.value?.[0]?.address ?? "",
        },
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        date: parsed.date?.toISOString() ?? new Date().toISOString(),
        textBody,
        htmlBody: parsed.html || undefined,
        truncated,
        attachments,
        messageId: parsed.messageId ?? "",
        inReplyTo: parsed.inReplyTo ?? undefined,
        references: parsed.references
          ? (Array.isArray(parsed.references)
              ? parsed.references
              : [parsed.references])
          : undefined,
      };
    } finally {
      lock.release();
    }
  }

  async search(
    folder: string,
    criteria: Record<string, unknown>,
    limit: number
  ): Promise<{ messages: MessageSummary[]; total: number }> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(folder);
    try {
      const searchCriteria: Record<string, unknown> = {};

      if (criteria.text) searchCriteria.text = criteria.text;
      if (criteria.from) searchCriteria.from = criteria.from;
      if (criteria.to) searchCriteria.to = criteria.to;
      if (criteria.subject) searchCriteria.subject = criteria.subject;
      if (criteria.since) searchCriteria.since = new Date(criteria.since as string);
      if (criteria.before) searchCriteria.before = new Date(criteria.before as string);
      if (criteria.unseen) searchCriteria.seen = false;
      if (criteria.flagged) searchCriteria.flagged = true;

      const searchResult = await this.client.search(searchCriteria, { uid: true });
      const uids: number[] = searchResult ? searchResult : [];
      const total = uids.length;

      if (total === 0) return { messages: [], total: 0 };

      // Sort descending (newest first) and limit
      uids.sort((a: number, b: number) => b - a);
      const limitedUids = uids.slice(0, limit);
      const uidSet = limitedUids.join(",");

      const messages: MessageSummary[] = [];
      for await (const msg of this.client.fetch(
        uidSet,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        { uid: true }
      )) {
        const from = msg.envelope?.from?.[0];
        messages.push({
          uid: msg.uid,
          subject: msg.envelope?.subject ?? "(no subject)",
          from: {
            name: from?.name ?? "",
            address: from?.address ?? "",
          },
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
          flags: Array.from(msg.flags ?? []),
          hasAttachments: this.hasAttachments(msg.bodyStructure),
          messageId: msg.envelope?.messageId ?? null,
        });
      }

      messages.sort((a, b) => b.uid - a.uid);
      return { messages, total };
    } finally {
      lock.release();
    }
  }

  /**
   * Look up a message by RFC 5322 Message-Id header. Returns the IMAP UID of
   * the matching message in the given folder, or null if no match.
   *
   * Used by triage_commit (M4.2) to make the draft APPEND idempotent: derive a
   * deterministic Message-Id from the idempotencyKey, SEARCH HEADER first, and
   * if a match exists, reuse that UID instead of APPENDing a duplicate.
   *
   * Folder doesn't exist → throws (caller should not retry blindly).
   */
  async searchByMessageId(
    folder: string,
    messageId: string
  ): Promise<number | null> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(folder);
    try {
      // imapflow's search supports `header` criterion: { header: { "message-id": "<...>" } }
      const result = await this.client.search(
        { header: { "message-id": messageId } as Record<string, string> },
        { uid: true }
      );
      const uids: number[] = result ? result : [];
      if (uids.length === 0) return null;
      // Multiple matches shouldn't happen for a deterministic Message-Id, but
      // pick the highest UID (most recent) to be safe.
      return Math.max(...uids);
    } finally {
      lock.release();
    }
  }

  /**
   * Resolve the user's Sent folder path. Returns null if no candidate matches.
   *
   * Lookup order:
   *   1. RFC 6154 SPECIAL-USE flag `\Sent` (most reliable when set).
   *   2. Path-name match from a well-known list — Apple uses 'Sent Messages';
   *      other servers use 'Sent' or 'INBOX.Sent'. Case-insensitive.
   *
   * Cached on the provider instance for the request lifetime (per-Lambda on
   * Vercel; per-process on stdio). The cache is dropped on disconnect.
   */
  async resolveSentFolder(): Promise<string | null> {
    if (this.sentFolderPath !== undefined) return this.sentFolderPath;
    await this.ensureConnected();

    const mailboxes = await this.client.list();

    const bySpecialUse = mailboxes.find(
      (m) => (m as { specialUse?: string }).specialUse === "\\Sent"
    );
    if (bySpecialUse) {
      this.sentFolderPath = bySpecialUse.path;
      return this.sentFolderPath;
    }

    const wellKnown = ["Sent Messages", "Sent", "INBOX.Sent"];
    for (const candidate of wellKnown) {
      const match = mailboxes.find(
        (m) => m.path.toLowerCase() === candidate.toLowerCase()
      );
      if (match) {
        this.sentFolderPath = match.path;
        return this.sentFolderPath;
      }
    }

    this.sentFolderPath = null;
    return null;
  }

  /**
   * Bulk-search the Sent folder for messages whose `In-Reply-To` or
   * `References` header references any of the given inbound message-ids. Used
   * by daily_brief (M4.3) to compute response-staleness in ONE round trip.
   *
   * Returns the parsed metadata for each matching sent message — caller does
   * the threading join (matching against original messageIds).
   *
   * Empty `messageIds` returns []. Bounded by `sinceDays` SINCE constraint to
   * avoid scanning multi-year Sent histories; replies older than that are not
   * returned (caller treats them as never-replied — honest degradation).
   */
  async searchSentReplies(
    folder: string,
    messageIds: string[],
    sinceDays: number
  ): Promise<import("../types.js").SentReplyEntry[]> {
    if (messageIds.length === 0) return [];
    await this.ensureConnected();

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    // Build OR'd criterion: for each id, two clauses (in-reply-to + references).
    // imapflow accepts an N-ary `or` array (>=2). With 10 ids × 2 headers = 20
    // clauses; if iCloud rejects we'll narrow this in a follow-up (OQ#4).
    const orClauses: Array<{ header: Record<string, string> }> = [];
    for (const id of messageIds) {
      orClauses.push({ header: { "in-reply-to": id } });
      orClauses.push({ header: { "references": id } });
    }

    const lock = await this.client.getMailboxLock(folder);
    try {
      const searchResult = await this.client.search(
        { or: orClauses, since },
        { uid: true }
      );
      const uids: number[] = searchResult ? searchResult : [];
      if (uids.length === 0) return [];

      // Fetch envelope + the two threading headers we need to join on.
      const uidSet = uids.join(",");
      const entries: import("../types.js").SentReplyEntry[] = [];
      for await (const msg of this.client.fetch(
        uidSet,
        {
          uid: true,
          envelope: true,
          headers: ["in-reply-to", "references"],
        },
        { uid: true }
      )) {
        const { inReplyTo, references } = parseThreadingHeaders(
          msg.headers as Buffer | string | undefined
        );
        entries.push({
          messageId: msg.envelope?.messageId ?? null,
          inReplyTo,
          references,
          date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
        });
      }
      return entries;
    } finally {
      lock.release();
    }
  }

  async moveMessage(
    uid: number,
    fromFolder: string,
    toFolder: string
  ): Promise<void> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(fromFolder);
    try {
      await this.client.messageMove(uid.toString(), toFolder, { uid: true });
    } finally {
      lock.release();
    }
  }

  async deleteMessage(uid: number, folder: string): Promise<void> {
    // Move to Trash, does not permanently delete
    await this.moveMessage(uid, folder, "Trash");
  }

  async markMessage(
    uid: number,
    folder: string,
    flag: "read" | "unread" | "flagged" | "unflagged"
  ): Promise<void> {
    await this.ensureConnected();
    const lock = await this.client.getMailboxLock(folder);
    try {
      const uidStr = uid.toString();
      switch (flag) {
        case "read":
          await this.client.messageFlagsAdd(uidStr, ["\\Seen"], { uid: true });
          break;
        case "unread":
          await this.client.messageFlagsRemove(uidStr, ["\\Seen"], {
            uid: true,
          });
          break;
        case "flagged":
          await this.client.messageFlagsAdd(uidStr, ["\\Flagged"], {
            uid: true,
          });
          break;
        case "unflagged":
          await this.client.messageFlagsRemove(uidStr, ["\\Flagged"], {
            uid: true,
          });
          break;
      }
    } finally {
      lock.release();
    }
  }

  async createFolder(name: string): Promise<void> {
    await this.ensureConnected();
    await this.client.mailboxCreate(name);
  }

  async append(
    folder: string,
    rawMessage: Buffer,
    flags?: string[]
  ): Promise<{ uid?: number }> {
    await this.ensureConnected();
    const result = await this.client.append(folder, rawMessage, flags ?? []);
    return { uid: (result as { uid?: number })?.uid };
  }

  async deleteFolder(name: string): Promise<void> {
    const protectedFolders = [
      "INBOX",
      "Sent",
      "Trash",
      "Drafts",
      "Junk",
      "Archive",
      "Sent Messages",
    ];
    if (protectedFolders.some((f) => f.toLowerCase() === name.toLowerCase())) {
      throw new Error(
        `Cannot delete protected system folder: ${name}. Protected folders: ${protectedFolders.join(", ")}`
      );
    }
    await this.ensureConnected();
    await this.client.mailboxDelete(name);
  }

  private hasAttachments(bodyStructure: unknown): boolean {
    if (!bodyStructure || typeof bodyStructure !== "object") return false;
    const bs = bodyStructure as Record<string, unknown>;
    if (bs.disposition === "attachment") return true;
    if (Array.isArray(bs.childNodes)) {
      return bs.childNodes.some((child: unknown) =>
        this.hasAttachments(child)
      );
    }
    return false;
  }

  private parseAddressList(
    addr: unknown
  ): EmailAddress[] {
    if (!addr) return [];
    if (typeof addr === "object" && "value" in (addr as Record<string, unknown>)) {
      const val = (addr as { value: Array<{ name?: string; address?: string }> }).value;
      return val.map((a) => ({
        name: a.name ?? "",
        address: a.address ?? "",
      }));
    }
    if (Array.isArray(addr)) {
      return addr.flatMap((a) => this.parseAddressList(a));
    }
    return [];
  }
}

/**
 * Parse the `In-Reply-To` and `References` headers out of a raw IMAP-fetched
 * header block. `imapflow` returns the requested headers as a single Buffer
 * (or string) of the literal RFC 5322 lines, e.g.:
 *
 *   In-Reply-To: <abc@example.com>\r\n
 *   References: <root@example.com>\r\n
 *    <reply@example.com>\r\n
 *
 * Continuation lines (folded headers) start with whitespace and concatenate
 * to the previous header value. References is whitespace-tokenized into a
 * list of message-ids (still angle-bracket wrapped).
 *
 * Exported so tests can pin the parser without booting an IMAP client.
 */
export function parseThreadingHeaders(raw: Buffer | string | undefined): {
  inReplyTo: string | null;
  references: string[];
} {
  if (!raw) return { inReplyTo: null, references: [] };
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  // Unfold: a header line that begins with WSP belongs to the previous line.
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  const lines = unfolded.split(/\r?\n/);

  let inReplyTo: string | null = null;
  let referencesRaw = "";

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    if (name === "in-reply-to" && !inReplyTo) {
      // Pick the first <...> token; some clients append a comment after.
      const m = value.match(/<[^>]+>/);
      inReplyTo = m ? m[0] : value || null;
    } else if (name === "references" && !referencesRaw) {
      referencesRaw = value;
    }
  }

  const references = referencesRaw
    ? Array.from(referencesRaw.matchAll(/<[^>]+>/g)).map((m) => m[0])
    : [];

  return { inReplyTo, references };
}
