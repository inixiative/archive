import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  connectDestination,
  destinationIdentity,
  destinationsFile,
  kingdomDirectory,
  readRouting,
} from '../src/config';
import { archiveSnapshotSchema } from '../src/index';
import { startArchiveServer } from '../src/server';
import { freshStore, MIGRATED_DATABASE, testDatabaseUrl } from './db';
import { routing } from './routing';

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
      JSON.stringify({
        organizations: [{ id: 'inixiative', projects: ['inixiative'] }],
        destinations: [
          {
            kind: 'archive',
            organizationId: 'inixiative',
            url: hosted.server.url.href,
            tokenEnv: 'HOSTED_TOKEN',
          },
        ],
        publish: 'on',
        cleanup: 'leaked',
        cleanupFor: {},
      }),
    );
    const reader = local.stdout.getReader();
    let printed = '';
    while (!printed.includes('}')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`serve exited: ${await new Response(local.stderr).text()}`);
      printed += new TextDecoder().decode(chunk.value);
    }
    const url = JSON.parse(printed).listening as string;
    const sessionId = `synced-${crypto.randomUUID()}`;
    const snapshot = archiveSnapshotSchema.parse({
      schemaVersion: 1,
      sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
      source: 'codex',
      // The migrated database outlives a run: a session of its own each time.
      sessionId,
      title: 'Synced',
      projectId: 'inixiative',
      tags: [],
      capturedAt: 1,
      coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
      entries: [{ id: 'e', kind: 'user', text: 'hello', timestamp: 1, sourceRef: 'line:1' }],
    });
    const post = async (action: string, body: unknown) => {
      const response = await fetch(new URL(`api/v1/archive/${action}`, url), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: Record<string, unknown> }).data;
    };
    await post('projects/set', { projects: [{ projectId: 'inixiative', roots: ['/w'] }] });
    const ingested = await post('ingest', { snapshot, previousDigest: null, cwd: '/w' });
    // Nothing publishes until the session is planned: the plan goes through the same server.
    const input = await post('routing/input', { archiveId: ingested.id });
    const recorded = await post('routing/record', {
      archiveId: ingested.id,
      digest: input.digest,
      through: input.through,
      key: 'k',
      by: 'test',
      proposal: { parts: [{ from: 0, to: 0, organizations: ['inixiative'] }] },
    });
    expect(recorded.status).toBe('valid');
    const deadline = Date.now() + 40_000;
    const published = async () =>
      (await hosted.store.list()).map((a) => a.sessionId).includes(`${sessionId}#part-e`);
    while (!(await published()) && Date.now() < deadline) await Bun.sleep(250);
    expect(await published()).toBe(true);
    // The session itself never publishes, only its part.
    expect((await hosted.store.list()).map((a) => a.sessionId)).not.toContain(sessionId);
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
      ['bun', 'src/cli.ts', ...command.split(' '), '--home', home, '--url', local.server.url.href],
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
      organizationId: 'inixiative',
      url: hosted.server.url.href,
      tokenFile: join(home, 'hosted.token'),
    });
    expect(await cli('publish on')).toEqual({ publish: 'on' });
    expect(await cli('organizations set --id inixiative --project inixiative')).toEqual([
      { id: 'inixiative', projects: ['inixiative'] },
    ]);
    await local.store.setProjectMap({
      projects: [{ projectId: 'inixiative', roots: ['/w'], repositories: [] }],
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
      { cwd: '/w' },
    );
    const planned = await local.store.recordPlan(
      {
        archiveId: captured.id,
        digest: captured.digest,
        through: 0,
        key: 'k',
        by: 'test',
        proposal: {
          parts: [{ from: 0, to: 0, organizations: ['inixiative'] }],
          prune: [],
          redactions: [],
          rationale: '',
        },
      },
      readRouting(destinationsFile(home)),
    );
    expect(planned.status).toBe('valid');
    const routes = (await cli('routes')) as { id: string; partOf: string | null }[];
    const part = routes.find((r) => r.partOf === captured.id)!;
    expect(routes.find((r) => r.id === captured.id)).toMatchObject({
      organizations: [],
      destinations: [],
    });
    expect(part).toMatchObject({
      projectId: 'inixiative',
      organizations: ['inixiative'],
      destinations: [
        { kind: 'archive', organizationId: 'inixiative', url: hosted.server.url.href },
      ],
    });
    expect(await cli('cleanup')).toEqual({ cleanup: 'off', cleanupFor: {} });
    // Without an organization, leaked or all must name every organization on purpose.
    await expect(cli('cleanup leaked')).rejects.toThrow();
    expect(await cli('cleanup off')).toEqual({ cleanup: 'off', cleanupFor: {} });
    expect(await cli('cleanup all --all-organizations')).toEqual({
      cleanup: 'all',
      cleanupFor: {},
    });
    expect(await cli('cleanup off')).toEqual({ cleanup: 'off', cleanupFor: {} });
    expect(await cli('cleanup inixiative leaked')).toEqual({
      cleanup: 'off',
      cleanupFor: { inixiative: 'leaked' },
    });
    // A whole copy the destination holds from before routing: the dry run names it, sends nothing.
    await hosted.store.capture((await local.store.read(captured.id))!.snapshot, {
      previousDigest: null,
    });
    await local.store.delivered(
      captured.id,
      destinationIdentity(readRouting(destinationsFile(home)).destinations[0]!),
      captured.digest,
    );
    expect(await cli('sync --dry-run')).toEqual({
      dryRun: true,
      destinations: { [hosted.server.url.href]: { wouldDelete: 1, ids: [captured.id] } },
      other: [],
    });
    expect((await hosted.store.list()).map((a) => a.sessionId)).toEqual(['routed']);
    await hosted.store.delete(captured.id);
    await local.store.forgetDelivery(
      captured.id,
      destinationIdentity(readRouting(destinationsFile(home)).destinations[0]!),
    );
    expect(await cli('sync')).toEqual([
      { id: part.id, destination: hosted.server.url.href, status: 'published' },
    ]);
    expect((await hosted.store.list()).map((a) => a.sessionId)).toEqual(['routed#part-e']);
  } finally {
    await local.close();
    await hosted.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
