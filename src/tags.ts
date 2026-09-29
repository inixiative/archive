import { type ArchiveSnapshot, categorySuggestions } from './index';

export type TagSuggestion = { tag: string; origin: 'heuristic' | 'reference' };

const references: [RegExp, (match: RegExpExecArray) => string][] = [
  [
    /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g,
    (m) => `github:${m[1]}/${m[2]}#${m[3]}`.toLowerCase(),
  ],
  [
    /github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})\b/g,
    (m) => `github:${m[1]}/${m[2]}@${m[3].slice(0, 7)}`.toLowerCase(),
  ],
  [
    /linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/g,
    (m) => `linear:${m[1].toUpperCase()}`,
  ],
];

/** Issues, pull requests and commits the transcript links to, most-referenced first. A mention is not proof of work, so these stay suggestions. */
export function referenceSuggestions(snapshot: ArchiveSnapshot, limit = 25): TagSuggestion[] {
  const counts = new Map<string, number>();
  for (const entry of snapshot.entries)
    for (const [pattern, tag] of references)
      for (const match of entry.text.matchAll(pattern)) {
        const value = tag(match);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag]) => ({ tag, origin: 'reference' }));
}

/** Every computed suggestion for an archive. Suggestions never route or authorize. */
export function suggestTags(snapshot: ArchiveSnapshot): TagSuggestion[] {
  return [...categorySuggestions(snapshot), ...referenceSuggestions(snapshot)];
}

/** Recorded git context of a session, as explicit tags. */
export function provenanceTags(context: { repository?: string; branch?: string }): string[] {
  const repository = context.repository?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return [
    ...(repository ? [`repo:${repository[1].toLowerCase()}`] : []),
    ...(context.branch && context.branch !== 'HEAD' ? [`branch:${context.branch}`] : []),
  ].filter((tag) => tag.length <= 120);
}

/** `atlas graph --json`: repository-relative file paths to the concepts they are part of. */
export type AtlasFileConcepts = Record<string, { partOf: string[] }>;

/** Atlas concepts of the repository files a session's tool calls touched. */
export function atlasTags(
  snapshot: ArchiveSnapshot,
  fileToConcepts: AtlasFileConcepts,
  roots: Iterable<string>,
  limit = 20,
): string[] {
  // Longest first: worktrees can live inside their main checkout.
  const prefixes = [...roots]
    .map((root) => `${root.replace(/\/+$/, '')}/`)
    .sort((a, b) => b.length - a.length);
  const counts = new Map<string, number>();
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'tool-call') continue;
    for (const [path] of entry.text.matchAll(/[\w@.~/-]+\.[A-Za-z]{1,6}\b/g)) {
      const prefix = prefixes.find((candidate) => path.startsWith(candidate));
      const relative = prefix ? path.slice(prefix.length) : path;
      for (const concept of fileToConcepts[relative]?.partOf ?? [])
        counts.set(concept, (counts.get(concept) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([concept]) => `atlas:${concept}`)
    .filter((tag) => tag.length <= 120);
}
