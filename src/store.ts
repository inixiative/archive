import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { exemptRun, identityRunTags, RUN_TAGS, type RunKind } from './exemption';
import {
  type ArchiveChunk,
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  chunkArchive,
  selectChunks,
  snapshotDigest,
  UNROUTED,
} from './index';
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
      tags: summary.capturedTags,
      lineage: summary.lineage,
    }),
  ]),
];

/**
 * The run kind a snapshot is stamped (or, interim, inferred) as, unless a person lifted that
 * exemption on the stored session by removing its run tag.
 */
async function runToDrop(
  tx: Prisma.TransactionClient,
  id: string,
  snapshot: ArchiveSnapshot,
): Promise<RunKind | undefined> {
  const run = exemptRun([
    ...snapshot.tags,
    ...identityRunTags({ ...snapshot, projectId: snapshot.projectId ?? null }),
  ]);
  if (!run) return undefined;
  const lifted = await tx.tagEdit.findFirst({
    where: { archiveId: id, added: false, tag: { in: Object.values(RUN_TAGS) } },
  });
  return lifted ? undefined : run;
}

type ArchiveRow = {
  id: string;
  revision: number;
  digest: string;
  summary: Prisma.JsonValue;
  tagEdits: { tag: string; added: boolean }[];
  suggestion: { digest: string; by: string; tags: string[] } | null;
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
    { id: row.id, revision: row.revision, digest: row.digest, ...summary, tags, suggestedTags },
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
  async capture(input: unknown, expected?: { previousDigest: string | null }) {
    const incoming = archiveSnapshotSchema.parse(input);
    const id = archiveKey(incoming);
    const digest = snapshotDigest(incoming);
    return this.db.$transaction(
      async (tx) => {
        // Serializes concurrent captures of one session.
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${id}))`;
        // A settings change waits for captures in flight, so the sweep it queues sees them all.
        await tx.$executeRaw`SELECT 1 FROM pg_advisory_xact_lock_shared(${SETTINGS_LOCK})`;
        const settings = await this.settings(tx);
        const run = settings.captureRunSessions ? undefined : await runToDrop(tx, id, incoming);
        if (run) {
          // The digest is the writer's, so a syncing Archive records the delivery and moves on.
          await tx.archive.deleteMany({ where: { id } });
          return { id, digest, revision: 0, changed: false, dropped: RUN_TAGS[run] };
        }
        const old = await tx.archive.findUnique({ where: { id } });
        if (old?.digest === digest) return { id, digest, revision: old.revision, changed: false };
        if (expected && (old?.digest ?? null) !== expected.previousDigest)
          throw new ArchiveConflict('Revision conflict');
        if (old && old.capturedAt > incoming.capturedAt) throw new ArchiveConflict('Stale capture');
        const { snapshot, changed } = settings.captureToolCallsAndResults
          ? { snapshot: incoming, changed: 0 }
          : withoutToolActivity(incoming, settings.integrations);
        const storedDigest = changed ? snapshotDigest(snapshot) : digest;
        // The writer changed only what this Archive drops: what it holds stays as it is.
        if (old?.storedDigest === storedDigest) {
          await tx.archive.update({
            where: { id },
            data: { digest, capturedAt: snapshot.capturedAt },
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
          storedDigest,
          revision,
          source: snapshot.source,
          projectId: snapshot.projectId ?? null,
          actorId: snapshot.actor?.id ?? null,
          provider: snapshot.runtime?.provider ?? null,
          accessPath: snapshot.runtime?.accessPath ?? null,
          capturedAt: snapshot.capturedAt,
          summary: summarize(snapshot, settings) as Prisma.InputJsonValue,
        };
        await tx.archive.upsert({ where: { id }, create: { id, ...fields }, update: fields });
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
  /** Current digest and revision without the content. */
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
      },
    });
    return row ?? undefined;
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
        where: { id: { in: raw.map((a) => a.id) } },
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
   * on, as listed (a session whose run tag a person removed stays). One page of archives at a
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
        if (listing(archive, { exempt: 'only' }).length)
          // A capture that moved the session on meanwhile was itself dropped or lifted.
          removed += (
            await this.db.archive.deleteMany({ where: { id: archive.id, digest: archive.digest } })
          ).count;
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
  /** A project's archives at one destination: delivered at their latest digest, or pending. */
  async delivery(projectId: string, destination: string) {
    const archives = await this.db.archive.findMany({
      where: { projectId, supersededBy: null },
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
        where: cursor === undefined ? {} : { seq: { lt: cursor } },
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
      if (exemptRun(listing(row, { exempt: 'include' })[0]!.tags)) {
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

/** A capture that lost a race or arrived out of order; the server answers 409. */
export class ArchiveConflict extends Error {}
/** A claim another writer holds, or a fulfil by a writer that does not hold the claim. */
export class ClaimHeld extends Error {}
/** A revision compaction removed: only the current one, and one awaiting delivery, are kept. 410. */
export class RevisionCompacted extends Error {}
/** Reclaiming space before compaction and tool-activity removal have finished. 409. */
export class MaintenancePending extends Error {}
