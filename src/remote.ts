import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultHome } from './agents';
import type { ArchiveDestination, DescribedDestination } from './config';
import type { ArchiveChunk, ArchiveSnapshot } from './index';
import { archiveKey, archiveSnapshotSchema } from './index';
import type {
  ArchiveFilter,
  ArchiveSettings,
  ClaimSource,
  ClaimState,
  TagDefinition,
} from './schemas';
import type { SuggestionDue, SuggestionResult } from './suggest';
import type { ArchiveReferenceCount, TagSuggestion } from './tags';

export type ArchiveListing = Omit<ArchiveSnapshot, 'entries'> & {
  id: string;
  revision: number;
  digest: string;
  entries: number;
  models: { model: string; effort?: string; entries: number }[];
  suggestedTags: TagSuggestion[];
  references: ArchiveReferenceCount[];
};

/** A configured destination and how many of its project's archives it holds at their latest. */
export type DestinationStatus = DescribedDestination & { delivered: number; pending: number };
/** A hosted Archive library a held Signet may write to. */
export type ArchiveLibrary = { integrationId: string; resourceId: string; name: string };
export type ArchiveLibraries = { paired: boolean; libraries: ArchiveLibrary[] };
export type RoutedDestination = Pick<ArchiveDestination, 'kind' | 'url'> & {
  integrationId?: string;
};
export type RoutingPreview = (Pick<
  ArchiveListing,
  'id' | 'projectId' | 'tags' | 'suggestedTags'
> & {
  destinations: RoutedDestination[];
})[];
export type SyncResult = { id: string; destination: string; status: string };
/** A project routed to a hosted Archive library through Kingdom. */
export type KingdomRoute = { projectId: string; integrationId: string; resourceId: string };

export class ArchiveRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The server's reason for refusing a request: its JSON `error`, else the start of the raw body (a proxy's page). */
export async function refusalDetail(response: Response) {
  const text = (await response.text().catch(() => '')).trim();
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const error = body.error as { message?: unknown } | string | undefined;
    const message = typeof error === 'string' ? error : (error?.message ?? body.message);
    if (typeof message === 'string') return message.slice(0, 500);
  } catch {}
  return text.replace(/\s+/g, ' ').slice(0, 500) || undefined;
}

/**
 * An Archive server over HTTP. Collectors, the CLI and Foundry write through this; only the
 * server holds the database.
 */
export class ArchiveClient {
  private cachedSourceId?: string;
  constructor(private readonly options: { url: string; token: string; fetch?: typeof fetch }) {}
  async request<T>(
    action: string,
    body: unknown = {},
    { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      new URL(`api/v1/archive/${action}`, this.options.url),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok)
      throw new ArchiveRequestError(
        response.status,
        (await refusalDetail(response)) ?? `Archive ${action} failed`,
      );
    return ((await response.json()) as { data: T }).data;
  }
  async sourceId() {
    this.cachedSourceId ??= (await this.request<{ sourceId: string }>('info')).sourceId;
    return this.cachedSourceId;
  }
  head(id: string) {
    return this.request<{ id: string; digest: string; revision: number; projectId: string | null }>(
      'head',
      { archiveId: id },
    ).catch((error) => {
      if (error instanceof ArchiveRequestError && error.status === 404) return undefined;
      throw error;
    });
  }
  /** Captures a snapshot as the next revision, retrying when another writer got there first. */
  async capture(input: unknown) {
    const snapshot = archiveSnapshotSchema.parse(input);
    const id = archiveKey(snapshot);
    for (let attempt = 0; ; attempt++) {
      const head = await this.head(id);
      try {
        return await this.request<{
          id: string;
          digest: string;
          revision: number;
          changed: boolean;
        }>('ingest', { snapshot, previousDigest: head?.digest ?? null });
      } catch (error) {
        const conflict =
          error instanceof ArchiveRequestError &&
          error.status === 409 &&
          error.message === 'Revision conflict';
        if (!conflict || attempt >= 3) throw error;
      }
    }
  }
  /** Claim native sessions this writer records itself, for `ttlMs` (claim again to renew the lease). */
  holdClaims(input: {
    claimant: string;
    ttlMs: number;
    sessions: Array<{ source: ClaimSource; sessionId: string }>;
  }) {
    return this.request<{ expiresAt: number }>('claims/hold', input);
  }
  /** This writer stored its own version (`archiveId`) of a session it claimed. */
  fulfilClaim(input: {
    claimant: string;
    source: ClaimSource;
    sessionId: string;
    archiveId: string;
  }) {
    return this.request<{ fulfilledBy: string; superseded: string[] }>('claims/fulfil', input);
  }
  /**
   * Whether a native session (its transcript modified at `modifiedAt`) is left to its claimant
   * (`live` until `until`, `fulfilled`) or captured (`lapsed`, `none`).
   */
  claimState(source: ClaimSource, sessionId: string, modifiedAt?: number) {
    return this.request<{ state: ClaimState; until?: number }>('claims/state', {
      source,
      sessionId,
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
    });
  }
  read(id: string, revision?: number) {
    return this.request<{
      id: string;
      revision: number;
      digest: string;
      snapshot: ArchiveSnapshot;
      chunks: ArchiveChunk[];
    }>('read', { archiveId: id, ...(revision ? { revision } : {}) }).catch((error) => {
      if (error instanceof ArchiveRequestError && error.status === 404) return undefined;
      throw error;
    });
  }
  /** Every listing matching the filter, following cursors. */
  async list(filter: ArchiveFilter = {}) {
    const archives: ArchiveListing[] = [];
    let beforeId: string | undefined;
    do {
      const page = await this.request<{ archives: ArchiveListing[]; nextCursor: string | null }>(
        'list',
        { ...filter, limit: 100, ...(beforeId ? { beforeId } : {}) },
      );
      archives.push(...page.archives);
      beforeId = page.nextCursor ?? undefined;
    } while (beforeId);
    return archives;
  }
  search(
    body: ArchiveFilter & { query?: string; budget?: number; limit?: number; beforeId?: string },
  ) {
    return this.request<{
      archives: (Omit<ArchiveListing, 'id' | 'entries'> & {
        archiveId: string;
        chunks: ArchiveChunk[];
        tokenCount: number;
      })[];
      tokenCount: number;
      nextCursor: string | null;
    }>('search', body);
  }
  tag(id: string, change: { add?: string[]; remove?: string[] }) {
    return this.request<{ id: string; tags: string[] }>('tag', { archiveId: id, ...change });
  }
  delete(id: string) {
    return this.request<{ deleted: boolean }>('delete', { archiveId: id });
  }
  settings() {
    return this.request<ArchiveSettings>('settings/read');
  }
  updateSettings(change: Partial<ArchiveSettings>) {
    return this.request<ArchiveSettings>('settings/update', change);
  }
  defineTag(definition: TagDefinition) {
    return this.request<TagDefinition>('tags/define', definition);
  }
  undefineTag(definition: { tag: string; actorId?: string }) {
    return this.request<{ removed: boolean }>('tags/remove', definition);
  }
  /** Sessions due for tag suggestions, each as a bounded digest. */
  suggestionQueue(body: { key: string; limit: number; beforeId?: string; refresh?: boolean }) {
    return this.request<{ items: SuggestionDue[]; projects: string[]; nextCursor: string | null }>(
      'suggestions/queue',
      body,
      { timeoutMs: 120_000 },
    );
  }
  recordSuggestions(results: SuggestionResult[]) {
    return this.request<{ recorded: number; stale: number; refused: number; dropped: number }>(
      'suggestions/record',
      { results },
    );
  }
  tagDefinitions(actorId?: string) {
    return this.request<{ tags: (TagDefinition & { archives: number })[] }>(
      'tags/list',
      actorId ? { actorId } : {},
    );
  }
  destinations(filter: { projectId?: string } = {}) {
    return this.request<{ destinations: DestinationStatus[] }>('destinations/list', filter);
  }
  libraries() {
    return this.request<ArchiveLibraries>('destinations/libraries');
  }
  /** Each archive and the destinations its project routes to; nothing is sent. */
  routes() {
    return this.request<RoutingPreview>('destinations/routes');
  }
  /** Publishes every archive to its project's destinations once. */
  sync() {
    return this.request<SyncResult[]>('destinations/sync', {}, { timeoutMs: 600_000 });
  }
  /** Routes a project to a library; the server verifies its Signet grants sessions.write first. */
  connectDestination(route: KingdomRoute) {
    return this.request<DescribedDestination>('destinations/connect', route);
  }
  removeDestination(route: KingdomRoute) {
    return this.request<{ removed: boolean }>('destinations/remove', route);
  }
}

/** The machine's local Archive server (the `archive` block in @inixiative/config ports). */
export const DEFAULT_URL = 'http://127.0.0.1:4700';

/**
 * A client for this machine's Archive: `ARCHIVE_URL` or the default address, with `ARCHIVE_TOKEN`
 * or the home's `server.token`. Undefined until `archive up` (or `init`) has made a token.
 */
export function localArchive(options: { home?: string; url?: string; fetch?: typeof fetch } = {}) {
  const tokenFile = join(options.home ?? defaultHome(), 'server.token');
  const token =
    process.env.ARCHIVE_TOKEN ??
    (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined);
  if (!token) return undefined;
  return new ArchiveClient({
    url: options.url ?? process.env.ARCHIVE_URL ?? DEFAULT_URL,
    token,
    fetch: options.fetch,
  });
}
