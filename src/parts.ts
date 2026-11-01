import { typedPrompt } from './import';
import { type ArchiveEntry, type ArchiveSnapshot, archiveSnapshotSchema, digest } from './index';
import { PROJECT_TAG_PREFIX } from './tags';

/** Why a span is redacted; the replacement text names the reason and nothing else. */
export const REDACTION_REASONS = [
  'coworker',
  'career',
  'personal-life',
  'investor',
  'secret',
  'other',
] as const;
export type RedactionReason = (typeof REDACTION_REASONS)[number];
/** A span of an entry, byte for byte, and why it is replaced. */
export type Redaction = { entryId: string; text: string; reason: RedactionReason };
export const redactionMarker = (reason: RedactionReason) => `[redacted: ${reason}]`;

/** A part's session id: its session's, then the first entry it holds. Stable across re-plans. */
export function partSessionId(sessionId: string, firstEntryId: string) {
  const id = `${sessionId}#part-${firstEntryId}`;
  // Identifiers are at most 256 characters.
  return id.length <= 256 ? id : `${sessionId.slice(0, 180)}#part-${digest(id).slice(0, 32)}`;
}

/** What a part publishes: its entry range, the entries kept in it, and its organizations' projects. */
export type PartSpec = {
  firstEntryId: string;
  lastEntryId: string;
  /** The range's entries that publish (not pruned), in order. */
  entryIds: string[];
  /** Projects of the organizations it goes to: only their `project:` tags and projectId travel. */
  projects: ReadonlySet<string>;
};

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * A part as a snapshot of its own: the kept entries of the range, every redaction's text replaced
 * wherever it appears (echoes included: a redaction only ever removes text), titled from its own
 * first prompt, carrying no references and only its organizations' project tags and projectId.
 * `source` is the session as it is stripped of tool activity, which is what the plan read.
 */
export function partSnapshot(
  source: ArchiveSnapshot,
  part: PartSpec,
  redactions: readonly Redaction[],
): ArchiveSnapshot {
  const keep = new Set(part.entryIds);
  const redact = (text: string) =>
    redactions.reduce(
      (current, r) => (r.text ? current.replaceAll(r.text, redactionMarker(r.reason)) : current),
      text,
    );
  const entries: ArchiveEntry[] = source.entries
    .filter((entry) => keep.has(entry.id))
    .map((entry) => ({ ...entry, text: redact(entry.text) }));
  const range = source.entries.map((e) => e.id);
  const span = range.indexOf(part.lastEntryId) - range.indexOf(part.firstEntryId) + 1;
  const redacted = source.entries.filter(
    (entry) => keep.has(entry.id) && redact(entry.text) !== entry.text,
  ).length;
  const first = entries.find((e) => e.kind === 'user' || e.kind === 'event');
  const root =
    source.lineage?.rootSessionId ??
    (source.lineage?.kind === 'part' ? undefined : source.lineage?.parentSessionId) ??
    source.sessionId;
  return archiveSnapshotSchema.parse({
    schemaVersion: 1,
    sourceId: source.sourceId,
    source: source.source,
    sessionId: partSessionId(source.sessionId, part.firstEntryId),
    title:
      (first ? flat(typedPrompt(first.text) ?? first.text).slice(0, 200) : '') || 'Session part',
    ...(source.projectId && part.projects.has(source.projectId)
      ? { projectId: source.projectId }
      : {}),
    ...(source.actor ? { actor: source.actor } : {}),
    ...(source.runtime ? { runtime: source.runtime } : {}),
    lineage: {
      kind: 'part',
      parentSessionId: source.sessionId,
      rootSessionId: root,
      firstEntryId: part.firstEntryId,
      lastEntryId: part.lastEntryId,
      ...(source.lineage?.agentType ? { agentType: source.lineage.agentType } : {}),
    },
    tags: source.tags.filter(
      (tag) =>
        !tag.startsWith(PROJECT_TAG_PREFIX) ||
        part.projects.has(tag.slice(PROJECT_TAG_PREFIX.length)),
    ),
    goalIds: source.goalIds,
    runIds: source.runIds,
    capturedAt: source.capturedAt,
    coverage: {
      reasoning: source.coverage.reasoning,
      completeness: 'partial',
      omissions: [
        ...source.coverage.omissions,
        `A part of its session: ${entries.length} of ${span} entries in its range; ${span - entries.length} pruned; ${redacted} redacted`,
      ].slice(-100),
    },
    entries,
  });
}
