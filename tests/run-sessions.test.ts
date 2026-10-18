import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { publishArchive } from '../src/client';
import { type CollectionSource, collectSessions } from '../src/collector';
import { type ArchiveDestination, destinationIdentity } from '../src/config';
import { RUN_INFERRED, RUN_TAGS, stampedRun, stampRunDirectory } from '../src/exemption';
import { archiveSnapshotSchema } from '../src/index';
import { createArchiveHandler } from '../src/server';
import { freshStore } from './db';
import { routing } from './routing';

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
  // Interim inferences only exempt: Foundry's fixture project `P`, a working directory guess.
  expect((await store.capture(session('fixture', [], 'P'))).dropped).toBeUndefined();
  expect(
    (await store.capture(session('scratch', [RUN_TAGS.test, RUN_INFERRED]))).dropped,
  ).toBeUndefined();
  // A person's Foundry thread from Zed outside a registered project is their work.
  const acp = await store.capture({
    ...session('acp-thread', ['acp', 'acp:zed']),
    source: 'foundry',
    projectId: undefined,
  });
  expect(acp).toMatchObject({ changed: true });
  expect(acp.dropped).toBeUndefined();
  // A run session already held goes when it is captured again.
  expect(
    (await store.capture({ ...session('kept-run', [RUN_TAGS.foundry]), capturedAt: 2 })).dropped,
  ).toBe(RUN_TAGS.foundry);
  // A person's work is untouched.
  expect((await store.capture(session('work'))).changed).toBe(true);
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId).sort()).toEqual([
    'acp-thread',
    'fixture',
    'scratch',
    'work',
  ]);
  expect((await store.list()).map((a) => a.sessionId).sort()).toEqual(['acp-thread', 'work']);

  // Over HTTP too (Foundry's direct writes, a syncing Archive).
  const handler = createArchiveHandler(store, token);
  const response = await handler(
    request('ingest', { snapshot: session('http-run', [RUN_TAGS.oracle]), previousDigest: null }),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: { dropped?: string } }).data.dropped).toBe(
    RUN_TAGS.oracle,
  );
  expect(await store.list({ exempt: 'include' })).toHaveLength(4);
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
      organizationId: 'inixiative',
      url: 'http://localhost:4413/',
      tokenEnv: 'ARCHIVE_RUN_SESSIONS_TEST_TOKEN',
    };
    const handler = createArchiveHandler(remote, token);
    const transport = ((url: string, options: RequestInit) =>
      handler(new Request(url, options))) as unknown as typeof fetch;
    expect(await publishArchive(store, id, destination, routing([destination]), transport)).toEqual(
      { unchanged: false },
    );
    expect(await remote.list({ exempt: 'include' })).toEqual([]);
    expect(await store.receipt(id, destinationIdentity(destination))).toBe(
      (await store.head(id))!.storedDigest,
    );
    expect(await publishArchive(store, id, destination, routing([destination]), transport)).toEqual(
      { unchanged: true },
    );
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
    const host = join(dir, 'host');
    const primed = join(host, 'fixture');
    mkdirSync(history);
    mkdirSync(project);
    mkdirSync(primed, { recursive: true });
    // The marker sits below the collector root, as a runner's workspace does.
    stampRunDirectory(host, 'foundry');
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
      projectRoots: [dir],
      subdirectories: true,
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

test("Foundry's own subagents are run:foundry by agent type; a person's subagents are not", async () => {
  const store = await freshStore();
  const subagent = (agentId: string, agentType: string) => ({
    ...session(`parent/agent-${agentId}`),
    lineage: { kind: 'subagent' as const, parentSessionId: 'parent', agentType },
  });
  for (const [id, type] of [
    ['w5', 'foundry-warden'],
    ['g1', 'foundry-dispatch'],
    ['r', 'foundry-root'],
    ['d', 'd-0123456789abcdef'],
  ])
    await store.capture(subagent(id!, type!));
  await store.capture(subagent('gp', 'general-purpose'));
  await store.capture(subagent('lookalike', 'foundry-warden-helper'));
  expect((await store.list()).map((a) => a.sessionId).sort()).toEqual([
    'parent/agent-gp',
    'parent/agent-lookalike',
  ]);
  expect(
    new Set(
      (await store.list({ exempt: 'only' })).flatMap((a) =>
        a.tags.filter((t) => t.startsWith('run:')),
      ),
    ),
  ).toEqual(new Set([RUN_TAGS.foundry]));
  await store.updateSettings({ captureRunSessions: false });
  await store.maintain();
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId).sort()).toEqual([
    'parent/agent-gp',
    'parent/agent-lookalike',
  ]);
  expect((await store.capture({ ...subagent('w6', 'foundry-warden') })).dropped).toBe(
    RUN_TAGS.foundry,
  );
});

test('a session a person rescued from a run tag is stored without it, so an "off" destination keeps it', async () => {
  const store = await freshStore();
  const remote = await freshStore('remote');
  process.env.ARCHIVE_RUN_SESSIONS_TEST_TOKEN = token;
  try {
    await remote.updateSettings({ captureRunSessions: false });
    const { id } = await store.capture(session('rescued', [RUN_TAGS.test]));
    await store.tag(id, { remove: [RUN_TAGS.test] });
    expect((await store.read(id))!.snapshot.tags).toEqual([]);
    // A later capture from the writer, still stamped, stays rescued too.
    await store.capture({ ...session('rescued', [RUN_TAGS.test]), capturedAt: 2 });
    expect((await store.read(id))!.snapshot.tags).toEqual([]);
    expect((await store.list()).map((a) => a.sessionId)).toEqual(['rescued']);
    const destination: ArchiveDestination = {
      kind: 'archive',
      organizationId: 'inixiative',
      url: 'http://localhost:4414/',
      tokenEnv: 'ARCHIVE_RUN_SESSIONS_TEST_TOKEN',
    };
    const handler = createArchiveHandler(remote, token);
    const transport = ((url: string, options: RequestInit) =>
      handler(new Request(url, options))) as unknown as typeof fetch;
    expect(await publishArchive(store, id, destination, routing([destination]), transport)).toEqual(
      { unchanged: false },
    );
    expect((await remote.list()).map((a) => a.sessionId)).toEqual(['rescued']);
    expect(await publishArchive(store, id, destination, routing([destination]), transport)).toEqual(
      { unchanged: true },
    );
  } finally {
    delete process.env.ARCHIVE_RUN_SESSIONS_TEST_TOKEN;
  }
});

test('the sweep deletes explicit runs only: an inferred or lifted one stays', async () => {
  const store = await freshStore();
  await store.capture(session('stamped', [RUN_TAGS.oracle]));
  await store.capture(session('inferred', [RUN_TAGS.test, RUN_INFERRED]));
  await store.capture(session('fixture', [], 'P'));
  const { id: lifted } = await store.capture(session('lifted', [RUN_TAGS.test]));
  await store.tag(lifted, { remove: [RUN_TAGS.test] });
  // A lift recorded straight in tag_edits (no re-store) is honoured by the delete statement.
  const { id: late } = await store.capture(session('late-lift', [RUN_TAGS.foundry]));
  await store.db.tagEdit.create({ data: { archiveId: late, tag: RUN_TAGS.foundry, added: false } });
  await store.updateSettings({ captureRunSessions: false });
  expect(await store.removeRunSessions()).toBe(1);
  expect((await store.list({ exempt: 'include' })).map((a) => a.sessionId).sort()).toEqual([
    'fixture',
    'inferred',
    'late-lift',
    'lifted',
  ]);
});

test('a deleted session leaves a tombstone: the same digest is not stored again, a new one is', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  const first = session('deleted');
  const { id, digest } = await store.capture(first);
  expect((await handler(request('delete', { archiveId: id }))).status).toBe(200);
  expect(await store.head(id)).toMatchObject({ id, digest, revision: 0, deleted: true });
  // The writer's unchanged copy, with the tombstone's digest as the previous one.
  const again = await handler(request('ingest', { snapshot: first, previousDigest: digest }));
  expect(((await again.json()) as { data: { changed: boolean } }).data.changed).toBe(false);
  expect(await store.list({ exempt: 'include' })).toEqual([]);
  // Resumed: a new digest is captured, and the tombstone goes.
  const resumed = {
    ...first,
    capturedAt: 2,
    entries: [...first.entries, { ...first.entries[0]!, id: 'u2', sourceRef: 'line:2' }],
  };
  const back = await handler(request('ingest', { snapshot: resumed, previousDigest: digest }));
  expect(((await back.json()) as { data: { changed: boolean } }).data.changed).toBe(true);
  expect(await store.db.archiveTombstone.count()).toBe(0);
  // Retention leaves tombstones too.
  await store.updateSettings({ retentionDays: 1 });
  expect(await store.prune(10 * 86_400_000)).toEqual([id]);
  expect(await store.head(id)).toMatchObject({ deleted: true });
});

test('a tombstone matches the transcript, not the tags around it; a stale or missing previous digest is no conflict', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  const first = session('retagged', ['coding']);
  const { id, digest } = await store.capture(first);
  await store.delete(id);
  // A new collector, Atlas graph or project list tags the same transcript differently.
  const retagged = { ...first, tags: ['coding', 'project:kingdom', 'atlas:feature:x'] };
  const answer = await handler(request('ingest', { snapshot: retagged, previousDigest: null }));
  expect(answer.status).toBe(200);
  expect(((await answer.json()) as { data: { changed: boolean } }).data.changed).toBe(false);
  expect(await store.list({ exempt: 'include' })).toEqual([]);
  // The tombstone takes the writer's new digest, so the collector's head check matches it.
  const head = await store.head(id);
  expect(head).toMatchObject({ deleted: true });
  expect(head!.digest).not.toBe(digest);
  // A resumed transcript comes back even with no previous digest (a destination reset).
  const resumed = {
    ...retagged,
    capturedAt: 2,
    entries: [...first.entries, { ...first.entries[0]!, id: 'u2', sourceRef: 'line:2' }],
  };
  const back = await handler(request('ingest', { snapshot: resumed, previousDigest: null }));
  expect(back.status).toBe(200);
  expect(((await back.json()) as { data: { changed: boolean } }).data.changed).toBe(true);
});

test('a session deleted here comes back under its current routing when it resumes, after delete or retention', async () => {
  const dir = realpathSync(mkdtempSync(join(homedir(), '.archive-tombstone-test-')));
  const store = await freshStore();
  try {
    const history = join(dir, 'history');
    mkdirSync(history);
    const file = join(history, 'moved.jsonl');
    const line = (uuid: string, content: string) =>
      JSON.stringify({
        sessionId: 'moved',
        cwd: join(dir, 'b', 'x'),
        type: 'user',
        uuid,
        message: { content },
      });
    writeFileSync(file, line('m1', 'Work'));
    const base = { directory: history, source: 'claude-code' as const, subdirectories: true };
    const a: CollectionSource = { ...base, projectId: 'a', projectRoots: [dir] };
    const b: CollectionSource = { ...base, projectId: 'b', projectRoots: [join(dir, 'b')] };
    const harness = () => undefined;
    // Captured under a (before b had a collector), then deleted.
    expect(await collectSessions(store, a, { peers: [a], harness })).toMatchObject({ imported: 1 });
    const { id } = (await store.list())[0]!;
    for (const remove of ['delete', 'retention'] as const) {
      if (remove === 'delete') await store.delete(id);
      else {
        await store.updateSettings({ retentionDays: 1 });
        expect(await store.prune(Date.now() + 10 * 86_400_000)).toEqual([id]);
        await store.updateSettings({ retentionDays: null });
      }
      expect(await store.head(id)).toMatchObject({ deleted: true, projectId: expect.any(String) });
      // Unchanged under b's routing: still deleted, and never "held by a".
      expect(await collectSessions(store, b, { peers: [a, b], harness })).toMatchObject({
        imported: 0,
        held: 0,
        unchanged: 1,
      });
      // Resumed: back, under b.
      writeFileSync(
        file,
        `${readFileSync(file, 'utf8')}\n${line(`m-${remove}`, `More (${remove})`)}`,
      );
      expect(await collectSessions(store, b, { peers: [a, b], harness })).toMatchObject({
        imported: 1,
        held: 0,
      });
      expect((await store.list()).map((x) => x.projectId)).toEqual(['b']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
