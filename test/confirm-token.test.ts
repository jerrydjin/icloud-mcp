import { describe, expect, test } from "bun:test";
import {
  signProposal,
  verifyToken,
  canonicalize,
} from "../src/utils/confirm-token.js";

const VALID_SECRET = "x".repeat(64); // 64 chars; passes the >=32 length gate

describe("signProposal — security gates", () => {
  test("throws on missing secret", async () => {
    await expect(signProposal({}, undefined)).rejects.toThrow(
      /CONFIRM_TOKEN_SECRET is not set/
    );
  });

  test("throws on empty secret", async () => {
    await expect(signProposal({}, "")).rejects.toThrow(
      /CONFIRM_TOKEN_SECRET is not set/
    );
  });

  test("throws on secret shorter than 32 chars", async () => {
    await expect(signProposal({}, "x".repeat(31))).rejects.toThrow(
      /too short/
    );
  });

  test("accepts a 32+ char secret", async () => {
    const token = await signProposal({ test: 1 }, "x".repeat(32));
    expect(token).toBeTruthy();
    expect(token).toContain(".");
  });
});

describe("signProposal + verifyToken — happy path", () => {
  test("freshly-signed token verifies as valid", async () => {
    const proposal = { reminder: { title: "test", idempotencyKey: "k1" } };
    const token = await signProposal(proposal, VALID_SECRET);
    const result = await verifyToken(token, proposal, VALID_SECRET);
    expect(result.valid).toBe(true);
    expect(result.expired).toBe(false);
    expect(result.mismatch).toBe(false);
  });

  test("verification rejects wrong proposal (mismatch)", async () => {
    const original = { reminder: { title: "original" } };
    const tampered = { reminder: { title: "tampered" } };
    const token = await signProposal(original, VALID_SECRET);
    const result = await verifyToken(token, tampered, VALID_SECRET);
    expect(result.valid).toBe(false);
    expect(result.mismatch).toBe(true);
  });

  test("verification rejects tampered token (signature mismatch)", async () => {
    const proposal = { reminder: { title: "test" } };
    const token = await signProposal(proposal, VALID_SECRET);
    // Flip a single character in the MAC portion
    const dot = token.indexOf(".");
    const tampered =
      token.slice(0, dot + 1) +
      (token.charAt(dot + 1) === "A" ? "B" : "A") +
      token.slice(dot + 2);
    const result = await verifyToken(tampered, proposal, VALID_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
    expect(result.mismatch).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  test("verification rejects token signed with different secret", async () => {
    const proposal = { reminder: { title: "test" } };
    const token = await signProposal(proposal, VALID_SECRET);
    const result = await verifyToken(token, proposal, "y".repeat(64));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  test("verification handles malformed token gracefully", async () => {
    const result = await verifyToken("nodothere", {}, VALID_SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed_token");
  });

  test("expiration: a token with 0-sec TTL is expired immediately", async () => {
    const proposal = { reminder: { title: "test" } };
    const token = await signProposal(proposal, VALID_SECRET, 0);
    // Sleep a tiny bit so the unix-second tick advances
    await new Promise((r) => setTimeout(r, 1100));
    const result = await verifyToken(token, proposal, VALID_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
  });
});

describe("canonicalize — deterministic key ordering", () => {
  test("object keys are sorted regardless of input order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("nested objects also sorted", () => {
    expect(
      canonicalize({ outer: { z: 1, a: 2 } })
    ).toBe(canonicalize({ outer: { a: 2, z: 1 } }));
  });

  test("arrays preserve order", () => {
    expect(canonicalize([1, 2, 3])).toBe(JSON.stringify([1, 2, 3]));
    expect(canonicalize([3, 2, 1])).toBe(JSON.stringify([3, 2, 1]));
  });

  test("primitives canonicalize to JSON.stringify", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize("hi")).toBe('"hi"');
  });
});
