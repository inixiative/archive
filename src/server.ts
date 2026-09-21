import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { archiveKey, archiveSnapshotSchema, selectChunks, snapshotDigest } from './index';
import { LocalArchiveStore } from './local';

const ingestSchema = z.strictObject({
  snapshot: archiveSnapshotSchema,
  previousDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const searchSchema = z.strictObject({
  query: z.string().max(1000).default(''),
  tag: z.string().min(1).max(120).optional(),
  budget: z.number().int().min(16).max(32768).default(2048),
  projectId: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  beforeId: z.string().optional(),
});
const readSchema = z.strictObject({
  archiveId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive().optional(),
});

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
      if (path === '/api/v1/archive/search') {
        const input = searchSchema.parse(body);
        let remaining = input.budget;
        const matching = store
          .list()
          .filter(
            (a) =>
              (!input.projectId || a.projectId === input.projectId) &&
              (!input.tag || a.tags.includes(input.tag)),
          )
          .map((a) => ({
            a,
            selected: selectChunks(store.read(a.id)!.chunks, input.query, input.budget),
          }))
          .filter(
            ({ a, selected }) =>
              !input.query ||
              selected.matchingChunks > 0 ||
              [a.title, ...a.tags].some((text) =>
                text.toLowerCase().includes(input.query.toLowerCase()),
              ),
          );
        const cursor = input.beforeId ? matching.findIndex(({ a }) => a.id === input.beforeId) : -1;
        if (input.beforeId && cursor < 0) return json({ error: 'Invalid cursor' }, 400);
        const page = matching.slice(cursor + 1, cursor + 1 + input.limit);
        const archives = page.map(({ a }) => {
          const selected =
            remaining >= 16
              ? selectChunks(store.read(a.id)!.chunks, input.query, remaining)
              : { chunks: [], tokenCount: 0 };
          remaining -= selected.tokenCount;
          return {
            archiveId: a.id,
            revision: a.revision,
            digest: a.digest,
            title: a.title,
            projectId: a.projectId,
            tags: a.tags,
            suggestedTags: a.suggestedTags,
            coverage: a.coverage,
            ...selected,
          };
        });
        return json({
          data: {
            archives,
            tokenCount: input.budget - remaining,
            nextCursor: matching.length > cursor + 1 + page.length ? page.at(-1)?.a.id : null,
          },
        });
      }
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
        await server.stop(true);
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
