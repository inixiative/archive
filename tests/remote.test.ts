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
