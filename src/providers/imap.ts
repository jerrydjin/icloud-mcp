import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type {
  FolderInfo,
  MessageSummary,
  MessageFull,
  EmailAddress,
} from "../types.ts";

// NOTE: UIDVALIDITY is not tracked in v1. UIDs are assumed stable for this
// single-user personal tool. If UIDVALIDITY changes (rare on iCloud), UIDs
// from prior tool calls may point to different messages. Revisit if this
// becomes a shared tool.

export class ImapProvider {
  private client: ImapFlow;
  private connected = false;
  private noopInterval: ReturnType<typeof setInterval> | null = null;

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
  }

  private async ensureConnected(): Promise<void> {
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
        });
      }

      messages.sort((a, b) => b.uid - a.uid);
      return { messages, total };
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
