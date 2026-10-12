import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { type ImportOptions, importTranscriptLines } from './import';
import { archiveLineageSchema } from './index';

/** Bound raw record memory while skipping unsupported payloads from long native histories. */
export function importTranscriptFile(file: string, options: ImportOptions) {
  function* lines() {
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
  const snapshot = importTranscriptLines(lines(), options);
  if (options.source === 'claude-code' && snapshot.lineage) {
    const meta = subagentMeta(file);
    if (meta) snapshot.lineage = archiveLineageSchema.parse({ ...snapshot.lineage, ...meta });
  }
  return snapshot;
}

/** Claude Code writes `agent-<id>.meta.json` beside a subagent transcript: its type, task and depth. */
function subagentMeta(file: string) {
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
  const fields = {
    agentType: text(meta.agentType, 200),
    description: text(meta.description, 500),
    toolUseId: text(meta.toolUseId, 256),
    depth: Number.isInteger(meta.spawnDepth) ? (meta.spawnDepth as number) : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
