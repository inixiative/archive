import type { ArchiveChunk, ArchiveSnapshot } from './index';
import { archiveKey, archiveSnapshotSchema } from './index';
import type { ArchiveFilter, ArchiveSettings, TagDefinition } from './store';
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

export class ArchiveRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * An Archive server over HTTP. Collectors, the CLI and Foundry write through this; only the
 * server holds the database.
 */
export class ArchiveClient {
  private cachedSourceId?: string;
  constructor(private readonly options: { url: string; token: string; fetch?: typeof fetch }) {}
  async request<T>(action: string, body: unknown = {}): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      new URL(`api/v1/archive/${action}`, this.options.url),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: string };
    if (!response.ok)
      throw new ArchiveRequestError(response.status, payload.error ?? `Archive ${action} failed`);
    return payload.data as T;
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
  tagDefinitions(actorId?: string) {
    return this.request<{ tags: (TagDefinition & { archives: number })[] }>(
      'tags/list',
      actorId ? { actorId } : {},
    );
  }
}
