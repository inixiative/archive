import { expect, test } from 'bun:test';
import { importTranscript } from '../src/import';
import { LocalArchiveStore } from '../src/local';

const sourceId = '1ae3ac76-faa8-4498-8072-425ab35f453c';
const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n');

test('Codex turns stamp model and effort on what the model produced, per turn', () => {
  const message = (role: string, text: string, id: string) => ({
    type: 'response_item',
    payload: { type: 'message', role, id, content: [{ type: 'output_text', text }] },
  });
  const snapshot = importTranscript(
    lines(
      { type: 'session_meta', payload: { id: 'codex-1' } },
      { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'high' } },
      message('user', 'Fix it', 'u1'),
      message('assistant', 'Fixed', 'a1'),
      { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'low' } },
      {
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1', id: 'f1' },
      },
    ),
    { source: 'codex', sourceId },
  );
  expect(snapshot.entries.map(({ kind, model, effort }) => ({ kind, model, effort }))).toEqual([
    { kind: 'user', model: undefined, effort: undefined },
    { kind: 'assistant', model: 'gpt-6-luna', effort: 'high' },
    { kind: 'tool-call', model: 'gpt-6-luna', effort: 'low' },
  ]);
});

test('Claude records stamp their own model and effort; sessions list and filter by them', () => {
  const store = new LocalArchiveStore(':memory:');
  try {
    const record = (type: string, uuid: string, model?: string, effort?: string) => ({
      type,
      uuid,
      sessionId: 'claude-1',
      ...(effort ? { effort } : {}),
      message: {
        ...(model ? { model } : {}),
        content: [{ type: 'text', text: `${type} ${uuid}` }],
      },
    });
    const snapshot = importTranscript(
      lines(
        record('user', 'u1'),
        record('assistant', 'a1', 'claude-opus-5-5', 'medium'),
        record('assistant', 'a2', 'claude-opus-5-5', 'medium'),
        record('assistant', 'a3', 'claude-sonnet-5', 'high'),
      ),
      { source: 'claude-code', sourceId, projectId: 'inixiative' },
    );
    store.capture(snapshot);
    expect(store.list()[0].models).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium', entries: 2 },
      { model: 'claude-sonnet-5', effort: 'high', entries: 1 },
    ]);
    expect(store.list({ model: 'claude-sonnet-5' })).toHaveLength(1);
    expect(store.list({ model: 'claude-sonnet-5', effort: 'medium' })).toHaveLength(0);
    expect(store.list({ effort: 'medium' })).toHaveLength(1);
  } finally {
    store.close();
  }
});
