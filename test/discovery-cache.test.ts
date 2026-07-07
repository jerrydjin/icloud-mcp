import { describe, expect, test } from "bun:test";
import { DiscoveryCache, TTL } from "../src/providers/discovery-cache.js";

describe("DiscoveryCache", () => {
  test("caches a fresh fetch and reuses on second call", async () => {
    const cache = new DiscoveryCache();
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return ["a", "b"];
    };

    const r1 = await cache.get("calendars", 60, fetcher);
    const r2 = await cache.get("calendars", 60, fetcher);
    expect(r1).toEqual(["a", "b"]);
    expect(r2).toEqual(["a", "b"]);
    expect(fetchCount).toBe(1);
  });

  test("re-fetches after TTL expires", async () => {
    const cache = new DiscoveryCache();
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return fetchCount;
    };

    // TTL of 0 means already expired on next read
    await cache.get("k", 0, fetcher);
    // Wait a tick to ensure Date.now() advances at least 1ms
    await new Promise((r) => setTimeout(r, 5));
    await cache.get("k", 0, fetcher);
    expect(fetchCount).toBe(2);
  });

  test("invalidate forces re-fetch on next call", async () => {
    const cache = new DiscoveryCache();
    let fetchCount = 0;
    const fetcher = async () => ++fetchCount;

    await cache.get("k", 60, fetcher);
    cache.invalidate("k");
    await cache.get("k", 60, fetcher);
    expect(fetchCount).toBe(2);
  });

  test("clear drops everything", async () => {
    const cache = new DiscoveryCache();
    await cache.get("a", 60, async () => 1);
    await cache.get("b", 60, async () => 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("different keys don't collide", async () => {
    const cache = new DiscoveryCache();
    const r1 = await cache.get("calendars", 60, async () => "cal-data");
    const r2 = await cache.get("addressBooks", 60, async () => "ab-data");
    expect(r1).toBe("cal-data");
    expect(r2).toBe("ab-data");
  });

  test("fetcher error drops the cache entry (next call retries)", async () => {
    const cache = new DiscoveryCache();
    let attempt = 0;
    const fetcher = async () => {
      attempt++;
      if (attempt === 1) throw new Error("first attempt fails");
      return "success";
    };

    await expect(cache.get("k", 60, fetcher)).rejects.toThrow("first attempt fails");
    const r2 = await cache.get("k", 60, fetcher);
    expect(r2).toBe("success");
  });

  test("concurrent calls during in-flight fetch share the same fetcher", async () => {
    const cache = new DiscoveryCache();
    let fetchCount = 0;
    let resolveFetcher: ((value: string) => void) | undefined;
    const fetcher = async () => {
      fetchCount++;
      return new Promise<string>((res) => {
        resolveFetcher = res;
      });
    };

    const p1 = cache.get("k", 60, fetcher);
    const p2 = cache.get("k", 60, fetcher);
    // Both promises kicked off; only one fetcher should have run
    expect(fetchCount).toBe(1);
    resolveFetcher!("done");
    expect(await p1).toBe("done");
    expect(await p2).toBe("done");
  });

  test("TTL constants match ENG-12 decision", () => {
    expect(TTL.calendars).toBe(300);
    expect(TTL.addressBooks).toBe(600);
    expect(TTL.reminderLists).toBe(300);
  });
});
