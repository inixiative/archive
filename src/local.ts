import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ArchiveChunk,
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  categorySuggestions,
  chunkArchive,
  selectChunks,
  snapshotDigest,
} from './index';

export class LocalArchiveStore {
  private readonly db: Database;
  readonly sourceId: string;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (archive_id TEXT NOT NULL REFERENCES archives(id), revision INTEGER NOT NULL,
        digest TEXT NOT NULL, snapshot TEXT NOT NULL, chunks TEXT NOT NULL, PRIMARY KEY(archive_id, revision));
      CREATE TABLE IF NOT EXISTS receipts (archive_id TEXT NOT NULL REFERENCES archives(id), destination TEXT NOT NULL,
        digest TEXT NOT NULL, PRIMARY KEY(archive_id, destination));
      CREATE TABLE IF NOT EXISTS outbox (archive_id TEXT NOT NULL REFERENCES archives(id), destination TEXT NOT NULL,
        pending TEXT NOT NULL, PRIMARY KEY(archive_id, destination));`);
    this.db.query("INSERT OR IGNORE INTO settings VALUES ('sourceId', ?)").run(randomUUID());
    this.sourceId = (
      this.db.query("SELECT value FROM settings WHERE key='sourceId'").get() as { value: string }
    ).value;
  }
  capture(input: unknown) {
    const snapshot = archiveSnapshotSchema.parse(input);
    const id = archiveKey(snapshot);
    const hash = snapshotDigest(snapshot);
    return this.db.transaction(() => {
      const old = this.read(id);
      if (old?.digest === hash) return { id, digest: hash, revision: old.revision, changed: false };
      if (old && old.snapshot.capturedAt > snapshot.capturedAt)
        throw new Error('Older capture cannot replace newer archive');
      const revision = (old?.revision ?? 0) + 1;
      const chunks = chunkArchive(snapshot);
      this.db
        .query(
          'INSERT INTO archives VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET digest=excluded.digest, revision=excluded.revision',
        )
        .run(id, hash, revision);
      this.db
        .query('INSERT INTO revisions VALUES (?, ?, ?, ?, ?)')
        .run(id, revision, hash, JSON.stringify(snapshot), JSON.stringify(chunks));
      return { id, digest: hash, revision, changed: true };
    })();
  }
  read(
    id: string,
    revision?: number,
  ):
    | {
        id: string;
        revision: number;
        digest: string;
        snapshot: ArchiveSnapshot;
        chunks: ArchiveChunk[];
      }
    | undefined {
    const row = this.db
      .query(`SELECT r.* FROM revisions r JOIN archives a ON a.id=r.archive_id
      WHERE a.id=? AND r.revision=COALESCE(?, a.revision)`)
      .get(id, revision ?? null) as any;
    return row
      ? {
          id,
          revision: row.revision,
          digest: row.digest,
          snapshot: archiveSnapshotSchema.parse(JSON.parse(row.snapshot)),
          chunks: JSON.parse(row.chunks),
        }
      : undefined;
  }
  list() {
    return (
      this.db.query('SELECT id FROM archives ORDER BY rowid DESC').all() as { id: string }[]
    ).map(({ id }) => {
      const archive = this.read(id)!;
      const { entries, ...snapshot } = archive.snapshot;
      return {
        id,
        revision: archive.revision,
        digest: archive.digest,
        ...snapshot,
        entries: entries.length,
        suggestedTags: categorySuggestions(archive.snapshot),
      };
    });
  }
  search(ids: string[], query: string, budget = 2048) {
    return ids.map((id) => {
      const archive = this.read(id);
      if (!archive) throw new Error('Archive unavailable');
      return {
        id,
        revision: archive.revision,
        digest: archive.digest,
        ...selectChunks(archive.chunks, query, budget),
      };
    });
  }
  receipt(id: string, destination: string): string | null {
    return (
      (
        this.db
          .query('SELECT digest FROM receipts WHERE archive_id=? AND destination=?')
          .get(id, destination) as { digest: string } | null
      )?.digest ?? null
    );
  }
  acknowledge(id: string, destination: string, hash: string) {
    this.db
      .query(
        'INSERT INTO receipts VALUES (?, ?, ?) ON CONFLICT(archive_id,destination) DO UPDATE SET digest=excluded.digest',
      )
      .run(id, destination, hash);
  }
  pending(id: string, destination: string): { revision: number; keepIds: string[] } | null {
    const row = this.db
      .query('SELECT pending FROM outbox WHERE archive_id=? AND destination=?')
      .get(id, destination) as { pending: string } | null;
    return row ? JSON.parse(row.pending) : null;
  }
  enqueue(id: string, destination: string, pending: { revision: number; keepIds: string[] }) {
    this.db
      .query('INSERT OR IGNORE INTO outbox VALUES (?, ?, ?)')
      .run(id, destination, JSON.stringify(pending));
  }
  delivered(id: string, destination: string, hash: string, placement: string) {
    this.db.transaction(() => {
      this.acknowledge(id, destination, hash);
      this.acknowledge(id, `${destination}:keeps`, placement);
      this.db.query('DELETE FROM outbox WHERE archive_id=? AND destination=?').run(id, destination);
    })();
  }
  close() {
    this.db.close();
  }
}
