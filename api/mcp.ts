import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ImapProvider } from "../src/providers/imap.js";
import { SmtpProvider } from "../src/providers/smtp.js";
import { CalDavProvider } from "../src/providers/caldav.js";
import { RemindersProvider } from "../src/providers/reminders.js";
import { ContactsProvider } from "../src/providers/contacts.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerWriteTools } from "../src/tools/write.js";
import { registerManageTools } from "../src/tools/manage.js";
import { registerCalendarTools } from "../src/tools/calendar.js";
import { registerCrossTools } from "../src/tools/cross.js";
import { registerFindVerb } from "../src/verbs/find.js";

function createServer(): {
  server: McpServer;
  imapProvider: ImapProvider;
  caldavProvider: CalDavProvider;
  remindersProvider: RemindersProvider;
  contactsProvider: ContactsProvider;
} {
  const email = process.env.ICLOUD_EMAIL;
  const password = process.env.ICLOUD_APP_PASSWORD;
  const imapHost = process.env.IMAP_HOST ?? "imap.mail.me.com";
  const imapPort = Number(process.env.IMAP_PORT ?? "993");
  const smtpHost = process.env.SMTP_HOST ?? "smtp.mail.me.com";
  const smtpPort = Number(process.env.SMTP_PORT ?? "587");
  const caldavUrl = process.env.CALDAV_URL ?? "https://caldav.icloud.com";
  const carddavUrl = process.env.CARDDAV_URL ?? "https://contacts.icloud.com";

  if (!email || !password) {
    throw new Error("Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD");
  }

  const imapProvider = new ImapProvider(imapHost, imapPort, email, password);
  const smtpProvider = new SmtpProvider(smtpHost, smtpPort, email, password);
  const caldavProvider = new CalDavProvider(caldavUrl, email, password);
  const remindersProvider = new RemindersProvider(caldavUrl, email, password);
  const contactsProvider = new ContactsProvider(carddavUrl, email, password);

  const server = new McpServer({
    name: "icloud-mcp",
    version: "3.0.0-dev",
  });

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
    email
  );
  registerFindVerb(server, {
    imap: imapProvider,
    smtp: smtpProvider,
    caldav: caldavProvider,
    reminders: remindersProvider,
    contacts: contactsProvider,
    email,
  });

  return { server, imapProvider, caldavProvider, remindersProvider, contactsProvider };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Bearer token auth — this is on the public internet
  const expected = process.env.AUTH_TOKEN?.trim();
  if (expected) {
    const authHeader = req.headers.authorization ?? "";
    const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (provided !== expected) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }
  }

  if (req.method === "POST") {
    const {
      server,
      imapProvider,
      caldavProvider,
      remindersProvider,
      contactsProvider,
    } = createServer();

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await imapProvider.disconnect();
      await caldavProvider.disconnect();
      await remindersProvider.disconnect();
      await contactsProvider.disconnect();
    }
  } else if (req.method === "GET" || req.method === "DELETE") {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  } else {
    res.status(405).end();
  }
}
