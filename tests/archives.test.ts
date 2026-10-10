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

describe('Claude Code titles are the first message the person typed', () => {
  const claude = (rows: object[]) =>
    importTranscript(
      rows
        .map((row, index) =>
          JSON.stringify({
            sessionId: 'titled-claude',
            uuid: `u-${index}`,
            cwd: '/work/archive',
            type: 'user',
            ...row,
          }),
        )
        .join('\n'),
      { source: 'claude-code', sourceId: snapshot().sourceId },
    );
  const reminder =
    "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\nContents of /work/archive/CLAUDE.md:\nNo any.\n</system-reminder>";

  test('local-command caveats, slash-command wrappers and their output are skipped', () => {
    const result = claude([
      {
        isMeta: true,
        message: {
          role: 'user',
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>',
        },
      },
      {
        message: {
          role: 'user',
          content:
            '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
        },
      },
      {
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Set model to \u001b[1mopus\u001b[22m</local-command-stdout>',
        },
      },
      {
        message: {
          role: 'user',
          content:
            '<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>',
        },
      },
      {
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Review pull request 12 for correctness bugs.' }],
        },
      },
      { message: { role: 'user', content: [{ type: 'text', text: 'Why are titles wrong?' }] } },
    ]);
    expect(result.title).toBe('Why are titles wrong?');
    expect(result.entries.filter((entry) => entry.kind === 'user')).toHaveLength(6);
  });

  test('system reminders are skipped as their own block or as a prefix', () => {
    expect(
      claude([
        {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: reminder },
              { type: 'text', text: 'Fix the collector titles' },
            ],
          },
        },
      ]).title,
    ).toBe('Fix the collector titles');
    expect(
      claude([{ message: { role: 'user', content: `${reminder}\n\nFix the collector titles` } }])
        .title,
    ).toBe('Fix the collector titles');
  });

  test('compaction summaries, interruptions, notifications and hook output are skipped', () => {
    const result = claude([
      {
        isCompactSummary: true,
        message: {
          role: 'user',
          content:
            'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
        },
      },
      {
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      },
      {
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>af8032d61f3e8a02f</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>',
        },
      },
      {
        message: {
          role: 'user',
          content:
            '<user-prompt-submit-hook>Remember the coordination board.</user-prompt-submit-hook>',
        },
      },
      { message: { role: 'user', content: 'Merge it once green' } },
    ]);
    expect(result.title).toBe('Merge it once green');
  });

  test('a fork takes its directive and a Foundry session its user message', () => {
    expect(
      claude([
        {
          isSidechain: true,
          agentId: 'a0c8ef474c8711038',
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: "<fork-boilerplate>\nYou are a worker fork. The transcript above is the parent's history.\n</fork-boilerplate>\n\nYour directive: port the template commits into Kingdom.",
              },
            ],
          },
        },
      ]).title,
    ).toBe('Your directive: port the template commits into Kingdom.');
    expect(
      claude([
        {
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '# System Context\n\nCurrent thread state. Use this to determine what the thread is working on.\n\n{"domain":"general"}\n\n# User Message\n\nSmoke test: reply with the single word PONG.\n\n# Assistant Message\n\nPONG',
              },
            ],
          },
        },
      ]).title,
    ).toBe('Smoke test: reply with the single word PONG.');
    expect(
      claude([
        {
          message: {
            role: 'user',
            content:
              '# User Message\n\nBuild the harness loop.\n\n# Foundry Injection\n\nRouting notes',
          },
        },
      ]).title,
    ).toBe('Build the harness loop.');
  });

  test('pasted text keeps its words without the paste markup', () => {
    expect(
      claude([
        {
          message: {
            role: 'user',
            content:
              '[Image #1]\n\n<pasted_content id="ddc8">\nCompare Foundry and Figma\n</pasted_content>',
          },
        },
      ]).title,
    ).toBe('[Image #1]\n\n\nCompare Foundry and Figma');
  });

  test('a prompt only Claude Code wrote titles the session when nothing was typed', () => {
    expect(
      claude([
        {
          isSidechain: true,
          agentId: 'aa0c36effe0e8dac4',
          isMeta: true,
          message: { role: 'user', content: 'Review target: json-rules pull request 16' },
        },
      ]).title,
    ).toBe('Review target: json-rules pull request 16');
    expect(
      claude([
        {
          isMeta: true,
          message: {
            role: 'user',
            content: '<local-command-caveat>Caveat: run locally.</local-command-caveat>',
          },
        },
        { message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      ]).title,
    ).toBe('titled-claude');
  });
});

test('Codex AGENTS.md instructions are not the title', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'agents-md' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '# AGENTS.md instructions for /work/archive\n\n<INSTRUCTIONS>\nNo any.\n</INSTRUCTIONS>',
          },
          {
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/work/archive</cwd>\n</environment_context>',
          },
        ],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Rename the sync endpoint' }],
      },
    },
  ];
  expect(
    importTranscript(rows.map((row) => JSON.stringify(row)).join('\n'), {
      source: 'codex',
      sourceId: snapshot().sourceId,
    }).title,
  ).toBe('Rename the sync endpoint');
});
