import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSnapshotSchema } from '../src/index';
import { startArchiveServer } from '../src/server';

const token = 'synthetic-archive-test-token-0000000000';
const hostedToken = 'synthetic-hosted-archive-token-000000000';

test('serve --sync publishes what it receives to its destinations from the same process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'archive-serve-sync-'));
  const hosted = startArchiveServer({ store: ':memory:', token: hostedToken, port: 0 });
  const local = Bun.spawn(['bun', 'src/cli.ts', 'serve', '--home', home, '--port', '0', '--sync'], {
    env: { ...process.env, ARCHIVE_SERVER_TOKEN: token, HOSTED_TOKEN: hostedToken },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    writeFileSync(
      join(home, 'destinations.json'),
      JSON.stringify([
        {
          kind: 'archive',
          projectId: 'inixiative',
          url: hosted.server.url.href,
          tokenEnv: 'HOSTED_TOKEN',
        },
      ]),
    );
    const reader = local.stdout.getReader();
    let printed = '';
    while (!printed.includes('}')) printed += new TextDecoder().decode((await reader.read()).value);
    const url = JSON.parse(printed).listening as string;
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1,
      sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
      source: 'codex',
      sessionId: 'synced',
      title: 'Synced',
      projectId: 'inixiative',
      tags: [],
      capturedAt: 1,
      coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
      entries: [{ id: 'e', kind: 'user', text: 'hello', timestamp: 1, sourceRef: 'line:1' }],
    });
    const ingested = await fetch(new URL('api/v1/archive/ingest', url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ snapshot, previousDigest: null }),
    });
    expect(ingested.status).toBe(200);
    const deadline = Date.now() + 40_000;
    while (!hosted.store.list().length && Date.now() < deadline) await Bun.sleep(250);
    expect(hosted.store.list().map((a) => a.title)).toEqual(['Synced']);
  } finally {
    local.kill('SIGTERM');
    await local.exited;
    await hosted.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
