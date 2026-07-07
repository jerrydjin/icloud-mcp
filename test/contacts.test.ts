import { describe, expect, test } from "bun:test";
import {
  parseVCard,
  mergeContactForUpdate,
  matchContacts,
  fuzzyNameMatches,
  type Contact,
} from "../src/providers/contacts.js";

// ── parseVCard ──

const VCARD_BASIC = `BEGIN:VCARD
VERSION:3.0
UID:basic-1
FN:Jane Smith
N:Smith;Jane;;;
EMAIL;TYPE=INTERNET:jane@example.com
END:VCARD`;

const VCARD_FULL = `BEGIN:VCARD
VERSION:3.0
UID:full-1
FN:John Doe
N:Doe;John;A;Mr;Jr
EMAIL;TYPE=WORK:john@work.com
EMAIL;TYPE=HOME;PREF=1:john@home.com
TEL;TYPE=CELL:+1-555-1234
TEL;TYPE=WORK:+1-555-5678
ORG:Acme Inc;Engineering Department
TITLE:Senior Engineer
NOTE:Met at the conference
END:VCARD`;

const VCARD_FOLDED = `BEGIN:VCARD
VERSION:3.0
UID:folded-1
FN:Long Name Here
NOTE:This is a long note
 that spans multiple lines
 due to vCard line folding
END:VCARD`;

const VCARD_ESCAPED = `BEGIN:VCARD
VERSION:3.0
UID:escape-1
FN:Doe\\, John
NOTE:Line1\\nLine2
ORG:Acme\\;Inc
END:VCARD`;

const VCARD_MISSING_UID = `BEGIN:VCARD
VERSION:3.0
FN:No UID
N:;No UID;;;
END:VCARD`;

const VCARD_NO_FN_HAS_N = `BEGIN:VCARD
VERSION:3.0
UID:no-fn-1
N:Smith;Jane;;;
END:VCARD`;

describe("parseVCard", () => {
  test("parses basic vCard", () => {
    const c = parseVCard(VCARD_BASIC, "Personal", "https://example.com/personal/");
    expect(c).not.toBeNull();
    expect(c!.uid).toBe("basic-1");
    expect(c!.fullName).toBe("Jane Smith");
    expect(c!.givenName).toBe("Jane");
    expect(c!.familyName).toBe("Smith");
    expect(c!.emails).toEqual([
      { address: "jane@example.com", type: "INTERNET", preferred: false },
    ]);
    expect(c!.phones).toEqual([]);
    expect(c!.addressBookName).toBe("Personal");
  });

  test("parses vCard with multiple emails, phones, ORG, TITLE, NOTE", () => {
    const c = parseVCard(VCARD_FULL, "Work", "https://example.com/work/");
    expect(c).not.toBeNull();
    expect(c!.emails).toHaveLength(2);
    expect(c!.emails[0]).toEqual({
      address: "john@work.com",
      type: "WORK",
      preferred: false,
    });
    expect(c!.emails[1]).toEqual({
      address: "john@home.com",
      type: "HOME",
      preferred: true,
    });
    expect(c!.phones).toHaveLength(2);
    expect(c!.phones[0]).toEqual({ number: "+1-555-1234", type: "CELL" });
    expect(c!.organization).toBe("Acme Inc");
    expect(c!.title).toBe("Senior Engineer");
    expect(c!.note).toBe("Met at the conference");
  });

  test("handles vCard line folding (RFC 6350 § 3.2)", () => {
    const c = parseVCard(VCARD_FOLDED, "Personal", "https://example.com/p/");
    expect(c).not.toBeNull();
    expect(c!.note).toBe(
      "This is a long notethat spans multiple linesdue to vCard line folding"
    );
  });

  test("unescapes vCard escape sequences (\\, \\n \\;)", () => {
    const c = parseVCard(VCARD_ESCAPED, "Personal", "https://example.com/p/");
    expect(c).not.toBeNull();
    expect(c!.fullName).toBe("Doe, John");
    expect(c!.note).toBe("Line1\nLine2");
    expect(c!.organization).toBe("Acme;Inc");
  });

  test("returns null when UID is missing", () => {
    const c = parseVCard(VCARD_MISSING_UID, "Personal", "https://example.com/p/");
    expect(c).toBeNull();
  });

  test("falls back to N when FN is missing", () => {
    const c = parseVCard(VCARD_NO_FN_HAS_N, "Personal", "https://example.com/p/");
    expect(c).not.toBeNull();
    expect(c!.fullName).toBe("Jane Smith");
  });
});

// ── mergeContactForUpdate ──

const baseContact: Contact = {
  uid: "merge-uid",
  fullName: "Original Name",
  givenName: "Original",
  familyName: "Name",
  emails: [{ address: "old@example.com", type: "WORK" }],
  phones: [{ number: "+1-555-0000", type: "CELL" }],
  organization: "Old Co",
  title: "Old Title",
  note: "Old note",
  addressBookUrl: "https://example.com/p/",
  addressBookName: "Personal",
  url: "https://example.com/p/merge-uid.vcf",
  etag: "etag-1",
};

describe("mergeContactForUpdate", () => {
  test("undefined fields preserve existing values", () => {
    const merged = mergeContactForUpdate(baseContact, {});
    expect(merged.fullName).toBe("Original Name");
    expect(merged.organization).toBe("Old Co");
    expect(merged.emails).toEqual([{ address: "old@example.com", type: "WORK" }]);
  });

  test("explicit fullName replaces existing", () => {
    const merged = mergeContactForUpdate(baseContact, { fullName: "New Name" });
    expect(merged.fullName).toBe("New Name");
    expect(merged.organization).toBe("Old Co"); // preserved
  });

  test("organization=null clears", () => {
    const merged = mergeContactForUpdate(baseContact, { organization: null });
    expect(merged.organization).toBeUndefined();
  });

  test("emails array replaces entirely (does not merge)", () => {
    const merged = mergeContactForUpdate(baseContact, {
      emails: [{ address: "new@example.com" }],
    });
    expect(merged.emails).toEqual([{ address: "new@example.com" }]);
  });

  test("emails=[] empties the list", () => {
    const merged = mergeContactForUpdate(baseContact, { emails: [] });
    expect(merged.emails).toEqual([]);
  });

  test("title=null clears, title=undefined preserves", () => {
    const cleared = mergeContactForUpdate(baseContact, { title: null });
    expect(cleared.title).toBeUndefined();

    const preserved = mergeContactForUpdate(baseContact, {});
    expect(preserved.title).toBe("Old Title");
  });
});

// ── matchContacts ──

const sampleContacts: Contact[] = [
  {
    uid: "1",
    fullName: "Alice Anderson",
    givenName: "Alice",
    familyName: "Anderson",
    emails: [{ address: "alice@example.com", type: "WORK" }],
    phones: [],
    addressBookUrl: "x",
    addressBookName: "Personal",
    url: "x",
  },
  {
    uid: "2",
    fullName: "Bob Brown",
    givenName: "Bob",
    familyName: "Brown",
    emails: [{ address: "bob@example.com", type: "WORK" }],
    phones: [{ number: "+1-555-1234", type: "CELL" }],
    addressBookUrl: "x",
    addressBookName: "Personal",
    url: "x",
  },
  {
    uid: "3",
    fullName: "Charlie",
    givenName: "Charlie",
    emails: [
      { address: "charlie.work@example.com", type: "WORK" },
      { address: "charlie.home@example.com", type: "HOME" },
    ],
    phones: [],
    addressBookUrl: "x",
    addressBookName: "Personal",
    url: "x",
  },
];

describe("matchContacts", () => {
  test("exact email match returns the contact first", () => {
    const r = matchContacts(sampleContacts, "alice@example.com");
    expect(r).toHaveLength(1);
    expect(r[0]!.fullName).toBe("Alice Anderson");
  });

  test("partial email match works", () => {
    const r = matchContacts(sampleContacts, "charlie.home");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("3");
  });

  test("name substring match works", () => {
    const r = matchContacts(sampleContacts, "brown");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("2");
  });

  test("phone digits match (ignoring formatting)", () => {
    const r = matchContacts(sampleContacts, "5551234");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("2");
  });

  test("no match returns []", () => {
    const r = matchContacts(sampleContacts, "nobody");
    expect(r).toEqual([]);
  });

  test("empty query returns []", () => {
    expect(matchContacts(sampleContacts, "")).toEqual([]);
    expect(matchContacts(sampleContacts, "   ")).toEqual([]);
  });

  test("exact email match precedes partial matches in result order", () => {
    // Note: this scenario doesn't really happen with 3 contacts but matters
    // when query is generic. Constructing a case where one email is exact match.
    const r = matchContacts(sampleContacts, "bob@example.com");
    expect(r[0]!.uid).toBe("2");
  });

  test("case-insensitive name match", () => {
    const r = matchContacts(sampleContacts, "ALICE");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("1");
  });

  // ── M4.1: fuzzy name fallback ──

  test("fuzzy match: 1-edit typo on a longer name resolves", () => {
    // "Andersn" is one delete from "Anderson" (8 chars → similarity 0.875,
    // above the 0.85 threshold). Doesn't substring-match, fuzzy fallback catches it.
    const r = matchContacts(sampleContacts, "Andersn");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("1");
  });

  test("fuzzy match: 1-edit typo via substitution resolves", () => {
    // "Andersan" is one substitution from "Anderson" → similarity 0.875
    const r = matchContacts(sampleContacts, "Andersan");
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.map((c) => c.uid)).toContain("1");
  });

  test("fuzzy fallback only fires when partial match yields nothing", () => {
    // "Alice" substring-matches "Alice Anderson" so fuzzy fallback is NOT invoked
    // and result count stays at 1 (not pulling in fuzzy-but-wrong matches)
    const r = matchContacts(sampleContacts, "Alice");
    expect(r).toHaveLength(1);
    expect(r[0]!.uid).toBe("1");
  });

  test("fuzzy fallback skipped for email-shaped queries", () => {
    // An unknown email shouldn't fuzzy-match a name
    const r = matchContacts(sampleContacts, "xyz@nowhere.com");
    expect(r).toEqual([]);
  });

  test("fuzzy fallback skipped for digit-only queries (treated as phone)", () => {
    const r = matchContacts(sampleContacts, "9999");
    expect(r).toEqual([]);
  });

  test("totally different name does not fuzzy-match", () => {
    const r = matchContacts(sampleContacts, "Robert");
    expect(r).toEqual([]);
  });
});

describe("fuzzyNameMatches", () => {
  test("threshold 0.85 catches single-edit typos", () => {
    const r = fuzzyNameMatches(sampleContacts, "Anderssn"); // 1 edit from Anderson
    expect(r.map((c) => c.uid)).toContain("1");
  });

  test("threshold 0.85 rejects very different names", () => {
    const r = fuzzyNameMatches(sampleContacts, "Zelda");
    expect(r).toEqual([]);
  });

  test("custom threshold can loosen matching", () => {
    const r = fuzzyNameMatches(sampleContacts, "Brwn", 0.7);
    expect(r.map((c) => c.uid)).toContain("2");
  });
});
