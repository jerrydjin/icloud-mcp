import { describe, expect, test } from "bun:test";
import { parseThreadingHeaders } from "../src/providers/imap.js";

// parseThreadingHeaders is the parser for the raw header buffer that imapflow
// returns when fetched with `headers: ["in-reply-to", "references"]`. Pinning
// the parser here keeps M4.3 response-staleness joins correct without an
// IMAP round trip.

describe("parseThreadingHeaders", () => {
  test("undefined input → empty values", () => {
    expect(parseThreadingHeaders(undefined)).toEqual({
      inReplyTo: null,
      references: [],
    });
  });

  test("empty string → empty values", () => {
    expect(parseThreadingHeaders("")).toEqual({
      inReplyTo: null,
      references: [],
    });
  });

  test("In-Reply-To single id (string input)", () => {
    const raw = "In-Reply-To: <abc@example.com>\r\n";
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: "<abc@example.com>",
      references: [],
    });
  });

  test("In-Reply-To from a Buffer", () => {
    const raw = Buffer.from("In-Reply-To: <buf@example.com>\r\n", "utf8");
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: "<buf@example.com>",
      references: [],
    });
  });

  test("References tokenized into multiple ids", () => {
    const raw =
      "References: <root@example.com> <middle@example.com> <reply@example.com>\r\n";
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: null,
      references: [
        "<root@example.com>",
        "<middle@example.com>",
        "<reply@example.com>",
      ],
    });
  });

  test("folded References (continuation lines) unfold to a single value", () => {
    // RFC 5322 allows header folding: a line beginning with WSP continues the
    // previous header's value. iCloud's IMAP routinely folds long References.
    const raw =
      "References: <root@example.com>\r\n" +
      " <middle@example.com>\r\n" +
      "\t<reply@example.com>\r\n";
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: null,
      references: [
        "<root@example.com>",
        "<middle@example.com>",
        "<reply@example.com>",
      ],
    });
  });

  test("both headers present in same buffer", () => {
    const raw =
      "In-Reply-To: <abc@example.com>\r\n" +
      "References: <root@example.com> <abc@example.com>\r\n";
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: "<abc@example.com>",
      references: ["<root@example.com>", "<abc@example.com>"],
    });
  });

  test("case-insensitive header names", () => {
    const raw =
      "in-REPLY-to: <abc@example.com>\r\nREFERENCES: <root@example.com>\r\n";
    expect(parseThreadingHeaders(raw)).toEqual({
      inReplyTo: "<abc@example.com>",
      references: ["<root@example.com>"],
    });
  });

  test("In-Reply-To with trailing comment keeps only the id token", () => {
    const raw = "In-Reply-To: <abc@example.com> (this is a comment)\r\n";
    expect(parseThreadingHeaders(raw).inReplyTo).toBe("<abc@example.com>");
  });

  test("first In-Reply-To wins on duplicate header (broken sender)", () => {
    const raw =
      "In-Reply-To: <first@example.com>\r\nIn-Reply-To: <second@example.com>\r\n";
    expect(parseThreadingHeaders(raw).inReplyTo).toBe("<first@example.com>");
  });

  test("References missing returns empty array", () => {
    const raw = "In-Reply-To: <only@example.com>\r\n";
    expect(parseThreadingHeaders(raw).references).toEqual([]);
  });
});
