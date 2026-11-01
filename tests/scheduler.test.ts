import { expect, test } from 'bun:test';
import { agentUnits } from '../src/agents';
import type { Routing } from '../src/config';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import { type RoutingArchive, runRouting } from '../src/route';
import type { SuggestModel } from '../src/suggest';
import { freshStore } from './db';

const routing: Routing = {
  organizations: [{ id: 'inixiative', projects: ['template'] }],
  destinations: [],
};
const map = { projects: [{ projectId: 'template', roots: ['/w/template'], repositories: [] }] };
const session = (sessionId: string, n: number, extra: Record<string, unknown> = {}) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId,
    title: sessionId,
    projectId: 'template',
    tags: [],
    capturedAt: n,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: Array.from(
      { length: n },
      (_, i): ArchiveEntry => ({
        id: `${sessionId}-${i}`,
        kind: i % 2 ? 'assistant' : 'user',
        text: `turn ${i}`,
        timestamp: i,
        sourceRef: `l${i}`,
      }),
    ),
    ...extra,
  });
/** Plans everything shown as one inixiative part (the start directory is evidence). */
const model: SuggestModel = {
  model: 'claude-sonnet-5-5',
  async decide({ input }) {
    const range = input.match(/## New entries \(E(\d+)–E(\d+)/)!;
    return {
      content: JSON.stringify({
        parts: [
          {
            from: Number(range[1]),
            to: Number(range[2]),
            organizations: ['inixiative'],
            continues: true,
          },
        ],
        rationale: 'template work',
      }),
    };
  },
};

test('due sessions: unplanned now; with new entries once paused or an hour (staggered) after their plan; subagents after their parent; never runs or parts', async () => {
  const store = await freshStore();
  await store.setProjectMap(map);
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, routing),
    recordPlan: (b) => store.recordPlan(b, routing),
    routingDue: (b) => store.routingDue(b),
  };
  const t0 = 1_800_000_000_000;
  const { id } = await store.capture(session('a', 2), { cwd: '/w/template' });
  const { id: child } = await store.capture(
    session('a/agent-x', 2, {
      lineage: { kind: 'subagent', parentSessionId: 'a', rootSessionId: 'a' },
    }),
    { cwd: '/w/template' },
  );
  await store.capture(session('probe', 2, { tags: ['run:test'] }), { cwd: '/w/template' });
  // The subagent waits for its parent; the run is never planned.
  expect(await store.routingDue({ now: t0, limit: 10 })).toEqual([
    { archiveId: id, reason: 'unplanned' },
  ]);
  const first = await runRouting(archive, model, { limit: 10 });
  expect(first).toMatchObject({ due: 1, valid: 1 });
  expect(await store.routingDue({ now: Date.now(), limit: 10 })).toEqual([
    { archiveId: child, reason: 'unplanned' },
  ]);
  await runRouting(archive, model);
  // Planned and unchanged: nothing is due, parts included.
  expect(await store.routingDue({ now: Date.now() + 10 * 3_600_000, limit: 10 })).toEqual([]);
  // New entries: due once paused, or once the hour (plus its stagger) has passed.
  const grown = session('a', 4);
  grown.capturedAt = Date.now();
  await store.capture(grown, { cwd: '/w/template' });
  const plannedAt = (await store.db.routingPlan.findUniqueOrThrow({ where: { archiveId: id } })).at;
  expect(await store.routingDue({ now: grown.capturedAt + 60_000, limit: 10 })).toEqual([]);
  expect(await store.routingDue({ now: grown.capturedAt + 31 * 60_000, limit: 10 })).toEqual([
    { archiveId: id, reason: 'new entries, paused' },
  ]);
  expect(
    await store.routingDue({ now: plannedAt + 71 * 60_000, pausedMs: 10 * 3_600_000, limit: 10 }),
  ).toEqual([{ archiveId: id, reason: 'new entries' }]);
  // A person's route: decision makes it due at once.
  await store.tag(child, { add: ['route:personal'] });
  expect((await store.routingDue({ now: Date.now(), limit: 10 })).map((d) => d.reason)).toContain(
    'decision',
  );
  const report = await runRouting(archive, model, { limit: 10 });
  expect(report.sessions.find((s) => s.archiveId === child)?.status).toBe('valid');
  // The decision narrowed the subagent to personal: it publishes nothing.
  const parts = await store.list({ exempt: 'include', parts: 'only' });
  expect(parts.map((p) => p.lineage?.parentSessionId)).toEqual(['a']);
});

test('the router is a unit beside the collectors when declared, with the Claude CLI named in full', () => {
  const config = { collectors: [], router: { concurrency: 3 } };
  const [unit] = agentUnits(config, {
    home: '/h',
    execPath: '/bun',
    cliPath: '/cli.ts',
    claudeBin: '/opt/claude',
  });
  expect(unit?.label).toBe('com.inixiative.archive.route');
  expect(unit?.args).toEqual([
    '/bun',
    '/cli.ts',
    'route',
    '--watch',
    '--claude-bin',
    '/opt/claude',
    '--concurrency',
    '3',
    '--home',
    '/h',
  ]);
  expect(agentUnits({ collectors: [] }, { home: '/h' })).toEqual([]);
});
