import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCli } from '../src/cli';
import {
  publishArchive,
  routingPreview,
  type SyncBackoff,
  searchRemotes,
  syncArchives,
} from '../src/client';
import {
  type ArchiveDestination,
  connectDestination,
  destinationIdentity,
  destinationsFile,
  readRouting,
} from '../src/config';
import { archiveKey, archiveSnapshotSchema } from '../src/index';
import { verifyKingdomDestination } from '../src/kingdom';
import { createArchiveHandler, startArchiveServer } from '../src/server';
import { ArchiveStore } from '../src/store';
import { freshStore, testDatabaseUrl } from './db';
import { signetKingdom } from './kingdom';
import { routeWhole, routing } from './routing';

const captureResponse = z.object({
  data: z.object({ id: z.string(), digest: z.string(), revision: z.number() }),
});
const readResponse = z.object({ data: z.object({ snapshot: archiveSnapshotSchema }) });
const searchResponse = z.object({
  data: z.object({
    archives: z.array(z.object({ tokenCount: z.number() })),
    tokenCount: z.number(),
  }),
});

const token = 'synthetic-archive-test-token-0000000000';
const snapshot = (projectId = 'inixiative', sessionId = 'one') =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'codex',
    sessionId,
    title: 'Routing test',
    projectId,
    tags: ['personal', 'userevidence'],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [
      {
        id: 'one',
        kind: 'user',
        text: 'Fix regression privacy docs '.repeat(80),
        timestamp: 1,
        sourceRef: 'line:1',
      },
    ],
  });
const request = (action: string, body: unknown, auth = token) =>
  new Request(`http://localhost/api/v1/archive/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });

test('hosted auth, compacted revisions, concurrent-write conflicts and bounded search', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  try {
    expect((await handler(request('search', {}, 'wrong'))).status).toBe(401);
    const s = snapshot();
    const first = captureResponse.parse(
      await (await handler(request('ingest', { snapshot: s, previousDigest: null }))).json(),
    );
    expect(first.data.revision).toBe(1);
    expect(
      (
        await handler(
          request('ingest', {
            snapshot: { ...s, title: 'Edit', capturedAt: 2 },
            previousDigest: null,
          }),
        )
      ).status,
    ).toBe(409);
    const changed = await handler(
      request('ingest', {
        snapshot: { ...s, title: 'Edit', capturedAt: 2 },
        previousDigest: first.data.digest,
      }),
    );
    expect(captureResponse.parse(await changed.json()).data.revision).toBe(2);
    expect(
      (
        await handler(
          request('ingest', {
            snapshot: { ...s, title: 'Edit', capturedAt: 2 },
            previousDigest: first.data.digest,
          }),
        )
      ).status,
    ).toBe(200);
    // Only the current revision is kept: an earlier one is gone, not unknown.
    expect((await handler(request('read', { archiveId: first.data.id, revision: 1 }))).status).toBe(
      410,
    );
    expect(
      readResponse.parse(
        await (await handler(request('read', { archiveId: first.data.id, revision: 2 }))).json(),
      ).data.snapshot.title,
    ).toBe('Edit');
    await handler(
      request('ingest', { snapshot: snapshot('inixiative', 'two'), previousDigest: null }),
    );
    const found = searchResponse.parse(
      await (await handler(request('search', { query: 'privacy', budget: 32 }))).json(),
    );
    expect(found.data.archives).toHaveLength(2);
    expect(found.data.tokenCount).toBeLessThanOrEqual(32);
    expect(found.data.archives.reduce((n, a) => n + a.tokenCount, 0)).toBe(found.data.tokenCount);
    expect(
      searchResponse.parse(
        await (await handler(request('search', { projectId: 'userevidence' }))).json(),
      ).data.archives,
    ).toHaveLength(0);
    expect(
      searchResponse.parse(
        await (await handler(request('search', { query: 'userevidence' }))).json(),
      ).data.archives,
    ).toHaveLength(2);
    expect((await handler(request('search', { integrationId: 'not-standalone' }))).status).toBe(
      400,
    );
  } finally {
  }
});

test('three organizations stay isolated; projects no organization owns remain local', async () => {
  const local = await freshStore();
  const instances = [];
  for (const projectId of ['personal', 'inixiative', 'userevidence'] as const) {
    await freshStore(projectId);
    instances.push({
      projectId,
      instance: await startArchiveServer({
        databaseUrl: testDatabaseUrl(projectId),
        token,
        port: 0,
      }),
    });
  }
  process.env.ARCHIVE_ROUTING_TEST_TOKEN = token;
  try {
    // Each session is planned to its own organization; one no plan routes stays here.
    for (const projectId of ['personal', 'inixiative', 'userevidence', 'unknown']) {
      const { id } = await local.capture(snapshot(projectId, projectId));
      if (projectId !== 'unknown') await routeWhole(local, id, [projectId]);
    }
    const destinations: ArchiveDestination[] = instances.map(({ projectId, instance }) => ({
      organizationId: projectId,
      kind: 'archive',
      url: instance.server.url.href,
      tokenEnv: 'ARCHIVE_ROUTING_TEST_TOKEN',
    }));
    const routes = await routingPreview(local, routing(destinations));
    expect(routes.filter((r) => r.destinations.length).map((r) => r.partOf)).toHaveLength(3);
    expect(routes.find((r) => r.projectId === 'unknown')?.destinations).toHaveLength(0);
    expect(routes.find((r) => r.projectId === 'inixiative' && r.partOf)?.destinations).toHaveLength(
      1,
    );
    expect((await syncArchives(local, routing(destinations))).map((r) => r.status)).toEqual([
      'published',
      'published',
      'published',
    ]);
    for (const { projectId, instance } of instances)
      expect((await instance.store.list()).map((a) => a.projectId)).toEqual([projectId]);
    expect(
      (await syncArchives(local, routing(destinations))).every((r) => r.status === 'unchanged'),
    ).toBe(true);
  } finally {
    delete process.env.ARCHIVE_ROUTING_TEST_TOKEN;
    for (const { instance } of instances) await instance.close();
  }
});

test('lost acknowledgement replays old revision before new content after client and server restart', async () => {
  let local = await freshStore();
  let remote = await freshStore('remote');
  process.env.ARCHIVE_RESTART_TEST_TOKEN = token;
  const destination: ArchiveDestination = {
    kind: 'archive',
    organizationId: 'inixiative',
    url: 'http://localhost:4411/',
    tokenEnv: 'ARCHIVE_RESTART_TEST_TOKEN',
  };
  try {
    const source = await local.capture(snapshot());
    const first = { id: await routeWhole(local, source.id, ['inixiative']) };
    let handler = createArchiveHandler(remote, token);
    const lost = (async (url: any, options: any) => {
      await handler(new Request(url, options));
      throw new Error('lost ack');
    }) as unknown as typeof fetch;
    await expect(
      publishArchive(local, first.id, destination, routing([destination]), lost),
    ).rejects.toThrow('lost ack');
    const second = snapshot();
    second.entries[0]!.text = 'Second';
    await local.capture({ ...second, capturedAt: 2 });
    await routeWhole(local, source.id, ['inixiative']);
    local = new ArchiveStore(testDatabaseUrl('main'));
    remote = new ArchiveStore(testDatabaseUrl('remote'));
    handler = createArchiveHandler(remote, token);
    await publishArchive(local, first.id, destination, routing([destination]), ((
      url: any,
      options: any,
    ) => handler(new Request(url, options))) as typeof fetch);
    expect((await remote.read(first.id))?.revision).toBe(2);
    // The replayed first revision reached the remote before the second, which compacted it.
    expect(remote.read(first.id, 1)).rejects.toThrow('was compacted');
    expect((await remote.read(first.id))?.snapshot.entries[0]?.text).toBe('Second');
    // Delivered, the local revision the outbox held back is compacted too.
    expect(local.read(first.id, 1)).rejects.toThrow('was compacted');
  } finally {
    await local.close();
    await remote.close();
    delete process.env.ARCHIVE_RESTART_TEST_TOKEN;
  }
});

test('connect validates credentials before changing configuration and repeated setup is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-connect-'));
  await freshStore('serve');
  const instance = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  const config = destinationsFile(dir);
  const args = [
    'connect',
    '--home',
    dir,
    '--url',
    instance.server.url.href,
    '--organization-id',
    'inixiative',
    '--token-env',
    'ARCHIVE_CONNECT_TEST_TOKEN',
  ];
  try {
    process.env.ARCHIVE_CONNECT_TEST_TOKEN = 'bad';
    await expect(runCli(args)).rejects.toThrow('401');
    expect(readRouting(config).destinations).toHaveLength(0);
    process.env.ARCHIVE_CONNECT_TEST_TOKEN = token;
    await runCli(args);
    await runCli(args);
    expect(readRouting(config).destinations).toHaveLength(1);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(readRouting(config).destinations)).not.toContain(token);
    expect(() =>
      connectDestination(config, {
        kind: 'archive',
        url: 'http://unsafe.example',
        organizationId: 'p',
        tokenEnv: 'TOKEN',
      }),
    ).toThrow('HTTPS');
  } finally {
    delete process.env.ARCHIVE_CONNECT_TEST_TOKEN;
    await instance.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted tag filtering matches exact explicit tags, not transcript mentions', async () => {
  const store = await freshStore();
  try {
    await store.capture({ ...snapshot('inixiative', 'tagged'), tags: ['Agentic'] });
    await store.capture({
      ...snapshot('inixiative', 'mentioned'),
      tags: ['Governance'],
      title: 'Agentic discussion',
    });
    const handler = createArchiveHandler(store, token);
    const result = searchResponse.parse(
      await (await handler(request('search', { tag: 'Agentic' }))).json(),
    );
    expect(result.data.archives).toHaveLength(1);
    const other = searchResponse.parse(
      await (await handler(request('search', { tag: 'agentic' }))).json(),
    );
    expect(other.data.archives).toHaveLength(0);
  } finally {
  }
});

test('Kingdom destinations write and search through the paired Signet', async () => {
  const local = await freshStore();
  const source = (await local.capture(snapshot())).id;
  const id = await routeWhole(local, source, ['inixiative']);
  await local.db.routingPlan.create({
    data: {
      archiveId: source,
      status: 'valid',
      plan: {},
      key: 'k',
      by: 'm',
      digest: 'd',
      entries: 1,
      at: 1,
    },
  });
  const directory = mkdtempSync(join(tmpdir(), 'archive-kingdom-'));
  chmodSync(directory, 0o700);
  const integrationId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const kingdom = signetKingdom({
    libraries: [{ integrationId, resourceId, name: 'Org Archive' }],
    execute: async (body) =>
      body.operation === 'documents.search'
        ? { documents: [] }
        : body.operation === 'sessions.delete'
          ? { archiveId: id, deleted: true }
          : { id, digest: (await local.read(id))!.digest, revision: 1, changed: true },
  });
  const { origin, signetId, executed } = kingdom;
  const credentialFile = await kingdom.hold(directory);
  const destination: ArchiveDestination = {
    kind: 'kingdom',
    organizationId: 'inixiative',
    url: origin,
    credentialFile,
    integrationId,
    resourceId,
  };
  try {
    await verifyKingdomDestination(destination);
    await expect(
      verifyKingdomDestination({ ...destination, resourceId: crypto.randomUUID() }),
    ).rejects.toThrow('does not grant sessions.write');
    await publishArchive(local, id, destination, routing([destination]));
    expect(executed[0]).toMatchObject({
      signetId,
      integrationId,
      operation: 'sessions.write',
      input: { resourceId, previousDigest: null },
    });
    expect(executed[0].input.snapshot?.sessionId).toBe('one#part-one');
    // Kingdom's sessions.write takes the snapshot and previous digest only.
    expect(Object.keys(executed[0].input).sort()).toEqual([
      'limit',
      'previousDigest',
      'resourceId',
      'snapshot',
    ]);
    expect(await publishArchive(local, id, destination, routing([destination]))).toEqual({
      unchanged: true,
    });
    expect(
      (await routingPreview(local, routing([destination]))).find((r) => r.id === id)?.destinations,
    ).toEqual([{ kind: 'kingdom', organizationId: 'inixiative', url: origin, integrationId }]);
    // A re-plan that no longer routes the part takes it back through sessions.delete.
    await local.applyParts(source, []);
    expect(await syncArchives(local, routing([destination]))).toEqual([
      { id, destination: origin, status: 'deleted' },
    ]);
    expect(executed.at(-1)).toMatchObject({
      operation: 'sessions.delete',
      input: { resourceId, documentId: id },
    });
    expect(await local.listing(id)).toBeUndefined();
    const [remote] = await searchRemotes([destination], 'anything');
    expect(remote).toMatchObject({ data: { documents: [] } });
    expect(executed.at(-1)).toMatchObject({ operation: 'documents.search' });
  } finally {
    kingdom.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parts publish to every organization their plan gives them; a re-plan deletes what it drops and restores what it brings back; a planned leak is deleted', async () => {
  const local = await freshStore();
  const instances: {
    projectId: string;
    instance: Awaited<ReturnType<typeof startArchiveServer>>;
  }[] = [];
  for (const projectId of ['inixiative', 'userevidence'] as const) {
    await freshStore(projectId);
    instances.push({
      projectId,
      instance: await startArchiveServer({
        databaseUrl: testDatabaseUrl(projectId),
        token,
        port: 0,
      }),
    });
  }
  process.env.ARCHIVE_ORGANIZATION_TEST_TOKEN = token;
  try {
    const destinations: ArchiveDestination[] = instances.map(({ projectId, instance }) => ({
      kind: 'archive',
      organizationId: projectId,
      url: instance.server.url.href,
      tokenEnv: 'ARCHIVE_ORGANIZATION_TEST_TOKEN',
    }));
    const routed = routing(destinations, {
      inixiative: ['inixiative', 'template', 'kingdom', 'tribe'],
      userevidence: ['userevidence'],
    });
    const ue = instances[1]!.instance.store;
    // A session published whole to UserEvidence before routing was planned (the leak), whose plan
    // now keeps it personal; one work for both; one for UserEvidence; one not planned yet.
    const leaked = await local.capture(snapshot('inixiative', 'leaked'));
    const leakedCopy = (await local.read(leaked.id))!;
    await ue.capture(leakedCopy.snapshot, { previousDigest: null });
    await local.delivered(leaked.id, destinationIdentity(destinations[1]!), leakedCopy.digest);
    await local.db.routingPlan.create({
      data: {
        archiveId: leaked.id,
        status: 'valid',
        plan: {},
        key: 'k',
        by: 'm',
        digest: 'd',
        entries: 1,
        at: 1,
      },
    });
    const mixed = await local.capture(snapshot('inixiative', 'mixed'));
    const mixedPart = await routeWhole(local, mixed.id, ['inixiative', 'userevidence']);
    await routeWhole(local, (await local.capture(snapshot('userevidence', 'ue-own'))).id, [
      'userevidence',
    ]);
    const unplanned = await local.capture(snapshot('inixiative', 'unplanned'));
    // Its whole copy published before routing is a leak too, deleted with no plan needed.
    await local.delivered(unplanned.id, destinationIdentity(destinations[1]!), unplanned.digest);
    const routes = await routingPreview(local, routed);
    expect(routes.find((r) => r.id === mixedPart)?.organizations).toEqual([
      'inixiative',
      'userevidence',
    ]);
    expect(routes.find((r) => r.id === unplanned.id)?.organizations).toEqual([]);
    const statuses = async () =>
      (await syncArchives(local, routed))
        .map(
          (r) =>
            `${r.status}:${r.destination === destinations[0]!.url ? 'inixiative' : 'userevidence'}`,
        )
        .sort();
    expect(await statuses()).toEqual([
      'deleted:userevidence',
      'deleted:userevidence',
      'published:inixiative',
      'published:userevidence',
      'published:userevidence',
    ]);
    const held = (i: number) =>
      instances[i]!.instance.store.list({ exempt: 'include' }).then((l) =>
        l.map((a) => a.sessionId).sort(),
      );
    expect(await held(0)).toEqual(['mixed#part-one']);
    expect(await held(1)).toEqual(['mixed#part-one', 'ue-own#part-one']);
    expect((await syncArchives(local, routed)).every((r) => r.status === 'unchanged')).toBe(true);
    // A re-plan moves the mixed part to inixiative only: UserEvidence's copy is deleted.
    await routeWhole(local, mixed.id, ['inixiative']);
    expect(await statuses()).toEqual([
      'deleted:userevidence',
      'unchanged:inixiative',
      'unchanged:userevidence',
    ]);
    expect(await held(1)).toEqual(['ue-own#part-one']);
    // Routed there again, it is restored, not swallowed by the destination's tombstone.
    await routeWhole(local, mixed.id, ['inixiative', 'userevidence']);
    expect(await statuses()).toContain('published:userevidence');
    expect(await held(1)).toEqual(['mixed#part-one', 'ue-own#part-one']);
  } finally {
    delete process.env.ARCHIVE_ORGANIZATION_TEST_TOKEN;
    for (const { instance } of instances) await instance.close();
  }
});

test('L6: every whole-session copy a destination holds is deleted, whatever the plan; with publish off nothing new publishes', async () => {
  const local = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_LEAK_TEST_TOKEN = token;
  const server = Bun.serve({ port: 0, fetch: createArchiveHandler(remote, token) });
  try {
    const destination: ArchiveDestination = {
      kind: 'archive',
      organizationId: 'userevidence',
      url: server.url.href,
      tokenEnv: 'ARCHIVE_LEAK_TEST_TOKEN',
    };
    const identity = destinationIdentity(destination);
    const leak = async (sessionId: string, extra: Record<string, unknown> = {}) => {
      const { id } = await local.capture({ ...snapshot('userevidence', sessionId), ...extra });
      const copy = (await local.read(id))!;
      await remote.capture(copy.snapshot, { previousDigest: null });
      await local.delivered(id, identity, copy.digest);
      return id;
    };
    const unplanned = await leak('unplanned');
    const held = await leak('held');
    await local.db.routingPlan.create({
      data: { archiveId: held, status: 'held', key: 'k', by: 'm', digest: 'd', entries: 1, at: 1 },
    });
    const superseded = await leak('superseded');
    await local.db.archive.update({ where: { id: superseded }, data: { supersededBy: 'driver' } });
    const exempt = await leak('exempt', { tags: ['run:test'] });
    // A planned part: with publish off it does not go out.
    const planned = await local.capture(snapshot('userevidence', 'planned'));
    await routeWhole(local, planned.id, ['userevidence']);
    const off = { ...routing([destination]), publish: 'off' as const };
    const results = await syncArchives(local, off);
    expect(results.map((r) => [r.id, r.status]).sort()).toEqual(
      [unplanned, held, superseded, exempt].map((id) => [id, 'deleted']).sort(),
    );
    expect(await remote.list({ exempt: 'include' })).toEqual([]);
    // On, the part publishes.
    expect((await syncArchives(local, routing([destination]))).map((r) => r.status)).toEqual([
      'published',
    ]);
  } finally {
    server.stop(true);
    delete process.env.ARCHIVE_LEAK_TEST_TOKEN;
  }
});

test('L7: deleting or pruning a session deletes its parts’ copies first; a part deleted here stays deleted', async () => {
  const local = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_L7_TEST_TOKEN = token;
  const server = Bun.serve({ port: 0, fetch: createArchiveHandler(remote, token) });
  try {
    const destination: ArchiveDestination = {
      kind: 'archive',
      organizationId: 'userevidence',
      url: server.url.href,
      tokenEnv: 'ARCHIVE_L7_TEST_TOKEN',
    };
    const routed = routing([destination]);
    const published = async (sessionId: string) => {
      const { id } = await local.capture(snapshot('userevidence', sessionId));
      const part = await routeWhole(local, id, ['userevidence']);
      return { id, part };
    };
    const a = await published('deleted-here');
    const b = await published('pruned');
    const c = await published('part-deleted');
    expect((await syncArchives(local, routed)).map((r) => r.status)).toEqual([
      'published',
      'published',
      'published',
    ]);
    expect(await remote.list()).toHaveLength(3);
    // A person deletes a session; retention prunes another; a person deletes a part.
    await local.delete(a.id);
    await local.db.archive.update({ where: { id: c.id }, data: { capturedAt: 5 * 86_400_000 } });
    await local.updateSettings({ retentionDays: 1 });
    expect(await local.prune(5.5 * 86_400_000)).toEqual([b.id]);
    expect(await local.delete(c.part)).toBe(true);
    expect((await syncArchives(local, routed)).map((r) => [r.id, r.status]).sort()).toEqual(
      [a.part, b.part, c.part].map((id) => [id, 'deleted']).sort(),
    );
    expect(await remote.list()).toEqual([]);
    // The deleted part is not restored by the next plan of its session.
    await routeWhole(local, c.id, ['userevidence']);
    expect(await syncArchives(local, routed)).toEqual([]);
    expect(await remote.list()).toEqual([]);
  } finally {
    server.stop(true);
    delete process.env.ARCHIVE_L7_TEST_TOKEN;
  }
});

test('publishArchive itself refuses while routing.publish is off', async () => {
  const local = await freshStore();
  const { id } = await local.capture(snapshot('userevidence', 'guarded'));
  const part = await routeWhole(local, id, ['userevidence']);
  const destination: ArchiveDestination = {
    kind: 'archive',
    organizationId: 'userevidence',
    url: 'http://127.0.0.1:9/',
    tokenEnv: 'NO_TOKEN',
  };
  await expect(
    publishArchive(local, part, destination, { ...routing([destination]), publish: 'off' }),
  ).rejects.toThrow('Publishing is off');
});

test('R2, R3, cleanup: deletes survive a local delete, reconciliation finds copies with no receipt, a foreign copy and a whole-routed copy stay', async () => {
  const local = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_R3_TEST_TOKEN = token;
  let refuse = false;
  const handler = createArchiveHandler(remote, token);
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      refuse && new URL(request.url).pathname.endsWith('/delete')
        ? Response.json({ error: 'Forbidden' }, { status: 403 })
        : handler(request),
  });
  try {
    const destination: ArchiveDestination = {
      kind: 'archive',
      organizationId: 'userevidence',
      url: server.url.href,
      tokenEnv: 'ARCHIVE_R3_TEST_TOKEN',
    };
    const identity = destinationIdentity(destination);
    const sourceId = await local.sourceId();
    const ours = (sessionId: string) => ({ ...snapshot('userevidence', sessionId), sourceId });
    const send = async (s: ReturnType<typeof ours>) => remote.capture(s, { previousDigest: null });
    // R2: a leaked copy whose session is deleted here while the destination refuses deletes.
    const gone = await local.capture(ours('gone'));
    await send(ours('gone'));
    await local.delivered(gone.id, identity, gone.digest);
    // R3: a copy the destination holds with no local row and no receipt, and another Archive's.
    await send(ours('lost'));
    const foreign = { ...snapshot('userevidence', 'foreign'), sourceId: crypto.randomUUID() };
    await send(foreign);
    // cleanup: leaked keeps a whole copy its valid plan sends there whole and unredacted.
    const whole = await local.capture(ours('whole'));
    await send(ours('whole'));
    await local.delivered(whole.id, identity, whole.digest);
    await local.setProjectMap({ projects: [] });
    await local
      .recordPlan(
        {
          archiveId: whole.id,
          digest: whole.digest,
          through: 0,
          key: 'k',
          by: 'test',
          proposal: {
            parts: [{ from: 0, to: 0, organizations: ['userevidence'] }],
            prune: [],
            redactions: [],
            rationale: '',
          },
        },
        routing([destination]),
      )
      .catch(() => undefined);
    // The plan needs evidence; a person's decision stands in for it here.
    await local.tag(whole.id, { add: ['route:userevidence'] });
    const planned = await local.recordPlan(
      {
        archiveId: whole.id,
        digest: whole.digest,
        through: 0,
        key: 'k',
        by: 'test',
        proposal: {
          parts: [{ from: 0, to: 0, organizations: ['userevidence'] }],
          prune: [],
          redactions: [],
          rationale: '',
        },
      },
      routing([destination]),
    );
    expect(planned.status).toBe('valid');
    refuse = true;
    await local.delete(gone.id);
    const off = { ...routing([destination]), publish: 'off' as const };
    const backoff: SyncBackoff = new Map();
    const statuses = async (r = off) =>
      (await syncArchives(local, r, { backoff })).map(
        (x) => `${x.id.slice(0, 6)}:${x.status.split(';')[0]}`,
      );
    // The refused delete stays queued on the tombstone.
    expect((await statuses()).some((s) => s.endsWith('failed'))).toBe(true);
    refuse = false;
    backoff.clear();
    await statuses();
    const held = (await remote.list({ exempt: 'include' })).map((a) => a.sessionId).sort();
    expect(held).toEqual(['foreign', 'whole']);
    // cleanup all, or publishing on, deletes the whole copy too; the foreign one always stays.
    backoff.clear();
    await statuses({ ...off, cleanup: 'all' });
    expect((await remote.list({ exempt: 'include' })).map((a) => a.sessionId)).toEqual(['foreign']);
  } finally {
    server.stop(true);
    delete process.env.ARCHIVE_R3_TEST_TOKEN;
  }
});

test('R3 through Kingdom: a listed copy this Archive knows is deleted; one it can’t attribute is left alone', async () => {
  const local = await freshStore();
  const { id: deleted } = await local.capture(snapshot('userevidence', 'deleted-locally'));
  await local.delete(deleted);
  const stranger = 'f'.repeat(64);
  const directory = mkdtempSync(join(tmpdir(), 'archive-kingdom-reconcile-'));
  chmodSync(directory, 0o700);
  const integrationId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const kingdom = signetKingdom({
    libraries: [{ integrationId, resourceId, name: 'UE Archive' }],
    execute: (body) =>
      body.operation === 'documents.read'
        ? { documents: [{ id: deleted }, { id: stranger }] }
        : { archiveId: deleted, deleted: true },
  });
  try {
    const destination: ArchiveDestination = {
      kind: 'kingdom',
      organizationId: 'userevidence',
      url: kingdom.origin,
      credentialFile: await kingdom.hold(directory),
      integrationId,
      resourceId,
    };
    expect(await syncArchives(local, { ...routing([destination]), publish: 'off' })).toEqual([
      { id: deleted, destination: kingdom.origin, status: 'deleted' },
    ]);
    expect(kingdom.executed.map((e) => e.operation)).toEqual(['documents.read', 'sessions.delete']);
  } finally {
    kingdom.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
