import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Runs that are not a person's work: tests and probes (`run:test`), Oracle and bench evaluations
 * (`run:oracle`), and sessions Foundry itself starts (`run:foundry`: Wardens, middleware roles,
 * classifiers). An exempt session never feeds curation, suggestions, retention scoring,
 * correction mining or agent context. A person removing the tag lifts the exemption.
 *
 * Only explicit stamps make a session a run an Archive with `captureRunSessions` off drops:
 * - a run tag on the snapshot (a writer's own tags, `collect --tag`);
 * - `ARCHIVE_RUN=test|oracle|foundry` in the environment of a process that writes snapshots;
 * - a `.archive-run` file holding the run kind in the session's working directory or an
 *   ancestor below every collector root, written by the runner that made the workspace
 *   (`stampRunDirectory`);
 * - Foundry's own subagent types (`foundryAgentRun`);
 * - a run tag a person added.
 * Interim inferences (from a working directory, or a test fixture's identity) only exempt: the
 * session is kept. The collector marks an inferred tag with `run:inferred`.
 */
export const RUN_TAGS = { test: 'run:test', oracle: 'run:oracle', foundry: 'run:foundry' } as const;
export type RunKind = keyof typeof RUN_TAGS;
export const RUN_ENV = 'ARCHIVE_RUN';
export const RUN_MARKER = '.archive-run';
/** Beside a run tag the collector inferred from the working directory: exempt, never dropped. */
export const RUN_INFERRED = 'run:inferred';

export const RUN_KINDS = Object.keys(RUN_TAGS) as RunKind[];
const runKind = (value: unknown): RunKind | undefined => RUN_KINDS.find((kind) => kind === value);

/** The run kind a session's tags exempt it as, if any, in the order `oracle`, `foundry`, `test`. */
export function exemptRun(tags: readonly string[]): RunKind | undefined {
  if (tags.includes(RUN_TAGS.oracle)) return 'oracle';
  if (tags.includes(RUN_TAGS.foundry)) return 'foundry';
  if (tags.includes(RUN_TAGS.test)) return 'test';
  return undefined;
}

/** The run tag this process is stamped with (`ARCHIVE_RUN`), for snapshots it writes. */
export function stampedRun(env: Record<string, string | undefined> = process.env) {
  const kind = runKind(env[RUN_ENV]?.trim());
  return kind && RUN_TAGS[kind];
}

/**
 * Marks a workspace a test or eval harness made, so sessions run in it are runs. Refuses a
 * relative path, the filesystem root, the home directory and a git work tree's root: a marker
 * there would stamp a person's sessions.
 */
export function stampRunDirectory(directory: string, kind: RunKind) {
  if (!directory || !isAbsolute(directory))
    throw new Error('A run marker needs an absolute directory');
  const target = resolve(directory);
  if (target === dirname(target) || target === resolve(homedir()))
    throw new Error(`Refusing a run marker in ${target}`);
  if (existsSync(join(target, '.git')))
    throw new Error(`Refusing a run marker at the root of a git work tree (${target})`);
  writeFileSync(join(target, RUN_MARKER), `${kind}\n`);
}

/**
 * The run tag a `.archive-run` file in the working directory or an ancestor stamps. Markers at the
 * filesystem root, the home directory, or at or above any of `ceilings` (collector roots) are
 * ignored, so one stray file never stamps a project's sessions.
 */
export function markedRun(cwd: string, ceilings: Iterable<string> = []): string | undefined {
  const stops = [...ceilings].map((root) => resolve(root));
  const home = resolve(homedir());
  const ceiling = (directory: string) =>
    directory === dirname(directory) ||
    directory === home ||
    stops.some((root) => root === directory || root.startsWith(`${directory}/`));
  for (let directory = resolve(cwd); !ceiling(directory); directory = dirname(directory)) {
    const marker = join(directory, RUN_MARKER);
    if (existsSync(marker)) {
      try {
        const kind = runKind(readFileSync(marker, 'utf8').trim());
        if (kind) return RUN_TAGS[kind];
      } catch {}
    }
  }
  return undefined;
}

/**
 * Agent types Foundry gives the subagents it starts inside a person's session (in-session Wardens:
 * their root, dispatchers and members) and inside its decision hosts (`d-`/`w-` and 16 hex). Its
 * permission hook refuses these types to anyone else, so matching them never drops a real subagent.
 */
const FOUNDRY_AGENT_TYPE = /^(?:foundry-(?:root|dispatch|warden)|[dw]-[0-9a-f]{16})$/;

/** `run:foundry` for one of Foundry's own subagents, by its recorded agent type (explicit). */
export const foundryAgentRun = (lineage?: { agentType?: string } | null) =>
  lineage?.agentType && FOUNDRY_AGENT_TYPE.test(lineage.agentType) ? RUN_TAGS.foundry : undefined;

/**
 * The run tags a session's identity implies: Foundry's own subagents (explicit), and, INTERIM until
 * every fixture stamps (exempt only; delete then), `run:test` for Foundry's test fixtures as they
 * exist today: project `P` and the watcher threads.
 */
export function identityRunTags(session: {
  source: string;
  sessionId: string;
  projectId?: string | null;
  lineage?: { agentType?: string } | null;
}): string[] {
  const foundry = foundryAgentRun(session.lineage);
  if (foundry) return [foundry];
  const { source, sessionId, projectId } = session;
  const test = projectId === 'P' || (source === 'foundry' && /^watch-[AB]$/.test(sessionId));
  return test ? [RUN_TAGS.test] : [];
}

/**
 * The run kind that lets an Archive with `captureRunSessions` off drop a snapshot: an explicit run
 * tag (not one the collector marked `run:inferred`) or a Foundry subagent type.
 */
export function droppableRun(snapshot: {
  tags: readonly string[];
  lineage?: { agentType?: string } | null;
}): RunKind | undefined {
  if (foundryAgentRun(snapshot.lineage)) return 'foundry';
  return snapshot.tags.includes(RUN_INFERRED) ? undefined : exemptRun(snapshot.tags);
}

/** The OS temp directories, by path and real path (macOS `/tmp` is `/private/tmp`). */
export const temporaryRoots = () => [
  ...new Set(
    ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()].flatMap((path) => {
      try {
        return [resolve(path), realpathSync(path)];
      } catch {
        return [resolve(path)];
      }
    }),
  ),
];
const under = (cwd: string, root: string) => cwd === root || cwd.startsWith(`${root}/`);
const segments = (cwd: string) => cwd.split('/').filter(Boolean);

/**
 * INTERIM inference from a working directory, for sessions no harness stamped; delete once the
 * fixtures and runners that make these directories write `.archive-run`. Oracle: its eval
 * workspaces, a `.oracle` directory, bench run checkouts. Foundry: the primed host fixtures its
 * Wardens, chorus and classifiers run in (`decision-receipts/primed-<host>/fixture`). Test: other
 * decision receipts, agent scratchpads, anything under a temp directory.
 */
export function inferredRunTag(cwd: string): string | undefined {
  const parts = segments(cwd);
  const temporary = temporaryRoots().some((root) => under(cwd, root));
  if (
    parts.includes('.oracle') ||
    parts.some(
      (part, i) => (part === '.runs' || part === '.runs-archive') && parts[i - 1] === 'bench',
    ) ||
    (temporary && parts.some((part) => /^oracle-/.test(part)))
  )
    return RUN_TAGS.oracle;
  if (parts.some((part, i) => part === 'decision-receipts' && /^primed-/.test(parts[i + 1] ?? '')))
    return RUN_TAGS.foundry;
  if (temporary || parts.includes('decision-receipts') || parts.includes('scratchpad'))
    return RUN_TAGS.test;
  return undefined;
}

/** The run tag for a session in this working directory: its stamp, else the interim inference. */
export const cwdRunTag = (cwd: string, ceilings: Iterable<string> = []) =>
  markedRun(cwd, ceilings) ?? inferredRunTag(cwd);

/**
 * The tags a collector stamps for a working directory: the marker's run tag, or an inferred one
 * with `run:inferred` beside it (exempt, never dropped).
 */
export function cwdRunTags(cwd: string, ceilings: Iterable<string> = []): string[] {
  const marked = markedRun(cwd, ceilings);
  if (marked) return [marked];
  const inferred = inferredRunTag(cwd);
  return inferred ? [inferred, RUN_INFERRED] : [];
}
