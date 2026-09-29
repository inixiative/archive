import { expect, test } from 'bun:test';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import { atlasTags, provenanceTags, referenceSuggestions, suggestTags } from '../src/tags';

const snapshot = (entries: Pick<ArchiveEntry, 'kind' | 'text'>[]) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId: 'session',
    title: 'Tags',
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'partial', omissions: [] },
    entries: entries.map((entry, i) => ({
      ...entry,
      id: `e${i}`,
      timestamp: 1,
      sourceRef: `line:${i}`,
    })),
  });

test('linked pull requests, issues, commits and Linear issues become reference suggestions, most-linked first', () => {
  const archive = snapshot([
    { kind: 'user', text: 'Fix the bug from https://linear.app/inixiative/issue/arc-12/title' },
    {
      kind: 'tool-result',
      text: 'https://github.com/inixiative/Foundry/pull/24 and https://github.com/inixiative/foundry/pull/24',
    },
    {
      kind: 'assistant',
      text: 'See https://github.com/inixiative/archive/commit/531c17d9a1b2 and github.com/a/b/issues/3',
    },
  ]);
  expect(referenceSuggestions(archive)).toEqual([
    { tag: 'github:inixiative/foundry#24', origin: 'reference' },
    { tag: 'linear:ARC-12', origin: 'reference' },
    { tag: 'github:a/b#3', origin: 'reference' },
    { tag: 'github:inixiative/archive@531c17d', origin: 'reference' },
  ]);
  expect(suggestTags(archive).map((s) => s.tag)).toEqual([
    'debugging',
    ...referenceSuggestions(archive).map((s) => s.tag),
  ]);
  expect(referenceSuggestions(archive, 1)).toHaveLength(1);
});

test('recorded git context becomes repository and branch tags', () => {
  expect(
    provenanceTags({ repository: 'git@github.com:inixiative/Foundry.git', branch: 'fix/x' }),
  ).toEqual(['repo:inixiative/foundry', 'branch:fix/x']);
  expect(provenanceTags({ repository: 'https://github.com/a/b', branch: 'HEAD' })).toEqual([
    'repo:a/b',
  ]);
  expect(provenanceTags({ repository: 'https://gitlab.example/a/b' })).toEqual([]);
});

test('Atlas concepts come from files tool calls touched, in any root, never from prose', () => {
  const graph = {
    'apps/api/archive.ts': { partOf: ['feature:archive'] },
    'apps/api/auth.ts': { partOf: ['feature:auth', 'primitive:access'] },
  };
  const archive = snapshot([
    { kind: 'user', text: 'apps/api/auth.ts' },
    { kind: 'tool-call', text: '{"input":{"file_path":"/repo/.worktrees/a/apps/api/auth.ts"}}' },
    { kind: 'tool-call', text: '{"input":{"file_path":"/repo/apps/api/auth.ts"}}' },
    { kind: 'tool-call', text: '{"input":{"command":"cat apps/api/archive.ts /elsewhere/x.ts"}}' },
  ]);
  expect(atlasTags(archive, graph, ['/repo', '/repo/.worktrees/a'])).toEqual([
    'atlas:feature:auth',
    'atlas:primitive:access',
    'atlas:feature:archive',
  ]);
});
