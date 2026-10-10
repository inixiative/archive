import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connectDestination, destinationsFile, kingdomDirectory } from '../src/config';
import { archiveSnapshotSchema } from '../src/index';
import { startArchiveServer } from '../src/server';
import { freshStore, MIGRATED_DATABASE, testDatabaseUrl } from './db';

const token = 'synthetic-archive-test-token-0000000000';
const hostedToken = 'synthetic-hosted-archive-token-000000000';

test('serve --sync publishes what it receives to its destinations from the same process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'archive-serve-sync-'));
  await freshStore('remote');
  const hosted = await startArchiveServer({
    databaseUrl: testDatabaseUrl('remote'),
    token: hostedToken,
    port: 0,
  });
  const local = Bun.spawn(['bun', 'src/cli.ts', 'serve', '--home', home, '--port', '0', '--sync'], {
    env: {
      ...process.env,
      ARCHIVE_SERVER_TOKEN: token,
      HOSTED_TOKEN: hostedToken,
      DATABASE_URL: testDatabaseUrl(MIGRATED_DATABASE),
      ARCHIVE_DEBUG: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    mkdirSync(dirname(destinationsFile(home)), { recursive: true });
    writeFileSync(
      destinationsFile(home),
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
    while (!printed.includes('}')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`serve exited: ${await new Response(local.stderr).text()}`);
      printed += new TextDecoder().decode(chunk.value);
    }
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
    while (!(await hosted.store.list()).length && Date.now() < deadline) await Bun.sleep(250);
    expect((await hosted.store.list()).map((a) => a.title)).toEqual(['Synced']);
  } finally {
    local.kill('SIGTERM');
    await local.exited;
    await hosted.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test('routes and sync run against the Archive server of the home, without DATABASE_URL', async () => {
  const home = mkdtempSync(join(tmpdir(), 'archive-routes-'));
  chmodSync(home, 0o700);
  writeFileSync(join(home, 'server.token'), `${token}\n`, { mode: 0o600 });
  writeFileSync(join(home, 'hosted.token'), `${hostedToken}\n`, { mode: 0o600 });
  await freshStore('serve');
  await freshStore('remote');
  const hosted = await startArchiveServer({
    databaseUrl: testDatabaseUrl('remote'),
    token: hostedToken,
    port: 0,
  });
  const local = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
    config: { destinationsFile: destinationsFile(home), kingdomDirectory: kingdomDirectory(home) },
  });
  const { DATABASE_URL: _databaseUrl, ARCHIVE_TOKEN: _archiveToken, ...env } = process.env;
  const cli = async (command: string) => {
    const run = Bun.spawn(
      ['bun', 'src/cli.ts', command, '--home', home, '--url', local.server.url.href],
      { env: { ...env, ARCHIVE_DEBUG: '1' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (exitCode !== 0) throw new Error(`archive ${command} failed: ${stderr}`);
    return JSON.parse(stdout);
  };
  try {
    connectDestination(destinationsFile(home), {
      kind: 'archive',
      projectId: 'inixiative',
      url: hosted.server.url.href,
      tokenFile: join(home, 'hosted.token'),
    });
    const captured = await local.store.capture(
      archiveSnapshotSchema.parse({
        schemaVersion: 1,
        sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
        source: 'claude-code',
        sessionId: 'routed',
        title: 'Routed',
        projectId: 'inixiative',
        tags: [],
        capturedAt: 1,
        coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
        entries: [{ id: 'e', kind: 'user', text: 'hello', timestamp: 1, sourceRef: 'line:1' }],
      }),
    );
    expect(await cli('routes')).toMatchObject([
      {
        id: captured.id,
        projectId: 'inixiative',
        destinations: [{ kind: 'archive', url: hosted.server.url.href }],
      },
    ]);
    expect(await cli('sync')).toEqual([
      { id: captured.id, destination: hosted.server.url.href, status: 'published' },
    ]);
    expect((await hosted.store.list()).map((a) => a.title)).toEqual(['Routed']);
  } finally {
    await local.close();
    await hosted.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
