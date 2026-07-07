import { describe, expect, test } from "bun:test";

const PROTECTED_FOLDERS = [
  "INBOX",
  "Sent",
  "Trash",
  "Drafts",
  "Junk",
  "Archive",
  "Sent Messages",
];

function isProtectedFolder(name: string): boolean {
  return PROTECTED_FOLDERS.some(
    (f) => f.toLowerCase() === name.toLowerCase()
  );
}

function validateSearchCriteria(
  criteria: Record<string, unknown>
): string | null {
  if (Object.keys(criteria).length === 0) {
    return "At least one search criterion is required. Use list_messages to browse a folder without filters.";
  }
  return null;
}

describe("protected folder validation", () => {
  test("blocks INBOX deletion", () => {
    expect(isProtectedFolder("INBOX")).toBe(true);
  });

  test("blocks case-insensitive match", () => {
    expect(isProtectedFolder("inbox")).toBe(true);
    expect(isProtectedFolder("TRASH")).toBe(true);
    expect(isProtectedFolder("drafts")).toBe(true);
  });

  test("blocks all protected folders", () => {
    for (const folder of PROTECTED_FOLDERS) {
      expect(isProtectedFolder(folder)).toBe(true);
    }
  });

  test("allows custom folder deletion", () => {
    expect(isProtectedFolder("Projects")).toBe(false);
    expect(isProtectedFolder("Work/Important")).toBe(false);
  });

  test("allows Sent Messages variant", () => {
    expect(isProtectedFolder("Sent Messages")).toBe(true);
  });
});

describe("search criteria validation", () => {
  test("rejects empty criteria", () => {
    expect(validateSearchCriteria({})).toBeTruthy();
  });

  test("accepts single criterion", () => {
    expect(validateSearchCriteria({ from: "test@test.com" })).toBeNull();
  });

  test("accepts multiple criteria", () => {
    expect(
      validateSearchCriteria({ from: "test@test.com", subject: "hello" })
    ).toBeNull();
  });
});
