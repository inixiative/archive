import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Runs that are not a person's work: tests and probes (`run:test`), Oracle and bench evaluations
 * (`run:oracle`). An exempt session is kept, but never feeds curation, suggestions, retention
 * scoring, correction mining or agent context. A person removing the tag lifts the exemption.
 */
export const RUN_TAGS = { test: 'run:test', oracle: 'run:oracle' } as const;
export type RunKind = keyof typeof RUN_TAGS;

/** The run kind a session's tags exempt it as, if any; `run:oracle` wins over `run:test`. */
export function exemptRun(tags: readonly string[]): RunKind | undefined {
  if (tags.includes(RUN_TAGS.oracle)) return 'oracle';
  if (tags.includes(RUN_TAGS.test)) return 'test';
  return undefined;
}

/** Foundry's test fixtures: project `P`, the watcher threads, and ACP client probes outside a project. */
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
 * The run tag a session's working directory implies. Oracle: its eval and environment-check
 * workspaces, a `.oracle` directory, and bench run checkouts. Test: decision receipts (Foundry's
 * and every primed decision host's), agent scratchpads, and anything else under a temp directory
 * (VCR scenarios, live-test and controlled-transport fixtures).
 */
export function cwdRunTag(cwd: string): string | undefined {
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
