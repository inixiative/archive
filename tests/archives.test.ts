import { describe, expect, test } from 'bun:test';
import { importTranscript } from '../src/import';
import { archiveSnapshotSchema, chunkArchive, selectChunks, snapshotDigest } from '../src/index';
import { ArchiveStore } from '../src/store';
import { freshStore, testDatabaseUrl } from './db';

const snapshot = () =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'foundry',
    sessionId: 'thread-a',
    title: 'Archive fixtures',
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [
      {
        id: 'message-a',
        kind: 'user',
        text: 'Review patient privacy. 🏰 文本 '.repeat(200),
        timestamp: 1,
        sourceRef: 'message:a',
      },
    ],
  });
describe('session archives', () => {
  test('chunks preserve all Unicode text with exact offsets and bounded reference tokens', () => {
    const s = snapshot(),
      chunks = chunkArchive(s, 64);
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(s.entries[0].text);
    expect(chunks.every((chunk) => chunk.tokenCount <= 64 && chunk.tokenCount > 0)).toBe(true);
    for (const chunk of chunks)
      expect(s.entries[0].text.slice(chunk.start, chunk.end)).toBe(chunk.text);
    expect(selectChunks(chunks, 'privacy', 128).tokenCount).toBeLessThanOrEqual(128);
    expect(selectChunks(chunks, 'nonexistent', 128).chunks).toHaveLength(0);
    const small = selectChunks(chunkArchive(s), 'privacy', 32);
    expect(small.chunks.length).toBeGreaterThan(0);
    expect(small.tokenCount).toBeLessThanOrEqual(32);
    for (const chunk of small.chunks)
      expect(s.entries[0].text.slice(chunk.start, chunk.end)).toBe(chunk.text);
  });
  test('capture is idempotent, retains prior versions and rejects older replacements', async () => {
    const store = await freshStore();
    const s = snapshot(),
      first = await store.capture(s);
    expect((await store.capture({ ...s, capturedAt: 2 })).changed).toBe(false);
    const edited = { ...s, title: 'Changed', capturedAt: 3 };
    expect((await store.capture(edited)).revision).toBe(2);
    expect((await store.read(first.id, 1))?.snapshot.title).toBe(s.title);
    expect(store.capture({ ...s, capturedAt: 2 })).rejects.toThrow('Stale capture');
    expect(await store.receipt(first.id, 'destination')).toBeNull();
    await store.delivered(first.id, 'destination', snapshotDigest(edited));
    expect(await store.receipt(first.id, 'destination')).toBe(snapshotDigest(edited));
  });
  test('Codex imports public messages, tool results and summaries once, without private payloads', () => {
    const lines = [
      { type: 'session_meta', payload: { id: 'session-a' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix docs' }],
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix docs' } },
      {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          encrypted_content: 'PRIVATE',
          summary: [{ text: 'Checking the public documentation' }],
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-a', output: 'README contents' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    const imported = importTranscript(lines, { source: 'codex', sourceId: snapshot().sourceId });
    expect(imported.entries).toHaveLength(3);
    expect(imported.entries[2].callId).toBe('call-a');
    expect(imported.entries[2].turnId).toBeUndefined();
    expect(JSON.stringify(imported)).not.toContain('PRIVATE');
    expect(imported.coverage.reasoning).toBe('summaries-only');
    expect(() =>
      importTranscript(lines + '\n{', { source: 'codex', sourceId: snapshot().sourceId }),
    ).toThrow('line 6');
  });
  test('Claude import records tool output and omissions without inventing reasoning', () => {
    const row = {
      sessionId: 'claude-a',
      uuid: 'a',
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'PRIVATE' },
          { type: 'text', text: 'Done' },
          {
            type: 'tool_result',
            content: [
              { type: 'text', text: 'Saved' },
              { type: 'image', data: 'BINARY' },
            ],
          },
        ],
      },
    };
    const imported = importTranscript(JSON.stringify(row), {
      source: 'claude-code',
      sourceId: snapshot().sourceId,
    });
    expect(imported.entries.map((e) => e.text)).toEqual(['Done', 'Saved']);
    expect(
      importTranscript([row, row].map((r) => JSON.stringify(r)).join('\n'), {
        source: 'claude-code',
        sourceId: snapshot().sourceId,
      }).entries,
    ).toHaveLength(2);
    expect(() =>
      importTranscript(
        [
          row,
          {
            ...row,
            message: { content: [{ type: 'thinking' }, { type: 'text', text: 'Changed' }] },
          },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n'),
        { source: 'claude-code', sourceId: snapshot().sourceId },
      ),
    ).toThrow('Conflicting');
    expect(JSON.stringify(imported)).not.toContain('PRIVATE');
    expect(imported.coverage.completeness).toBe('partial');
    expect(() =>
      importTranscript(
        [row, { ...row, sessionId: 'other' }].map((r) => JSON.stringify(r)).join('\n'),
        { source: 'claude-code', sourceId: snapshot().sourceId },
      ),
    ).toThrow('Mixed');
  });
  test('Claude subagent transcripts archive apart from their parent session and each other', () => {
    const row = (agentId?: string) =>
      JSON.stringify({
        sessionId: 'parent',
        uuid: `u-${agentId ?? 'main'}`,
        type: 'user',
        message: { content: 'Work' },
        ...(agentId && { isSidechain: true, agentId }),
      });
    const id = (line: string) =>
      importTranscript(line, { source: 'claude-code', sourceId: snapshot().sourceId }).sessionId;
    expect([id(row()), id(row('a1')), id(row('a2'))]).toEqual([
      'parent',
      'parent/agent-a1',
      'parent/agent-a2',
    ]);
    expect(() => id(`${row('a1')}\n${row('a2')}`)).toThrow('Mixed');
  });
});

test('a pending upload and source identity survive reconnecting to the database', async () => {
  const original = await freshStore();
  const sourceId = await original.sourceId();
  const archive = await original.capture(snapshot());
  await original.enqueue(archive.id, 'destination', { revision: 1 });
  const reopened = new ArchiveStore(testDatabaseUrl('main'));
  try {
    expect(await reopened.sourceId()).toBe(sourceId);
    expect(await reopened.pending(archive.id, 'destination')).toEqual({ revision: 1 });
    expect((await reopened.read(archive.id, 1))?.digest).toBe(archive.digest);
    await reopened.delivered(archive.id, 'destination', archive.digest);
    expect(await reopened.pending(archive.id, 'destination')).toBeNull();
    expect(await reopened.receipt(archive.id, 'destination')).toBe(archive.digest);
  } finally {
    await reopened.close();
  }
});

test('generated setup content remains evidence without becoming the default archive title', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'titled' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<recommended_plugins>Generated setup</recommended_plugins>',
          },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Design our shared archives' }],
      },
    },
  ];
  const result = importTranscript(rows.map((row) => JSON.stringify(row)).join('\n'), {
    source: 'codex',
    sourceId: snapshot().sourceId,
  });
  expect(result.title).toBe('Design our shared archives');
  expect(result.entries).toHaveLength(2);
});
