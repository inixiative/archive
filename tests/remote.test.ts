import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../src/collector';
import { archiveSnapshotSchema } from '../src/index';
import { ArchiveClient, localArchive } from '../src/remote';
import { startArchiveServer } from '../src/server';
import { freshStore, testDatabaseUrl } from './db';

const token = 'synthetic-archive-test-token-0000000000';

test('collectors and clients write through the server over HTTP and retry lost races', async () => {
  await freshStore('serve');
  const server = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  const dir = mkdtempSync(join(tmpdir(), 'archive-remote-'));
  try {
    const client = new ArchiveClient({ url: server.server.url.href, token });
    expect(await client.sourceId()).toBe(await server.store.sourceId());
    writeFileSync(
      join(dir, 'one.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'remote-1', cwd: '/work/archive' } },
        {
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    const config = {
      directory: dir,
      source: 'codex' as const,
      projectRoots: ['/work/archive'],
      projectId: 'archive',
    };
    expect(await collectSessions(client, config)).toMatchObject({ imported: 1 });
    expect(await collectSessions(client, config)).toMatchObject({ unchanged: 1 });
    const [listed] = await client.list({ projectId: 'archive' });
    expect(listed.sessionId).toBe('remote-1');
    expect(await client.head(listed.id)).toMatchObject({ revision: 1, projectId: 'archive' });
    expect((await client.tag(listed.id, { add: ['seen'] })).tags).toEqual(['seen']);
    expect(await client.head('f'.repeat(64))).toBeUndefined();

    // Another writer lands a revision between this client's head and ingest.
    const snapshot = archiveSnapshotSchema.parse({
      ...(await client.read(listed.id))!.snapshot,
      title: 'Mine',
      capturedAt: Date.now(),
    });
    let raced = false;
    const racing = new ArchiveClient({
      url: server.server.url.href,
      token,
      fetch: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (!raced && String(url).endsWith('/ingest')) {
          raced = true;
          await server.store.capture({
            ...snapshot,
            title: 'Theirs',
            capturedAt: snapshot.capturedAt - 1,
          });
        }
        return fetch(url, init);
      }) as typeof fetch,
    });
    expect((await racing.capture(snapshot)).revision).toBe(3);
    expect((await client.read(listed.id))?.snapshot.title).toBe('Mine');
    await expect(
      new ArchiveClient({ url: server.server.url.href, token: 'x'.repeat(40) }).list(),
    ).rejects.toThrow('Unauthorized');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('localArchive reaches this machine’s server once a token exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'archive-local-'));
  const previous = process.env.ARCHIVE_TOKEN;
  delete process.env.ARCHIVE_TOKEN;
  await freshStore('serve');
  const server = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  try {
    expect(localArchive({ home })).toBeUndefined();
    writeFileSync(join(home, 'server.token'), `${token}\n`);
    const archive = localArchive({ home, url: server.server.url.href })!;
    expect(await archive.sourceId()).toBe(await server.store.sourceId());
  } finally {
    if (previous !== undefined) process.env.ARCHIVE_TOKEN = previous;
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the server reads gzip bodies and refuses other encodings', async () => {
  await freshStore('serve');
  const server = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  try {
    const info = (encoding: string, body: Uint8Array | string) =>
      fetch(new URL('api/v1/archive/info', server.server.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-encoding': encoding },
        body,
      });
    const zipped = await info('gzip', Bun.gzipSync('{}'));
    expect(zipped.status).toBe(200);
    expect(((await zipped.json()) as { data: { sourceId: string } }).data.sourceId).toBe(
      await server.store.sourceId(),
    );
    expect((await info('gzip', 'not gzip')).status).toBe(400);
    expect((await info('br', '{}')).status).toBe(415);
  } finally {
    await server.close();
  }
});

test('a refusal carries the server’s reason, even from a proxy page', async () => {
  const refusing = (response: Response) =>
    new ArchiveClient({
      url: 'https://archive.test/',
      token,
      fetch: (async () => response) as unknown as typeof fetch,
    }).list();
  await expect(
    refusing(Response.json({ error: 'Archive unavailable' }, { status: 404 })),
  ).rejects.toThrow('Archive unavailable');
  await expect(
    refusing(new Response('<html><title>Blocked</title></html>', { status: 403 })),
  ).rejects.toThrow('<title>Blocked</title>');
});

test('claims over HTTP: hold renews a lease, state reports it, fulfil needs the claimant and an archive', async () => {
  await freshStore('serve');
  const server = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  try {
    const client = new ArchiveClient({ url: server.server.url.href, token });
    expect(await client.claimState('codex', 'thread-1')).toEqual({ state: 'none' });
    const { expiresAt } = await client.holdClaims({
      claimant: 'foundry',
      ttlMs: 60_000,
      sessions: [{ source: 'codex', sessionId: 'thread-1' }],
    });
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await client.claimState('codex', 'thread-1')).toEqual({
      state: 'live',
      until: expiresAt,
    });
    await expect(
      client.holdClaims({
        claimant: 'someone-else',
        ttlMs: 60_000,
        sessions: [{ source: 'codex', sessionId: 'thread-1' }],
      }),
    ).rejects.toThrow('claimed by another writer');
    await expect(
      client.fulfilClaim({
        claimant: 'foundry',
        source: 'codex',
        sessionId: 'thread-1',
        archiveId: 'a'.repeat(64),
      }),
    ).rejects.toThrow('Archive unavailable');
    const stitched = await client.capture({
      schemaVersion: 1,
      sourceId: await client.sourceId(),
      source: 'foundry',
      sessionId: 'thread-1',
      title: 'Stitched',
      tags: [],
      goalIds: [],
      runIds: [],
      capturedAt: Date.now(),
      coverage: { reasoning: 'unavailable', completeness: 'partial', omissions: [] },
      entries: [{ id: 'm1', kind: 'user', text: 'Hi', timestamp: 1, sourceRef: 'message:m1' }],
    });
    expect(
      await client.fulfilClaim({
        claimant: 'foundry',
        source: 'codex',
        sessionId: 'thread-1',
        archiveId: stitched.id,
      }),
    ).toEqual({ fulfilledBy: stitched.id, superseded: [] });
    expect(await client.claimState('codex', 'thread-1', Date.now() - 60_000)).toEqual({
      state: 'live',
      until: expiresAt,
    });
    await expect(
      client.fulfilClaim({
        claimant: 'foundry',
        source: 'codex',
        sessionId: 'unclaimed',
        archiveId: stitched.id,
      }),
    ).rejects.toThrow('Claim unavailable');
    // Only native sources are claimable.
    await expect(
      client.holdClaims({
        claimant: 'foundry',
        ttlMs: 60_000,
        sessions: [{ source: 'foundry' as never, sessionId: 'x' }],
      }),
    ).rejects.toThrow();
  } finally {
    await server.close();
  }
});
