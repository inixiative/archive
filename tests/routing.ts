import type { ArchiveDestination, Routing } from '../src/config';
import { partSnapshot } from '../src/parts';
import { sensitivityKey } from '../src/route';
import type { ArchiveStore } from '../src/store';

/**
 * Routing for tests: each destination's organization owns the project of the same id, unless
 * `projects` says otherwise.
 */
export const routing = (
  destinations: ArchiveDestination[],
  projects: Record<string, string[]> = {},
): Routing => ({
  organizations: [
    ...new Set([...destinations.map((d) => d.organizationId), ...Object.keys(projects)]),
  ].map((id) => ({ id, projects: projects[id] ?? [id] })),
  destinations,
  publish: 'on',
  cleanup: 'leaked',
  cleanupFor: {},
  personalSpans: 'hold',
});

/**
 * Routes a captured session whole to organizations, as a validated plan would: one part holding
 * every entry, with the session's projects. Returns the part's id, which is what publishes.
 */
export async function routeWhole(store: ArchiveStore, id: string, organizations: string[]) {
  const { snapshot } = (await store.read(id))!;
  const ids = snapshot.entries.map((e) => e.id);
  const projects = new Set([
    ...(snapshot.projectId ? [snapshot.projectId] : []),
    ...snapshot.tags.filter((t) => t.startsWith('project:')).map((t) => t.slice(8)),
  ]);
  const part = partSnapshot(
    snapshot,
    { firstEntryId: ids[0]!, lastEntryId: ids.at(-1)!, entryIds: ids, projects },
    [],
  );
  const { kept } = await store.applyParts(id, [{ snapshot: part, organizations }]);
  // The plan behind it, checked by the sensitivity pass, as a planner run would record it.
  const plan = {
    parts: [
      {
        firstEntryId: ids[0]!,
        lastEntryId: ids.at(-1)!,
        organizations,
        sensitive: false,
        confidence: 1,
        rationale: 'test',
      },
    ],
    prune: [],
    redactions: [],
    rationale: 'test',
    throughEntryId: ids.at(-1)!,
    sensitive: [],
    heldForReview: [],
    checked: sensitivityKey('test'),
  };
  const row = await store.db.archive.findUniqueOrThrow({ where: { id }, select: { digest: true } });
  const fields = {
    status: 'valid',
    plan,
    key: 'test',
    by: 'test',
    digest: row.digest,
    entries: ids.length,
    at: Date.now(),
  };
  await store.db.routingPlan.upsert({
    where: { archiveId: id },
    create: { archiveId: id, ...fields },
    update: fields,
  });
  return kept[0]!;
}
