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
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cwdRunTags, exemptRun, temporaryRoots } from './exemption';
import { claudeSessionId } from './import';
import { importTranscriptFile, transcriptAgentId } from './import-file';
import {
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  snapshotDigest,
  UNROUTED,
} from './index';
import type { ArchiveClient } from './remote';
import { type AtlasFileConcepts, atlasTags, projectTags, provenanceReferences } from './tags';

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
 * Folder filters over a session's working directory, globs in the style of Atlas's `include` /
 * `ignore` and Gloss's `exclude`: a glob names folders and covers everything below them. They
 * apply to every match (exact roots, worktrees, subdirectories, catch-alls); exclude wins over
 * include, and with an `include` list only folders it names are collected at all.
 */
export type FolderFilters = { include?: string[]; exclude?: string[] };

/**
 * Excluded for every match unless a deployment drops them from its filters: decision receipts
 * (Foundry's primed Warden and middleware hosts, the repeat report's, the tagger's).
 */
export const defaultExclusions = () => ['**/decision-receipts'];

const escapeGlob = (path: string) => path.replace(/[[\]{}*?!\\]/g, '\\$&');

/**
 * A folder glob, normalized: `~/` expands to the home directory (taken literally), a leading `./`,
 * a trailing `/**` and trailing slashes go (a folder glob already covers everything below, so
 * Atlas's `dir/**` names `dir` too), and a relative glob matches at any depth (it gains a leading
 * `**` segment). An empty glob, one naming the filesystem root, or one with a `..` segment throws.
 */
export function folderGlob(entry: string): string {
  let glob = entry.trim();
  if (glob === '~' || glob.startsWith('~/')) glob = escapeGlob(homedir()) + glob.slice(1);
  glob = glob.replace(/^(\.\/)+/, '');
  for (let before = ''; before !== glob; ) {
    before = glob;
    glob = glob.replace(/\/+$/, '').replace(/\/\*\*$/, '');
  }
  if (!glob || glob === '.')
    throw new Error(`Folder glob "${entry}" is empty or names every folder`);
  if (glob.split('/').includes('..')) throw new Error(`Folder glob "${entry}" has a .. segment`);
  return glob.startsWith('/') || glob.startsWith('**') ? glob : `**/${glob}`;
}

/**
 * An exclude glob: a folder glob that does not cover the home directory or the filesystem root,
 * since excluding everything would stop capture silently until the harness's cleanup loses it.
 */
export function excludeGlob(entry: string): string {
  const glob = folderGlob(entry);
  if (folderMatches(homedir(), [glob]) || folderMatches('/', [glob]))
    throw new Error(`Exclude glob "${entry}" covers every session`);
  return glob;
}

const compiled = new Map<string, InstanceType<typeof Bun.Glob>>();
/** Whether a normalized folder glob names this directory or one of its ancestors. */
export function folderMatches(cwd: string, globs: readonly string[]) {
  if (!globs.length) return false;
  const matchers = globs.map((glob) => {
    if (!compiled.has(glob)) compiled.set(glob, new Bun.Glob(glob));
    return compiled.get(glob)!;
  });
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (matchers.some((matcher) => matcher.match(directory))) return true;
    if (directory === dirname(directory)) return false;
  }
}

/** Whether the folder filters let a session in this working directory be collected. */
export function folderAllowed(cwd: string, filters: FolderFilters) {
  if (folderMatches(cwd, filters.exclude ?? defaultExclusions())) return false;
  return !filters.include?.length || folderMatches(cwd, filters.include);
}

/**
 * Temp directories (test fixtures, agent scratchpads) are never swept in by a subdirectory or
 * catch-all match; an exact root in one is explicit and still matches.
 */
const temporary = (cwd: string) =>
  temporaryRoots().some((root) => cwd === root || cwd.startsWith(`${root}/`));

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

export type SessionMetadata = {
  cwd: string;
  branch?: string;
  repository?: string;
  /** The session id the import gives it (a Claude subagent: `<session>/agent-<id>`), for claims. */
  sessionId?: string;
};

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
    const claudeId = claudeSessionId(row, transcriptAgentId(file));
    return source === 'codex'
      ? {
          cwd: resolve(meta.cwd),
          branch: text(meta.git?.branch),
          repository: text(meta.git?.repository_url),
          ...(text(meta.id) ? { sessionId: text(meta.id) } : {}),
        }
      : {
          cwd: resolve(meta.cwd),
          branch: text(meta.gitBranch),
          ...(claudeId ? { sessionId: claudeId } : {}),
        };
  }
}

/**
 * A collector never waits on a child for long: macOS holds a launchd agent's access to protected
 * folders (Desktop, Documents) pending a privacy prompt nobody answers, which blocks git forever.
 */
const SPAWN_MS = 10_000;

const git = (cwd: string, ...args: string[]) => {
  const run = Bun.spawnSync(['git', '-C', cwd, ...args], { stderr: 'ignore', timeout: SPAWN_MS });
  return run.success ? run.stdout.toString().trim() : undefined;
};

function atlasGraph(cwd: string): AtlasFileConcepts | undefined {
  if (!existsSync(`${cwd}/.atlas`)) return;
  const run = Bun.spawnSync([process.execPath, 'x', 'atlas', 'graph', '--json'], {
    cwd,
    stderr: 'ignore',
    timeout: 12 * SPAWN_MS,
  });
  if (!run.success) return;
  try {
    return JSON.parse(run.stdout.toString()).fileToConcepts;
  } catch {}
}

function worktreesOf(root: string): string[] {
  const listed = Bun.spawnSync(['git', '-C', root, 'worktree', 'list', '--porcelain'], {
    stderr: 'ignore',
    timeout: SPAWN_MS,
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
 * The collector a session's cwd belongs to. The folder filters decide first, for every match. The
 * longest matching root wins: a root matches its own directory (and worktrees), and with
 * `subdirectories` the directories below it. Ties go to the first declared. Temp directories match
 * only exact roots. Unclaimed sessions go to the first catch-all.
 */
export function routeSession(
  cwd: string,
  collectors: CollectionSource[],
  options: { filters?: FolderFilters; roots?: (collector: CollectionSource) => Set<string> } = {},
) {
  if (!folderAllowed(cwd, options.filters ?? {})) return undefined;
  const rootsOf = options.roots ?? collectionRoots;
  const broad = !temporary(cwd);
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
export type ArchiveWriter = Pick<ArchiveClient, 'sourceId' | 'head' | 'capture' | 'claimState'> & {
  /** Needed only by a repair, to tell a collided row from one routed elsewhere. */
  read?: (id: string) => Promise<{ snapshot: Pick<ArchiveSnapshot, 'entries'> } | undefined>;
};

/** The stored row shares no entry with this transcript: it holds another session's content. */
async function collided(archive: ArchiveWriter, id: string, snapshot: ArchiveSnapshot) {
  const stored = await archive.read?.(id);
  if (!stored) return false;
  const own = new Set(snapshot.entries.map((entry) => entry.id));
  return !stored.snapshot.entries.some((entry) => own.has(entry.id));
}

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
    outcome: Outcome;
    meta?: SessionMetadata;
    stored?: { id: string; digest: string; checkedAt: number };
    /** Left to its claimant: asked again once the lease runs out (or the file changes). */
    claimedUntil?: number;
  }
>;
const REVALIDATE_MS = 10 * 60_000;
type Outcome = 'unchanged' | 'skipped' | 'held' | 'dropped' | 'failed';

export interface CollectOptions {
  /** Every collector of this source and directory, this one included; the most specific wins. */
  peers?: CollectionSource[];
  /** Folder filters; by default the built-in exclusions. */
  filters?: FolderFilters;
  /**
   * Every collector on this machine, of any source: a session is tagged `project:<projectId>` for
   * each project whose roots (and worktrees) hold a path its tool calls touched. Defaults to peers.
   */
  projects?: CollectionSource[];
  cache?: CollectorCache;
  /** The harness login's access path; defaults to reading the history directory's harness home. */
  harness?: (
    source: CollectionSource['source'],
    directory: string,
  ) => 'subscription' | 'api' | undefined;
  now?: () => number;
  /**
   * Take over a session another project holds only when its row holds another transcript: one
   * captured before subagent transcripts had their own identity holds a subagent's content under
   * its parent's key and the subagent's project, and the project guard would otherwise refuse the
   * parent's own transcript forever. A row holding this transcript keeps its project. Each
   * session re-imported, and each refusal with its reason, is reported.
   */
  repair?: boolean;
}

/**
 * One scan. `held`: sessions this collector now routes that another project already holds (most
 * often a checkout or worktree that was retired after capture); they stay with that project.
 * `dropped`: run sessions the server does not keep (`captureRunSessions` off). `refused` and
 * `heldBy` give the reason for each decided in this scan; a watching collector does not repeat
 * them for files that have not changed.
 */
export type CollectResult = {
  imported: number;
  unchanged: number;
  skipped: number;
  held: number;
  dropped: number;
  failed: number;
  repaired?: { file: string; sessionId: string; projectId: string; previousProjectId?: string }[];
  refused: { file: string; reason: string }[];
  heldBy: { file: string; projectId: string }[];
};

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
  const filters = options.filters ?? {};
  const projects = (options.projects ?? peers).filter((collector) => !collector.catchAll);
  const cache: CollectorCache = options.cache ?? new Map();
  const routing = JSON.stringify([sourceId, config, peers, filters, projects]);
  const result: CollectResult = {
    imported: 0,
    unchanged: 0,
    skipped: 0,
    held: 0,
    dropped: 0,
    failed: 0,
    refused: [],
    heldBy: [],
  };
  if (options.repair) result.repaired = [];
  const refuse = (file: string, error: unknown) => {
    result.failed++;
    result.refused.push({
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  };
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
        const claimed = known.claimedUntil;
        if (claimed !== undefined) {
          // Left to a live lease; once it runs out (the transcript unchanged), ask again below.
          if (now() < claimed) {
            result.skipped++;
            continue;
          }
        } else if (!stored || now() - stored.checkedAt < REVALIDATE_MS) {
          result[known.outcome]++;
          continue;
        } else if ((await archive.head(stored.id))?.digest === stored.digest) {
          stored.checkedAt = now();
          result.unchanged++;
          continue;
        }
      }
      const remember = (
        outcome: Outcome,
        meta?: SessionMetadata,
        stored?: { id: string; digest: string },
        claimedUntil?: number,
      ) =>
        cache.set(file, {
          size: before.size,
          mtimeMs: before.mtimeMs,
          routing,
          outcome,
          meta,
          ...(stored ? { stored: { ...stored, checkedAt: now() } } : {}),
          ...(claimedUntil !== undefined ? { claimedUntil } : {}),
        });
      // A session its driver records itself (Foundry) is its driver's while the lease is live, or
      // once fulfilled with the transcript unchanged since; otherwise (the driver died) it is
      // captured raw. Asked before the transcript is parsed.
      const claimed = async (sessionId: string, meta?: SessionMetadata) => {
        if (config.source !== 'claude-code' && config.source !== 'codex') return false;
        const claim = await archive.claimState(config.source, sessionId, before.mtimeMs);
        if (claim.state === 'live') remember('skipped', meta, undefined, claim.until ?? now());
        else if (claim.state === 'fulfilled') remember('skipped', meta);
        else return false;
        result.skipped++;
        return true;
      };
      // A transcript's first cwd never changes, so it is read once per file.
      const meta = known?.meta ?? sessionMetadata(file, config.source);
      if (!meta) {
        result.skipped++;
        remember('skipped');
        continue;
      }
      if (!routes.has(meta.cwd))
        routes.set(meta.cwd, routeSession(meta.cwd, peers, { filters, roots }));
      if (routes.get(meta.cwd) !== config) {
        result.skipped++;
        remember('skipped', meta);
        continue;
      }
      if (meta.sessionId && (await claimed(meta.sessionId, meta))) continue;
      let snapshot: ReturnType<typeof importTranscriptFile>;
      try {
        snapshot = importTranscriptFile(file, {
          source: config.source,
          sourceId,
          projectId: config.projectId,
        });
      } catch (error) {
        // The same bytes fail the same way; a partial file is retried once it changes.
        refuse(file, error);
        remember('failed', meta);
        continue;
      }
      const after = lstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        result.skipped++;
        continue;
      }
      if (snapshot.sessionId !== meta.sessionId && (await claimed(snapshot.sessionId, meta)))
        continue;
      const { cwd } = meta;
      if (!repositories.has(cwd)) repositories.set(cwd, git(cwd, 'remote', 'get-url', 'origin'));
      if (config.atlas && !graphs.has(cwd)) graphs.set(cwd, atlasGraph(cwd));
      const graph = graphs.get(cwd);
      // A marker counts only below every collector root; an inferred tag is marked as a guess.
      const ceilings = projects.flatMap((project) => [...roots(project)]);
      const run = exemptRun(config.tags ?? []) ? [] : cwdRunTags(cwd, ceilings);
      snapshot.tags = [
        ...new Set([
          ...run,
          ...(config.tags ?? []),
          ...projectTags(
            snapshot,
            projects.map((project) => ({ projectId: project.projectId, roots: roots(project) })),
            cwd,
          ),
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
      // A tombstone holds no project: a session deleted here comes back under today's routing.
      const moved =
        old && !old.deleted && old.projectId !== config.projectId && old.projectId !== UNROUTED;
      if (moved && !(options.repair && (await collided(archive, id, snapshot)))) {
        result.held++;
        result.heldBy.push({ file, projectId: old.projectId! });
        remember('held', meta);
        continue;
      }
      // An unchanged session is not sent again: the server already holds this digest.
      // Digest what the server will: the schema orders keys, and fields set above were appended.
      let digest: string;
      try {
        digest = snapshotDigest(archiveSnapshotSchema.parse(snapshot));
      } catch (error) {
        // Over the archive's limits: the same bytes are refused again.
        refuse(file, error);
        remember('failed', meta);
        continue;
      }
      if (old?.digest === digest) result.unchanged++;
      else {
        try {
          const captured = await archive.capture(snapshot);
          if (captured.dropped) {
            result.dropped++;
            remember('dropped', meta);
            continue;
          }
          digest = captured.digest;
          result[captured.changed ? 'imported' : 'unchanged']++;
          if (captured.changed)
            result.repaired?.push({
              file,
              sessionId: snapshot.sessionId,
              projectId: config.projectId,
              ...(moved ? { previousProjectId: old.projectId ?? undefined } : {}),
            });
        } catch (error) {
          refuse(file, error);
          if (deterministic(error)) remember('failed', meta);
          continue;
        }
      }
      remember('unchanged', meta, { id, digest });
    } catch (error) {
      refuse(file, error);
    } // Partial/malformed files remain intact and retry on the next scan.
  }
  return result;
}
