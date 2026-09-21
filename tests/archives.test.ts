import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTranscript } from '../src/import';
import { archiveSnapshotSchema, chunkArchive, selectChunks, snapshotDigest } from '../src/index';
import { LocalArchiveStore } from '../src/local';

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
  test('capture is idempotent, retains prior versions and rejects older replacements', () => {
    const store = new LocalArchiveStore(':memory:');
    try {
      const s = snapshot(),
        first = store.capture(s);
      expect(store.capture({ ...s, capturedAt: 2 }).changed).toBe(false);
      const edited = { ...s, title: 'Changed', capturedAt: 3 };
      expect(store.capture(edited).revision).toBe(2);
      expect(store.read(first.id, 1)?.snapshot.title).toBe(s.title);
      expect(() => store.capture({ ...s, capturedAt: 2 })).toThrow('Older capture');
      expect(store.receipt(first.id, 'destination')).toBeNull();
      store.acknowledge(first.id, 'destination', snapshotDigest(edited));
      expect(store.receipt(first.id, 'destination')).toBe(snapshotDigest(edited));
    } finally {
      store.close();
    }
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
});

test('a pending upload and source identity survive closing and reopening the archive store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'archive-outbox-test-'));
  const path = join(directory, 'archives.sqlite');
  const original = new LocalArchiveStore(path);
  const sourceId = original.sourceId;
  const archive = original.capture(snapshot());
  original.enqueue(archive.id, 'destination', { revision: 1, keepIds: ['keep-a'] });
  original.close();
  const reopened = new LocalArchiveStore(path);
  try {
    expect(reopened.sourceId).toBe(sourceId);
    expect(reopened.pending(archive.id, 'destination')).toEqual({
      revision: 1,
      keepIds: ['keep-a'],
    });
    expect(reopened.read(archive.id, 1)?.digest).toBe(archive.digest);
    reopened.delivered(archive.id, 'destination', archive.digest, '["keep-a"]');
    expect(reopened.pending(archive.id, 'destination')).toBeNull();
    expect(reopened.receipt(archive.id, 'destination')).toBe(archive.digest);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
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
