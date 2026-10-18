import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SyncBackoff, syncArchives } from '../src/client';
import {
  connectDestination,
  destinationIdentity,
  destinationsFile,
  kingdomDirectory,
  readRouting,
  removeDestination,
  removeOrganization,
  sessionDestinations,
  sessionOrganizations,
  setOrganization,
} from '../src/config';
import { archiveSnapshotSchema } from '../src/index';
import { ArchiveClient, ArchiveRequestError } from '../src/remote';
import { createArchiveHandler } from '../src/server';
import { freshStore } from './db';
import { signetKingdom } from './kingdom';
import { routing } from './routing';

const token = 'synthetic-archive-test-token-0000000000';
const snapshot = (projectId: string, sessionId: string) =>
  archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: '1ae3ac76-faa8-4498-8072-425ab35f453c',
    source: 'codex',
    sessionId,
    title: 'Destination test',
    projectId,
    tags: [],
    capturedAt: 1,
    coverage: { reasoning: 'unavailable', completeness: 'recorded', omissions: [] },
    entries: [{ id: 'one', kind: 'user', text: 'Route me', timestamp: 1, sourceRef: 'line:1' }],
  });
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-destinations-'));
  chmodSync(dir, 0o700);
  return dir;
};

test('removeDestination drops only that organization route and keeps the file private', () => {
  const dir = home();
  const file = destinationsFile(dir);
  try {
    const direct = {
      kind: 'archive' as const,
      url: 'https://archive.example/',
      tokenEnv: 'ARCHIVE_TOKEN',
    };
    connectDestination(file, { ...direct, organizationId: 'one' });
    connectDestination(file, { ...direct, organizationId: 'two' });
    const identity = destinationIdentity({ ...direct, organizationId: 'one' });
    expect(removeDestination(file, { organizationId: 'one', identity })).toBe(true);
    expect(readRouting(file).destinations.map((d) => d.organizationId)).toEqual(['two']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(removeDestination(file, { organizationId: 'one', identity })).toBe(false);
    expect(removeDestination(join(dir, 'missing.json'), { organizationId: 'one', identity })).toBe(
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('destination endpoints list delivery, libraries, connect and remove through the paired Signet', async () => {
  const store = await freshStore();
  const dir = home();
  const config = {
    destinationsFile: destinationsFile(dir),
    kingdomDirectory: kingdomDirectory(dir),
  };
  const integrationId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const kingdom = signetKingdom({
    libraries: [{ integrationId, resourceId, name: 'Org Archive' }],
  });
  const handler = createArchiveHandler(store, token, config);
  const archive = new ArchiveClient({
    url: 'http://archive.test/',
    token,
    fetch: ((url: URL, init: RequestInit) => handler(new Request(url.href, init))) as typeof fetch,
  });
  const route = { organizationId: 'inixiative', integrationId, resourceId };
  try {
    expect(await archive.libraries()).toEqual({ paired: false, libraries: [] });
    await expect(archive.connectDestination(route)).rejects.toMatchObject({ status: 403 });

    await kingdom.hold(config.kingdomDirectory);
    expect(await archive.libraries()).toEqual({
      paired: true,
      libraries: [{ integrationId, resourceId, name: 'Org Archive' }],
    });
    const other = { ...route, resourceId: crypto.randomUUID() };
    const refused = await archive.connectDestination(other).catch((error) => error);
    expect(refused).toBeInstanceOf(ArchiveRequestError);
    expect(refused).toMatchObject({
      status: 403,
      message: expect.stringContaining('sessions.write'),
    });
    expect(readRouting(config.destinationsFile).destinations).toEqual([]);

    const connected = await archive.connectDestination(route);
    expect(connected).toEqual({
      configured: true,
      kind: 'kingdom',
      organizationId: 'inixiative',
      url: `${kingdom.origin}/`,
      integrationId,
      resourceId,
    });
    const [saved] = readRouting(config.destinationsFile).destinations;
    expect(saved).toMatchObject({ kind: 'kingdom', ...route });
    if (saved.kind !== 'kingdom') throw new Error('Expected a Kingdom destination');
    expect(saved.credentialFile.startsWith(config.kingdomDirectory)).toBe(true);
    expect(await archive.connectDestination(route)).toEqual(connected);
    connectDestination(config.destinationsFile, {
      kind: 'archive',
      organizationId: 'personal',
      url: 'https://personal.example',
      tokenEnv: 'PERSONAL_TOKEN',
    });
    // Connecting declares the organization; which projects it owns is set separately.
    expect((await archive.organizations()).organizations).toEqual([
      { id: 'inixiative', projects: [] },
      { id: 'personal', projects: [] },
    ]);
    await archive.setOrganization({ id: 'inixiative', projects: ['inixiative'] });
    await archive.setOrganization({ id: 'personal', projects: ['personal'] });

    const delivered = await store.capture(snapshot('inixiative', 'delivered'));
    const stale = await store.capture(snapshot('inixiative', 'stale'));
    await store.capture(snapshot('inixiative', 'new'));
    await store.capture(snapshot('personal', 'personal'));
    const identity = destinationIdentity(saved);
    await store.delivered(delivered.id, identity, delivered.digest);
    await store.delivered(stale.id, identity, stale.digest);
    await store.capture({ ...snapshot('inixiative', 'stale'), title: 'Changed', capturedAt: 2 });

    expect((await archive.destinations()).destinations).toEqual([
      { ...connected, delivered: 1, pending: 2 },
      {
        configured: true,
        kind: 'archive',
        organizationId: 'personal',
        url: 'https://personal.example/',
        tokenEnv: 'PERSONAL_TOKEN',
        delivered: 0,
        pending: 1,
      },
    ]);
    expect(
      (await archive.destinations({ organizationId: 'personal' })).destinations.map(
        (d) => d.organizationId,
      ),
    ).toEqual(['personal']);
    expect(JSON.stringify(await archive.destinations())).not.toContain('credentialFile');

    expect(await archive.removeDestination(route)).toEqual({ removed: true });
    expect(await archive.removeDestination(route)).toEqual({ removed: false });
    expect(readRouting(config.destinationsFile).destinations.map((d) => d.organizationId)).toEqual([
      'personal',
    ]);
    expect(await archive.removeOrganization('personal')).toEqual({ removed: true });
    expect(readRouting(config.destinationsFile)).toEqual({
      organizations: [{ id: 'inixiative', projects: ['inixiative'] }],
      destinations: [],
    });
    await expect(
      archive.request('destinations/remove', { ...route, organizationId: undefined }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      archive.request('destinations/connect', { ...route, kind: 'archive' }),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    kingdom.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a server without configuration has no destination endpoints', async () => {
  const handler = createArchiveHandler(await freshStore(), token);
  const response = await handler(
    new Request('http://localhost/api/v1/archive/destinations/list', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    }),
  );
  expect(response.status).toBe(404);
});

test('a failed delivery backs off, doubling per failure, and clears once delivered', async () => {
  const store = await freshStore();
  const { id } = await store.capture(snapshot('backoff', 'backoff-1'));
  let accept = false;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (!accept) return Response.json({ error: 'Invalid archive request' }, { status: 400 });
      const { snapshot: sent } = JSON.parse(
        Buffer.from(Bun.gunzipSync(await request.arrayBuffer())).toString('utf8'),
      ) as { snapshot: unknown };
      return Response.json({ data: await (await freshStore('remote')).capture(sent) });
    },
  });
  process.env.ARCHIVE_BACKOFF_TEST_TOKEN = token;
  const destinations = [
    {
      kind: 'archive' as const,
      organizationId: 'backoff',
      url: server.url.href,
      tokenEnv: 'ARCHIVE_BACKOFF_TEST_TOKEN',
    },
  ];
  const backoff: SyncBackoff = new Map();
  let clock = 1_000_000;
  const sync = async () =>
    (await syncArchives(store, routing(destinations), { backoff, now: () => clock })).find(
      (r) => r.id === id,
    )!.status;
  try {
    expect(await sync()).toStartWith('failed');
    clock += 29_000;
    expect(await sync()).toStartWith('deferred');
    clock += 1_000;
    expect(await sync()).toStartWith('failed');
    // The second failure waits 60 seconds.
    clock += 59_000;
    expect(await sync()).toStartWith('deferred');
    clock += 1_000;
    accept = true;
    expect(await sync()).toBe('published');
    expect(backoff.size).toBe(0);
    expect(await sync()).toBe('unchanged');
  } finally {
    server.stop(true);
  }
});

test('an unreachable destination is skipped for every archive until it is due; a new revision retries at once', async () => {
  const store = await freshStore();
  const first = await store.capture(snapshot('circuit', 'circuit-1'));
  await store.capture(snapshot('circuit', 'circuit-2'));
  process.env.ARCHIVE_BACKOFF_TEST_TOKEN = token;
  const down = [
    {
      kind: 'archive' as const,
      organizationId: 'circuit',
      url: 'http://127.0.0.1:9/',
      tokenEnv: 'ARCHIVE_BACKOFF_TEST_TOKEN',
    },
  ];
  const backoff: SyncBackoff = new Map();
  let clock = 1_000_000;
  const statuses = async () =>
    (await syncArchives(store, routing(down), { backoff, now: () => clock })).map(
      (r) => r.status.split(' ')[0],
    );
  // One connection failure defers the destination's other archives in the same cycle.
  expect((await statuses()).sort()).toEqual(['deferred', 'failed;']);
  clock += 10_000;
  expect(await statuses()).toEqual(['deferred', 'deferred']);

  // A refused archive waits, but its next revision is tried at once.
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      calls++;
      return Response.json({ error: 'Invalid archive request' }, { status: 400 });
    },
  });
  try {
    const refusing = [{ ...down[0]!, url: server.url.href }];
    const only = async () =>
      (await syncArchives(store, routing(refusing), { backoff, now: () => clock })).find(
        (r) => r.id === first.id,
      )!.status;
    expect(await only()).toStartWith('failed');
    expect(await only()).toStartWith('deferred');
    await store.capture({ ...snapshot('circuit', 'circuit-1'), title: 'Revised', capturedAt: 2 });
    calls = 0;
    expect(await only()).toStartWith('failed');
    expect(calls).toBeGreaterThan(0);
  } finally {
    server.stop(true);
  }
});

test('routing is per organization: a session publishes to every organization it belongs to', () => {
  const dir = home();
  const file = destinationsFile(dir);
  try {
    const direct = (organizationId: string, url: string) => ({
      kind: 'archive' as const,
      organizationId,
      url,
      tokenEnv: 'ARCHIVE_TOKEN',
    });
    connectDestination(file, direct('inixiative', 'https://inixiative.example'));
    connectDestination(file, direct('userevidence', 'https://userevidence.example'));
    setOrganization(file, { id: 'inixiative', projects: ['inixiative', 'template', 'tribe'] });
    setOrganization(file, { id: 'userevidence', projects: ['userevidence'] });
    // A project belongs to at most one organization.
    expect(() => setOrganization(file, { id: 'userevidence', projects: ['template'] })).toThrow(
      'another organization',
    );
    const routed = readRouting(file);
    const urls = (session: { projectId?: string; tags: string[] }) =>
      sessionDestinations(routed, session).map((d) => d.url);
    // Projects are tags: a mixed session goes to both organizations.
    expect(
      urls({ projectId: 'inixiative', tags: ['project:template', 'project:userevidence'] }),
    ).toEqual(['https://inixiative.example/', 'https://userevidence.example/']);
    expect(urls({ projectId: 'userevidence', tags: ['project:tribe'] })).toEqual([
      'https://inixiative.example/',
      'https://userevidence.example/',
    ]);
    expect(sessionOrganizations(routed, { projectId: 'template', tags: [] })).toEqual([
      'inixiative',
    ]);
    // A project in no organization stays local; so does unrouted.
    expect(urls({ projectId: 'scratch', tags: ['project:oracle'] })).toEqual([]);
    expect(urls({ projectId: 'unrouted', tags: [] })).toEqual([]);
    expect(() => setOrganization(file, { id: 'x', projects: ['unrouted'] })).toThrow();
    // Removing an organization takes its destinations; its projects stay local.
    expect(removeOrganization(file, 'userevidence')).toBe(true);
    expect(readRouting(file).destinations.map((d) => d.organizationId)).toEqual(['inixiative']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
