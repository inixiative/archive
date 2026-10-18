import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentsConfigSchema, collectorPlan } from '../src/agents';
import {
  type CollectionSource,
  collectSessions,
  defaultExclusions,
  excludeGlob,
  folderAllowed,
  folderGlob,
  routeSession,
} from '../src/collector';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import { projectTags } from '../src/tags';
import { freshStore } from './db';

test('folder globs normalize like Atlas and Gloss entries, and an empty one is refused', () => {
  expect(folderGlob('~/scratch/')).toBe(join(homedir(), 'scratch'));
  expect(folderGlob('decision-receipts')).toBe('**/decision-receipts');
  expect(folderGlob('./.foundry/evals//')).toBe('**/.foundry/evals');
  // A trailing /** goes: a folder glob covers the folder and everything below (Atlas's `dir/**`).
  expect(folderGlob(' /tmp/** ')).toBe('/tmp');
  expect(folderGlob('~/code/inixiative/**/')).toBe(join(homedir(), 'code/inixiative'));
  expect(
    folderAllowed(join(homedir(), 'code/inixiative'), {
      include: [folderGlob('~/code/inixiative/**')],
    }),
  ).toBe(true);
  expect(folderGlob('**/primed-*/fixture')).toBe('**/primed-*/fixture');
  for (const empty of ['', '  ', '/', './', '.', '/**', '//'])
    expect(() => folderGlob(empty)).toThrow();
  expect(() => folderGlob('../x')).toThrow('..');
  // Excludes that cover everything are refused; narrower ones are not.
  for (const broad of ['**', '*', '/*', '~', '~/', homedir(), dirname(homedir())])
    expect(() => excludeGlob(broad)).toThrow('covers every session');
  expect(excludeGlob('~/code/zealot')).toBe(join(homedir(), 'code/zealot'));
  expect(agentsConfigSchema.safeParse({ exclude: ['**'], collectors: [] }).success).toBe(false);
  expect(agentsConfigSchema.safeParse({ include: ['**'], collectors: [] }).success).toBe(true);
  const parsed = agentsConfigSchema.parse({
    include: ['~/code/'],
    exclude: ['bench/.runs'],
    collectors: [],
  });
  expect(parsed).toMatchObject({
    include: [join(homedir(), 'code')],
    exclude: ['**/bench/.runs'],
  });
  expect(agentsConfigSchema.safeParse({ exclude: [''], collectors: [] }).success).toBe(false);
  expect(agentsConfigSchema.safeParse({ include: ['  '], collectors: [] }).success).toBe(false);
});

test('folder filters apply to every match: exact roots, worktrees, subdirectories and catch-alls; exclude wins', () => {
  const base = { directory: '/h', source: 'claude-code' as const };
  const foundry: CollectionSource = {
    ...base,
    projectId: 'foundry',
    projectRoots: ['/w/foundry'],
    worktrees: true,
    subdirectories: true,
  };
  const primedRoot: CollectionSource = {
    ...base,
    projectId: 'primed',
    projectRoots: ['/w/foundry/.foundry/decision-receipts/primed-1/fixture'],
  };
  const unrouted: CollectionSource = {
    ...base,
    projectId: 'unrouted',
    projectRoots: [],
    catchAll: true,
  };
  const peers = [foundry, primedRoot, unrouted];
  // A worktree of the foundry root, as `git worktree list` reports it.
  const roots = (collector: CollectionSource) =>
    new Set(
      collector === foundry
        ? ['/w/foundry', '/w/foundry/.worktrees/feature']
        : collector.projectRoots,
    );
  const route = (cwd: string, filters = { exclude: defaultExclusions() }) =>
    routeSession(cwd, peers, { filters, roots })?.projectId;

  expect(route('/w/foundry')).toBe('foundry');
  expect(route('/w/foundry/.worktrees/feature')).toBe('foundry');
  expect(route('/elsewhere')).toBe('unrouted');
  // Decision receipts are out by default, an exact root included.
  expect(route('/w/foundry/.foundry/decision-receipts/primed-1/fixture')).toBeUndefined();
  expect(route('/w/foundry/.worktrees/feature/.foundry/decision-receipts/primed-2/fixture')).toBe(
    undefined,
  );
  expect(route('/w/foundry/.foundry/decision-receipts/primed-1/fixture', { exclude: [] })).toBe(
    'primed',
  );

  const filters = {
    include: [folderGlob('/w/**'), folderGlob('/elsewhere')],
    exclude: [...defaultExclusions(), folderGlob('/w/foundry/.worktrees/*'), folderGlob('evals')],
  };
  expect(route('/w/foundry', filters)).toBe('foundry');
  // Exclude wins over include, for a worktree as for any match.
  expect(route('/w/foundry/.worktrees/feature', filters)).toBeUndefined();
  expect(route('/w/foundry/.worktrees/feature/apps', filters)).toBeUndefined();
  expect(route('/w/foundry/scripts/evals/run', filters)).toBeUndefined();
  expect(route('/elsewhere/notes', filters)).toBe('unrouted');
  // Outside every include, nothing is collected, not even by the catch-all.
  expect(route('/Users/me/notes', filters)).toBeUndefined();
  expect(folderAllowed('/w', { include: [folderGlob('/w/*')] })).toBe(false);
});

test('agents.json filters reach every collector through its plan', () => {
  const config = agentsConfigSchema.parse({
    include: ['/w'],
    exclude: ['/w/scratch'],
    collectors: [
      {
        name: 'claude-code.w',
        source: 'claude-code',
        directory: '/h/.claude/projects',
        projectId: 'w',
        projectRoots: ['/w'],
      },
      {
        name: 'codex.kingdom',
        source: 'codex',
        directory: '/h/.codex/sessions',
        projectId: 'kingdom',
        projectRoots: ['/w/kingdom'],
      },
    ],
  });
  const plan = collectorPlan(config, 'claude-code.w');
  expect(plan.filters).toEqual({
    include: ['/w'],
    exclude: ['**/decision-receipts', '/w/scratch'],
  });
  // Projects for `project:` tags span every source; peers stay one source.
  expect(plan.peers.map((p) => p.projectId)).toEqual(['w']);
  expect(plan.projects.map((p) => p.projectId)).toEqual(['w', 'kingdom']);
});

const snapshot = (entries: Pick<ArchiveEntry, 'kind' | 'text'>[]) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId: 'org',
    title: 'Org',
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: entries.map((entry, i) => ({
      ...entry,
      id: `e${i}`,
      timestamp: 1,
      sourceRef: `line:${i}`,
    })),
  });

test('project tags name every project whose files the tool calls touched, the longest root winning', () => {
  const projects = [
    { projectId: 'inixiative', roots: ['/w'] },
    { projectId: 'kingdom', roots: ['/w/kingdom', '/w/kingdom/.worktrees/feat'] },
    { projectId: 'template', roots: ['/w/template/'] },
    { projectId: 'tribe', roots: ['/t/tribe'] },
    { projectId: 'notes', roots: [join(homedir(), 'notes')] },
  ];
  const call = (name: string, input: object) => ({
    kind: 'tool-call' as const,
    text: JSON.stringify({ name, input }),
  });
  const session = snapshot([
    { kind: 'user', text: 'Touch /t/tribe/README.md in prose only' },
    call('Read', { file_path: '/w/kingdom/.worktrees/feat/apps/api/src/index.ts' }),
    call('Edit', { file_path: '/w/kingdom/apps/web/x.tsx', old_string: 'a', new_string: 'b' }),
    call('Bash', { command: 'git -C /w/template status && cd template/apps && ls' }),
    call('Bash', { command: 'open https://github.com/inixiative/tribe/pull/2 and /t/tribeish' }),
    call('Write', { file_path: '~/notes/today.md', content: 'x' }),
    { kind: 'tool-result', text: '/t/tribe/apps/api/src/server.ts' },
  ]);
  expect(projectTags(session, projects, '/w')).toEqual([
    'project:kingdom',
    'project:template',
    'project:notes',
  ]);
  // Without a working directory only absolute paths count.
  expect(projectTags(session, projects).sort()).toEqual([
    'project:kingdom',
    'project:notes',
    'project:template',
  ]);
  // A relative path resolves against the session's directory.
  expect(
    projectTags(snapshot([call('Read', { file_path: 'kingdom/a.ts' })]), projects, '/w'),
  ).toEqual(['project:kingdom']);
  expect(projectTags(session, [])).toEqual([]);
  // Naming the folder that holds every checkout is not working in any of them; a project's own
  // root or worktree (`git -C`) still counts.
  const listing = snapshot([
    call('Bash', { command: 'ls /w && find /w/ -maxdepth 1 && ls ~/notes' }),
  ]);
  expect(projectTags(listing, projects, '/t')).toEqual(['project:notes']);
  expect(
    projectTags(
      snapshot([call('Bash', { command: 'git -C /w/kingdom/.worktrees/feat log' })]),
      projects,
    ),
  ).toEqual(['project:kingdom']);
});

test('a collector tags an org-level session, and its subagent, with the projects it touched; routing is unchanged', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-project-tags-')));
  const org = join(dir, 'org');
  const kingdom = join(org, 'kingdom');
  const feature = join(org, 'kingdom-feature');
  const template = join(org, 'template');
  const history = join(dir, 'history');
  const codexHistory = join(dir, 'codex');
  const git = (...args: string[]) =>
    expect(Bun.spawnSync(['git', '-C', kingdom, ...args], { stderr: 'ignore' }).success).toBe(true);
  const store = await freshStore();
  try {
    for (const path of [kingdom, template, history, codexHistory])
      mkdirSync(path, { recursive: true });
    git('init', '-q');
    git('-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i');
    git('worktree', 'add', '-q', feature);
    const parent = 'b9f0d7a3-7d6c-4c58-9b33-2f8a1c2d3e4f';
    const tool = (id: string, input: object) => ({
      sessionId: parent,
      cwd: org,
      type: 'assistant',
      uuid: id,
      message: { content: [{ type: 'tool_use', id: `t-${id}`, name: 'Bash', input }] },
    });
    const lines = (rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');
    writeFileSync(
      join(history, `${parent}.jsonl`),
      lines([
        { sessionId: parent, cwd: org, type: 'user', uuid: 'u1', message: { content: 'Port it' } },
        tool('a1', { command: `git -C ${feature} log -1` }),
        tool('a2', { command: 'cat template/package.json' }),
      ]),
    );
    mkdirSync(join(history, parent, 'subagents'), { recursive: true });
    writeFileSync(
      join(history, parent, 'subagents', 'agent-a1.jsonl'),
      lines([
        {
          sessionId: parent,
          agentId: 'a1',
          isSidechain: true,
          cwd: org,
          type: 'user',
          uuid: 's1',
          message: { content: 'Read the template' },
        },
        { ...tool('s2', { command: `ls ${template}/apps` }), agentId: 'a1', isSidechain: true },
      ]),
    );
    const collectors: CollectionSource[] = [
      { directory: history, source: 'claude-code', projectId: 'inixiative', projectRoots: [org] },
      {
        directory: history,
        source: 'claude-code',
        projectId: 'kingdom',
        projectRoots: [kingdom],
        worktrees: true,
      },
      // Another source's collector still names a project.
      { directory: codexHistory, source: 'codex', projectId: 'template', projectRoots: [template] },
    ];
    const [own] = collectors as [CollectionSource];
    const result = await collectSessions(store, own, {
      peers: collectors.slice(0, 2),
      projects: collectors,
      harness: () => undefined,
    });
    expect(result).toMatchObject({ imported: 2, failed: 0 });
    // In a temp directory, so exempt as a test run (interim inference); listed with the rest.
    const listed = await store.list({ exempt: 'include' });
    const main = listed.find((a) => a.sessionId === parent)!;
    const subagent = listed.find((a) => a.sessionId === `${parent}/agent-a1`)!;
    expect(main.projectId).toBe('inixiative');
    expect(main.tags.filter((t) => t.startsWith('project:')).sort()).toEqual([
      'project:kingdom',
      'project:template',
    ]);
    expect(subagent.projectId).toBe('inixiative');
    expect(subagent.tags.filter((t) => t.startsWith('project:'))).toEqual(['project:template']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
