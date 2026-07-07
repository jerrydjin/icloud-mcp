import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImapProvider } from "../providers/imap.js";

export function registerReadTools(
  server: McpServer,
  imapProvider: ImapProvider,
  email: string
) {
  server.tool(
    "get_connection_info",
    "Get iCloud Mail connection status and authenticated email address",
    {},
    async () => {
      try {
        await imapProvider.connect();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  email,
                  imapConnected: true,
                  smtpConfigured: true,
                  serverHost: "imap.mail.me.com",
                },
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
              text: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_folders",
    "List all mail folders in the iCloud account with message counts",
    {},
    async () => {
      try {
        const folders = await imapProvider.listFolders();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ folders }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to list folders: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "list_messages",
    "List messages in a folder with pagination (newest first)",
    {
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder path (default: INBOX)"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Number of messages to return (max 100)"),
      offset: z
        .number()
        .min(0)
        .optional()
        .default(0)
        .describe("Number of messages to skip"),
    },
    async ({ folder, limit, offset }) => {
      try {
        const result = await imapProvider.listMessages(folder, limit, offset);
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
              text: `Failed to list messages: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "read_message",
    "Read the full content of an email message by UID",
    {
      uid: z.number().describe("Message UID"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder path (default: INBOX)"),
      maxBodyLength: z
        .number()
        .optional()
        .default(10000)
        .describe("Maximum body text length before truncation (default: 10000)"),
    },
    async ({ uid, folder, maxBodyLength }) => {
      try {
        const message = await imapProvider.fetchAndParseMessage(
          uid,
          folder,
          maxBodyLength
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(message, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to read message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "search_messages",
    "Search for messages matching criteria. At least one search criterion is required. Use list_messages to browse without filters.",
    {
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder to search in"),
      text: z.string().optional().describe("Full-text search across entire message content (headers and body)"),
      from: z.string().optional().describe("Filter by sender address or name"),
      to: z.string().optional().describe("Filter by recipient address"),
      subject: z.string().optional().describe("Filter by subject text"),
      since: z
        .string()
        .optional()
        .describe("Messages after this date (ISO 8601)"),
      before: z
        .string()
        .optional()
        .describe("Messages before this date (ISO 8601)"),
      unseen: z.boolean().optional().describe("Only unread messages"),
      flagged: z.boolean().optional().describe("Only flagged/starred messages"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe("Maximum results (max 100)"),
    },
    async ({ folder, text, from, to, subject, since, before, unseen, flagged, limit }) => {
      const criteria: Record<string, unknown> = {};
      if (text) criteria.text = text;
      if (from) criteria.from = from;
      if (to) criteria.to = to;
      if (subject) criteria.subject = subject;
      if (since) criteria.since = since;
      if (before) criteria.before = before;
      if (unseen) criteria.unseen = true;
      if (flagged) criteria.flagged = true;

      if (Object.keys(criteria).length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "At least one search criterion is required. Use list_messages to browse a folder without filters.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await imapProvider.search(folder, criteria, limit);
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
              text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
