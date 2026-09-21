import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const common = {
  projectId: z.string().min(1).max(256),
  url: z.url(),
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
};
export const archiveDestinationSchema = z.union([
  z.strictObject({
    ...common,
    kind: z.literal('archive'),
    keepIds: z.array(z.string()).max(0).default([]),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('kingdom').optional(),
    kastleId: z.uuid(),
    keepIds: z.array(z.uuid()).max(50).default([]),
  }),
]);
export type ArchiveDestination = z.infer<typeof archiveDestinationSchema>;

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
  // Preserve existing Foundry/Kingdom upload receipt identities.
  return JSON.stringify([
    url.origin,
    new URL(destination.url).pathname,
    destination.kind === 'archive' ? 'standalone' : destination.kastleId,
  ]);
}
export function connectDestination(file: string, input: unknown) {
  const destination = archiveDestinationSchema.parse(input);
  destination.url = destinationUrl(destination.url).href;
  const destinations = readDestinations(file);
  const identity = destinationIdentity(destination);
  const index = destinations.findIndex(
    (item) => item.projectId === destination.projectId && destinationIdentity(item) === identity,
  );
  if (index < 0) destinations.push(destination);
  else destinations[index] = destination;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(destinations, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return {
    configured: true,
    kind: destination.kind ?? 'kingdom',
    projectId: destination.projectId,
    url: destination.url,
    tokenEnv: destination.tokenEnv,
  };
}
