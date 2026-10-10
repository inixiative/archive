import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectionRoots, collectSessions } from '../src/collector';
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
