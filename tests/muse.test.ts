import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHistoryDirectory } from '../src/agents';
import { collectSessions, historyFiles, sessionMetadata } from '../src/collector';
import { type Routing, sessionOrganizations } from '../src/config';
import { importTranscript } from '../src/import';
import { importTranscriptFile } from '../src/import-file';
import { previewImports } from '../src/preview';
import { planSession, type RoutingArchive } from '../src/route';
import type { SuggestModel } from '../src/suggest';
import { toolCallAccess } from '../src/tags';
import { withoutToolActivity } from '../src/tool-activity';
import { freshStore } from './db';

// Synthetic Muse Code (`muse` 1.4.x) transcripts: the envelope and record shapes Muse writes, with
// made-up ids, text and paths.
const sourceId = '7d0c1b2a-3e4f-4a5b-8c6d-7e8f90a1b2c3';
const ROOT = '01900000-0000-7000-8000-000000000001';
const CHILD = '01900000-0000-7000-8000-000000000002';
const GRANDCHILD = '01900000-0000-7000-8000-000000000003';
const RUN = '01900000-0000-7000-8000-0000000000a1';
const START = 1_780_000_000_000_000; // microseconds

let sequence = 0;
const record = (session: string, payloadType: string, payload: object, at = sequence) => {
  sequence++;
  return JSON.stringify({
    schema_version: 1,
    id: `01900000-0000-7000-9000-${String(sequence).padStart(12, '0')}`,
    stream: { kind: 'session', id: session },
    sequence,
    recorded_at: START + at * 1000,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
};
const run = (session: string, runId: string, event: object) =>
  record(session, 'runtime.session', {
    kind: 'run',
    run_id: runId,
    event,
    source_run_record_id: 'b0b0b0b0-0000-4000-8000-000000000000',
    source_run_record_sequence: 1,
  });
/** A frame of another shape, as Muse writes for a permission transaction. */
const frame = JSON.stringify({
  retained_frame: 'session_permission_transaction',
  frame_schema_version: 1,
  children: [{ child_index: 0, record_json: '{}' }],
});

const parentLines = (cwd: string) => [
  frame,
  record(ROOT, 'runtime.session.metadata', {
    kind: 'metadata',
    record: { workspace_root: cwd, provider_id: 'meta', build: { semver: '1.4.14' } },
  }),
  record(ROOT, 'runtime.session.route_facts', { kind: 'route_facts', record: { cwd, pid: 1 } }),
  record(ROOT, 'run.model.configured', {
    kind: 'run_model',
    record: { run_stream: { kind: 'run', id: RUN }, provider_id: 'meta', model_id: 'muse-test-1' },
  }),
  record(ROOT, 'runtime.user_intent.accepted', {
    intent_id: RUN,
    source_session_id: ROOT,
    surface: 'main',
    semantic_kind: { kind: 'chat' },
    refill_blocks: [{ kind: 'text', text: 'Tidy the widget module' }],
    model_messages: [{ content: [{ kind: 'text', text: 'Tidy the widget module' }] }],
  }),
  // The run's start repeats the prompt: not a second user entry.
  run(ROOT, RUN, { kind: 'started', prompt: 'Tidy the widget module' }),
  run(ROOT, RUN, {
    kind: 'memory_reminder_child_session_linked',
    parent_session_id: ROOT,
    parent_run_id: RUN,
    reminder_agent_id: 'goal-reminder',
    child_session_id: CHILD,
    child_session_log_path: `subagent/${CHILD}/session.jsonl`,
  }),
  run(ROOT, RUN, { kind: 'reasoning_summary_delta', text: 'Look', summary_index: 0 }),
  run(ROOT, RUN, { kind: 'reasoning_summary_committed', text: 'Look at the module first' }),
  run(ROOT, RUN, { kind: 'reasoning_committed', text: '', encrypted_content: 'ENCRYPTED-BLOB' }),
  run(ROOT, RUN, {
    kind: 'assistant_message_committed',
    text: 'Reading the module.',
    phase: 'commentary',
  }),
  run(ROOT, RUN, {
    kind: 'assistant_tool_calls_committed',
    tool_calls: [
      { id: 'fc_1', call_id: 'call_1', name: 'read_file', args: '{"path":"src/widget.ts"}' },
      {
        id: 'fc_2',
        call_id: 'call_2',
        name: 'write_file',
        args: JSON.stringify({ path: `${cwd}/src/widget.ts`, content: 'export {}' }),
      },
    ],
  }),
  run(ROOT, RUN, {
    kind: 'tool_result_batch_committed',
    results: [
      { tool_call_index: 0, tool_call_id: 'call_1', text: 'export const widget = 1;' },
      { tool_call_index: 1, tool_call_id: 'call_2', text: 'file written' },
    ],
  }),
  run(ROOT, RUN, { kind: 'model_completed', model: 'muse-test-1', usage: { input_tokens: 1 } }),
  run(ROOT, RUN, { kind: 'assistant_message_committed', text: 'Done.' }),
  run(ROOT, RUN, { kind: 'terminal', terminal: 'completed', reason: null }),
  record(ROOT, 'session.end', { kind: 'session_end', record: { exit_reason: 'clean' } }),
];
const childLines = (session: string, runId: string) => [
  frame,
  record(session, 'runtime.session.metadata', {
    kind: 'metadata',
    record: { provider_id: 'meta', model_id: 'muse-test-mini' },
  }),
  run(session, runId, { kind: 'started', prompt: 'You watch the main agent for goal drift.' }),
  run(session, runId, {
    kind: 'assistant_tool_calls_committed',
    tool_calls: [
      { call_id: 'call_9', name: 'submit_reminder_decision', args: '{"needs_reminder":false}' },
    ],
  }),
  run(session, runId, {
    kind: 'tool_result_batch_committed',
    results: [{ tool_call_index: 0, tool_call_id: 'call_9', text: 'decision recorded' }],
  }),
];
const write = (file: string, lines: string[]) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
};
/** A Muse home's `sessions` directory: one session with a subagent, which has its own. */
const museHome = (cwd = '/work/widgets') => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-muse-'));
  const session = join(dir, '2026/01/02', ROOT);
  const child = join(session, 'subagent', CHILD);
  write(join(session, 'session.jsonl'), parentLines(cwd));
  write(join(child, 'session.jsonl'), childLines(CHILD, CHILD));
  write(join(child, 'subagent', GRANDCHILD, 'session.jsonl'), childLines(GRANDCHILD, GRANDCHILD));
  // What else Muse keeps beside a session: never a transcript.
  writeFileSync(join(session, 'cli-1.log'), 'log\n');
  writeFileSync(join(session, 'cron.db'), '');
  writeFileSync(join(session, '.session.lock'), '');
  writeFileSync(join(session, 'session.peer-history.sqlite3'), '');
  writeFileSync(join(session, 'notes.jsonl'), '{}\n');
  return { dir, session, child };
};

test('a Muse session imports as user, assistant, reasoning-summary and tool entries', () => {
  const snapshot = importTranscript(parentLines('/work/widgets').join('\n'), {
    source: 'muse',
    sourceId,
  });
  expect(snapshot).toMatchObject({
    source: 'muse',
    sessionId: ROOT,
    title: 'Tidy the widget module',
    runtime: { provider: 'meta', accessPath: 'subscription', evidence: 'harness' },
    coverage: { reasoning: 'summaries-only', completeness: 'partial' },
  });
  expect(snapshot.lineage).toBeUndefined();
  expect(snapshot.entries.map((e) => [e.kind, e.text, e.callId, e.model])).toEqual([
    ['user', 'Tidy the widget module', undefined, undefined],
    ['event', JSON.stringify({ spawned: 'goal-reminder', sessionId: CHILD }), undefined, undefined],
    ['reasoning-summary', 'Look at the module first', undefined, 'muse-test-1'],
    ['assistant', 'Reading the module.', undefined, 'muse-test-1'],
    [
      'tool-call',
      JSON.stringify({ name: 'read_file', arguments: '{"path":"src/widget.ts"}' }),
      'call_1',
      'muse-test-1',
    ],
    [
      'tool-call',
      JSON.stringify({
        name: 'write_file',
        arguments: JSON.stringify({ path: '/work/widgets/src/widget.ts', content: 'export {}' }),
      }),
      'call_2',
      'muse-test-1',
    ],
    ['tool-result', 'export const widget = 1;', 'call_1', undefined],
    ['tool-result', 'file written', 'call_2', undefined],
    ['assistant', 'Done.', undefined, 'muse-test-1'],
  ]);
  const [user] = snapshot.entries;
  // Ids are the record's own, timestamps its microseconds in milliseconds.
  expect(user!.id).toMatch(/^01900000-0000-7000-9000-\d{12}:text-0$/);
  expect(user!.sourceRef).toBe('line:5');
  expect(Number.isInteger(user!.timestamp)).toBe(true);
  expect(user!.timestamp! - START / 1000).toBeGreaterThan(0);
  // Encrypted reasoning is never stored.
  expect(JSON.stringify(snapshot)).not.toContain('ENCRYPTED-BLOB');
  expect(snapshot.coverage.omissions).toContain(
    'Private reasoning and encrypted payloads are not included',
  );
  // One session per transcript.
  expect(() =>
    importTranscript([...parentLines('/w'), ...childLines(CHILD, CHILD)].join('\n'), {
      source: 'muse',
      sourceId,
    }),
  ).toThrow('Mixed transcript sessions');
  // A session with no turns (a sign-in) has nothing to archive.
  expect(() =>
    importTranscript(parentLines('/w').slice(0, 4).join('\n'), { source: 'muse', sourceId }),
  ).toThrow('contain supported records');
});

test('the strip drops Muse tool activity and evidence reads its file tools', () => {
  const snapshot = importTranscript(parentLines('/work/widgets').join('\n'), {
    source: 'muse',
    sourceId,
  });
  const { snapshot: stripped } = withoutToolActivity(snapshot);
  expect(stripped.entries.map((e) => e.kind)).toEqual([
    'user',
    'event',
    'reasoning-summary',
    'assistant',
    'assistant',
  ]);
  // A subagent Muse spawns through its tool stays, as a spawn event.
  const spawning = importTranscript(
    [
      run(ROOT, RUN, {
        kind: 'assistant_tool_calls_committed',
        tool_calls: [
          { call_id: 'call_5', name: 'subagent_spawn', args: '{"description":"Check the docs"}' },
        ],
      }),
    ].join('\n'),
    { source: 'muse', sourceId },
  );
  expect(withoutToolActivity(spawning).snapshot.entries).toMatchObject([
    {
      kind: 'event',
      callId: 'call_5',
      text: JSON.stringify({ spawned: 'subagent_spawn', description: 'Check the docs' }),
    },
  ]);
  const [read, written] = snapshot.entries.filter((e) => e.kind === 'tool-call');
  expect(toolCallAccess(read!.text, '/work/widgets')).toMatchObject({
    paths: ['/work/widgets/src/widget.ts'],
    writes: [],
  });
  expect(toolCallAccess(written!.text, '/work/widgets')).toMatchObject({
    writes: ['/work/widgets/src/widget.ts'],
  });
  // Muse's shell tool is read like the others.
  expect(
    toolCallAccess(
      JSON.stringify({ name: 'bash', arguments: '{"command":"cat docs/a.md"}' }),
      '/work/widgets',
    ).paths,
  ).toContain('/work/widgets/docs/a.md');
});

test('a Muse subagent is its own session, linked to its parent, root and spawning entry', () => {
  const { dir, session, child } = museHome();
  try {
    const parent = importTranscriptFile(join(session, 'session.jsonl'), {
      source: 'muse',
      sourceId,
    });
    const snapshot = importTranscriptFile(join(child, 'session.jsonl'), {
      source: 'muse',
      sourceId,
    });
    const spawn = parent.entries.find((e) => e.kind === 'event')!;
    expect(snapshot).toMatchObject({
      sessionId: CHILD,
      // The runtime wrote its prompt: an event that titles it, never a user turn.
      title: 'You watch the main agent for goal drift.',
      lineage: {
        kind: 'subagent',
        parentSessionId: ROOT,
        rootSessionId: ROOT,
        parentEntryId: spawn.id,
        agentType: 'goal-reminder',
      },
    });
    expect(snapshot.entries.some((e) => e.kind === 'user')).toBe(false);
    expect(snapshot.entries.map((e) => e.kind)).toEqual(['event', 'tool-call', 'tool-result']);
    expect(snapshot.entries[1]!.model).toBe('muse-test-mini');
    // A subagent's subagent: its parent is the subagent, its root the session. Its parent's
    // transcript never names it, so no spawning entry.
    const nested = importTranscriptFile(join(child, 'subagent', GRANDCHILD, 'session.jsonl'), {
      source: 'muse',
      sourceId,
    });
    expect(nested.lineage).toEqual({
      kind: 'subagent',
      parentSessionId: CHILD,
      rootSessionId: ROOT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the muse collector finds sessions and their subagents, which run in the parent’s directory', async () => {
  expect(defaultHistoryDirectory('muse')).toBe(join(homedir(), '.local/share/muse/sessions'));
  const { dir, session, child } = museHome('/work/widgets');
  try {
    const files = historyFiles({ directory: dir, source: 'muse' });
    expect(files).toEqual([
      join(session, 'session.jsonl'),
      join(child, 'session.jsonl'),
      join(child, 'subagent', GRANDCHILD, 'session.jsonl'),
    ]);
    expect(sessionMetadata(files[0]!, 'muse')).toEqual({ cwd: '/work/widgets', sessionId: ROOT });
    expect(sessionMetadata(files[2]!, 'muse')).toEqual({
      cwd: '/work/widgets',
      sessionId: GRANDCHILD,
    });
    expect(previewImports(dir, 'muse')).toMatchObject({ ready: 3, rejected: 1 });

    const store = await freshStore();
    const config = {
      directory: dir,
      source: 'muse' as const,
      projectRoots: ['/work/widgets'],
      projectId: 'widgets',
    };
    expect(await collectSessions(store, config)).toMatchObject({ imported: 3, failed: 0 });
    const listed = await store.list({ exempt: 'include' });
    expect(listed.map((a) => [a.source, a.sessionId]).sort()).toEqual([
      ['muse', ROOT],
      ['muse', CHILD],
      ['muse', GRANDCHILD],
    ]);
    expect((await collectSessions(store, config)).unchanged).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a collected Muse session is personal: planned without a model call, published nowhere', async () => {
  const store = await freshStore();
  await store.updateSettings({ captureToolCallsAndResults: false });
  await store.setProjectMap({
    projects: [{ projectId: 'zealot', roots: ['/z'], repositories: ['userevidence/zealot'] }],
  });
  const routing: Routing = {
    organizations: [{ id: 'userevidence', projects: ['zealot'] }],
    destinations: [],
    publish: 'off',
    cleanup: 'leaked',
    cleanupFor: {},
    personalSpans: 'hold',
  };
  const archive: RoutingArchive = {
    routingInput: (body) => store.routingInput(body.archiveId, routing, body.key),
    recordPlan: (body) => store.recordPlan(body, routing),
    routingDue: (body) => store.routingDue(body),
  };
  const asked: string[] = [];
  const model: SuggestModel = {
    model: 'claude-sonnet-5-5',
    async decide({ input }) {
      asked.push(input);
      throw new Error('no model call for Muse');
    },
  };
  // Work in an organization's project: evidence that would route any other session there.
  const { dir } = museHome('/z');
  try {
    await collectSessions(store, {
      directory: dir,
      source: 'muse',
      projectRoots: ['/z'],
      projectId: 'zealot',
    });
    const [captured] = (await store.list({ exempt: 'include' })).filter(
      (a) => a.sessionId === ROOT,
    );
    expect(captured).toMatchObject({ source: 'muse' });
    const tools = (await store.read(captured!.id))!.snapshot.entries.filter((e) =>
      e.kind.startsWith('tool-'),
    );
    expect(tools).toEqual([]);
    expect(await planSession(archive, model, captured!.id)).toMatchObject({ status: 'valid' });
    const parts = await store.list({ exempt: 'include', parts: 'only' });
    expect(parts.flatMap((p) => p.routedTo ?? [])).toEqual([]);
    expect(
      sessionOrganizations(routing, {
        source: 'muse',
        partOf: captured!.id,
        routedTo: ['userevidence'],
      }),
    ).toEqual([]);
    expect(asked).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
