import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runCli } from '../src/cli';
import { publishArchive, routingPreview, searchRemotes, syncArchives } from '../src/client';
import {
  type ArchiveDestination,
  connectDestination,
  destinationsFile,
  readDestinations,
} from '../src/config';
import { archiveSnapshotSchema } from '../src/index';
import { verifyKingdomDestination } from '../src/kingdom';
import { createArchiveHandler, startArchiveServer } from '../src/server';
import { ArchiveStore } from '../src/store';
import { freshStore, testDatabaseUrl } from './db';
import { signetKingdom } from './kingdom';

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

test('hosted auth, immutable revisions, concurrent-write conflicts and bounded search', async () => {
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
    expect(
      readResponse.parse(
        await (await handler(request('read', { archiveId: first.data.id, revision: 1 }))).json(),
      ).data.snapshot.title,
    ).toBe(s.title);
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

test('three destinations stay isolated; tags never authorize a destination; unknown projects remain local', async () => {
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
    for (const projectId of ['personal', 'inixiative', 'userevidence', 'unknown'])
      await local.capture(snapshot(projectId, projectId));
    const destinations: ArchiveDestination[] = instances.map(({ projectId, instance }) => ({
      projectId,
      kind: 'archive',
      url: instance.server.url.href,
      tokenEnv: 'ARCHIVE_ROUTING_TEST_TOKEN',
    }));
    const routes = await routingPreview(local, destinations);
    expect(routes.find((r) => r.projectId === 'unknown')?.destinations).toHaveLength(0);
    expect(routes.find((r) => r.projectId === 'inixiative')?.destinations).toHaveLength(1);
    expect((await syncArchives(local, destinations)).map((r) => r.status)).toEqual([
      'published',
      'published',
      'published',
    ]);
    for (const { projectId, instance } of instances)
      expect((await instance.store.list()).map((a) => a.projectId)).toEqual([projectId]);
    expect((await syncArchives(local, destinations)).every((r) => r.status === 'unchanged')).toBe(
      true,
    );
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
    projectId: 'inixiative',
    url: 'http://localhost:4411/',
    tokenEnv: 'ARCHIVE_RESTART_TEST_TOKEN',
  };
  try {
    const first = await local.capture(snapshot());
    let handler = createArchiveHandler(remote, token);
    const lost = (async (url: any, options: any) => {
      await handler(new Request(url, options));
      throw new Error('lost ack');
    }) as unknown as typeof fetch;
    await expect(publishArchive(local, first.id, destination, lost)).rejects.toThrow('lost ack');
    await local.capture({ ...snapshot(), title: 'Second', capturedAt: 2 });
    local = new ArchiveStore(testDatabaseUrl('main'));
    remote = new ArchiveStore(testDatabaseUrl('remote'));
    handler = createArchiveHandler(remote, token);
    await publishArchive(local, first.id, destination, ((url: any, options: any) =>
      handler(new Request(url, options))) as typeof fetch);
    expect((await remote.read(first.id))?.revision).toBe(2);
    expect((await remote.read(first.id, 1))?.snapshot.title).toBe('Routing test');
    expect((await remote.read(first.id))?.snapshot.title).toBe('Second');
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
    '--project-id',
    'inixiative',
    '--token-env',
    'ARCHIVE_CONNECT_TEST_TOKEN',
  ];
  try {
    process.env.ARCHIVE_CONNECT_TEST_TOKEN = 'bad';
    await expect(runCli(args)).rejects.toThrow('401');
    expect(readDestinations(config)).toHaveLength(0);
    process.env.ARCHIVE_CONNECT_TEST_TOKEN = token;
    await runCli(args);
    await runCli(args);
    expect(readDestinations(config)).toHaveLength(1);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(readDestinations(config))).not.toContain(token);
    expect(() =>
      connectDestination(config, {
        kind: 'archive',
        url: 'http://unsafe.example',
        projectId: 'p',
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
  const id = (await local.capture(snapshot())).id;
  const directory = mkdtempSync(join(tmpdir(), 'archive-kingdom-'));
  chmodSync(directory, 0o700);
  const integrationId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const kingdom = signetKingdom({
    libraries: [{ integrationId, resourceId, name: 'Org Archive' }],
    execute: async (body) =>
      body.operation === 'documents.search'
        ? { documents: [] }
        : { id, digest: (await local.read(id))!.digest, revision: 1, changed: true },
  });
  const { origin, signetId, executed } = kingdom;
  const credentialFile = await kingdom.hold(directory);
  const destination: ArchiveDestination = {
    kind: 'kingdom',
    projectId: 'inixiative',
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
    await publishArchive(local, id, destination);
    expect(executed[0]).toMatchObject({
      signetId,
      integrationId,
      operation: 'sessions.write',
      input: { resourceId, previousDigest: null },
    });
    expect(executed[0].input.snapshot?.sessionId).toBe('one');
    expect(await publishArchive(local, id, destination)).toEqual({ unchanged: true });
    expect((await routingPreview(local, [destination]))[0].destinations).toEqual([
      { kind: 'kingdom', url: origin, integrationId },
    ]);
    const [remote] = await searchRemotes([destination], 'anything');
    expect(remote).toMatchObject({ data: { documents: [] } });
    expect(executed.at(-1)).toMatchObject({ operation: 'documents.search' });
  } finally {
    kingdom.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
