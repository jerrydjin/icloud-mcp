import { describe, expect, test } from "bun:test";
import {
  canonicalEmail,
  canonicalPhone,
  levenshtein,
  levenshteinSimilarity,
  normalizeNameTokens,
  sameEmail,
} from "../src/utils/identity.js";

describe("canonicalEmail", () => {
  test("lowercases and trims a basic email", () => {
    expect(canonicalEmail("  Jane@EXAMPLE.com  ")).toBe("jane@example.com");
  });

  test("strips mailto: prefix (CalDAV ATTENDEE values)", () => {
    expect(canonicalEmail("mailto:jane@example.com")).toBe("jane@example.com");
    expect(canonicalEmail("MAILTO:Jane@Example.com")).toBe("jane@example.com");
  });

  test("strips surrounding angle brackets", () => {
    expect(canonicalEmail("<jane@example.com>")).toBe("jane@example.com");
  });

  test("extracts email from 'Display Name <email>' format", () => {
    expect(canonicalEmail("Jane Smith <jane@example.com>")).toBe(
      "jane@example.com"
    );
    expect(canonicalEmail('"Jane Smith" <jane@example.com>')).toBe(
      "jane@example.com"
    );
  });

  test("returns empty string for non-email input", () => {
    expect(canonicalEmail("")).toBe("");
    expect(canonicalEmail("   ")).toBe("");
    expect(canonicalEmail("not-an-email")).toBe("");
    expect(canonicalEmail("@example.com")).toBe("");
    expect(canonicalEmail("jane@")).toBe("");
  });

  test("strips Gmail plus-tags (gmail.com)", () => {
    expect(canonicalEmail("jane+tag@gmail.com")).toBe("jane@gmail.com");
    expect(canonicalEmail("jane+a+b+c@gmail.com")).toBe("jane@gmail.com");
  });

  test("strips Gmail dots in local part", () => {
    expect(canonicalEmail("j.a.n.e@gmail.com")).toBe("jane@gmail.com");
    expect(canonicalEmail("jane.smith+tag@gmail.com")).toBe("janesmith@gmail.com");
  });

  test("strips Gmail tags for googlemail.com too", () => {
    expect(canonicalEmail("jane+tag@googlemail.com")).toBe("jane@googlemail.com");
  });

  test("does NOT strip plus-tags or dots for other providers", () => {
    // Non-Gmail providers may treat plus-tags as distinct addresses
    expect(canonicalEmail("jane+tag@example.com")).toBe("jane+tag@example.com");
    expect(canonicalEmail("j.a.n.e@example.com")).toBe("j.a.n.e@example.com");
  });

  test("handles iCloud addresses (don't alias them)", () => {
    expect(canonicalEmail("Jane@icloud.com")).toBe("jane@icloud.com");
    expect(canonicalEmail("jane+tag@icloud.com")).toBe("jane+tag@icloud.com");
  });
});

describe("sameEmail", () => {
  test("two equivalent emails match", () => {
    expect(sameEmail("Jane@Example.com", "jane@example.com")).toBe(true);
    expect(sameEmail("mailto:jane@example.com", "<jane@example.com>")).toBe(
      true
    );
  });

  test("Gmail aliases match", () => {
    expect(sameEmail("jane.smith+work@gmail.com", "janesmith@gmail.com")).toBe(
      true
    );
  });

  test("different emails don't match", () => {
    expect(sameEmail("jane@example.com", "bob@example.com")).toBe(false);
  });

  test("empty/invalid inputs don't match (avoid '' === '' false-positive)", () => {
    expect(sameEmail("", "")).toBe(false);
    expect(sameEmail("not-email", "also-not-email")).toBe(false);
    expect(sameEmail("jane@example.com", "")).toBe(false);
  });
});

describe("canonicalPhone", () => {
  test("strips formatting", () => {
    expect(canonicalPhone("(415) 555-0100")).toBe("4155550100");
    expect(canonicalPhone("+1-415-555-0100")).toBe("4155550100");
    expect(canonicalPhone("415.555.0100")).toBe("4155550100");
  });

  test("drops leading 1 only for 11-digit numbers", () => {
    expect(canonicalPhone("14155550100")).toBe("4155550100");
    expect(canonicalPhone("4155550100")).toBe("4155550100");
    // Don't strip the leading 1 from numbers that aren't NANP-shaped
    expect(canonicalPhone("447911123456")).toBe("447911123456");
  });

  test("returns empty for non-phone input", () => {
    expect(canonicalPhone("")).toBe("");
    expect(canonicalPhone("not-a-phone")).toBe("");
    expect(canonicalPhone("---")).toBe("");
  });
});

describe("levenshtein", () => {
  test("equal strings have distance 0", () => {
    expect(levenshtein("jane", "jane")).toBe(0);
  });

  test("single edit", () => {
    expect(levenshtein("jane", "jaen")).toBe(2); // transpose = 2 single-char edits
    expect(levenshtein("jane", "janes")).toBe(1);
    expect(levenshtein("jane", "jan")).toBe(1);
  });

  test("empty strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("totally different", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("levenshteinSimilarity", () => {
  test("identical = 1.0", () => {
    expect(levenshteinSimilarity("Jane", "jane")).toBe(1);
  });

  test("typo on a long-ish name still matches above 0.85", () => {
    // "jane smith" -> "jane smithe" = 1 edit / 11 chars = 0.909
    expect(levenshteinSimilarity("jane smith", "jane smithe")).toBeGreaterThan(
      0.85
    );
  });

  test("very different names score low", () => {
    expect(levenshteinSimilarity("jane", "robert")).toBeLessThan(0.5);
  });

  test("empty inputs both empty = 1.0 (degenerate but defined)", () => {
    expect(levenshteinSimilarity("", "")).toBe(1);
  });
});

describe("normalizeNameTokens", () => {
  test("splits on whitespace, lowercases, strips dots", () => {
    expect(normalizeNameTokens("Jane Smith")).toEqual(["jane", "smith"]);
    expect(normalizeNameTokens("J. Smith")).toEqual(["j", "smith"]);
    expect(normalizeNameTokens("Smith, Jane")).toEqual(["smith", "jane"]);
  });

  test("keeps apostrophes and hyphens (load-bearing in real names)", () => {
    expect(normalizeNameTokens("Jane O'Neill")).toEqual(["jane", "o'neill"]);
    expect(normalizeNameTokens("Mary-Jane Watson")).toEqual([
      "mary-jane",
      "watson",
    ]);
  });

  test("empty input returns empty array", () => {
    expect(normalizeNameTokens("")).toEqual([]);
    expect(normalizeNameTokens("   ")).toEqual([]);
  });
});
