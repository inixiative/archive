import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { machineProjectMap } from '../src/agents';
import { collectSessions, routeSession } from '../src/collector';
import {
  evidenceByOrganization,
  evidencedOrganizations,
  projectMapKey,
  sessionEvidence,
} from '../src/evidence';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import { freshStore } from './db';

const map = {
  projects: [
    { projectId: 'inixiative', roots: ['/w'], repositories: [] },
    { projectId: 'template', roots: ['/w/template'], repositories: ['inixiative/template'] },
    {
      projectId: 'zealot',
      roots: ['/z', '/private/tmp/zlt-review'],
      repositories: ['userevidence/zealot'],
    },
  ],
};
const routing = {
  organizations: [
    { id: 'inixiative', projects: ['inixiative', 'template'] },
    { id: 'userevidence', projects: ['zealot'] },
  ],
  destinations: [],
  publish: 'off' as const,
  cleanup: 'leaked' as const,
  cleanupFor: {},
  personalSpans: 'hold' as const,
};
const call = (name: string, input: object) => ({
  kind: 'tool-call' as const,
  text: JSON.stringify({ name, input }),
});
const snapshot = (entries: Pick<ArchiveEntry, 'kind' | 'text'>[], extra: object = {}) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId: 'evidence',
    title: 'Evidence',
    projectId: 'inixiative',
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: entries.map((entry, i) => ({
      ...entry,
      id: `e${i}`,
      timestamp: 1,
      sourceRef: `l${i}`,
    })),
    ...extra,
  });

test('evidence counts writes and reads per project at the kept entry before them; reads never count as writes', () => {
  const session = snapshot([
    call('Read', { file_path: '/z/README.md' }),
    { kind: 'user', text: 'Port the commit' },
    call('Edit', { file_path: 'template/a.ts' }),
    call('Bash', { command: 'gh pr create --repo userevidence/zealot --title x' }),
    { kind: 'assistant', text: 'Done: https://github.com/userevidence/zealot/pull/9' },
    call('Bash', { command: 'git -C /private/tmp/zlt-review commit -m x && ls /w' }),
    call('Write', { file_path: '/elsewhere/x' }),
  ]);
  const kept = new Set(['e1', 'e4']);
  const evidence = sessionEvidence(session, kept, map, '/w');
  expect(evidence).toMatchObject({
    cwd: '/w',
    startProjectId: 'inixiative',
    unattributedWrites: 1,
  });
  expect(evidence.anchors).toEqual([
    { entryId: 'e1', reads: { zealot: 1 }, writes: { template: 1, zealot: 1 } },
    { entryId: 'e4', writes: { zealot: 1 }, references: { 'userevidence/zealot': 1 } },
  ]);
  expect(evidenceByOrganization(evidence, routing, map, new Set(['e4']))).toEqual({
    userevidence: { writes: 1, reads: 0, references: 1 },
  });
  expect([...evidencedOrganizations(evidence, routing, map, new Set(['e4']))].sort()).toEqual([
    'inixiative',
    'userevidence',
  ]);
  // Without a working directory the project's first root stands in.
  expect(sessionEvidence(session, kept, map).cwd).toBe('/w');
});

test('evidence is computed at ingest before the strip, kept off the snapshot, and recomputed under a new project map', async () => {
  const store = await freshStore();
  await store.updateSettings({ captureToolCallsAndResults: false });
  const session = snapshot([
    { kind: 'user', text: 'Fix zealot' },
    call('Edit', { file_path: '/z/a.ts' }),
    { kind: 'tool-result', text: 'ok' },
    { kind: 'assistant', text: 'Fixed' },
  ]);
  // No map yet: nothing to compute against.
  const { id } = await store.capture(session, { cwd: '/z' });
  let row = await store.db.archive.findUniqueOrThrow({ where: { id } });
  expect(row.evidence).toBeNull();
  await store.setProjectMap(map);
  // The same snapshot again: no new revision, evidence filled in.
  const again = await store.capture(session, { cwd: '/z' });
  expect(again.changed).toBe(false);
  row = await store.db.archive.findUniqueOrThrow({ where: { id } });
  expect(row.evidence).toMatchObject({
    startProjectId: 'zealot',
    anchors: [{ entryId: 'e0', writes: { zealot: 1 } }],
  });
  expect((await store.head(id))?.evidenceKey).toBe(row.evidenceKey);
  const stored = (await store.read(id))!.snapshot;
  expect(stored.entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
  expect(Object.keys(stored)).not.toContain('evidence');
});

test('a collector sends the session’s cwd, and re-sends an unchanged session whose evidence predates the project map', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-evidence-')));
  const repo = join(dir, 'repo');
  const history = join(dir, 'history');
  mkdirSync(repo, { recursive: true });
  mkdirSync(history, { recursive: true });
  const store = await freshStore();
  try {
    const id = 'c5f0d7a3-7d6c-4c58-9b33-2f8a1c2d3e4f';
    writeFileSync(
      join(history, `${id}.jsonl`),
      [
        { sessionId: id, cwd: repo, type: 'user', uuid: 'u1', message: { content: 'Edit it' } },
        {
          sessionId: id,
          cwd: repo,
          type: 'assistant',
          uuid: 'a1',
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'touch src/x.ts' } },
            ],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
    const collector = {
      directory: history,
      source: 'claude-code' as const,
      projectId: 'repo',
      projectRoots: [repo],
    };
    await collectSessions(store, collector, { harness: () => undefined });
    const [listed] = await store.list({ exempt: 'include' });
    expect(
      (await store.db.archive.findUniqueOrThrow({ where: { id: listed!.id } })).evidence,
    ).toBeNull();
    await store.setProjectMap({
      projects: [{ projectId: 'repo', roots: [repo], repositories: [] }],
    });
    const second = await collectSessions(store, collector, { harness: () => undefined });
    expect(second.unchanged).toBe(1);
    const row = await store.db.archive.findUniqueOrThrow({ where: { id: listed!.id } });
    expect(row.evidence).toMatchObject({
      cwd: repo,
      startProjectId: 'repo',
      anchors: [{ entryId: expect.any(String), writes: { repo: 1 } }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repair computes evidence for Codex rollouts Codex archived, and for a session another project holds, keeping its project', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-evidence-codex-')));
  const repo = join(dir, 'repo');
  const moved = join(dir, 'old-checkout');
  const home = join(dir, 'codex');
  for (const d of [repo, moved, join(home, 'sessions'), join(home, 'archived_sessions')])
    mkdirSync(d, { recursive: true });
  const store = await freshStore();
  try {
    const rollout = (id: string, cwd: string) =>
      [
        { type: 'session_meta', payload: { id, cwd, timestamp: '2026-01-01T00:00:00Z' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Edit it' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'c1',
            arguments: JSON.stringify({ cmd: 'touch src/x.ts', workdir: repo }),
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n');
    const archived = '019a0000-0000-7000-8000-000000000001';
    writeFileSync(
      join(home, 'archived_sessions', `rollout-${archived}.jsonl`),
      rollout(archived, repo),
    );
    const heldId = '019a0000-0000-7000-8000-000000000002';
    writeFileSync(join(home, 'sessions', `rollout-${heldId}.jsonl`), rollout(heldId, moved));
    const collector = {
      directory: join(home, 'sessions'),
      source: 'codex' as const,
      projectId: 'repo',
      projectRoots: [repo],
    };
    // Its old checkout now routes elsewhere (on this machine, an old Desktop path routes to the
    // catch-all; temp directories never do, so here another project's root stands in).
    const elsewhere = {
      directory: join(home, 'sessions'),
      source: 'codex' as const,
      projectId: 'other',
      projectRoots: [moved],
    };
    // The held session was captured when its checkout still routed to `repo`.
    await collectSessions(
      store,
      { ...collector, projectRoots: [repo, moved] },
      { harness: () => undefined },
    );
    await store.setProjectMap({
      projects: [{ projectId: 'repo', roots: [repo], repositories: [] }],
    });
    const peers = [collector, elsewhere];
    for (const c of peers)
      await collectSessions(store, c, {
        peers,
        projects: [collector],
        harness: () => undefined,
        repair: true,
      });
    const rows = await store.db.archive.findMany({
      select: { projectId: true, evidence: true, summary: true },
    });
    const bySession = new Map(rows.map((r) => [(r.summary as { sessionId: string }).sessionId, r]));
    expect(bySession.get(archived)?.evidence).toMatchObject({ anchors: [{ writes: { repo: 1 } }] });
    expect(bySession.get(heldId)).toMatchObject({
      projectId: 'repo',
      evidence: { anchors: [{ writes: { repo: 1 } }] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formerRoots resolve a project’s old checkout paths for evidence, and move the map’s key; nothing collects from them', () => {
  const former = {
    projects: [
      {
        projectId: 'template',
        roots: ['/w/template'],
        formerRoots: ['/Users/me/Desktop/template'],
        repositories: [],
      },
    ],
  };
  const session = snapshot([call('Edit', { file_path: 'src/a.ts' })]);
  expect(
    sessionEvidence(session, new Set(['e0']), former, '/Users/me/Desktop/template').anchors,
  ).toEqual([{ entryId: 'e0', writes: { template: 1 } }]);
  expect(projectMapKey(former)).not.toBe(
    projectMapKey({ projects: [{ ...former.projects[0]!, formerRoots: [] }] }),
  );
  expect(
    machineProjectMap({
      collectors: [
        {
          name: 'claude-code.template',
          source: 'claude-code',
          directory: '/h',
          projectId: 'template',
          projectRoots: ['/w/template'],
          formerRoots: ['/Users/me/Desktop/template'],
        },
      ],
    }).projects[0],
  ).toMatchObject({ roots: ['/w/template'], formerRoots: ['/Users/me/Desktop/template'] });
  expect(
    routeSession('/Users/me/Desktop/template', [
      {
        directory: '/h',
        source: 'claude-code',
        projectId: 'template',
        projectRoots: ['/w/template'],
      },
    ]),
  ).toBeUndefined();
});
