import { join } from 'node:path';
import {
  collectPairing,
  generateSignetKey,
  kingdomUrl,
  requestPairing,
  SignetClient,
  saveCollectedSignet,
  writePrivateJson,
} from '@inixiative/signet';
import type { ArchiveDestination } from './config';

const pollMs = 3000;

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

/**
 * Pairs this Archive with Kingdom as a local Archive integration bound to its sourceId. The owner
 * approves the review code in Kingdom and chooses which hosted Archives it may write to.
 */
export async function pairWithKingdom(input: {
  kingdom: string;
  name: string;
  sourceId: string;
  directory: string;
  onReview: (review: { reviewCode: string; review: string; expiresAt: string }) => void;
  sleep?: (ms: number) => Promise<unknown>;
}) {
  const kingdom = kingdomUrl(input.kingdom);
  const keyFile = join(input.directory, `key-${crypto.randomUUID()}.json`);
  await writePrivateJson(keyFile, generateSignetKey());
  const pending = await requestPairing(kingdom, keyFile, {
    provider: 'archive',
    deviceId: input.sourceId,
    name: input.name,
    resources: [],
    expiresAt: null,
    maxRequests: null,
    maxConcurrent: 4,
  });
  input.onReview({
    reviewCode: pending.reviewCode,
    review: `${kingdom}/dashboard?reviewSignet=${pending.reviewCode}`,
    expiresAt: pending.expiresAt,
  });
  const sleep = input.sleep ?? Bun.sleep;
  while (Date.parse(pending.expiresAt) > Date.now()) {
    const collected = await collectPairing(kingdom, keyFile, pending.deviceCode);
    if (collected) {
      const credentialFile = join(input.directory, `signet-${collected.signetId}.json`);
      await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
      return {
        paired: true,
        integrationId: collected.integrationId,
        credentialFile,
        libraries: await writableLibraries(credentialFile),
        next: 'archive connect --kind kingdom --url KINGDOM --credential-file FILE --integration-id ID --resource-id ID --project-id PROJECT',
      };
    }
    await sleep(pollMs);
  }
  throw new Error('The review code expired before it was approved; run archive pair again');
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
