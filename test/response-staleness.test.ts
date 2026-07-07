import { describe, expect, test } from "bun:test";
import { enrichResponseStaleness } from "../src/tools/cross.js";
import type {
  MessageSummary,
  SentReplyEntry,
} from "../src/types.js";
import type { ImapProvider } from "../src/providers/imap.js";

// Fake imap shape: only the two methods enrichResponseStaleness reads from.
// We type-cast to ImapProvider to keep the function signature honest without
// needing a full provider stub.
type FakeImap = {
  resolveSentFolderResult?: string | null;
  resolveSentFolderError?: Error;
  searchSentRepliesResult?: SentReplyEntry[];
  searchSentRepliesError?: Error;
  searchCalls: Array<{
    folder: string;
    messageIds: string[];
    sinceDays: number;
  }>;
};

function makeFake(opts: Partial<FakeImap>): ImapProvider {
  const state: FakeImap = {
    searchCalls: [],
    ...opts,
  };
  const fake = {
    async resolveSentFolder(): Promise<string | null> {
      if (state.resolveSentFolderError) throw state.resolveSentFolderError;
      return state.resolveSentFolderResult === undefined
        ? "Sent Messages"
        : state.resolveSentFolderResult;
    },
    async searchSentReplies(
      folder: string,
      messageIds: string[],
      sinceDays: number
    ): Promise<SentReplyEntry[]> {
      state.searchCalls.push({ folder, messageIds, sinceDays });
      if (state.searchSentRepliesError) throw state.searchSentRepliesError;
      return state.searchSentRepliesResult ?? [];
    },
    _state: state,
  } as unknown as ImapProvider & { _state: FakeImap };
  return fake;
}

const makeMsg = (
  partial: Partial<MessageSummary> & { uid: number; messageId: string | null }
): MessageSummary => ({
  uid: partial.uid,
  subject: partial.subject ?? "subj",
  from: partial.from ?? { name: "Jane", address: "jane@example.com" },
  date: partial.date ?? "2026-05-04T15:00:00.000Z",
  flags: partial.flags ?? [],
  hasAttachments: partial.hasAttachments ?? false,
  messageId: partial.messageId,
});

describe("enrichResponseStaleness — empty + skip cases", () => {
  test("empty messages array short-circuits without IMAP calls", async () => {
    const fake = makeFake({});
    const result = await enrichResponseStaleness(
      [],
      fake,
      "me@example.com"
    );
    expect(result.messages).toEqual([]);
    expect(result.replyLookupError).toBeUndefined();
    expect((fake as unknown as { _state: FakeImap })._state.searchCalls).toHaveLength(0);
  });

  test("messages without messageId get null/false default and don't trigger search", async () => {
    const fake = makeFake({});
    const msgs = [makeMsg({ uid: 1, messageId: null })];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]).toMatchObject({
      lastReplyFromYou: null,
      awaitingYourReply: false,
    });
    expect(result.replyLookupError).toBeUndefined();
    expect((fake as unknown as { _state: FakeImap })._state.searchCalls).toHaveLength(0);
  });

  test("self-sent message (sender resolves to me) gets awaitingYourReply: false", async () => {
    const fake = makeFake({});
    const msgs = [
      makeMsg({
        uid: 2,
        messageId: "<self@example.com>",
        from: { name: "Me", address: "me@example.com" },
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]).toMatchObject({
      lastReplyFromYou: null,
      awaitingYourReply: false,
    });
    expect((fake as unknown as { _state: FakeImap })._state.searchCalls).toHaveLength(0);
  });

  test("self-sent uses canonical email comparison (case + alias-insensitive)", async () => {
    const fake = makeFake({});
    const msgs = [
      makeMsg({
        uid: 3,
        messageId: "<x@example.com>",
        from: { name: "Me", address: "ME@Example.COM" },
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]!.awaitingYourReply).toBe(false);
  });
});

describe("enrichResponseStaleness — folder + search errors", () => {
  test("Sent folder undetectable → all messages get null/false + replyLookupError", async () => {
    const fake = makeFake({ resolveSentFolderResult: null });
    const msgs = [
      makeMsg({ uid: 1, messageId: "<a@x.com>" }),
      makeMsg({ uid: 2, messageId: "<b@x.com>" }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.replyLookupError).toBe("Sent folder not found");
    for (const m of result.messages) {
      expect(m.lastReplyFromYou).toBeNull();
      expect(m.awaitingYourReply).toBe(false);
    }
    expect((fake as unknown as { _state: FakeImap })._state.searchCalls).toHaveLength(0);
  });

  test("resolveSentFolder throws → graceful degradation", async () => {
    const fake = makeFake({
      resolveSentFolderError: new Error("LIST timeout"),
    });
    const msgs = [makeMsg({ uid: 1, messageId: "<a@x.com>" })];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.replyLookupError).toContain("Sent folder lookup failed");
    expect(result.replyLookupError).toContain("LIST timeout");
    expect(result.messages[0]!.awaitingYourReply).toBe(false);
  });

  test("searchSentReplies throws → graceful degradation", async () => {
    const fake = makeFake({
      searchSentRepliesError: new Error("SEARCH rejected: too many OR"),
    });
    const msgs = [makeMsg({ uid: 1, messageId: "<a@x.com>" })];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.replyLookupError).toContain("Sent folder search failed");
    expect(result.replyLookupError).toContain("too many OR");
    expect(result.messages[0]!.awaitingYourReply).toBe(false);
  });
});

describe("enrichResponseStaleness — happy paths (the actual feature)", () => {
  test("never replied → lastReplyFromYou=null, awaitingYourReply=true", async () => {
    const fake = makeFake({ searchSentRepliesResult: [] });
    const msgs = [
      makeMsg({
        uid: 1,
        messageId: "<unanswered@x.com>",
        date: "2026-05-01T10:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]).toMatchObject({
      lastReplyFromYou: null,
      awaitingYourReply: true,
    });
  });

  test("matched via In-Reply-To, my reply newer → not awaiting", async () => {
    const fake = makeFake({
      searchSentRepliesResult: [
        {
          messageId: "<my-reply@me.com>",
          inReplyTo: "<inbound@x.com>",
          references: [],
          date: "2026-05-02T12:00:00.000Z",
        },
      ],
    });
    const msgs = [
      makeMsg({
        uid: 1,
        messageId: "<inbound@x.com>",
        date: "2026-05-01T10:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]).toMatchObject({
      lastReplyFromYou: "2026-05-02T12:00:00.000Z",
      awaitingYourReply: false,
    });
  });

  test("matched via References (multi-id thread) → joins on any id in list", async () => {
    const fake = makeFake({
      searchSentRepliesResult: [
        {
          messageId: "<my-reply@me.com>",
          inReplyTo: "<other@x.com>",
          references: ["<root@x.com>", "<inbound@x.com>"],
          date: "2026-05-02T12:00:00.000Z",
        },
      ],
    });
    const msgs = [
      makeMsg({
        uid: 1,
        messageId: "<inbound@x.com>",
        date: "2026-05-01T10:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]!.lastReplyFromYou).toBe(
      "2026-05-02T12:00:00.000Z"
    );
    expect(result.messages[0]!.awaitingYourReply).toBe(false);
  });

  test("inbound newer than my reply → awaiting your reply (they wrote back)", async () => {
    const fake = makeFake({
      searchSentRepliesResult: [
        {
          messageId: "<old-reply@me.com>",
          inReplyTo: "<inbound@x.com>",
          references: [],
          date: "2026-04-15T08:00:00.000Z",
        },
      ],
    });
    const msgs = [
      makeMsg({
        uid: 1,
        messageId: "<inbound@x.com>",
        date: "2026-05-01T10:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]).toMatchObject({
      lastReplyFromYou: "2026-04-15T08:00:00.000Z",
      awaitingYourReply: true,
    });
  });

  test("multiple matches → picks latest by date", async () => {
    const fake = makeFake({
      searchSentRepliesResult: [
        {
          messageId: "<r1@me.com>",
          inReplyTo: "<inbound@x.com>",
          references: [],
          date: "2026-04-30T10:00:00.000Z",
        },
        {
          messageId: "<r2@me.com>",
          inReplyTo: "<inbound@x.com>",
          references: [],
          date: "2026-05-02T11:00:00.000Z",
        },
        {
          messageId: "<r3@me.com>",
          inReplyTo: "<inbound@x.com>",
          references: [],
          date: "2026-05-01T09:00:00.000Z",
        },
      ],
    });
    const msgs = [
      makeMsg({
        uid: 1,
        messageId: "<inbound@x.com>",
        date: "2026-04-29T08:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]!.lastReplyFromYou).toBe(
      "2026-05-02T11:00:00.000Z"
    );
    expect(result.messages[0]!.awaitingYourReply).toBe(false);
  });

  test("mix of self-sent + inbound with reply + inbound never-replied", async () => {
    const fake = makeFake({
      searchSentRepliesResult: [
        {
          messageId: "<reply@me.com>",
          inReplyTo: "<answered@x.com>",
          references: [],
          date: "2026-05-02T12:00:00.000Z",
        },
      ],
    });
    const msgs: MessageSummary[] = [
      makeMsg({
        uid: 1,
        messageId: "<self@x.com>",
        from: { name: "Me", address: "me@example.com" },
        date: "2026-05-01T08:00:00.000Z",
      }),
      makeMsg({
        uid: 2,
        messageId: "<answered@x.com>",
        date: "2026-05-01T10:00:00.000Z",
      }),
      makeMsg({
        uid: 3,
        messageId: "<unanswered@x.com>",
        date: "2026-05-01T11:00:00.000Z",
      }),
    ];
    const result = await enrichResponseStaleness(
      msgs,
      fake,
      "me@example.com"
    );
    expect(result.messages[0]!.awaitingYourReply).toBe(false); // self-sent
    expect(result.messages[1]).toMatchObject({
      lastReplyFromYou: "2026-05-02T12:00:00.000Z",
      awaitingYourReply: false,
    });
    expect(result.messages[2]).toMatchObject({
      lastReplyFromYou: null,
      awaitingYourReply: true,
    });

    // Only candidates (uid 2 + uid 3) get queried; self-sent is filtered out.
    const calls = (fake as unknown as { _state: FakeImap })._state.searchCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messageIds).toEqual([
      "<answered@x.com>",
      "<unanswered@x.com>",
    ]);
    expect(calls[0]!.sinceDays).toBe(90);
  });

  test("custom sinceDays propagates to the search call", async () => {
    const fake = makeFake({});
    const msgs = [makeMsg({ uid: 1, messageId: "<x@y.com>" })];
    await enrichResponseStaleness(msgs, fake, "me@example.com", 30);
    const calls = (fake as unknown as { _state: FakeImap })._state.searchCalls;
    expect(calls[0]!.sinceDays).toBe(30);
  });
});
