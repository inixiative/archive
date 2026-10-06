import {
  type ArchiveDestination,
  archiveDestinationSchema,
  destinationIdentity,
  destinationToken,
  destinationUrl,
} from './config';
import type { ArchiveStore } from './store';

export { type ArchiveDestination, archiveDestinationSchema } from './config';

/** Identifies the Kingdom owner and forwarding connection; standalone Archive needs neither. */
export function kingdomFields(destination: ArchiveDestination) {
  if (destination.kind === 'archive') return {};
  const { ownerModel, organizationId, spaceId, connectionId } = destination;
  return Object.fromEntries(
    Object.entries({ ownerModel, organizationId, spaceId, connectionId }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

export async function archiveRequest(
  destination: ArchiveDestination,
  action: string,
  body: unknown,
  transport: typeof fetch = fetch,
) {
  const url = destinationUrl(destination.url);
  const token = destinationToken(destination);
  if (!token || (destination.kind === 'kingdom' && !token.startsWith('kingdom_runtime_')))
    throw new Error('Archive runtime credential unavailable');
  const path =
    destination.kind === 'kingdom' && destination.connectionId ? `remote/${action}` : action;
  const response = await transport(new URL(`api/v1/archive/${path}`, url), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Archive request rejected (${response.status}); local archive retained`);
  return response.json() as Promise<{ data: any }>;
}

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
    const body = await archiveRequest(
      destination,
      'ingest',
      {
        ...kingdomFields(destination),
        previousDigest,
        snapshot: queued.snapshot,
      },
      transport,
    );
    if (body.data?.digest !== queued.digest) throw new Error('Archive acknowledgement mismatch');
    await store.delivered(id, receiptKey, queued.digest);
    sent = true;
  }
  throw new Error('Archive changed repeatedly during publication; retry sync');
}

export async function routingPreview(store: ArchiveStore, destinations: ArchiveDestination[]) {
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
        ...kingdomFields(d),
      })),
  }));
}

export async function syncArchives(store: ArchiveStore, destinations: ArchiveDestination[]) {
  const results: { id: string; destination: string; status: string }[] = [];
  for (const archive of await store.list())
    for (const destination of destinations.filter((d) => d.projectId === archive.projectId)) {
      try {
        const result = await publishArchive(store, archive.id, destination);
        results.push({
          id: archive.id,
          destination: destination.url,
          status: result.unchanged ? 'unchanged' : 'published',
        });
      } catch (error) {
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
        const result = await archiveRequest(destination, 'search', {
          query,
          budget,
          ...(destination.kind === 'archive'
            ? { projectId: destination.projectId }
            : kingdomFields(destination)),
        });
        return {
          destination: destination.url,
          projectId: destination.projectId,
          data: result.data,
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
