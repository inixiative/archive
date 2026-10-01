import { createHash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { z } from 'zod';

const identifier = z.string().min(1).max(256);
export const archiveEntrySchema = z.strictObject({
  id: identifier,
  turnId: identifier.optional(),
  callId: identifier.optional(),
  kind: z.enum(['user', 'assistant', 'tool-call', 'tool-result', 'reasoning-summary', 'event']),
  text: z.string().max(2_000_000),
  timestamp: z.number().finite().nonnegative().nullable(),
  sourceRef: z.string().min(1).max(512),
});
/** Who did the work: a person, or a service such as an API-key run. */
export const archiveActorSchema = z.strictObject({
  kind: z.enum(['user', 'service']),
  id: identifier,
  name: z.string().min(1).max(200).optional(),
});
/** An item in an integration (a GitHub pull request, a Linear issue) the session is about. */
export const archiveReferenceSchema = z.strictObject({
  integration: z.string().regex(/^[a-z0-9-]{1,64}$/),
  ref: z.string().min(1).max(300),
});
export const archiveSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    sourceId: z.uuid(),
    source: z.enum(['foundry', 'claude-code', 'codex', 'chatgpt']),
    sessionId: identifier,
    title: z.string().min(1).max(500),
    projectId: identifier.optional(),
    actor: archiveActorSchema.optional(),
    /** Recorded references, such as the session's repository and branch. Linked ones are found in the text. */
    references: z.array(archiveReferenceSchema).max(100).optional(),
    tags: z.array(z.string().min(1).max(120)).max(100),
    goalIds: z.array(identifier).max(100).default([]),
    runIds: z.array(identifier).max(100).default([]),
    capturedAt: z.number().finite().nonnegative(),
    coverage: z.strictObject({
      reasoning: z.enum(['unavailable', 'summaries-only']),
      completeness: z.enum(['recorded', 'partial']),
      omissions: z.array(z.string().max(500)).max(100),
    }),
    entries: z.array(archiveEntrySchema).max(50_000),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate archive entry identities' });
    if (Buffer.byteLength(JSON.stringify(value)) > 64_000_000)
      ctx.addIssue({ code: 'custom', message: 'Archive exceeds 64 MB' });
  });
export type ArchiveSnapshot = z.infer<typeof archiveSnapshotSchema>;
export type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
export type ArchiveActor = z.infer<typeof archiveActorSchema>;
export type ArchiveReference = z.infer<typeof archiveReferenceSchema>;
export interface ArchiveChunk {
  id: string;
  entryId: string;
  sourceRef: string;
  kind: ArchiveEntry['kind'];
  start: number;
  end: number;
  text: string;
  tokenCount: number;
  encoding: 'cl100k_base';
}
let encoding: ReturnType<typeof getEncoding> | undefined;
export const tokenCount = (text: string) => {
  encoding ??= getEncoding('cl100k_base');
  return encoding.encode(text, [], []).length;
};
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const archiveKey = (snapshot: Pick<ArchiveSnapshot, 'sourceId' | 'source' | 'sessionId'>) =>
  digest(JSON.stringify([snapshot.sourceId, snapshot.source, snapshot.sessionId]));
export const snapshotDigest = (snapshot: ArchiveSnapshot) => {
  const { capturedAt: _, ...content } = snapshot;
  return digest(JSON.stringify(content));
};

export function chunkArchive(snapshot: ArchiveSnapshot, budget = 512): ArchiveChunk[] {
  if (!Number.isInteger(budget) || budget < 16 || budget > 8192)
    throw new Error('Invalid chunk token budget');
  const chunks: ArchiveChunk[] = [];
  for (const entry of snapshot.entries) {
    let start = 0;
    while (start < entry.text.length) {
      let end = Math.min(entry.text.length, start + budget * 3);
      if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
      let text = entry.text.slice(start, end);
      while (tokenCount(text) > budget) {
        end = start + Math.max(1, Math.floor((end - start) * 0.8));
        if (end < entry.text.length && /[\uD800-\uDBFF]/.test(entry.text[end - 1])) end--;
        text = entry.text.slice(start, end);
      }
      chunks.push({
        id: digest(JSON.stringify([entry.id, start, end, text])),
        entryId: entry.id,
        sourceRef: entry.sourceRef,
        kind: entry.kind,
        start,
        end,
        text,
        tokenCount: tokenCount(text),
        encoding: 'cl100k_base',
      });
      start = end;
    }
  }
  return chunks;
}

export function selectChunks(chunks: ArchiveChunk[], query: string, budget = 2048) {
  if (!Number.isInteger(budget) || budget < 16 || budget > 32768)
    throw new Error('Invalid context token budget');
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 64);
  const ranked = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: terms.reduce(
        (score, term) => score + Number(chunk.text.toLowerCase().includes(term)),
        0,
      ),
    }))
    .filter((item) => !terms.length || item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: ArchiveChunk[] = [];
  let used = 0;
  for (const { chunk } of ranked) {
    const remaining = budget - used;
    if (remaining < 16) break;
    if (chunk.tokenCount <= remaining) {
      selected.push(chunk);
      used += chunk.tokenCount;
      continue;
    }
    // Return a source-addressable excerpt even when the requested context is smaller than a stored chunk.
    const lower = chunk.text.toLowerCase();
    const match =
      terms
        .map((term) => lower.indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0] ?? 0;
    let offset = Math.max(0, match - Math.floor(remaining / 4));
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(chunk.text[offset])) offset--;
    let end = Math.min(chunk.text.length, offset + remaining * 3);
    if (end < chunk.text.length && /[\uD800-\uDBFF]/.test(chunk.text[end - 1])) end--;
    while (tokenCount(chunk.text.slice(offset, end)) > remaining) {
      end = offset + Math.max(1, Math.floor((end - offset) * 0.8));
      if (end < chunk.text.length && /[\uD800-\uDBFF]/.test(chunk.text[end - 1])) end--;
    }
    const text = chunk.text.slice(offset, end);
    selected.push({
      ...chunk,
      id: digest(JSON.stringify([chunk.entryId, chunk.start + offset, chunk.start + end, text])),
      start: chunk.start + offset,
      end: chunk.start + end,
      text,
      tokenCount: tokenCount(text),
    });
    used += tokenCount(text);
  }
  return {
    chunks: selected,
    tokenCount: used,
    encoding: 'cl100k_base' as const,
    matchingChunks: ranked.length,
  };
}

export function categorySuggestions(snapshot: ArchiveSnapshot) {
  const text = snapshot.entries
    .filter((entry) => entry.kind === 'user')
    .map((entry) => entry.text)
    .join('\n')
    .toLowerCase();
  const categories = {
    debugging: /\b(bug|error|fix|failure|regression)\b/,
    documentation: /\b(docs|documentation|readme)\b/,
    testing: /\b(test|tests|verification|qa)\b/,
    design: /\b(design|architecture|diagram|proposal)\b/,
  };
  return Object.entries(categories)
    .filter(([, pattern]) => pattern.test(text))
    .map(([tag]) => ({ tag, origin: 'heuristic' as const }));
}
