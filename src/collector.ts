import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { importTranscriptFile } from './import-file';
import { archiveKey } from './index';
import type { LocalArchiveStore } from './local';

export interface CollectionSource {
  directory: string;
  source: 'codex' | 'claude-code';
  projectRoot: string;
  projectId: string;
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
async function sessionDirectory(file: string, source: CollectionSource['source']) {
  const input = createReadStream(file, { encoding: 'utf8', end: 1_000_000 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
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
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function collectSessions(store: LocalArchiveStore, config: CollectionSource) {
  const root = resolve(config.projectRoot);
  const result = { imported: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const file of files(config.directory)) {
    try {
      const cwd = await sessionDirectory(file, config.source);
      // Exact root selection avoids sweeping nested checkouts belonging to another organization.
      if (!cwd || relative(root, cwd) !== '') {
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
