import { expect, test } from 'bun:test';
import { freshStore, testDatabaseUrl } from './db';

test('a transaction a timed-out test left open does not hold up the next test', async () => {
  await freshStore();
  // What a test that timed out mid-capture leaves behind: an open transaction holding a lock.
  const leftover = new Bun.SQL(testDatabaseUrl('main'));
  const reserved = await leftover.reserve();
  await reserved`BEGIN`;
  await reserved`LOCK TABLE "archives" IN ROW EXCLUSIVE MODE`;
  const started = Date.now();
  const store = await freshStore();
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(await store.list({ exempt: 'include' })).toEqual([]);
  await leftover.close().catch(() => undefined);
});
