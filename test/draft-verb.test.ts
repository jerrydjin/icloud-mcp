import { describe, expect, test } from "bun:test";
import { looksLikeEmail } from "../src/verbs/draft.js";

describe("looksLikeEmail", () => {
  test("real-looking emails pass", () => {
    expect(looksLikeEmail("jane@example.com")).toBe(true);
    expect(looksLikeEmail("a@b")).toBe(true);
    expect(looksLikeEmail("first.last+tag@subdomain.co.uk")).toBe(true);
  });

  test("names without @ fail", () => {
    expect(looksLikeEmail("Jane Smith")).toBe(false);
    expect(looksLikeEmail("Bob")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
  });

  test("strings with whitespace fail (don't try to be clever)", () => {
    expect(looksLikeEmail("Jane Smith <jane@example.com>")).toBe(false);
    expect(looksLikeEmail("jane @ example.com")).toBe(false);
  });

  test("@ at edges fail", () => {
    expect(looksLikeEmail("@example.com")).toBe(false);
    expect(looksLikeEmail("jane@")).toBe(false);
    expect(looksLikeEmail("@")).toBe(false);
  });
});
