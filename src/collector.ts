import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { importTranscriptFile } from './import-file';
import { archiveKey } from './index';
import type { ArchiveClient } from './remote';
import { type AtlasFileConcepts, atlasTags, provenanceReferences } from './tags';

export interface CollectionSource {
  directory: string;
  source: 'codex' | 'claude-code';
  projectRoots: string[];
  projectId: string;
  /** Also match the git worktrees of each root; nested checkouts stay separate. */
  worktrees?: boolean;
  /** Tag sessions with the Atlas concepts of files they touched, from `atlas graph` in the session's checkout. */
  atlas?: boolean;
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

type SessionMetadata = { cwd: string; branch?: string; repository?: string };

/** Match provider metadata, never text/tags/model suggestions. No implicit parent-directory routing. */
function sessionMetadata(
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
  const roots = config.projectRoots.map((root) => resolve(root));
  return new Set(config.worktrees ? [...roots, ...roots.flatMap(worktreesOf)] : roots);
}

/** Where collected sessions go: an Archive server, or a store in-process. */
export type ArchiveWriter = Pick<ArchiveClient, 'sourceId' | 'head' | 'capture'>;

export async function collectSessions(archive: ArchiveWriter, config: CollectionSource) {
  const sourceId = await archive.sourceId();
  const roots = collectionRoots(config);
  const result = { imported: 0, unchanged: 0, skipped: 0, failed: 0 };
  // Per scan: checkouts change between scans.
  const repositories = new Map<string, string | undefined>();
  const graphs = new Map<string, AtlasFileConcepts | undefined>();
  for (const file of files(config.directory)) {
    try {
      const meta = sessionMetadata(file, config.source);
      // Exact root selection avoids sweeping nested checkouts belonging to another organization.
      if (!meta || !roots.has(meta.cwd)) {
        result.skipped++;
        continue;
      }
      const before = lstatSync(file);
      const snapshot = importTranscriptFile(file, {
        source: config.source,
        sourceId,
        projectId: config.projectId,
      });
      const after = lstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        result.skipped++;
        continue;
      }
      const old = await archive.head(archiveKey(snapshot));
      if (old && old.projectId !== config.projectId) {
        result.failed++;
        continue;
      }
      const { cwd } = meta;
      if (!repositories.has(cwd)) repositories.set(cwd, git(cwd, 'remote', 'get-url', 'origin'));
      if (config.atlas && !graphs.has(cwd)) graphs.set(cwd, atlasGraph(cwd));
      const graph = graphs.get(cwd);
      snapshot.tags = [
        ...new Set([...(config.tags ?? []), ...(graph ? atlasTags(snapshot, graph, roots) : [])]),
      ].slice(0, 100);
      const references = provenanceReferences({
        branch: meta.branch,
        repository: meta.repository ?? repositories.get(cwd),
      });
      if (references.length) snapshot.references = references;
      if ((await archive.capture(snapshot)).changed) result.imported++;
      else result.unchanged++;
    } catch {
      result.failed++;
    } // Partial/malformed files remain intact and retry on the next scan.
  }
  return result;
}
