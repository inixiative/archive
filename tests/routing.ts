import type { ArchiveDestination, Routing } from '../src/config';

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
});
