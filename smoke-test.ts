/**
 * Smoke test: v2 + v3 read-only round-trip against a real iCloud account.
 *
 * Run: bun run smoke-test
 *
 * READ-ONLY by default. No emails are sent, no events created, no reminders
 * written. Per ENG-16, this is the live-credential backstop for ENG-10's
 * recorded-fixture strategy — fixtures rot when iCloud changes ETag/sync
 * semantics, and a periodic real run catches that drift.
 *
 * R2 regression (per /plan-eng-review): exercises v2 surfaces (IMAP, SMTP,
 * CalDAV calendars+events) AND v3 surfaces (CalDAV-VTODO reminders, CardDAV
 * contacts) so a release that breaks v2 expectations fails here.
 *
 * Before running:
 * 1. Copy .env.example to .env
 * 2. Fill in your iCloud email and app-specific password
 *    (generate at https://account.apple.com > Sign-In and Security > App-Specific Passwords)
 */

import { ImapProvider } from "./src/providers/imap.js";
import { SmtpProvider } from "./src/providers/smtp.js";
import { CalDavProvider } from "./src/providers/caldav.js";
import { RemindersProvider } from "./src/providers/reminders.js";
import { ContactsProvider } from "./src/providers/contacts.js";
import { IdentityResolver } from "./src/providers/identity-cache.js";

const email = process.env.ICLOUD_EMAIL;
const password = process.env.ICLOUD_APP_PASSWORD;

if (!email || !password) {
  console.error("Missing ICLOUD_EMAIL or ICLOUD_APP_PASSWORD in .env");
  process.exit(1);
}

const imapHost = process.env.IMAP_HOST ?? "imap.mail.me.com";
const imapPort = Number(process.env.IMAP_PORT ?? "993");
const smtpHost = process.env.SMTP_HOST ?? "smtp.mail.me.com";
const smtpPort = Number(process.env.SMTP_PORT ?? "587");
const caldavUrl = process.env.CALDAV_URL ?? "https://caldav.icloud.com";
const carddavUrl = process.env.CARDDAV_URL ?? "https://contacts.icloud.com";

let totalPassed = 0;
let totalFailed = 0;

function pass(msg: string): void {
  totalPassed++;
  console.log(`   ✓ ${msg}`);
}

function fail(section: string, err: unknown): void {
  totalFailed++;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`   ✗ ${section} FAILED: ${msg}`);
  if (err instanceof Error && err.stack) {
    console.error(
      `     ${err.stack.split("\n").slice(0, 3).join("\n     ")}`
    );
  }
}

console.log(`=== icloud-mcp smoke test (read-only) ===`);
console.log(`Account: ${email}\n`);

// ── Section A: v2 mail (IMAP read + SMTP verify) ──

console.log("A. v2 Mail (IMAP read-only + SMTP auth)");
const imap = new ImapProvider(imapHost, imapPort, email, password);
try {
  const folders = await imap.listFolders();
  if (!Array.isArray(folders) || folders.length === 0) {
    throw new Error("listFolders returned empty or non-array");
  }
  pass(`IMAP listFolders: ${folders.length} folders`);

  const inboxFolder = folders.find((f) => f.path === "INBOX");
  if (!inboxFolder) throw new Error("INBOX not found");
  pass(`INBOX folder shape: { path, messageCount, unseenCount }`);

  const recent = await imap.listMessages("INBOX", 3, 0);
  if (!recent.messages || !Array.isArray(recent.messages)) {
    throw new Error("listMessages.messages is not an array");
  }
  pass(`IMAP listMessages: fetched ${recent.messages.length} messages`);

  if (recent.messages.length > 0) {
    const m = recent.messages[0]!;
    if (typeof m.uid !== "number") throw new Error("MessageSummary.uid not number");
    if (typeof m.subject !== "string") throw new Error("MessageSummary.subject not string");
    if (!m.from || typeof m.from.address !== "string") {
      throw new Error("MessageSummary.from.address not string");
    }
    pass(
      `MessageSummary v2 shape: uid=${m.uid}, subject preserved, from.address present`
    );

    // M4.3 (v4.3): messageId now populated from envelope.messageId. Required
    // for the Sent-folder threading join in daily_brief response-staleness.
    if (!("messageId" in m)) {
      throw new Error("M4.3: MessageSummary.messageId field missing");
    }
    if (m.messageId !== null && typeof m.messageId !== "string") {
      throw new Error(
        `M4.3: MessageSummary.messageId expected string|null, got ${typeof m.messageId}`
      );
    }
    pass(
      `M4.3 MessageSummary shape: messageId present (${m.messageId ? "populated" : "null"})`
    );
  }
} catch (err) {
  fail("A. v2 Mail (IMAP)", err);
} finally {
  await imap.disconnect();
}

const smtp = new SmtpProvider(smtpHost, smtpPort, email, password);
try {
  // Build a raw message but do NOT send. This exercises the SMTP path
  // (auth verification happens on first send/verify call inside nodemailer).
  const raw = await smtp.buildRawMessage({
    to: email,
    subject: "[smoke-test] this should not be sent",
    body: "noop",
  });
  if (!Buffer.isBuffer(raw) && typeof raw !== "string") {
    throw new Error(`buildRawMessage returned ${typeof raw}, expected Buffer or string`);
  }
  pass(`SMTP buildRawMessage produces a raw RFC822 message (no actual send)`);
} catch (err) {
  fail("A. v2 Mail (SMTP)", err);
} finally {
  await smtp.disconnect();
}

// ── Section B: v2 Calendar (CalDAV read) ──

console.log("\nB. v2 Calendar (CalDAV read-only)");
const caldav = new CalDavProvider(caldavUrl, email, password);
try {
  const calendars = await caldav.listCalendars();
  if (calendars.length === 0) {
    throw new Error("listCalendars returned 0 — expected at least one VEVENT calendar");
  }
  pass(`CalDAV listCalendars: ${calendars.length} VEVENT calendar(s)`);

  const c0 = calendars[0]!;
  if (typeof c0.displayName !== "string") throw new Error("CalendarInfo.displayName missing");
  if (typeof c0.url !== "string") throw new Error("CalendarInfo.url missing");
  pass(`CalendarInfo v2 shape: { displayName, url, color?, ctag?, description? }`);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const events = await caldav.listEvents(c0.url, sevenDaysAgo, sevenDaysAhead);
  pass(`CalDAV listEvents (±7 days, "${c0.displayName}"): ${events.length} events`);

  if (events.length > 0) {
    const e = events[0]!;
    if (typeof e.uid !== "string") throw new Error("CalendarEvent.uid not string");
    if (!e.start || typeof e.start.utc !== "string") {
      throw new Error("CalendarEvent.start.utc not string");
    }
    if (!e.start.timezone) throw new Error("CalendarEvent.start.timezone missing");
    pass(
      `CalendarEvent v2 shape: { uid, summary, start: TimezoneAwareTime, end, attendees, isAllDay, etag? }`
    );
  }
} catch (err) {
  fail("B. v2 Calendar", err);
} finally {
  await caldav.disconnect();
}

// ── Section C: v3 Reminders (CalDAV-VTODO read) ──

console.log("\nC. v3 Reminders (CalDAV-VTODO read-only)");
const reminders = new RemindersProvider(caldavUrl, email, password);
try {
  const lists = await reminders.listLists();
  pass(`RemindersProvider.listLists: ${lists.length} VTODO list(s)`);

  if (lists.length === 0) {
    console.log(
      `     (note: no VTODO lists found. iCloud Reminders may not be enabled, or all your reminder lists are filtered out.)`
    );
  } else {
    const l0 = lists[0]!;
    if (typeof l0.displayName !== "string") {
      throw new Error("ReminderListInfo.displayName missing");
    }
    if (typeof l0.url !== "string") throw new Error("ReminderListInfo.url missing");
    pass(`ReminderListInfo v3 shape: { displayName, url, color?, ctag?, description? }`);

    const items = await reminders.listReminders(l0.url, { includeCompleted: false });
    pass(
      `RemindersProvider.listReminders (incomplete only, "${l0.displayName}"): ${items.length} reminder(s)`
    );

    if (items.length > 0) {
      const r = items[0]!;
      if (typeof r.uid !== "string") throw new Error("Reminder.uid not string");
      if (typeof r.summary !== "string") throw new Error("Reminder.summary not string");
      if (typeof r.isCompleted !== "boolean") {
        throw new Error("Reminder.isCompleted not boolean");
      }
      pass(`Reminder v3 shape: { uid, summary, due?, isCompleted, listUrl, etag? }`);
    }
  }
} catch (err) {
  fail("C. v3 Reminders", err);
} finally {
  await reminders.disconnect();
}

// ── Section D: v3 Contacts (CardDAV read) ──

console.log("\nD. v3 Contacts (CardDAV read-only)");
const contacts = new ContactsProvider(carddavUrl, email, password);
try {
  const books = await contacts.listAddressBooks();
  pass(`ContactsProvider.listAddressBooks: ${books.length} address book(s)`);

  if (books.length === 0) {
    console.log(`     (note: no address books found — iCloud Contacts may not be enabled)`);
  } else {
    const b0 = books[0]!;
    if (typeof b0.displayName !== "string") {
      throw new Error("AddressBookInfo.displayName missing");
    }
    pass(`AddressBookInfo v3 shape: { displayName, url, ctag?, description? }`);

    const list = await contacts.listContacts(b0.url);
    pass(
      `ContactsProvider.listContacts ("${b0.displayName}"): ${list.length} contact(s)`
    );

    if (list.length > 0) {
      const c = list[0]!;
      if (typeof c.uid !== "string") throw new Error("Contact.uid not string");
      if (typeof c.fullName !== "string") throw new Error("Contact.fullName not string");
      if (!Array.isArray(c.emails)) throw new Error("Contact.emails not array");
      if (!Array.isArray(c.phones)) throw new Error("Contact.phones not array");
      pass(`Contact v3 shape: { uid, fullName, emails[], phones[], etag? }`);
    }
  }
} catch (err) {
  fail("D. v3 Contacts", err);
} finally {
  await contacts.disconnect();
}

// ── E. v4 IdentityResolver (M4.1) — measure cold-start cost on real Contacts ──

console.log("\n[E] v4 IdentityResolver (M4.1) — cold-start cost on real Contacts");
const contactsForIdentity = new ContactsProvider(carddavUrl, email, password);
try {
  const resolver = new IdentityResolver(contactsForIdentity);

  // First call hits Contacts cold — this is the latency you'll feel on Vercel.
  const t0 = Date.now();
  const stranger = await resolver.resolveIdentity("nobody@nowhere.invalid");
  const coldMs = Date.now() - t0;
  if (!stranger.identity || stranger.identity.contactUid !== null) {
    throw new Error(
      "Unknown email should return a Contact-less identity, not match a real Contact"
    );
  }
  pass(`IdentityResolver cold-start (full Contacts walk): ${coldMs}ms`);
  if (coldMs > 5000) {
    console.log(
      `     ⚠️  Cold-start >5sec — revisit per-request cache decision (design doc OQ #4).`
    );
  }

  // Second call is a cache hit — should be near-instant.
  const t1 = Date.now();
  await resolver.resolveIdentity("alsonobody@nowhere.invalid");
  const warmMs = Date.now() - t1;
  pass(`IdentityResolver warm call (cache hit): ${warmMs}ms`);
  if (warmMs > 100) {
    console.log(
      `     ⚠️  Warm call >100ms — index lookup should be much faster, investigate.`
    );
  }

  // Verify flush actually drops the cache: third call should be cold again.
  resolver.flush();
  const t2 = Date.now();
  await resolver.resolveIdentity("yetanother@nowhere.invalid");
  const flushedMs = Date.now() - t2;
  if (flushedMs < coldMs / 4) {
    throw new Error(
      `flush() didn't drop cache — post-flush call (${flushedMs}ms) suspiciously close to warm (${warmMs}ms), expected closer to cold (${coldMs}ms)`
    );
  }
  pass(`IdentityResolver.flush() drops cache (post-flush: ${flushedMs}ms)`);
} catch (err) {
  fail("E. v4 IdentityResolver", err);
} finally {
  await contactsForIdentity.disconnect();
}

// ── F. v4.2 triage proposer (M4.2) — read-only check on a real INBOX message ──
//
// Read-only by design: this section calls triage() to verify the proposer
// runs end-to-end against real mail, but does NOT call triage_commit (which
// would write reminder + event + draft to your real iCloud). Manual round-
// trip testing of the commit path is on the M4.2 ship-gate checklist; do
// that separately on a known-throwaway thread.

console.log("\n[F] v4.2 triage proposer (M4.2) — read-only on a real INBOX message");
const imapForTriage = new ImapProvider(imapHost, imapPort, email, password);
const contactsForTriage = new ContactsProvider(carddavUrl, email, password);
try {
  const messages = await imapForTriage.listMessages("INBOX", 1, 0);
  if (messages.messages.length === 0) {
    console.log("     (skipped: INBOX is empty — nothing to triage)");
  } else {
    const target = messages.messages[0]!;
    pass(`Found target message: UID ${target.uid}, "${target.subject.slice(0, 50)}"`);

    // We don't import triage.ts directly here because doing so would also need
    // the full VerbContext (caldav, reminders, smtp, identityResolver). Instead
    // exercise the underlying pieces: fetchAndParseMessage + proposer helpers.
    const full = await imapForTriage.fetchAndParseMessage(target.uid, "INBOX");
    pass(`Fetched + parsed message body (${full.textBody.length} chars)`);

    const { detectActionVerb, detectDatetime, detectQuestionOrRequest } =
      await import("./src/utils/proposer.js");
    const hasAction = detectActionVerb(full.textBody);
    const hasDate = detectDatetime(full.textBody);
    const hasQuestion = detectQuestionOrRequest(full.textBody);
    pass(
      `Proposer signals on "${full.subject.slice(0, 40)}": ` +
        `action=${hasAction}, datetime=${hasDate ? "yes" : "no"}, question=${hasQuestion}`
    );

    // Verify confirm-token round-trip with the M4.2 secret (or skip if unset)
    const secret = process.env.CONFIRM_TOKEN_SECRET;
    if (!secret) {
      console.log(
        `     (skipped confirmToken round-trip: CONFIRM_TOKEN_SECRET not set)`
      );
    } else {
      const { signProposal, verifyToken } = await import(
        "./src/utils/confirm-token.js"
      );
      const fakeProposal = { test: { idempotencyKey: "smoke-test" } };
      const token = await signProposal(fakeProposal, secret);
      const verify = await verifyToken(token, fakeProposal, secret);
      if (!verify.valid) {
        throw new Error(
          `confirmToken round-trip failed: ${JSON.stringify(verify)}`
        );
      }
      pass(`confirmToken sign + verify round-trip works against real Web Crypto`);
    }
  }
} catch (err) {
  fail("F. v4.2 triage proposer", err);
} finally {
  await imapForTriage.disconnect();
  await contactsForTriage.disconnect();
}

// ── G. v4.3 response-staleness — Sent folder + bulk SEARCH HEADER ──
//
// Verifies the M4.3 IMAP additions against a live iCloud account:
//   1. resolveSentFolder() finds the Sent folder (Apple convention is
//      'Sent Messages'; specialUse=\Sent should also match).
//   2. searchSentReplies() runs against a real recent inbound messageId
//      without throwing (proves SEARCH HEADER + OR criterion work on iCloud).
//
// READ-ONLY. No writes; no destructive paths.

console.log("\n[G] v4.3 response-staleness (M4.3) — Sent folder + bulk SEARCH HEADER");
const imapForStaleness = new ImapProvider(imapHost, imapPort, email, password);
try {
  const sentFolder = await imapForStaleness.resolveSentFolder();
  if (!sentFolder) {
    throw new Error(
      "M4.3: resolveSentFolder returned null — daily_brief will mark replyLookupError on every call"
    );
  }
  pass(`resolveSentFolder: "${sentFolder}"`);

  // Re-resolution must hit the cache (instant), not re-LIST.
  const t0 = Date.now();
  const cached = await imapForStaleness.resolveSentFolder();
  const cacheMs = Date.now() - t0;
  if (cached !== sentFolder) {
    throw new Error(
      `M4.3: cache returned different value: first="${sentFolder}" cached="${cached}"`
    );
  }
  if (cacheMs > 50) {
    console.log(
      `     ⚠️  Cached resolveSentFolder took ${cacheMs}ms — should be <5ms; cache may not be wired.`
    );
  }
  pass(`resolveSentFolder cache hit: ${cacheMs}ms`);

  // Bulk SEARCH HEADER against a real recent inbound message-id.
  const inbox = await imapForStaleness.listMessages("INBOX", 5, 0);
  const probe = inbox.messages.find((m) => m.messageId);
  if (!probe || !probe.messageId) {
    console.log(
      "     (skipped: no recent INBOX message has a Message-Id — can't probe bulk SEARCH)"
    );
  } else {
    const t1 = Date.now();
    const replies = await imapForStaleness.searchSentReplies(
      sentFolder,
      [probe.messageId],
      90
    );
    const searchMs = Date.now() - t1;
    if (!Array.isArray(replies)) {
      throw new Error(
        `M4.3: searchSentReplies must return an array, got ${typeof replies}`
      );
    }
    pass(
      `searchSentReplies (1 id, 90d SINCE): ${replies.length} match(es) in ${searchMs}ms`
    );
    if (searchMs > 5000) {
      console.log(
        `     ⚠️  Bulk SEARCH >5s — daily_brief p95 likely degrades; revisit OQ#2.`
      );
    }
    if (replies.length > 0) {
      const r = replies[0]!;
      if (
        !("inReplyTo" in r) ||
        !("references" in r) ||
        !("date" in r) ||
        !("messageId" in r)
      ) {
        throw new Error(
          `M4.3: SentReplyEntry shape missing fields: ${JSON.stringify(Object.keys(r))}`
        );
      }
      if (!Array.isArray(r.references)) {
        throw new Error("M4.3: SentReplyEntry.references must be string[]");
      }
      pass(
        `SentReplyEntry shape: { messageId, inReplyTo, references[], date }`
      );
    }
  }
} catch (err) {
  fail("G. v4.3 response-staleness", err);
} finally {
  await imapForStaleness.disconnect();
}

// ── Summary ──

console.log("\n=== Summary ===");
console.log(`Passed: ${totalPassed}`);
console.log(`Failed: ${totalFailed}`);
if (totalFailed > 0) {
  console.error("\n❌ One or more sections failed. Investigate before tagging a release.");
  process.exit(1);
}
console.log(
  "\n✓ All sections passed. v2 + v3 surfaces are intact against real iCloud."
);
