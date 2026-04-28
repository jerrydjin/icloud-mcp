import type { DAVAddressBook } from "tsdav";
import { CalDavTransport } from "./caldav-transport.js";
import { requireOkAndEtag, requireOkAndEtagOrConflict } from "./icloud-quirks.js";

// ContactsProvider speaks CardDAV. iCloud's CardDAV endpoint is separate from CalDAV
// (https://contacts.icloud.com), but auth is the same app-specific password.
//
// vCard parsing is hand-rolled because the project doesn't depend on a vCard library.
// We parse the fields v3 actually needs: UID, FN, N, EMAIL, TEL, ORG, TITLE, NOTE.

export interface AddressBookInfo {
  displayName: string;
  url: string;
  ctag?: string;
  description?: string;
}

export interface Contact {
  uid: string;
  fullName: string; // FN
  givenName?: string; // N — given name (slot 2)
  familyName?: string; // N — family name (slot 1)
  emails: ContactEmail[];
  phones: ContactPhone[];
  organization?: string; // ORG
  title?: string; // TITLE
  note?: string; // NOTE
  addressBookUrl: string;
  addressBookName: string;
  url: string; // CardDAV object URL
  etag?: string;
}

export interface ContactEmail {
  address: string;
  type?: string; // HOME / WORK / INTERNET / etc.
  preferred?: boolean;
}

export interface ContactPhone {
  number: string;
  type?: string; // CELL / WORK / HOME / etc.
}

export interface CreateContactInput {
  fullName: string;
  givenName?: string;
  familyName?: string;
  emails?: { address: string; type?: string }[];
  phones?: { number: string; type?: string }[];
  organization?: string;
  title?: string;
  note?: string;
  addressBook?: string; // display name or URL
}

export interface UpdateContactInput {
  fullName?: string;
  givenName?: string;
  familyName?: string;
  emails?: { address: string; type?: string }[]; // replaces entirely
  phones?: { number: string; type?: string }[]; // replaces entirely
  organization?: string | null; // null clears
  title?: string | null;
  note?: string | null;
}

export class ContactsProvider extends CalDavTransport {
  private addressBooksCache: DAVAddressBook[] | null = null;

  constructor(serverUrl: string, email: string, password: string) {
    super(serverUrl, email, password, "carddav");
  }

  protected override onDisconnect(): void {
    this.addressBooksCache = null;
  }

  // ── Address books ──

  async listAddressBooks(): Promise<AddressBookInfo[]> {
    await this.ensureConnected();
    const books = await this.dav.fetchAddressBooks();
    this.addressBooksCache = books;
    return books.map((b) => ({
      displayName: String(b.displayName || "(unnamed)"),
      url: b.url,
      ctag: b.ctag,
      description: b.description,
    }));
  }

  async resolveAddressBookUrl(nameOrUrl?: string): Promise<string> {
    const books = await this.listAddressBooks();
    if (books.length === 0) {
      throw new Error("No address books found");
    }
    if (!nameOrUrl) return books[0]!.url;
    if (nameOrUrl.startsWith("http://") || nameOrUrl.startsWith("https://")) {
      return nameOrUrl;
    }
    const matches = books.filter(
      (b) => b.displayName.toLowerCase() === nameOrUrl.toLowerCase()
    );
    if (matches.length === 0) {
      const available = books.map((b) => b.displayName).join(", ");
      throw new Error(
        `Address book "${nameOrUrl}" not found. Available: ${available}`
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous address book "${nameOrUrl}" matches ${matches.length} books. Use the URL instead.`
      );
    }
    return matches[0]!.url;
  }

  // ── Reads ──

  async listContacts(addressBookUrl: string): Promise<Contact[]> {
    await this.ensureConnected();
    const bookName = await this.getAddressBookName(addressBookUrl);

    const objects = await this.dav.fetchVCards({
      addressBook: { url: addressBookUrl } as DAVAddressBook,
    });

    const contacts: Contact[] = [];
    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = parseVCard(obj.data as string, bookName, addressBookUrl);
        if (!parsed) continue;
        parsed.url = obj.url;
        parsed.etag = obj.etag;
        contacts.push(parsed);
      } catch {
        continue;
      }
    }

    contacts.sort((a, b) =>
      a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" })
    );
    return contacts;
  }

  async getContact(addressBookUrl: string, uid: string): Promise<Contact | null> {
    await this.ensureConnected();
    const bookName = await this.getAddressBookName(addressBookUrl);

    const objects = await this.dav.fetchVCards({
      addressBook: { url: addressBookUrl } as DAVAddressBook,
    });

    for (const obj of objects) {
      if (!obj.data) continue;
      try {
        const parsed = parseVCard(obj.data as string, bookName, addressBookUrl);
        if (parsed && parsed.uid === uid) {
          parsed.url = obj.url;
          parsed.etag = obj.etag;
          return parsed;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async searchContacts(query: string): Promise<Contact[]> {
    const books = await this.listAddressBooks();
    const allContacts: Contact[] = [];
    for (const book of books) {
      try {
        const contacts = await this.listContacts(book.url);
        allContacts.push(...contacts);
      } catch {
        // Per-book errors are non-fatal; continue
      }
    }
    return matchContacts(allContacts, query);
  }

  // ── Writes ──

  async createContact(
    addressBookUrl: string,
    input: CreateContactInput
  ): Promise<Contact> {
    await this.ensureConnected();
    const bookName = await this.getAddressBookName(addressBookUrl);

    const uid = crypto.randomUUID();
    const vCardString = buildVCard({ uid, ...input });

    const response = await this.dav.createVCard({
      addressBook: { url: addressBookUrl } as DAVAddressBook,
      filename: `${uid}.vcf`,
      vCardString,
    });

    const etag = await requireOkAndEtag(response, vCardErrorExcerpt(vCardString));
    const resultUrl = response.url || `${addressBookUrl}${uid}.vcf`;

    return {
      uid,
      fullName: input.fullName,
      givenName: input.givenName,
      familyName: input.familyName,
      emails: (input.emails ?? []).map((e) => ({
        address: e.address,
        type: e.type,
      })),
      phones: (input.phones ?? []).map((p) => ({
        number: p.number,
        type: p.type,
      })),
      organization: input.organization,
      title: input.title,
      note: input.note,
      addressBookUrl,
      addressBookName: bookName,
      url: resultUrl,
      etag,
    };
  }

  async updateContact(
    addressBookUrl: string,
    uid: string,
    updates: UpdateContactInput
  ): Promise<Contact> {
    await this.ensureConnected();
    const existing = await this.getContact(addressBookUrl, uid);
    if (!existing) {
      throw new Error(`Contact ${uid} not found in address book ${addressBookUrl}`);
    }
    if (!existing.etag) {
      throw new Error(
        `Contact ${uid} has no ETag — cannot perform conditional update`
      );
    }

    const merged = mergeContactForUpdate(existing, updates);
    const vCardString = buildVCard({
      uid: existing.uid,
      fullName: merged.fullName,
      givenName: merged.givenName,
      familyName: merged.familyName,
      emails: merged.emails,
      phones: merged.phones,
      organization: merged.organization,
      title: merged.title,
      note: merged.note,
    });

    const response = await this.dav.updateVCard({
      vCard: {
        url: existing.url,
        data: vCardString,
        etag: existing.etag,
      },
    });

    const newEtag = await requireOkAndEtagOrConflict(
      response,
      vCardErrorExcerpt(vCardString)
    );

    return {
      uid: existing.uid,
      fullName: merged.fullName,
      givenName: merged.givenName,
      familyName: merged.familyName,
      emails: merged.emails,
      phones: merged.phones,
      organization: merged.organization,
      title: merged.title,
      note: merged.note,
      addressBookUrl,
      addressBookName: existing.addressBookName,
      url: existing.url,
      etag: newEtag,
    };
  }

  // ── Internal ──

  private async getAddressBookName(addressBookUrl: string): Promise<string> {
    if (!this.addressBooksCache) {
      await this.listAddressBooks();
    }
    const book = this.addressBooksCache?.find((b) => b.url === addressBookUrl);
    return String(book?.displayName || "(unnamed)");
  }
}

// ── Pure functions (extracted for testability) ──

/**
 * Hand-parse a vCard 3.0 / 4.0 string. Extracts the fields v3 actually needs.
 * Handles line folding (RFC 6350 § 3.2): lines starting with a space/tab continue
 * the previous line.
 */
export function parseVCard(
  vCardData: string,
  addressBookName: string,
  addressBookUrl: string
): Contact | null {
  // Unfold lines: any line starting with space or tab continues the previous
  const unfolded: string[] = [];
  for (const line of vCardData.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }

  let uid: string | undefined;
  let fullName: string | undefined;
  let givenName: string | undefined;
  let familyName: string | undefined;
  let organization: string | undefined;
  let title: string | undefined;
  let note: string | undefined;
  const emails: ContactEmail[] = [];
  const phones: ContactPhone[] = [];

  for (const rawLine of unfolded) {
    if (!rawLine || rawLine.startsWith("BEGIN") || rawLine.startsWith("END")) continue;
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) continue;

    const left = rawLine.slice(0, colonIdx);
    const value = rawLine.slice(colonIdx + 1);
    const [name, ...paramParts] = left.split(";");
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) continue;
      params[part.slice(0, eqIdx).toUpperCase()] = part.slice(eqIdx + 1);
    }
    const fieldName = (name ?? "").toUpperCase();

    switch (fieldName) {
      case "UID":
        uid = unescapeVCardValue(value);
        break;
      case "FN":
        fullName = unescapeVCardValue(value);
        break;
      case "N": {
        // N is structured: family;given;additional;prefix;suffix. Split on UNESCAPED `;`.
        const parts = splitOnUnescapedSemicolon(value);
        familyName = parts[0] ? unescapeVCardValue(parts[0]) : undefined;
        givenName = parts[1] ? unescapeVCardValue(parts[1]) : undefined;
        break;
      }
      case "EMAIL":
        emails.push({
          address: unescapeVCardValue(value),
          type: params["TYPE"]?.replace(/^"(.*)"$/, "$1"),
          preferred: params["PREF"] === "1" || params["TYPE"]?.toUpperCase().includes("PREF"),
        });
        break;
      case "TEL":
        phones.push({
          number: unescapeVCardValue(value),
          type: params["TYPE"]?.replace(/^"(.*)"$/, "$1"),
        });
        break;
      case "ORG":
        // ORG is structured: "Company;Department;Office". Split on UNESCAPED `;`.
        organization = unescapeVCardValue(splitOnUnescapedSemicolon(value)[0] ?? value);
        break;
      case "TITLE":
        title = unescapeVCardValue(value);
        break;
      case "NOTE":
        note = unescapeVCardValue(value);
        break;
    }
  }

  if (!uid) return null;
  if (!fullName) {
    // Fall back to constructing from N if FN is missing
    fullName = [givenName, familyName].filter(Boolean).join(" ") || "(no name)";
  }

  return {
    uid,
    fullName,
    givenName,
    familyName,
    emails,
    phones,
    organization,
    title,
    note,
    addressBookUrl,
    addressBookName,
    url: "",
    etag: undefined,
  };
}

/**
 * Split a structured vCard value on UNESCAPED `;`. Per RFC 6350 § 3.4, escaped
 * semicolons (`\;`) are part of the field value, not separators.
 */
function splitOnUnescapedSemicolon(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function unescapeVCardValue(v: string): string {
  return v
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function escapeVCardValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildVCard(input: {
  uid: string;
  fullName: string;
  givenName?: string;
  familyName?: string;
  emails?: { address: string; type?: string }[];
  phones?: { number: string; type?: string }[];
  organization?: string;
  title?: string;
  note?: string;
}): string {
  const lines: string[] = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:3.0");
  lines.push(`UID:${escapeVCardValue(input.uid)}`);
  lines.push(`FN:${escapeVCardValue(input.fullName)}`);

  // N is required in vCard 3.0
  const n = [
    input.familyName ? escapeVCardValue(input.familyName) : "",
    input.givenName ? escapeVCardValue(input.givenName) : "",
    "",
    "",
    "",
  ].join(";");
  lines.push(`N:${n}`);

  for (const e of input.emails ?? []) {
    const typePart = e.type ? `;TYPE=${e.type.toUpperCase()}` : "";
    lines.push(`EMAIL${typePart}:${escapeVCardValue(e.address)}`);
  }
  for (const p of input.phones ?? []) {
    const typePart = p.type ? `;TYPE=${p.type.toUpperCase()}` : "";
    lines.push(`TEL${typePart}:${escapeVCardValue(p.number)}`);
  }
  if (input.organization) {
    lines.push(`ORG:${escapeVCardValue(input.organization)}`);
  }
  if (input.title) {
    lines.push(`TITLE:${escapeVCardValue(input.title)}`);
  }
  if (input.note) {
    lines.push(`NOTE:${escapeVCardValue(input.note)}`);
  }
  lines.push(`PRODID:-//icloud-mcp//v3//EN`);
  lines.push(`REV:${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z"}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

function vCardErrorExcerpt(vCardString: string): string {
  return vCardString
    .split(/\r?\n/)
    .filter((l) => /^(UID|FN|N|EMAIL|TEL|ORG|REV)/i.test(l))
    .join(" | ");
}

/**
 * Merge an existing contact with update input. null = clear, undefined = preserve,
 * value = replace. Email/phone arrays replace entirely when provided (not merged).
 */
export function mergeContactForUpdate(
  existing: Contact,
  updates: UpdateContactInput
): {
  fullName: string;
  givenName?: string;
  familyName?: string;
  emails: ContactEmail[];
  phones: ContactPhone[];
  organization?: string;
  title?: string;
  note?: string;
} {
  return {
    fullName: updates.fullName ?? existing.fullName,
    givenName:
      updates.givenName !== undefined ? updates.givenName : existing.givenName,
    familyName:
      updates.familyName !== undefined ? updates.familyName : existing.familyName,
    emails: updates.emails ?? existing.emails,
    phones: updates.phones ?? existing.phones,
    organization:
      updates.organization === null
        ? undefined
        : updates.organization ?? existing.organization,
    title: updates.title === null ? undefined : updates.title ?? existing.title,
    note: updates.note === null ? undefined : updates.note ?? existing.note,
  };
}

/**
 * Match contacts against a query. Tries email-exact-match first (case-insensitive),
 * then name-substring match (case-insensitive), then phone-substring match.
 * Returns up to 50 matches in relevance order.
 */
export function matchContacts(contacts: Contact[], query: string): Contact[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const exactEmailMatches: Contact[] = [];
  const partialMatches: Contact[] = [];

  for (const c of contacts) {
    const fnLower = c.fullName.toLowerCase();
    const emailExact = c.emails.some((e) => e.address.toLowerCase() === q);
    if (emailExact) {
      exactEmailMatches.push(c);
      continue;
    }
    const nameMatch = fnLower.includes(q);
    const givenMatch = c.givenName?.toLowerCase().includes(q) ?? false;
    const familyMatch = c.familyName?.toLowerCase().includes(q) ?? false;
    const emailPartial = c.emails.some((e) =>
      e.address.toLowerCase().includes(q)
    );
    // Only do phone matching when the query has digits — otherwise empty-string
    // matches every phone number.
    const qDigits = q.replace(/\D/g, "");
    const phoneMatch =
      qDigits.length > 0 &&
      c.phones.some((p) => p.number.replace(/\D/g, "").includes(qDigits));
    if (nameMatch || givenMatch || familyMatch || emailPartial || phoneMatch) {
      partialMatches.push(c);
    }
  }

  return [...exactEmailMatches, ...partialMatches].slice(0, 50);
}
