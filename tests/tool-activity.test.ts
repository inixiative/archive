import { expect, test } from 'bun:test';
import { syncArchives } from '../src/client';
import { importTranscript } from '../src/import';
import { type ArchiveSnapshot, archiveSnapshotSchema } from '../src/index';
import type { ArchiveStore } from '../src/store';
import { withoutToolActivity } from '../src/tool-activity';
import { freshStore } from './db';

const sourceId = '1ae3ac76-faa8-4498-8072-425ab35f453c';
const lines = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const claudeRow = (uuid: string, type: 'user' | 'assistant', content: unknown[]) => ({
  sessionId: 'claude-session',
  uuid,
  type,
  timestamp: '2026-10-12T10:00:00.000Z',
  ...(type === 'user' ? { origin: { kind: 'human' } } : {}),
  message: { role: type, content },
});
// Real shapes from the local Archive (2026-10-18), answers shortened.
const answered =
  'The user answered: "How much should the shared error-message catalog cover in this pass?"="We already have the make error system for our errors. This is just for auth, right?", "Where should this work go?"="Into PR #117 (Recommended)". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.';
const rejected =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nKeep the error in makeError; don't add a catalog.";
const clarify =
  'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nThe user wants to clarify these questions.\n    Questions asked:\n- "Which gives way?"\n  (No answer provided)';
const prCreated = 'https://github.com/inixiative/kingdom/pull/143\n';
const claudeTranscript = lines([
  claudeRow('u1', 'user', [{ type: 'text', text: 'Unify the auth errors' }]),
  claudeRow('a1', 'assistant', [
    {
      type: 'tool_use',
      id: 'toolu_ask',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'How much should the catalog cover?', options: [] }] },
    },
  ]),
  claudeRow('u2', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: answered }]),
  claudeRow('a2', 'assistant', [
    { type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'errors.ts' } },
  ]),
  claudeRow('u3', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: rejected }]),
  claudeRow('a3', 'assistant', [
    { type: 'tool_use', id: 'toolu_q2', name: 'AskUserQuestion', input: { questions: [] } },
  ]),
  claudeRow('u4', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_q2', content: clarify }]),
  claudeRow('a4', 'assistant', [
    { type: 'tool_use', id: 'toolu_pr', name: 'Bash', input: { command: 'gh pr create' } },
  ]),
  claudeRow('u5', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_pr', content: prCreated }]),
  claudeRow('a5', 'assistant', [
    {
      type: 'tool_use',
      id: 'toolu_agent',
      name: 'Agent',
      input: {
        description: 'Port the error envelope',
        prompt: 'Long task text',
        subagent_type: 'general-purpose',
      },
    },
  ]),
  claudeRow('a6', 'assistant', [{ type: 'text', text: 'Opened the PR.' }]),
]);
const codexTranscript = lines([
  { type: 'session_meta', payload: { id: 'codex-session', originator: 'codex_cli_rs' } },
  {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Plan aggregates' }],
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'call_ask',
      arguments: JSON.stringify({
        questions: [
          {
            header: 'Syntax',
            id: 'source_syntax',
            question: 'Which source syntax do you want for v1?',
            options: [{ label: 'Shared source object (Recommended)' }],
          },
          { header: 'Scope', id: 'support_scope', question: 'Which surfaces?', options: [] },
        ],
      }),
    },
  },
  {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'call_ask',
      output: JSON.stringify({
        answers: {
          source_syntax: { answers: ["why not just aggregateField: null | 'sum' | 'average'"] },
          support_scope: { answers: [] },
        },
      }),
    },
  },
]);

test('Claude Code: answers and rejection feedback the person typed into a tool are user entries', () => {
  const imported = importTranscript(claudeTranscript, { source: 'claude-code', sourceId });
  const kind = (text: string) => imported.entries.find((e) => e.text === text)?.kind;
  expect(kind(answered)).toBe('user');
  expect(kind(rejected)).toBe('user');
  // Asking to clarify is a choice, not typed text: an event that keeps the questions.
  expect(kind(clarify)).toBe('event');
  expect(kind(prCreated)).toBe('tool-result');
  expect(imported.title).toBe('Unify the auth errors');
});

test('Codex: request_user_input answers are user entries carrying their questions', () => {
  const imported = importTranscript(codexTranscript, { source: 'codex', sourceId });
  const answer = imported.entries.find((e) => e.callId === 'call_ask' && e.kind === 'user');
  expect(answer?.text).toBe(
    `The user answered: "Which source syntax do you want for v1?"="why not just aggregateField: null | 'sum' | 'average'"`,
  );
  expect(imported.entries.filter((e) => e.kind === 'tool-result')).toHaveLength(0);
});

/** A snapshot as 0.21 captured it: every tool result kept as tool activity. */
const capturedBefore = (): ArchiveSnapshot => {
  const imported = importTranscript(claudeTranscript, { source: 'claude-code', sourceId });
  return archiveSnapshotSchema.parse({
    ...imported,
    projectId: 'kingdom',
    capturedAt: 1,
    entries: imported.entries.map((e) =>
      e.callId && (e.kind === 'user' || e.kind === 'event') ? { ...e, kind: 'tool-result' } : e,
    ),
  });
};

test('the strip keeps typed answers, links only tool output carried, and the spawn anchor', () => {
  const before = capturedBefore();
  expect(before.entries.filter((e) => e.kind === 'user')).toHaveLength(1);
  const { snapshot, changed } = withoutToolActivity(before);
  expect(changed).toBeGreaterThan(0);
  const texts = snapshot.entries.map((e) => [e.kind, e.text]);
  expect(texts).toContainEqual(['user', answered]);
  expect(texts).toContainEqual(['user', rejected]);
  expect(texts).toContainEqual(['event', clarify]);
  expect(snapshot.entries.some((e) => e.kind === 'tool-call' || e.kind === 'tool-result')).toBe(
    false,
  );
  // The PR appeared only in `gh pr create` output: recorded, so references keep it.
  expect(snapshot.references).toContainEqual({
    integration: 'github',
    ref: 'inixiative/kingdom#143',
  });
  // A subagent's lineage.toolUseId names this call: its id and callId survive as an event.
  const anchor = snapshot.entries.find((e) => e.callId === 'toolu_agent');
  expect(anchor).toMatchObject({ kind: 'event' });
  expect(JSON.parse(anchor!.text)).toEqual({
    spawned: 'Agent',
    description: 'Port the error envelope',
  });
  // Idempotent: a stripped snapshot strips to itself.
  expect(withoutToolActivity(snapshot).changed).toBe(0);
});

const references = async (store: ArchiveStore, id: string) =>
  (await store.list({ exempt: 'include' })).find((a) => a.id === id)?.references ?? [];

test('the sweep re-derives typed answers and references from what 0.21 stored', async () => {
  const store = await freshStore();
  const { id } = await store.capture(capturedBefore());
  expect(await references(store, id)).toContainEqual(
    expect.objectContaining({ integration: 'github', ref: 'inixiative/kingdom#143' }),
  );
  await store.updateSettings({ captureToolCallsAndResults: false });
  await store.maintain();
  const stored = (await store.read(id))!;
  expect(stored.snapshot.entries.filter((e) => e.kind === 'user').map((e) => e.text)).toEqual([
    'Unify the auth errors',
    answered,
    rejected,
  ]);
  expect(stored.chunks.some((c) => c.kind === 'user' && c.text.includes('make error system'))).toBe(
    true,
  );
  expect(await references(store, id)).toContainEqual(
    expect.objectContaining({
      integration: 'github',
      ref: 'inixiative/kingdom#143',
      recorded: true,
    }),
  );
  expect((await store.matching([id], 'makeError')).has(id)).toBe(true);
});

test('a sweep passes over an archive it cannot strip, records it, and retries it next run', async () => {
  const store = await freshStore();
  const good = await store.capture({ ...capturedBefore(), sessionId: 'good' });
  const bad = await store.capture({ ...capturedBefore(), sessionId: 'bad' });
  // A stored snapshot that no longer parses.
  await store.db.$executeRaw`
    UPDATE "revisions" SET "snapshot" = jsonb_set("snapshot", '{schemaVersion}', '7')
    WHERE "archiveId" = ${bad.id}`;
  await store.updateSettings({ captureToolCallsAndResults: false });
  await store.maintain();
  let status = await store.maintenanceStatus();
  expect(status.toolActivitySweepPending).toBe(false);
  expect(status.toolActivitySweepFailures).toEqual([bad.id]);
  expect((await store.head(good.id))?.revision).toBe(2);
  // The failure does not hold back the index rebuild or a reclaim.
  await store.db.$executeRawUnsafe('DROP INDEX IF EXISTS "chunks_text_idx"');
  expect(await store.ensureSearchIndex()).toBe(true);

  await store.db.$executeRaw`
    UPDATE "revisions" SET "snapshot" = jsonb_set("snapshot", '{schemaVersion}', '1')
    WHERE "archiveId" = ${bad.id}`;
  await store.maintain();
  status = await store.maintenanceStatus();
  expect(status.toolActivitySweepFailures).toEqual([]);
  expect((await store.head(bad.id))?.revision).toBe(2);
  expect(await store.db.setting.findUnique({ where: { key: 'toolActivitySweep' } })).toBeNull();
});

test('stop ends maintenance between statements', async () => {
  const store = await freshStore();
  for (let n = 0; n < 40; n++) {
    const s = { ...capturedBefore(), sessionId: `s-${n}` };
    const { id } = await store.capture(s);
    await store.enqueue(id, 'held', { revision: 1 });
    await store.capture({ ...s, title: 'Second', capturedAt: 2 });
  }
  await store.db.outbox.deleteMany({});
  const running = store.maintain();
  await store.stop();
  await running;
  expect((await store.maintenanceStatus()).supersededRevisions).toBeGreaterThan(0);
});

test('outbox rows no route will deliver are released, and their revisions compacted', async () => {
  const store = await freshStore();
  const first = await store.capture({ ...capturedBefore(), projectId: 'gone' });
  await store.enqueue(first.id, 'removed-destination', { revision: 1 });
  await store.capture({ ...capturedBefore(), projectId: 'gone', title: 'Second', capturedAt: 2 });
  const superseded = await store.capture({ ...capturedBefore(), sessionId: 'raw' });
  await store.enqueue(superseded.id, 'live-destination', { revision: 1 });
  await store.capture({ ...capturedBefore(), sessionId: 'raw', title: 'Second', capturedAt: 2 });
  await store.db.archive.update({
    where: { id: superseded.id },
    data: { supersededBy: first.id },
  });
  expect((await store.maintenanceStatus()).revisionsAwaitingDelivery).toBe(2);
  await syncArchives(store, []);
  await store.maintain();
  expect(await store.db.outbox.count()).toBe(0);
  expect(await store.db.revision.count()).toBe(2);
});
