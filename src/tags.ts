import { z } from 'zod';
import { type ArchiveReference, type ArchiveSnapshot, categorySuggestions } from './index';

/** A conceptual tag the archive proposes; suggestions never route or authorize. */
export type TagSuggestion = { tag: string; origin: 'heuristic' };

/**
 * An integration whose items sessions can reference. GitHub and Linear links are recognized
 * natively; any other integration supplies a pattern whose first group (or whole match) is the item.
 */
export const archiveIntegrationSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(100),
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((pattern) => {
      try {
        new RegExp(pattern, 'g');
        return true;
      } catch {
        return false;
      }
    }, 'Invalid pattern')
    .optional(),
});
export type ArchiveIntegration = z.infer<typeof archiveIntegrationSchema>;

export const defaultIntegrations: ArchiveIntegration[] = [
  { key: 'github', name: 'GitHub' },
  { key: 'linear', name: 'Linear' },
];

type Extractor = [RegExp, (match: RegExpExecArray) => string];
const nativeExtractors: Record<string, Extractor[]> = {
  github: [
    [
      /github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/g,
      (m) => `${m[1]}/${m[2]}#${m[3]}`.toLowerCase(),
    ],
    [
      /github\.com\/([\w.-]+)\/([\w.-]+)\/commit\/([0-9a-f]{7,40})\b/g,
      (m) => `${m[1]}/${m[2]}@${m[3].slice(0, 7)}`.toLowerCase(),
    ],
  ],
  linear: [[/linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/g, (m) => m[1].toUpperCase()]],
};

function extractors(integration: ArchiveIntegration): Extractor[] {
  if (integration.pattern)
    return [[new RegExp(integration.pattern, 'g'), (m) => (m[1] ?? m[0]).slice(0, 300)]];
  return nativeExtractors[integration.key] ?? [];
}

export type ArchiveReferenceCount = ArchiveReference & { recorded: boolean; mentions: number };

/**
 * References to the archive's integrations: recorded ones first, then linked ones, most-linked
 * first. A link is not proof of work, so linked references are evidence, not assignments.
 */
export function archiveReferences(
  snapshot: ArchiveSnapshot,
  integrations: ArchiveIntegration[] = defaultIntegrations,
  limit = 25,
): ArchiveReferenceCount[] {
  const known = new Set(integrations.map((integration) => integration.key));
  const found = new Map<string, ArchiveReferenceCount>();
  const key = (reference: ArchiveReference) =>
    JSON.stringify([reference.integration, reference.ref]);
  for (const reference of snapshot.references ?? [])
    if (known.has(reference.integration))
      found.set(key(reference), { ...reference, recorded: true, mentions: 0 });
  for (const integration of integrations)
    for (const [pattern, ref] of extractors(integration))
      for (const entry of snapshot.entries)
        for (const match of entry.text.matchAll(pattern)) {
          const reference = { integration: integration.key, ref: ref(match) };
          if (!reference.ref) continue;
          const current = found.get(key(reference)) ?? {
            ...reference,
            recorded: false,
            mentions: 0,
          };
          current.mentions++;
          found.set(key(reference), current);
        }
  return [...found.values()]
    .sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.mentions - a.mentions)
    .slice(0, limit);
}

/** Every computed tag suggestion for an archive. */
export function suggestTags(snapshot: ArchiveSnapshot): TagSuggestion[] {
  return categorySuggestions(snapshot);
}

/** Recorded git context of a session, as GitHub references to its repository and branch. */
export function provenanceReferences(context: {
  repository?: string;
  branch?: string;
}): ArchiveReference[] {
  const repository = context.repository
    ?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1]
    .toLowerCase();
  if (!repository) return [];
  return [
    { integration: 'github', ref: repository },
    ...(context.branch && context.branch !== 'HEAD'
      ? [{ integration: 'github', ref: `${repository}/tree/${context.branch}` }]
      : []),
  ].filter((reference) => reference.ref.length <= 300);
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
