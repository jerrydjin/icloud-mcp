// Shared discovery cache for CalDAV/CardDAV resource lists.
//
// CalDAV/CardDAV providers each do a discovery PROPFIND on first call to fetch their
// available resources (calendars, addressbooks, reminder lists). Without a shared
// cache, the verb layer's parallel fan-out (mail + calendar + reminders) re-discovers
// these on every cold start. Per ENG-12, a process-level TTL'd cache means cold
// start pays once; subsequent verb calls reuse the result.
//
// Usage: providers call get(key, ttlSeconds, fetcher). On cache hit (within TTL),
// the cached value returns without invoking fetcher. On miss/expiry, fetcher runs,
// the result is cached, and returned.
//
// Invalidation: on writes (createEvent, createReminder, etc.), providers SHOULD
// call invalidate(key) for the affected resource type so the next read re-discovers.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class DiscoveryCache {
  private store = new Map<string, CacheEntry<unknown>>();

  /**
   * Get a value from cache, or fetch and cache it. Multiple concurrent calls for
   * the same key during a miss share the in-flight fetcher (request coalescing).
   */
  async get<T>(
    key: string,
    ttlSeconds: number,
    fetcher: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expiresAt > now) {
      return entry.value;
    }
    if (entry && entry.value instanceof Promise) {
      // In-flight fetch; await the same promise to avoid duplicate work.
      return entry.value;
    }
    const promise = fetcher();
    this.store.set(key, { value: promise as unknown as T, expiresAt: now + ttlSeconds * 1000 });
    try {
      const value = await promise;
      this.store.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
      return value;
    } catch (err) {
      // Fetch failed: drop the cache entry so the next call retries.
      this.store.delete(key);
      throw err;
    }
  }

  /** Invalidate a single key. Next get() will re-fetch. */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Drop everything (e.g., on full disconnect). */
  clear(): void {
    this.store.clear();
  }

  /** Number of currently-cached entries. Useful for tests. */
  get size(): number {
    return this.store.size;
  }
}

// Standard TTLs for known resource types per ENG-12. Importers use these as
// the second arg to cache.get() so the values are consistent across providers.
export const TTL = {
  calendars: 5 * 60, // 5 minutes
  addressBooks: 10 * 60, // 10 minutes
  reminderLists: 5 * 60, // 5 minutes
} as const;
