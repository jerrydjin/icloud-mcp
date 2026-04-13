import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImapProvider } from "../providers/imap.ts";
import type { SmtpProvider } from "../providers/smtp.ts";

export function registerWriteTools(
  server: McpServer,
  imapProvider: ImapProvider,
  smtpProvider: SmtpProvider
) {
  server.tool(
    "send_message",
    "Send a new email message via iCloud Mail",
    {
      to: z
        .union([z.string(), z.array(z.string())])
        .describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      from: z.string().optional().describe("Send from this address (must be an alias configured on your iCloud account, e.g. me@jerryjin.dev). Defaults to primary iCloud email."),
      fromName: z.string().optional().describe("Display name for the From header (e.g. 'Jerry Jin'). If omitted, sends with bare address."),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
    },
    async ({ to, subject, body, from, fromName, cc, bcc }) => {
      try {
        const result = await smtpProvider.send({
          to,
          subject,
          body,
          from,
          fromName,
          cc,
          bcc,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // SMTP sends are never retried. Connection drop may mean the email was sent.
        const isConnectionError =
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("socket");
        const errorText = isConnectionError
          ? `Send may have failed — check your Sent folder before resending. Error: ${msg}`
          : `Failed to send message: ${msg}`;
        return {
          content: [{ type: "text" as const, text: errorText }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "reply_to_message",
    "Reply to an existing email message. Automatically sets threading headers and quotes the original.",
    {
      uid: z.number().describe("UID of the message to reply to"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder containing the original message"),
      body: z.string().describe("Reply text (original will be quoted below)"),
      from: z.string().optional().describe("Send from this alias address. Defaults to primary iCloud email."),
      fromName: z.string().optional().describe("Display name for the From header (e.g. 'Jerry Jin'). If omitted, sends with bare address."),
      replyAll: z
        .boolean()
        .optional()
        .default(false)
        .describe("Reply to all recipients"),
    },
    async ({ uid, folder, body, from, fromName, replyAll }) => {
      try {
        const original = await imapProvider.fetchAndParseMessage(uid, folder);

        // Build subject with Re: prefix, deduplicating
        const subject = original.subject.replace(/^(Re:\s*)+/i, "");
        const replySubject = `Re: ${subject}`;

        // Quote original body
        const quotedLines = original.textBody
          .split("\n")
          .map((line) => `> ${line}`);
        const fullBody = `${body}\n\n${quotedLines.join("\n")}`;

        // Build recipients
        let to: string[];
        if (replyAll) {
          // Reply-all: original sender + all To/CC, excluding self
          const allRecipients = [
            original.from.address,
            ...original.to.map((a) => a.address),
            ...original.cc.map((a) => a.address),
          ].filter(Boolean);
          // Deduplicate
          to = [...new Set(allRecipients)];
        } else {
          to = [original.from.address];
        }

        // Build references chain
        const references = [...(original.references ?? [])];
        if (original.messageId) references.push(original.messageId);

        const result = await smtpProvider.send({
          to,
          subject: replySubject,
          body: fullBody,
          from,
          fromName,
          inReplyTo: original.messageId,
          references,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to reply: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_draft",
    "Save an email draft to the Drafts folder for review before sending. Use send_draft to send it later.",
    {
      to: z
        .union([z.string(), z.array(z.string())])
        .describe("Recipient email address(es)"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body text"),
      from: z.string().optional().describe("Send from this address (must be an alias configured on your iCloud account). Defaults to primary iCloud email."),
      fromName: z.string().optional().describe("Display name for the From header (e.g. 'Jerry Jin'). If omitted, sends with bare address."),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
    },
    async ({ to, subject, body, from, fromName, cc, bcc }) => {
      try {
        const rawMessage = await smtpProvider.buildRawMessage({
          to, subject, body, from, fromName, cc, bcc,
        });
        const result = await imapProvider.append("Drafts", rawMessage, [
          "\\Draft",
          "\\Seen",
        ]);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { uid: result.uid, folder: "Drafts", success: true },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create draft: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_reply_draft",
    "Save a reply draft to the Drafts folder. Quotes the original message and sets threading headers. Use send_draft to send it later.",
    {
      uid: z.number().describe("UID of the message to reply to"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder containing the original message"),
      body: z.string().describe("Reply text (original will be quoted below)"),
      from: z.string().optional().describe("Send from this alias address. Defaults to primary iCloud email."),
      fromName: z.string().optional().describe("Display name for the From header (e.g. 'Jerry Jin'). If omitted, sends with bare address."),
      replyAll: z
        .boolean()
        .optional()
        .default(false)
        .describe("Reply to all recipients"),
    },
    async ({ uid, folder, body, from, fromName, replyAll }) => {
      try {
        const original = await imapProvider.fetchAndParseMessage(uid, folder);

        const subject = original.subject.replace(/^(Re:\s*)+/i, "");
        const replySubject = `Re: ${subject}`;

        const quotedLines = original.textBody
          .split("\n")
          .map((line) => `> ${line}`);
        const fullBody = `${body}\n\n${quotedLines.join("\n")}`;

        let to: string[];
        if (replyAll) {
          const allRecipients = [
            original.from.address,
            ...original.to.map((a) => a.address),
            ...original.cc.map((a) => a.address),
          ].filter(Boolean);
          to = [...new Set(allRecipients)];
        } else {
          to = [original.from.address];
        }

        const references = [...(original.references ?? [])];
        if (original.messageId) references.push(original.messageId);

        const rawMessage = await smtpProvider.buildRawMessage({
          to,
          subject: replySubject,
          body: fullBody,
          from,
          fromName,
          inReplyTo: original.messageId,
          references,
        });
        const result = await imapProvider.append("Drafts", rawMessage, [
          "\\Draft",
          "\\Seen",
        ]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { uid: result.uid, folder: "Drafts", success: true },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create reply draft: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "send_draft",
    "Send an existing draft from the Drafts folder via SMTP, then remove it from Drafts.",
    {
      uid: z.number().describe("UID of the draft message in the Drafts folder"),
      from: z.string().optional().describe("Override the From address. Defaults to the address in the draft."),
      fromName: z.string().optional().describe("Override the display name. Defaults to the name in the draft."),
    },
    async ({ uid, from, fromName }) => {
      try {
        const draft = await imapProvider.fetchAndParseMessage(uid, "Drafts");

        const to = draft.to.map((a) => a.address).filter(Boolean);
        if (to.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "Draft has no recipients." },
            ],
            isError: true,
          };
        }

        const cc = draft.cc.map((a) => a.address).filter(Boolean);
        const bcc = draft.bcc.map((a) => a.address).filter(Boolean);

        const result = await smtpProvider.send({
          to,
          subject: draft.subject,
          body: draft.textBody,
          from: from ?? draft.from.address,
          fromName: fromName ?? (draft.from.name || undefined),
          cc: cc.length > 0 ? cc : undefined,
          bcc: bcc.length > 0 ? bcc : undefined,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
        });

        // Remove draft after successful send
        await imapProvider.deleteMessage(uid, "Drafts");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isConnectionError =
          msg.includes("ECONNRESET") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("socket");
        const errorText = isConnectionError
          ? `Send may have failed — check your Sent folder before resending. Draft kept in Drafts. Error: ${msg}`
          : `Failed to send draft: ${msg}`;
        return {
          content: [{ type: "text" as const, text: errorText }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "forward_message",
    "Forward an email message to new recipients. v1 forwards text content only (no attachments).",
    {
      uid: z.number().describe("UID of the message to forward"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder containing the original message"),
      to: z
        .union([z.string(), z.array(z.string())])
        .describe("Recipient(s) to forward to"),
      from: z.string().optional().describe("Send from this alias address. Defaults to primary iCloud email."),
      fromName: z.string().optional().describe("Display name for the From header (e.g. 'Jerry Jin'). If omitted, sends with bare address."),
      body: z
        .string()
        .optional()
        .default("")
        .describe("Optional message to include above the forwarded content"),
    },
    async ({ uid, folder, to, from, fromName, body }) => {
      try {
        const original = await imapProvider.fetchAndParseMessage(uid, folder);

        const fwdSubject = original.subject.replace(/^(Fwd:\s*)+/i, "");
        const forwardSubject = `Fwd: ${fwdSubject}`;

        const forwardHeader = [
          "---------- Forwarded message ----------",
          `From: ${original.from.name} <${original.from.address}>`,
          `Date: ${original.date}`,
          `Subject: ${original.subject}`,
          `To: ${original.to.map((a) => `${a.name} <${a.address}>`).join(", ")}`,
          "",
        ].join("\n");

        const fullBody = body
          ? `${body}\n\n${forwardHeader}\n${original.textBody}`
          : `${forwardHeader}\n${original.textBody}`;

        const result = await smtpProvider.send({
          to,
          subject: forwardSubject,
          body: fullBody,
          from,
          fromName,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to forward: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
