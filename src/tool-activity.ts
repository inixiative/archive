import { type ArchiveEntry, type ArchiveSnapshot, archiveSnapshotSchema } from './index';
import { type ArchiveIntegration, archiveReferences, defaultIntegrations } from './tags';

/** Entry kinds a deployment can decline to keep (`captureToolCallsAndResults`). */
export const TOOL_ACTIVITY_KINDS = ['tool-call', 'tool-result'] as const;
export const TOOL_ACTIVITY_OMISSION =
  "Tool calls and tool results are not kept: this Archive's captureToolCallsAndResults setting is off.";
const MAX_REFERENCES = 100;

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
type ToolCall = { name: string; input?: Record<string, unknown> };
/** A tool call's name and input, as the importers (`name`) and Foundry (`tool`) write them. */
const toolCall = (entry: ArchiveEntry | undefined): ToolCall | undefined => {
  const call = record(entry && parse(entry.text));
  const name = string(call?.name) ?? string(call?.tool);
  if (!name) return undefined;
  const raw = call?.input ?? call?.arguments;
  return { name, input: record(typeof raw === 'string' ? parse(raw) : raw) };
};

const REJECTED = /^The user doesn't want to proceed with this tool use\./;
const SAID = /the user said:\s*/;

/**
 * The person's side of a tool result, one recogniser per shape Claude Code and Codex write. Each
 * gives the entry the result becomes: `user` for what the person typed, `event` for a choice they
 * made without typing. Results that match none are tool activity.
 */
const RESULT_SHAPES: {
  shape: string;
  read: (result: string, call?: ToolCall) => { kind: 'user' | 'event'; text: string } | undefined;
}[] = [
  {
    // AskUserQuestion: `The user answered: "question"="answer"` (older Claude Code wrote
    // `Your questions have been answered: …`). The questions are in the text.
    shape: 'answered',
    read: (result) =>
      /^(?:The user answered|Your questions have been answered): /.test(result)
        ? { kind: 'user', text: result }
        : undefined,
  },
  {
    // A rejected tool use or plan with the person's typed feedback. Asking to clarify a question
    // instead of answering it is a choice, and keeps the questions it names.
    shape: 'rejected with feedback',
    read: (result) => {
      const said = REJECTED.test(result) ? SAID.exec(result) : null;
      if (!said) return undefined;
      const feedback = result.slice(said.index + said[0].length).trim();
      if (!feedback) return undefined;
      return {
        kind: /^The user wants to clarify these questions\./.test(feedback) ? 'event' : 'user',
        text: result,
      };
    },
  },
  {
    // A rejection without feedback: the refusal of that call is the signal.
    shape: 'rejected',
    read: (result, call) => {
      if (!REJECTED.test(result) || SAID.test(result)) return undefined;
      const command = string(call?.input?.command);
      return {
        kind: 'event',
        text: JSON.stringify({
          rejected: call?.name ?? 'tool use',
          ...(command && command.length <= 500 ? { command } : {}),
        }),
      };
    },
  },
  {
    // ExitPlanMode approval; the approved plan is in the text.
    shape: 'plan approved',
    read: (result) =>
      /^User has approved your plan\./.test(result) ? { kind: 'event', text: result } : undefined,
  },
  {
    // Codex request_user_input: answers by question id, written here with their questions.
    shape: 'codex answered',
    read: (result, call) => {
      if (call?.name !== 'request_user_input') return undefined;
      const answers = record(record(parse(result))?.answers);
      if (!answers) return undefined;
      const questions = Array.isArray(call.input?.questions) ? call.input.questions : [];
      const parts = Object.entries(answers).flatMap(([id, value]) => {
        const given = record(value)?.answers;
        const list = Array.isArray(given) ? given.filter((a) => string(a)) : [];
        if (!list.length) return [];
        const question = questions.map(record).find((q) => q?.id === id);
        return [`"${string(question?.question) ?? id}"="${list.join(', ')}"`];
      });
      return parts.length
        ? { kind: 'user', text: `The user answered: ${parts.join(', ')}` }
        : undefined;
    },
  },
];

/** The shape a tool result matches and the entry it becomes, or undefined for tool activity. */
export function personToolResult(result: ArchiveEntry, call?: ArchiveEntry) {
  if (result.kind !== 'tool-result') return undefined;
  const asked = toolCall(call);
  for (const { shape, read } of RESULT_SHAPES) {
    const entry = read(result.text, asked);
    if (entry) return { shape, ...entry };
  }
  return undefined;
}

/** Tool results that carry the person's answers or choices become user or event entries. */
export function personToolResults(entries: ArchiveEntry[]) {
  const calls = new Map(
    entries.flatMap((entry) =>
      entry.kind === 'tool-call' && entry.callId ? [[entry.callId, entry] as const] : [],
    ),
  );
  return entries.map((entry) => {
    const person = personToolResult(entry, entry.callId ? calls.get(entry.callId) : undefined);
    return person ? { ...entry, kind: person.kind, text: person.text } : entry;
  });
}

/**
 * Tool calls the strip keeps as a small event with the call's id and callId, one recogniser per
 * shape: subagent spawns, which a child's `lineage.toolUseId` points at, and a Codex
 * `request_user_input_async` question whose answer message does not repeat it.
 */
const CALL_SHAPES: {
  shape: string;
  keep: (call: ToolCall, entry: ArchiveEntry, entries: ArchiveEntry[]) => object | undefined;
}[] = [
  {
    shape: 'spawn',
    keep: (call) => {
      if (!['Agent', 'Task', 'spawn_agent'].includes(call.name)) return undefined;
      const detail =
        string(call.input?.description) ??
        string(call.input?.agent_type) ??
        string(call.input?.subagent_type);
      return { spawned: call.name, ...(detail ? { description: detail.slice(0, 500) } : {}) };
    },
  },
  {
    shape: 'codex question',
    keep: (call, entry, entries) => {
      if (call.name !== 'request_user_input_async' || !entry.callId) return undefined;
      const callId = entry.callId;
      // The answer arrives later as a message naming the call, with the question in it.
      const answered = entries.some(
        (other) =>
          other.kind !== 'tool-call' &&
          other.text.includes('send_user_message_question_reply') &&
          other.text.includes(callId),
      );
      if (answered) return undefined;
      const questions = (Array.isArray(call.input?.questions) ? call.input.questions : [])
        .map(record)
        .flatMap((q) => string(q?.question) ?? string(q?.title) ?? []);
      return questions.length ? { asked: questions } : undefined;
    },
  },
];

/**
 * The snapshot without tool calls and tool results, its coverage saying so. What survives:
 * - the person's answers, feedback and choices made through a tool (`RESULT_SHAPES`);
 * - references linked only from tool activity, recorded in `references` (at most 100; a coverage
 *   omission counts any beyond);
 * - the calls `CALL_SHAPES` keep, as events with their id and callId.
 *
 * `changed` counts the entries dropped or rewritten; a snapshot with none is returned as it was.
 */
export function withoutToolActivity(
  snapshot: ArchiveSnapshot,
  integrations: ArchiveIntegration[] = defaultIntegrations,
) {
  const kinds: readonly string[] = TOOL_ACTIVITY_KINDS;
  const personal = personToolResults(snapshot.entries);
  const dropped: ArchiveEntry[] = [];
  const entries = personal.flatMap((entry): ArchiveEntry[] => {
    if (!kinds.includes(entry.kind)) return [entry];
    dropped.push(entry);
    const call = entry.kind === 'tool-call' ? toolCall(entry) : undefined;
    const kept = call
      ? CALL_SHAPES.map(({ keep }) => keep(call, entry, personal)).find(Boolean)
      : undefined;
    if (!kept) return [];
    return [
      {
        id: entry.id,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        ...(entry.callId ? { callId: entry.callId } : {}),
        kind: 'event',
        text: JSON.stringify(kept),
        timestamp: entry.timestamp,
        sourceRef: entry.sourceRef,
      },
    ];
  });
  const changed =
    dropped.length + personal.filter((entry, i) => entry !== snapshot.entries[i]).length;
  if (!changed) return { snapshot, changed };
  // Links the kept text still carries are found there; only those in dropped entries are recorded.
  const key = (r: { integration: string; ref: string }) => JSON.stringify([r.integration, r.ref]);
  const kept = new Set(
    archiveReferences({ ...snapshot, entries }, integrations, Number.MAX_SAFE_INTEGER).map(key),
  );
  const linked = archiveReferences(
    { ...snapshot, references: [], entries: dropped },
    integrations,
    Number.MAX_SAFE_INTEGER,
  )
    .map(({ integration, ref }) => ({ integration, ref }))
    .filter((r) => !kept.has(key(r)));
  const all = [...(snapshot.references ?? []), ...linked];
  const references = all.slice(0, MAX_REFERENCES);
  const cut = all.length - references.length;
  const omissions = [
    ...snapshot.coverage.omissions,
    TOOL_ACTIVITY_OMISSION,
    ...(cut
      ? [`${cut} references linked from tool activity beyond ${MAX_REFERENCES} were not recorded`]
      : []),
  ];
  return {
    snapshot: archiveSnapshotSchema.parse({
      ...snapshot,
      ...(references.length ? { references } : {}),
      coverage: {
        ...snapshot.coverage,
        completeness: 'partial',
        omissions: [...new Set(omissions)].slice(-100),
      },
      entries,
    }),
    changed,
  };
}
