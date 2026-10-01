import { ArchiveStore } from '../src/store';

const base = new URL(
  process.env.ARCHIVE_TEST_DATABASE_URL ??
    // The archive block's Postgres port from @inixiative/config.
    'postgresql://archive:archive@127.0.0.1:6132/archive_test',
);

/** A test database per name, so stores (and their extensions) never share one. */
export const testDatabaseUrl = (name: string) => {
  const url = new URL(base);
  url.pathname = `/${base.pathname.slice(1)}_${name}`;
  return url.href;
};

/** Test databases, created and pushed once before the suite (bunfig preload). */
export const TEST_DATABASES = [
  'main',
  'remote',
  'serve',
  'personal',
  'inixiative',
  'userevidence',
] as const;
export type TestDatabase = (typeof TEST_DATABASES)[number];

/** Created empty and left to `serve`, which applies the migrations itself. */
export const MIGRATED_DATABASE = 'served';

export async function prepareTestDatabases() {
  // The maintenance database exists in every cluster; the test databases may not yet.
  const maintenance = new URL(base);
  maintenance.pathname = '/postgres';
  const admin = new Bun.SQL(maintenance.href);
  try {
    const migrated = new URL(testDatabaseUrl(MIGRATED_DATABASE)).pathname.slice(1);
    const [present] = await admin`SELECT 1 FROM pg_database WHERE datname = ${migrated}`;
    if (!present) await admin.unsafe(`CREATE DATABASE "${migrated}"`);
    for (const name of TEST_DATABASES) {
      const url = testDatabaseUrl(name);
      const database = new URL(url).pathname.slice(1);
      const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`;
      if (!exists) await admin.unsafe(`CREATE DATABASE "${database}"`);
      const push = Bun.spawnSync(
        [process.execPath, 'x', 'prisma', 'db', 'push', '--skip-generate'],
        { env: { ...process.env, DATABASE_URL: url }, stdout: 'ignore', stderr: 'pipe' },
      );
      if (!push.success) throw new Error(`Test database ${name}: ${push.stderr.toString()}`);
    }
  } finally {
    await admin.close();
  }
}

const open = new Map<string, ArchiveStore>();

/** An empty store in its own database, emptied for each test. */
export async function freshStore(name: TestDatabase = 'main') {
  const store = open.get(name) ?? new ArchiveStore(testDatabaseUrl(name));
  open.set(name, store);
  await store.db.$executeRawUnsafe(
    'TRUNCATE "archives", "settings", "tag_definitions" RESTART IDENTITY CASCADE',
  );
  return store;
}
