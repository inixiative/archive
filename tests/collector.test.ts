import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CollectionSource,
  type CollectorCache,
  collectionRoots,
  collectSessions,
  routeSession,
} from '../src/collector';
import { importTranscript } from '../src/import';
import { importTranscriptFile } from '../src/import-file';
import { freshStore } from './db';

test('collector matches exact provider cwd, retries partial files and keeps manual tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-collect-'));
  const root = '/work/inixiative';
  const rows = (id: string, cwd: string, text = 'Fix regression') =>
    [
      { type: 'session_meta', payload: { id, cwd } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';
  const store = await freshStore();
  const config = {
    directory: dir,
    source: 'codex' as const,
    projectRoots: [root],
    projectId: 'inixiative',
    tags: ['coding'],
  };
  try {
    writeFileSync(join(dir, 'wanted.jsonl'), rows('wanted', root));
    writeFileSync(join(dir, 'ue.jsonl'), rows('ue', '/work/ue'));
    writeFileSync(join(dir, 'nested.jsonl'), rows('nested', root + '/other-checkout'));
    writeFileSync(join(dir, 'partial.jsonl'), rows('partial', root) + '{');
    symlinkSync(join(dir, 'ue.jsonl'), join(dir, 'linked.jsonl'));
    const first = await collectSessions(store, config);
    expect(first).toEqual({ imported: 1, unchanged: 0, failed: 1, skipped: 2 });
    const id = (await await store.list())[0].id;
    await await store.tag(id, { add: ['manually-reviewed'] });
    writeFileSync(join(dir, 'partial.jsonl'), rows('partial', root));
    writeFileSync(join(dir, 'wanted.jsonl'), rows('wanted', root, 'More work'));
    const next = await collectSessions(store, config);
    expect(next.imported).toBe(2);
    expect((await await store.list()).find((a) => a.id === id)?.tags).toEqual([
      'coding',
      'manually-reviewed',
    ]);
    expect(await await store.list()).toHaveLength(2);
    expect((await collectSessions(store, config)).unchanged).toBe(2);
    expect((await collectSessions(store, { ...config, projectId: 'personal' })).failed).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude cwd metadata is collected without treating a destination name in text as routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-claude-'));
  const store = await freshStore();
  try {
    writeFileSync(
      join(dir, 'session.jsonl'),
      JSON.stringify({
        sessionId: 'claude-1',
        cwd: '/work/ue',
        gitBranch: 'feat/tags',
        type: 'user',
        uuid: 'msg-1',
        message: { content: 'Please share this with personal' },
      }),
    );
    const result = await collectSessions(store, {
      directory: dir,
      source: 'claude-code',
      projectId: 'userevidence',
      projectRoots: ['/work/ue'],
    });
    expect(result.imported).toBe(1);
    expect((await store.list())[0].projectId).toBe('userevidence');
    // A branch without a GitHub repository references no integration.
    expect((await store.list())[0].tags).toEqual([]);
    expect((await store.list())[0].references).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('several exact roots and their git worktrees collect into one project; nested checkouts do not', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-worktrees-')));
  const repo = join(dir, 'foundry');
  const worktree = join(dir, 'foundry-feature');
  const history = join(dir, 'history');
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(['git', '-C', repo, ...args], { stderr: 'ignore' }).success).toBe(true);
  const store = await freshStore();
  try {
    mkdirSync(repo);
    mkdirSync(history);
    git('init', '-q');
    git(
      '-c',
      'user.email=a@b.c',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    git('worktree', 'add', '-q', worktree);
    const session = (id: string, cwd: string) =>
      writeFileSync(
        join(history, `${id}.jsonl`),
        JSON.stringify({
          sessionId: id,
          cwd,
          type: 'user',
          uuid: `${id}-1`,
          message: { content: 'Work' },
        }),
      );
    session('main', repo);
    session('feature', worktree);
    session('second', '/work/second-checkout');
    session('nested', join(repo, 'packages/core'));
    const config = {
      directory: history,
      source: 'claude-code' as const,
      projectRoots: [repo, '/work/second-checkout'],
      projectId: 'foundry',
    };
    expect(collectionRoots(config)).toEqual(new Set([repo, '/work/second-checkout']));
    expect(await collectSessions(store, config)).toEqual({
      imported: 2,
      unchanged: 0,
      skipped: 2,
      failed: 0,
    });
    expect(await collectSessions(store, { ...config, worktrees: true })).toEqual({
      imported: 1,
      unchanged: 2,
      skipped: 1,
      failed: 0,
    });
    expect(new Set((await store.list()).map((archive) => archive.projectId))).toEqual(
      new Set(['foundry']),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stored session titled with injected content is retitled on the next scan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-retitle-'));
  const store = await freshStore();
  const caveat =
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>';
  const file = join(dir, 'session.jsonl');
  const config = {
    directory: dir,
    source: 'claude-code' as const,
    projectId: 'inixiative',
    projectRoots: ['/work/archive'],
  };
  try {
    writeFileSync(
      file,
      [
        { uuid: 'caveat', isMeta: true, message: { role: 'user', content: caveat } },
        { uuid: 'typed', message: { role: 'user', content: 'Retitle old sessions' } },
      ]
        .map((row) =>
          JSON.stringify({ sessionId: 'retitled', cwd: '/work/archive', type: 'user', ...row }),
        )
        .join('\n'),
    );
    const imported = importTranscriptFile(file, {
      source: 'claude-code',
      sourceId: await store.sourceId(),
      projectId: 'inixiative',
    });
    await store.capture({ ...imported, title: caveat, capturedAt: 1 });
    expect(await collectSessions(store, config)).toMatchObject({ imported: 1 });
    const [listed] = await store.list();
    expect(listed).toMatchObject({ title: 'Retitle old sessions', revision: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unchanged session is not sent again, and an untouched file is not read again', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-unchanged-')));
  // A checkout with a GitHub remote, so the snapshot gains references after import.
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  for (const args of [
    ['init', '-q'],
    ['remote', 'add', 'origin', 'https://github.com/inixiative/archive.git'],
  ])
    expect(Bun.spawnSync(['git', '-C', repo, ...args]).success).toBe(true);
  const store = await freshStore();
  const calls = { head: 0, capture: 0 };
  const writer = {
    sourceId: () => store.sourceId(),
    head: (id: string) => {
      calls.head++;
      return store.head(id);
    },
    capture: (snapshot: unknown) => {
      calls.capture++;
      return store.capture(snapshot);
    },
  };
  const session = (id: string, text: string) =>
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({
        sessionId: id,
        cwd: repo,
        type: 'user',
        uuid: `${id}-1`,
        message: { content: text },
      }),
    );
  const config = {
    directory: dir,
    source: 'claude-code' as const,
    projectId: 'a',
    projectRoots: [repo],
  };
  const harness = () => 'subscription' as const;
  try {
    session('one', 'First');
    session('two', 'Second');
    expect(await collectSessions(writer, config, { harness })).toMatchObject({ imported: 2 });
    expect((await store.list())[0]!.references).toEqual([
      expect.objectContaining({ integration: 'github' }),
    ]);
    expect(calls.capture).toBe(2);
    // A restarted collector compares digests: nothing is sent.
    const cache: CollectorCache = new Map();
    expect(await collectSessions(writer, config, { harness, cache })).toMatchObject({
      unchanged: 2,
    });
    expect(calls).toEqual({ head: 4, capture: 2 });
    // A watching collector skips files whose size and mtime have not moved.
    expect(await collectSessions(writer, config, { harness, cache })).toMatchObject({
      unchanged: 2,
    });
    expect(calls).toEqual({ head: 4, capture: 2 });
    session('two', 'Second, edited');
    expect(await collectSessions(writer, config, { harness, cache })).toMatchObject({
      imported: 1,
      unchanged: 1,
    });
    expect(calls.capture).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the longest root wins; subdirectories, exclusions and the catch-all route the rest', async () => {
  const inixiative: CollectionSource = {
    directory: '/h',
    source: 'claude-code',
    projectId: 'inixiative',
    projectRoots: ['/w'],
    subdirectories: true,
  };
  const kingdom = { ...inixiative, projectId: 'kingdom', projectRoots: ['/w/kingdom'] };
  const tribe = {
    ...inixiative,
    projectId: 'tribe',
    projectRoots: ['/w/tribe'],
    subdirectories: false,
  };
  const fixtures = {
    ...inixiative,
    projectId: 'fixtures',
    projectRoots: ['/tmp/fixture'],
    subdirectories: false,
  };
  const unrouted = {
    ...inixiative,
    projectId: 'unrouted',
    projectRoots: [],
    catchAll: true,
    subdirectories: false,
  };
  const peers = [inixiative, kingdom, tribe, fixtures, unrouted];
  const route = (cwd: string) =>
    routeSession(cwd, peers, { exclude: ['/tmp', '.foundry/decision-receipts'] })?.projectId;
  expect(route('/w')).toBe('inixiative');
  expect(route('/w/kingdom')).toBe('kingdom');
  expect(route('/w/kingdom/apps/api')).toBe('kingdom');
  expect(route('/w/kingdomish')).toBe('inixiative');
  expect(route('/w/tribe')).toBe('tribe');
  // An exact-only root claims no subdirectories; the broader root does.
  expect(route('/w/tribe/apps')).toBe('inixiative');
  expect(route('/elsewhere')).toBe('unrouted');
  // Exclusions stop subdirectory and catch-all matches; an exact root is explicit.
  expect(route('/tmp/probe')).toBeUndefined();
  expect(route('/tmp/fixture')).toBe('fixtures');
  expect(route('/w/foundry/.foundry/decision-receipts/r1')).toBeUndefined();

  const dir = mkdtempSync(join(tmpdir(), 'archive-route-'));
  const store = await freshStore();
  try {
    const session = (id: string, cwd: string) =>
      writeFileSync(
        join(dir, `${id}.jsonl`),
        JSON.stringify({
          sessionId: id,
          cwd,
          type: 'user',
          uuid: `${id}-1`,
          message: { content: 'Work' },
        }),
      );
    session('k', '/w/kingdom/apps/api');
    session('i', '/w/notes');
    session('u', '/elsewhere');
    session('t', '/tmp/probe');
    const options = {
      peers: [inixiative, kingdom, unrouted].map((c) => ({ ...c, directory: dir })),
      exclude: ['/tmp'],
    };
    const [i, k, u] = options.peers as [CollectionSource, CollectionSource, CollectionSource];
    expect(await collectSessions(store, k, options)).toMatchObject({ imported: 1, skipped: 3 });
    expect(await collectSessions(store, i, options)).toMatchObject({ imported: 1, skipped: 3 });
    expect(await collectSessions(store, u, options)).toMatchObject({ imported: 1, skipped: 3 });
    expect(new Set((await store.list()).map((a) => `${a.sessionId}:${a.projectId}`))).toEqual(
      new Set(['k:kingdom', 'i:inixiative', 'u:unrouted']),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex subagent rollout is its own session, with its parent as lineage', () => {
  const child = '01a073a0-498b-7db2-99e3-4339c7d0058d';
  const parent = '01a0739f-c6d1-7160-a8ea-d2a555776324';
  const rows = [
    {
      type: 'session_meta',
      payload: {
        id: child,
        forked_from_id: parent,
        cwd: '/w',
        originator: 'Codex Desktop',
        model_provider: 'openai',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parent,
              depth: 1,
              agent_nickname: 'Gibbs',
              agent_role: 'reviewer',
            },
          },
        },
      },
    },
    {
      type: 'session_meta',
      payload: { id: parent, cwd: '/w', originator: 'Codex Desktop', source: 'vscode' },
    },
    { type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'high' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Review this' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done' }],
      },
    },
    { type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'pro' } } },
  ];
  const snapshot = importTranscript(rows.map((r) => JSON.stringify(r)).join('\n'), {
    source: 'codex',
    sourceId: crypto.randomUUID(),
  });
  expect(snapshot.sessionId).toBe(child);
  expect(snapshot.lineage).toEqual({
    kind: 'subagent',
    parentSessionId: parent,
    agentType: 'reviewer',
    agentName: 'Gibbs',
    depth: 1,
  });
  expect(snapshot.runtime).toEqual({
    provider: 'openai',
    accessPath: 'subscription',
    evidence: 'transcript',
  });
  // The parent's meta does not make the subagent's prompt a typed one.
  expect(snapshot.entries.map((e) => e.kind)).toEqual(['event', 'assistant']);
  expect(snapshot.entries[1]).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
  // Two unrelated sessions in one file are still refused.
  const [, second] = rows;
  expect(() =>
    importTranscript(
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'a', cwd: '/w' } }),
        JSON.stringify(second),
      ].join('\n'),
      {
        source: 'codex',
        sourceId: crypto.randomUUID(),
      },
    ),
  ).toThrow('identity mismatch');
});

test('Claude subagent runs carry lineage from meta.json; runtime is tagged and filterable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-subagent-'));
  const store = await freshStore();
  const parent = 'c100a93c-aa39-490b-b4da-02e6c8c8108d';
  try {
    mkdirSync(join(dir, parent, 'subagents'), { recursive: true });
    const row = (extra: object) =>
      JSON.stringify({ sessionId: parent, cwd: '/work/a', uuid: crypto.randomUUID(), ...extra });
    writeFileSync(
      join(dir, `${parent}.jsonl`),
      [
        row({ type: 'user', message: { content: 'Plan it' } }),
        row({
          type: 'assistant',
          effort: 'medium',
          message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Ok' }] },
        }),
        row({
          type: 'assistant',
          quotaLimits: { rateLimitType: 'five_hour', status: 'rejected' },
          message: { model: '<synthetic>', content: [{ type: 'text', text: 'Limit' }] },
        }),
      ].join('\n'),
    );
    const agent = join(dir, parent, 'subagents', 'agent-a0802a504cb2dd9ca');
    writeFileSync(
      `${agent}.jsonl`,
      [
        row({
          type: 'user',
          isSidechain: true,
          agentId: 'a0802a504cb2dd9ca',
          message: { content: 'Review it' },
        }),
        row({
          type: 'assistant',
          isSidechain: true,
          agentId: 'a0802a504cb2dd9ca',
          effort: 'high',
          message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Reviewed' }] },
        }),
      ].join('\n'),
    );
    writeFileSync(
      `${agent}.meta.json`,
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Adversarial review',
        toolUseId: 'toolu_1',
        spawnDepth: 1,
      }),
    );
    const config = {
      directory: dir,
      source: 'claude-code' as const,
      projectId: 'a',
      projectRoots: ['/work/a'],
    };
    expect(await collectSessions(store, config, { harness: () => 'subscription' })).toMatchObject({
      imported: 2,
    });
    const listed = await store.list();
    const run = listed.find((a) => a.lineage)!;
    expect(run.sessionId).toBe(`${parent}/agent-a0802a504cb2dd9ca`);
    expect(run.lineage).toEqual({
      kind: 'subagent',
      parentSessionId: parent,
      agentType: 'general-purpose',
      description: 'Adversarial review',
      toolUseId: 'toolu_1',
      depth: 1,
    });
    // The subagent's transcript is silent on access, so the harness login says it.
    expect(run.runtime).toEqual({
      provider: 'anthropic',
      accessPath: 'subscription',
      evidence: 'harness',
    });
    expect(run.models).toEqual([{ model: 'claude-sonnet-5', effort: 'high', entries: 1 }]);
    const main = listed.find((a) => !a.lineage)!;
    expect(main.runtime).toEqual({
      provider: 'anthropic',
      accessPath: 'subscription',
      evidence: 'transcript',
    });
    expect((await store.list({ provider: 'anthropic', accessPath: 'subscription' })).length).toBe(
      2,
    );
    expect(await store.list({ provider: 'openai' })).toEqual([]);
    expect(await store.list({ accessPath: 'api' })).toEqual([]);
    expect(
      (await store.list({ model: 'claude-sonnet-5', effort: 'high' })).map((a) => a.id),
    ).toEqual([run.id]);
    expect(await store.list({ model: 'claude-sonnet-5', effort: 'medium' })).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused session is not retried until it changes; the catch-all hands sessions to their project; a deleted archive is captured again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-refused-'));
  const store = await freshStore();
  let heads = 0;
  const writer = {
    sourceId: () => store.sourceId(),
    head: (id: string) => {
      heads++;
      return store.head(id);
    },
    capture: (snapshot: unknown) => store.capture(snapshot),
  };
  const session = (id: string, cwd: string) =>
    writeFileSync(
      join(dir, `${id}.jsonl`),
      JSON.stringify({
        sessionId: id,
        cwd,
        type: 'user',
        uuid: `${id}-1`,
        message: { content: 'Work' },
      }),
    );
  const base = { directory: dir, source: 'claude-code' as const, subdirectories: true };
  const unrouted = { ...base, projectId: 'unrouted', projectRoots: [], catchAll: true };
  const a = { ...base, projectId: 'a', projectRoots: ['/work/a'] };
  const b = { ...base, projectId: 'b', projectRoots: ['/work/b'] };
  const harness = () => undefined;
  let clock = 0;
  const now = () => clock;
  try {
    session('one', '/work/a/x');
    // Captured by the catch-all before project a had a collector.
    expect(
      await collectSessions(writer, unrouted, { peers: [unrouted], harness, now }),
    ).toMatchObject({ imported: 1 });
    // Once a claims it, a takes it over from unrouted.
    expect(await collectSessions(writer, a, { peers: [a, unrouted], harness, now })).toMatchObject({
      imported: 1,
    });
    expect((await store.list()).map((x) => x.projectId)).toEqual(['a']);
    // Another project may not take it: refused once, then not re-read or re-asked.
    const cache: CollectorCache = new Map();
    const moved = { ...b, projectRoots: ['/work/a/x'] };
    expect(
      await collectSessions(writer, moved, { peers: [moved], harness, cache, now }),
    ).toMatchObject({ failed: 1 });
    heads = 0;
    expect(
      await collectSessions(writer, moved, { peers: [moved], harness, cache, now }),
    ).toMatchObject({ failed: 1 });
    expect(heads).toBe(0);
    // A stored session is re-checked every 10 minutes; one deleted on the server comes back.
    const own: CollectorCache = new Map();
    expect(
      await collectSessions(writer, a, { peers: [a], harness, cache: own, now }),
    ).toMatchObject({ unchanged: 1 });
    await store.delete((await store.list())[0]!.id);
    expect(
      await collectSessions(writer, a, { peers: [a], harness, cache: own, now }),
    ).toMatchObject({ unchanged: 1 });
    expect(await store.list()).toEqual([]);
    clock += 10 * 60_000;
    expect(
      await collectSessions(writer, a, { peers: [a], harness, cache: own, now }),
    ).toMatchObject({ imported: 1 });
    expect((await store.list()).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
