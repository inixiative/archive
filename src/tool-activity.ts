import { type ArchiveEntry, type ArchiveSnapshot, archiveSnapshotSchema } from './index';
import { type ArchiveIntegration, archiveReferences, defaultIntegrations } from './tags';

/** Entry kinds a deployment can decline to keep (`captureToolCallsAndResults`). */
export const TOOL_ACTIVITY_KINDS = ['tool-call', 'tool-result'] as const;
export const TOOL_ACTIVITY_OMISSION =
  "Tool calls and tool results are not kept: this Archive's captureToolCallsAndResults setting is off.";

/** Tools that start a subagent: their calls are what a child's `lineage.toolUseId` points at. */
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'spawn_agent']);
/** Codex's tool for asking the person questions; its output holds their answers. */
const CODEX_QUESTION_TOOLS = new Set(['request_user_input']);
const REJECTION = /^The user doesn't want to proceed with this tool use\.[\s\S]*?the user said:\s*/;
/** What Claude Code writes when the person chose to clarify a question instead of answering it. */
const CLARIFY = /^The user wants to clarify these questions\./;

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
/** A tool call's name and input, as the importers and Foundry write them. */
const toolCall = (entry: ArchiveEntry | undefined) => {
  const call = record(entry && parse(entry.text));
  const name = typeof call?.name === 'string' ? call.name : call?.tool;
  if (typeof name !== 'string') return undefined;
  const raw = call?.input ?? call?.arguments;
  return { name, input: record(typeof raw === 'string' ? parse(raw) : raw) };
};

/**
 * The person's side of a tool result:
 * - `user`, what they typed: Claude Code's AskUserQuestion answers (`The user answered:
 *   "question"="answer"`), a rejected tool use or plan with their feedback (`… the user said: …`),
 *   and Codex `request_user_input` answers, rendered with their questions;
 * - `event`, a choice they made without typing (asking to clarify a question), which keeps the
 *   questions it names.
 */
export function typedToolResult(
  result: ArchiveEntry,
  call?: ArchiveEntry,
): { kind: 'user' | 'event'; text: string } | undefined {
  if (result.kind !== 'tool-result') return undefined;
  if (result.text.startsWith('The user answered: ')) return { kind: 'user', text: result.text };
  const rejection = REJECTION.exec(result.text);
  if (rejection) {
    const said = result.text.slice(rejection[0].length);
    if (!said.trim()) return undefined;
    return { kind: CLARIFY.test(said) ? 'event' : 'user', text: result.text };
  }
  const asked = toolCall(call);
  if (!asked || !CODEX_QUESTION_TOOLS.has(asked.name)) return undefined;
  const answers = record(record(parse(result.text))?.answers);
  if (!answers) return undefined;
  const questions = Array.isArray(asked.input?.questions) ? asked.input.questions : [];
  const parts = Object.entries(answers).flatMap(([id, value]) => {
    const given = record(value)?.answers;
    const list = Array.isArray(given) ? given.filter((a) => typeof a === 'string' && a) : [];
    if (!list.length) return [];
    const question = questions.map(record).find((q) => q?.id === id);
    const text = typeof question?.question === 'string' ? question.question : id;
    return [`"${text}"="${list.join(', ')}"`];
  });
  return parts.length
    ? { kind: 'user', text: `The user answered: ${parts.join(', ')}` }
    : undefined;
}

/** Tool results that carry the person's answers become user (or event) entries, the question in their text. */
export function typedToolResultsAsUser(entries: ArchiveEntry[]) {
  const calls = new Map(
    entries.flatMap((entry) =>
      entry.kind === 'tool-call' && entry.callId ? [[entry.callId, entry] as const] : [],
    ),
  );
  return entries.map((entry) => {
    const typed = typedToolResult(entry, entry.callId ? calls.get(entry.callId) : undefined);
    return typed ? { ...entry, ...typed } : entry;
  });
}

/**
 * The snapshot without tool calls and tool results, its coverage saying so. What survives:
 * - what the person typed into a tool (answers, rejection feedback) as user entries;
 * - references linked only from tool activity, recorded in `references`;
 * - each subagent spawn as an event with the call's id and callId, so a child's lineage still
 *   resolves.
 *
 * `changed` counts the entries dropped or rewritten; a snapshot with none is returned as it was.
 */
export function withoutToolActivity(
  snapshot: ArchiveSnapshot,
  integrations: ArchiveIntegration[] = defaultIntegrations,
) {
  const kinds: readonly string[] = TOOL_ACTIVITY_KINDS;
  const typed = typedToolResultsAsUser(snapshot.entries);
  const dropped: ArchiveEntry[] = [];
  const entries = typed.flatMap((entry): ArchiveEntry[] => {
    if (!kinds.includes(entry.kind)) return [entry];
    dropped.push(entry);
    const spawn = entry.kind === 'tool-call' ? toolCall(entry) : undefined;
    if (!spawn || !SPAWN_TOOLS.has(spawn.name)) return [];
    const detail =
      spawn.input?.description ?? spawn.input?.agent_type ?? spawn.input?.subagent_type;
    return [
      {
        id: entry.id,
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
        ...(entry.callId ? { callId: entry.callId } : {}),
        kind: 'event',
        text: JSON.stringify({
          spawned: spawn.name,
          ...(typeof detail === 'string' ? { description: detail.slice(0, 500) } : {}),
        }),
        timestamp: entry.timestamp,
        sourceRef: entry.sourceRef,
      },
    ];
  });
  const changed = dropped.length + typed.filter((entry, i) => entry !== snapshot.entries[i]).length;
  if (!changed) return { snapshot, changed };
  // Links the kept text still carries are found there; only those in dropped entries are recorded.
  const kept = new Set(
    archiveReferences({ ...snapshot, entries }, integrations, 1_000).map((r) =>
      JSON.stringify([r.integration, r.ref]),
    ),
  );
  const linked = archiveReferences(
    { ...snapshot, references: [], entries: dropped },
    integrations,
    100,
  )
    .map(({ integration, ref }) => ({ integration, ref }))
    .filter((r) => !kept.has(JSON.stringify([r.integration, r.ref])));
  const references = [...(snapshot.references ?? []), ...linked].slice(0, 100);
  const omissions = snapshot.coverage.omissions.includes(TOOL_ACTIVITY_OMISSION)
    ? snapshot.coverage.omissions
    : [...snapshot.coverage.omissions, TOOL_ACTIVITY_OMISSION].slice(-100);
  return {
    snapshot: archiveSnapshotSchema.parse({
      ...snapshot,
      ...(references.length ? { references } : {}),
      coverage: { ...snapshot.coverage, completeness: 'partial', omissions },
      entries,
    }),
    changed,
  };
}
