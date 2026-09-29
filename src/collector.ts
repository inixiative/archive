import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { importTranscriptFile } from './import-file';
import { archiveKey } from './index';
import type { LocalArchiveStore } from './local';

export interface CollectionSource {
  directory: string;
  source: 'codex' | 'claude-code';
  projectRoots: string[];
  projectId: string;
  /** Also match the git worktrees of each root; nested checkouts stay separate. */
  worktrees?: boolean;
  tags?: string[];
}

function files(directory: string): string[] {
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

/** Match provider metadata, never text/tags/model suggestions. No implicit parent-directory routing. */
function sessionDirectory(file: string, source: CollectionSource['source']) {
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
    const cwd =
      source === 'codex' ? (row.type === 'session_meta' ? row.payload?.cwd : undefined) : row.cwd;
    if (typeof cwd === 'string' && isAbsolute(cwd)) return resolve(cwd);
  }
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
  const roots = config.projectRoots.map((root) => resolve(root));
  return new Set(config.worktrees ? [...roots, ...roots.flatMap(worktreesOf)] : roots);
}

export async function collectSessions(store: LocalArchiveStore, config: CollectionSource) {
  const roots = collectionRoots(config);
  const result = { imported: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const file of files(config.directory)) {
    try {
      const cwd = sessionDirectory(file, config.source);
      // Exact root selection avoids sweeping nested checkouts belonging to another organization.
      if (!cwd || !roots.has(cwd)) {
        result.skipped++;
        continue;
      }
      const before = lstatSync(file);
      const snapshot = importTranscriptFile(file, {
        source: config.source,
        sourceId: store.sourceId,
        projectId: config.projectId,
      });
      const after = lstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        result.skipped++;
        continue;
      }
      const old = store.read(archiveKey(snapshot));
      if (old && old.snapshot.projectId !== config.projectId) {
        result.failed++;
        continue;
      }
      snapshot.tags = [...new Set([...(old?.snapshot.tags ?? []), ...(config.tags ?? [])])];
      if (store.capture(snapshot).changed) result.imported++;
      else result.unchanged++;
    } catch {
      result.failed++;
    } // Partial/malformed files remain intact and retry on the next scan.
  }
  return result;
}
