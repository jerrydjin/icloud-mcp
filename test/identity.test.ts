import { describe, expect, test } from "bun:test";
import { canonicalEmail, sameEmail } from "../src/utils/identity.js";

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
