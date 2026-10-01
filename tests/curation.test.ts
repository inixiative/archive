import { expect, test } from 'bun:test';
import { archiveSnapshotSchema } from '../src/index';
import { LocalArchiveStore } from '../src/local';
import { createArchiveHandler } from '../src/server';

const token = 'synthetic-archive-test-token-0000000000';
const snapshot = (sessionId: string, extra: Record<string, unknown> = {}) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'claude-code',
    sessionId,
    title: `Session ${sessionId}`,
    projectId: 'inixiative',
    tags: ['captured'],
    capturedAt: 1_000,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [
      {
        id: 'e1',
        kind: 'user',
        text: 'Ship https://acme.atlassian.net/browse/JIRA-7 and https://github.com/inixiative/archive/pull/9',
        timestamp: 1,
        sourceRef: 'line:1',
      },
    ],
    ...extra,
  });
type Reply = {
  data: {
    archives: { id: string; actor?: unknown; entries: number }[];
    nextCursor: string | null;
    tags: unknown;
    deleted: boolean;
    retentionDays: number | null;
    removed: boolean;
    integrations: unknown;
  };
};
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
  return { status: response.status, body: (await response.json()) as Reply };
};

test('sessions carry an actor; list filters by actor, source, tag and reference and pages by cursor', async () => {
  const store = new LocalArchiveStore(':memory:');
  const handler = createArchiveHandler(store, token);
  try {
    const ada = store.capture(snapshot('a', { actor: { kind: 'user', id: 'ada', name: 'Ada' } }));
    store.capture(snapshot('b', { actor: { kind: 'service', id: 'nightly' } }));
    store.capture(snapshot('c'));
    store.capture(
      snapshot('d', { actor: { kind: 'job', id: 'renewIntegrations', integrationId: 'int-1' } }),
    );
    expect(store.list({ actorId: 'renewIntegrations' })[0].actor).toEqual({
      kind: 'job',
      id: 'renewIntegrations',
      integrationId: 'int-1',
    });
    const mine = await call(handler, 'list', { actorId: 'ada' });
    expect(mine.body.data.archives.map((a) => [a.id, a.actor])).toEqual([
      [ada.id, { kind: 'user', id: 'ada', name: 'Ada' }],
    ]);
    expect(mine.body.data.archives[0]).not.toHaveProperty('chunks');
    expect(mine.body.data.archives[0].entries).toBe(1);
    const first = await call(handler, 'list', { limit: 2 });
    const second = await call(handler, 'list', { limit: 2, beforeId: first.body.data.nextCursor });
    expect([...first.body.data.archives, ...second.body.data.archives]).toHaveLength(4);
    expect(second.body.data.nextCursor).toBeNull();
    const linked = await call(handler, 'list', {
      reference: { integration: 'github', ref: 'inixiative/archive#9' },
    });
    expect(linked.body.data.archives).toHaveLength(4);
    expect((await call(handler, 'list', { source: 'codex' })).body.data.archives).toEqual([]);
  } finally {
    store.close();
  }
});

test('tag edits apply without a revision, survive re-capture, and stay within 100 tags', async () => {
  const store = new LocalArchiveStore(':memory:');
  const handler = createArchiveHandler(store, token);
  try {
    const { id } = store.capture(snapshot('a'));
    const edited = await call(handler, 'tag', {
      archiveId: id,
      add: ['reviewed'],
      remove: ['captured'],
    });
    expect(edited.body.data.tags).toEqual(['reviewed']);
    expect(store.read(id)?.revision).toBe(1);
    store.capture({ ...snapshot('a'), capturedAt: 2_000, title: 'Renamed' });
    expect(store.list()[0].tags).toEqual(['reviewed']);
    expect(
      (await call(handler, 'tag', { archiveId: id, add: ['captured'] })).body.data.tags,
    ).toEqual(['captured', 'reviewed']);
    const tooMany = Array.from({ length: 100 }, (_, i) => `t${i}`);
    expect((await call(handler, 'tag', { archiveId: id, add: tooMany })).status).toBe(400);
    expect(store.list()[0].tags).toEqual(['captured', 'reviewed']);
    expect((await call(handler, 'list', { tag: 'reviewed' })).body.data.archives).toHaveLength(1);
    expect((await call(handler, 'tag', { archiveId: 'f'.repeat(64), add: ['x'] })).status).toBe(
      404,
    );
  } finally {
    store.close();
  }
});

test('the archive owns its integrations: references follow settings, duplicates are refused', async () => {
  const store = new LocalArchiveStore(':memory:');
  const handler = createArchiveHandler(store, token);
  try {
    store.capture(snapshot('a'));
    const defaults = (await call(handler, 'settings/read', {})).body.data;
    expect(defaults.integrations).toEqual([
      { key: 'github', name: 'GitHub' },
      { key: 'linear', name: 'Linear' },
    ]);
    expect(defaults.retentionDays).toBeNull();
    const updated = await call(handler, 'settings/update', {
      integrations: [{ key: 'jira', name: 'Jira', prefix: 'https://acme.atlassian.net/browse/' }],
    });
    expect(updated.body.data.retentionDays).toBeNull();
    expect(store.list()[0].references).toEqual([
      { integration: 'jira', ref: 'JIRA-7', recorded: false, mentions: 1 },
    ]);
    const duplicate = await call(handler, 'settings/update', {
      integrations: [
        { key: 'jira', name: 'Jira' },
        { key: 'jira', name: 'Jira again' },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(
      (
        await call(handler, 'settings/update', {
          integrations: [{ key: 'x', name: 'X', prefix: 'ab' }],
        })
      ).status,
    ).toBe(400);
  } finally {
    store.close();
  }
});

test('retention deletes expired archives with their edits and receipts; delete removes one', async () => {
  const store = new LocalArchiveStore(':memory:');
  const handler = createArchiveHandler(store, token);
  try {
    const old = store.capture(snapshot('old'));
    const fresh = store.capture({ ...snapshot('fresh'), capturedAt: 10 * 86_400_000 });
    store.tag(old.id, { add: ['x'] });
    store.acknowledge(old.id, 'remote', old.digest);
    expect(store.prune(10 * 86_400_000)).toEqual([]);
    store.updateSettings({ retentionDays: 5 });
    expect(store.prune(10 * 86_400_000)).toEqual([old.id]);
    expect(store.read(old.id)).toBeUndefined();
    expect(store.receipt(old.id, 'remote')).toBeNull();
    expect(store.list().map((a) => a.id)).toEqual([fresh.id]);
    expect((await call(handler, 'delete', { archiveId: fresh.id })).body.data.deleted).toBe(true);
    expect((await call(handler, 'delete', { archiveId: fresh.id })).status).toBe(404);
  } finally {
    store.close();
  }
});

test('tag definitions are archive-wide or per actor, with usage counts', async () => {
  const store = new LocalArchiveStore(':memory:');
  const handler = createArchiveHandler(store, token);
  try {
    store.capture(snapshot('a', { actor: { kind: 'user', id: 'ada' } }));
    store.capture(snapshot('b', { actor: { kind: 'user', id: 'grace' } }));
    await call(handler, 'tags/define', { tag: 'captured', description: 'Collector default' });
    await call(handler, 'tags/define', { tag: 'mine', actorId: 'ada' });
    await call(handler, 'tags/define', { tag: 'hers', actorId: 'grace' });
    expect((await call(handler, 'tags/list', {})).body.data.tags).toEqual([
      { tag: 'captured', description: 'Collector default', archives: 2 },
    ]);
    expect((await call(handler, 'tags/list', { actorId: 'ada' })).body.data.tags).toEqual([
      { tag: 'captured', description: 'Collector default', archives: 1 },
      { tag: 'mine', actorId: 'ada', archives: 0 },
    ]);
    expect(
      (await call(handler, 'tags/remove', { tag: 'mine', actorId: 'ada' })).body.data.removed,
    ).toBe(true);
    expect(
      (await call(handler, 'tags/remove', { tag: 'mine', actorId: 'ada' })).body.data.removed,
    ).toBe(false);
  } finally {
    store.close();
  }
});
