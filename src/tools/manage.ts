import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ImapProvider } from "../providers/imap.js";

export function registerManageTools(
  server: McpServer,
  imapProvider: ImapProvider
) {
  server.tool(
    "move_message",
    "Move a message from one folder to another",
    {
      uid: z.number().describe("Message UID"),
      fromFolder: z.string().describe("Source folder path"),
      toFolder: z.string().describe("Destination folder path"),
    },
    async ({ uid, fromFolder, toFolder }) => {
      try {
        await imapProvider.moveMessage(uid, fromFolder, toFolder);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to move message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_message",
    "Delete a message (moves to Trash, does not permanently delete)",
    {
      uid: z.number().describe("Message UID"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder containing the message"),
    },
    async ({ uid, folder }) => {
      try {
        await imapProvider.deleteMessage(uid, folder);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to delete message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "mark_message",
    "Mark a message as read, unread, flagged, or unflagged",
    {
      uid: z.number().describe("Message UID"),
      folder: z
        .string()
        .optional()
        .default("INBOX")
        .describe("Folder containing the message"),
      flag: z
        .enum(["read", "unread", "flagged", "unflagged"])
        .describe("Flag to set"),
    },
    async ({ uid, folder, flag }) => {
      try {
        await imapProvider.markMessage(uid, folder, flag);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to mark message: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "create_folder",
    "Create a new mail folder",
    {
      name: z
        .string()
        .describe(
          'Folder name (use "/" for nested folders, e.g. "Projects/Work")'
        ),
    },
    async ({ name }) => {
      try {
        await imapProvider.createFolder(name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "delete_folder",
    "Delete a mail folder. Cannot delete protected system folders (INBOX, Sent, Trash, Drafts, Junk, Archive).",
    {
      name: z.string().describe("Folder name to delete"),
    },
    async ({ name }) => {
      try {
        await imapProvider.deleteFolder(name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to delete folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
