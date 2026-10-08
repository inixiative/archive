import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  generateSignetKey,
  signetCredentialFile,
  verifySignetProof,
  writePrivateJson,
} from '@inixiative/signet';

type Library = { integrationId: string; resourceId: string; name: string };
/** What Archive sends to `execute`. */
export type ExecuteBody = {
  signetId: string;
  integrationId: string;
  operation: string;
  input: { resourceId: string; previousDigest?: string | null; snapshot?: { sessionId: string } };
};

/** A Kingdom serving one Signet's describe and execute, checking every DPoP proof. */
export function signetKingdom(options: {
  libraries: Library[];
  execute?: (body: ExecuteBody) => unknown;
}) {
  const nonces = new Set<string>();
  const executed: ExecuteBody[] = [];
  const signetId = crypto.randomUUID();
  const localIntegrationId = crypto.randomUUID();
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const action = new URL(request.url).pathname.split('/').pop();
      const data = (value: unknown) => Response.json({ data: value });
      if (action === 'nonce') {
        const nonce = randomBytes(32).toString('base64url');
        nonces.add(nonce);
        return data({ nonce, expiresAt: new Date().toISOString() });
      }
      const proof = await verifySignetProof({
        proof: request.headers.get('dpop') ?? '',
        url: `${origin}/api/v1/access/${action}`,
        method: 'POST',
        now: new Date(),
        token: request.headers.get('authorization')?.slice(5),
      });
      if (!nonces.delete(proof.nonce)) return Response.json({}, { status: 401 });
      if (action === 'describe')
        return data({
          signetId,
          integrationId: localIntegrationId,
          provider: 'archive',
          name: 'Laptop Archive',
          expiresAt: null,
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          operations: [
            {
              key: 'sessions.write',
              name: 'Write sessions',
              resources: options.libraries.map((library) => ({
                id: library.resourceId,
                name: library.name,
                kind: 'archiveLibrary',
                integrationId: library.integrationId,
              })),
            },
          ],
        });
      if (action === 'execute') {
        const body = (await request.json()) as ExecuteBody;
        executed.push(body);
        return data({ executionId: crypto.randomUUID(), result: await options.execute?.(body) });
      }
      return Response.json({}, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    signetId,
    executed,
    stop: () => server.stop(true),
    /** Writes the Signet's credential and key where `pair` would under the directory. */
    async hold(directory: string) {
      const kingdomDirectory = join(directory, `127.0.0.1:${server.port}`);
      const keyFile = join(kingdomDirectory, 'installation-key.json');
      const file = signetCredentialFile(kingdomDirectory, signetId);
      await writePrivateJson(keyFile, generateSignetKey());
      await writePrivateJson(file, {
        url: origin,
        signetId,
        integrationId: localIntegrationId,
        keyFile,
        enrollmentId: crypto.randomUUID(),
        lifecycle: 'ongoing',
        taskId: null,
        accessToken: `kingdom_${'a'.repeat(43)}`,
        renewalCredential: `signet_renew_${'b'.repeat(43)}`,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        renewalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        idleExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        tokenType: 'DPoP',
      });
      return file;
    },
  };
}
