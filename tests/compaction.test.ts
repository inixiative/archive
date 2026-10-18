import { expect, test } from 'bun:test';
import { publishArchive } from '../src/client';
import { type ArchiveDestination, destinationIdentity } from '../src/config';
import {
  type ArchiveSnapshot,
  archiveSnapshotSchema,
  chunkArchive,
  snapshotDigest,
} from '../src/index';
import { createArchiveHandler } from '../src/server';
import type { ArchiveStore } from '../src/store';
import { TOOL_ACTIVITY_OMISSION } from '../src/tool-activity';
import { freshStore } from './db';
import { routing } from './routing';

const token = 'synthetic-archive-test-token-0000000000';
const entry = (id: string, kind: ArchiveSnapshot['entries'][number]['kind'], text: string) => ({
  id,
  kind,
  text,
  timestamp: 1,
  sourceRef: `line:${id}`,
});
const session = (entries: ReturnType<typeof entry>[], capturedAt = 1) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'codex',
    sessionId: 'growing',
    title: 'Compaction',
    projectId: 'inixiative',
    tags: [],
    capturedAt,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries,
  });
const turns = [
  entry('u1', 'user', 'Find the migration that adds storage '.repeat(40)),
  entry('c1', 'tool-call', 'grep -r migration prisma '.repeat(40)),
  entry('r1', 'tool-result', 'prisma/migrations/20261001022030_init '.repeat(400)),
  entry('a1', 'assistant', 'The init migration adds the tables '.repeat(40)),
];
const revisions = (store: ArchiveStore, id: string) =>
  store.db.revision.findMany({
    where: { archiveId: id },
    select: { revision: true },
    orderBy: { revision: 'asc' },
  });
const chunkKinds = async (store: ArchiveStore, id: string) =>
  [
    ...new Set(
      (await store.db.chunk.findMany({ where: { archiveId: id }, select: { kind: true } })).map(
        (c) => c.kind,
      ),
    ),
  ].sort();
const request = (action: string, body: unknown) =>
  new Request(`http://localhost/api/v1/archive/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const searchIndexValid = async (store: ArchiveStore) => {
  const [row] = await store.db.$queryRaw<{ valid: boolean }[]>`
    SELECT i."indisvalid" AS "valid" FROM pg_index i JOIN pg_class c ON c."oid" = i."indexrelid"
    WHERE c."relname" = 'chunks_text_idx'`;
  return row?.valid;
};

test('a capture keeps only the current revision; one awaiting delivery stays until delivered', async () => {
  const store = await freshStore();
  const first = await store.capture(session(turns.slice(0, 1)));
  await store.capture(session(turns.slice(0, 2), 2));
  expect(await revisions(store, first.id)).toEqual([{ revision: 2 }]);
  const handler = createArchiveHandler(store, token);
  const gone = await handler(request('read', { archiveId: first.id, revision: 1 }));
  expect(gone.status).toBe(410);
  expect(((await gone.json()) as { error: string }).error).toContain('was compacted');
  expect((await handler(request('read', { archiveId: first.id, revision: 9 }))).status).toBe(404);

  // Revision 2 is queued for a destination, so the next capture leaves it in place.
  await store.enqueue(first.id, 'destination', { revision: 2 });
  await store.capture(session(turns.slice(0, 3), 3));
  expect(await revisions(store, first.id)).toEqual([{ revision: 2 }, { revision: 3 }]);
  expect(await store.compact()).toBe(0);
  expect((await store.read(first.id, 2))?.snapshot.entries).toHaveLength(2);
  expect((await store.maintenanceStatus()).revisionsAwaitingDelivery).toBe(1);
  await store.delivered(first.id, 'destination', (await store.read(first.id, 2))!.digest);
  expect(await revisions(store, first.id)).toEqual([{ revision: 3 }]);
  // Revision numbers keep counting; head and the writer's digest are untouched by compaction.
  expect(await store.head(first.id)).toMatchObject({
    revision: 3,
    digest: snapshotDigest(session(turns.slice(0, 3), 3)),
  });
});

test('compact removes the revisions earlier versions kept, one statement per revision', async () => {
  const store = await freshStore();
  const first = await store.capture(session(turns.slice(0, 1)));
  // Earlier versions kept every revision: hold each with an outbox row, then release them all.
  for (let n = 2; n <= 4; n++) {
    await store.enqueue(first.id, `destination-${n}`, { revision: n - 1 });
    await store.capture(session(turns.slice(0, n), n));
  }
  await store.db.outbox.deleteMany({ where: { archiveId: first.id } });
  expect(await revisions(store, first.id)).toHaveLength(4);
  expect((await store.maintenanceStatus()).supersededRevisions).toBe(3);
  expect(await store.compact()).toBe(3);
  expect(await revisions(store, first.id)).toEqual([{ revision: 4 }]);
  expect(await store.db.chunk.count({ where: { archiveId: first.id, revision: { lt: 4 } } })).toBe(
    0,
  );
  const search = (await store.matching([first.id], 'migration')).has(first.id);
  expect(search).toBe(true);
});

test('a publish whose queued revision was compacted before sending queues the current one', async () => {
  const store = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_COMPACTION_TEST_TOKEN = token;
  try {
    const first = await store.capture(session(turns.slice(0, 1)));
    const destination: ArchiveDestination = {
      kind: 'archive',
      organizationId: 'inixiative',
      url: 'http://localhost:4412/',
      tokenEnv: 'ARCHIVE_COMPACTION_TEST_TOKEN',
    };
    // The race: the outbox row names revision 1 after a capture already compacted it.
    await store.capture(session(turns.slice(0, 2), 2));
    await store.db.outbox.create({
      data: { archiveId: first.id, destination: destinationIdentity(destination), revision: 1 },
    });
    const handler = createArchiveHandler(remote, token);
    await publishArchive(store, first.id, destination, routing([destination]), ((
      url: string,
      options: RequestInit,
    ) => handler(new Request(url, options))) as unknown as typeof fetch);
    expect((await remote.read(first.id))?.snapshot.entries).toHaveLength(2);
    expect(await store.pending(first.id, destinationIdentity(destination))).toBeNull();
  } finally {
    delete process.env.ARCHIVE_COMPACTION_TEST_TOKEN;
  }
});

test('with tool capture off, ingest stores no tool calls or results, and an unchanged session stays unchanged', async () => {
  const store = await freshStore();
  expect((await store.settings()).captureToolCallsAndResults).toBe(true);
  await store.updateSettings({ captureToolCallsAndResults: false });
  const sent = session(turns);
  const first = await store.capture(sent);
  const stored = (await store.read(first.id))!;
  expect(stored.snapshot.entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
  expect(stored.snapshot.coverage).toMatchObject({
    completeness: 'partial',
    omissions: [TOOL_ACTIVITY_OMISSION],
  });
  expect(await chunkKinds(store, first.id)).toEqual(['assistant', 'user']);
  expect(stored.digest).toBe(snapshotDigest(stored.snapshot));
  // The writer's digest is what head reports, so a collector sees its unchanged file as unchanged.
  expect(first.digest).toBe(snapshotDigest(sent));
  expect((await store.head(first.id))?.digest).toBe(snapshotDigest(sent));
  expect((await store.capture({ ...sent, capturedAt: 2 })).changed).toBe(false);
  expect((await store.list({ exempt: 'include' })).find((a) => a.id === first.id)?.entries).toBe(2);

  // Only tool activity moved: the writer's digest advances, the stored revision does not.
  const moreTools = session([...turns, entry('r2', 'tool-result', 'more output')], 3);
  const absorbed = await store.capture(moreTools, { previousDigest: first.digest });
  expect(absorbed).toMatchObject({
    changed: false,
    revision: 1,
    digest: snapshotDigest(moreTools),
  });
  expect((await store.head(first.id))?.digest).toBe(snapshotDigest(moreTools));
  expect(
    store.capture({ ...moreTools, capturedAt: 4 }, { previousDigest: first.digest }),
  ).resolves.toMatchObject({ changed: false });

  // Over HTTP too: whatever writes the snapshot, the server filters it.
  const handler = createArchiveHandler(store, token);
  const other = { ...session(turns, 5), sessionId: 'other' };
  const response = await handler(request('ingest', { snapshot: other, previousDigest: null }));
  const { data } = (await response.json()) as { data: { id: string; digest: string } };
  expect(data.digest).toBe(snapshotDigest(archiveSnapshotSchema.parse(other)));
  expect(await chunkKinds(store, data.id)).toEqual(['assistant', 'user']);
});

test('archives with different tool settings publish to each other and then stay unchanged', async () => {
  const local = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_COMPACTION_TEST_TOKEN = token;
  const destination: ArchiveDestination = {
    kind: 'archive',
    organizationId: 'inixiative',
    url: 'http://localhost:4413/',
    tokenEnv: 'ARCHIVE_COMPACTION_TEST_TOKEN',
  };
  const transport = (store: ArchiveStore) => {
    const handler = createArchiveHandler(store, token);
    return ((url: string, options: RequestInit) =>
      handler(new Request(url, options))) as unknown as typeof fetch;
  };
  try {
    // Local keeps tool activity, the destination does not.
    await remote.updateSettings({ captureToolCallsAndResults: false });
    const first = await local.capture(session(turns));
    expect(
      await publishArchive(local, first.id, destination, routing([destination]), transport(remote)),
    ).toEqual({
      unchanged: false,
    });
    expect(await chunkKinds(remote, first.id)).toEqual(['assistant', 'user']);
    expect(
      await publishArchive(local, first.id, destination, routing([destination]), transport(remote)),
    ).toEqual({
      unchanged: true,
    });
    await local.capture(session([...turns, entry('a2', 'assistant', 'Done')], 2));
    await publishArchive(local, first.id, destination, routing([destination]), transport(remote));
    expect((await remote.read(first.id))?.snapshot.entries.map((e) => e.id)).toEqual([
      'u1',
      'a1',
      'a2',
    ]);
    expect(
      await local.delivery(
        (await local.list({ exempt: 'include' })).map((a) => a.id),
        destinationIdentity(destination),
      ),
    ).toEqual({
      delivered: 1,
      pending: 0,
    });

    // The other way round: a filtered local Archive publishes what it stored.
    await local.updateSettings({ captureToolCallsAndResults: false });
    await remote.updateSettings({ captureToolCallsAndResults: true });
    const second = await local.capture({ ...session(turns, 3), sessionId: 'second' });
    await publishArchive(local, second.id, destination, routing([destination]), transport(remote));
    expect(await chunkKinds(remote, second.id)).toEqual(['assistant', 'user']);
    expect(
      await publishArchive(
        local,
        second.id,
        destination,
        routing([destination]),
        transport(remote),
      ),
    ).toEqual({
      unchanged: true,
    });
    expect(
      await local.delivery(
        (await local.list({ exempt: 'include' })).map((a) => a.id),
        destinationIdentity(destination),
      ),
    ).toEqual({
      delivered: 2,
      pending: 0,
    });
  } finally {
    delete process.env.ARCHIVE_COMPACTION_TEST_TOKEN;
  }
});

test('turning tool capture off removes the tool activity already held, batched and resumable', async () => {
  const store = await freshStore();
  const ids: string[] = [];
  for (let n = 0; n < 60; n++)
    ids.push((await store.capture({ ...session(turns, n + 1), sessionId: `held-${n}` })).id);
  const plain = await store.capture({
    ...session(turns.filter((e) => e.kind === 'user')),
    sessionId: 'no-tools',
  });
  const before = (await store.head(ids[0]!))!;
  expect(await store.removePastToolActivity()).toBe(0);

  await store.updateSettings({ captureToolCallsAndResults: false });
  expect((await store.maintenanceStatus()).toolActivitySweepPending).toBe(true);
  await store.maintain();
  const status = await store.maintenanceStatus();
  expect(status).toMatchObject({ toolActivitySweepPending: false, supersededRevisions: 0 });
  for (const id of ids) {
    expect(await revisions(store, id)).toEqual([{ revision: 2 }]);
    expect(await chunkKinds(store, id)).toEqual(['assistant', 'user']);
  }
  const after = (await store.head(ids[0]!))!;
  expect(after.digest).toBe(before.digest);
  expect(after.storedDigest).not.toBe(before.storedDigest);
  const stored = (await store.read(ids[0]!))!;
  // The copied chunks are exactly the stripped snapshot's chunks, positions dense.
  expect(stored.chunks.map((c) => c.id)).toEqual(chunkArchive(stored.snapshot).map((c) => c.id));
  expect(
    (
      await store.db.chunk.findMany({ where: { archiveId: ids[0]! }, orderBy: { position: 'asc' } })
    ).map((c) => c.position),
  ).toEqual(stored.chunks.map((_, i) => i));
  expect(stored.digest).toBe(after.storedDigest);
  expect(await revisions(store, plain.id)).toEqual([{ revision: 1 }]);
  // The writer's next capture of the unchanged file is still unchanged.
  expect((await store.capture({ ...session(turns, 99), sessionId: 'held-0' })).changed).toBe(false);

  // Turning it back on stops the sweep; new captures keep tool activity again.
  await store.updateSettings({ captureToolCallsAndResults: true });
  const kept = await store.capture({ ...session(turns), sessionId: 'kept' });
  await store.maintain();
  expect(await chunkKinds(store, kept.id)).toEqual([
    'assistant',
    'tool-call',
    'tool-result',
    'user',
  ]);
});

test('a sweep that stopped resumes after the last archive it finished', async () => {
  const store = await freshStore();
  for (let n = 0; n < 3; n++) await store.capture({ ...session(turns), sessionId: `s-${n}` });
  await store.updateSettings({ captureToolCallsAndResults: false });
  const rows = await store.db.archive.findMany({
    orderBy: { seq: 'asc' },
    select: { id: true, seq: true },
  });
  // As if a run stopped after the first archive.
  await store.db.setting.update({
    where: { key: 'toolActivitySweep' },
    data: { value: { afterSeq: rows[0]!.seq.toString() } },
  });
  expect(await store.removePastToolActivity()).toBe(2);
  expect(await chunkKinds(store, rows[0]!.id)).toContain('tool-result');
  expect(await chunkKinds(store, rows[2]!.id)).toEqual(['assistant', 'user']);
});

test('the search index is rebuilt once compaction is done, and reclaim rewrites the tables', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  const first = await store.capture(session(turns.slice(0, 1)));
  await store.enqueue(first.id, 'destination', { revision: 1 });
  await store.capture(session(turns, 2));
  await store.db.outbox.deleteMany({});
  // An operator short of disk dropped the index before compaction.
  await store.db.$executeRawUnsafe('DROP INDEX IF EXISTS "chunks_text_idx"');
  expect(await store.ensureSearchIndex()).toBe(false);
  expect((await handler(request('maintenance/reclaim', {}))).status).toBe(409);
  await store.maintain();
  expect(await searchIndexValid(store)).toBe(true);

  const started = await handler(request('maintenance/reclaim', {}));
  expect(started.status).toBe(200);
  for (let i = 0; store.reclaiming.state === 'running' && i < 600; i++) await Bun.sleep(50);
  const status = (await (await handler(request('maintenance/status', {}))).json()) as {
    data: { reclaim: { state: string; last?: { afterBytes?: number; error?: string } } };
  };
  expect(status.data.reclaim.state).toBe('idle');
  expect(status.data.reclaim.last?.error).toBeUndefined();
  expect(status.data.reclaim.last?.afterBytes).toBeGreaterThan(0);
  expect(await searchIndexValid(store)).toBe(true);
  expect((await store.matching([first.id], 'migration')).has(first.id)).toBe(true);
});

test('maintenance and reclaim never overlap, and a search index build in progress is left alone', async () => {
  const store = await freshStore();
  await store.capture(session(turns));
  const url = new URL(
    process.env.ARCHIVE_TEST_DATABASE_URL ??
      'postgresql://archive:archive@127.0.0.1:6132/archive_test',
  );
  url.pathname = `${url.pathname}_main`;
  const holder = new Bun.SQL(url.href, { max: 1 });
  const builder = new Bun.SQL(url.href, { max: 1 });
  const reserved = await holder.reserve();
  try {
    // A maintenance run in progress refuses a reclaim.
    const running = store.maintain();
    expect(store.reclaim()).rejects.toThrow('Maintenance or a reclaim is running');
    await running;

    // A reclaim in progress makes maintenance a no-op. An open transaction that has read chunks
    // holds the reclaim at its first step (dropping the index concurrently waits for it), while
    // captures go on.
    await reserved`BEGIN`;
    await reserved`SELECT count(*) FROM "chunks"`;
    await store.reclaim();
    expect(store.reclaiming.state).toBe('running');
    // A second reclaim is refused at once, before anything is awaited.
    expect(store.reclaim()).rejects.toThrow('Maintenance or a reclaim is running');
    const held = await store.capture({ ...session(turns.slice(0, 1)), sessionId: 'held' });
    await store.enqueue(held.id, 'destination', { revision: 1 });
    await store.capture({ ...session(turns.slice(0, 2), 2), sessionId: 'held' });
    await store.db.outbox.deleteMany({});
    await store.maintain();
    // Still held, however fast VACUUM FULL would be on this small database.
    await Bun.sleep(500);
    expect(store.reclaiming.state).toBe('running');
    expect((await store.maintenanceStatus()).supersededRevisions).toBe(1);
    await reserved`COMMIT`;
    for (let i = 0; store.reclaiming.state === 'running' && i < 600; i++) await Bun.sleep(50);
    expect(store.reclaiming.last?.error).toBeUndefined();
    await store.maintain();
    expect((await store.maintenanceStatus()).supersededRevisions).toBe(0);
    expect(await searchIndexValid(store)).toBe(true);

    // A concurrent build waits on an old snapshot, leaving an invalid index while it is in progress.
    await store.db.$executeRawUnsafe('DROP INDEX IF EXISTS "chunks_text_idx"');
    await reserved`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await reserved`SELECT count(*) FROM "chunks"`;
    // Bun's queries run when awaited: start the build now, without waiting for it.
    const build = (async () =>
      await builder.unsafe(
        'CREATE INDEX CONCURRENTLY "chunks_text_idx" ON "chunks" USING GIN ("text" gin_trgm_ops)',
      ))();
    for (let i = 0; (await searchIndexValid(store)) === undefined && i < 200; i++)
      await Bun.sleep(50);
    expect(await searchIndexValid(store)).toBe(false);
    expect(await store.ensureSearchIndex()).toBe(false);
    expect(await searchIndexValid(store)).toBe(false);
    await reserved`COMMIT`;
    await build;
    expect(await searchIndexValid(store)).toBe(true);
  } finally {
    await reserved`ROLLBACK`.catch(() => {});
    reserved.release();
    await holder.close();
    await builder.close();
  }
}, 60_000);
