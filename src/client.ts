import { kingdomUrl, SignetClient } from '@inixiative/signet';
import {
  type ArchiveDestination,
  archiveDestinationSchema,
  destinationIdentity,
  destinationToken,
  destinationUrl,
} from './config';
import type { RoutingPreview, SyncResult } from './remote';
import type { ArchiveStore } from './store';

export { type ArchiveDestination, archiveDestinationSchema } from './config';

type DirectDestination = Extract<ArchiveDestination, { kind: 'archive' }>;
type KingdomDestination = Extract<ArchiveDestination, { kind: 'kingdom' }>;
type Ingested = { id: string; digest: string; revision: number; changed: boolean };

const sessionWriteTimeoutMs = 300_000;

export async function archiveRequest(
  destination: DirectDestination,
  action: string,
  body: unknown,
  transport: typeof fetch = fetch,
) {
  const url = destinationUrl(destination.url);
  const token = destinationToken(destination);
  if (!token) throw new Error('Archive server token unavailable');
  const response = await transport(new URL(`api/v1/archive/${action}`, url), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(action === 'ingest' ? sessionWriteTimeoutMs : 30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Archive request rejected (${response.status}); local archive retained`);
  return response.json() as Promise<{ data: any }>;
}

const kingdomSignet = async (destination: KingdomDestination) => {
  const signet = await SignetClient.fromFile(destination.credentialFile);
  if (signet.url !== kingdomUrl(destination.url))
    throw new Error('The Signet credential belongs to a different Kingdom');
  return signet;
};

/** Runs one Archive operation on the destination's library through the paired Signet. */
export async function kingdomArchiveOperation(
  destination: KingdomDestination,
  operation: 'sessions.write' | 'documents.search',
  input: Record<string, unknown>,
) {
  const { result } = await (await kingdomSignet(destination)).execute(
    {
      integrationId: destination.integrationId,
      operation,
      input: { resourceId: destination.resourceId, limit: 20, ...input },
    },
    { timeoutMs: operation === 'sessions.write' ? sessionWriteTimeoutMs : 30_000 },
  );
  return result;
}

const ingest = async (
  destination: ArchiveDestination,
  body: { snapshot: unknown; previousDigest: string | null },
  transport: typeof fetch,
) =>
  (destination.kind === 'archive'
    ? (await archiveRequest(destination, 'ingest', body, transport)).data
    : await kingdomArchiveOperation(destination, 'sessions.write', body)) as Ingested | undefined;

export async function publishArchive(
  store: ArchiveStore,
  id: string,
  input: ArchiveDestination,
  transport: typeof fetch = fetch,
) {
  const destination = archiveDestinationSchema.parse(input);
  const archive = await store.head(id);
  if (!archive || archive.projectId !== destination.projectId)
    throw new Error('Archive is outside destination project');
  const receiptKey = destinationIdentity(destination);
  let sent = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const latest = (await store.head(id))!;
    const previousDigest = await store.receipt(id, receiptKey);
    let pending = await store.pending(id, receiptKey);
    if (!pending) {
      if (previousDigest === latest.digest) return { unchanged: !sent };
      await store.enqueue(id, receiptKey, { revision: latest.revision });
      pending = (await store.pending(id, receiptKey))!;
    }
    const queued = await store.read(id, pending.revision);
    if (!queued || queued.snapshot.projectId !== destination.projectId)
      throw new Error('Pending archive is outside destination project');
    const acknowledged = await ingest(
      destination,
      { previousDigest, snapshot: queued.snapshot },
      transport,
    );
    if (acknowledged?.digest !== queued.digest) throw new Error('Archive acknowledgement mismatch');
    await store.delivered(id, receiptKey, queued.digest);
    sent = true;
  }
  throw new Error('Archive changed repeatedly during publication; retry sync');
}

export async function routingPreview(
  store: ArchiveStore,
  destinations: ArchiveDestination[],
): Promise<RoutingPreview> {
  return (await store.list()).map((archive) => ({
    id: archive.id,
    projectId: archive.projectId,
    tags: archive.tags,
    suggestedTags: archive.suggestedTags,
    destinations: destinations
      .filter((d) => d.projectId === archive.projectId)
      .map((d) => ({
        kind: d.kind,
        url: d.url,
        ...(d.kind === 'kingdom' ? { integrationId: d.integrationId } : {}),
      })),
  }));
}

/**
 * Deliveries that failed, and when each may be tried again. A rejected archive is retried after
 * 30 seconds, doubling per failure up to 30 minutes, instead of re-sending it every sync.
 */
export type SyncBackoff = Map<string, { failures: number; until: number }>;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export async function syncArchives(
  store: ArchiveStore,
  destinations: ArchiveDestination[],
  options: { backoff?: SyncBackoff; now?: () => number } = {},
): Promise<SyncResult[]> {
  const now = options.now ?? Date.now;
  const results: SyncResult[] = [];
  for (const archive of await store.list())
    for (const destination of destinations.filter((d) => d.projectId === archive.projectId)) {
      const key = JSON.stringify([archive.id, destinationIdentity(destination)]);
      const waiting = options.backoff?.get(key);
      if (waiting && now() < waiting.until) {
        results.push({
          id: archive.id,
          destination: destination.url,
          status: `deferred until ${new Date(waiting.until).toISOString()}`,
        });
        continue;
      }
      try {
        const result = await publishArchive(store, archive.id, destination);
        options.backoff?.delete(key);
        results.push({
          id: archive.id,
          destination: destination.url,
          status: result.unchanged ? 'unchanged' : 'published',
        });
      } catch (error) {
        const failures = (waiting?.failures ?? 0) + 1;
        options.backoff?.set(key, {
          failures,
          until: now() + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
        });
        results.push({
          id: archive.id,
          destination: destination.url,
          status: `failed; local revision retained: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  return results;
}

export async function searchRemotes(
  destinations: ArchiveDestination[],
  query: string,
  budget = 2048,
) {
  return Promise.all(
    destinations.map(async (destination) => {
      try {
        const data =
          destination.kind === 'archive'
            ? (
                await archiveRequest(destination, 'search', {
                  query,
                  budget,
                  projectId: destination.projectId,
                })
              ).data
            : await kingdomArchiveOperation(destination, 'documents.search', {
                query,
                budget,
                projectId: destination.projectId,
              });
        return {
          destination: destination.url,
          projectId: destination.projectId,
          data,
        };
      } catch {
        return {
          destination: destination.url,
          projectId: destination.projectId,
          error: 'Remote unavailable',
        };
      }
    }),
  );
}
