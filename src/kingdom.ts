import { pairInstallation, SignetClient } from '@inixiative/signet';
import type { ArchiveDestination } from './config';

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

export async function verifyKingdomDestination(
  destination: Extract<ArchiveDestination, { kind: 'kingdom' }>,
) {
  const libraries = await writableLibraries(destination.credentialFile);
  if (
    !libraries.some(
      (library) =>
        library.integrationId === destination.integrationId &&
        library.resourceId === destination.resourceId,
    )
  )
    throw new Error("This Archive's Signet does not grant sessions.write on that library");
}
