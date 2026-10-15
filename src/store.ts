import { randomUUID } from 'node:crypto';
import { type Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { exemptRun, identityRunTags } from './exemption';
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

/** A session's tags before edits: as captured, plus the run tags its identity implies. */
const baseTags = (summary: Summary) => [
  ...new Set([
    ...summary.capturedTags,
    ...identityRunTags({
      source: summary.source,
      sessionId: summary.sessionId,
      projectId: summary.projectId,
      tags: summary.capturedTags,
    }),
  ]),
];

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
          provider: snapshot.runtime?.provider ?? null,
          accessPath: snapshot.runtime?.accessPath ?? null,
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
   * Claim native sessions for a writer that records them itself, for `ttlMs` from now: the lease is
   * renewed by claiming again. A claim keeps a session it already covers fulfilled.
   */
  async claim(input: {
    claimant: string;
    ttlMs: number;
    sessions: Array<{ source: ClaimSource; sessionId: string }>;
  }) {
    const expiresAt = new Date(Date.now() + input.ttlMs);
    await this.db.$transaction(
      input.sessions.map(({ source, sessionId }) =>
        this.db.claim.upsert({
          where: { source_sessionId: { source, sessionId } },
          create: { source, sessionId, claimant: input.claimant, expiresAt },
          update: { claimant: input.claimant, expiresAt },
        }),
      ),
    );
    return { expiresAt: expiresAt.getTime() };
  }
  /**
   * The claimant stored its own version of a claimed session (`archiveId`): the claim is fulfilled,
   * and a raw capture the collector made while the claim had lapsed is tagged `superseded-by:<id>`
   * (kept; retention may prune it).
   */
  async fulfil(input: { source: ClaimSource; sessionId: string; archiveId: string }) {
    const updated = await this.db.claim.updateMany({
      where: { source: input.source, sessionId: input.sessionId },
      data: { fulfilledBy: input.archiveId },
    });
    if (!updated.count) return null;
    const fallbacks = await this.db.archive.findMany({
      where: {
        source: input.source,
        OR: [
          { summary: { path: ['sessionId'], equals: input.sessionId } },
          { summary: { path: ['sessionId'], string_starts_with: `${input.sessionId}/` } },
        ],
      },
      select: { id: true },
    });
    for (const { id } of fallbacks)
      await this.tag(id, { add: [`superseded-by:${input.archiveId}`] });
    return { fulfilledBy: input.archiveId, superseded: fallbacks.map((a) => a.id) };
  }
  /**
   * Whether the collector should leave a native session to its claimant: `live` (lease running),
   * `fulfilled` (stored by the claimant), `lapsed` (capture it raw) or `none`. A Claude subagent
   * transcript (`<session>/agent-<id>`) follows its session's claim.
   */
  async claimState(source: string, sessionId: string): Promise<ClaimState> {
    const root = sessionId.split('/')[0]!;
    const claim = await this.db.claim.findFirst({
      where: { source, sessionId: { in: [...new Set([sessionId, root])] } },
      orderBy: { sessionId: 'desc' },
    });
    if (!claim) return 'none';
    if (claim.fulfilledBy) return 'fulfilled';
    return claim.expiresAt.getTime() > Date.now() ? 'live' : 'lapsed';
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
  /** A project's archives at one destination: delivered at their latest digest, or pending. */
  async delivery(projectId: string, destination: string) {
    const archives = await this.db.archive.findMany({
      where: { projectId },
      select: { digest: true, receipts: { where: { destination }, select: { digest: true } } },
    });
    const delivered = archives.filter((a) => a.receipts[0]?.digest === a.digest).length;
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

/** A capture that lost a race or arrived out of order; the server answers 409. */
export class ArchiveConflict extends Error {}
