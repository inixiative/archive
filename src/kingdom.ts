import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  collectSignet,
  generateSignetKey,
  installationInquiries,
  kingdomUrl,
  registerInstallation,
  requestRegistration,
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

type Pairing = {
  kingdom: string;
  name: string;
  sourceId: string;
  directory: string;
  onReview: (review: { reviewCode: string; review: string; expiresAt: string }) => void;
  confirmOwner: (owner: { ownerName: string | null; owner: unknown }) => Promise<boolean>;
  sleep?: (ms: number) => Promise<unknown>;
};

/** The key that names this Archive to one Kingdom; reused for every owner it registers with. */
async function installationKey(directory: string) {
  const keyFile = join(directory, 'installation-key.json');
  if (!existsSync(keyFile)) await writePrivateJson(keyFile, generateSignetKey());
  return keyFile;
}

/**
 * Registers this Archive with Kingdom as an Installation and asks to become an owner's local
 * Archive integration. A person claims the review code in Kingdom; once approved, the Archive
 * confirms the owner locally before collecting its Signet.
 */
export async function pairWithKingdom(input: Pairing) {
  const kingdom = kingdomUrl(input.kingdom);
  const directory = join(input.directory, new URL(kingdom).host);
  const keyFile = await installationKey(directory);
  await registerInstallation(kingdom, keyFile, {
    kind: 'archive',
    name: input.name,
    sourceId: input.sourceId,
  });
  const askedAt = Date.now();
  const pending = await requestRegistration(kingdom, keyFile, {
    name: input.name,
    lifecycle: 'ongoing',
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
  for (;;) {
    const state = await installationInquiries(kingdom, keyFile);
    if (state.declinedAt && Date.parse(state.declinedAt) >= askedAt)
      throw new Error('The registration was declined in Kingdom');
    const inquiry = state.inquiries.find(
      (item) => item.type === 'registerIntegration' && Date.parse(item.createdAt) >= askedAt,
    );
    if (inquiry?.status === 'approved') {
      if (!(await input.confirmOwner({ ownerName: inquiry.ownerName, owner: inquiry.owner })))
        throw new Error('Not collected: the owner was not confirmed');
      const collected = await collectSignet(kingdom, keyFile, inquiry.id);
      if (!collected) throw new Error('Kingdom has not released the Signet yet; try again');
      const credentialFile = join(directory, `signet-${collected.signetId}.json`);
      await saveCollectedSignet(credentialFile, kingdom, keyFile, collected);
      return {
        paired: true,
        owner: inquiry.ownerName,
        integrationId: collected.integrationId,
        credentialFile,
        libraries: await writableLibraries(credentialFile),
        next: 'archive connect --kind kingdom --url KINGDOM --credential-file FILE --integration-id ID --resource-id ID --project-id PROJECT',
      };
    }
    if (inquiry && inquiry.status !== 'sent')
      throw new Error(`The registration was ${inquiry.status} in Kingdom`);
    if (!inquiry && !state.pending)
      throw new Error('The review code expired before it was claimed; run archive pair again');
    await sleep(pollMs);
  }
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
