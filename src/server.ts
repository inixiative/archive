import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { routingPreview, syncArchives } from './client';
import {
  connectDestination,
  describeDestination,
  destinationIdentity,
  kingdomDestinationSchema,
  readDestinations,
  removeDestination,
} from './config';
import { archiveReferenceSchema, archiveSnapshotSchema, selectChunks } from './index';
import { KingdomGrantMissing, pairedDestination, pairedLibraries } from './kingdom';
import { ArchiveConflict, ArchiveStore, archiveSettingsSchema, tagDefinitionSchema } from './store';

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
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(40).optional(),
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
const destinationListSchema = z.strictObject({ projectId: filterFields.projectId });
const kingdomRouteSchema = kingdomDestinationSchema.pick({
  projectId: true,
  integrationId: true,
  resourceId: true,
});

/** Where the server finds its destinations and the Signets `pair` collected. */
export type ArchiveServerConfig = { destinationsFile: string; kingdomDirectory: string };

/** One deployment, one ownership boundary. No shared cross-tenant database or admin API. */
export function createArchiveHandler(
  store: ArchiveStore,
  token: string,
  config?: ArchiveServerConfig,
) {
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
      if (path === '/api/v1/archive/info') {
        z.strictObject({}).parse(body);
        return json({ data: { sourceId: await store.sourceId(), protocol: 2 } });
      }
      if (path === '/api/v1/archive/ingest') {
        const { snapshot, previousDigest } = ingestSchema.parse(body);
        return json({ data: await store.capture(snapshot, { previousDigest }) });
      }
      if (path === '/api/v1/archive/head') {
        const head = await store.head(readSchema.pick({ archiveId: true }).parse(body).archiveId);
        return head ? json({ data: head }) : json({ error: 'Archive unavailable' }, 404);
      }
      if (path === '/api/v1/archive/read') {
        const input = readSchema.parse(body),
          archive = await store.read(input.archiveId, input.revision);
        return archive ? json({ data: archive }) : json({ error: 'Archive unavailable' }, 404);
      }
      if (path === '/api/v1/archive/list') {
        const { limit, beforeId, ...filter } = listSchema.parse(body);
        const result = await store.page(filter, limit, beforeId);
        if (!result) return json({ error: 'Invalid cursor' }, 400);
        return json({ data: { archives: result.items, nextCursor: result.nextCursor } });
      }
      if (path === '/api/v1/archive/search') {
        const { query, budget, limit, beforeId, ...filter } = searchSchema.parse(body);
        const lower = query.toLowerCase();
        const result = await store.page(filter, limit, beforeId, async (listings) => {
          if (!query) return new Set(listings.map((a) => a.id));
          const hits = await store.matching(
            listings.map((a) => a.id),
            query,
          );
          for (const a of listings)
            if ([a.title, ...a.tags].some((text) => text.toLowerCase().includes(lower)))
              hits.add(a.id);
          return hits;
        });
        if (!result) return json({ error: 'Invalid cursor' }, 400);
        let remaining = budget;
        const archives = [];
        for (const a of result.items) {
          const selected =
            remaining >= 16
              ? selectChunks((await store.read(a.id))!.chunks, query, remaining)
              : { chunks: [], tokenCount: 0 };
          remaining -= selected.tokenCount;
          archives.push({
            archiveId: a.id,
            revision: a.revision,
            digest: a.digest,
            title: a.title,
            projectId: a.projectId,
            actor: a.actor,
            models: a.models,
            tags: a.tags,
            suggestedTags: a.suggestedTags,
            references: a.references,
            coverage: a.coverage,
            ...selected,
          });
        }
        return json({
          data: { archives, tokenCount: budget - remaining, nextCursor: result.nextCursor },
        });
      }
      if (path === '/api/v1/archive/tag') {
        const input = tagSchema.parse(body);
        if (!(await store.read(input.archiveId)))
          return json({ error: 'Archive unavailable' }, 404);
        return json({ data: await store.tag(input.archiveId, input) });
      }
      if (path === '/api/v1/archive/delete') {
        const input = readSchema.pick({ archiveId: true }).parse(body);
        return (await store.delete(input.archiveId))
          ? json({ data: { archiveId: input.archiveId, deleted: true } })
          : json({ error: 'Archive unavailable' }, 404);
      }
      if (path === '/api/v1/archive/settings/read') {
        z.strictObject({}).parse(body);
        return json({ data: await store.settings() });
      }
      if (path === '/api/v1/archive/settings/update')
        return json({
          data: await store.updateSettings(archiveSettingsSchema.partial().parse(body)),
        });
      if (path === '/api/v1/archive/tags/list')
        return json({
          data: { tags: await store.tagDefinitions(tagListSchema.parse(body).actorId) },
        });
      if (path === '/api/v1/archive/tags/define')
        return json({ data: await store.defineTag(tagDefinitionSchema.parse(body)) });
      if (path === '/api/v1/archive/tags/remove')
        return json({ data: { removed: await store.undefineTag(tagRemoveSchema.parse(body)) } });
      if (config && path === '/api/v1/archive/destinations/list') {
        const { projectId } = destinationListSchema.parse(body);
        const destinations = [];
        for (const destination of readDestinations(config.destinationsFile))
          if (!projectId || destination.projectId === projectId)
            destinations.push({
              ...describeDestination(destination),
              ...(await store.delivery(destination.projectId, destinationIdentity(destination))),
            });
        return json({ data: { destinations } });
      }
      if (config && path === '/api/v1/archive/destinations/routes') {
        z.strictObject({}).parse(body);
        return json({
          data: await routingPreview(store, readDestinations(config.destinationsFile)),
        });
      }
      if (config && path === '/api/v1/archive/destinations/sync') {
        z.strictObject({}).parse(body);
        return json({ data: await syncArchives(store, readDestinations(config.destinationsFile)) });
      }
      if (config && path === '/api/v1/archive/destinations/libraries') {
        z.strictObject({}).parse(body);
        return json({ data: await pairedLibraries(config.kingdomDirectory) });
      }
      if (config && path === '/api/v1/archive/destinations/connect') {
        const route = kingdomRouteSchema.parse(body);
        const destination = await pairedDestination(config.kingdomDirectory, route);
        return json({ data: connectDestination(config.destinationsFile, destination) });
      }
      if (config && path === '/api/v1/archive/destinations/remove') {
        const route = kingdomRouteSchema.parse(body);
        const configured = readDestinations(config.destinationsFile).find(
          (d) =>
            d.kind === 'kingdom' &&
            d.projectId === route.projectId &&
            d.integrationId === route.integrationId &&
            d.resourceId === route.resourceId,
        );
        return json({
          data: {
            removed: configured
              ? removeDestination(config.destinationsFile, {
                  projectId: route.projectId,
                  identity: destinationIdentity(configured),
                })
              : false,
          },
        });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof ArchiveConflict) return json({ error: error.message }, 409);
      if (error instanceof KingdomGrantMissing) return json({ error: error.message }, 403);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: 'Invalid archive request' }, 400);
      return json({ error: 'Archive operation failed' }, 500);
    }
  };
}

export async function startArchiveServer(options: {
  databaseUrl: string;
  token: string;
  port?: number;
  hostname?: string;
  config?: ArchiveServerConfig;
}) {
  const store = new ArchiveStore(options.databaseUrl);
  try {
    // Retention runs at start and hourly; it only ever deletes from this archive.
    await store.prune();
    const retention = setInterval(() => void store.prune().catch(() => {}), 3_600_000);
    retention.unref();
    const server = Bun.serve({
      port: options.port ?? 4700,
      hostname: options.hostname ?? '127.0.0.1',
      maxRequestBodySize: 65_000_000,
      fetch: createArchiveHandler(store, options.token, options.config),
    });
    return {
      server,
      store,
      async close() {
        clearInterval(retention);
        await server.stop(true);
        await store.close();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
