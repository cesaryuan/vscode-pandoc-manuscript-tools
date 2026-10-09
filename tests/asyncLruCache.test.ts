import assert from "node:assert/strict";
import test from "node:test";
import { AsyncLruCache } from "../src/asyncLruCache";

/** Verifies observable reuse follows recency and storage budgets rather than insertion order alone. */
async function evictsLeastRecentlyRequestedWork(): Promise<void> {
  const cache = new AsyncLruCache<string>(2, 30, (value) => value.length);
  let calls = 0;
  /** Makes a cache miss visible through its result, independent of cache internals. */
  const render = async () => String(++calls);
  assert.equal(await cache.getOrCreate("a", render), "1");
  assert.equal(await cache.getOrCreate("b", render), "2");
  assert.equal(await cache.getOrCreate("a", render), "1");
  await cache.getOrCreate("c", render);
  assert.equal(await cache.getOrCreate("b", render), "4");
  // Oversized results are returned to their caller but cannot remain permanently retained.
  await cache.getOrCreate("large", async () => "x".repeat(40));
  assert.equal(await cache.getOrCreate("large", render), "5");
}

/** Eviction during pending work must not let an old failure remove a newer request for that key. */
async function isolatesPendingFailures(): Promise<void> {
  const cache = new AsyncLruCache<string | undefined>(1, 100, (value) => value?.length || 0);
  let rejectOld: (error: Error) => void;
  const old = cache.getOrCreate("a", () => new Promise<string>((_resolve, reject) => { rejectOld = reject; }));
  const rejection = assert.rejects(old, /old failure/);
  await cache.getOrCreate("b", async () => "B");
  await cache.getOrCreate("a", async () => "new A");
  rejectOld!(new Error("old failure"));
  await rejection;
  assert.equal(await cache.getOrCreate("a", async () => "unexpected"), "new A");
  assert.equal(await cache.getOrCreate("missing", async () => undefined), undefined);
  assert.equal(await cache.getOrCreate("missing", async () => "recovered"), "recovered");
}

test("asynchronous cache reuses recent work and releases entries exceeding storage budgets", evictsLeastRecentlyRequestedWork);
test("evicted pending failures cannot invalidate newer cache entries", isolatesPendingFailures);
