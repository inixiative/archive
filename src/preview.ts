import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importTranscriptFile } from './import-file';

/** Inspect explicit source paths without opening an archive store or publishing data. */
export function previewImports(path: string, source: 'codex' | 'claude-code', limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Preview limit must be between 1 and 1000');
  const files: string[] = [];
  let truncated = false;
  const visit = (candidate: string) => {
    if (files.length > limit) {
      truncated = true;
      return;
    }
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(candidate).sort()) {
        visit(join(candidate, entry));
        if (files.length > limit) break;
      }
    } else if (stat.isFile() && candidate.endsWith('.jsonl')) files.push(candidate);
  };
  visit(resolve(path));
  truncated ||= files.length > limit;
  const sessions = files.slice(0, limit).map((file) => {
    try {
      const snapshot = importTranscriptFile(file, {
        source,
        sourceId: '00000000-0000-4000-8000-000000000000',
      });
      return {
        file,
        status: 'ready' as const,
        source,
        sessionId: snapshot.sessionId,
        title: snapshot.title,
        entries: snapshot.entries.length,
        characters: snapshot.entries.reduce((n, entry) => n + entry.text.length, 0),
        coverage: snapshot.coverage,
      };
    } catch (error) {
      return {
        file,
        status: 'rejected' as const,
        error: error instanceof Error ? error.message : 'Unable to inspect transcript',
      };
    }
  });
  return {
    sessions,
    truncated,
    ready: sessions.filter((session) => session.status === 'ready').length,
    rejected: sessions.filter((session) => session.status === 'rejected').length,
  };
}
