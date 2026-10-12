import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions, defaultExclusions, routeSession } from '../src/collector';
import { cwdRunTag, exemptRun, identityRunTags, RUN_TAGS } from '../src/exemption';
import { archiveSnapshotSchema } from '../src/index';
import { createArchiveHandler } from '../src/server';
import {
  PREFILTER,
  parseSuggestions,
  prefilter,
  runSuggestions,
  type SuggestionArchive,
  type SuggestModel,
  sessionDigest,
  suggestionKey,
} from '../src/suggest';
import { decisionEnvironment } from '../src/suggest-claude';
import { freshStore } from './db';

const token = 'synthetic-archive-test-token-0000000000';
const snapshot = (sessionId: string, extra: Record<string, unknown> = {}) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId,
    title: `Session ${sessionId}`,
    projectId: 'template',
    tags: [],
    capturedAt: 1_000,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [
      {
        id: 'u1',
        kind: 'user',
        text: 'Fix the flaky login test',
        timestamp: 1,
        sourceRef: 'line:1',
      },
      { id: 'a1', kind: 'assistant', text: 'Fixed the race.', timestamp: 2, sourceRef: 'line:2' },
    ],
    ...extra,
  });
const call = async (
  handler: ReturnType<typeof createArchiveHandler>,
  action: string,
  body: unknown,
) => {
  const response = await handler(
    new Request(`http://localhost/api/v1/archive/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as { data: Reply } };
};
type Reply = {
  archives: { archiveId: string }[];
  items: { archiveId: string; session: unknown }[];
  projects: string[];
  nextCursor: string | null;
};

test('identity rules exempt Foundry test fixtures, never a project ACP thread', () => {
  const run = (session: Partial<Parameters<typeof identityRunTags>[0]>) =>
    identityRunTags({ source: 'foundry', sessionId: 't1', tags: [], ...session });
  expect(run({ projectId: 'P' })).toEqual([RUN_TAGS.test]);
  expect(run({ source: 'claude-code', projectId: 'P' })).toEqual([RUN_TAGS.test]);
  expect(run({ sessionId: 'watch-A', projectId: 'foundry' })).toEqual([RUN_TAGS.test]);
  expect(run({ tags: ['acp', 'acp:t3-code'] })).toEqual([RUN_TAGS.test]);
  expect(run({ tags: ['acp:Paseo'], projectId: 'P' })).toEqual([RUN_TAGS.test]);
  expect(run({ tags: ['acp', 'acp:Paseo'], projectId: 'template' })).toEqual([]);
  expect(run({ sessionId: 'watch-C' })).toEqual([]);
  expect(run({ source: 'claude-code', sessionId: 'watch-A' })).toEqual([]);
  expect(exemptRun(['run:test', 'run:oracle'])).toBe('oracle');
  expect(exemptRun(['debugging'])).toBeUndefined();
});

test('working directories of tests, decisions, Oracle and bench runs carry a run tag', () => {
  const temp = realpathSync(tmpdir());
  expect(cwdRunTag(join(temp, 'native-text-controlled-abc'))).toBe(RUN_TAGS.test);
  expect(cwdRunTag('/private/tmp/claude-501/x/scratchpad')).toBe(RUN_TAGS.test);
  expect(cwdRunTag('/Users/me/scratchpad')).toBe(RUN_TAGS.test);
  expect(cwdRunTag('/w/foundry/.foundry/decision-receipts/primed-1/fixture')).toBe(RUN_TAGS.test);
  expect(cwdRunTag(join(homedir(), '.foundry/repeats/decision-receipts/p/fixture'))).toBe(
    RUN_TAGS.test,
  );
  expect(cwdRunTag(join(temp, 'oracle-historical-eval-x1'))).toBe(RUN_TAGS.oracle);
  expect(cwdRunTag('/w/oracle/.oracle/fixtures/f1')).toBe(RUN_TAGS.oracle);
  expect(cwdRunTag('/w/bench/.runs/r1/checkout')).toBe(RUN_TAGS.oracle);
  expect(cwdRunTag('/w/app/.runs/r1')).toBeUndefined();
  expect(cwdRunTag('/w/oracle')).toBeUndefined();
  expect(cwdRunTag('/w/template')).toBeUndefined();
  // Decision receipts anywhere stay out of broad matches, so catch-alls never capture them.
  const catchAll = {
    directory: '/h',
    source: 'claude-code' as const,
    projectRoots: [],
    projectId: 'unrouted',
    catchAll: true,
  };
  expect(
    routeSession('/Users/me/.foundry/repeats/decision-receipts/p', [catchAll], {
      exclude: defaultExclusions(),
    }),
  ).toBeUndefined();
  expect(routeSession('/Users/me/notes', [catchAll], { exclude: defaultExclusions() })).toBe(
    catchAll,
  );
});

test('a collector tags sessions from a test working directory it was told to collect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-run-'));
  const store = await freshStore();
  const root = join(realpathSync(tmpdir()), 'vcr-scenario-1');
  try {
    writeFileSync(
      join(dir, 's.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'c1', cwd: root } })}\n${JSON.stringify(
        {
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        },
      )}\n`,
    );
    const result = await collectSessions(store, {
      directory: dir,
      source: 'codex',
      projectRoots: [root],
      projectId: 'foundry',
    });
    expect(result.imported).toBe(1);
    expect(await store.list()).toEqual([]);
    expect((await store.list({ exempt: 'include' }))[0]!.tags).toEqual([RUN_TAGS.test]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exempt sessions filter out of list and search; removing the run tag lifts the exemption', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  const work = await store.capture(snapshot('work'));
  const fixture = await store.capture(snapshot('fixture', { source: 'foundry', projectId: 'P' }));
  const oracle = await store.capture(snapshot('eval', { tags: [RUN_TAGS.oracle] }));
  expect((await store.list({ exempt: 'include' })).find((a) => a.id === fixture.id)?.tags).toEqual([
    RUN_TAGS.test,
  ]);
  expect((await store.list()).map((a) => a.id)).toEqual([work.id]);
  expect((await store.list({ exempt: 'only' })).map((a) => a.id).sort()).toEqual(
    [fixture.id, oracle.id].sort(),
  );
  const found = await call(handler, 'search', { query: 'login' });
  expect(found.body.data.archives.map((a) => a.archiveId)).toEqual([work.id]);
  expect((await store.tag(fixture.id, { remove: [RUN_TAGS.test] })).tags).toEqual([]);
  expect((await store.list()).map((a) => a.id).sort()).toEqual([work.id, fixture.id].sort());
  expect((await store.tag(fixture.id, { add: [RUN_TAGS.test] })).tags).toEqual([RUN_TAGS.test]);
});

test('suggestions: due once per digest and key, never for exempt sessions, human edits win', async () => {
  const store = await freshStore();
  const handler = createArchiveHandler(store, token);
  await store.defineTag({ tag: 'debugging', description: 'Fixing a failure' });
  await store.defineTag({ tag: 'testing' });
  const work = await store.capture(snapshot('work'));
  const stray = await store.capture(snapshot('stray', { projectId: 'unrouted' }));
  await store.capture(snapshot('fixture', { source: 'foundry', projectId: 'P' }));
  const queue = await call(handler, 'suggestions/queue', { key: 'k1', limit: 10 });
  expect(queue.status).toBe(200);
  expect(queue.body.data.projects).toEqual(['template']);
  expect(queue.body.data.items.map((i) => i.archiveId)).toEqual([stray.id, work.id]);
  expect(queue.body.data.items[1].session).toMatchObject({
    title: 'Session work',
    counts: { prompts: 1, assistant: 1, toolCalls: 0 },
    prompts: ['Fix the flaky login test'],
  });
  const result = (archiveId: string, digest: string, tags: string[]) => ({
    archiveId,
    digest,
    key: 'k1',
    by: 'claude-haiku-5-5',
    tags,
  });
  // Tags the archive does not offer are dropped; a project only for a weakly routed session.
  expect(
    await store.recordSuggestions([
      result(work.id, work.digest, ['undefined-tag', 'project:template', 'debugging']),
      result(stray.id, stray.digest, ['project:nowhere']),
    ]),
  ).toEqual({ recorded: 2, stale: 0, refused: 0, dropped: 3 });
  expect((await store.list()).find((a) => a.id === work.id)!.suggestedTags).toEqual([
    { tag: 'debugging', origin: 'model' },
    { tag: 'testing', origin: 'heuristic' },
  ]);
  const recorded = await call(handler, 'suggestions/record', {
    results: [
      result(work.id, work.digest, ['debugging', 'testing']),
      result(stray.id, stray.digest, ['project:template']),
      result(stray.id, 'f'.repeat(64), []),
    ],
  });
  expect(recorded.body.data as unknown).toEqual({ recorded: 2, stale: 1, refused: 0, dropped: 0 });
  const listed = (await store.list()).find((a) => a.id === work.id)!;
  expect(listed.tags).toEqual([]);
  expect(listed.suggestedTags).toEqual([
    { tag: 'debugging', origin: 'model' },
    { tag: 'testing', origin: 'model' },
  ]);
  expect((await store.list({ suggestedTag: 'project:template' })).map((a) => a.id)).toEqual([
    stray.id,
  ]);
  expect(
    (await call(handler, 'suggestions/queue', { key: 'k1', limit: 10 })).body.data.items,
  ).toEqual([]);
  expect(
    (await call(handler, 'suggestions/queue', { key: 'k2', limit: 1 })).body.data.nextCursor,
  ).toBe(stray.id);
  // A person's edits win: applied tags leave the suggestions, removed ones never show.
  await store.tag(work.id, { add: ['testing'], remove: ['debugging'] });
  const edited = (await store.list()).find((a) => a.id === work.id)!;
  expect(edited.tags).toEqual(['testing']);
  expect(edited.suggestedTags).toEqual([]);
  // A new digest makes the session due again, and the old suggestions no longer show.
  await store.tag(work.id, { remove: ['testing'] });
  await store.recordSuggestions([result(work.id, work.digest, ['debugging', 'junk'])]);
  const grown = await store.capture({ ...snapshot('work'), capturedAt: 2_000, title: 'Longer' });
  expect((await store.list({ suggestedTag: 'junk' })).map((a) => a.id)).toEqual([]);
  const due = await store.suggestionQueue({ key: 'k1', limit: 10 });
  expect(due?.items.map((i) => [i.archiveId, i.digest])).toEqual([[work.id, grown.digest]]);
  // Exempt sessions are refused even when asked directly.
  const [fixture] = await store.list({ exempt: 'only' });
  expect(
    await store.recordSuggestions([
      { archiveId: fixture!.id, digest: fixture!.digest, key: 'k1', by: PREFILTER, tags: ['junk'] },
    ]),
  ).toEqual({ recorded: 0, stale: 0, refused: 1, dropped: 0 });
});

test('the prefilter settles empty sessions; digests stay bounded', () => {
  const empty = sessionDigest(
    snapshot('e', {
      entries: [
        {
          id: 'x',
          kind: 'event',
          text: '<command-name>/clear</command-name>',
          timestamp: 1,
          sourceRef: 'l',
        },
      ],
    }),
  );
  expect(prefilter(empty)).toEqual(['junk']);
  const aborted = sessionDigest(
    snapshot('a', {
      entries: [
        { id: 'u', kind: 'user', text: 'Refactor everything', timestamp: 1, sourceRef: 'l1' },
        {
          id: 'i',
          kind: 'user',
          text: '[Request interrupted by user]',
          timestamp: 2,
          sourceRef: 'l2',
        },
      ],
    }),
  );
  expect(prefilter(aborted)).toEqual(['junk']);
  const subagent = sessionDigest(
    snapshot('s/agent-1', {
      lineage: { kind: 'subagent', parentSessionId: 's', agentType: 'Explore' },
      entries: [
        { id: 't', kind: 'event', text: 'Find the retention code', timestamp: 1, sourceRef: 'l1' },
        {
          id: 'c',
          kind: 'tool-call',
          text: '{"name":"Grep","input":{}}',
          timestamp: 2,
          sourceRef: 'l2',
        },
      ],
    }),
  );
  expect(prefilter(subagent)).toBeUndefined();
  expect(subagent).toMatchObject({
    task: 'Find the retention code',
    tools: [['Grep', 1]],
    lineage: { kind: 'subagent', agentType: 'Explore' },
  });
  const long = sessionDigest(
    snapshot('l', {
      entries: Array.from({ length: 10 }, (_, i) => ({
        id: `u${i}`,
        kind: 'user',
        text: 'x'.repeat(5_000),
        timestamp: i,
        sourceRef: `l${i}`,
      })),
    }),
  );
  expect(long.prompts).toHaveLength(4);
  expect(long.prompts[0]!.length).toBeLessThanOrEqual(501);
  expect(long.counts.prompts).toBe(10);
});

test('answers keep only defined tags and listed projects for weakly routed sessions', () => {
  const digests = [
    sessionDigest(snapshot('a')),
    sessionDigest(snapshot('b', { projectId: 'unrouted' })),
    sessionDigest(snapshot('c')),
  ];
  const parsed = parseSuggestions(
    'Sure: {"S1": {"junk": false, "tags": ["debugging", "made-up"], "project": "template"}, "S2": {"junk": true, "tags": [], "project": "template"}}',
    digests,
    {
      tags: new Set(['debugging']),
      projects: new Set(['template']),
      weak: (d) => !d.projectId || d.projectId === 'unrouted',
    },
  );
  expect(parsed).toEqual([['debugging'], ['junk', 'project:template'], undefined]);
  expect(suggestionKey('m', [{ tag: 'a' }])).not.toBe(suggestionKey('m', [{ tag: 'b' }]));
  expect(suggestionKey('m', [{ tag: 'a' }])).not.toBe(suggestionKey('n', [{ tag: 'a' }]));
});

test('runSuggestions batches, splits failed batches, counts tokens and never re-asks unchanged sessions', async () => {
  const store = await freshStore();
  await store.defineTag({ tag: 'debugging' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) await store.capture(snapshot(id));
  await store.capture(
    snapshot('empty', {
      entries: [
        {
          id: 'x',
          kind: 'event',
          text: '<command-name>/clear</command-name>',
          timestamp: 1,
          sourceRef: 'l',
        },
      ],
    }),
  );
  await store.capture(snapshot('fixture', { source: 'foundry', projectId: 'P' }));
  const inputs: string[] = [];
  let fail = true;
  const model: SuggestModel = {
    model: 'fake-haiku',
    async decide({ input, context }) {
      expect(context).toContain('- debugging');
      expect(context).toContain('- template: ~/code/template');
      inputs.push(input);
      const sessions = input.match(/^## S\d+$/gm) ?? [];
      // The first four-session batch fails whole, so it is split in halves.
      if (fail && sessions.length === 4) {
        fail = false;
        throw new Error('rate limited');
      }
      const answer = Object.fromEntries(
        sessions.map((_, i) => [`S${i + 1}`, { junk: false, tags: ['debugging'], project: null }]),
      );
      return { content: JSON.stringify(answer), tokens: { input: 100, output: 10, cacheRead: 50 } };
    },
  };
  const archive: SuggestionArchive = {
    tagDefinitions: async () => ({ tags: await store.tagDefinitions() }),
    suggestionQueue: async (body) => (await store.suggestionQueue(body))!,
    recordSuggestions: (results) => store.recordSuggestions(results),
  };
  const report = await runSuggestions(archive, {
    model,
    batch: 4,
    concurrency: 1,
    projectLabels: { template: '~/code/template' },
  });
  expect(report).toMatchObject({
    model: 'fake-haiku',
    due: 6,
    prefiltered: 1,
    asked: 5,
    recorded: 6,
    stale: 0,
    refused: 0,
    unanswered: 0,
    calls: 4,
    failedCalls: 1,
    errors: { 'rate limited': 1 },
    tokens: { input: 300, output: 30, cacheRead: 150, cacheWrite: 0 },
    tags: { junk: 1, debugging: 5 },
  });
  expect(inputs.join('\n')).not.toContain('Session fixture');
  const again = await runSuggestions(archive, { model, batch: 4 });
  expect(again).toMatchObject({ due: 0, calls: 0 });
  const listed = await store.list({ suggestedTag: 'junk' });
  expect(listed.map((a) => [a.sessionId, a.suggestedTags])).toEqual([
    ['empty', [{ tag: 'junk', origin: 'heuristic' }]],
  ]);
});

test('decision processes get an allowlisted environment; Foundry events are never a task', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.example';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  try {
    const env = decisionEnvironment();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  }
  const foundry = sessionDigest(
    snapshot('t', {
      source: 'foundry',
      entries: [
        { id: 'e', kind: 'event', text: 'Status check', timestamp: 1, sourceRef: 'turn:1' },
        { id: 'f', kind: 'event', text: '{"status":"failed"}', timestamp: 2, sourceRef: 'turn:2' },
      ],
    }),
  );
  expect(foundry.task).toBeUndefined();
  expect(prefilter(foundry)).toEqual(['junk']);
});

test('a session captured before summaries held its digest is digested once from its snapshot', async () => {
  const store = await freshStore();
  const { id } = await store.capture(snapshot('old'));
  const row = await store.db.archive.findUniqueOrThrow({ where: { id } });
  const { session: _, ...summary } = row.summary as Record<string, unknown>;
  await store.db.archive.update({ where: { id }, data: { summary: summary as object } });
  const queue = await store.suggestionQueue({ key: 'k', limit: 5 });
  expect(queue?.items[0]?.session.prompts).toEqual(['Fix the flaky login test']);
  const after = await store.db.archive.findUniqueOrThrow({ where: { id } });
  expect((after.summary as { session?: unknown }).session).toBeDefined();
  expect((await store.list())[0]).not.toHaveProperty('session');
});
