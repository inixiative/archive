import { expect, test } from 'bun:test';
import { agentUnits } from '../src/agents';
import type { Routing } from '../src/config';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import { type RoutingArchive, routeKey, runBackfill, runRouting } from '../src/route';
import type { SuggestModel } from '../src/suggest';
import { freshStore } from './db';

const routing: Routing = {
  organizations: [{ id: 'inixiative', projects: ['template'] }],
  destinations: [],
  publish: 'off',
  cleanup: 'leaked',
  cleanupFor: {},
  personalSpans: 'hold',
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
        // The second entry stands for the call that spawns this session's subagents.
        ...(i === 1 ? { callId: `spawn-${sessionId}` } : {}),
        kind: i % 2 ? 'assistant' : 'user',
        text: `turn ${i}`,
        timestamp: i,
        sourceRef: `l${i}`,
      }),
    ),
    ...extra,
  });
/** Plans everything shown as one inixiative part (the start directory is evidence). */
/** The sensitivity pass's answer when it finds nothing. */
const CLEAN_CHECK = '{"hold": false, "redactions": []}';
const model: SuggestModel = {
  model: 'claude-sonnet-5-5',
  async decide({ key, input }) {
    if (key === 'archive-sensitivity') return { content: CLEAN_CHECK };
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
    routingInput: (b) => store.routingInput(b.archiveId, routing, b.key),
    recordPlan: (b) => store.recordPlan(b, routing),
    routingDue: (b) => store.routingDue(b),
  };
  const due = async (options: Parameters<typeof store.routingDue>[0]) =>
    (await store.routingDue(options)).map(({ archiveId, reason }) => ({ archiveId, reason }));
  const t0 = 1_800_000_000_000;
  const { id } = await store.capture(session('a', 2), { cwd: '/w/template' });
  const { id: child } = await store.capture(
    session('a/agent-x', 2, {
      lineage: { kind: 'subagent', parentSessionId: 'a', rootSessionId: 'a', toolUseId: 'spawn-a' },
    }),
    { cwd: '/w/template' },
  );
  await store.capture(session('probe', 2, { tags: ['run:test'] }), { cwd: '/w/template' });
  // The subagent waits for its parent; the run is never planned.
  expect(await due({ now: t0, limit: 10 })).toEqual([{ archiveId: id, reason: 'unplanned' }]);
  const first = await runRouting(archive, model, { limit: 10 });
  expect(first).toMatchObject({ due: 1, valid: 1 });
  expect(await due({ now: Date.now(), limit: 10 })).toEqual([
    { archiveId: child, reason: 'unplanned' },
  ]);
  await runRouting(archive, model);
  // The subagent's plan makes its parent due once (entries quoting it may move), re-applied with
  // no model call; then nothing is due, parts included.
  expect((await due({ now: Date.now(), limit: 10 })).map((d) => d.reason)).toEqual(['related']);
  await runRouting(archive, model);
  expect(await due({ now: Date.now() + 10 * 3_600_000, limit: 10 })).toEqual([]);
  // New entries: due once paused, or once the hour (plus its stagger) has passed.
  const grown = session('a', 4);
  grown.capturedAt = Date.now();
  await store.capture(grown, { cwd: '/w/template' });
  const plannedAt = (await store.db.routingPlan.findUniqueOrThrow({ where: { archiveId: id } })).at;
  expect(await due({ now: grown.capturedAt + 60_000, limit: 10 })).toEqual([]);
  expect(await due({ now: grown.capturedAt + 31 * 60_000, limit: 10 })).toEqual([
    { archiveId: id, reason: 'new entries, paused' },
  ]);
  expect(await due({ now: plannedAt + 71 * 60_000, pausedMs: 10 * 3_600_000, limit: 10 })).toEqual([
    { archiveId: id, reason: 'new entries' },
  ]);
  // A person's route: decision makes it due at once.
  await store.tag(child, { add: ['route:personal'] });
  expect((await due({ now: Date.now(), limit: 10 })).map((d) => d.reason)).toContain('decision');
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

test('a backfill dry run plans every session, subagents against their parent’s dry-run plan, stores nothing, and reports what changes against what destinations hold', async () => {
  const store = await freshStore();
  const routed: Routing = {
    organizations: [
      { id: 'inixiative', projects: ['template'] },
      { id: 'userevidence', projects: ['zealot'] },
    ],
    destinations: [
      {
        kind: 'archive',
        organizationId: 'userevidence',
        url: 'https://ue.example/',
        tokenEnv: 'UE_TOKEN',
      },
    ],
    publish: 'off',
    cleanup: 'leaked',
    cleanupFor: {},
    personalSpans: 'hold',
  };
  await store.setProjectMap({
    projects: [
      { projectId: 'template', roots: ['/w/template'], repositories: [] },
      { projectId: 'zealot', roots: ['/z'], repositories: [] },
    ],
  });
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, routed, b.key),
    recordPlan: (b) => store.recordPlan(b, routed),
    routingDue: (b) => store.routingDue(b),
  };
  // The leak: a template session UserEvidence holds whole.
  const { id: leaked, digest } = await store.capture(session('leaked', 2), { cwd: '/w/template' });
  await store.delivered(leaked, JSON.stringify(['https://ue.example', '/', 'standalone']), digest);
  const { id: root } = await store.capture(session('root', 2), { cwd: '/z' });
  const { id: child } = await store.capture(
    session('root/agent-x', 2, {
      lineage: {
        kind: 'subagent',
        parentSessionId: 'root',
        rootSessionId: 'root',
        toolUseId: 'spawn-root',
      },
    }),
    { cwd: '/z' },
  );
  const answers: Record<string, string[]> = {
    leaked: ['personal'],
    root: ['userevidence'],
    'root/agent-x': ['userevidence'],
  };
  const planner: SuggestModel = {
    model: 'claude-sonnet-5-5',
    async decide({ key, input }) {
      if (key === 'archive-sensitivity') return { content: CLEAN_CHECK };
      const title = input.match(/^title: (.+)$/m)![1]!;
      return {
        content: JSON.stringify({ parts: [{ from: 0, to: 1, organizations: answers[title] }] }),
      };
    },
  };
  const dry = await runBackfill(archive, planner, { dryRun: true });
  expect(dry).toMatchObject({ dryRun: true, due: 3, valid: 3, held: 0 });
  expect(dry.rows.find((r) => r.archiveId === leaked)).toMatchObject({
    holds: ['userevidence'],
    deletes: ['userevidence'],
    adds: [],
  });
  expect(dry.rows.find((r) => r.archiveId === child)).toMatchObject({
    status: 'valid',
    adds: ['userevidence'],
  });
  expect(dry.moves).toEqual({ 'userevidence → personal': 1, 'nowhere → userevidence': 2 });
  expect(await store.db.routingPlan.count()).toBe(0);
  expect(await store.list({ exempt: 'include', parts: 'only' })).toEqual([]);
  // Applied, parents first, pass after pass.
  const applied = await runBackfill(archive, planner);
  expect(applied).toMatchObject({ dryRun: false, valid: 3 });
  expect((await store.list({ exempt: 'include', parts: 'only' })).map((p) => p.routedTo)).toEqual([
    ['userevidence'],
    ['userevidence'],
  ]);
  expect(root).toBeDefined();
});

test('S4: a change to the organizations or the project map makes plans due to re-validate their parts', async () => {
  const store = await freshStore();
  await store.setProjectMap(map);
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, routing, b.key),
    recordPlan: (b) => store.recordPlan(b, routing),
    routingDue: (b) => store.routingDue(b),
  };
  const { id } = await store.capture(session('ctx', 2), { cwd: '/w/template' });
  await runRouting(archive, model);
  const key = await store.routingContextKey(routing);
  expect(await store.routingDue({ limit: 10, contextKey: key })).toEqual([]);
  const moved = await store.routingContextKey({
    ...routing,
    organizations: [{ id: 'inixiative', projects: [] }],
  });
  expect(await store.routingDue({ limit: 10, contextKey: moved })).toEqual([
    { archiveId: id, reason: 'context', depth: 0 },
  ]);
});

test('a long session plans one window a pass and stays due; a new worktree does not change the project map’s key', async () => {
  const store = await freshStore();
  await store.setProjectMap(map);
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, routing, b.key),
    recordPlan: (b) => store.recordPlan(b, routing),
    routingDue: (b) => store.routingDue(b),
  };
  const long = session('long', 2);
  long.entries[0]!.text = 'first window words '.repeat(11_000);
  long.entries[1]!.text = 'second window words '.repeat(11_000);
  const { id } = await store.capture(long, { cwd: '/w/template' });
  // A planner call and the sensitivity pass's call for its one work part.
  const first = await runRouting(archive, model);
  expect(first).toMatchObject({ calls: 2, valid: 1 });
  expect(await store.routingDue({ limit: 10 })).toEqual([
    { archiveId: id, reason: 'partial', depth: 0 },
  ]);
  expect(await runRouting(archive, model)).toMatchObject({ calls: 2, valid: 1 });
  expect(await store.routingDue({ limit: 10 })).toEqual([]);
  const [part] = await store.list({ exempt: 'include', parts: 'only' });
  expect(part?.entries).toBe(2);
  // Worktrees resolve, but don't move the key evidence and plans recorded.
  const before = await store.projectMapKey();
  await store.setProjectMap({
    projects: [{ ...map.projects[0]!, worktrees: ['/w/template/.worktrees/new'] }],
  });
  expect(await store.projectMapKey()).toBe(before);
});

test('a new planner charter or model makes every plan due', async () => {
  const store = await freshStore();
  await store.setProjectMap(map);
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, routing, b.key),
    recordPlan: (b) => store.recordPlan(b, routing),
    routingDue: (b) => store.routingDue(b),
  };
  const { id } = await store.capture(session('charter', 2), { cwd: '/w/template' });
  await runRouting(archive, model);
  expect(await store.routingDue({ limit: 10, planKey: routeKey(model.model) })).toEqual([]);
  expect(await store.routingDue({ limit: 10, planKey: routeKey('claude-sonnet-6') })).toEqual([
    { archiveId: id, reason: 'charter', depth: 0 },
  ]);
});

test('a new charter re-plans with the model from the first entry, over passes, keeping sticky redactions; the old plan publishes until it is done', async () => {
  const store = await freshStore();
  await store.setProjectMap(map);
  // Redacting, so the coworker remark publishes redacted rather than holding its part.
  const redacting: Routing = { ...routing, personalSpans: 'redact' };
  const archive: RoutingArchive = {
    routingInput: (b) => store.routingInput(b.archiveId, redacting, b.key),
    recordPlan: (b) => store.recordPlan(b, redacting),
    routingDue: (b) => store.routingDue(b),
  };
  const long = session('retuned', 2);
  long.entries[0]!.text = `${'first window words '.repeat(11_000)} Grant is useless`;
  long.entries[1]!.text = 'second window words '.repeat(11_000);
  const { id } = await store.capture(long, { cwd: '/w/template' });
  // Under the old charter: two windows, the first redacting a coworker remark.
  const seen: string[] = [];
  const planner = (name: string): SuggestModel => ({
    model: name,
    async decide({ key, input }) {
      if (key === 'archive-sensitivity') return { content: CLEAN_CHECK };
      seen.push(`${name} ${input.match(/## New entries \(E(\d+)/)![1]}`);
      const range = input.match(/## New entries \(E(\d+)–E(\d+)/)!;
      const from = Number(range[1]);
      return {
        content: JSON.stringify({
          parts: [
            { from, to: Number(range[2]), organizations: ['inixiative'], continues: from > 0 },
          ],
          redactions:
            from === 0 && name === 'old'
              ? [{ entry: 0, text: 'Grant is useless', reason: 'coworker' }]
              : [],
        }),
      };
    },
  });
  await runRouting(archive, planner('old'));
  await runRouting(archive, planner('old'));
  expect(await store.routingDue({ limit: 10, planKey: routeKey('old') })).toEqual([]);
  // A new charter: due, re-planned from E0 with the new model, one window a pass.
  expect((await runRouting(archive, planner('new'))).calls).toBe(2);
  // Mid-rebuild, the old plan still publishes.
  const [mid] = await store.list({ exempt: 'include', parts: 'only' });
  expect(mid?.entries).toBe(2);
  expect((await store.db.routingPlan.findUniqueOrThrow({ where: { archiveId: id } })).key).toBe(
    routeKey('old'),
  );
  await runRouting(archive, planner('new'));
  expect(seen).toEqual(['old 0', 'old 1', 'new 0', 'new 1']);
  const plan = await store.db.routingPlan.findUniqueOrThrow({ where: { archiveId: id } });
  expect(plan.key).toBe(routeKey('new'));
  expect(await store.routingDue({ limit: 10, planKey: routeKey('new') })).toEqual([]);
  const [part] = await store.list({ exempt: 'include', parts: 'only' });
  const text = (await store.read(part!.id))!.snapshot.entries.map((e) => e.text).join('');
  expect(text).not.toContain('Grant is useless');
});
