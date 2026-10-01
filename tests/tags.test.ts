import { expect, test } from 'bun:test';
import { type ArchiveEntry, archiveSnapshotSchema } from '../src/index';
import {
  archiveReferences,
  atlasTags,
  defaultIntegrations,
  provenanceReferences,
  suggestTags,
} from '../src/tags';

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

test('linked pull requests, issues, commits and Linear issues become references, recorded first, then most-linked', () => {
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
  archive.references = [{ integration: 'github', ref: 'inixiative/archive' }];
  expect(archiveReferences(archive)).toEqual([
    { integration: 'github', ref: 'inixiative/archive', recorded: true, mentions: 0 },
    { integration: 'github', ref: 'inixiative/foundry#24', recorded: false, mentions: 2 },
    { integration: 'github', ref: 'a/b#3', recorded: false, mentions: 1 },
    { integration: 'github', ref: 'inixiative/archive@531c17d', recorded: false, mentions: 1 },
    { integration: 'linear', ref: 'ARC-12', recorded: false, mentions: 1 },
  ]);
  expect(suggestTags(archive)).toEqual([{ tag: 'debugging', origin: 'heuristic' }]);
  expect(archiveReferences(archive, defaultIntegrations, 1)).toHaveLength(1);
});

test("only the archive's integrations are referenced; others match their link prefix", () => {
  const archive = snapshot([
    {
      kind: 'user',
      text: 'See https://acme.atlassian.net/browse/JIRA-7. and https://linear.app/x/issue/ARC-1/t',
    },
  ]);
  archive.references = [{ integration: 'notion', ref: 'page' }];
  expect(
    archiveReferences(archive, [
      { key: 'jira', name: 'Jira', prefix: 'https://acme.atlassian.net/browse/' },
    ]),
  ).toEqual([{ integration: 'jira', ref: 'JIRA-7', recorded: false, mentions: 1 }]);
});

test('recorded git context becomes repository and branch references', () => {
  expect(
    provenanceReferences({ repository: 'git@github.com:inixiative/Foundry.git', branch: 'fix/x' }),
  ).toEqual([
    { integration: 'github', ref: 'inixiative/foundry' },
    { integration: 'github', ref: 'inixiative/foundry/tree/fix/x' },
  ]);
  expect(provenanceReferences({ repository: 'https://github.com/a/b', branch: 'HEAD' })).toEqual([
    { integration: 'github', ref: 'a/b' },
  ]);
  expect(provenanceReferences({ repository: 'https://gitlab.example/a/b', branch: 'x' })).toEqual(
    [],
  );
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
