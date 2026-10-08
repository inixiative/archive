import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pairInstallation, SignetClient } from '@inixiative/signet';
import type { ArchiveDestination } from './config';

type KingdomDestination = Extract<ArchiveDestination, { kind: 'kingdom' }>;
type Library = { integrationId: string; resourceId: string; name: string };

/** The Signet does not grant sessions.write on the library. */
export class KingdomGrantMissing extends Error {
  constructor() {
    super("This Archive's Signet does not grant sessions.write on that library");
  }
}

/** Libraries this Archive's Signet may write to, as Kingdom describes them. */
export async function writableLibraries(credentialFile: string) {
  const description = await (await SignetClient.fromFile(credentialFile)).describe();
  return (
    description.operations
      .find((operation) => operation.key === 'sessions.write')
      ?.resources.map((resource) => ({
        integrationId: resource.integrationId,
        resourceId: resource.id,
        name: resource.name,
      })) ?? []
  );
}

type Pairing = {
  kingdom: string;
  name: string;
  sourceId: string;
  directory: string;
  onReview: (review: { reviewCode: string; review: string; expiresAt: string }) => void;
  confirmOwner: (owner: { ownerName: string | null; owner: unknown }) => Promise<boolean>;
  onError?: (error: unknown) => void;
  socketOptions?: { pollMs?: number; retryBaseMs?: number; authTimeoutMs?: number };
};

/**
 * Pairs this Archive with Kingdom as an Installation: a person claims the review code, the Archive
 * confirms the owner locally, then collects the Signet for its local Archive integration.
 */
export async function pairWithKingdom(input: Pairing) {
  const paired = await pairInstallation({
    url: input.kingdom,
    root: input.directory,
    kind: 'archive',
    name: input.name,
    sourceId: input.sourceId,
    terms: {
      name: input.name,
      lifecycle: 'ongoing',
      resources: [],
      expiresAt: null,
      maxRequests: null,
      maxConcurrent: 4,
    },
    onReview: input.onReview,
    confirmOwner: input.confirmOwner,
    onError: input.onError,
    socketOptions: input.socketOptions,
  });
  return {
    paired: true,
    owner: paired.ownerName,
    integrationId: paired.integrationId,
    credentialFile: paired.credentialFile,
    libraries: await writableLibraries(paired.credentialFile),
    next: 'archive connect --kind kingdom --url KINGDOM --credential-file FILE --integration-id ID --resource-id ID --project-id PROJECT',
  };
}

export async function verifyKingdomDestination(destination: KingdomDestination) {
  const libraries = await writableLibraries(destination.credentialFile);
  if (
    !libraries.some(
      (library) =>
        library.integrationId === destination.integrationId &&
        library.resourceId === destination.resourceId,
    )
  )
    throw new KingdomGrantMissing();
}

/** Credential files of the Signets `pair` collected into the directory, one per owner. */
export function heldSignets(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((kingdom) =>
      readdirSync(join(directory, kingdom.name))
        .filter((name) => /^signet-[^/]+\.json$/.test(name))
        .map((name) => join(directory, kingdom.name, name)),
    )
    .sort();
}

/** Every library the held Signets may write to; `paired` is false until `pair` collected one. */
export async function pairedLibraries(directory: string) {
  const credentialFiles = heldSignets(directory);
  const libraries = new Map<string, Library>();
  for (const credentialFile of credentialFiles)
    for (const library of await writableLibraries(credentialFile))
      libraries.set(JSON.stringify([library.integrationId, library.resourceId]), library);
  return { paired: credentialFiles.length > 0, libraries: [...libraries.values()] };
}

/** The Kingdom destination for a library, through whichever held Signet grants writing to it. */
export async function pairedDestination(
  directory: string,
  route: { projectId: string; integrationId: string; resourceId: string },
): Promise<KingdomDestination> {
  for (const credentialFile of heldSignets(directory)) {
    const destination: KingdomDestination = {
      kind: 'kingdom',
      ...route,
      url: (await SignetClient.fromFile(credentialFile)).url,
      credentialFile,
    };
    try {
      await verifyKingdomDestination(destination);
      return destination;
    } catch (error) {
      if (!(error instanceof KingdomGrantMissing)) throw error;
    }
  }
  throw new KingdomGrantMissing();
}
