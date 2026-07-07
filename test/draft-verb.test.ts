import { describe, expect, test } from "bun:test";
import { draftHandler, looksLikeEmail } from "../src/verbs/draft.js";
import type { VerbContext } from "../src/verbs/types.js";
import type { MessageFull } from "../src/types.js";

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

// ── Edit-mode tests for draftHandler ──
//
// Patch semantics: editUid loads the existing draft, fields the caller passes
// override, the rest are kept. After append the old UID is moved to Trash.

interface AppendCall {
  folder: string;
  flags: string[] | undefined;
  raw: Buffer;
}

function makeCtx(existing: MessageFull | null): {
  ctx: VerbContext;
  appends: AppendCall[];
  deletes: { uid: number; folder: string }[];
  buildArgs: Record<string, unknown>[];
} {
  const appends: AppendCall[] = [];
  const deletes: { uid: number; folder: string }[] = [];
  const buildArgs: Record<string, unknown>[] = [];

  const ctx = {
    imap: {
      fetchAndParseMessage: async (uid: number, folder: string) => {
        if (!existing || existing.uid !== uid || folder !== "Drafts") {
          throw new Error(`Message UID ${uid} not found in folder ${folder}`);
        }
        return existing;
      },
      append: async (folder: string, raw: Buffer, flags?: string[]) => {
        appends.push({ folder, raw, flags });
        return { uid: 999 };
      },
      deleteMessage: async (uid: number, folder: string) => {
        deletes.push({ uid, folder });
      },
    },
    smtp: {
      buildRawMessage: async (opts: Record<string, unknown>) => {
        buildArgs.push(opts);
        return Buffer.from("raw");
      },
    },
    identityResolver: {
      // Pass-through resolver: emails return as-is, names fail to resolve.
      // Edit-mode tests don't exercise contact lookup; we just need the
      // shape so the verb can call it.
      resolveIdentity: async (input: string) => {
        if (looksLikeEmail(input)) {
          return {
            identity: {
              canonical: input.toLowerCase(),
              displayName: input,
            },
          };
        }
        return { unresolvedReason: "no_match" };
      },
    },
    // Unused by draftHandler but required by the type
    caldav: {} as never,
    reminders: {} as never,
    contacts: {} as never,
    email: "me@icloud.com",
  } as unknown as VerbContext;

  return { ctx, appends, deletes, buildArgs };
}

function makeExistingDraft(overrides: Partial<MessageFull> = {}): MessageFull {
  return {
    uid: 42,
    subject: "Original Subject",
    from: { name: "Me", address: "me@icloud.com" },
    to: [{ name: "", address: "alice@example.com" }],
    cc: [],
    bcc: [],
    date: "2026-04-30T00:00:00.000Z",
    textBody: "Original body",
    truncated: false,
    attachments: [],
    messageId: "<orig@icloud.com>",
    ...overrides,
  };
}

describe("draftHandler edit mode", () => {
  test("patches body only, preserves recipients and subject", async () => {
    const existing = makeExistingDraft();
    const { ctx, appends, deletes, buildArgs } = makeCtx(existing);

    const result = await draftHandler(
      { editUid: 42, body: "Updated body" },
      ctx
    );

    expect(result.items.success).toBe(true);
    expect(result.items.draftUid).toBe(999);
    expect(result.items.replacedUid).toBe(42);
    expect(result.items.to).toEqual(["alice@example.com"]);
    expect(buildArgs[0]?.subject).toBe("Original Subject");
    expect(buildArgs[0]?.body).toBe("Updated body");
    expect(buildArgs[0]?.to).toEqual(["alice@example.com"]);
    expect(appends).toHaveLength(1);
    expect(appends[0]?.folder).toBe("Drafts");
    expect(appends[0]?.flags).toEqual(["\\Draft", "\\Seen"]);
    expect(deletes).toEqual([{ uid: 42, folder: "Drafts" }]);
  });

  test("replaces recipients when `to` is passed", async () => {
    const existing = makeExistingDraft();
    const { ctx, buildArgs } = makeCtx(existing);

    const result = await draftHandler(
      { editUid: 42, to: ["bob@example.com"] },
      ctx
    );

    expect(result.items.success).toBe(true);
    expect(result.items.to).toEqual(["bob@example.com"]);
    expect(buildArgs[0]?.to).toEqual(["bob@example.com"]);
    // subject + body preserved
    expect(buildArgs[0]?.subject).toBe("Original Subject");
    expect(buildArgs[0]?.body).toBe("Original body");
  });

  test("unresolved recipient blocks edit and does not delete the old draft", async () => {
    const existing = makeExistingDraft();
    const { ctx, appends, deletes } = makeCtx(existing);

    const result = await draftHandler(
      { editUid: 42, to: ["Some Unknown Person"] },
      ctx
    );

    expect(result.items.success).toBe(false);
    expect(result.items.unresolved).toHaveLength(1);
    expect(result.items.unresolved[0]?.input).toBe("Some Unknown Person");
    expect(appends).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  test("missing draft UID throws (caller sees a tool error)", async () => {
    const { ctx } = makeCtx(null);
    await expect(
      draftHandler({ editUid: 999, body: "x" }, ctx)
    ).rejects.toThrow(/UID 999/);
  });

  test("delete failure is non-fatal, surfaces as degraded", async () => {
    const existing = makeExistingDraft();
    const { ctx } = makeCtx(existing);
    // Override deleteMessage to fail
    (ctx.imap as unknown as { deleteMessage: (u: number, f: string) => Promise<void> }).deleteMessage =
      async () => {
        throw new Error("IMAP delete failed");
      };

    const result = await draftHandler(
      { editUid: 42, body: "Updated" },
      ctx
    );

    expect(result.items.success).toBe(true);
    expect(result.items.draftUid).toBe(999);
    expect(result.items.replacedUid).toBeUndefined();
    expect(result.degraded).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source).toBe("mail");
    expect(result.errors[0]?.message).toMatch(/IMAP delete failed/);
  });

  test("clearing cc with [] removes existing cc from the patched draft", async () => {
    const existing = makeExistingDraft({
      cc: [{ name: "", address: "carol@example.com" }],
    });
    const { ctx, buildArgs } = makeCtx(existing);

    await draftHandler({ editUid: 42, cc: [] }, ctx);

    expect(buildArgs[0]?.cc).toBeUndefined();
  });
});

describe("draftHandler create mode validation", () => {
  test("missing `to` throws", async () => {
    const { ctx } = makeCtx(null);
    await expect(
      draftHandler({ subject: "s", body: "b" }, ctx)
    ).rejects.toThrow(/`to` is required/);
  });

  test("missing `subject` throws", async () => {
    const { ctx } = makeCtx(null);
    await expect(
      draftHandler({ to: ["x@example.com"], body: "b" }, ctx)
    ).rejects.toThrow(/`subject` is required/);
  });

  test("missing `body` throws", async () => {
    const { ctx } = makeCtx(null);
    await expect(
      draftHandler({ to: ["x@example.com"], subject: "s" }, ctx)
    ).rejects.toThrow(/`body` is required/);
  });
});
