import { createHash } from 'node:crypto';
import { typedPrompt } from './import';
import type { ArchiveSnapshot } from './index';
import type { TagDefinition } from './schemas';

/** Suggested for sessions that hold no real work: empty, aborted, probes, accidental starts. */
export const JUNK_TAG = 'junk';
/** `project:<projectId>`: the project a weakly routed session belongs to. */
export const PROJECT_TAG_PREFIX = 'project:';
/** The `by` of suggestions the prefilter made without asking a model. */
export const PREFILTER = 'prefilter';

/** What the tagger reads of a session: bounded excerpts and counts, never the whole transcript. */
export type SessionDigest = {
  title: string;
  source: ArchiveSnapshot['source'];
  projectId?: string;
  lineage?: { kind: string; agentType?: string };
  counts: { prompts: number; assistant: number; toolCalls: number; events: number };
  tools: [string, number][];
  /** The first typed prompts; a subagent's task when nothing was typed. */
  prompts: string[];
  task?: string;
  /** The first and last assistant text. */
  replies: string[];
  aborted: boolean;
};

const PROMPTS = 4;
const PROMPT_CHARS = 500;
const REPLY_CHARS = 400;
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const ABORTED = /^\s*\[Request interrupted by user/;

export function sessionDigest(snapshot: ArchiveSnapshot): SessionDigest {
  const prompts: string[] = [];
  const replies: string[] = [];
  const tools = new Map<string, number>();
  const counts = { prompts: 0, assistant: 0, toolCalls: 0, events: 0 };
  let task: string | undefined;
  let aborted = false;
  let lastReply: string | undefined;
  for (const entry of snapshot.entries) {
    if (ABORTED.test(entry.text)) aborted = true;
    if (entry.kind === 'user') {
      const typed = typedPrompt(entry.text);
      if (!typed) continue;
      counts.prompts++;
      if (prompts.length < PROMPTS) prompts.push(clip(typed, PROMPT_CHARS));
    } else if (entry.kind === 'assistant') {
      counts.assistant++;
      if (!entry.text.trim()) continue;
      if (!replies.length) replies.push(clip(entry.text, REPLY_CHARS));
      lastReply = entry.text;
    } else if (entry.kind === 'tool-call') {
      counts.toolCalls++;
      let name = 'tool';
      try {
        const call = JSON.parse(entry.text) as { name?: unknown; tool?: unknown };
        const found = call.name ?? call.tool;
        if (typeof found === 'string' && found) name = found.slice(0, 60);
      } catch {}
      tools.set(name, (tools.get(name) ?? 0) + 1);
    } else if (entry.kind === 'event') {
      counts.events++;
      // A subagent's task or an SDK caller's prompt; Foundry's events are structured records.
      if (snapshot.source !== 'foundry' && !entry.text.trimStart().startsWith('{'))
        task ??= typedPrompt(entry.text);
    }
  }
  if (lastReply !== undefined && counts.assistant > 1) replies.push(clip(lastReply, REPLY_CHARS));
  return {
    title: clip(snapshot.title, 200),
    source: snapshot.source,
    ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
    ...(snapshot.lineage
      ? {
          lineage: {
            kind: snapshot.lineage.kind,
            ...(snapshot.lineage.agentType ? { agentType: snapshot.lineage.agentType } : {}),
          },
        }
      : {}),
    counts,
    tools: [...tools].sort((a, b) => b[1] - a[1]).slice(0, 8),
    prompts,
    ...(!prompts.length && task ? { task: clip(task, PROMPT_CHARS) } : {}),
    replies,
    aborted,
  };
}

/** Junk without asking a model: nothing typed or tasked, and nothing done. */
export function prefilter(digest: SessionDigest): string[] | undefined {
  const { counts } = digest;
  const nothingDone = counts.assistant === 0 && counts.toolCalls === 0;
  if (nothingDone && (digest.aborted || (!counts.prompts && !digest.task))) return [JUNK_TAG];
  return undefined;
}

export const SUGGEST_PROMPT = `You sort archived coding-agent sessions. You get the category tags and projects first, then sessions (S1, S2, ...): title, counts, the first prompts the person typed (or a subagent's task), tools used, and the first and last replies.

For each session decide:
- junk: true only when the session holds no real work: empty, aborted before anything useful happened, a probe or connectivity check ("hi", "say OK", "test"), or an accidental start. A short session that asked something and got a useful answer is not junk. A subagent run that did its task is not junk.
- tags: zero to three of the listed category tags that describe what the session did. Use only listed tags; none fits gives [].
- project: only when the session's project is "unrouted" or missing: the listed project id it belongs to, or null when none clearly fits. Otherwise null.

Respond with JSON only, one key per session:
{"S1": {"junk": false, "tags": ["debugging"], "project": null}}`;

/** The stable part of every request: the category tags and the projects. */
export function suggestContext(definitions: TagDefinition[], projects: Record<string, string>) {
  const tags = definitions.map(
    (definition) =>
      `- ${definition.tag}${definition.description ? `: ${definition.description}` : ''}`,
  );
  const listed = Object.entries(projects).map(
    ([id, label]) => `- ${id}${label && label !== id ? `: ${label}` : ''}`,
  );
  return `## Category tags\n${tags.join('\n') || '(none)'}\n\n## Projects\n${listed.join('\n') || '(none)'}`;
}

export function renderSession(id: string, digest: SessionDigest) {
  const { counts } = digest;
  const lines = [
    `## ${id}`,
    `title: ${digest.title}`,
    `source: ${digest.source} · project: ${digest.projectId ?? 'missing'}${digest.lineage ? ` · ${digest.lineage.kind} run${digest.lineage.agentType ? ` (${digest.lineage.agentType})` : ''}` : ''}`,
    `counts: ${counts.prompts} typed prompts, ${counts.assistant} replies, ${counts.toolCalls} tool calls${digest.aborted ? ', interrupted' : ''}`,
  ];
  if (digest.tools.length)
    lines.push(`tools: ${digest.tools.map(([name, n]) => `${name} ×${n}`).join(', ')}`);
  if (digest.prompts.length) lines.push('prompts:', ...digest.prompts.map((p) => `> ${p}`));
  else if (digest.task) lines.push(`task: ${digest.task}`);
  if (digest.replies.length)
    lines.push(
      `first reply: ${digest.replies[0]}`,
      ...(digest.replies[1] ? [`last reply: ${digest.replies[1]}`] : []),
    );
  return lines.join('\n');
}

/** Suggestions are due again when the prompt, model or tag definitions change. */
export function suggestionKey(model: string, definitions: TagDefinition[]) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        SUGGEST_PROMPT,
        model,
        definitions.map((d) => [d.tag, d.description ?? '']).sort(),
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

function firstJson(content: string): Record<string, unknown> | undefined {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(content.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The model's answer as tags per session, `S1` first; undefined for a session it did not answer.
 * Only defined tags and listed projects survive, and only weakly routed sessions get a project.
 */
export function parseSuggestions(
  content: string,
  digests: SessionDigest[],
  allowed: { tags: Set<string>; projects: Set<string>; weak: (digest: SessionDigest) => boolean },
): (string[] | undefined)[] {
  const answer = firstJson(content);
  return digests.map((digest, index) => {
    const item = answer?.[`S${index + 1}`] as
      | { junk?: unknown; tags?: unknown; project?: unknown }
      | undefined;
    if (!item || typeof item !== 'object' || typeof item.junk !== 'boolean') return undefined;
    const tags = Array.isArray(item.tags)
      ? [...new Set(item.tags.filter((tag): tag is string => allowed.tags.has(tag)))].slice(0, 3)
      : [];
    const project =
      typeof item.project === 'string' && allowed.projects.has(item.project) && allowed.weak(digest)
        ? [`${PROJECT_TAG_PREFIX}${item.project}`]
        : [];
    return [...(item.junk ? [JUNK_TAG] : []), ...tags, ...project];
  });
}

export type TokenUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

/** A model the tagger asks: one decision per call, text only. */
export interface SuggestModel {
  readonly model: string;
  decide(request: {
    /** Calls on one key run one at a time; the tagger uses one key per concurrent worker. */
    key: string;
    instructions: string;
    context: string;
    input: string;
  }): Promise<{ content: string; tokens?: TokenUsage }>;
}

export type SuggestionDue = { archiveId: string; digest: string; session: SessionDigest };
export type SuggestionResult = {
  archiveId: string;
  digest: string;
  key: string;
  by: string;
  tags: string[];
};
export interface SuggestionArchive {
  tagDefinitions(): Promise<{ tags: TagDefinition[] }>;
  suggestionQueue(body: {
    key: string;
    limit: number;
    beforeId?: string;
    refresh?: boolean;
  }): Promise<{ items: SuggestionDue[]; projects: string[]; nextCursor: string | null }>;
  recordSuggestions(results: SuggestionResult[]): Promise<{
    recorded: number;
    stale: number;
    refused: number;
    dropped: number;
  }>;
}

export interface SuggestOptions {
  model: SuggestModel;
  /** Sessions per model call. Default 8. */
  batch?: number;
  /** Model calls at once. Default 2. */
  concurrency?: number;
  /** Sessions to consider this run, newest first. Default: every due session. */
  limit?: number;
  /** Suggest again for sessions whose suggestions are current. */
  refresh?: boolean;
  /** Readable labels for project ids (a collector's roots), shown to the model. */
  projectLabels?: Record<string, string>;
  progress?: (line: string) => void;
}

export interface SuggestReport {
  model: string;
  /** Sessions whose suggestions were missing or out of date. */
  due: number;
  prefiltered: number;
  asked: number;
  recorded: number;
  stale: number;
  refused: number;
  /** Suggested tags the archive does not offer, left out. */
  dropped: number;
  /** Sessions the model never answered. */
  unanswered: number;
  calls: number;
  failedCalls: number;
  errors: Record<string, number>;
  tokens: Required<TokenUsage>;
  /** Suggested tags this run, with counts. */
  tags: Record<string, number>;
}

const PAGE = 20;
const STOP_AFTER = 6;

async function pool<T>(
  items: T[],
  concurrency: number,
  run: (item: T, slot: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async (_, slot) => {
      while (next < items.length) await run(items[next++]!, slot);
    }),
  );
}

/**
 * Suggests tags for every session that is due: not exempt, and without suggestions for its current
 * digest and this key. The prefilter settles empty sessions; the rest go to the model in batches.
 * A batch the model fails is split and asked again; a run of failures stops the run.
 */
export async function runSuggestions(
  archive: SuggestionArchive,
  options: SuggestOptions,
): Promise<SuggestReport> {
  const batchSize = options.batch ?? 8;
  const concurrency = options.concurrency ?? 2;
  const model = options.model;
  const definitions = (await archive.tagDefinitions()).tags.map(({ tag, description }) => ({
    tag,
    ...(description ? { description } : {}),
  }));
  const key = suggestionKey(model.model, definitions);
  const report: SuggestReport = {
    model: model.model,
    due: 0,
    prefiltered: 0,
    asked: 0,
    recorded: 0,
    stale: 0,
    refused: 0,
    dropped: 0,
    unanswered: 0,
    calls: 0,
    failedCalls: 0,
    errors: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tags: {},
  };
  const allowedTags = new Set(definitions.map((d) => d.tag));
  let failedInARow = 0;
  const failure = (reason: string) => {
    report.failedCalls++;
    failedInARow++;
    const short = reason.slice(0, 160);
    report.errors[short] = (report.errors[short] ?? 0) + 1;
  };
  const record = async (results: SuggestionResult[]) => {
    if (!results.length) return;
    let outcome: Awaited<ReturnType<SuggestionArchive['recordSuggestions']>>;
    try {
      outcome = await archive.recordSuggestions(results);
    } catch (error) {
      // Not recorded: the sessions stay due for the next run.
      failure(`record: ${error instanceof Error ? error.message : String(error)}`);
      report.unanswered += results.length;
      return;
    }
    report.recorded += outcome.recorded;
    report.stale += outcome.stale;
    report.refused += outcome.refused;
    report.dropped += outcome.dropped;
    for (const result of results)
      for (const tag of result.tags) report.tags[tag] = (report.tags[tag] ?? 0) + 1;
  };
  let beforeId: string | undefined;
  for (;;) {
    const remaining =
      options.limit === undefined ? PAGE : Math.min(PAGE, options.limit - report.due);
    if (remaining <= 0 || failedInARow >= STOP_AFTER) break;
    const page = await archive.suggestionQueue({
      key,
      limit: remaining,
      ...(beforeId ? { beforeId } : {}),
      ...(options.refresh ? { refresh: true } : {}),
    });
    report.due += page.items.length;
    const projects: Record<string, string> = {};
    for (const id of page.projects) projects[id] = options.projectLabels?.[id] ?? id;
    const context = suggestContext(definitions, projects);
    const allowed = {
      tags: allowedTags,
      projects: new Set(page.projects),
      weak: (digest: SessionDigest) => !digest.projectId || digest.projectId === 'unrouted',
    };
    const settled: SuggestionResult[] = [];
    const ask: SuggestionDue[] = [];
    for (const item of page.items) {
      const tags = prefilter(item.session);
      if (tags) {
        report.prefiltered++;
        settled.push({ archiveId: item.archiveId, digest: item.digest, key, by: PREFILTER, tags });
      } else ask.push(item);
    }
    await record(settled);
    const batches: SuggestionDue[][] = [];
    for (let i = 0; i < ask.length; i += batchSize) batches.push(ask.slice(i, i + batchSize));
    const classify = async (batch: SuggestionDue[], slot: number): Promise<void> => {
      if (failedInARow >= STOP_AFTER) {
        report.unanswered += batch.length;
        return;
      }
      report.calls++;
      let answers: (string[] | undefined)[];
      try {
        const result = await model.decide({
          key: `archive-suggest:${slot}`,
          instructions: SUGGEST_PROMPT,
          context,
          input: batch.map((item, i) => renderSession(`S${i + 1}`, item.session)).join('\n\n'),
        });
        if (result.tokens) {
          report.tokens.input += result.tokens.input;
          report.tokens.output += result.tokens.output;
          report.tokens.cacheRead += result.tokens.cacheRead ?? 0;
          report.tokens.cacheWrite += result.tokens.cacheWrite ?? 0;
        }
        answers = parseSuggestions(
          result.content,
          batch.map((item) => item.session),
          allowed,
        );
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        if (batch.length > 1)
          for (const half of [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)])
            await classify(half, slot);
        else report.unanswered++;
        return;
      }
      const missing = batch.filter((_, i) => !answers[i]);
      if (missing.length === batch.length) {
        failure('unparseable answer');
        if (batch.length > 1)
          for (const half of [batch.slice(0, batch.length >> 1), batch.slice(batch.length >> 1)])
            await classify(half, slot);
        else report.unanswered++;
        return;
      }
      failedInARow = 0;
      report.asked += batch.length - missing.length;
      await record(
        batch.flatMap((item, i) =>
          answers[i]
            ? [
                {
                  archiveId: item.archiveId,
                  digest: item.digest,
                  key,
                  by: model.model,
                  tags: answers[i]!,
                },
              ]
            : [],
        ),
      );
      // A partial answer re-asks only what it missed, one at a time.
      for (const item of missing) await classify([item], slot);
    };
    await pool(batches, concurrency, classify);
    options.progress?.(
      `${report.due} due · ${report.prefiltered} prefiltered · ${report.asked} suggested · ${report.calls} calls`,
    );
    if (!page.nextCursor) break;
    beforeId = page.nextCursor;
  }
  return report;
}
