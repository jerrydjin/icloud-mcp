/*
 * iCloud Mail MCP Server
 *
 * Dependency graph:
 *
 * ┌─────────────┐
 * │  server.ts   │  MCP server setup, creates providers
 * │  (entry)     │  passes providers to tool registrations
 * └──────┬───────┘
 *        │ creates + passes
 *        ▼
 * ┌──────────────┐     ┌──────────────┐
 * │ ImapProvider  │     │ SmtpProvider  │
 * │ (imap.ts)    │     │ (smtp.ts)    │
 * └──────────────┘     └──────────────┘
 *        ▲                    ▲
 *        │ uses               │ uses
 *        └────────┬───────────┘
 *          ┌──────┴───────┐
 *          │  tools/*.ts  │
 *          │  read.ts     │
 *          │  write.ts    │
 *          │  manage.ts   │
 *          └──────────────┘
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load .env from project root regardless of cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapProvider } from "./providers/imap.ts";
import { SmtpProvider } from "./providers/smtp.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerWriteTools } from "./tools/write.ts";
import { registerManageTools } from "./tools/manage.ts";

// Validate required environment variables
const email = process.env.ICLOUD_EMAIL;
const password = process.env.ICLOUD_APP_PASSWORD;
const imapHost = process.env.IMAP_HOST ?? "imap.mail.me.com";
const imapPort = Number(process.env.IMAP_PORT ?? "993");
const smtpHost = process.env.SMTP_HOST ?? "smtp.mail.me.com";
const smtpPort = Number(process.env.SMTP_PORT ?? "587");

if (!email || !password) {
  console.error(
    "Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD. Copy .env.example to .env and fill in your credentials."
  );
  process.exit(1);
}

// Create providers
const imapProvider = new ImapProvider(imapHost, imapPort, email, password);
const smtpProvider = new SmtpProvider(smtpHost, smtpPort, email, password);

// Create MCP server
const server = new McpServer({
  name: "icloud-mail",
  version: "1.0.0",
});

// Register all tools
registerReadTools(server, imapProvider, email);
registerWriteTools(server, imapProvider, smtpProvider);
registerManageTools(server, imapProvider);

// Graceful shutdown
async function shutdown() {
  await imapProvider.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
