import { describe, expect, test } from "bun:test";
import {
  idempotencyKey,
  fnv1a64,
} from "../src/verbs/triage.js";
import {
  uuidFromIdempotencyKey,
  messageIdFromIdempotencyKey,
} from "../src/verbs/triage-commit.js";

describe("fnv1a64 — deterministic hash", () => {
  test("same input → same output", () => {
    expect(fnv1a64("hello")).toBe(fnv1a64("hello"));
  });
  test("different input → different output", () => {
    expect(fnv1a64("hello")).not.toBe(fnv1a64("world"));
  });
  test("returns 16-char hex string", () => {
    const out = fnv1a64("test");
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });
  test("empty string is well-defined", () => {
    expect(fnv1a64("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("idempotencyKey", () => {
  test("same content + same leg + same thread → same key", () => {
    const a = idempotencyKey("thread-1", "reminder", { title: "hi" });
    const b = idempotencyKey("thread-1", "reminder", { title: "hi" });
    expect(a).toBe(b);
  });

  test("different content → different key", () => {
    const a = idempotencyKey("thread-1", "reminder", { title: "hi" });
    const b = idempotencyKey("thread-1", "reminder", { title: "bye" });
    expect(a).not.toBe(b);
  });

  test("different leg → different key", () => {
    const a = idempotencyKey("thread-1", "reminder", { title: "hi" });
    const b = idempotencyKey("thread-1", "event", { title: "hi" });
    expect(a).not.toBe(b);
  });

  test("different thread → different key", () => {
    const a = idempotencyKey("thread-1", "reminder", { title: "hi" });
    const b = idempotencyKey("thread-2", "reminder", { title: "hi" });
    expect(a).not.toBe(b);
  });

  test("key order in content doesn't change result (canonicalized)", () => {
    const a = idempotencyKey("t", "reminder", { a: 1, b: 2 });
    const b = idempotencyKey("t", "reminder", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test("key shape is human-readable + grep-friendly", () => {
    const k = idempotencyKey("t", "reminder", {});
    expect(k).toMatch(/^triage-reminder-[0-9a-f]{16}$/);
  });
});

describe("uuidFromIdempotencyKey", () => {
  test("returns UUID v4-shaped string", () => {
    const uuid = uuidFromIdempotencyKey("triage-reminder-abc");
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("deterministic — same key → same UUID", () => {
    const a = uuidFromIdempotencyKey("k1");
    const b = uuidFromIdempotencyKey("k1");
    expect(a).toBe(b);
  });

  test("different key → different UUID", () => {
    const a = uuidFromIdempotencyKey("k1");
    const b = uuidFromIdempotencyKey("k2");
    expect(a).not.toBe(b);
  });
});

describe("messageIdFromIdempotencyKey", () => {
  test("returns RFC 5322 Message-Id shape", () => {
    const id = messageIdFromIdempotencyKey("triage-draft-abc");
    expect(id).toMatch(/^<[0-9a-f]{16}@triage\.icloud-mcp\.local>$/);
  });

  test("deterministic", () => {
    expect(messageIdFromIdempotencyKey("k1")).toBe(
      messageIdFromIdempotencyKey("k1")
    );
  });

  test("different key → different Message-Id", () => {
    expect(messageIdFromIdempotencyKey("k1")).not.toBe(
      messageIdFromIdempotencyKey("k2")
    );
  });
});
