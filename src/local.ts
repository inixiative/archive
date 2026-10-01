import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  type ArchiveChunk,
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  chunkArchive,
  selectChunks,
  snapshotDigest,
} from './index';
import {
  archiveIntegrationSchema,
  archiveReferences,
  defaultIntegrations,
  suggestTags,
} from './tags';

export const archiveSettingsSchema = z.strictObject({
  /** Integrations sessions can reference; Kingdom and Foundry display these, Archive owns them. */
  integrations: z
    .array(archiveIntegrationSchema)
    .max(50)
    .refine(
      (list) => new Set(list.map((i) => i.key)).size === list.length,
      'Duplicate integration keys',
    ),
  /** Archives whose latest capture is older than this are deleted here. Deletions never sync. */
  retentionDays: z.number().int().positive().max(36_500).nullable(),
});
export type ArchiveSettings = z.infer<typeof archiveSettingsSchema>;
const defaultSettings: ArchiveSettings = { integrations: defaultIntegrations, retentionDays: null };

const tagSchema = z.string().min(1).max(120);
/** A conceptual tag this archive offers: archive-wide (no actor) or for one actor. */
export const tagDefinitionSchema = z.strictObject({
  tag: tagSchema,
  actorId: z.string().min(1).max(256).optional(),
  description: z.string().max(500).optional(),
});
export type TagDefinition = z.infer<typeof tagDefinitionSchema>;

export interface ArchiveFilter {
  projectId?: string;
  source?: ArchiveSnapshot['source'];
  tag?: string;
  actorId?: string;
  reference?: { integration: string; ref: string };
}

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
        pending TEXT NOT NULL, PRIMARY KEY(archive_id, destination));
      CREATE TABLE IF NOT EXISTS tag_edits (archive_id TEXT NOT NULL REFERENCES archives(id), tag TEXT NOT NULL,
        added INTEGER NOT NULL, PRIMARY KEY(archive_id, tag));
      CREATE TABLE IF NOT EXISTS tag_definitions (actor_id TEXT NOT NULL, tag TEXT NOT NULL, description TEXT,
        PRIMARY KEY(actor_id, tag));`);
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
  /** Computed per revision: references and suggestions scan the whole transcript. */
  private summaries = new Map<
    string,
    ReturnType<LocalArchiveStore['summarize']> & { digest: string }
  >();
  private summarize(id: string, revision: number) {
    const row = this.db
      .query('SELECT snapshot FROM revisions WHERE archive_id=? AND revision=?')
      .get(id, revision) as { snapshot: string };
    const full = archiveSnapshotSchema.parse(JSON.parse(row.snapshot));
    const { entries, tags, ...snapshot } = full;
    return {
      snapshot,
      capturedTags: tags,
      entries: entries.length,
      suggestedTags: suggestTags(full),
      references: archiveReferences(full, this.settings().integrations),
    };
  }
  /** Archive metadata, newest first. Tags are the captured tags with this archive's edits applied. */
  list(filter: ArchiveFilter = {}) {
    const rows = this.db
      .query('SELECT id, revision, digest FROM archives ORDER BY rowid DESC')
      .all() as { id: string; revision: number; digest: string }[];
    return rows.flatMap(({ id, revision, digest }) => {
      let summary = this.summaries.get(id);
      if (summary?.digest !== digest) {
        summary = { ...this.summarize(id, revision), digest };
        this.summaries.set(id, summary);
      }
      const { snapshot, references } = summary;
      const tags = this.tags(id, summary.capturedTags);
      const reference = filter.reference;
      if (
        (filter.projectId && snapshot.projectId !== filter.projectId) ||
        (filter.source && snapshot.source !== filter.source) ||
        (filter.tag && !tags.includes(filter.tag)) ||
        (filter.actorId && snapshot.actor?.id !== filter.actorId) ||
        (reference &&
          !references.some(
            (r) => r.integration === reference.integration && r.ref === reference.ref,
          ))
      )
        return [];
      return [
        {
          id,
          revision,
          digest,
          ...snapshot,
          tags,
          entries: summary.entries,
          suggestedTags: summary.suggestedTags,
          references,
        },
      ];
    });
  }
  private tags(id: string, captured: string[]) {
    const edits = this.db.query('SELECT tag, added FROM tag_edits WHERE archive_id=?').all(id) as {
      tag: string;
      added: number;
    }[];
    const removed = new Set(edits.filter((e) => !e.added).map((e) => e.tag));
    return [...new Set([...captured, ...edits.filter((e) => e.added).map((e) => e.tag)])].filter(
      (tag) => !removed.has(tag),
    );
  }
  /** Tag or untag without a new revision. Edits belong to this archive and do not sync. */
  tag(id: string, change: { add?: string[]; remove?: string[] }) {
    const add = z
      .array(tagSchema)
      .max(100)
      .parse(change.add ?? []);
    const remove = z
      .array(tagSchema)
      .max(100)
      .parse(change.remove ?? []);
    const archive = this.read(id);
    if (!archive) throw new Error('Archive unavailable');
    const captured = new Set(archive.snapshot.tags);
    const upsert = this.db.query(
      'INSERT INTO tag_edits VALUES (?, ?, ?) ON CONFLICT(archive_id, tag) DO UPDATE SET added=excluded.added',
    );
    const clear = this.db.query('DELETE FROM tag_edits WHERE archive_id=? AND tag=?');
    return this.db.transaction(() => {
      for (const tag of add) captured.has(tag) ? clear.run(id, tag) : upsert.run(id, tag, 1);
      for (const tag of remove) captured.has(tag) ? upsert.run(id, tag, 0) : clear.run(id, tag);
      const tags = this.tags(id, archive.snapshot.tags);
      z.array(tagSchema).max(100, 'An archive holds at most 100 tags').parse(tags);
      return { id, tags };
    })();
  }
  delete(id: string) {
    return this.db.transaction(() => {
      for (const table of ['tag_edits', 'receipts', 'outbox', 'revisions'])
        this.db.query(`DELETE FROM ${table} WHERE archive_id=?`).run(id);
      this.summaries.delete(id);
      return this.db.query('DELETE FROM archives WHERE id=?').run(id).changes > 0;
    })();
  }
  /** Applies the retention setting; returns the deleted archive ids. */
  prune(now = Date.now()) {
    const { retentionDays } = this.settings();
    if (retentionDays === null) return [];
    const cutoff = now - retentionDays * 86_400_000;
    const expired = (this.db.query('SELECT id FROM archives').all() as { id: string }[]).filter(
      ({ id }) => this.read(id)!.snapshot.capturedAt < cutoff,
    );
    for (const { id } of expired) this.delete(id);
    return expired.map(({ id }) => id);
  }
  settings(): ArchiveSettings {
    const row = this.db.query("SELECT value FROM settings WHERE key='archive'").get() as {
      value: string;
    } | null;
    return row ? archiveSettingsSchema.parse(JSON.parse(row.value)) : defaultSettings;
  }
  updateSettings(change: Partial<ArchiveSettings>) {
    const next = archiveSettingsSchema.parse({ ...this.settings(), ...change });
    this.db
      .query(
        "INSERT INTO settings VALUES ('archive', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(next));
    this.summaries.clear();
    return next;
  }
  /** Offered tags with how many archives carry each; an actor sees archive-wide and their own. */
  tagDefinitions(actorId?: string) {
    const rows = this.db
      .query(
        "SELECT actor_id, tag, description FROM tag_definitions WHERE actor_id IN ('', ?) ORDER BY tag",
      )
      .all(actorId ?? '') as { actor_id: string; tag: string; description: string | null }[];
    const archives = this.list(actorId ? { actorId } : {});
    return rows.map((row) => ({
      tag: row.tag,
      ...(row.actor_id ? { actorId: row.actor_id } : {}),
      ...(row.description ? { description: row.description } : {}),
      archives: archives.filter((archive) => archive.tags.includes(row.tag)).length,
    }));
  }
  defineTag(input: TagDefinition) {
    const definition = tagDefinitionSchema.parse(input);
    this.db
      .query(
        'INSERT INTO tag_definitions VALUES (?, ?, ?) ON CONFLICT(actor_id, tag) DO UPDATE SET description=excluded.description',
      )
      .run(definition.actorId ?? '', definition.tag, definition.description ?? null);
    return definition;
  }
  undefineTag(input: { tag: string; actorId?: string }) {
    return (
      this.db
        .query('DELETE FROM tag_definitions WHERE actor_id=? AND tag=?')
        .run(input.actorId ?? '', input.tag).changes > 0
    );
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
  pending(id: string, destination: string): { revision: number } | null {
    const row = this.db
      .query('SELECT pending FROM outbox WHERE archive_id=? AND destination=?')
      .get(id, destination) as { pending: string } | null;
    return row ? JSON.parse(row.pending) : null;
  }
  enqueue(id: string, destination: string, pending: { revision: number }) {
    this.db
      .query('INSERT OR IGNORE INTO outbox VALUES (?, ?, ?)')
      .run(id, destination, JSON.stringify(pending));
  }
  delivered(id: string, destination: string, hash: string) {
    this.db.transaction(() => {
      this.acknowledge(id, destination, hash);
      this.db.query('DELETE FROM outbox WHERE archive_id=? AND destination=?').run(id, destination);
    })();
  }
  close() {
    this.db.close();
  }
}
