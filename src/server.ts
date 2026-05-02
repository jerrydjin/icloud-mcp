/*
 * iCloud MCP Server (v3)
 *
 * Unified MCP server: iCloud Mail + Calendar + Reminders + Contacts.
 * Same app-specific password authenticates IMAP, SMTP, CalDAV, CardDAV.
 *
 * v3 chief-of-staff identity: per-service tools stay for v2 surface (Mail,
 * Calendar). New providers (Reminders, Contacts) are accessible only through
 * cross-service verbs like daily_brief / triage_my_day (per ENG-5).
 */

// Bun loads .env automatically (no dotenv needed)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ImapProvider } from "./providers/imap.js";
import { SmtpProvider } from "./providers/smtp.js";
import { CalDavProvider } from "./providers/caldav.js";
import { RemindersProvider } from "./providers/reminders.js";
import { ContactsProvider } from "./providers/contacts.js";
import { IdentityResolver } from "./providers/identity-cache.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerManageTools } from "./tools/manage.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCrossTools } from "./tools/cross.js";
import { registerFindVerb } from "./verbs/find.js";
import { registerDeferVerb } from "./verbs/defer.js";
import { registerDraftVerb } from "./verbs/draft.js";
import { registerScheduleVerb } from "./verbs/schedule.js";
import { registerTriageVerb } from "./verbs/triage.js";
import {
  registerTriageCommitVerb,
  registerTriageCommitRetryVerb,
} from "./verbs/triage-commit.js";

// Validate required environment variables
const email = process.env.ICLOUD_EMAIL;
const password = process.env.ICLOUD_APP_PASSWORD;
const imapHost = process.env.IMAP_HOST ?? "imap.mail.me.com";
const imapPort = Number(process.env.IMAP_PORT ?? "993");
const smtpHost = process.env.SMTP_HOST ?? "smtp.mail.me.com";
const smtpPort = Number(process.env.SMTP_PORT ?? "587");
const caldavUrl = process.env.CALDAV_URL ?? "https://caldav.icloud.com";
const carddavUrl = process.env.CARDDAV_URL ?? "https://contacts.icloud.com";

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
const remindersProvider = new RemindersProvider(caldavUrl, email, password);
const contactsProvider = new ContactsProvider(carddavUrl, email, password);

// Create MCP server
const server = new McpServer({
  name: "icloud-mcp",
  version: "4.2.0",
});

// v4 M4.1: identity resolver, request-scoped on Vercel and process-scoped on stdio
const identityResolver = new IdentityResolver(contactsProvider);

// Register all tools
registerReadTools(server, imapProvider, email);
registerWriteTools(server, imapProvider, smtpProvider);
registerManageTools(server, imapProvider);
registerCalendarTools(server, caldavProvider);
registerCrossTools(
  server,
  imapProvider,
  smtpProvider,
  caldavProvider,
  remindersProvider,
  contactsProvider,
  identityResolver,
  email
);

// v3 verbs (chief-of-staff layer per ENG-7)
const verbCtx = {
  imap: imapProvider,
  smtp: smtpProvider,
  caldav: caldavProvider,
  reminders: remindersProvider,
  contacts: contactsProvider,
  identityResolver,
  email,
};
registerFindVerb(server, verbCtx);
registerDeferVerb(server, verbCtx);
registerDraftVerb(server, verbCtx);
registerScheduleVerb(server, verbCtx);
registerTriageVerb(server, verbCtx);
registerTriageCommitVerb(server, verbCtx);
registerTriageCommitRetryVerb(server, verbCtx);

// Graceful shutdown
async function shutdown() {
  await imapProvider.disconnect();
  await smtpProvider.disconnect();
  await caldavProvider.disconnect();
  await remindersProvider.disconnect();
  await contactsProvider.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
