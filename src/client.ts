import {
  type ArchiveDestination,
  archiveDestinationSchema,
  destinationIdentity,
  destinationUrl,
} from './config';
import type { LocalArchiveStore } from './local';

export { type ArchiveDestination, archiveDestinationSchema } from './config';

export async function archiveRequest(
  destination: ArchiveDestination,
  action: string,
  body: unknown,
  transport: typeof fetch = fetch,
) {
  const url = destinationUrl(destination.url);
  const token = process.env[destination.tokenEnv];
  if (!token || (destination.kind !== 'archive' && !token.startsWith('kastle_runtime_')))
    throw new Error('Archive runtime credential unavailable');
  const response = await transport(new URL(`api/v1/archive/${action}`, url), {
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
  store: LocalArchiveStore,
  id: string,
  input: ArchiveDestination,
  transport: typeof fetch = fetch,
) {
  const destination = archiveDestinationSchema.parse(input);
  const archive = store.read(id);
  if (!archive || archive.snapshot.projectId !== destination.projectId)
    throw new Error('Archive is outside destination project');
  const receiptKey = destinationIdentity(destination);
  const keepIds = [...new Set(destination.keepIds)].sort();
  let sent = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const latest = store.read(id)!;
    const previousDigest = store.receipt(id, receiptKey);
    let pending = store.pending(id, receiptKey);
    if (!pending) {
      if (
        previousDigest === latest.digest &&
        store.receipt(id, `${receiptKey}:keeps`) === JSON.stringify(keepIds)
      )
        return { unchanged: !sent };
      store.enqueue(id, receiptKey, { revision: latest.revision, keepIds });
      pending = store.pending(id, receiptKey)!;
    }
    const queued = store.read(id, pending.revision);
    if (!queued || queued.snapshot.projectId !== destination.projectId)
      throw new Error('Pending archive is outside destination project');
    const body = await archiveRequest(
      destination,
      'ingest',
      {
        ...(destination.kind === 'archive'
          ? {}
          : { kastleId: destination.kastleId, keepIds: pending.keepIds }),
        previousDigest,
        snapshot: queued.snapshot,
      },
      transport,
    );
    if (body.data?.digest !== queued.digest) throw new Error('Archive acknowledgement mismatch');
    store.delivered(id, receiptKey, queued.digest, JSON.stringify(pending.keepIds));
    sent = true;
  }
  throw new Error('Archive changed repeatedly during publication; retry sync');
}

export function routingPreview(store: LocalArchiveStore, destinations: ArchiveDestination[]) {
  return store.list().map((archive) => ({
    id: archive.id,
    projectId: archive.projectId,
    tags: archive.tags,
    suggestedTags: archive.suggestedTags,
    destinations: destinations
      .filter((d) => d.projectId === archive.projectId)
      .map((d) => ({
        kind: d.kind ?? 'kingdom',
        url: d.url,
        ...(d.kind === 'archive' ? {} : { kastleId: d.kastleId }),
      })),
  }));
}

export async function syncArchives(store: LocalArchiveStore, destinations: ArchiveDestination[]) {
  const results: { id: string; destination: string; status: string }[] = [];
  for (const archive of store.list())
    for (const destination of destinations.filter((d) => d.projectId === archive.projectId)) {
      try {
        const result = await publishArchive(store, archive.id, destination);
        results.push({
          id: archive.id,
          destination: destination.url,
          status: result.unchanged ? 'unchanged' : 'published',
        });
      } catch {
        results.push({
          id: archive.id,
          destination: destination.url,
          status: 'failed; local revision retained',
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
            : { kastleId: destination.kastleId }),
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
