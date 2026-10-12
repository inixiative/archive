import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Runs that are not a person's work: tests and probes (`run:test`), Oracle and bench evaluations
 * (`run:oracle`). An exempt session is kept, but never feeds curation, suggestions, retention
 * scoring, correction mining or agent context. A person removing the tag lifts the exemption.
 *
 * Exemption rests on explicit stamps from the harness that ran the session:
 * - a `run:test` / `run:oracle` tag on the snapshot (a writer's own tags, `collect --tag`);
 * - `ARCHIVE_RUN=test|oracle` in the environment of a process that writes snapshots;
 * - a `.archive-run` file holding `test` or `oracle` in the session's working directory or an
 *   ancestor, written by the runner that made the workspace (`stampRunDirectory`).
 */
export const RUN_TAGS = { test: 'run:test', oracle: 'run:oracle' } as const;
export type RunKind = keyof typeof RUN_TAGS;
export const RUN_ENV = 'ARCHIVE_RUN';
export const RUN_MARKER = '.archive-run';

const runKind = (value: unknown): RunKind | undefined =>
  value === 'test' || value === 'oracle' ? value : undefined;

/** The run kind a session's tags exempt it as, if any; `run:oracle` wins over `run:test`. */
export function exemptRun(tags: readonly string[]): RunKind | undefined {
  if (tags.includes(RUN_TAGS.oracle)) return 'oracle';
  if (tags.includes(RUN_TAGS.test)) return 'test';
  return undefined;
}

/** The run tag this process is stamped with (`ARCHIVE_RUN`), for snapshots it writes. */
export function stampedRun(env: Record<string, string | undefined> = process.env) {
  const kind = runKind(env[RUN_ENV]?.trim());
  return kind && RUN_TAGS[kind];
}

/** Marks a workspace a test or eval harness made, so sessions run in it are exempt. */
export function stampRunDirectory(directory: string, kind: RunKind) {
  writeFileSync(join(directory, RUN_MARKER), `${kind}\n`);
}

/** The run tag a `.archive-run` file in the working directory or an ancestor stamps. */
export function markedRun(cwd: string): string | undefined {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const marker = join(directory, RUN_MARKER);
    if (existsSync(marker)) {
      try {
        const kind = runKind(readFileSync(marker, 'utf8').trim());
        if (kind) return RUN_TAGS[kind];
      } catch {}
    }
    if (directory === dirname(directory)) return undefined;
  }
}

/**
 * INTERIM inference, until every fixture and runner stamps explicitly; delete once they do.
 * Foundry's test fixtures as they exist today: project `P`, the watcher threads, and ACP client
 * probes outside a project.
 */
export function identityRunTags(session: {
  source: string;
  sessionId: string;
  projectId?: string | null;
  tags: readonly string[];
}): string[] {
  const { source, sessionId, projectId, tags } = session;
  const test =
    projectId === 'P' ||
    (source === 'foundry' && /^watch-[AB]$/.test(sessionId)) ||
    (source === 'foundry' &&
      (!projectId || projectId === 'P') &&
      tags.some((tag) => tag === 'acp' || tag.startsWith('acp:')));
  return test ? [RUN_TAGS.test] : [];
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
 * workspaces, a `.oracle` directory, bench run checkouts. Test: decision receipts, agent
 * scratchpads, anything under a temp directory.
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
  if (temporary || parts.includes('decision-receipts') || parts.includes('scratchpad'))
    return RUN_TAGS.test;
  return undefined;
}

/** The run tag for a session in this working directory: its stamp, else the interim inference. */
export const cwdRunTag = (cwd: string) => markedRun(cwd) ?? inferredRunTag(cwd);
