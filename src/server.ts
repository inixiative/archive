import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  archiveKey,
  archiveReferenceSchema,
  archiveSnapshotSchema,
  selectChunks,
  snapshotDigest,
} from './index';
import { archiveSettingsSchema, LocalArchiveStore, tagDefinitionSchema } from './local';

const ingestSchema = z.strictObject({
  snapshot: archiveSnapshotSchema,
  previousDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const archiveId = z.string().regex(/^[a-f0-9]{64}$/);
const filterFields = {
  projectId: z.string().max(256).optional(),
  source: archiveSnapshotSchema.shape.source.optional(),
  tag: z.string().min(1).max(120).optional(),
  actorId: z.string().min(1).max(256).optional(),
  reference: archiveReferenceSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  beforeId: archiveId.optional(),
};
const listSchema = z.strictObject(filterFields);
const searchSchema = z.strictObject({
  ...filterFields,
  query: z.string().max(1000).default(''),
  budget: z.number().int().min(16).max(32768).default(2048),
});
const readSchema = z.strictObject({ archiveId, revision: z.number().int().positive().optional() });
const tagSchema = z.strictObject({
  archiveId,
  add: z.array(z.string()).max(100).optional(),
  remove: z.array(z.string()).max(100).optional(),
});
const tagListSchema = z.strictObject({ actorId: z.string().min(1).max(256).optional() });
const tagRemoveSchema = tagDefinitionSchema.pick({ tag: true, actorId: true });

/** Cursor paging over newest-first archives. */
function page<T extends { id: string }>(items: T[], limit: number, beforeId?: string) {
  const cursor = beforeId ? items.findIndex((item) => item.id === beforeId) : -1;
  if (beforeId && cursor < 0) return undefined;
  const slice = items.slice(cursor + 1, cursor + 1 + limit);
  return {
    items: slice,
    nextCursor: items.length > cursor + 1 + slice.length ? (slice.at(-1)?.id ?? null) : null,
  };
}

/** One deployment, one ownership boundary. No shared cross-tenant database or admin API. */
export function createArchiveHandler(store: LocalArchiveStore, token: string) {
  if (token.length < 32)
    throw new Error('ARCHIVE_SERVER_TOKEN must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET')
      return json({ status: 'ok', service: 'archive', protocol: 1 });
    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return json({ error: 'Unauthorized' }, 401);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    try {
      // Enforce a limit for both fixed-length and streamed/chunked requests.
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'Body required' }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 65_000_000) {
          await reader.cancel();
          return json({ error: 'Body too large' }, 413);
        }
        chunks.push(item.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (path === '/api/v1/archive/ingest') {
        const { snapshot, previousDigest } = ingestSchema.parse(body);
        const id = archiveKey(snapshot),
          old = store.read(id),
          next = snapshotDigest(snapshot);
        if (old?.digest !== next && (old?.digest ?? null) !== previousDigest)
          return json({ error: 'Revision conflict' }, 409);
        if (old && old.digest !== next && old.snapshot.capturedAt > snapshot.capturedAt)
          return json({ error: 'Stale capture' }, 409);
        return json({ data: store.capture(snapshot) });
      }
      if (path === '/api/v1/archive/read') {
        const input = readSchema.parse(body),
          archive = store.read(input.archiveId, input.revision);
        return archive ? json({ data: archive }) : json({ error: 'Archive unavailable' }, 404);
      }
      if (path === '/api/v1/archive/list') {
        const { limit, beforeId, ...filter } = listSchema.parse(body);
        const result = page(store.list(filter), limit, beforeId);
        if (!result) return json({ error: 'Invalid cursor' }, 400);
        return json({ data: { archives: result.items, nextCursor: result.nextCursor } });
      }
      if (path === '/api/v1/archive/search') {
        const { query, budget, limit, beforeId, ...filter } = searchSchema.parse(body);
        let remaining = budget;
        const matching = store
          .list(filter)
          .filter(
            (a) =>
              !query ||
              selectChunks(store.read(a.id)!.chunks, query, budget).matchingChunks > 0 ||
              [a.title, ...a.tags].some((text) => text.toLowerCase().includes(query.toLowerCase())),
          );
        const result = page(matching, limit, beforeId);
        if (!result) return json({ error: 'Invalid cursor' }, 400);
        const archives = result.items.map((a) => {
          const selected =
            remaining >= 16
              ? selectChunks(store.read(a.id)!.chunks, query, remaining)
              : { chunks: [], tokenCount: 0 };
          remaining -= selected.tokenCount;
          return {
            archiveId: a.id,
            revision: a.revision,
            digest: a.digest,
            title: a.title,
            projectId: a.projectId,
            actor: a.actor,
            tags: a.tags,
            suggestedTags: a.suggestedTags,
            references: a.references,
            coverage: a.coverage,
            ...selected,
          };
        });
        return json({
          data: { archives, tokenCount: budget - remaining, nextCursor: result.nextCursor },
        });
      }
      if (path === '/api/v1/archive/tag') {
        const input = tagSchema.parse(body);
        if (!store.read(input.archiveId)) return json({ error: 'Archive unavailable' }, 404);
        return json({ data: store.tag(input.archiveId, input) });
      }
      if (path === '/api/v1/archive/delete') {
        const input = readSchema.pick({ archiveId: true }).parse(body);
        return store.delete(input.archiveId)
          ? json({ data: { archiveId: input.archiveId, deleted: true } })
          : json({ error: 'Archive unavailable' }, 404);
      }
      if (path === '/api/v1/archive/settings/read') {
        z.strictObject({}).parse(body);
        return json({ data: store.settings() });
      }
      if (path === '/api/v1/archive/settings/update')
        return json({ data: store.updateSettings(archiveSettingsSchema.partial().parse(body)) });
      if (path === '/api/v1/archive/tags/list')
        return json({ data: { tags: store.tagDefinitions(tagListSchema.parse(body).actorId) } });
      if (path === '/api/v1/archive/tags/define')
        return json({ data: store.defineTag(tagDefinitionSchema.parse(body)) });
      if (path === '/api/v1/archive/tags/remove')
        return json({ data: { removed: store.undefineTag(tagRemoveSchema.parse(body)) } });
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: 'Invalid archive request' }, 400);
      return json({ error: 'Archive operation failed' }, 500);
    }
  };
}

export function startArchiveServer(options: {
  store: string;
  token: string;
  port?: number;
  hostname?: string;
}) {
  const store = new LocalArchiveStore(options.store);
  // Retention runs at start and hourly; it only ever deletes from this archive.
  store.prune();
  const retention = setInterval(() => store.prune(), 3_600_000);
  retention.unref();
  try {
    const server = Bun.serve({
      port: options.port ?? 4411,
      hostname: options.hostname ?? '127.0.0.1',
      maxRequestBodySize: 65_000_000,
      fetch: createArchiveHandler(store, options.token),
    });
    return {
      server,
      store,
      async close() {
        clearInterval(retention);
        await server.stop(true);
        store.close();
      },
    };
  } catch (error) {
    clearInterval(retention);
    store.close();
    throw error;
  }
}
