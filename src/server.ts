/*
 * iCloud Bridge MCP Server (v2)
 *
 * Unified MCP server for iCloud Mail + Calendar.
 * Same app-specific password authenticates IMAP, SMTP, and CalDAV.
 *
 * Dependency graph:
 *
 * ┌─────────────┐
 * │  server.ts   │  MCP server setup, creates providers
 * │  (entry)     │  passes providers to tool registrations
 * └──────┬───────┘
 *        │ creates + passes
 *        ▼
 * ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 * │ ImapProvider  │  │ SmtpProvider  │  │ CalDavProvider│
 * │ (imap.ts)    │  │ (smtp.ts)    │  │ (caldav.ts)  │
 * └──────────────┘  └──────────────┘  └──────────────┘
 *        ▲                 ▲                 ▲
 *        │ uses            │ uses            │ uses
 *        └────────┬────────┴────────┬────────┘
 *          ┌──────┴───────┐  ┌──────┴───────┐
 *          │  tools/*.ts  │  │  tools/*.ts  │
 *          │  read.ts     │  │  calendar.ts │
 *          │  write.ts    │  │  cross.ts    │
 *          │  manage.ts   │  └──────────────┘
 *          └──────────────┘
 */

// Bun loads .env automatically (no dotenv needed)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapProvider } from "./providers/imap.ts";
import { SmtpProvider } from "./providers/smtp.ts";
import { CalDavProvider } from "./providers/caldav.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";
import { registerManageTools } from "./tools/manage.ts";
import { registerCalendarTools } from "./tools/calendar.ts";
import { registerCrossTools } from "./tools/cross.ts";

// Validate required environment variables
const email = process.env.ICLOUD_EMAIL;
const password = process.env.ICLOUD_APP_PASSWORD;
const imapHost = process.env.IMAP_HOST ?? "imap.mail.me.com";
const imapPort = Number(process.env.IMAP_PORT ?? "993");
const smtpHost = process.env.SMTP_HOST ?? "smtp.mail.me.com";
const smtpPort = Number(process.env.SMTP_PORT ?? "587");
const caldavUrl = process.env.CALDAV_URL ?? "https://caldav.icloud.com";

if (!email || !password) {
  console.error(
    "Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD. Copy .env.example to .env and fill in your credentials."
  );
  process.exit(1);
}

// Create providers
const imapProvider = new ImapProvider(imapHost, imapPort, email, password);
const smtpProvider = new SmtpProvider(smtpHost, smtpPort, email, password);
const caldavProvider = new CalDavProvider(caldavUrl, email, password);

// Create MCP server
const server = new McpServer({
  name: "icloud-bridge",
  version: "2.0.0",
});

// Register all tools
registerReadTools(server, imapProvider, email);
registerWriteTools(server, imapProvider, smtpProvider);
registerManageTools(server, imapProvider);
registerCalendarTools(server, caldavProvider);
registerCrossTools(server, imapProvider, smtpProvider, caldavProvider, email);

// Graceful shutdown
async function shutdown() {
  await imapProvider.disconnect();
  await smtpProvider.disconnect();
  await caldavProvider.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
