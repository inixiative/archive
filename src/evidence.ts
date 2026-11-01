import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Routing } from './config';
import { type ArchiveSnapshot, digest } from './index';
import {
  PROJECT_TAG_PREFIX,
  projectPaths,
  referencesIn,
  repositorySlug,
  toolCallAccess,
} from './tags';

/**
 * The machine's projects as the collectors see them: each project's roots and worktrees (read
 * now) and the GitHub repositories (`owner/name`) its checkouts push to. The host sends it to the
 * server (`projects/set`), which runs in Docker and cannot read the host's checkouts.
 */
export const projectMapSchema = z.strictObject({
  projects: z
    .array(
      z.strictObject({
        projectId: z.string().min(1).max(256),
        roots: z.array(z.string().max(4096).refine(isAbsolute, 'Roots are absolute')).max(1000),
        /** Worktrees found under its roots now: they resolve, but don't change the map's key. */
        worktrees: z
          .array(z.string().max(4096).refine(isAbsolute, 'Worktrees are absolute'))
          .max(1000)
          .optional(),
        repositories: z
          .array(z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/))
          .max(50)
          .default([]),
      }),
    )
    .max(500),
});
export type ProjectMap = z.infer<typeof projectMapSchema>;
/**
 * The map's key, which evidence and plans record: declared roots and repositories, not the
 * worktrees found under them, so a new worktree doesn't make every session recompute.
 */
export const projectMapKey = (map: ProjectMap) =>
  digest(
    JSON.stringify(
      map.projects.map(({ projectId, roots, repositories }) => [projectId, roots, repositories]),
    ),
  ).slice(0, 32);
/** Every directory a project's paths resolve under: its roots and its worktrees. */
const resolvable = (map: ProjectMap) =>
  map.projects.map(({ projectId, roots, worktrees }) => ({
    projectId,
    roots: [...roots, ...(worktrees ?? [])],
  }));

type Counts = Record<string, number>;
/**
 * The tool activity at a kept entry, until the next kept one: writes and reads per project, the
 * repositories a call changed remotely (`gh`) that no project pushes to, and GitHub repositories
 * linked from those entries. Tool calls and results the strip drops count at the kept entry before
 * them (the first kept entry for any before it).
 */
export type EntryEvidence = {
  entryId: string;
  writes?: Counts;
  reads?: Counts;
  repositories?: Counts;
  references?: Counts;
};
/**
 * What a session did where, computed at ingest from the snapshot as its writer sent it, before
 * the tool-activity strip, and kept on this row only: never in the snapshot, so it never travels.
 */
export type SessionEvidence = {
  /** The project map it was computed under (`projectMapKey`). */
  key: string;
  cwd?: string;
  startProjectId?: string;
  anchors: EntryEvidence[];
  /** Writes outside every project's roots. */
  unattributedWrites: number;
};

const bump = (counts: Counts, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Per kept entry of `keptIds` (the entries the stored snapshot holds), the evidence of what the
 * raw snapshot's tool calls wrote and read, through `map`. Relative paths resolve against the
 * session's working directory (`cwd`, else its project's first root). Naming a container root
 * itself (a root holding other projects' roots) reads nothing, as `projectTags` has it.
 */
export function sessionEvidence(
  raw: Pick<ArchiveSnapshot, 'entries' | 'projectId'>,
  keptIds: ReadonlySet<string>,
  map: ProjectMap,
  cwd?: string,
): SessionEvidence {
  const resolvePath = projectPaths(resolvable(map));
  const { containers } = resolvePath;
  const byRepository = new Map<string, string>();
  for (const project of map.projects)
    for (const repository of project.repositories) byRepository.set(repository, project.projectId);
  const at = cwd ?? map.projects.find((p) => p.projectId === raw.projectId)?.roots[0] ?? undefined;
  const anchors: EntryEvidence[] = [];
  let unattributedWrites = 0;
  let current: EntryEvidence | undefined;
  const pending: EntryEvidence = { entryId: '' };
  const add = (field: 'writes' | 'reads' | 'repositories' | 'references', key: string) => {
    const target = current ?? pending;
    target[field] = target[field] ?? {};
    bump(target[field], key);
  };
  for (const entry of raw.entries) {
    if (keptIds.has(entry.id)) {
      current = { entryId: entry.id };
      anchors.push(current);
      if (anchors.length === 1)
        for (const field of ['writes', 'reads', 'repositories', 'references'] as const)
          if (pending[field]) current[field] = { ...pending[field] };
    }
    for (const reference of referencesIn(entry.text)) {
      const slug = reference.integration === 'github' ? repositorySlug(reference.ref) : undefined;
      if (slug) add('references', slug);
    }
    if (entry.kind !== 'tool-call') continue;
    const access = toolCallAccess(entry.text, at);
    const writes = new Set(access.writes);
    for (const path of writes) {
      const owner = resolvePath(path);
      if (owner) add('writes', owner.projectId);
      else unattributedWrites++;
    }
    for (const path of new Set(access.paths)) {
      if (writes.has(path) || containers.has(path)) continue;
      const owner = resolvePath(path);
      if (owner) add('reads', owner.projectId);
    }
    for (const repository of new Set(access.repositories)) {
      const project = byRepository.get(repository);
      if (project) add('writes', project);
      else add('repositories', repository);
    }
  }
  const start = at ? resolvePath(resolve(at)) : undefined;
  return {
    key: projectMapKey(map),
    ...(at ? { cwd: at } : {}),
    ...(start ? { startProjectId: start.projectId } : {}),
    anchors: anchors.filter((a) => a.writes || a.reads || a.repositories || a.references),
    unattributedWrites,
  };
}

/** Writes, reads and references per organization ("personal" for projects in none). */
export type OrganizationEvidence = Record<
  string,
  { writes: number; reads: number; references: number }
>;

/**
 * The evidence of the anchors among `entryIds` (all of them when absent), by organization:
 * projects through `routing.organizations`, repositories and references through the projects
 * that push to them.
 */
export function evidenceByOrganization(
  evidence: SessionEvidence | null | undefined,
  routing: Routing,
  map: ProjectMap | undefined,
  entryIds?: ReadonlySet<string>,
): OrganizationEvidence {
  const result: OrganizationEvidence = {};
  if (!evidence) return result;
  const organizationOf = (projectId: string) =>
    routing.organizations.find((o) => o.projects.includes(projectId))?.id ?? 'personal';
  const repositoryProject = new Map<string, string>();
  for (const project of map?.projects ?? [])
    for (const repository of project.repositories)
      repositoryProject.set(repository, project.projectId);
  const add = (organization: string, field: 'writes' | 'reads' | 'references', n: number) => {
    const row = result[organization] ?? { writes: 0, reads: 0, references: 0 };
    row[field] += n;
    result[organization] = row;
  };
  for (const anchor of evidence.anchors) {
    if (entryIds && !entryIds.has(anchor.entryId)) continue;
    for (const [project, n] of Object.entries(anchor.writes ?? {}))
      add(organizationOf(project), 'writes', n);
    for (const [project, n] of Object.entries(anchor.reads ?? {}))
      add(organizationOf(project), 'reads', n);
    for (const [repository, n] of Object.entries(anchor.repositories ?? {})) {
      const project = repositoryProject.get(repository);
      add(project ? organizationOf(project) : 'personal', 'writes', n);
    }
    for (const [repository, n] of Object.entries(anchor.references ?? {})) {
      const project = repositoryProject.get(repository);
      add(project ? organizationOf(project) : 'personal', 'references', n);
    }
  }
  return result;
}

/**
 * The organizations a range of a session has evidence for: writes, reads or references in its
 * entries, or the session's start directory in one of the organization's projects.
 */
export function evidencedOrganizations(
  evidence: SessionEvidence | null | undefined,
  routing: Routing,
  map: ProjectMap | undefined,
  entryIds?: ReadonlySet<string>,
) {
  const found = new Set(
    Object.entries(evidenceByOrganization(evidence, routing, map, entryIds))
      .filter(([, e]) => e.writes || e.reads || e.references)
      .map(([organization]) => organization),
  );
  const start = evidence?.startProjectId;
  const startOrganization = start
    ? routing.organizations.find((o) => o.projects.includes(start))?.id
    : undefined;
  if (startOrganization) found.add(startOrganization);
  found.delete('personal');
  return found;
}

/**
 * The projects a session worked in: `project:<projectId>` for each project its tool calls wrote or
 * read in (`sessionEvidence`, the one loop over a session's paths) or its working directory sits
 * in, most first. Mentions (text written, prompts, messages, prose) never count, and naming a pure
 * container (a root holding other projects' roots, like `~/code/inixiative`) by itself tags
 * nothing. Routing is unaffected: tags are for search.
 */
export function projectTags(
  snapshot: Pick<ArchiveSnapshot, 'entries'>,
  projects: { projectId: string; roots: Iterable<string> }[],
  cwd?: string,
  limit = 20,
): string[] {
  const map = {
    projects: projects.map(({ projectId, roots }) => ({
      projectId,
      roots: [...roots],
      repositories: [],
    })),
  };
  const evidence = sessionEvidence(snapshot, new Set(snapshot.entries.map((e) => e.id)), map, cwd);
  const counts = new Map<string, number>();
  const add = (projectId: string, n: number) =>
    counts.set(projectId, (counts.get(projectId) ?? 0) + n);
  const resolvePath = projectPaths(map.projects);
  if (cwd && !resolvePath.containers.has(resolve(cwd)) && evidence.startProjectId)
    add(evidence.startProjectId, 1);
  for (const anchor of evidence.anchors)
    for (const field of [anchor.writes, anchor.reads])
      for (const [projectId, n] of Object.entries(field ?? {})) add(projectId, n);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([projectId]) => `${PROJECT_TAG_PREFIX}${projectId}`)
    .filter((tag) => tag.length <= 120);
}
