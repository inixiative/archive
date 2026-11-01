import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { destinationIdentity, type Routing } from './config';
import {
  evidenceByOrganization,
  evidencedOrganizations,
  type ProjectMap,
  projectMapKey,
  projectMapSchema,
  type SessionEvidence,
  sessionEvidence,
} from './evidence';
import { droppableRun, exemptRun, identityRunTags, RUN_TAGS } from './exemption';
import {
  type ArchiveChunk,
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  chunkArchive,
  digest,
  selectChunks,
  snapshotDigest,
  transcriptDigest,
  UNROUTED,
} from './index';
import { partSnapshot } from './parts';
import {
  PERSONAL,
  planReach,
  publishedParts,
  quotedSessions,
  type RecordPlanBody,
  type RecordPlanResult,
  ROUTE_TAG_PREFIX,
  type RoutingEntry,
  type RoutingInput,
  sensitiveEntries,
  storedPlanSchema,
  validatePlan,
} from './route';
import {
  type ArchiveFilter,
  type ArchiveSettings,
  archiveSettingsSchema,
  CLAIM_SOURCES,
  type ClaimSource,
  type ClaimState,
  defaultSettings,
  type TagDefinition,
  tagDefinitionSchema,
  tagSchema,
} from './schemas';
import {
  JUNK_TAG,
  PROJECT_TAG_PREFIX,
  type SessionDigest,
  type SuggestionDue,
  type SuggestionResult,
  sessionDigest,
} from './suggest';
import { archiveReferences } from './tags';
import { withoutToolActivity } from './tool-activity';

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
    references: archiveReferences(snapshot, settings.integrations),
    /** What the tagger reads; absent from listings. */
    session: sessionDigest(snapshot) as SessionDigest | undefined,
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
/** The settings row that marks past tool activity still to remove, and how far the sweep got. */
const TOOL_ACTIVITY_SWEEP = 'toolActivitySweep';
const toolActivitySweepSchema = z.strictObject({
  afterSeq: z.string().regex(/^\d+$/),
  finished: z.boolean().default(false),
  failed: z.array(z.string()).max(10_000).default([]),
});
/** The settings row that marks run sessions still to delete, and how far the sweep got. */
const RUN_SESSION_SWEEP = 'runSessionSweep';
const runSessionSweepSchema = z.strictObject({ afterSeq: z.string().regex(/^\d+$/) });
const RUN_SESSION_BATCH = 100;
const COMPACTION_BATCH = 100;
/** The trigram index on chunk text (prisma/schema.prisma) that search uses. */
const SEARCH_INDEX = 'chunks_text_idx';
const TOOL_ACTIVITY_BATCH = 50;
/** The settings row holding the host's project map (`projects/set`), for evidence at ingest. */
const PROJECT_MAP = 'projectMap';
/** What the routing planner reads per entry, and per request, in characters. */
/**
 * The planner sees whole entries, as many as fit a window; one longer than a whole window is shown
 * cut, and a part holding it holds (`ValidationContext.clipped`).
 */
export const ROUTE_WINDOW_CHARS = 300_000;
/** Advisory lock key: captures hold it shared, a settings change exclusively. */
const SETTINGS_LOCK = 0x41524348;

/** A session's tags before edits: as captured, plus the run tags its identity implies. */
const baseTags = (summary: Summary) => [
  ...new Set([
    ...summary.capturedTags,
    ...identityRunTags({
      source: summary.source,
      sessionId: summary.sessionId,
      projectId: summary.projectId,
      lineage: summary.lineage,
    }),
  ]),
];

const RUN_TAG_VALUES: string[] = Object.values(RUN_TAGS);
/** Run tags a person removed from a session: they lift its exemption and are never stored. */
const liftedRunTags = async (db: Prisma.TransactionClient | PrismaClient, id: string) =>
  (
    await db.tagEdit.findMany({
      where: { archiveId: id, added: false, tag: { in: RUN_TAG_VALUES } },
      select: { tag: true },
    })
  ).map((edit) => edit.tag);
/** The snapshot without the run tags a person lifted, so a copy synced onward is not a run. */
const withoutLifted = (snapshot: ArchiveSnapshot, lifted: string[]) =>
  lifted.some((tag) => snapshot.tags.includes(tag))
    ? { ...snapshot, tags: snapshot.tags.filter((tag) => !lifted.includes(tag)) }
    : snapshot;

type ArchiveRow = {
  id: string;
  revision: number;
  digest: string;
  summary: Prisma.JsonValue;
  tagEdits: { tag: string; added: boolean }[];
  suggestion: { digest: string; by: string; tags: string[] } | null;
  partOf?: string | null;
  routedTo?: string[];
};
/**
 * Tags are the base tags with this archive's edits applied. Suggestions are the tagger's, minus
 * what a person applied or removed: their edits always win.
 */
const listing = (row: ArchiveRow, filter: ArchiveFilter) => {
  const { capturedTags: _, session: __, ...summary } = row.summary as Summary;
  // Suggestions describe one digest; once the session moves on they no longer apply.
  const suggestion = row.suggestion?.digest === row.digest ? row.suggestion : null;
  const removed = new Set(row.tagEdits.filter((e) => !e.added).map((e) => e.tag));
  const tags = [
    ...new Set([
      ...baseTags(row.summary as Summary),
      ...row.tagEdits.filter((e) => e.added).map((e) => e.tag),
    ]),
  ].filter((tag) => !removed.has(tag));
  const suggestedTags = [...new Set(suggestion?.tags)]
    .filter((tag) => !tags.includes(tag) && !removed.has(tag))
    .map((tag) => ({ tag, origin: 'model' as const }));
  const { reference, model, effort } = filter;
  if (
    (filter.tag && !tags.includes(filter.tag)) ||
    (filter.exempt !== 'include' && Boolean(exemptRun(tags)) !== (filter.exempt === 'only')) ||
    (filter.suggestedTag && !suggestedTags.some((s) => s.tag === filter.suggestedTag)) ||
    (model && !summary.models.some((m) => m.model === model)) ||
    (effort && !summary.models.some((m) => m.effort === effort && (!model || m.model === model))) ||
    (reference &&
      !summary.references.some(
        (r) => r.integration === reference.integration && r.ref === reference.ref,
      ))
  )
    return [];
  return [
    {
      id: row.id,
      revision: row.revision,
      digest: row.digest,
      ...summary,
      tags,
      suggestedTags,
      /** The session a part was cut from, and the organizations it publishes to. */
      partOf: row.partOf ?? null,
      routedTo: row.routedTo ?? [],
    },
  ];
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
  /**
   * Stores a snapshot as the next revision and compacts the one it replaces. `digest` is the
   * snapshot as its writer sent it, so a writer's unchanged session stays unchanged; the stored
   * snapshot (and `storedDigest`) leave out tool activity when the setting says so.
   */
  async capture(input: unknown, options: CaptureOptions = {}) {
    const incoming = archiveSnapshotSchema.parse(input);
    const id = archiveKey(incoming);
    const digest = snapshotDigest(incoming);
    const expected =
      options.previousDigest === undefined ? undefined : { previousDigest: options.previousDigest };
    return this.db.$transaction(
      async (tx) => {
        // Serializes concurrent captures of one session.
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        // A settings change waits for captures in flight, so the sweep it queues sees them all.
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(${SETTINGS_LOCK})`;
        const settings = await this.settings(tx);
        const lifted = await liftedRunTags(tx, id);
        const unlifted = withoutLifted(incoming, lifted);
        // Only explicit stamps drop; a run tag a person removed keeps the session.
        const run = settings.captureRunSessions ? undefined : droppableRun(unlifted);
        if (run && !lifted.includes(RUN_TAGS[run])) {
          // The digest is the writer's, so a syncing Archive records the delivery and moves on.
          await tx.archive.deleteMany({ where: { id } });
          return { id, digest, revision: 0, changed: false, dropped: RUN_TAGS[run] };
        }
        const old = await tx.archive.findUnique({ where: { id } });
        const map = await this.projectMap(tx);
        // Evidence comes from the snapshot as its writer sent it, before the strip drops tool calls.
        const evidenceOf = (kept: ArchiveSnapshot) =>
          map
            ? sessionEvidence(unlifted, new Set(kept.entries.map((e) => e.id)), map, options.cwd)
            : null;
        const evidenceFields = (evidence: SessionEvidence | null) => ({
          evidence: (evidence ?? undefined) as Prisma.InputJsonValue | undefined,
          evidenceKey: evidence?.key ?? null,
        });
        const stale = (row: { evidenceKey: string | null }) =>
          map !== undefined && row.evidenceKey !== projectMapKey(map);
        const stripOf = () =>
          settings.captureToolCallsAndResults
            ? { snapshot: unlifted, changed: 0 }
            : withoutToolActivity(unlifted, settings.integrations);
        if (old?.digest === digest) {
          // The same session under a new project map: only its evidence is recomputed.
          if (stale(old))
            await tx.archive.update({
              where: { id },
              data: evidenceFields(evidenceOf(stripOf().snapshot)),
            });
          return { id, digest, revision: old.revision, changed: false };
        }
        // A session deleted here stays deleted while its transcript is unchanged, however a
        // collector tags it; the tombstone takes the writer's digest so `head` matches it.
        const transcript = transcriptDigest(incoming);
        const tombstone = old ? null : await tx.archiveTombstone.findUnique({ where: { id } });
        if (
          tombstone &&
          !options.restore &&
          (tombstone.digest === digest || tombstone.transcriptDigest === transcript)
        ) {
          if (tombstone.digest !== digest)
            await tx.archiveTombstone.update({ where: { id }, data: { digest } });
          return { id, digest, revision: 0, changed: false };
        }
        // Only a tombstone is held: there is no revision to conflict with, whatever the writer
        // last saw (a destination whose receipts were reset sends none).
        if (expected && !tombstone && (old?.digest ?? null) !== expected.previousDigest)
          throw new ArchiveConflict('Revision conflict');
        if (old && old.capturedAt > incoming.capturedAt) throw new ArchiveConflict('Stale capture');
        if (tombstone) await tx.archiveTombstone.delete({ where: { id } });
        const stripped = stripOf();
        const { snapshot } = stripped;
        const changed = stripped.changed || unlifted !== incoming;
        const storedDigest = changed ? snapshotDigest(snapshot) : digest;
        // The writer changed only what this Archive drops: what it holds stays as it is.
        if (old?.storedDigest === storedDigest) {
          await tx.archive.update({
            where: { id },
            data: {
              digest,
              transcriptDigest: transcript,
              capturedAt: snapshot.capturedAt,
              ...evidenceFields(evidenceOf(snapshot)),
            },
          });
          return { id, digest, revision: old.revision, changed: false };
        }
        const revision = (old?.revision ?? 0) + 1;
        // A raw capture landing after its driver fulfilled the claim is superseded at once.
        const claim = (CLAIM_SOURCES as readonly string[]).includes(snapshot.source)
          ? await this.claimFor(tx, snapshot.source, snapshot.sessionId)
          : null;
        const supersededBy =
          claim?.fulfilledBy && claim.fulfilledBy !== id
            ? claim.fulfilledBy
            : (old?.supersededBy ?? null);
        const fields = {
          supersededBy,
          digest,
          transcriptDigest: transcript,
          storedDigest,
          revision,
          source: snapshot.source,
          projectId: snapshot.projectId ?? null,
          actorId: snapshot.actor?.id ?? null,
          provider: snapshot.runtime?.provider ?? null,
          accessPath: snapshot.runtime?.accessPath ?? null,
          capturedAt: snapshot.capturedAt,
          summary: summarize(snapshot, settings) as Prisma.InputJsonValue,
          ...evidenceFields(evidenceOf(snapshot)),
        };
        await tx.archive.upsert({ where: { id }, create: { id, ...fields }, update: fields });
        // A superseded session's parts are superseded with it, so they never publish.
        if (supersededBy && supersededBy !== old?.supersededBy)
          await tx.archive.updateMany({ where: { partOf: id }, data: { supersededBy } });
        await tx.revision.create({
          data: {
            archiveId: id,
            revision,
            digest: storedDigest,
            snapshot: snapshot as Prisma.InputJsonValue,
          },
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
        if (old) await dropRevision(tx, id, old.revision);
        return { id, digest, revision, changed: true };
        // A 64 MB session writes tens of thousands of chunks.
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }
  /**
   * Current digest and revision without the content. A session deleted here answers with its
   * tombstone (`deleted`, revision 0), so a collector sees its unchanged source as unchanged.
   */
  async head(id: string) {
    const row = await this.db.archive.findUnique({
      where: { id },
      select: {
        id: true,
        digest: true,
        storedDigest: true,
        revision: true,
        projectId: true,
        supersededBy: true,
        evidenceKey: true,
      },
    });
    if (row) return row;
    const tombstone = await this.db.archiveTombstone.findUnique({ where: { id } });
    return tombstone
      ? {
          id,
          digest: tombstone.digest,
          storedDigest: tombstone.digest,
          revision: 0,
          projectId: tombstone.projectId,
          supersededBy: null,
          evidenceKey: null,
          deleted: true as const,
        }
      : undefined;
  }
  /**
   * The current revision, or an earlier one still waiting to be delivered. Other earlier revisions
   * are compacted away: asking for one throws `RevisionCompacted`.
   */
  async read(id: string, revision?: number) {
    const archive = await this.db.archive.findUnique({ where: { id } });
    if (!archive) return undefined;
    const row = await this.db.revision.findUnique({
      where: { archiveId_revision: { archiveId: id, revision: revision ?? archive.revision } },
      include: { chunks: { orderBy: { position: 'asc' } } },
    });
    if (!row) {
      if (revision !== undefined && revision < archive.revision)
        throw new RevisionCompacted(
          `Revision ${revision} was compacted; this Archive keeps revision ${archive.revision}`,
        );
      return undefined;
    }
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
  /** One archive's listing (tags with this archive's edits applied), exempt or not. */
  async listing(id: string) {
    const row = await this.db.archive.findUnique({
      where: { id },
      include: { tagEdits: true, suggestion: { select: { digest: true, by: true, tags: true } } },
    });
    return row ? listing(row, { exempt: 'include' })[0] : undefined;
  }
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
          ...(filter.provider ? { provider: filter.provider } : {}),
          ...(filter.accessPath ? { accessPath: filter.accessPath } : {}),
          ...(filter.parts === 'include'
            ? {}
            : filter.parts === 'only'
              ? { partOf: { not: null } }
              : { partOf: null }),
          ...(cursor === undefined ? {} : { seq: { lt: cursor } }),
        },
        include: { tagEdits: true, suggestion: { select: { digest: true, by: true, tags: true } } },
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
      await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
      const archive = await tx.archive.findUnique({ where: { id } });
      if (!archive) throw new Error('Archive unavailable');
      const captured = new Set(baseTags(archive.summary as Summary));
      const set = (tag: string, added: boolean) =>
        tx.tagEdit.upsert({
          where: { archiveId_tag: { archiveId: id, tag } },
          create: { archiveId: id, tag, added },
          update: { added },
        });
      const clear = (tag: string) => tx.tagEdit.deleteMany({ where: { archiveId: id, tag } });
      for (const tag of add) await (captured.has(tag) ? clear(tag) : set(tag, true));
      // A removal is kept even for a tag the session lacks, so a later capture or suggestion of it stays removed.
      for (const tag of remove) await set(tag, false);
      // A lifted run tag leaves the stored copy too, so what syncs onward is not a run.
      if (remove.some((tag) => RUN_TAG_VALUES.includes(tag))) await this.storeLifted(tx, id);
      const edits = await tx.tagEdit.findMany({ where: { archiveId: id } });
      const removed = new Set(edits.filter((e) => !e.added).map((e) => e.tag));
      const tags = [
        ...new Set([...captured, ...edits.filter((e) => e.added).map((e) => e.tag)]),
      ].filter((tag) => !removed.has(tag));
      z.array(tagSchema).max(100, 'An archive holds at most 100 tags').parse(tags);
      return { id, tags };
    });
  }
  /**
   * Stores the current revision again without the run tags a person lifted: one new revision with
   * its chunks copied, the old one compacted, and the listing recomputed. Nothing when none is held.
   */
  private async storeLifted(tx: Prisma.TransactionClient, id: string) {
    const archive = await tx.archive.findUnique({ where: { id } });
    if (!archive) return;
    const current = await tx.revision.findUnique({
      where: { archiveId_revision: { archiveId: id, revision: archive.revision } },
      select: { snapshot: true },
    });
    if (!current) return;
    const stored = archiveSnapshotSchema.parse(current.snapshot);
    const snapshot = withoutLifted(stored, await liftedRunTags(tx, id));
    if (snapshot === stored) return;
    const revision = archive.revision + 1;
    const storedDigest = snapshotDigest(snapshot);
    await tx.revision.create({
      data: {
        archiveId: id,
        revision,
        digest: storedDigest,
        snapshot: snapshot as Prisma.InputJsonValue,
      },
    });
    await tx.$executeRaw`
      INSERT INTO "chunks" ("archiveId", "revision", "position", "id", "entryId", "sourceRef",
        "kind", "start", "end", "text", "tokenCount", "embedding")
      SELECT "archiveId", ${revision}, "position", "id", "entryId", "sourceRef", "kind", "start",
        "end", "text", "tokenCount", "embedding"
      FROM "chunks" WHERE "archiveId" = ${id} AND "revision" = ${archive.revision}`;
    await tx.archive.update({
      where: { id },
      data: {
        revision,
        storedDigest,
        summary: summarize(snapshot, await this.settings(tx)) as Prisma.InputJsonValue,
      },
    });
    await dropRevision(tx, id, archive.revision);
  }
  /**
   * Claim native sessions for a writer that records them itself, for `ttlMs` from now; holding
   * again renews the lease and reopens a fulfilled claim (the session is the writer's again until
   * it fulfils). Another claimant's live lease is not taken over.
   */
  async claim(input: {
    claimant: string;
    ttlMs: number;
    sessions: Array<{ source: ClaimSource; sessionId: string }>;
  }) {
    const now = Date.now();
    const expiresAt = new Date(now + input.ttlMs);
    await this.db.$transaction(async (tx) => {
      for (const { source, sessionId } of input.sessions) {
        const held = await tx.claim.findUnique({
          where: { source_sessionId: { source, sessionId } },
        });
        if (
          held &&
          held.claimant !== input.claimant &&
          held.expiresAt.getTime() > now &&
          !held.fulfilledBy
        )
          throw new ClaimHeld(`${source} session ${sessionId} is claimed by another writer`);
        const fields = {
          claimant: input.claimant,
          expiresAt,
          fulfilledBy: null,
          fulfilledAt: null,
        };
        await tx.claim.upsert({
          where: { source_sessionId: { source, sessionId } },
          create: { source, sessionId, ...fields },
          update: fields,
        });
      }
    });
    return { expiresAt: expiresAt.getTime() };
  }
  /**
   * The claimant stored its own version (`archiveId`, an archive in this store) of a claimed
   * session: the claim is fulfilled as of now, and a raw capture of the session (or its Claude
   * subagent transcripts) made while the claim had lapsed is marked superseded: kept, never
   * delivered onward. Null when the session is unclaimed.
   */
  async fulfil(input: {
    claimant: string;
    source: ClaimSource;
    sessionId: string;
    archiveId: string;
  }) {
    const sourceId = await this.sourceId();
    return this.db.$transaction(async (tx) => {
      const claim = await tx.claim.findUnique({
        where: { source_sessionId: { source: input.source, sessionId: input.sessionId } },
      });
      if (!claim) return null;
      if (claim.claimant !== input.claimant)
        throw new ClaimHeld(
          `${input.source} session ${input.sessionId} is claimed by another writer`,
        );
      if (!(await tx.archive.findUnique({ where: { id: input.archiveId }, select: { id: true } })))
        throw new Error('Archive unavailable');
      await tx.claim.update({
        where: { source_sessionId: { source: input.source, sessionId: input.sessionId } },
        data: { fulfilledBy: input.archiveId, fulfilledAt: new Date() },
      });
      const raw = await tx.archive.findMany({
        where: {
          source: input.source,
          id: { not: input.archiveId },
          AND: [
            { summary: { path: ['sourceId'], equals: sourceId } },
            {
              OR: [
                { summary: { path: ['sessionId'], equals: input.sessionId } },
                { summary: { path: ['sessionId'], string_starts_with: `${input.sessionId}/` } },
              ],
            },
          ],
        },
        select: { id: true },
      });
      await tx.archive.updateMany({
        where: {
          OR: [{ id: { in: raw.map((a) => a.id) } }, { partOf: { in: raw.map((a) => a.id) } }],
        },
        data: { supersededBy: input.archiveId },
      });
      return { fulfilledBy: input.archiveId, superseded: raw.map((a) => a.id) };
    });
  }
  /**
   * Whether the collector should leave a native session (modified at `modifiedAt`) to its
   * claimant:
   * - `live`: its lease is running, until `until`;
   * - `fulfilled`: the claimant stored it, and the transcript has not changed since;
   * - `lapsed`: the lease ran out, or the transcript changed after the claim was fulfilled, so it is
   *   captured raw;
   * - `none`: nobody claimed it.
   *
   * A Claude subagent transcript (`<session>/agent-<id>`) follows its session's claim unless it has
   * its own. Codex sub-agent threads are their own sessions: their driver claims each one.
   */
  async claimState(
    source: string,
    sessionId: string,
    modifiedAt?: number,
  ): Promise<{ state: ClaimState; until?: number }> {
    const claim = await this.claimFor(this.db, source, sessionId);
    if (!claim) return { state: 'none' };
    const until = claim.expiresAt.getTime();
    if (until > Date.now()) return { state: 'live', until };
    if (
      claim.fulfilledBy &&
      claim.fulfilledAt &&
      (modifiedAt === undefined || modifiedAt <= claim.fulfilledAt.getTime() + 1_000)
    )
      return { state: 'fulfilled' };
    return { state: 'lapsed' };
  }
  private claimFor(db: Prisma.TransactionClient | PrismaClient, source: string, sessionId: string) {
    const root = sessionId.split('/')[0]!;
    return db.claim.findFirst({
      where: { source, sessionId: { in: [...new Set([sessionId, root])] } },
      orderBy: { sessionId: 'desc' },
    });
  }
  /**
   * Makes a session's parts what its plan says: each part stored as its own row (`partOf` the
   * session, routed to its organizations, superseded with the session), and each part the plan
   * no longer has retired: deleted here, or, while a destination still holds it, kept routed
   * nowhere until sync deletes it there (`forgetDelivery`). Returns the part ids kept and retired.
   */
  async applyParts(
    archiveId: string,
    parts: { snapshot: ArchiveSnapshot; organizations: string[] }[],
  ) {
    const source = await this.db.archive.findUnique({
      where: { id: archiveId },
      select: { supersededBy: true, partOf: true },
    });
    if (!source || source.partOf) throw new Error('Archive unavailable');
    const kept: string[] = [];
    for (const part of parts) {
      // A part re-added after a re-plan dropped it is meant: its tombstone, if any, is lifted.
      const { id } = await this.capture(part.snapshot, { restore: true });
      await this.db.archive.update({
        where: { id },
        data: {
          partOf: archiveId,
          routedTo: [...new Set(part.organizations)].sort(),
          supersededBy: source.supersededBy,
        },
      });
      kept.push(id);
    }
    const retired = await this.db.archive.findMany({
      where: { partOf: archiveId, id: { notIn: kept } },
      select: { id: true, receipts: { select: { destination: true } } },
    });
    for (const part of retired)
      if (part.receipts.length)
        await this.db.archive.update({ where: { id: part.id }, data: { routedTo: [] } });
      else await this.db.archive.deleteMany({ where: { id: part.id } });
    return { kept, retired: retired.map((r) => r.id) };
  }
  /**
   * A destination no longer holds this archive (sync deleted it there): its receipt and queued
   * revision go, and a retired part no destination holds any more is deleted here.
   */
  async forgetDelivery(id: string, destination: string) {
    await this.db.$transaction([
      this.db.receipt.deleteMany({ where: { archiveId: id, destination } }),
      this.db.outbox.deleteMany({ where: { archiveId: id, destination } }),
    ]);
    await this.db.archive.deleteMany({
      where: { id, partOf: { not: null }, routedTo: { isEmpty: true }, receipts: { none: {} } },
    });
  }
  /** Every receipt: which destinations hold which archives, with what routing those rows now have. */
  async deliveries() {
    return this.db.receipt.findMany({
      select: {
        archiveId: true,
        destination: true,
        archive: {
          select: {
            partOf: true,
            routedTo: true,
            supersededBy: true,
            routingPlan: { select: { plan: true } },
          },
        },
      },
    });
  }
  /** Deletes a session and leaves its tombstone (`head`), so it is not imported again unchanged. */
  async delete(id: string) {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
      const archive = await tx.archive.findUnique({
        where: { id },
        select: { digest: true, transcriptDigest: true, projectId: true },
      });
      if (!archive) return false;
      const tombstone = {
        digest: archive.digest,
        transcriptDigest: archive.transcriptDigest,
        projectId: archive.projectId,
      };
      await tx.archiveTombstone.upsert({
        where: { id },
        create: { id, ...tombstone },
        update: { ...tombstone, deletedAt: new Date() },
      });
      await tx.archive.delete({ where: { id } });
      return true;
    });
  }
  /** Applies the retention setting; returns the deleted archive ids. */
  async prune(now = Date.now()) {
    const { retentionDays } = await this.settings();
    if (retentionDays === null) return [];
    const expired = await this.db.archive.findMany({
      // A part goes with its session.
      where: { capturedAt: { lt: now - retentionDays * 86_400_000 }, partOf: null },
      select: { id: true },
    });
    const deleted: string[] = [];
    for (const { id } of expired) if (await this.delete(id)) deleted.push(id);
    return deleted;
  }
  /**
   * Deletes every revision but the current one, keeping any an outbox row still names until it is
   * delivered. A growing session's earlier revisions are prefixes of its current one. One revision
   * per statement (its chunks cascade), so no transaction holds a large delete. Outbox rows of
   * superseded archives, which are never delivered, are released first. Stops between statements
   * once `stop()` is called; returns how many went.
   */
  async compact() {
    await this.db.outbox.deleteMany({ where: { archive: { supersededBy: { not: null } } } });
    let removed = 0;
    while (!this.stopping) {
      const rows = await this.db.$queryRaw<{ archiveId: string; revision: number }[]>`
        SELECT r."archiveId", r."revision" FROM "revisions" r
        JOIN "archives" a ON a."id" = r."archiveId"
        WHERE r."revision" < a."revision"
          AND NOT EXISTS (SELECT 1 FROM "outbox" o
            WHERE o."archiveId" = r."archiveId" AND o."revision" = r."revision")
        LIMIT ${COMPACTION_BATCH}`;
      let batch = 0;
      for (const row of rows) {
        if (this.stopping) break;
        batch += await dropRevision(this.db, row.archiveId, row.revision);
      }
      removed += batch;
      if (rows.length < COMPACTION_BATCH || !batch) break;
    }
    return removed;
  }
  /**
   * Releases outbox rows no configured destination will deliver (a removed route), so the
   * revisions they hold can be compacted. `destinations` are the configured identities.
   */
  async releaseOutbox(destinations: string[]) {
    // An empty list is more likely a destinations file that failed to read than no routes at all.
    if (!destinations.length) return 0;
    return (await this.db.outbox.deleteMany({ where: { destination: { notIn: destinations } } }))
      .count;
  }
  private async sweepState() {
    const row = await this.db.setting.findUnique({ where: { key: TOOL_ACTIVITY_SWEEP } });
    return row ? toolActivitySweepSchema.parse(row.value) : undefined;
  }
  /**
   * While `captureToolCallsAndResults` is off, removes the tool activity this Archive took in while
   * it was on: each affected archive gets a new revision without it and the old one is compacted. Resumes where it stopped. An archive that fails is
   * logged, recorded and passed over, and retried on the next run; it never holds up the rest.
   * Returns the archives changed.
   */
  async removePastToolActivity() {
    let changed = 0;
    let retried = false;
    while (!this.stopping) {
      const state = await this.sweepState();
      if (!state) return changed;
      const settings = await this.settings();
      if (settings.captureToolCallsAndResults) {
        await this.db.setting.deleteMany({ where: { key: TOOL_ACTIVITY_SWEEP } });
        return changed;
      }
      const failed = new Set<string>();
      const attempt = async (id: string) => {
        try {
          if (await this.stripToolActivity(id, settings)) changed++;
        } catch (error) {
          failed.add(id);
          console.error(
            JSON.stringify({
              maintenance: 'tool activity removal failed',
              archiveId: id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      };
      if (!retried) {
        retried = true;
        for (const id of state.failed) await attempt(id);
      } else for (const id of state.failed) failed.add(id);
      let { afterSeq, finished } = state;
      if (!finished) {
        const page = await this.db.$queryRaw<{ id: string; seq: bigint; tools: boolean }[]>`
          SELECT a."id", a."seq", jsonb_path_exists(r."snapshot",
            '$.entries[*] ? (@.kind == "tool-call" || @.kind == "tool-result")') AS "tools"
          FROM "archives" a
          JOIN "revisions" r ON r."archiveId" = a."id" AND r."revision" = a."revision"
          WHERE a."seq" > ${BigInt(afterSeq)}
          ORDER BY a."seq" LIMIT ${TOOL_ACTIVITY_BATCH}`;
        finished = page.length < TOOL_ACTIVITY_BATCH;
        for (const archive of page) {
          if (this.stopping) {
            finished = false;
            break;
          }
          if (archive.tools) await attempt(archive.id);
          afterSeq = archive.seq.toString();
        }
      }
      if (finished && !failed.size) {
        await this.db.setting.deleteMany({ where: { key: TOOL_ACTIVITY_SWEEP } });
        return changed;
      }
      await this.db.setting.updateMany({
        where: { key: TOOL_ACTIVITY_SWEEP },
        data: { value: { afterSeq, finished, failed: [...failed] } },
      });
      // Only failures are left: they wait for the next run.
      if (finished) return changed;
    }
    return changed;
  }
  /**
   * While `captureRunSessions` is off, deletes the run sessions this Archive took in while it was
   * on: explicitly stamped (not `run:inferred`), a Foundry subagent type, or tagged a run by a
   * person; a session whose run tag a person removed stays. One page of archives at a
   * time, one archive per statement, resuming where it stopped. Returns the archives deleted.
   */
  async removeRunSessions() {
    let removed = 0;
    while (!this.stopping) {
      const row = await this.db.setting.findUnique({ where: { key: RUN_SESSION_SWEEP } });
      if (!row) return removed;
      if ((await this.settings()).captureRunSessions) {
        await this.db.setting.deleteMany({ where: { key: RUN_SESSION_SWEEP } });
        return removed;
      }
      const { afterSeq } = runSessionSweepSchema.parse(row.value);
      const page = await this.db.archive.findMany({
        where: { seq: { gt: BigInt(afterSeq) } },
        orderBy: { seq: 'asc' },
        take: RUN_SESSION_BATCH,
        select: {
          id: true,
          seq: true,
          revision: true,
          digest: true,
          summary: true,
          tagEdits: { select: { tag: true, added: true } },
          suggestion: { select: { digest: true, by: true, tags: true } },
        },
      });
      let reached = afterSeq;
      let finished = page.length < RUN_SESSION_BATCH;
      for (const archive of page) {
        if (this.stopping) {
          finished = false;
          break;
        }
        const summary = archive.summary as Summary;
        const run =
          droppableRun({ tags: summary.capturedTags, lineage: summary.lineage }) ??
          exemptRun(archive.tagEdits.filter((e) => e.added).map((e) => e.tag));
        if (run && listing(archive, { exempt: 'only' }).length)
          // One statement: a session lifted, or moved on by a capture, meanwhile is left alone.
          removed += await this.db.$executeRaw`
            DELETE FROM "archives" a WHERE a."id" = ${archive.id} AND a."digest" = ${archive.digest}
              AND NOT EXISTS (SELECT 1 FROM "tag_edits" t WHERE t."archiveId" = a."id"
                AND t."added" = false AND t."tag" = ANY(${RUN_TAG_VALUES}))`;
        reached = archive.seq.toString();
      }
      if (finished) {
        await this.db.setting.deleteMany({ where: { key: RUN_SESSION_SWEEP } });
        return removed;
      }
      await this.db.setting.updateMany({
        where: { key: RUN_SESSION_SWEEP },
        data: { value: { afterSeq: reached } },
      });
    }
    return removed;
  }
  private stripToolActivity(id: string, settings: ArchiveSettings) {
    return this.db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        const archive = await tx.archive.findUnique({ where: { id } });
        if (!archive) return false;
        const current = await tx.revision.findUnique({
          where: { archiveId_revision: { archiveId: id, revision: archive.revision } },
          select: { snapshot: true },
        });
        if (!current) return false;
        const { snapshot, changed } = withoutToolActivity(
          archiveSnapshotSchema.parse(current.snapshot),
          settings.integrations,
        );
        if (!changed) return false;
        const revision = archive.revision + 1;
        const storedDigest = snapshotDigest(snapshot);
        await tx.revision.create({
          data: {
            archiveId: id,
            revision,
            digest: storedDigest,
            snapshot: snapshot as Prisma.InputJsonValue,
          },
        });
        // What is left is a small share of the text (no tool output), so it is chunked afresh.
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
        await tx.archive.update({
          where: { id },
          data: {
            revision,
            storedDigest,
            summary: summarize(snapshot, settings) as Prisma.InputJsonValue,
          },
        });
        await dropRevision(tx, id, archive.revision);
        return true;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  }
  private maintaining?: Promise<void>;
  private stopping = false;
  /**
   * Retention, compaction, deletion of run sessions and removal of past tool activity (each
   * while its setting is off), then the search index restored if it was
   * dropped. One run at a time (a call during a run joins it), and none while a reclaim runs.
   */
  maintain(now = Date.now()) {
    if (this.reclaiming.state === 'running') return Promise.resolve();
    this.maintaining ??= (async () => {
      try {
        await this.prune(now);
        await this.compact();
        await this.removeRunSessions();
        await this.removePastToolActivity();
        if (!this.stopping) await this.ensureSearchIndex();
      } finally {
        this.maintaining = undefined;
      }
    })();
    return this.maintaining;
  }
  /** Stops maintenance after the statement in progress; resolves once it has stopped. */
  async stop() {
    this.stopping = true;
    await this.maintaining;
  }
  /**
   * Recreates the trigram index search uses when it is missing or invalid, once compaction and the
   * tool-activity sweep have nothing left (or when `force`d, at the end of a reclaim), so it is built
   * over current rows only. An operator short of disk may drop it before compaction; `reclaim`
   * drops it too. Built concurrently: writes go on. A build already in progress (an invalid index
   * being built) is left alone. Returns whether it built one.
   */
  async ensureSearchIndex(force = false) {
    const [index] = await this.db.$queryRaw<{ valid: boolean; building: boolean }[]>`
      SELECT i."indisvalid" AS "valid",
        -- index_relid is 0 until a build reaches its later phases; the table is known throughout.
        EXISTS (SELECT 1 FROM pg_stat_progress_create_index p WHERE p."relid" = i."indrelid")
          AS "building"
      FROM pg_index i JOIN pg_class c ON c."oid" = i."indexrelid"
      WHERE c."relname" = ${SEARCH_INDEX} AND c."relnamespace" = current_schema()::regnamespace`;
    if (index?.valid || index?.building) return false;
    if (!force) {
      const status = await this.maintenanceStatus();
      if (status.supersededRevisions || status.toolActivitySweepPending) return false;
    }
    // An interrupted concurrent build leaves an invalid index behind.
    if (index)
      await this.db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${SEARCH_INDEX}"`);
    await this.db.$executeRawUnsafe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${SEARCH_INDEX}" ON "chunks" USING GIN ("text" gin_trgm_ops)`,
    );
    return true;
  }
  /** What maintenance has left and what the tables hold, for deciding when to reclaim space. */
  async maintenanceStatus() {
    const [superseded] = await this.db.$queryRaw<{ compactable: bigint; held: bigint }[]>`
      SELECT
        count(*) FILTER (WHERE o."archiveId" IS NULL) AS "compactable",
        count(*) FILTER (WHERE o."archiveId" IS NOT NULL) AS "held"
      FROM "revisions" r JOIN "archives" a ON a."id" = r."archiveId"
      LEFT JOIN LATERAL (SELECT o."archiveId" FROM "outbox" o
        WHERE o."archiveId" = r."archiveId" AND o."revision" = r."revision" LIMIT 1) o ON true
      WHERE r."revision" < a."revision"`;
    const tables = await this.db.$queryRaw<
      { table: string; totalBytes: bigint; liveRows: bigint; deadRows: bigint }[]
    >`
      SELECT c."relname"::text AS "table", pg_total_relation_size(c."oid") AS "totalBytes",
        coalesce(s."n_live_tup", 0) AS "liveRows", coalesce(s."n_dead_tup", 0) AS "deadRows"
      FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s."relid" = c."oid"
      WHERE c."relname" IN ('archives', 'revisions', 'chunks') AND c."relkind" = 'r'
        AND c."relnamespace" = current_schema()::regnamespace
      ORDER BY c."relname"`;
    const [database] = await this.db.$queryRaw<{ bytes: bigint }[]>`
      SELECT pg_database_size(current_database()) AS "bytes"`;
    const sweep = await this.sweepState();
    const runSessionSweep = await this.db.setting.findUnique({ where: { key: RUN_SESSION_SWEEP } });
    return {
      databaseBytes: Number(database!.bytes),
      /** Earlier revisions compaction will delete. */
      supersededRevisions: Number(superseded!.compactable),
      /** Earlier revisions kept until a destination acknowledges them. */
      revisionsAwaitingDelivery: Number(superseded!.held),
      /** Archives the tool-activity sweep has yet to reach. */
      toolActivitySweepPending: Boolean(sweep && !sweep.finished),
      /** Archives whose tool activity could not be removed; retried on each run. */
      toolActivitySweepFailures: sweep?.failed ?? [],
      /** Run sessions the deletion sweep has yet to reach (`captureRunSessions` off). */
      runSessionSweepPending: Boolean(runSessionSweep),
      reclaim: this.reclaiming,
      tables: tables.map((t) => ({
        table: t.table,
        totalBytes: Number(t.totalBytes),
        liveRows: Number(t.liveRows),
        deadRows: Number(t.deadRows),
      })),
    };
  }
  /**
   * Returns the space compaction freed to the operating system. The search index is dropped first,
   * so VACUUM FULL copies only live rows without rebuilding a large GIN index under its exclusive
   * lock; the index is always rebuilt at the end, concurrently, over current rows. Needs free disk
   * for the copied live rows (`maintenanceStatus`). Refused while maintenance runs or has work left.
   */
  async reclaim() {
    if (this.maintaining || this.reclaiming.state === 'running')
      throw new MaintenancePending('Maintenance or a reclaim is running; try again when it ends');
    // Claimed before the first await, so a maintenance run starting meanwhile sees it.
    const idle = this.reclaiming;
    const startedAt = Date.now();
    this.reclaiming = { state: 'running', startedAt };
    const before = await this.maintenanceStatus().catch((error) => {
      this.reclaiming = idle;
      throw error;
    });
    if (
      before.supersededRevisions ||
      before.toolActivitySweepPending ||
      before.runSessionSweepPending
    ) {
      this.reclaiming = idle;
      throw new MaintenancePending(
        'Compaction, run-session deletion or tool-activity removal is still running; reclaim once maintenance finishes',
      );
    }
    const finish = (outcome: { afterBytes?: number; error?: string }) => {
      this.reclaiming = {
        state: 'idle',
        last: { startedAt, finishedAt: Date.now(), beforeBytes: before.databaseBytes, ...outcome },
      };
    };
    void this.rewrite()
      .then(async () => finish({ afterBytes: (await this.maintenanceStatus()).databaseBytes }))
      .catch((error) => finish({ error: error instanceof Error ? error.message : String(error) }));
    return { started: true, beforeBytes: before.databaseBytes };
  }
  /** Reclaim's state in this process: running, or idle with the last run's outcome. */
  reclaiming: {
    state: 'running' | 'idle';
    startedAt?: number;
    last?: {
      startedAt: number;
      finishedAt: number;
      beforeBytes: number;
      afterBytes?: number;
      error?: string;
    };
  } = { state: 'idle' };
  private async rewrite() {
    try {
      await this.db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${SEARCH_INDEX}"`);
      for (const table of ['revisions', 'chunks'])
        await this.db.$executeRawUnsafe(`VACUUM (FULL, ANALYZE) "${table}"`);
    } finally {
      await this.ensureSearchIndex(true);
    }
  }
  /** The host's project map, which evidence is computed under; undefined until a host sends one. */
  async projectMap(db: Prisma.TransactionClient | PrismaClient = this.db) {
    const row = await db.setting.findUnique({ where: { key: PROJECT_MAP } });
    return row ? projectMapSchema.parse(row.value) : undefined;
  }
  async projectMapKey() {
    const map = await this.projectMap();
    return map ? projectMapKey(map) : null;
  }
  /** Saves the host's project map; captures from then on compute evidence under it. */
  async setProjectMap(input: ProjectMap) {
    const map = projectMapSchema.parse(input);
    await this.db.setting.upsert({
      where: { key: PROJECT_MAP },
      create: { key: PROJECT_MAP, value: map },
      update: { value: map },
    });
    return { key: projectMapKey(map) };
  }
  async settings(db: Prisma.TransactionClient | PrismaClient = this.db): Promise<ArchiveSettings> {
    const row = await db.setting.findUnique({ where: { key: 'archive' } });
    // A setting added after the row was saved takes its default.
    return row
      ? archiveSettingsSchema.parse({ ...defaultSettings, ...(row.value as object) })
      : defaultSettings;
  }
  /**
   * Saves settings. Listings are recomputed when the integrations change, since references follow
   * them. Turning `captureToolCallsAndResults` off queues removal of the tool activity already held;
   * turning `captureRunSessions` off queues deletion of the run sessions already held.
   */
  async updateSettings(change: Partial<ArchiveSettings>) {
    const { previous, next } = await this.db.$transaction(async (tx) => {
      // Waits for captures in flight (they hold it shared), so none lands after the sweep passed it.
      await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(${SETTINGS_LOCK})`;
      const previous = await this.settings(tx);
      const next = archiveSettingsSchema.parse({ ...previous, ...change });
      await tx.setting.upsert({
        where: { key: 'archive' },
        create: { key: 'archive', value: next },
        update: { value: next },
      });
      if (previous.captureToolCallsAndResults && !next.captureToolCallsAndResults)
        await tx.setting.upsert({
          where: { key: TOOL_ACTIVITY_SWEEP },
          create: { key: TOOL_ACTIVITY_SWEEP, value: { afterSeq: '0' } },
          update: { value: { afterSeq: '0' } },
        });
      if (next.captureToolCallsAndResults)
        await tx.setting.deleteMany({ where: { key: TOOL_ACTIVITY_SWEEP } });
      if (previous.captureRunSessions && !next.captureRunSessions)
        await tx.setting.upsert({
          where: { key: RUN_SESSION_SWEEP },
          create: { key: RUN_SESSION_SWEEP, value: { afterSeq: '0' } },
          update: { value: { afterSeq: '0' } },
        });
      if (next.captureRunSessions)
        await tx.setting.deleteMany({ where: { key: RUN_SESSION_SWEEP } });
      return { previous, next };
    });
    if (JSON.stringify(previous.integrations) === JSON.stringify(next.integrations)) return next;
    // After the lock is released, so captures go on. Captures from here on summarize with the new
    // integrations themselves; a row a capture moved on meanwhile is left to that capture.
    const archives = await this.db.archive.findMany({ select: { id: true, revision: true } });
    for (const archive of archives) {
      const row = await this.db.revision.findUnique({
        where: { archiveId_revision: { archiveId: archive.id, revision: archive.revision } },
        select: { snapshot: true },
      });
      if (!row) continue;
      await this.db.archive.updateMany({
        where: { id: archive.id, revision: archive.revision },
        data: {
          summary: summarize(
            archiveSnapshotSchema.parse(row.snapshot),
            next,
          ) as Prisma.InputJsonValue,
        },
      });
    }
    return next;
  }
  /** Offered tags with how many archives carry each; an actor sees archive-wide and their own. */
  async tagDefinitions(actorId?: string) {
    const rows = await this.db.tagDefinition.findMany({
      where: { actorId: { in: ['', actorId ?? ''] } },
      orderBy: { tag: 'asc' },
    });
    const archives = await this.list({ exempt: 'include', ...(actorId ? { actorId } : {}) });
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
  /** Forgets a pending revision compaction removed before anything was sent, so the current one is queued. */
  async dropPending(id: string, destination: string, revision: number) {
    await this.db.outbox.deleteMany({ where: { archiveId: id, destination, revision } });
  }
  async delivered(id: string, destination: string, digest: string) {
    const pending = await this.pending(id, destination);
    await this.db.$transaction([
      this.db.receipt.upsert({
        where: { archiveId_destination: { archiveId: id, destination } },
        create: { archiveId: id, destination, digest },
        update: { digest },
      }),
      this.db.outbox.deleteMany({ where: { archiveId: id, destination } }),
    ]);
    // The revision it held back is compacted unless another destination still waits on it.
    if (pending) await dropRevision(this.db, id, pending.revision);
  }
  /** These archives at one destination: delivered at their latest digest, or pending. */
  async delivery(archiveIds: string[], destination: string) {
    const archives = await this.db.archive.findMany({
      where: { id: { in: archiveIds }, supersededBy: null },
      select: {
        storedDigest: true,
        receipts: { where: { destination }, select: { digest: true } },
      },
    });
    const delivered = archives.filter((a) => a.receipts[0]?.digest === a.storedDigest).length;
    return { delivered, pending: archives.length - delivered };
  }
  /**
   * Sessions due for suggestions, newest first: not exempt, and without suggestions for their
   * current digest and this key (or every non-exempt one with `refresh`). Each comes as a bounded
   * digest, so the tagger never downloads transcripts. `projects` are the archive's routed projects.
   */
  async suggestionQueue(input: {
    key: string;
    limit: number;
    beforeId?: string;
    refresh?: boolean;
  }): Promise<
    { items: SuggestionDue[]; projects: string[]; nextCursor: string | null } | undefined
  > {
    let cursor: bigint | undefined;
    if (input.beforeId) {
      const before = await this.db.archive.findUnique({
        where: { id: input.beforeId },
        select: { seq: true },
      });
      if (!before) return undefined;
      cursor = before.seq;
    }
    const due: { id: string; revision: number; digest: string; summary: Prisma.JsonValue }[] = [];
    let nextCursor: string | null = null;
    scan: for (;;) {
      const rows = await this.db.archive.findMany({
        where: { partOf: null, ...(cursor === undefined ? {} : { seq: { lt: cursor } }) },
        include: { tagEdits: true, suggestion: true },
        orderBy: { seq: 'desc' },
        take: BATCH,
      });
      for (const row of rows) {
        const current = row.suggestion?.digest === row.digest && row.suggestion.key === input.key;
        if ((current && !input.refresh) || exemptRun(listing(row, { exempt: 'include' })[0]!.tags))
          continue;
        due.push(row);
        if (due.length >= input.limit) {
          nextCursor = row.id;
          break scan;
        }
      }
      if (rows.length < BATCH) break;
      cursor = rows.at(-1)!.seq;
    }
    const items: SuggestionDue[] = [];
    for (const archive of due) {
      let session = (archive.summary as Summary).session;
      if (!session) {
        // Captured before summaries carried the digest: computed once and stored.
        const row = await this.db.revision.findUnique({
          where: { archiveId_revision: { archiveId: archive.id, revision: archive.revision } },
          select: { snapshot: true },
        });
        if (!row) continue;
        session = sessionDigest(archiveSnapshotSchema.parse(row.snapshot));
        await this.db.archive.updateMany({
          where: { id: archive.id, digest: archive.digest },
          data: {
            summary: { ...(archive.summary as Summary), session } as Prisma.InputJsonValue,
          },
        });
      }
      items.push({ archiveId: archive.id, digest: archive.digest, session });
    }
    return { items, projects: await this.projects(), nextCursor };
  }
  /** Routed projects: every projectId but the catch-all's and Foundry's test fixture project. */
  private async projects() {
    const rows = await this.db.archive.findMany({
      where: { projectId: { notIn: [UNROUTED, 'P'] } },
      distinct: ['projectId'],
      select: { projectId: true },
      orderBy: { projectId: 'asc' },
    });
    return rows.flatMap((row) => (row.projectId ? [row.projectId] : []));
  }
  /**
   * Records the tagger's suggestions. One for a digest that is no longer current is stale; one for
   * an exempt session is refused. Tags this archive does not offer are dropped: archive-wide
   * definitions and `junk` are offered, and `project:<routed project>` only for a session that is
   * unrouted or has no project.
   */
  async recordSuggestions(results: SuggestionResult[], now = Date.now()) {
    const parsed = z
      .array(
        z.strictObject({
          archiveId: z.string().regex(/^[a-f0-9]{64}$/),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          key: z.string().min(1).max(128),
          by: z.string().min(1).max(200),
          tags: z.array(tagSchema).max(20),
        }),
      )
      .max(500)
      .parse(results);
    const offered = new Set([
      JUNK_TAG,
      ...(
        await this.db.tagDefinition.findMany({ where: { actorId: '' }, select: { tag: true } })
      ).map((d) => d.tag),
    ]);
    const projects = new Set(await this.projects());
    const outcome = { recorded: 0, stale: 0, refused: 0, dropped: 0 };
    for (const result of parsed) {
      const row = await this.db.archive.findUnique({
        where: { id: result.archiveId },
        include: { tagEdits: true, suggestion: true },
      });
      if (!row || row.digest !== result.digest) {
        outcome.stale++;
        continue;
      }
      if (row.partOf || exemptRun(listing(row, { exempt: 'include' })[0]!.tags)) {
        outcome.refused++;
        continue;
      }
      const weak = !row.projectId || row.projectId === UNROUTED;
      const tags = result.tags.filter(
        (tag) =>
          offered.has(tag) ||
          (weak &&
            tag.startsWith(PROJECT_TAG_PREFIX) &&
            projects.has(tag.slice(PROJECT_TAG_PREFIX.length))),
      );
      outcome.dropped += result.tags.length - tags.length;
      const fields = { digest: result.digest, key: result.key, by: result.by, tags, at: now };
      await this.db.suggestion.upsert({
        where: { archiveId: result.archiveId },
        create: { archiveId: result.archiveId, ...fields },
        update: fields,
      });
      outcome.recorded++;
    }
    return outcome;
  }
  /** A session as the planner reads it: its current revision without tool activity. */
  private async plannedSession(id: string) {
    const row = await this.db.archive.findUnique({
      where: { id },
      include: { tagEdits: true, routingPlan: true },
    });
    if (!row || row.partOf) return undefined;
    const revision = await this.db.revision.findUnique({
      where: { archiveId_revision: { archiveId: id, revision: row.revision } },
      select: { snapshot: true },
    });
    if (!revision) return undefined;
    const settings = await this.settings();
    const { snapshot } = withoutToolActivity(
      archiveSnapshotSchema.parse(revision.snapshot),
      settings.integrations,
    );
    const valid = row.routingPlan?.plan ? storedPlanSchema.parse(row.routingPlan.plan) : undefined;
    return { row, snapshot, plan: valid };
  }
  /** The archive of another session of the same writer and source, by its session id. */
  private relatedId(snapshot: ArchiveSnapshot, sessionId: string) {
    return archiveKey({ sourceId: snapshot.sourceId, source: snapshot.source, sessionId });
  }
  /**
   * What validation and the planner need beyond the session: where the plan starts, a person's
   * `route:` decisions, the subagents it spawned (with their evidence), its parent's reach at the
   * spawn, and where each quoted entry's own session is routed.
   */
  private async routingContext(
    session: NonNullable<Awaited<ReturnType<ArchiveStore['plannedSession']>>>,
    routing: Routing,
  ) {
    const { row, snapshot, plan } = session;
    const entries = snapshot.entries;
    const map = await this.projectMap();
    const evidence = (row.evidence ?? null) as SessionEvidence | null;
    const at = plan ? entries.findIndex((e) => e.id === plan.throughEntryId) : -1;
    const from = at + 1;
    const overrideTags = row.tagEdits
      .filter((e) => e.added && e.tag.startsWith(ROUTE_TAG_PREFIX))
      .map((e) => e.tag)
      .sort();
    const known = new Set(routing.organizations.map((o) => o.id));
    const overrides = {
      organizations: new Set(
        overrideTags.map((t) => t.slice(ROUTE_TAG_PREFIX.length)).filter((o) => known.has(o)),
      ),
      personal: overrideTags.includes(`${ROUTE_TAG_PREFIX}${PERSONAL}`),
    };
    const bySpawn = (list: typeof entries, lineage?: ArchiveSnapshot['lineage']) =>
      lineage &&
      list.find(
        (e) =>
          (lineage.toolUseId && e.callId === lineage.toolUseId) || e.id === lineage.parentEntryId,
      )?.id;
    const childRows = await this.db.archive.findMany({
      where: {
        partOf: null,
        source: snapshot.source,
        AND: [
          { summary: { path: ['sourceId'], equals: snapshot.sourceId } },
          { summary: { path: ['lineage', 'parentSessionId'], equals: snapshot.sessionId } },
        ],
      },
      select: { summary: true, evidence: true },
    });
    const children = childRows.map((child) => {
      const summary = child.summary as Summary;
      const childEvidence = (child.evidence ?? null) as SessionEvidence | null;
      const spawnEntryId = bySpawn(entries, summary.lineage);
      return {
        spawnEntryId,
        organizations: evidencedOrganizations(childEvidence, routing, map),
        evidence: evidenceByOrganization(childEvidence, routing, map),
        description: (summary.lineage?.description ?? summary.session?.task ?? summary.title).slice(
          0,
          300,
        ),
      };
    });
    let parentReach: Set<string> | undefined;
    let parentIssue: string | undefined;
    let parent: { title: string; organizations: string[] } | undefined;
    const lineage = snapshot.lineage;
    if (lineage && lineage.kind !== 'part') {
      const parentSession = await this.plannedSession(
        this.relatedId(snapshot, lineage.parentSessionId),
      );
      if (!parentSession) parentIssue = 'its parent session is not in this Archive';
      else if (!parentSession.plan) parentIssue = 'its parent session has no valid plan yet';
      else {
        const spawn = bySpawn(parentSession.snapshot.entries, lineage);
        parentReach = planReach(parentSession.plan, parentSession.snapshot.entries, spawn);
        parent = { title: parentSession.snapshot.title, organizations: [...parentReach] };
      }
    }
    const root =
      lineage?.kind === 'part'
        ? snapshot.sessionId
        : (lineage?.rootSessionId ?? snapshot.sessionId);
    const foreign = new Map<string, Set<string> | null>();
    const foreignLabel = new Map<string, string>();
    const reachOf = new Map<string, Set<string> | null | 'own'>();
    for (const entry of entries) {
      if (entry.kind !== 'user' && entry.kind !== 'event') continue;
      const origins =
        snapshot.source === 'claude-code' ? quotedSessions(entry.text, root) : undefined;
      if (!origins) continue;
      let reach: Set<string> | null | undefined;
      for (const origin of origins) {
        if (!reachOf.has(origin)) {
          if (origin === 'unknown') reachOf.set(origin, null);
          else {
            const other = await this.plannedSession(this.relatedId(snapshot, origin));
            // A task notification naming no archived session is this session's own background task.
            reachOf.set(
              origin,
              other
                ? other.plan
                  ? planReach(other.plan, other.snapshot.entries)
                  : null
                : entry.text.includes('<agent-message')
                  ? null
                  : 'own',
            );
          }
        }
        const found = reachOf.get(origin)!;
        if (found === 'own') continue;
        if (found === null) reach = null;
        else if (reach !== null)
          reach = reach ? new Set([...reach].filter((o) => found.has(o))) : new Set(found);
      }
      if (reach === undefined) continue;
      foreign.set(entry.id, reach);
      foreignLabel.set(
        entry.id,
        origins.includes('unknown') ? 'another session' : origins.join(', '),
      );
    }
    return {
      entries,
      map,
      evidence,
      plan,
      from,
      overrides,
      overrideTags,
      children,
      parentReach,
      parentIssue,
      parent,
      parentArchiveId:
        lineage && lineage.kind !== 'part'
          ? this.relatedId(snapshot, lineage.parentSessionId)
          : undefined,
      foreign,
      foreignLabel,
    };
  }
  /**
   * What the routing planner reads for one session: the entries since its plan (up to a budget,
   * each clipped), with their evidence and whether they quote another session, and the context.
   */
  async routingInput(archiveId: string, routing: Routing): Promise<RoutingInput> {
    const session = await this.plannedSession(archiveId);
    if (!session) throw new Error('Archive unavailable');
    const context = await this.routingContext(session, routing);
    const { row, snapshot } = session;
    const { entries, evidence, map, plan, from } = context;
    const clip = (text: string, max: number) =>
      text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
    const show = (entry: (typeof entries)[number], index: number, max: number): RoutingEntry => {
      const own = evidence?.anchors.some((a) => a.entryId === entry.id)
        ? evidenceByOrganization(evidence, routing, map, new Set([entry.id]))
        : undefined;
      const foreign = context.foreignLabel.get(entry.id);
      return {
        index,
        kind: entry.kind,
        // Shown as stored, so a redaction quoting it matches byte for byte.
        text: clip(entry.text, max),
        ...(entry.text.length > max ? { clipped: true } : {}),
        ...(foreign ? { foreign } : {}),
        ...(own && Object.keys(own).length ? { evidence: own } : {}),
      };
    };
    const window: RoutingEntry[] = [];
    let used = 0;
    for (let i = from; i < entries.length; i++) {
      const shown = show(entries[i]!, i, ROUTE_WINDOW_CHARS);
      if (window.length && used + shown.text.length > ROUTE_WINDOW_CHARS) break;
      used += shown.text.length;
      window.push(shown);
    }
    const index = new Map(entries.map((e, i) => [e.id, i]));
    const last = plan?.parts.at(-1);
    const startProject = evidence?.startProjectId;
    return {
      archiveId,
      digest: row.digest,
      session: {
        title: snapshot.title,
        source: snapshot.source,
        ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
        ...(snapshot.lineage
          ? {
              lineage: {
                kind: snapshot.lineage.kind,
                ...(snapshot.lineage.agentType ? { agentType: snapshot.lineage.agentType } : {}),
                ...(snapshot.lineage.description
                  ? { description: snapshot.lineage.description }
                  : {}),
              },
            }
          : {}),
        ...(startProject
          ? {
              startOrganization:
                routing.organizations.find((o) => o.projects.includes(startProject))?.id ??
                PERSONAL,
            }
          : {}),
      },
      organizations: routing.organizations.map((o) => ({
        id: o.id,
        projects: o.projects,
        roster: o.roster ?? [],
      })),
      total: entries.length,
      through: from + window.length - 1,
      entries: window,
      before: entries
        .slice(Math.max(0, from - 3), from)
        .map((e, i) => show(e, Math.max(0, from - 3) + i, 400)),
      ...(plan
        ? {
            prior: {
              ...(last
                ? {
                    lastPart: {
                      from: index.get(last.firstEntryId) ?? 0,
                      to: index.get(last.lastEntryId) ?? 0,
                      organizations: last.organizations,
                      rationale: last.rationale,
                    },
                  }
                : {}),
              sensitive: plan.parts
                .filter((p) => p.sensitive)
                .map((p) => ({
                  from: index.get(p.firstEntryId) ?? 0,
                  to: index.get(p.lastEntryId) ?? 0,
                })),
              redactions: plan.redactions.map((r) => ({
                entry: index.get(r.entryId) ?? 0,
                reason: r.reason,
              })),
            },
          }
        : {}),
      evidence: evidenceByOrganization(evidence, routing, map),
      children: context.children.map((c) => ({
        description: c.description,
        ...(c.spawnEntryId !== undefined && index.has(c.spawnEntryId)
          ? { spawnedAt: index.get(c.spawnEntryId)! }
          : {}),
        evidence: c.evidence,
      })),
      ...(context.parent ? { parent: context.parent } : {}),
      ...(context.parentArchiveId ? { parentArchiveId: context.parentArchiveId } : {}),
      overrides: context.overrideTags,
    };
  }
  /**
   * Records the planner's answer for one session: validated in code (`validatePlan`), then, when
   * valid, stored and applied (its parts written, the ones it dropped retired). A failed run or a
   * plan that fails validation is held for review and changes nothing that publishes. A dry run
   * returns what would publish and stores nothing.
   */
  async recordPlan(
    body: RecordPlanBody,
    routing: Routing,
    now = Date.now(),
  ): Promise<RecordPlanResult> {
    const session = await this.plannedSession(body.archiveId);
    if (!session) throw new Error('Archive unavailable');
    const context = await this.routingContext(session, routing);
    const { row, snapshot } = session;
    const { entries, plan: prior } = context;
    // Nothing new to plan re-applies the plan as it stands (a person's decision changed).
    const reapply =
      body.through === context.from - 1 && Boolean(prior) && !body.proposal?.parts.length;
    if ((body.through < context.from && !reapply) || body.through >= entries.length)
      return { status: 'stale' };
    const record = {
      key: body.key,
      by: body.by,
      digest: row.digest,
      // A plan that covers only part of the session (a window) leaves it due.
      entries: body.through === entries.length - 1 ? (row.summary as Summary).entries : -1,
      overrides: context.overrideTags,
      at: now,
    };
    const hold = async (issues: string[], notes: string[] = []) => {
      if (!body.dryRun) {
        const attempt = (body.proposal ?? { failure: body.failure }) as Prisma.InputJsonValue;
        const fields = { ...record, status: 'held', attempt, issues, notes, reviewedAt: null };
        await this.db.routingPlan.upsert({
          where: { archiveId: body.archiveId },
          create: { archiveId: body.archiveId, ...fields },
          update: fields,
        });
      }
      return { status: 'held' as const, issues, notes };
    };
    if (body.dryRun && body.assumeParentReach) {
      context.parentReach = new Set(body.assumeParentReach);
      context.parentIssue = undefined;
    }
    const holds = await this.heldBy(body.archiveId, routing);
    if (context.parentIssue) return { ...(await hold([context.parentIssue])), holds };
    if (!body.proposal) return { ...(await hold([body.failure ?? 'no plan'])), holds };
    const result = validatePlan(body.proposal, {
      entries,
      routing,
      ...(context.map ? { map: context.map } : {}),
      evidence: context.evidence,
      ...(prior ? { prior } : {}),
      from: context.from,
      through: body.through,
      clipped: new Set(
        entries
          .slice(context.from, body.through + 1)
          .filter((e) => e.text.length > ROUTE_WINDOW_CHARS)
          .map((e) => e.id),
      ),
      overrides: context.overrides,
      children: context.children,
      ...(context.parentReach ? { parentReach: context.parentReach } : {}),
      foreign: context.foreign,
    });
    if (result.status === 'held') return { ...(await hold(result.issues, result.notes)), holds };
    const published = publishedParts(
      result.plan,
      entries,
      context.foreign,
      sensitiveEntries(result.plan, entries),
    );
    const projectsOf = (organizations: string[]) =>
      new Set(
        routing.organizations
          .filter((o) => organizations.includes(o.id))
          .flatMap((o) => o.projects),
      );
    const parts = published.map((part) => ({
      snapshot: partSnapshot(
        snapshot,
        { ...part, projects: projectsOf(part.organizations) },
        result.plan.redactions,
      ),
      organizations: part.organizations,
    }));
    const outcome = {
      notes: result.notes,
      parts: parts.map((p) => ({
        sessionId: p.snapshot.sessionId,
        organizations: p.organizations,
        entries: p.snapshot.entries.length,
        redacted: p.snapshot.entries.filter((e) => e.text.includes('[redacted: ')).length,
      })),
    };
    if (body.dryRun) return { status: 'valid', ...outcome, holds };
    const changed = JSON.stringify(prior) !== JSON.stringify(result.plan);
    const version = (row.routingPlan?.version ?? 0) + (changed ? 1 : 0);
    const fields = {
      ...record,
      status: 'valid',
      plan: result.plan as Prisma.InputJsonValue,
      attempt: Prisma.DbNull,
      issues: [],
      notes: result.notes,
      version,
      ...(changed ? { reviewedAt: null } : {}),
    };
    await this.db.routingPlan.upsert({
      where: { archiveId: body.archiveId },
      create: { archiveId: body.archiveId, ...fields },
      update: fields,
    });
    const { retired } = await this.applyParts(body.archiveId, parts);
    return { status: 'valid', version, ...outcome, retired, holds };
  }
  /** The organizations whose destinations hold this session or one of its parts (receipts). */
  private async heldBy(archiveId: string, routing: Routing) {
    const receipts = await this.db.receipt.findMany({
      where: { OR: [{ archiveId }, { archive: { partOf: archiveId } }] },
      select: { destination: true },
    });
    const byIdentity = new Map(
      routing.destinations.map((d) => [destinationIdentity(d), d.organizationId]),
    );
    return [...new Set(receipts.flatMap((r) => byIdentity.get(r.destination) ?? []))].sort();
  }
  /**
   * Plans for review, most in need first: held ones, then ones with redactions or low confidence
   * a person has not read since they changed. `all` lists every plan.
   */
  async routingPlans(input: { all?: boolean; limit: number }) {
    const rows = await this.db.routingPlan.findMany({
      include: { archive: { select: { summary: true } } },
      orderBy: { at: 'desc' },
    });
    const items = rows.flatMap((row) => {
      const plan = row.plan ? storedPlanSchema.parse(row.plan) : undefined;
      const confidence = plan?.parts.length ? Math.min(...plan.parts.map((p) => p.confidence)) : 1;
      const redactions = plan?.redactions.length ?? 0;
      const due =
        row.status === 'held' || (row.reviewedAt === null && (redactions > 0 || confidence < 0.6));
      if (!input.all && !due) return [];
      const summary = row.archive.summary as Summary;
      return [
        {
          archiveId: row.archiveId,
          title: summary.title,
          sessionId: summary.sessionId,
          status: row.status,
          version: row.version,
          issues: row.issues,
          notes: row.notes,
          redactions,
          confidence,
          reviewedAt: row.reviewedAt,
          by: row.by,
          at: row.at,
          plan: plan ?? null,
          attempt: row.attempt,
        },
      ];
    });
    items.sort(
      (a, b) =>
        Number(b.status === 'held') - Number(a.status === 'held') || a.confidence - b.confidence,
    );
    return items.slice(0, input.limit);
  }
  /**
   * Sessions due for a routing plan, in the order to plan them: a tree's parents before their
   * subagents, oldest change first. A session is due when it has no plan yet, or new entries since
   * its plan (or a person changed its `route:` tags), and either it paused (no capture for
   * `pausedMs`) or its plan is older than `intervalMs` plus a stagger of up to `staggerMs` from its
   * id, so sessions are not all planned at once. A held plan is retried only when the session
   * changed or its parent has been planned since. Exempt runs, parts and superseded raw captures
   * are never planned, and a subagent waits for its parent's plan.
   */
  async routingDue(input: {
    now?: number;
    limit: number;
    intervalMs?: number;
    pausedMs?: number;
    staggerMs?: number;
    /** Only sessions with no plan at all (a backfill). */
    unplanned?: boolean;
    /** Subagents too, before their parent is planned (a dry run judges them on its own plans). */
    withoutParents?: boolean;
  }) {
    const now = input.now ?? Date.now();
    const interval = input.intervalMs ?? 60 * 60_000;
    const paused = input.pausedMs ?? 30 * 60_000;
    const stagger = input.staggerMs ?? 10 * 60_000;
    const rows = await this.db.archive.findMany({
      where: { partOf: null, supersededBy: null },
      select: {
        id: true,
        revision: true,
        digest: true,
        capturedAt: true,
        summary: true,
        tagEdits: true,
        routingPlan: {
          select: {
            status: true,
            plan: true,
            entries: true,
            digest: true,
            overrides: true,
            at: true,
            issues: true,
          },
        },
      },
    });
    const planned = new Set(rows.filter((r) => r.routingPlan?.plan).map((r) => r.id));
    const due: { archiveId: string; capturedAt: number; depth: number; reason: string }[] = [];
    for (const row of rows) {
      const view = listing({ ...row, suggestion: null }, { exempt: 'include' })[0]!;
      if (exemptRun(view.tags)) continue;
      const summary = row.summary as Summary;
      const lineage = summary.lineage;
      if (lineage && lineage.kind !== 'part' && !input.withoutParents) {
        const parent = archiveKey({
          sourceId: summary.sourceId,
          source: summary.source,
          sessionId: lineage.parentSessionId,
        });
        if (!planned.has(parent)) continue;
      }
      const plan = row.routingPlan;
      if (input.unplanned && plan) continue;
      const overrides = row.tagEdits
        .filter((e) => e.added && e.tag.startsWith(ROUTE_TAG_PREFIX))
        .map((e) => e.tag)
        .sort();
      let reason: string | undefined;
      if (!plan) reason = 'unplanned';
      else if (JSON.stringify(overrides) !== JSON.stringify(plan.overrides)) reason = 'decision';
      else if (plan.status === 'held')
        reason =
          plan.digest !== row.digest
            ? 'changed'
            : plan.issues.some((i) => i.includes('parent session'))
              ? 'parent planned'
              : undefined;
      else if (summary.entries > plan.entries) reason = 'new entries';
      if (!reason) continue;
      if (plan && reason !== 'decision') {
        const offset = Number.parseInt(digest(row.id).slice(0, 8), 16) % (stagger + 1);
        const pausedNow = now - row.capturedAt >= paused;
        if (!pausedNow && now < plan.at + interval + offset) continue;
        if (pausedNow) reason = `${reason}, paused`;
      }
      due.push({
        archiveId: row.id,
        capturedAt: row.capturedAt,
        depth: lineage?.depth ?? (lineage ? 1 : 0),
        reason,
      });
    }
    due.sort((a, b) => a.depth - b.depth || a.capturedAt - b.capturedAt);
    return due
      .slice(0, input.limit)
      .map(({ archiveId, reason, depth }) => ({ archiveId, reason, depth }));
  }
  /** A person read this plan; it leaves the review queue until it changes. */
  async reviewPlan(archiveId: string, now = Date.now()) {
    return (
      (await this.db.routingPlan.updateMany({ where: { archiveId }, data: { reviewedAt: now } }))
        .count > 0
    );
  }
  /**
   * A person drops a session's plan, its sticky decisions with it: the session is planned afresh.
   * Its parts stand until the next plan replaces them.
   */
  async resetPlan(archiveId: string) {
    return (await this.db.routingPlan.deleteMany({ where: { archiveId } })).count > 0;
  }
  async close() {
    await this.db.$disconnect();
  }
}

/**
 * Deletes one earlier revision (its chunks cascade) unless it is current or an outbox row names it.
 * Returns how many went (0 or 1).
 */
const dropRevision = (
  db: Prisma.TransactionClient | PrismaClient,
  archiveId: string,
  revision: number,
) => db.$executeRaw`
  DELETE FROM "revisions" r
  WHERE r."archiveId" = ${archiveId} AND r."revision" = ${revision}
    AND r."revision" < (SELECT a."revision" FROM "archives" a WHERE a."id" = r."archiveId")
    AND NOT EXISTS (SELECT 1 FROM "outbox" o
      WHERE o."archiveId" = r."archiveId" AND o."revision" = r."revision")`;

/**
 * How a capture is checked and what comes with it: `previousDigest` (the writer's last known
 * digest; checked when given), `cwd` (the session's working directory, for evidence), `restore`
 * (lift this session's tombstone: the writer means to bring a deleted session back).
 */
export type CaptureOptions = { previousDigest?: string | null; cwd?: string; restore?: boolean };

/** A capture that lost a race or arrived out of order; the server answers 409. */
export class ArchiveConflict extends Error {}
/** A claim another writer holds, or a fulfil by a writer that does not hold the claim. */
export class ClaimHeld extends Error {}
/** A revision compaction removed: only the current one, and one awaiting delivery, are kept. 410. */
export class RevisionCompacted extends Error {}
/** Reclaiming space before compaction and tool-activity removal have finished. 409. */
export class MaintenancePending extends Error {}
