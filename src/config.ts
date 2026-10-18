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
import { PROJECT_TAG_PREFIX } from './tags';

const projectId = z
  .string()
  .min(1)
  .max(256)
  .refine((id) => id !== UNROUTED, `${UNROUTED} sessions stay on this machine`);
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
});
/**
 * Where sessions publish: one archive per organization, not per project. Each project belongs to
 * an organization, and each organization has its destinations. A session publishes to the
 * destinations of every organization its own project, or a project it touched (`project:` tags),
 * belongs to. Projects in no organization stay on this machine.
 */
export const routingSchema = z
  .strictObject({
    organizations: z.array(organizationSchema).max(50),
    destinations: z.array(archiveDestinationSchema).max(100),
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
export type Routing = z.infer<typeof routingSchema>;
export type Organization = z.infer<typeof organizationSchema>;
const noRouting = (): Routing => ({ organizations: [], destinations: [] });

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

/** The organizations a session belongs to: its own project's and each touched project's. */
export function sessionOrganizations(
  routing: Routing,
  session: { projectId?: string | null; tags: readonly string[] },
): string[] {
  const projects = new Set([
    ...(session.projectId ? [session.projectId] : []),
    ...session.tags.flatMap((tag) =>
      tag.startsWith(PROJECT_TAG_PREFIX) ? [tag.slice(PROJECT_TAG_PREFIX.length)] : [],
    ),
  ]);
  return routing.organizations
    .filter((o) => o.projects.some((p) => projects.has(p)))
    .map((o) => o.id);
}

/** The destinations a session publishes to: those of every organization it belongs to. */
export const sessionDestinations = (
  routing: Routing,
  session: { projectId?: string | null; tags: readonly string[] },
) => {
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
  if (index < 0) routing.organizations.push(organization);
  else routing.organizations[index] = organization;
  return writeRouting(file, routing).organizations;
}

/** Removes an organization and its destinations; its projects then stay on this machine. */
export function removeOrganization(file: string, id: string) {
  const routing = readRouting(file);
  if (!routing.organizations.some((o) => o.id === id)) return false;
  writeRouting(file, {
    organizations: routing.organizations.filter((o) => o.id !== id),
    destinations: routing.destinations.filter((d) => d.organizationId !== id),
  });
  return true;
}
