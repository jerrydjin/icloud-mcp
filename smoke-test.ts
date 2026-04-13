/**
 * Phase 0: Smoke test bun + imapflow TLS compatibility
 *
 * Run: bun run smoke-test.ts
 *
 * Before running:
 * 1. Copy .env.example to .env
 * 2. Fill in your iCloud email and app-specific password
 *    (generate at https://account.apple.com > Sign-In and Security > App-Specific Passwords)
 */

import "dotenv/config";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

const email = process.env.ICLOUD_EMAIL;
const password = process.env.ICLOUD_APP_PASSWORD;

if (!email || !password) {
  console.error("Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD in .env");
  process.exit(1);
}

console.log("=== Phase 0: Smoke Test ===\n");

// Test 1: IMAP connection (TLS on port 993)
console.log("1. Testing IMAP connection (imap.mail.me.com:993, TLS)...");
try {
  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });

  await client.connect();
  console.log("   ✓ IMAP connected successfully");

  // Test listing folders
  const mailboxes = await client.list();
  console.log(`   ✓ Listed ${mailboxes.length} folders`);
  for (const mb of mailboxes.slice(0, 5)) {
    console.log(`     - ${mb.path}`);
  }
  if (mailboxes.length > 5) {
    console.log(`     ... and ${mailboxes.length - 5} more`);
  }

  // Test fetching a message (async iterator — known bun issue #18492)
  const lock = await client.getMailboxLock("INBOX");
  try {
    let count = 0;
    for await (const msg of client.fetch("1:3", { uid: true, envelope: true })) {
      count++;
      console.log(
        `   ✓ Fetched message UID ${msg.uid}: ${msg.envelope?.subject?.slice(0, 50)}`
      );
    }
    if (count === 0) {
      console.log("   ✓ INBOX is empty (fetch iterator works, no messages)");
    }
    console.log(
      `   ✓ Async iterator completed (${count} messages) — bun #18492 NOT triggered`
    );
  } finally {
    lock.release();
  }

  await client.logout();
  console.log("   ✓ IMAP disconnected cleanly\n");
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`   ✗ IMAP FAILED: ${err.message}`);
  if ("responseStatus" in err) console.error(`   Response: ${(err as any).responseStatus}`);
  if ("responseText" in err) console.error(`   Response text: ${(err as any).responseText}`);
  if (err.stack) console.error(`   Stack: ${err.stack.split("\n").slice(0, 3).join("\n")}`);
  console.error(
    "   → If this is a TLS or async iterator error, switch to node + tsx"
  );
  console.error(
    "   → If this is an auth error, check your email and app-specific password"
  );
  process.exit(1);
}

// Test 2: SMTP connection (STARTTLS on port 587)
console.log("2. Testing SMTP connection (smtp.mail.me.com:587, STARTTLS)...");
try {
  const transporter = nodemailer.createTransport({
    host: "smtp.mail.me.com",
    port: 587,
    secure: false, // STARTTLS
    auth: { user: email, pass: password },
  });

  await transporter.verify();
  console.log("   ✓ SMTP connected and authenticated successfully\n");
} catch (error) {
  console.error(
    `   ✗ SMTP FAILED: ${error instanceof Error ? error.message : String(error)}`
  );
  console.error(
    "   → If this is a STARTTLS error, bun's upgradeTLS may be broken. Switch to node + tsx"
  );
  process.exit(1);
}

console.log("=== All smoke tests passed! ===");
console.log("bun + imapflow + nodemailer are compatible.");
console.log("Proceed to Phase 1: build the read tools.");
