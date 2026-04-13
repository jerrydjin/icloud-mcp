import { describe, expect, test } from "bun:test";

// Test reply/forward formatting logic extracted from tool handlers.
// These test the pure string manipulation without needing IMAP/SMTP connections.

function deduplicateRePrefix(subject: string): string {
  return `Re: ${subject.replace(/^(Re:\s*)+/i, "")}`;
}

function deduplicateFwdPrefix(subject: string): string {
  return `Fwd: ${subject.replace(/^(Fwd:\s*)+/i, "")}`;
}

function quoteOriginal(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildReplyBody(replyText: string, originalText: string): string {
  return `${replyText}\n\n${quoteOriginal(originalText)}`;
}

describe("Re: prefix deduplication", () => {
  test("adds Re: to plain subject", () => {
    expect(deduplicateRePrefix("Hello")).toBe("Re: Hello");
  });

  test("deduplicates single Re:", () => {
    expect(deduplicateRePrefix("Re: Hello")).toBe("Re: Hello");
  });

  test("deduplicates multiple Re:", () => {
    expect(deduplicateRePrefix("Re: Re: Re: Hello")).toBe("Re: Hello");
  });

  test("handles case-insensitive Re:", () => {
    expect(deduplicateRePrefix("re: RE: Hello")).toBe("Re: Hello");
  });

  test("preserves subject with Re-like content", () => {
    expect(deduplicateRePrefix("Results of the meeting")).toBe(
      "Re: Results of the meeting"
    );
  });
});

describe("Fwd: prefix deduplication", () => {
  test("adds Fwd: to plain subject", () => {
    expect(deduplicateFwdPrefix("Hello")).toBe("Fwd: Hello");
  });

  test("deduplicates multiple Fwd:", () => {
    expect(deduplicateFwdPrefix("Fwd: Fwd: Hello")).toBe("Fwd: Hello");
  });
});

describe("quoted original formatting", () => {
  test("quotes single line", () => {
    expect(quoteOriginal("Hello")).toBe("> Hello");
  });

  test("quotes multiple lines", () => {
    expect(quoteOriginal("Hello\nWorld")).toBe("> Hello\n> World");
  });

  test("quotes empty lines", () => {
    expect(quoteOriginal("Hello\n\nWorld")).toBe("> Hello\n> \n> World");
  });
});

describe("reply body construction", () => {
  test("builds reply with quoted original", () => {
    const result = buildReplyBody("Thanks!", "Original message");
    expect(result).toBe("Thanks!\n\n> Original message");
  });

  test("builds reply with multi-line original", () => {
    const result = buildReplyBody("Got it", "Line 1\nLine 2");
    expect(result).toBe("Got it\n\n> Line 1\n> Line 2");
  });
});
