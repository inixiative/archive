import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type ImportOptions, importTranscriptLines, MUSE_SPAWN_SUFFIX } from './import';
import { type ArchiveLineage, archiveLineageSchema } from './index';

/** The agent id in a Claude subagent transcript's name (`agent-<id>.jsonl`), else undefined. */
export const transcriptAgentId = (file: string) =>
  /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(basename(file))?.[1];

/**
 * The sessions above a Muse subagent's transcript, nearest first: Muse writes a session's
 * subagents beside it, at `<session>/subagent/<child>/session.jsonl`, to any depth. Empty for a
 * top-level session.
 */
export function museAncestors(file: string) {
  const ancestors: { sessionId: string; file: string }[] = [];
  for (let directory = dirname(file); basename(dirname(directory)) === 'subagent'; ) {
    directory = dirname(dirname(directory));
    ancestors.push({ sessionId: basename(directory), file: join(directory, 'session.jsonl') });
  }
  return ancestors;
}

/** A transcript's lines, read in bounded chunks. */
function* transcriptLines(file: string) {
  const descriptor = openSync(file, 'r');
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1_000_000_000)
      throw new Error('Import requires a transcript file no larger than 1 GB');
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '',
      bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      bytes += count;
      if (bytes > 1_000_000_000) throw new Error('Transcript grew beyond the 1 GB import limit');
      pending += count
        ? decoder.decode(buffer.subarray(0, count), { stream: true })
        : decoder.decode();
      let start = 0;
      let newline = pending.indexOf('\n', start);
      while (newline >= 0) {
        if (newline - start > 64_000_000)
          throw new Error('Transcript record exceeds the 64 million character limit');
        yield pending.slice(start, newline);
        start = newline + 1;
        newline = pending.indexOf('\n', start);
      }
      pending = pending.slice(start);
      if (pending.length > 64_000_000)
        throw new Error('Transcript record exceeds the 64 million character limit');
      if (!count) {
        if (pending) yield pending;
        break;
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Bound raw record memory while skipping unsupported payloads from long native histories. */
export function importTranscriptFile(file: string, options: ImportOptions) {
  const agentId = options.source === 'claude-code' ? transcriptAgentId(file) : undefined;
  const snapshot = importTranscriptLines(
    transcriptLines(file),
    agentId ? { ...options, agentId } : options,
  );
  if (options.source === 'claude-code' && snapshot.lineage) {
    const meta = subagentMeta(file, snapshot.lineage);
    if (meta) snapshot.lineage = archiveLineageSchema.parse({ ...snapshot.lineage, ...meta });
  }
  if (options.source === 'muse') {
    const ancestors = museAncestors(file);
    if (ancestors.length)
      snapshot.lineage = archiveLineageSchema.parse({
        kind: 'subagent',
        parentSessionId: ancestors[0]!.sessionId,
        rootSessionId: ancestors.at(-1)!.sessionId,
        ...museSpawn(ancestors[0]!.file, snapshot.sessionId),
      });
  }
  return snapshot;
}

/**
 * The parent's record that started a Muse subagent (a run event naming it as `child_session_id`,
 * such as `memory_reminder_child_session_linked`): the parent entry the import makes of it, and
 * the agent it names. Empty when the parent's transcript is gone or never names the child.
 */
function museSpawn(parentFile: string, childSessionId: string) {
  if (!existsSync(parentFile)) return {};
  try {
    for (const line of transcriptLines(parentFile)) {
      if (!line.includes(childSessionId)) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const event = row?.payload?.kind === 'run' ? row.payload.event : undefined;
      if (event?.child_session_id !== childSessionId || typeof row.id !== 'string') continue;
      const agentType = typeof event.reminder_agent_id === 'string' ? event.reminder_agent_id : '';
      return {
        parentEntryId: `${row.id}:${MUSE_SPAWN_SUFFIX}`,
        ...(agentType ? { agentType: agentType.slice(0, 200) } : {}),
      };
    }
  } catch {}
  return {};
}

/**
 * Claude Code writes `agent-<id>.meta.json` beside a subagent transcript: its type, task and depth,
 * whether it is a fork, and for a nested subagent the agent that spawned it (`parentAgentId`),
 * whose session is `<root>/agent-<parentAgentId>`.
 */
function subagentMeta(file: string, lineage: ArchiveLineage) {
  const path = file.replace(/\.jsonl$/, '.meta.json');
  if (path === file || !existsSync(path)) return undefined;
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value ? value.slice(0, max) : undefined;
  const root = lineage.rootSessionId ?? lineage.parentSessionId;
  const parentAgentId = text(meta.parentAgentId, 256);
  const fields = {
    kind: meta.isFork === true ? 'fork' : undefined,
    parentSessionId: parentAgentId ? `${root}/agent-${parentAgentId}` : undefined,
    agentType: text(meta.agentType, 200),
    agentName: text(meta.name, 200),
    description: text(meta.description, 500),
    toolUseId: text(meta.toolUseId, 256),
    depth: Number.isInteger(meta.spawnDepth) ? (meta.spawnDepth as number) : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
