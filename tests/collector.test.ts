import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSessions } from '../src/collector';
import { LocalArchiveStore } from '../src/local';

test('collector matches exact provider cwd, retries partial files and preserves manual tags across restart', async () => {
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
  let store = new LocalArchiveStore(join(dir, 'local.sqlite'));
  const config = {
    directory: dir,
    source: 'codex' as const,
    projectRoot: root,
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
    const id = store.list()[0].id;
    store.capture({
      ...store.read(id)!.snapshot,
      tags: ['manually-reviewed'],
      capturedAt: Date.now(),
    });
    store.close();
    store = new LocalArchiveStore(join(dir, 'local.sqlite'));
    writeFileSync(join(dir, 'partial.jsonl'), rows('partial', root));
    writeFileSync(join(dir, 'wanted.jsonl'), rows('wanted', root, 'More work'));
    const next = await collectSessions(store, config);
    expect(next.imported).toBe(2);
    expect(store.read(id)?.snapshot.tags).toEqual(['manually-reviewed', 'coding']);
    expect(store.list()).toHaveLength(2);
    expect((await collectSessions(store, config)).unchanged).toBe(2);
    expect((await collectSessions(store, { ...config, projectId: 'personal' })).failed).toBe(2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude cwd metadata is collected without treating a destination name in text as routing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-claude-'));
  const store = new LocalArchiveStore(':memory:');
  try {
    writeFileSync(
      join(dir, 'session.jsonl'),
      JSON.stringify({
        sessionId: 'claude-1',
        cwd: '/work/ue',
        type: 'user',
        uuid: 'msg-1',
        message: { content: 'Please share this with personal' },
      }),
    );
    const result = await collectSessions(store, {
      directory: dir,
      source: 'claude-code',
      projectId: 'userevidence',
      projectRoot: '/work/ue',
    });
    expect(result.imported).toBe(1);
    expect(store.list()[0].projectId).toBe('userevidence');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
