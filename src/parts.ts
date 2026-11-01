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
/**
 * A span of an entry, byte for byte, and why it is replaced. `echoOnly`: a redaction that failed
 * validation (its text isn't the entry's byte for byte); its text is still removed wherever an echo
 * of it appears, ignoring case and whitespace.
 */
export type Redaction = {
  entryId: string;
  text: string;
  reason: RedactionReason;
  echoOnly?: boolean;
};

/**
 * The text with every occurrence of every redaction's span replaced, the spans found on the
 * original text and merged where they overlap or touch, so one redaction never hides another's
 * match. A merged span names each reason once.
 */
export function redactText(
  text: string,
  redactions: readonly Pick<Redaction, 'text' | 'reason' | 'echoOnly'>[],
  options: { roster?: readonly string[] } = {},
) {
  const spans: { start: number; end: number; reasons: RedactionReason[] }[] = [];
  for (const r of redactions) {
    if (!r.text || r.echoOnly) continue;
    for (let at = text.indexOf(r.text); at >= 0; at = text.indexOf(r.text, at + 1))
      spans.push({ start: at, end: at + r.text.length, reasons: [r.reason] });
  }
  spans.push(...echoSpans(text, redactions, options.roster ?? []));
  if (!spans.length) return text;
  spans.sort((a, b) => a.start - b.start);
  const merged = [spans[0]!];
  for (const span of spans.slice(1)) {
    const last = merged.at(-1)!;
    if (span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.reasons.push(...span.reasons);
    } else merged.push(span);
  }
  let out = '';
  let at = 0;
  for (const span of merged) {
    out += `${text.slice(at, span.start)}[redacted: ${[...new Set(span.reasons)].join(', ')}]`;
    at = span.end;
  }
  return out + text.slice(at);
}

/** The text lower-cased with whitespace runs collapsed, and each character's original index. */
function normalized(text: string) {
  let out = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!space) {
        out += ' ';
        at.push(i);
      }
      space = true;
      continue;
    }
    space = false;
    const lower = c.toLowerCase();
    out += lower.length === 1 ? lower : c;
    at.push(i);
  }
  return { out, at };
}
const words = (text: string) => normalized(text).out.trim().split(' ').filter(Boolean);

/**
 * Echoes of redacted spans, beyond the exact text: the span ignoring case and whitespace, every run
 * of four or more of its words, and the clause around each roster name the redactions name. They
 * only ever remove text.
 */
function echoSpans(
  text: string,
  redactions: readonly Pick<Redaction, 'text' | 'reason'>[],
  roster: readonly string[],
) {
  const spans: { start: number; end: number; reasons: RedactionReason[] }[] = [];
  const { out, at } = normalized(text);
  const find = (needle: string, reason: RedactionReason) => {
    if (!needle.trim()) return;
    for (let i = out.indexOf(needle); i >= 0; i = out.indexOf(needle, i + 1))
      spans.push({ start: at[i]!, end: at[i + needle.length - 1]! + 1, reasons: [reason] });
  };
  for (const r of redactions) {
    if (!r.text) continue;
    find(normalized(r.text).out.trim(), r.reason);
    const run = words(r.text);
    // Any shared run of four or more words is a union of shared runs of four.
    for (let i = 0; i + 4 <= run.length; i++) find(run.slice(i, i + 4).join(' '), r.reason);
    // A remark about a coworker: the clause around their name, written as the roster writes it,
    // wherever it appears. Only for coworker redactions, so a name that is also a word ("grant")
    // never takes work text with it.
    for (const name of r.reason === 'coworker' ? roster : []) {
      if (!new RegExp(`\\b${RegExp.escape(name)}\\b`, 'i').test(r.text)) continue;
      for (const match of text.matchAll(new RegExp(`\\b${RegExp.escape(name)}\\b`, 'gi'))) {
        const start = Math.max(
          ...['.', '!', '?', ';', '\n'].map((b) => text.lastIndexOf(b, match.index) + 1),
        );
        const ends = ['.', '!', '?', ';', '\n']
          .map((b) => text.indexOf(b, match.index))
          .filter((i) => i >= 0);
        const end = ends.length ? Math.min(...ends) : text.length;
        const lead = text.slice(start, match.index).match(/^\s*/)?.[0].length ?? 0;
        spans.push({ start: start + lead, end, reasons: [r.reason] });
      }
    }
  }
  return spans;
}

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
  /** Coworkers of those organizations: a remark about one is redacted wherever it is echoed. */
  roster?: readonly string[];
};

const TOOL_KINDS = new Set<string>(['tool-call', 'tool-result']);
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
  const redact = (text: string) => redactText(text, redactions, { roster: part.roster ?? [] });
  // Tool activity never publishes in a part, whatever the stored copy keeps.
  const entries: ArchiveEntry[] = source.entries
    .filter((entry) => keep.has(entry.id) && !TOOL_KINDS.has(entry.kind))
    .map((entry) => ({ ...entry, text: redact(entry.text) }));
  const range = source.entries.map((e) => e.id);
  const span = range.indexOf(part.lastEntryId) - range.indexOf(part.firstEntryId) + 1;
  const original = new Map(source.entries.map((e) => [e.id, e.text]));
  const redacted = entries.filter((entry) => entry.text !== original.get(entry.id)).length;
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
    // Only its organizations' project tags, and run tags so a destination can drop a run; no
    // concept tags, goals or runs of the whole session.
    tags: source.tags.filter((tag) =>
      tag.startsWith(PROJECT_TAG_PREFIX)
        ? part.projects.has(tag.slice(PROJECT_TAG_PREFIX.length))
        : tag.startsWith('run:'),
    ),
    goalIds: [],
    runIds: [],
    capturedAt: source.capturedAt,
    coverage: {
      reasoning: source.coverage.reasoning,
      completeness: 'partial',
      omissions: [
        `A part of its session: ${entries.length} of ${span} entries in its range; ${span - entries.length} pruned; ${redacted} redacted; tool activity is never kept`,
      ],
    },
    entries,
  });
}
