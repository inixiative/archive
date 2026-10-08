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

const projectId = z.string().min(1).max(256);
/** A remote Archive this one syncs to directly with its server token. */
const archiveDestination = z
  .strictObject({
    kind: z.literal('archive'),
    projectId,
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
  projectId,
  url: z.url(),
  credentialFile: z.string().max(4096).refine(isAbsolute, 'credentialFile must be absolute'),
  integrationId: z.uuid(),
  resourceId: z.uuid(),
});
export const archiveDestinationSchema = z.union([archiveDestination, kingdomDestinationSchema]);
export type ArchiveDestination = z.infer<typeof archiveDestinationSchema>;

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

export function readDestinations(file: string): ArchiveDestination[] {
  return existsSync(file)
    ? z
        .array(archiveDestinationSchema)
        .max(100)
        .parse(JSON.parse(readFileSync(file, 'utf8')))
    : [];
}
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
 * The server's configuration: destinations and the Kingdom pairing. Compose mounts it at the same
 * absolute path, so the CLI and the server read one file and the paths in it resolve for both.
 */
export const configDirectory = (home: string) => join(home, 'config');
export const destinationsFile = (home: string) => join(configDirectory(home), 'destinations.json');
export const kingdomDirectory = (home: string) => join(configDirectory(home), 'kingdom');

/** A destination as reported: never a token, and no credential file for Kingdom entries. */
export const describeDestination = (destination: ArchiveDestination) => ({
  configured: true as const,
  kind: destination.kind,
  projectId: destination.projectId,
  url: destination.url,
  ...(destination.kind === 'kingdom'
    ? { integrationId: destination.integrationId, resourceId: destination.resourceId }
    : destination.tokenFile
      ? { tokenFile: destination.tokenFile }
      : { tokenEnv: destination.tokenEnv }),
});
export type DescribedDestination = ReturnType<typeof describeDestination>;

function writeDestinations(file: string, destinations: ArchiveDestination[]) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(destinations, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

const sameRoute = (a: ArchiveDestination, projectId: string, identity: string) =>
  a.projectId === projectId && destinationIdentity(a) === identity;

export function connectDestination(file: string, input: unknown) {
  const destination = archiveDestinationSchema.parse(input);
  destination.url = destinationUrl(destination.url).href;
  const destinations = readDestinations(file);
  const identity = destinationIdentity(destination);
  const index = destinations.findIndex((item) => sameRoute(item, destination.projectId, identity));
  if (index < 0) destinations.push(destination);
  else destinations[index] = destination;
  writeDestinations(file, destinations);
  return describeDestination(destination);
}

/** Stops routing a project to a destination (by `destinationIdentity`); its receipts remain. */
export function removeDestination(file: string, route: { projectId: string; identity: string }) {
  const destinations = readDestinations(file);
  const kept = destinations.filter((item) => !sameRoute(item, route.projectId, route.identity));
  if (kept.length === destinations.length) return false;
  writeDestinations(file, kept);
  return true;
}
