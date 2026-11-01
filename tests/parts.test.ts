import { expect, test } from 'bun:test';
import { type ArchiveEntry, archiveKey, archiveSnapshotSchema } from '../src/index';
import { partSessionId, partSnapshot } from '../src/parts';
import { freshStore } from './db';

const sourceId = '1ae3ac76-faa8-4498-8072-425ab35f453c';
const session = (sessionId: string, entries: Pick<ArchiveEntry, 'kind' | 'text'>[], extra = {}) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId,
    source: 'claude-code',
    sessionId,
    title: 'Investor advice, then template work',
    projectId: 'template',
    tags: ['project:template', 'project:zealot', 'atlas:x'],
    references: [{ integration: 'github', ref: 'inixiative/template' }],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: entries.map((entry, i) => ({
      ...entry,
      id: `e${i}`,
      timestamp: i,
      sourceRef: `l${i}`,
    })),
    ...extra,
  });
const sample = () =>
  session('s1', [
    { kind: 'user', text: 'My advisor says raise now' },
    { kind: 'assistant', text: 'Noted' },
    { kind: 'user', text: 'Port the error envelope; Vlad deleted my work' },
    { kind: 'assistant', text: 'Sorry Vlad deleted your work. Ported.' },
    { kind: 'user', text: 'thanks' },
  ]);

test('a part publishes its kept entries with every redaction applied, its own title, and only its organizations’ projects', () => {
  const part = partSnapshot(
    sample(),
    {
      firstEntryId: 'e2',
      lastEntryId: 'e4',
      entryIds: ['e2', 'e3'],
      projects: new Set(['template']),
    },
    [
      { entryId: 'e2', text: 'Vlad deleted my work', reason: 'coworker' },
      { entryId: 'e3', text: 'Vlad deleted your work', reason: 'coworker' },
    ],
  );
  expect(part.sessionId).toBe('s1#part-e2');
  expect(part.entries.map((e) => [e.id, e.text])).toEqual([
    ['e2', 'Port the error envelope; [redacted: coworker]'],
    ['e3', 'Sorry [redacted: coworker]. Ported.'],
  ]);
  expect(part.title).toBe('Port the error envelope; [redacted: coworker]');
  expect(part.tags).toEqual(['project:template']);
  expect(part.references).toBeUndefined();
  expect(part.projectId).toBe('template');
  expect(part.lineage).toEqual({
    kind: 'part',
    parentSessionId: 's1',
    rootSessionId: 's1',
    firstEntryId: 'e2',
    lastEntryId: 'e4',
  });
  expect(part.coverage.omissions.at(-1)).toBe(
    'A part of its session: 2 of 3 entries in its range; 1 pruned; 2 redacted; tool activity is never kept',
  );
  // Echoes of a redacted span in other kept entries go too.
  const echoed = partSnapshot(
    sample(),
    { firstEntryId: 'e2', lastEntryId: 'e3', entryIds: ['e2', 'e3'], projects: new Set() },
    [{ entryId: 'e2', text: 'Vlad', reason: 'coworker' }],
  );
  expect(echoed.entries.map((e) => e.text).join(' ')).not.toContain('Vlad');
  expect(echoed.projectId).toBeUndefined();
  expect(partSessionId('x'.repeat(250), 'e1').length).toBeLessThanOrEqual(256);
});

test('parts are local rows: out of listings, suggestions and retention; superseded and deleted with their session; a re-plan retires what it drops', async () => {
  const store = await freshStore();
  const { id } = await store.capture(sample());
  const build = (first: string, last: string, ids: string[]) =>
    partSnapshot(
      sample(),
      { firstEntryId: first, lastEntryId: last, entryIds: ids, projects: new Set(['template']) },
      [],
    );
  const applied = await store.applyParts(id, [
    { snapshot: build('e2', 'e3', ['e2', 'e3']), organizations: ['inixiative'] },
    { snapshot: build('e4', 'e4', ['e4']), organizations: ['inixiative', 'userevidence'] },
  ]);
  expect(applied.kept).toHaveLength(2);
  expect((await store.list({ exempt: 'include' })).map((a) => a.id)).toEqual([id]);
  const parts = await store.list({ exempt: 'include', parts: 'only' });
  expect(parts.map((p) => [p.sessionId, p.partOf, p.routedTo]).sort()).toEqual([
    ['s1#part-e2', id, ['inixiative']],
    ['s1#part-e4', id, ['inixiative', 'userevidence']],
  ]);
  const queue = await store.suggestionQueue({ key: 'k', limit: 10 });
  expect(queue?.items.map((i) => i.archiveId)).toEqual([id]);
  // A part a destination holds stays, routed nowhere, until sync deletes it there.
  const held = applied.kept[1]!;
  await store.delivered(held, 'dest', 'digest');
  const replanned = await store.applyParts(id, [
    { snapshot: build('e2', 'e3', ['e2', 'e3']), organizations: ['inixiative'] },
  ]);
  expect(replanned).toEqual({ kept: [applied.kept[0]!], retired: [held] });
  expect((await store.listing(held))?.routedTo).toEqual([]);
  await store.forgetDelivery(held, 'dest');
  expect(await store.listing(held)).toBeUndefined();
  // Superseded with its session.
  await store.db.archive.update({ where: { id }, data: { supersededBy: 'driver' } });
  await store.applyParts(id, [
    { snapshot: build('e2', 'e3', ['e2', 'e3']), organizations: ['inixiative'] },
  ]);
  expect((await store.head(applied.kept[0]!))?.supersededBy).toBe('driver');
  // Retention passes parts over; deleting the session takes its parts.
  await store.updateSettings({ retentionDays: 1 });
  expect(await store.prune(10 * 86_400_000)).toEqual([id]);
  expect(await store.list({ exempt: 'include', parts: 'include' })).toEqual([]);
});

test('a re-add the writer means (restore) lifts a destination’s tombstone; without it the tombstone holds', async () => {
  const destination = await freshStore('remote');
  const part = partSnapshot(
    sample(),
    { firstEntryId: 'e0', lastEntryId: 'e1', entryIds: ['e0', 'e1'], projects: new Set() },
    [],
  );
  const first = await destination.capture(part, { previousDigest: null });
  expect(first.changed).toBe(true);
  await destination.delete(archiveKey(part));
  expect((await destination.capture(part, { previousDigest: null })).revision).toBe(0);
  expect(await destination.read(archiveKey(part))).toBeUndefined();
  const restored = await destination.capture(part, { previousDigest: null, restore: true });
  expect(restored.changed).toBe(true);
  expect((await destination.read(archiveKey(part)))?.snapshot.sessionId).toBe('s1#part-e0');
});

test('L4: overlapping redactions are one span over the original text; nothing between them survives', () => {
  const s = session('overlap', [
    { kind: 'user', text: 'I am interviewing at another company; Vlad is useless. Ship it.' },
  ]);
  const part = partSnapshot(
    s,
    { firstEntryId: 'e0', lastEntryId: 'e0', entryIds: ['e0'], projects: new Set() },
    [
      { entryId: 'e0', text: 'interviewing at another company', reason: 'career' },
      { entryId: 'e0', text: 'company; Vlad is useless', reason: 'coworker' },
    ],
  );
  expect(part.entries[0]!.text).toBe('I am [redacted: career, coworker]. Ship it.');
});

test('S6: a part carries only its organizations’ project tags and no whole-session metadata', () => {
  const part = partSnapshot(
    {
      ...sample(),
      goalIds: ['g1'],
      runIds: ['r1'],
      tags: ['project:template', 'project:kingdom', 'atlas:oracle:internals', 'secret-plan'],
    },
    { firstEntryId: 'e2', lastEntryId: 'e2', entryIds: ['e2'], projects: new Set(['template']) },
    [],
  );
  expect(part.tags).toEqual(['project:template']);
  expect(part.goalIds).toEqual([]);
  expect(part.runIds).toEqual([]);
});
