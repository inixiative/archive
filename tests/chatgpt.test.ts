import { expect, test } from 'bun:test';
import { importChatGPTThread } from '../src/chatgpt';
import { LocalArchiveStore } from '../src/local';
import { createArchiveHandler } from '../src/server';

test('ChatGPT reader export preserves source, chronology, tags and partial coverage through hosted ingest', async () => {
  const store = new LocalArchiveStore(':memory:');
  try {
    const snapshot = importChatGPTThread(
      {
        thread: { id: 'chat-one', kind: 'chatgpt', title: 'Personal conversation' },
        page: { order: 'newest_first', hasMore: true },
        turns: [
          {
            id: 'two',
            startedAt: 2,
            completedAt: 3,
            items: [{ id: 'a', type: 'agentMessage', text: 'Answer' }],
          },
          {
            id: 'one',
            startedAt: 1,
            completedAt: 2,
            items: [
              { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
            ],
          },
        ],
      },
      { sourceId: store.sourceId, projectId: 'personal' },
    );
    expect(snapshot.entries.map((e) => e.text)).toEqual(['Question', 'Answer']);
    expect(snapshot.entries[0]?.timestamp).toBe(1000);
    expect(snapshot.source).toBe('chatgpt');
    expect(snapshot.coverage.completeness).toBe('partial');
    expect(snapshot.coverage.omissions.some((x) => x.includes('Older'))).toBe(true);
    snapshot.tags = ['personal'];
    const handler = createArchiveHandler(store, 'synthetic-chatgpt-test-token-000000');
    const response = await handler(
      new Request('http://localhost/api/v1/archive/ingest', {
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-chatgpt-test-token-000000' },
        body: JSON.stringify({ snapshot, previousDigest: null }),
      }),
    );
    expect(response.status).toBe(200);
    expect(store.list()[0]?.tags).toEqual(['personal']);
    expect(() =>
      importChatGPTThread({ thread: { kind: 'codex' } }, { sourceId: store.sourceId }),
    ).toThrow();
  } finally {
    store.close();
  }
});
