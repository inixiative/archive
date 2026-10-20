import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySignetProof } from '@inixiative/signet';
import { requestRegistrationSchema } from '@inixiative/signet/contracts';
import { pairingRequest, pairWithKingdom } from '../src/kingdom';
import { routing } from './routing';

const fakeKingdom = () => {
  const nonces = new Set<string>();
  const state = { polls: 0, collected: 0, actions: [] as string[], requests: [] as unknown[] };
  let inquiryId = crypto.randomUUID();
  const signetId = crypto.randomUUID();
  const integrationId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const hostedId = crypto.randomUUID();
  const owner = {
    ownerModel: 'Organization',
    userId: null,
    organizationId: crypto.randomUUID(),
    spaceId: null,
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.headers.get('upgrade') === 'websocket')
        return new Response(null, { status: 426 });
      const action = new URL(request.url).pathname.split('/').pop()!;
      const data = (value: unknown) => Response.json({ data: value });
      if (action === 'nonce') {
        const nonce = randomBytes(32).toString('base64url');
        nonces.add(nonce);
        return data({ nonce, expiresAt: new Date().toISOString() });
      }
      const token = request.headers.get('authorization')?.slice(5);
      const proof = await verifySignetProof({
        proof: request.headers.get('dpop') ?? '',
        url: `http://127.0.0.1:${server.port}/api/v1/access/${action}`,
        method: 'POST',
        now: new Date(),
        token,
      });
      if (!nonces.delete(proof.nonce)) return Response.json({}, { status: 401 });
      state.actions.push(action);
      if (action === 'registerInstallation') return data({ installationId: crypto.randomUUID() });
      if (action === 'requestRegistration') {
        state.requests.push(requestRegistrationSchema.parse(await request.json()).terms);
        state.polls = 0;
        inquiryId = crypto.randomUUID();
        return data({
          reviewCode: 'ABCDEF123456',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          reviewUrl: 'https://kingdom.example/dashboard?reviewSignet=ABCDEF123456',
        });
      }
      if (action === 'installationInquiries') {
        state.polls++;
        const approved = state.polls > 1;
        return data({
          pending: approved
            ? null
            : {
                reviewCode: 'ABCDEF123456',
                expiresAt: new Date(Date.now() + 600000).toISOString(),
              },
          declinedAt: null,
          inquiries: approved
            ? [
                {
                  id: inquiryId,
                  type: 'registerIntegration',
                  status: 'approved',
                  createdAt: new Date().toISOString(),
                  expiresAt: null,
                  owner,
                  ownerName: 'Acme',
                  integrationId,
                  signetId,
                  deliverBefore: new Date(Date.now() + 86400000).toISOString(),
                },
              ]
            : [],
          hostedSignetRequests: [],
        });
      }
      if (action === 'installationSignets') return data({ signets: [], hostedSignets: [] });
      if (action === 'collectSignet') {
        state.collected++;
        return data({
          enrollmentId: crypto.randomUUID(),
          lifecycle: 'ongoing',
          taskId: null,
          accessToken: `kingdom_${'a'.repeat(43)}`,
          renewalCredential: `signet_renew_${'b'.repeat(43)}`,
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          renewalExpiresAt: new Date(Date.now() + 86400000).toISOString(),
          idleExpiresAt: new Date(Date.now() + 86400000).toISOString(),
          tokenType: 'DPoP',
          signetId,
          integrationId,
          owner,
        });
      }
      if (action === 'describe')
        return data({
          signetId,
          integrationId,
          provider: 'archive',
          name: 'Laptop Archive',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          lifecycle: 'ongoing',
          taskId: null,
          currentRevision: 1,
          remainingRequests: null,
          operations: [
            {
              key: 'sessions.write',
              name: 'Write sessions',
              resources: [
                {
                  id: resourceId,
                  name: 'Acme Archive',
                  kind: 'archiveLibrary',
                  integrationId: hostedId,
                  lens: {},
                },
              ],
            },
          ],
          holder: {
            integration: { id: integrationId, name: 'Laptop Archive', provider: 'archive' },
            owner: {
              ownerModel: 'Organization',
              name: 'Acme',
              organization: { id: owner.organizationId, name: 'Acme', slug: 'acme' },
              space: null,
              user: null,
            },
            issuedBy: { id: crypto.randomUUID(), name: 'Ada', email: 'ada@acme.example' },
            webUrl: 'https://kingdom.example',
            manageUrl: `https://kingdom.example/dashboard?integration=${integrationId}`,
          },
        });
      return Response.json({}, { status: 404 });
    },
  });
  return { server, state, url: `http://127.0.0.1:${server.port}`, hostedId, resourceId };
};

test('pair registers the Archive, waits for the claim, confirms the owner and collects', async () => {
  const kingdom = fakeKingdom();
  const directory = mkdtempSync(join(tmpdir(), 'archive-pair-'));
  chmodSync(directory, 0o700);
  try {
    const reviews: string[] = [];
    const owners: (string | null)[] = [];
    const paired = await pairWithKingdom({
      kingdom: kingdom.url,
      name: 'Laptop Archive',
      sourceId: crypto.randomUUID(),
      directory,
      request: pairingRequest({ kingdom: kingdom.url, organization: 'acme', destinations: [] }),
      onReview: (review) => reviews.push(review.reviewCode, review.review),
      confirmOwner: async ({ ownerName }) => {
        owners.push(ownerName);
        return true;
      },
      socketOptions: { pollMs: 10, retryBaseMs: 10_000 },
    });
    expect(reviews).toEqual([
      'ABCDEF123456',
      'https://kingdom.example/dashboard?reviewSignet=ABCDEF123456',
    ]);
    expect(kingdom.state.requests[0]).toMatchObject({
      owner: { ownerModel: 'Organization', organization: 'acme' },
      resources: [{ resourceKind: 'archiveLibrary', operations: ['sessions.write'], lens: {} }],
    });
    expect(owners).toEqual(['Acme']);
    expect(paired.libraries).toEqual([
      { integrationId: kingdom.hostedId, resourceId: kingdom.resourceId, name: 'Acme Archive' },
    ]);
    expect(kingdom.state.actions.slice(0, 3)).toEqual([
      'registerInstallation',
      'installationInquiries',
      'requestRegistration',
    ]);

    await expect(
      pairWithKingdom({
        kingdom: kingdom.url,
        name: 'Laptop Archive',
        sourceId: crypto.randomUUID(),
        directory,
        request: { resources: [] },
        onReview: () => {},
        confirmOwner: async () => false,
        socketOptions: { pollMs: 10, retryBaseMs: 10_000 },
      }),
    ).rejects.toThrow('owner was not confirmed');
    expect(kingdom.state.collected).toBe(1);
  } finally {
    kingdom.server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('pair asks for the named libraries, else the ones its Kingdom destinations name', () => {
  const kingdom = 'https://api.kingdom.example.com';
  const configured = crypto.randomUUID();
  const named = crypto.randomUUID();
  const destinations = [
    {
      kind: 'kingdom' as const,
      organizationId: 'kingdom',
      url: `${kingdom}/`,
      credentialFile: '/tmp/signet.json',
      integrationId: crypto.randomUUID(),
      resourceId: configured,
    },
    {
      kind: 'kingdom' as const,
      organizationId: 'other',
      url: 'https://api.elsewhere.example.com',
      credentialFile: '/tmp/signet.json',
      integrationId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
    },
  ];
  const operations = ['sessions.write'];
  expect(pairingRequest({ kingdom, destinations })).toEqual({
    resources: [{ resourceId: configured, operations }],
  });
  expect(
    pairingRequest({ kingdom, libraries: [named, 'inixiative Archive'], destinations }),
  ).toEqual({
    resources: [
      { resourceId: named, operations },
      { resourceKind: 'archiveLibrary', resourceName: 'inixiative Archive', operations },
    ],
  });
  expect(pairingRequest({ kingdom, organization: 'inixiative', destinations: [] })).toEqual({
    owner: { ownerModel: 'Organization', organization: 'inixiative' },
    resources: [{ resourceKind: 'archiveLibrary', operations }],
  });
});
