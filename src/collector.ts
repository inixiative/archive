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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { projectTags } from './evidence';
import { cwdRunTags, exemptRun, temporaryRoots } from './exemption';
import { claudeSessionId, EmptyTranscript, type TranscriptSource } from './import';
import { importTranscriptFile, museAncestors, transcriptAgentId } from './import-file';
import {
  type ArchiveSnapshot,
  archiveKey,
  archiveSnapshotSchema,
  snapshotDigest,
  UNROUTED,
} from './index';
import type { ArchiveClient } from './remote';
import { type AtlasFileConcepts, atlasTags, provenanceReferences } from './tags';

export { UNROUTED } from './index';

export interface CollectionSource {
  directory: string;
  source: TranscriptSource;
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

/**
 * The transcripts a collector reads: its history directory's, and for Codex the rollouts Codex
 * moved to `archived_sessions` beside `sessions`, which are sessions all the same. Muse writes
 * each session, and each of its subagents, as a `session.jsonl` in a directory of its own.
 */
export function historyFiles(config: Pick<CollectionSource, 'directory' | 'source'>) {
  const directory = resolve(config.directory);
  const archived = join(dirname(directory), 'archived_sessions');
  return [
    ...transcriptFiles(directory).filter(
      (file) => config.source !== 'muse' || basename(file) === 'session.jsonl',
    ),
    ...(config.source === 'codex' && directory.endsWith('/sessions') && existsSync(archived)
      ? transcriptFiles(archived)
      : []),
  ];
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

export type SessionMetadata = {
  cwd: string;
  branch?: string;
  repository?: string;
  /** The session id the import gives it (a Claude subagent: `<session>/agent-<id>`), for claims. */
  sessionId?: string;
};

/** A transcript's first megabyte, by a bounded synchronous read. */
function transcriptHead(file: string) {
  // Streamed readline could leave a watch loop waiting forever.
  const buffer = Buffer.alloc(Math.min(lstatSync(file).size, 1_000_000));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  return buffer.toString('utf8');
}

/**
 * A Muse session's id (its stream's) and working directory: the process's (`route_facts`), else
 * the workspace root its metadata names. A subagent records neither, and runs in its parent's.
 */
function museMetadata(file: string): SessionMetadata | undefined {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let root: string | undefined;
  for (const line of transcriptHead(file).split('\n')) {
    if (!line) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      break;
    }
    const record = row?.payload?.record;
    if (row?.stream?.kind === 'session' && typeof row.stream.id === 'string')
      sessionId ??= row.stream.id;
    if (row?.payload_type === 'runtime.session.route_facts' && typeof record?.cwd === 'string')
      cwd = record.cwd;
    const workspace = record?.workspace_root ?? record?.command?.session_metadata?.workspace_root;
    if (typeof workspace === 'string' && isAbsolute(workspace)) root ??= workspace;
    if (sessionId && cwd && isAbsolute(cwd)) break;
  }
  const at = cwd && isAbsolute(cwd) ? cwd : root;
  if (at) return { cwd: resolve(at), ...(sessionId ? { sessionId } : {}) };
  for (const ancestor of museAncestors(file)) {
    if (!existsSync(ancestor.file)) continue;
    const parent = museMetadata(ancestor.file);
    if (parent) return { cwd: parent.cwd, ...(sessionId ? { sessionId } : {}) };
  }
  return undefined;
}

/** Provider metadata, never text/tags/model suggestions; `routeSession` decides where it goes. */
export function sessionMetadata(
  file: string,
  source: CollectionSource['source'],
): SessionMetadata | undefined {
  if (source === 'muse') return museMetadata(file);
  for (const line of transcriptHead(file).split('\n')) {
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

export const git = (cwd: string, ...args: string[]) => {
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

function listWorktrees(root: string): string[] {
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

/** A root's worktree list is listed again at least this often: `worktree move` leaves `worktrees/` as it was. */
const WORKTREE_LIST_MS = 10 * 60_000;
const worktreeLists = new Map<
  string,
  { commonDirectory?: string; worktreesDirectory: string; listedAt: number; worktrees: string[] }
>();
/** When `<git common dir>/worktrees` last changed: `worktree add`, `remove` and `prune` change it. */
function worktreesDirectoryState(commonDirectory: string | undefined) {
  if (!commonDirectory) return 'no repository';
  try {
    const stat = lstatSync(join(commonDirectory, 'worktrees'));
    return `${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return 'no worktrees';
  }
}

/**
 * A root's git worktrees, listed again only when its repository's `worktrees` directory changes
 * or ten minutes have passed. Read before listing, so a worktree added meanwhile is listed again
 * on the next call, never missed.
 */
function worktreesOf(root: string, now: number): string[] {
  const known = worktreeLists.get(root);
  const current = known && now - known.listedAt < WORKTREE_LIST_MS ? known : undefined;
  const commonDirectory = current
    ? current.commonDirectory
    : git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const worktreesDirectory = worktreesDirectoryState(commonDirectory);
  if (current && current.worktreesDirectory === worktreesDirectory) return current.worktrees;
  const worktrees = commonDirectory ? listWorktrees(root) : [];
  worktreeLists.set(root, { commonDirectory, worktreesDirectory, listedAt: now, worktrees });
  return worktrees;
}

/**
 * Exact directories this collection accepts. Worktrees are listed again whenever the repository's
 * worktrees change, so a new one joins on the next scan.
 */
export function collectionRoots(config: CollectionSource, now = Date.now()): Set<string> {
  // Providers record the real path (macOS /tmp is /private/tmp), so roots match by it too.
  const roots = config.projectRoots.flatMap((root) => {
    try {
      return [...new Set([resolve(root), realpathSync(root)])];
    } catch {
      return [resolve(root)];
    }
  });
  return new Set(
    config.worktrees ? [...roots, ...roots.flatMap((root) => worktreesOf(root, now))] : roots,
  );
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
  /** The project map the server computes evidence under: a row computed under another is re-sent. */
  projectMapKey?: () => Promise<string | null>;
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
  // The Muse importer records its subscription itself.
  if (source === 'muse') return undefined;
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
 * there is captured again. One cache serves every collector of a scan.
 */
export type CollectorCache = Map<
  string,
  {
    size: number;
    mtimeMs: number;
    routing: string;
    /** The peer (by position) the session routed to; none when no collector takes it. */
    collector?: number;
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

/**
 * Whether a watching collector prints a scan: the first, one that imported or decided something
 * (a refusal, a held session, a repair), or one whose held, dropped or failed count moved since the
 * scan it last printed. Those counts include cached outcomes, so a steady count prints once.
 */
export function scanIsWorthPrinting(result: CollectResult, lastPrinted?: CollectResult) {
  return (
    !lastPrinted ||
    result.imported > 0 ||
    result.refused.length > 0 ||
    result.heldBy.length > 0 ||
    (result.repaired?.length ?? 0) > 0 ||
    (['held', 'dropped', 'failed'] as const).some((count) => result[count] !== lastPrinted[count])
  );
}

const emptyResult = (repair?: boolean): CollectResult => ({
  imported: 0,
  unchanged: 0,
  skipped: 0,
  held: 0,
  dropped: 0,
  failed: 0,
  ...(repair ? { repaired: [] } : {}),
  refused: [],
  heldBy: [],
});

/** One collector's scan, routed against its peers; the same walk as every peer's, counted for it alone. */
export async function collectSessions(
  archive: ArchiveWriter,
  config: CollectionSource,
  options: CollectOptions = {},
) {
  const { peers = [config], ...rest } = options;
  const only = peers.indexOf(config);
  if (only < 0) throw new Error('A collector is routed against peers it is not one of');
  return (await collectSessionsForPeers(archive, peers, { ...rest, only }))[only]!;
}

/**
 * One scan of one history directory for every collector over it (peers: one source and
 * directory): each transcript is read once and handed to the collector it routes to. Results line
 * up with peers, each counted as that collector alone would count it, so a session routed to
 * another is `skipped` for it. With `only`, sessions routed to any other peer are not imported.
 */
export async function collectSessionsForPeers(
  archive: ArchiveWriter,
  peers: CollectionSource[],
  options: Omit<CollectOptions, 'peers'> & { only?: number } = {},
): Promise<CollectResult[]> {
  const group = peers[options.only ?? 0];
  if (!group) return [];
  const sourceId = await archive.sourceId();
  const now = options.now ?? Date.now;
  const filters = options.filters ?? {};
  const projects = (options.projects ?? peers).filter((collector) => !collector.catchAll);
  const cache: CollectorCache = options.cache ?? new Map();
  const routing = JSON.stringify([sourceId, options.only ?? null, peers, filters, projects]);
  const results = peers.map(() => emptyResult(options.repair));
  // Every file settles once: its collector counts the outcome, every other peer counts it skipped.
  const settle = (collector: number | undefined, outcome: Outcome | 'imported') => {
    results.forEach((result, index) => {
      result[index === collector ? outcome : 'skipped']++;
    });
  };
  // Refused before routing, a file fails for every peer, as each would have read it.
  const refuse = (collector: number | undefined, file: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    results.forEach((result, index) => {
      if (collector !== undefined && index !== collector) result.skipped++;
      else {
        result.failed++;
        result.refused.push({ file, reason });
      }
    });
  };
  // Per scan, by root path: checkouts change between scans.
  const rootSets = new Map<string, Set<string>>();
  const roots = (collector: CollectionSource) => {
    const key = JSON.stringify([collector.projectRoots, Boolean(collector.worktrees)]);
    if (!rootSets.has(key)) rootSets.set(key, collectionRoots(collector, now()));
    return rootSets.get(key)!;
  };
  const routes = new Map<string, number | undefined>();
  const repositories = new Map<string, string | undefined>();
  const graphs = new Map<string, AtlasFileConcepts | undefined>();
  let harness: 'subscription' | 'api' | undefined | null = null;
  const mapKey = (await archive.projectMapKey?.()) ?? null;
  for (const file of historyFiles(group)) {
    let collector: number | undefined;
    try {
      const before = lstatSync(file);
      const known = cache.get(file);
      if (
        known?.size === before.size &&
        known.mtimeMs === before.mtimeMs &&
        known.routing === routing
      ) {
        collector = known.collector;
        const stored = known.stored;
        const claimed = known.claimedUntil;
        if (claimed !== undefined) {
          // Left to a live lease; once it runs out (the transcript unchanged), ask again below.
          if (now() < claimed) {
            settle(known.collector, 'skipped');
            continue;
          }
        } else if (!stored || now() - stored.checkedAt < REVALIDATE_MS) {
          settle(known.collector, known.outcome);
          continue;
        } else if ((await archive.head(stored.id))?.digest === stored.digest) {
          stored.checkedAt = now();
          settle(known.collector, 'unchanged');
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
          ...(collector !== undefined ? { collector } : {}),
          outcome,
          meta,
          ...(stored ? { stored: { ...stored, checkedAt: now() } } : {}),
          ...(claimedUntil !== undefined ? { claimedUntil } : {}),
        });
      // A session its driver records itself (Foundry) is its driver's while the lease is live, or
      // once fulfilled with the transcript unchanged since; otherwise (the driver died) it is
      // captured raw. Asked before the transcript is parsed.
      const claimed = async (sessionId: string, meta?: SessionMetadata) => {
        if (group.source !== 'claude-code' && group.source !== 'codex') return false;
        const claim = await archive.claimState(group.source, sessionId, before.mtimeMs);
        if (claim.state === 'live') remember('skipped', meta, undefined, claim.until ?? now());
        else if (claim.state === 'fulfilled') remember('skipped', meta);
        else return false;
        settle(collector, 'skipped');
        return true;
      };
      // A transcript's first cwd never changes, so it is read once per file.
      const meta = known?.meta ?? sessionMetadata(file, group.source);
      if (!meta) {
        collector = undefined;
        settle(collector, 'skipped');
        remember('skipped');
        continue;
      }
      if (!routes.has(meta.cwd)) {
        const routed = routeSession(meta.cwd, peers, { filters, roots });
        routes.set(meta.cwd, routed ? peers.indexOf(routed) : undefined);
      }
      collector = routes.get(meta.cwd);
      const config = collector === undefined ? undefined : peers[collector];
      const result = collector === undefined ? undefined : results[collector];
      if (!config || !result || (options.only !== undefined && collector !== options.only)) {
        settle(collector, 'skipped');
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
        // Nothing to capture yet: read again once the file changes.
        if (error instanceof EmptyTranscript) {
          settle(collector, 'skipped');
          remember('skipped', meta);
          continue;
        }
        // The same bytes fail the same way; a partial file is retried once it changes.
        refuse(collector, file, error);
        remember('failed', meta);
        continue;
      }
      const after = lstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        settle(collector, 'skipped');
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
          harness = (options.harness ?? harnessAccess)(group.source, group.directory);
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
        // Held by its project, but its evidence predates the map: the same transcript under that
        // project is sent again, which recomputes the evidence and changes nothing else.
        if (mapKey && old.evidenceKey !== mapKey)
          await archive.capture(snapshot, { cwd, evidenceOnly: true });
        settle(collector, 'held');
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
        refuse(collector, file, error);
        remember('failed', meta);
        continue;
      }
      // Unchanged, unless its evidence predates the server's project map (a new worktree or project).
      if (old?.digest === digest && (old.deleted || !mapKey || old.evidenceKey === mapKey))
        settle(collector, 'unchanged');
      else {
        try {
          const captured = await archive.capture(snapshot, { cwd });
          if (captured.dropped) {
            settle(collector, 'dropped');
            remember('dropped', meta);
            continue;
          }
          digest = captured.digest;
          settle(collector, captured.changed ? 'imported' : 'unchanged');
          if (captured.changed)
            result.repaired?.push({
              file,
              sessionId: snapshot.sessionId,
              projectId: config.projectId,
              ...(moved ? { previousProjectId: old.projectId ?? undefined } : {}),
            });
        } catch (error) {
          refuse(collector, file, error);
          if (deterministic(error)) remember('failed', meta);
          continue;
        }
      }
      remember('unchanged', meta, { id, digest });
    } catch (error) {
      refuse(collector, file, error);
    } // Partial/malformed files remain intact and retry on the next scan.
  }
  return results;
}
