import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { importTranscriptFile } from './import-file';
import { archiveKey, archiveSnapshotSchema, snapshotDigest, UNROUTED } from './index';
import type { ArchiveClient } from './remote';
import { type AtlasFileConcepts, atlasTags, provenanceReferences } from './tags';

export { UNROUTED } from './index';

export interface CollectionSource {
  directory: string;
  source: 'codex' | 'claude-code';
  projectRoots: string[];
  projectId: string;
  /** Also match the git worktrees of each root; nested checkouts stay separate. */
  worktrees?: boolean;
  /** Also match directories below each root, unless a more specific root claims them. */
  subdirectories?: boolean;
  /** Take every session no other collector of this source claims, as projectId `unrouted`. */
  catchAll?: boolean;
  /** Tag sessions with the Atlas concepts of files they touched, from `atlas graph` in the session's checkout. */
  atlas?: boolean;
  tags?: string[];
}

/**
 * Where sessions are never swept in by a subdirectory or catch-all match: temp directories (test
 * fixtures, agent scratchpads) and Foundry's decision receipts. An exact root is explicit and wins.
 * Absolute entries match the directory and below; relative ones match those path segments anywhere.
 */
export const defaultExclusions = () => [
  ...new Set(
    ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()].flatMap((path) => {
      try {
        return [resolve(path), realpathSync(path)];
      } catch {
        return [resolve(path)];
      }
    }),
  ),
  '.foundry/decision-receipts',
];
export function excluded(cwd: string, exclusions: string[]) {
  return exclusions.some((entry) =>
    isAbsolute(entry)
      ? cwd === resolve(entry) || cwd.startsWith(`${resolve(entry)}/`)
      : `${cwd}/`.includes(`/${entry.replace(/^\/+|\/+$/g, '')}/`),
  );
}

/** Every transcript (`.jsonl`) under a directory, in order, without following links. */
export function transcriptFiles(directory: string): string[] {
  const result: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile() && path.endsWith('.jsonl')) result.push(path);
  };
  visit(resolve(directory));
  return result;
}

export type SessionMetadata = { cwd: string; branch?: string; repository?: string };

/** Provider metadata, never text/tags/model suggestions; `routeSession` decides where it goes. */
export function sessionMetadata(
  file: string,
  source: CollectionSource['source'],
): SessionMetadata | undefined {
  // A bounded synchronous read: streamed readline could leave a watch loop waiting forever.
  const buffer = Buffer.alloc(Math.min(lstatSync(file).size, 1_000_000));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      return undefined;
    }
    const meta = source === 'codex' ? (row.type === 'session_meta' ? row.payload : undefined) : row;
    if (typeof meta?.cwd !== 'string' || !isAbsolute(meta.cwd)) continue;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    return source === 'codex'
      ? {
          cwd: resolve(meta.cwd),
          branch: text(meta.git?.branch),
          repository: text(meta.git?.repository_url),
        }
      : { cwd: resolve(meta.cwd), branch: text(meta.gitBranch) };
  }
}

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'ignore' });
  return run.success ? run.stdout.toString().trim() : undefined;
};

function atlasGraph(cwd: string): AtlasFileConcepts | undefined {
  if (!existsSync(`${cwd}/.atlas`)) return;
  const run = Bun.spawnSync([process.execPath, 'x', 'atlas', 'graph', '--json'], {
    cwd,
    stderr: 'ignore',
  });
  if (!run.success) return;
  try {
    return JSON.parse(run.stdout.toString()).fileToConcepts;
  } catch {}
}

function worktreesOf(root: string): string[] {
  const listed = Bun.spawnSync(['git', '-C', root, 'worktree', 'list', '--porcelain'], {
    stderr: 'ignore',
  });
  if (!listed.success) return [];
  return listed.stdout
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)));
}

/** Exact directories this collection accepts, re-read each scan so new worktrees join. */
export function collectionRoots(config: CollectionSource): Set<string> {
  // Providers record the real path (macOS /tmp is /private/tmp), so roots match by it too.
  const roots = config.projectRoots.flatMap((root) => {
    try {
      return [...new Set([resolve(root), realpathSync(root)])];
    } catch {
      return [resolve(root)];
    }
  });
  return new Set(config.worktrees ? [...roots, ...roots.flatMap(worktreesOf)] : roots);
}

/**
 * The collector a session's cwd belongs to. The longest matching root wins: a root matches its own
 * directory (and worktrees), and with `subdirectories` the directories below it. Ties go to the
 * first declared. Excluded directories match only exact roots. Unclaimed sessions go to the first
 * catch-all.
 */
export function routeSession(
  cwd: string,
  collectors: CollectionSource[],
  options: { exclude?: string[]; roots?: (collector: CollectionSource) => Set<string> } = {},
) {
  const rootsOf = options.roots ?? collectionRoots;
  const broad = !excluded(cwd, options.exclude ?? defaultExclusions());
  let best: { collector: CollectionSource; length: number } | undefined;
  for (const collector of collectors) {
    if (collector.catchAll) continue;
    for (const root of rootsOf(collector)) {
      const matches =
        cwd === root || (broad && collector.subdirectories && cwd.startsWith(`${root}/`));
      if (matches && (!best || root.length > best.length))
        best = { collector, length: root.length };
    }
  }
  if (best) return best.collector;
  return broad ? collectors.find((c) => c.catchAll) : undefined;
}

/** Where collected sessions go: an Archive server, or a store in-process. */
export type ArchiveWriter = Pick<ArchiveClient, 'sourceId' | 'head' | 'capture'>;

/**
 * The access path the harness's login implies when a transcript is silent, read from the harness
 * home that owns the history directory (`<claude config>/projects`, `<codex home>/sessions`):
 * Claude Code's subscription login (`oauthAccount`) unless its settings supply an API key, and
 * Codex's `auth.json` mode. Undefined when neither says; throws when a file exists but cannot be
 * read, so a bad read never relabels sessions.
 */
export function harnessAccess(
  source: CollectionSource['source'],
  directory: string,
): 'subscription' | 'api' | undefined {
  const json = (path: string) =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
  const harnessHome = dirname(resolve(directory));
  if (source === 'claude-code') {
    const settings = json(join(harnessHome, 'settings.json'));
    if (settings?.apiKeyHelper || settings?.env?.ANTHROPIC_API_KEY) return 'api';
    // The default config directory keeps its login beside it, in ~/.claude.json.
    const login =
      harnessHome === join(homedir(), '.claude')
        ? join(homedir(), '.claude.json')
        : join(harnessHome, '.claude.json');
    const account = json(login)?.oauthAccount;
    return account && typeof account === 'object' ? 'subscription' : undefined;
  }
  const auth = json(join(harnessHome, 'auth.json'));
  if (auth?.auth_mode === 'chatgpt' || auth?.tokens) return 'subscription';
  if (auth?.auth_mode === 'apikey' || auth?.OPENAI_API_KEY) return 'api';
  return undefined;
}

/**
 * What a watching collector remembers between scans: each file's size and mtime with the outcome,
 * so an untouched file is neither re-read nor re-sent. Keyed by the routing and archive it was
 * decided under; a stored session is re-checked against the server now and then, so one deleted
 * there is captured again.
 */
export type CollectorCache = Map<
  string,
  {
    size: number;
    mtimeMs: number;
    routing: string;
    outcome: 'unchanged' | 'skipped' | 'failed';
    meta?: SessionMetadata;
    stored?: { id: string; digest: string; checkedAt: number };
  }
>;
const REVALIDATE_MS = 10 * 60_000;

export interface CollectOptions {
  /** Every collector of this source and directory, this one included; the most specific wins. */
  peers?: CollectionSource[];
  exclude?: string[];
  cache?: CollectorCache;
  /** The harness login's access path; defaults to reading the history directory's harness home. */
  harness?: (
    source: CollectionSource['source'],
    directory: string,
  ) => 'subscription' | 'api' | undefined;
  now?: () => number;
}

/** A rejection the same snapshot will get again: invalid input or a refused write, not an outage. */
const deterministic = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    (error instanceof Error && error.name === 'ZodError') ||
    (typeof status === 'number' && status >= 400 && status < 500 && status !== 409)
  );
};

export async function collectSessions(
  archive: ArchiveWriter,
  config: CollectionSource,
  options: CollectOptions = {},
) {
  const sourceId = await archive.sourceId();
  const now = options.now ?? Date.now;
  const peers = options.peers ?? [config];
  const exclude = options.exclude ?? defaultExclusions();
  const cache: CollectorCache = options.cache ?? new Map();
  const routing = JSON.stringify([sourceId, config, peers, exclude]);
  const result = { imported: 0, unchanged: 0, skipped: 0, failed: 0 };
  // Per scan: checkouts change between scans.
  const rootSets = new Map<CollectionSource, Set<string>>();
  const roots = (collector: CollectionSource) => {
    if (!rootSets.has(collector)) rootSets.set(collector, collectionRoots(collector));
    return rootSets.get(collector)!;
  };
  const routes = new Map<string, CollectionSource | undefined>();
  const repositories = new Map<string, string | undefined>();
  const graphs = new Map<string, AtlasFileConcepts | undefined>();
  let harness: 'subscription' | 'api' | undefined | null = null;
  for (const file of transcriptFiles(config.directory)) {
    try {
      const before = lstatSync(file);
      const known = cache.get(file);
      if (
        known?.size === before.size &&
        known.mtimeMs === before.mtimeMs &&
        known.routing === routing
      ) {
        const stored = known.stored;
        if (!stored || now() - stored.checkedAt < REVALIDATE_MS) {
          result[known.outcome]++;
          continue;
        }
        if ((await archive.head(stored.id))?.digest === stored.digest) {
          stored.checkedAt = now();
          result.unchanged++;
          continue;
        }
      }
      const remember = (
        outcome: 'unchanged' | 'skipped' | 'failed',
        meta?: SessionMetadata,
        stored?: { id: string; digest: string },
      ) =>
        cache.set(file, {
          size: before.size,
          mtimeMs: before.mtimeMs,
          routing,
          outcome,
          meta,
          ...(stored ? { stored: { ...stored, checkedAt: now() } } : {}),
        });
      // A transcript's first cwd never changes, so it is read once per file.
      const meta = known?.meta ?? sessionMetadata(file, config.source);
      if (!meta) {
        result.skipped++;
        remember('skipped');
        continue;
      }
      if (!routes.has(meta.cwd))
        routes.set(meta.cwd, routeSession(meta.cwd, peers, { exclude, roots }));
      if (routes.get(meta.cwd) !== config) {
        result.skipped++;
        remember('skipped', meta);
        continue;
      }
      let snapshot: ReturnType<typeof importTranscriptFile>;
      try {
        snapshot = importTranscriptFile(file, {
          source: config.source,
          sourceId,
          projectId: config.projectId,
        });
      } catch {
        // The same bytes fail the same way; a partial file is retried once it changes.
        result.failed++;
        remember('failed', meta);
        continue;
      }
      const after = lstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        result.skipped++;
        continue;
      }
      const { cwd } = meta;
      if (!repositories.has(cwd)) repositories.set(cwd, git(cwd, 'remote', 'get-url', 'origin'));
      if (config.atlas && !graphs.has(cwd)) graphs.set(cwd, atlasGraph(cwd));
      const graph = graphs.get(cwd);
      snapshot.tags = [
        ...new Set([
          ...(config.tags ?? []),
          ...(graph ? atlasTags(snapshot, graph, roots(config)) : []),
        ]),
      ].slice(0, 100);
      const references = provenanceReferences({
        branch: meta.branch,
        repository: meta.repository ?? repositories.get(cwd),
      });
      if (references.length) snapshot.references = references;
      if (snapshot.runtime?.accessPath === 'unknown') {
        if (harness === null)
          harness = (options.harness ?? harnessAccess)(config.source, config.directory);
        if (harness)
          snapshot.runtime = { ...snapshot.runtime, accessPath: harness, evidence: 'harness' };
      }
      const id = archiveKey(snapshot);
      const old = await archive.head(id);
      // A session belongs to one project; only one the catch-all held moves to its routed project.
      if (old && old.projectId !== config.projectId && old.projectId !== UNROUTED) {
        result.failed++;
        remember('failed', meta);
        continue;
      }
      // An unchanged session is not sent again: the server already holds this digest.
      // Digest what the server will: the schema orders keys, and fields set above were appended.
      let digest: string;
      try {
        digest = snapshotDigest(archiveSnapshotSchema.parse(snapshot));
      } catch {
        // Over the archive's limits: the same bytes are refused again.
        result.failed++;
        remember('failed', meta);
        continue;
      }
      if (old?.digest === digest) result.unchanged++;
      else {
        try {
          const captured = await archive.capture(snapshot);
          digest = captured.digest;
          result[captured.changed ? 'imported' : 'unchanged']++;
        } catch (error) {
          result.failed++;
          if (deterministic(error)) remember('failed', meta);
          continue;
        }
      }
      remember('unchanged', meta, { id, digest });
    } catch {
      result.failed++;
    } // Partial/malformed files remain intact and retry on the next scan.
  }
  return result;
}
