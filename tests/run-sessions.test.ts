import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publishArchive } from '../src/client';
import { type CollectionSource, collectSessions } from '../src/collector';
import { type ArchiveDestination, destinationIdentity } from '../src/config';
import { RUN_TAGS, stampedRun, stampRunDirectory } from '../src/exemption';
import { archiveSnapshotSchema } from '../src/index';
import { createArchiveHandler } from '../src/server';
import { freshStore } from './db';

const token = 'synthetic-archive-test-token-0000000000';
const session = (sessionId: string, tags: string[] = [], projectId = 'inixiative') =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId,
    title: sessionId,
    projectId,
    tags,
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [
      { id: 'u1', kind: 'user', text: `Work on ${sessionId}`, timestamp: 1, sourceRef: 'line:1' },
    ],
  });
const request = (action: string, body: unknown) =>
  new Request(`http://localhost/api/v1/archive/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

test('every run kind can be stamped, by environment or by a marker file', () => {
  expect(stampedRun({ ARCHIVE_RUN: 'foundry' })).toBe(RUN_TAGS.foundry);
  expect(Object.values(RUN_TAGS)).toEqual(['run:test', 'run:oracle', 'run:foundry']);
});

test('with run sessions off, ingest keeps no run session, whoever stamped it, and deletes one held', async () => {
  const store = await freshStore();
  // On by default: kept, and exempt.
  const kept = await store.capture(session('kept-run', [RUN_TAGS.foundry]));
  expect(kept.changed).toBe(true);
  expect(await store.list({ exempt: 'only' })).toHaveLength(1);
  expect((await store.settings()).captureRunSessions).toBe(true);

  await store.updateSettings({ captureRunSessions: false });
  for (const tag of Object.values(RUN_TAGS))
    expect(await store.capture(session(`new-${tag}`, [tag]))).toMatchObject({
      changed: false,
      revision: 0,
      dropped: tag,
    });
  // The interim inference counts too: Foundry's fixture project `P`.
  expect((await store.capture(session('fixture', [], 'P'))).dropped).toBe(RUN_TAGS.test);
  // A run session already held goes when it is captured again.
  expect(
    (await store.capture({ ...session('kept-run', [RUN_TAGS.foundry]), capturedAt: 2 })).dropped,
  ).toBe(RUN_TAGS.foundry);
  // A person's work is untouched.
  expect((await store.capture(session('work'))).changed).toBe(true);
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId)).toEqual(['work']);

  // Over HTTP too (Foundry's direct writes, a syncing Archive).
  const handler = createArchiveHandler(store, token);
  const response = await handler(
    request('ingest', { snapshot: session('http-run', [RUN_TAGS.oracle]), previousDigest: null }),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: { dropped?: string } }).data.dropped).toBe(
    RUN_TAGS.oracle,
  );
  expect(await store.list({ exempt: 'include' })).toHaveLength(1);
});

test('a session whose run tag a person removed is kept when run sessions go off', async () => {
  const store = await freshStore();
  const { id } = await store.capture(session('lifted', [RUN_TAGS.test]));
  await store.tag(id, { remove: [RUN_TAGS.test] });
  await store.updateSettings({ captureRunSessions: false });
  await store.maintain();
  const again = await store.capture({ ...session('lifted', [RUN_TAGS.test]), capturedAt: 2 });
  expect(again.dropped).toBeUndefined();
  expect((await store.list()).map((a) => a.sessionId)).toEqual(['lifted']);
});

test('turning run sessions off deletes those already held, in batches, and resumes', async () => {
  const store = await freshStore();
  const runs = 105;
  for (let n = 0; n < runs; n++)
    await store.capture(session(`run-${n}`, [n % 2 ? RUN_TAGS.test : RUN_TAGS.foundry]));
  await store.capture(session('work-a'));
  await store.capture(session('work-b'));
  // Hand-tagged runs (a person's tag edit) count as listed.
  const { id: tagged } = await store.capture(session('hand-tagged'));
  await store.tag(tagged, { add: [RUN_TAGS.test] });
  expect((await store.maintenanceStatus()).runSessionSweepPending).toBe(false);

  await store.updateSettings({ captureRunSessions: false });
  expect((await store.maintenanceStatus()).runSessionSweepPending).toBe(true);
  // A reclaim waits for the sweep.
  await expect(store.reclaim()).rejects.toThrow('run-session deletion');
  expect(await store.removeRunSessions()).toBe(runs + 1);
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId).sort()).toEqual([
    'work-a',
    'work-b',
  ]);
  expect((await store.maintenanceStatus()).runSessionSweepPending).toBe(false);

  // Resumes after the last page it finished; turning the setting back on cancels it.
  await store.updateSettings({ captureRunSessions: true });
  await store.capture(session('late-run', [RUN_TAGS.oracle]));
  await store.updateSettings({ captureRunSessions: false });
  const workB = (await store.list()).find((a) => a.sessionId === 'work-b')!;
  const { seq } = (await store.db.archive.findUnique({ where: { id: workB.id } }))!;
  await store.db.setting.update({
    where: { key: 'runSessionSweep' },
    data: { value: { afterSeq: seq.toString() } },
  });
  await store.maintain();
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId).sort()).toEqual([
    'work-a',
    'work-b',
  ]);
  await store.updateSettings({ captureRunSessions: true });
  await store.capture(session('kept-again', [RUN_TAGS.oracle]));
  await store.maintain();
  expect(await store.list({ exempt: 'only' })).toHaveLength(1);
});

test('a destination that does not keep run sessions acknowledges them, so they are not resent', async () => {
  const store = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_RUN_SESSIONS_TEST_TOKEN = token;
  try {
    await remote.updateSettings({ captureRunSessions: false });
    const { id } = await store.capture(session('synced-run', [RUN_TAGS.test]));
    const destination: ArchiveDestination = {
      kind: 'archive',
      projectId: 'inixiative',
      url: 'http://localhost:4413/',
      tokenEnv: 'ARCHIVE_RUN_SESSIONS_TEST_TOKEN',
    };
    const handler = createArchiveHandler(remote, token);
    const transport = ((url: string, options: RequestInit) =>
      handler(new Request(url, options))) as unknown as typeof fetch;
    expect(await publishArchive(store, id, destination, transport)).toEqual({ unchanged: false });
    expect(await remote.list({ exempt: 'include' })).toEqual([]);
    expect(await store.receipt(id, destinationIdentity(destination))).toBe(
      (await store.head(id))!.storedDigest,
    );
    expect(await publishArchive(store, id, destination, transport)).toEqual({ unchanged: true });
  } finally {
    delete process.env.ARCHIVE_RUN_SESSIONS_TEST_TOKEN;
  }
});

test('a collector counts what the server dropped and does not send it again', async () => {
  const dir = realpathSync(mkdtempSync(join(homedir(), '.archive-run-sessions-test-')));
  const store = await freshStore();
  try {
    await store.updateSettings({ captureRunSessions: false });
    const history = join(dir, 'history');
    const project = join(dir, 'project');
    const primed = join(dir, 'host');
    mkdirSync(history);
    mkdirSync(project);
    mkdirSync(primed);
    stampRunDirectory(primed, 'foundry');
    const transcript = (id: string, cwd: string) =>
      writeFileSync(
        join(history, `${id}.jsonl`),
        JSON.stringify({
          sessionId: id,
          cwd,
          type: 'user',
          uuid: `${id}-1`,
          message: { content: `Work in ${id}` },
        }),
      );
    transcript('person', project);
    transcript('warden', primed);
    let captures = 0;
    const writer = {
      sourceId: () => store.sourceId(),
      head: (id: string) => store.head(id),
      capture: (snapshot: unknown) => {
        captures++;
        return store.capture(snapshot);
      },
      claimState: () => Promise.resolve({ state: 'none' as const }),
    };
    const config: CollectionSource = {
      directory: history,
      source: 'claude-code',
      projectRoots: [project, primed],
      projectId: 'inixiative',
    };
    const cache = new Map();
    expect(await collectSessions(writer, config, { cache })).toMatchObject({
      imported: 1,
      dropped: 1,
      failed: 0,
    });
    expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId)).toEqual(['person']);
    captures = 0;
    expect(await collectSessions(writer, config, { cache })).toMatchObject({
      unchanged: 1,
      dropped: 1,
    });
    expect(captures).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
