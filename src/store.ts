import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
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
  type ArchiveFilter,
  type ArchiveSettings,
  archiveSettingsSchema,
  defaultSettings,
  type TagDefinition,
  tagDefinitionSchema,
  tagSchema,
} from './schemas';
import { archiveReferences, suggestTags } from './tags';

export {
  type ArchiveFilter,
  type ArchiveSettings,
  archiveSettingsSchema,
  type TagDefinition,
  tagDefinitionSchema,
} from './schemas';

const summarize = (snapshot: ArchiveSnapshot, settings: ArchiveSettings) => {
  const { entries, tags, ...metadata } = snapshot;
  const models = new Map<string, { model: string; effort?: string; entries: number }>();
  for (const entry of entries) {
    if (!entry.model) continue;
    const key = JSON.stringify([entry.model, entry.effort]);
    const current = models.get(key) ?? {
      model: entry.model,
      ...(entry.effort ? { effort: entry.effort } : {}),
      entries: 0,
    };
    current.entries++;
    models.set(key, current);
  }
  return {
    ...metadata,
    capturedTags: tags,
    entries: entries.length,
    models: [...models.values()],
    suggestedTags: suggestTags(snapshot),
    references: archiveReferences(snapshot, settings.integrations),
  };
};
type Summary = ReturnType<typeof summarize>;

const toChunk = (row: {
  id: string;
  entryId: string;
  sourceRef: string;
  kind: string;
  start: number;
  end: number;
  text: string;
  tokenCount: number;
}): ArchiveChunk => ({
  id: row.id,
  entryId: row.entryId,
  sourceRef: row.sourceRef,
  kind: row.kind as ArchiveChunk['kind'],
  start: row.start,
  end: row.end,
  text: row.text,
  tokenCount: row.tokenCount,
  encoding: 'cl100k_base',
});

const BATCH = 500;

type ArchiveRow = {
  id: string;
  revision: number;
  digest: string;
  summary: Prisma.JsonValue;
  tagEdits: { tag: string; added: boolean }[];
};
const listing = (row: ArchiveRow, filter: ArchiveFilter) => {
  const { capturedTags, ...summary } = row.summary as Summary;
  const removed = new Set(row.tagEdits.filter((e) => !e.added).map((e) => e.tag));
  const tags = [
    ...new Set([...capturedTags, ...row.tagEdits.filter((e) => e.added).map((e) => e.tag)]),
  ].filter((tag) => !removed.has(tag));
  const { reference, model, effort } = filter;
  if (
    (filter.tag && !tags.includes(filter.tag)) ||
    (model && !summary.models.some((m) => m.model === model)) ||
    (effort && !summary.models.some((m) => m.effort === effort && (!model || m.model === model))) ||
    (reference &&
      !summary.references.some(
        (r) => r.integration === reference.integration && r.ref === reference.ref,
      ))
  )
    return [];
  return [{ id: row.id, revision: row.revision, digest: row.digest, ...summary, tags }];
};
export type ArchiveListing = ReturnType<typeof listing>[number];

/** One archive on Postgres. One deployment is one ownership boundary. */
export class ArchiveStore {
  readonly db: PrismaClient;
  private cachedSourceId?: string;
  constructor(databaseUrl: string) {
    this.db = new PrismaClient({ datasourceUrl: databaseUrl });
  }
  /** This archive's identity, stamped into the snapshots its collectors capture. */
  async sourceId() {
    if (this.cachedSourceId) return this.cachedSourceId;
    const row = await this.db.setting.upsert({
      where: { key: 'sourceId' },
      create: { key: 'sourceId', value: randomUUID() },
      update: {},
    });
    this.cachedSourceId = z.uuid().parse(row.value);
    return this.cachedSourceId;
  }
  async capture(input: unknown, expected?: { previousDigest: string | null }) {
    const snapshot = archiveSnapshotSchema.parse(input);
    const id = archiveKey(snapshot);
    const digest = snapshotDigest(snapshot);
    const settings = await this.settings();
    return this.db.$transaction(
      async (tx) => {
        // Serializes concurrent captures of one session.
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        const old = await tx.archive.findUnique({ where: { id } });
        if (old?.digest === digest) return { id, digest, revision: old.revision, changed: false };
        if (expected && (old?.digest ?? null) !== expected.previousDigest)
          throw new ArchiveConflict('Revision conflict');
        if (old && old.capturedAt > snapshot.capturedAt) throw new ArchiveConflict('Stale capture');
        const revision = (old?.revision ?? 0) + 1;
        const fields = {
          digest,
          revision,
          source: snapshot.source,
          projectId: snapshot.projectId ?? null,
          actorId: snapshot.actor?.id ?? null,
          capturedAt: snapshot.capturedAt,
          summary: summarize(snapshot, settings) as Prisma.InputJsonValue,
        };
        await tx.archive.upsert({ where: { id }, create: { id, ...fields }, update: fields });
        await tx.revision.create({
          data: { archiveId: id, revision, digest, snapshot: snapshot as Prisma.InputJsonValue },
        });
        const chunks = chunkArchive(snapshot);
        for (let offset = 0; offset < chunks.length; offset += 1000)
          await tx.chunk.createMany({
            data: chunks.slice(offset, offset + 1000).map(({ encoding: _, ...chunk }, i) => ({
              archiveId: id,
              revision,
              position: offset + i,
              ...chunk,
            })),
          });
        return { id, digest, revision, changed: true };
        // A 64 MB session writes tens of thousands of chunks.
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }
  /** Current digest and revision without the content. */
  async head(id: string) {
    const row = await this.db.archive.findUnique({
      where: { id },
      select: { id: true, digest: true, revision: true, projectId: true },
    });
    return row ?? undefined;
  }
  async read(id: string, revision?: number) {
    const archive = await this.db.archive.findUnique({ where: { id } });
    if (!archive) return undefined;
    const row = await this.db.revision.findUnique({
      where: { archiveId_revision: { archiveId: id, revision: revision ?? archive.revision } },
      include: { chunks: { orderBy: { position: 'asc' } } },
    });
    if (!row) return undefined;
    return {
      id,
      revision: row.revision,
      digest: row.digest,
      snapshot: archiveSnapshotSchema.parse(row.snapshot),
      chunks: row.chunks.map(toChunk),
    };
  }
  /**
   * One page of archive metadata, newest first, read from the database in batches. Tags are the
   * captured tags with this archive's edits applied. `keep` narrows each batch further (search).
   */
  async page(
    filter: ArchiveFilter,
    limit: number,
    beforeId?: string,
    keep?: (listings: ArchiveListing[]) => Promise<Set<string>>,
  ) {
    let cursor: bigint | undefined;
    if (beforeId) {
      const before = await this.db.archive.findUnique({
        where: { id: beforeId },
        select: { seq: true },
      });
      if (!before) return undefined;
      cursor = before.seq;
    }
    const items: ArchiveListing[] = [];
    while (items.length <= limit) {
      const rows = await this.db.archive.findMany({
        where: {
          ...(filter.projectId ? { projectId: filter.projectId } : {}),
          ...(filter.source ? { source: filter.source } : {}),
          ...(filter.actorId ? { actorId: filter.actorId } : {}),
          ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
        },
        include: { tagEdits: true },
        orderBy: { seq: 'desc' },
        take: BATCH,
      });
      if (!rows.length) break;
      cursor = rows.at(-1)!.seq;
      let listings = rows.flatMap((row) => listing(row, filter));
      if (keep && listings.length) {
        const kept = await keep(listings);
        listings = listings.filter((item) => kept.has(item.id));
      }
      items.push(...listings);
      if (rows.length < BATCH) break;
    }
    const slice = items.slice(0, limit);
    return { items: slice, nextCursor: items.length > limit ? slice.at(-1)!.id : null };
  }
  /** Every archive matching the filter, newest first. */
  async list(filter: ArchiveFilter = {}) {
    const all: ArchiveListing[] = [];
    let beforeId: string | undefined;
    do {
      const result = (await this.page(filter, BATCH, beforeId))!;
      all.push(...result.items);
      beforeId = result.nextCursor ?? undefined;
    } while (beforeId);
    return all;
  }
  /** Ids among `ids` whose current revision has a chunk containing any term. */
  async matching(ids: string[], query: string) {
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, 64);
    if (!terms.length || !ids.length) return new Set(ids);
    const current = await this.db.archive.findMany({
      where: { id: { in: ids } },
      select: { id: true, revision: true },
    });
    const rows = await this.db.chunk.findMany({
      where: {
        OR: current.map((a) => ({ archiveId: a.id, revision: a.revision })),
        AND: {
          OR: terms.map((term) => ({ text: { contains: term, mode: 'insensitive' as const } })),
        },
      },
      distinct: ['archiveId'],
      select: { archiveId: true },
    });
    return new Set(rows.map((row) => row.archiveId));
  }
  async search(ids: string[], query: string, budget = 2048) {
    return Promise.all(
      ids.map(async (id) => {
        const archive = await this.read(id);
        if (!archive) throw new Error('Archive unavailable');
        return {
          id,
          revision: archive.revision,
          digest: archive.digest,
          ...selectChunks(archive.chunks, query, budget),
        };
      }),
    );
  }
  /** Tag or untag without a new revision. Edits belong to this archive and do not sync. */
  async tag(id: string, change: { add?: string[]; remove?: string[] }) {
    const add = z
      .array(tagSchema)
      .max(100)
      .parse(change.add ?? []);
    const remove = z
      .array(tagSchema)
      .max(100)
      .parse(change.remove ?? []);
    return this.db.$transaction(async (tx) => {
      const archive = await tx.archive.findUnique({ where: { id } });
      if (!archive) throw new Error('Archive unavailable');
      const captured = new Set((archive.summary as Summary).capturedTags);
      const set = (tag: string, added: boolean) =>
        tx.tagEdit.upsert({
          where: { archiveId_tag: { archiveId: id, tag } },
          create: { archiveId: id, tag, added },
          update: { added },
        });
      const clear = (tag: string) => tx.tagEdit.deleteMany({ where: { archiveId: id, tag } });
      for (const tag of add) await (captured.has(tag) ? clear(tag) : set(tag, true));
      for (const tag of remove) await (captured.has(tag) ? set(tag, false) : clear(tag));
      const edits = await tx.tagEdit.findMany({ where: { archiveId: id } });
      const removed = new Set(edits.filter((e) => !e.added).map((e) => e.tag));
      const tags = [
        ...new Set([...captured, ...edits.filter((e) => e.added).map((e) => e.tag)]),
      ].filter((tag) => !removed.has(tag));
      z.array(tagSchema).max(100, 'An archive holds at most 100 tags').parse(tags);
      return { id, tags };
    });
  }
  async delete(id: string) {
    return (await this.db.archive.deleteMany({ where: { id } })).count > 0;
  }
  /** Applies the retention setting; returns the deleted archive ids. */
  async prune(now = Date.now()) {
    const { retentionDays } = await this.settings();
    if (retentionDays === null) return [];
    const expired = await this.db.archive.findMany({
      where: { capturedAt: { lt: now - retentionDays * 86_400_000 } },
      select: { id: true },
    });
    await this.db.archive.deleteMany({ where: { id: { in: expired.map((a) => a.id) } } });
    return expired.map((a) => a.id);
  }
  async settings(): Promise<ArchiveSettings> {
    const row = await this.db.setting.findUnique({ where: { key: 'archive' } });
    return row ? archiveSettingsSchema.parse(row.value) : defaultSettings;
  }
  /** Saves settings and recomputes listings together, since references follow the integrations. */
  async updateSettings(change: Partial<ArchiveSettings>) {
    const next = archiveSettingsSchema.parse({ ...(await this.settings()), ...change });
    await this.db.$transaction(
      async (tx) => {
        await tx.setting.upsert({
          where: { key: 'archive' },
          create: { key: 'archive', value: next },
          update: { value: next },
        });
        const archives = await tx.archive.findMany({ select: { id: true, revision: true } });
        for (const archive of archives) {
          const row = await tx.revision.findUnique({
            where: { archiveId_revision: { archiveId: archive.id, revision: archive.revision } },
            select: { snapshot: true },
          });
          if (!row) continue;
          await tx.archive.update({
            where: { id: archive.id },
            data: {
              summary: summarize(
                archiveSnapshotSchema.parse(row.snapshot),
                next,
              ) as Prisma.InputJsonValue,
            },
          });
        }
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
    return next;
  }
  /** Offered tags with how many archives carry each; an actor sees archive-wide and their own. */
  async tagDefinitions(actorId?: string) {
    const rows = await this.db.tagDefinition.findMany({
      where: { actorId: { in: ['', actorId ?? ''] } },
      orderBy: { tag: 'asc' },
    });
    const archives = await this.list(actorId ? { actorId } : {});
    return rows.map((row) => ({
      tag: row.tag,
      ...(row.actorId ? { actorId: row.actorId } : {}),
      ...(row.description ? { description: row.description } : {}),
      archives: archives.filter((archive) => archive.tags.includes(row.tag)).length,
    }));
  }
  async defineTag(input: TagDefinition) {
    const definition = tagDefinitionSchema.parse(input);
    const actorId = definition.actorId ?? '';
    const description = definition.description ?? null;
    await this.db.tagDefinition.upsert({
      where: { actorId_tag: { actorId, tag: definition.tag } },
      create: { actorId, tag: definition.tag, description },
      update: { description },
    });
    return definition;
  }
  async undefineTag(input: { tag: string; actorId?: string }) {
    return (
      (
        await this.db.tagDefinition.deleteMany({
          where: { actorId: input.actorId ?? '', tag: input.tag },
        })
      ).count > 0
    );
  }
  async receipt(id: string, destination: string) {
    return (
      (
        await this.db.receipt.findUnique({
          where: { archiveId_destination: { archiveId: id, destination } },
        })
      )?.digest ?? null
    );
  }
  async pending(id: string, destination: string) {
    const row = await this.db.outbox.findUnique({
      where: { archiveId_destination: { archiveId: id, destination } },
    });
    return row ? { revision: row.revision } : null;
  }
  async enqueue(id: string, destination: string, pending: { revision: number }) {
    await this.db.outbox.upsert({
      where: { archiveId_destination: { archiveId: id, destination } },
      create: { archiveId: id, destination, revision: pending.revision },
      update: {},
    });
  }
  async delivered(id: string, destination: string, digest: string) {
    await this.db.$transaction([
      this.db.receipt.upsert({
        where: { archiveId_destination: { archiveId: id, destination } },
        create: { archiveId: id, destination, digest },
        update: { digest },
      }),
      this.db.outbox.deleteMany({ where: { archiveId: id, destination } }),
    ]);
  }
  async close() {
    await this.db.$disconnect();
  }
}

/** A capture that lost a race or arrived out of order; the server answers 409. */
export class ArchiveConflict extends Error {}
