import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { UNROUTED } from './index';

const projectId = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => id !== UNROUTED, `${UNROUTED} sessions stay on this machine`);
const cleanupMode = z.enum(['off', 'leaked', 'all']);
/** An organization: the owner a set of projects belongs to, and where its sessions publish. */
const organizationId = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(64);
/** A remote Archive this one syncs to directly with its server token. */
const archiveDestination = z
  .strictObject({
    kind: z.literal('archive'),
    organizationId,
    url: z.url(),
    tokenEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]+$/)
      .optional(),
    tokenFile: z.string().max(4096).refine(isAbsolute, 'tokenFile must be absolute').optional(),
  })
  .refine(
    (d) => Boolean(d.tokenEnv) !== Boolean(d.tokenFile),
    'Set exactly one of tokenEnv or tokenFile',
  );
/**
 * A hosted Archive reached through Kingdom: this Archive presents the Signet it was paired with,
 * granting sessions.write on that Archive's library.
 */
export const kingdomDestinationSchema = z.strictObject({
  kind: z.literal('kingdom'),
  organizationId,
  url: z.url(),
  credentialFile: z.string().max(4096).refine(isAbsolute, 'credentialFile must be absolute'),
  integrationId: z.uuid(),
  resourceId: z.uuid(),
});
export const archiveDestinationSchema = z.union([archiveDestination, kingdomDestinationSchema]);
export type ArchiveDestination = z.infer<typeof archiveDestinationSchema>;

/** The projects an organization owns. A project belongs to at most one organization. */
export const organizationSchema = z.strictObject({
  id: organizationId,
  projects: z.array(projectId).max(1000),
  /** Coworkers' names, so the routing planner recognizes remarks about them. */
  roster: z.array(z.string().min(1).max(100)).max(500).optional(),
});
/**
 * Where sessions publish: one archive per organization, not per project. Each project belongs to
 * an organization, and each organization has its destinations. What publishes is a session's
 * parts, to the organizations its validated routing plan gives them (`routedTo`); the session
 * itself, and one not planned or held, publishes nowhere. `project:` tags are for search only.
 */
export const routingSchema = z
  .strictObject({
    organizations: z.array(organizationSchema).max(50),
    destinations: z.array(archiveDestinationSchema).max(100),
    /**
     * The go-live switch. `off` (the default): sessions are planned and plans validated and
     * applied here, and sync only deletes the whole-session copies destinations hold; nothing new
     * publishes to an organization. `on`: parts publish, and re-plans delete what they drop.
     */
    publish: z.enum(['off', 'on']).default('off'),
    /**
     * What sync deletes at destinations. `off` (the default): nothing; pending deletes stay
     * queued. `leaked`: what routing doesn't send there, keeping (with publishing off) a whole copy
     * whose current valid plan sends the whole session there unredacted and unpruned. `all`: the
     * same, keeping no whole copy. `cleanupFor` overrides it per organization.
     */
    cleanup: cleanupMode.default('off'),
    cleanupFor: z.record(organizationId, cleanupMode).default({}),
    /**
     * Talk that is personal for every organization (career or job, investor or advisor, remarks
     * about coworkers), found in a work part by the planner or the sensitivity pass. `hold` (the
     * default): the whole part stays personal and goes to review (`route review`). `redact`: the
     * span is redacted and the part publishes.
     */
    personalSpans: z.enum(['hold', 'redact']).default('hold'),
  })
  .superRefine((routing, ctx) => {
    const ids = routing.organizations.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Organization ids must be unique' });
    const projects = routing.organizations.flatMap((o) => o.projects);
    if (new Set(projects).size !== projects.length)
      ctx.addIssue({ code: 'custom', message: 'A project belongs to at most one organization' });
    for (const d of routing.destinations)
      if (!ids.includes(d.organizationId))
        ctx.addIssue({ code: 'custom', message: `Unknown organization ${d.organizationId}` });
  });
export type Routing = z.output<typeof routingSchema>;
export type Organization = z.infer<typeof organizationSchema>;
const noRouting = (): Routing => ({
  organizations: [],
  destinations: [],
  publish: 'off',
  cleanup: 'off',
  cleanupFor: {},
  personalSpans: 'hold',
});

/** Private regular file owned by this user; a symlink or group/world access is refused. */
export function readTokenFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Token file must be a regular file owned by you with mode 0600');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}
export const destinationToken = (destination: z.infer<typeof archiveDestination>) =>
  destination.tokenFile ? readTokenFile(destination.tokenFile) : process.env[destination.tokenEnv!];

export function destinationUrl(input: string) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Archive destination requires HTTPS or loopback HTTP and no URL credentials');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function readRouting(file: string): Routing {
  return existsSync(file)
    ? routingSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    : noRouting();
}

/** What routing reads of an archive: a part, and its plan's organizations. */
export type RoutedArchive = { partOf?: string | null; routedTo?: readonly string[] };

/**
 * The organizations an archive publishes to: a part's, from its session's validated plan, among
 * those the routing declares. A session (not a part) publishes to none.
 */
export function sessionOrganizations(routing: Routing, session: RoutedArchive): string[] {
  if (!session.partOf) return [];
  const routed = new Set(session.routedTo ?? []);
  return routing.organizations.filter((o) => routed.has(o.id)).map((o) => o.id);
}

/** The destinations an archive publishes to: those of every organization it is routed to. */
export const sessionDestinations = (routing: Routing, session: RoutedArchive) => {
  const organizations = sessionOrganizations(routing, session);
  return routing.destinations.filter((d) => organizations.includes(d.organizationId));
};
export function destinationIdentity(destination: ArchiveDestination) {
  const url = destinationUrl(destination.url);
  return JSON.stringify([
    url.origin,
    new URL(destination.url).pathname,
    destination.kind === 'archive'
      ? 'standalone'
      : ['kingdom', destination.integrationId, destination.resourceId],
  ]);
}
/**
 * The server's configuration: routing (organizations and their destinations) and the Kingdom pairing. Compose mounts it at the same
 * absolute path, so the CLI and the server read one file and the paths in it resolve for both.
 */
export const configDirectory = (home: string) => join(home, 'config');
export const destinationsFile = (home: string) => join(configDirectory(home), 'destinations.json');
export const kingdomDirectory = (home: string) => join(configDirectory(home), 'kingdom');

/** A destination as reported: never a token, and no credential file for Kingdom entries. */
export const describeDestination = (destination: ArchiveDestination) => ({
  configured: true as const,
  kind: destination.kind,
  organizationId: destination.organizationId,
  url: destination.url,
  ...(destination.kind === 'kingdom'
    ? { integrationId: destination.integrationId, resourceId: destination.resourceId }
    : destination.tokenFile
      ? { tokenFile: destination.tokenFile }
      : { tokenEnv: destination.tokenEnv }),
});
export type DescribedDestination = ReturnType<typeof describeDestination>;

function writeRouting(file: string, input: Routing) {
  const routing = routingSchema.parse(input);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(routing, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return routing;
}

const sameRoute = (a: ArchiveDestination, organizationId: string, identity: string) =>
  a.organizationId === organizationId && destinationIdentity(a) === identity;

/** Adds or replaces an organization's destination; an organization not declared yet is added empty. */
export function connectDestination(file: string, input: unknown) {
  const destination = archiveDestinationSchema.parse(input);
  destination.url = destinationUrl(destination.url).href;
  const routing = readRouting(file);
  if (!routing.organizations.some((o) => o.id === destination.organizationId))
    routing.organizations.push({ id: destination.organizationId, projects: [] });
  const identity = destinationIdentity(destination);
  const index = routing.destinations.findIndex((item) =>
    sameRoute(item, destination.organizationId, identity),
  );
  if (index < 0) routing.destinations.push(destination);
  else routing.destinations[index] = destination;
  writeRouting(file, routing);
  return describeDestination(destination);
}

/** Stops publishing an organization to a destination (by `destinationIdentity`); receipts remain. */
export function removeDestination(
  file: string,
  route: { organizationId: string; identity: string },
) {
  const routing = readRouting(file);
  const kept = routing.destinations.filter(
    (item) => !sameRoute(item, route.organizationId, route.identity),
  );
  if (kept.length === routing.destinations.length) return false;
  writeRouting(file, { ...routing, destinations: kept });
  return true;
}

/**
 * Declares an organization and the projects it owns (replacing its list). A project another
 * organization owns is refused: move it by removing it there first.
 */
export function setOrganization(file: string, input: Organization) {
  const organization = organizationSchema.parse(input);
  const routing = readRouting(file);
  const others = routing.organizations.filter((o) => o.id !== organization.id);
  const taken = organization.projects.filter((p) => others.some((o) => o.projects.includes(p)));
  if (taken.length)
    throw new Error(`Projects already in another organization: ${taken.join(', ')}`);
  const index = routing.organizations.findIndex((o) => o.id === organization.id);
  const roster = organization.roster ?? routing.organizations[index]?.roster;
  // Setting the projects keeps the roster unless one is given.
  const next = { ...organization, ...(roster ? { roster } : {}) };
  if (index < 0) routing.organizations.push(next);
  else routing.organizations[index] = next;
  return writeRouting(file, routing).organizations;
}

/** Removes an organization and its destinations; its projects then stay on this machine. */
export function removeOrganization(file: string, id: string) {
  const routing = readRouting(file);
  if (!routing.organizations.some((o) => o.id === id)) return false;
  writeRouting(file, {
    ...routing,
    organizations: routing.organizations.filter((o) => o.id !== id),
    destinations: routing.destinations.filter((d) => d.organizationId !== id),
  });
  return true;
}

/** The cleanup mode at an organization's destinations: its override, else the default. */
export const cleanupFor = (routing: Routing, organizationId: string) =>
  routing.cleanupFor[organizationId] ?? routing.cleanup;

/** Sets cleanup for every organization, or overrides it for one. */
export function setCleanup(file: string, mode: Routing['cleanup'], organizationId?: string) {
  const routing = readRouting(file);
  const next = organizationId
    ? { ...routing, cleanupFor: { ...routing.cleanupFor, [organizationId]: mode } }
    : { ...routing, cleanup: mode };
  const written = writeRouting(file, next);
  return { cleanup: written.cleanup, cleanupFor: written.cleanupFor };
}

/** Whether career, investor and coworker talk in a work part holds the part or is redacted. */
export function setPersonalSpans(file: string, personalSpans: Routing['personalSpans']) {
  return writeRouting(file, { ...readRouting(file), personalSpans }).personalSpans;
}

/** Turns publishing to organizations on or off (`routing.publish`). */
export function setPublish(file: string, publish: Routing['publish']) {
  return writeRouting(file, { ...readRouting(file), publish }).publish;
}
