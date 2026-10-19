import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { ArchiveReference, ArchiveSnapshot } from './index';

/**
 * A tag the tagger's model proposes; suggestions never route or authorize, and a person applies them.
 */
export type TagSuggestion = { tag: string; origin: 'model' };

/**
 * An integration whose items sessions can reference. GitHub and Linear links are recognized
 * natively; any other integration names the link prefix of its items, and the item is what
 * follows. A literal prefix keeps matching linear in the text, whatever settings say.
 */
export const archiveIntegrationSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(100),
  prefix: z.string().min(3).max(300).optional(),
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
  if (integration.prefix)
    return [
      [
        new RegExp(`${RegExp.escape(integration.prefix)}([\\w.~#/-]{1,300})`, 'g'),
        (m) => m[1].replace(/[./]+$/, ''),
      ],
    ];
  return nativeExtractors[integration.key] ?? [];
}

export type ArchiveReferenceCount = ArchiveReference & { recorded: boolean; mentions: number };

/**
 * Every link to the integrations' items in a text, one per mention, integration by integration in
 * the order given: what `archiveReferences` counts in a session, for any other text (a PR body).
 */
export function referencesIn(
  text: string,
  integrations: ArchiveIntegration[] = defaultIntegrations,
): ArchiveReference[] {
  const references: ArchiveReference[] = [];
  for (const integration of integrations)
    for (const [pattern, ref] of extractors(integration))
      for (const match of text.matchAll(pattern)) {
        const reference = { integration: integration.key, ref: ref(match) };
        if (reference.ref) references.push(reference);
      }
  return references;
}

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
    for (const entry of snapshot.entries)
      for (const reference of referencesIn(entry.text, [integration])) {
        const current = found.get(key(reference)) ?? { ...reference, recorded: false, mentions: 0 };
        current.mentions++;
        found.set(key(reference), current);
      }
  return [...found.values()]
    .sort((a, b) => Number(b.recorded) - Number(a.recorded) || b.mentions - a.mentions)
    .slice(0, limit);
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

/** `project:<projectId>`: a project whose files a session's tool calls touched. */
export const PROJECT_TAG_PREFIX = 'project:';

/**
 * Paths named in tool calls: absolute (`/…`, `~/…`) or relative with a folder (`apps/api/x.ts`),
 * never the inside of a URL.
 */
/** A whole shell word that is a path: absolute, `~/…`, `./…`, `../…`, or relative with a folder. */
const PATH_WORD = /^(?:~(?=\/|$)|\/|\.{1,2}\/|[\w@.+-]+\/)[\w@.+~/-]*$/;

/**
 * Shell words, quote-aware, split into commands at `;`, `&&`, `||`, `|`, newlines and
 * parentheses. Heredoc bodies are dropped: they are content written, not paths accessed.
 */
function shellCommands(script: string): string[][] {
  const lines = script.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]!);
    const heredoc = lines[i]!.match(/<<-?\s*(['"]?)(\w+)\1/);
    if (heredoc) while (i + 1 < lines.length && lines[i + 1]!.trim() !== heredoc[2]) i++;
  }
  const commands: string[][] = [[]];
  let word: string | null = null;
  let quote: string | null = null;
  const end = () => {
    if (word !== null) commands.at(-1)!.push(word);
    word = null;
  };
  const text = kept.join('\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i]!;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i]!;
    else if (/\s/.test(c) && c !== '\n') end();
    else if (
      c === '\n' ||
      c === ';' ||
      c === '|' ||
      c === '&' ||
      c === '(' ||
      c === ')' ||
      c === '`'
    ) {
      end();
      if (commands.at(-1)!.length) commands.push([]);
    } else if (c === '<' || c === '>') end();
    else word = (word ?? '') + c;
  }
  end();
  return commands.filter((command) => command.length);
}

/** The paths a shell script accesses: path-shaped arguments, `cd` and `git -C` targets. */
export function shellPaths(script: string, cwd?: string): string[] {
  const paths: string[] = [];
  let at = cwd;
  const absolute = (word: string) =>
    word === '~' || word.startsWith('~/')
      ? resolve(homedir(), word.slice(2))
      : word.startsWith('/')
        ? resolve(word)
        : at && resolve(at, word);
  for (const command of shellCommands(script))
    for (const [i, raw] of command.entries()) {
      const value =
        raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      const path = PATH_WORD.test(value) ? absolute(value) : undefined;
      if (path) paths.push(path);
      // A later relative path resolves against the directory `cd` moved to.
      if (i === 1 && command[0] === 'cd' && path) at = path;
    }
  return paths;
}

/** A tool's path argument, absolute: `~/` from home, relative from the working directory. */
const pathArgument = (value: string, cwd?: string): string[] =>
  value === '~' || value.startsWith('~/')
    ? [resolve(homedir(), value.slice(2))]
    : isAbsolute(value)
      ? [resolve(value)]
      : cwd
        ? [resolve(cwd, value)]
        : [];

const FILE_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
  LS: ['path'],
  view_image: ['path'],
};
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'unified_exec']);

/**
 * The paths one tool call accesses: the path arguments of file tools (Claude Code's Read, Edit,
 * Write, Glob, Grep and the like), the commands and working directory of shell calls (Claude
 * Code's Bash; Codex's exec_command, shell, the `exec` code cell's commands), and the files a Codex
 * patch names. Never the content written, a subagent's prompt, a message, or prose.
 */
export function toolCallPaths(text: string, cwd?: string): string[] {
  let call: { name?: unknown; input?: unknown; arguments?: unknown };
  try {
    call = JSON.parse(text);
  } catch {
    return [];
  }
  const name = typeof call?.name === 'string' ? call.name : '';
  let input: Record<string, unknown> = {};
  let raw = '';
  if (call.input && typeof call.input === 'object') input = call.input as Record<string, unknown>;
  else if (typeof call.arguments === 'string') {
    raw = call.arguments;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') input = parsed;
    } catch {}
  } else if (call.arguments && typeof call.arguments === 'object')
    input = call.arguments as Record<string, unknown>;
  const string = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const workdir = string(input.workdir) ?? string(input.cwd);
  const here = workdir ? (shellPaths(workdir, cwd)[0] ?? cwd) : cwd;
  const paths: string[] = workdir && here ? [here] : [];
  for (const key of FILE_TOOLS[name] ?? []) {
    const value = string(input[key]);
    if (value) paths.push(...pathArgument(value, here));
  }
  if (SHELL_TOOLS.has(name)) {
    const command = input.cmd ?? input.command;
    const script = Array.isArray(command)
      ? command
          .filter((w): w is string => typeof w === 'string')
          .map((w) => JSON.stringify(w))
          .join(' ')
      : string(command);
    if (script) paths.push(...shellPaths(script, here));
  }
  if (name === 'apply_patch') {
    const patch = string(input.input) ?? string(input.patch) ?? raw;
    for (const [, file] of patch.matchAll(
      /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm,
    ))
      if (file) paths.push(...pathArgument(file.trim(), here));
  }
  if (name === 'exec') {
    // A Codex code cell: the command strings its tool calls run, best effort.
    for (const [, , cmd] of raw.matchAll(/\bcmd\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/g))
      if (cmd) paths.push(...shellPaths(cmd.replace(/\\(.)/g, '$1'), here));
  }
  return paths;
}

/** Where a path sits: the project whose root (or worktree) holds it, that root, and the path inside it. */
export type ProjectPath = { projectId: string; root: string; path: string };

/**
 * A resolver from absolute paths to the project holding each, the longest root winning:
 * worktrees can live inside their main checkout, and a container (`~/code/inixiative`) holds
 * other projects' roots. A path outside every root resolves to nothing.
 */
export function projectPaths(
  projects: { projectId: string; roots: Iterable<string> }[],
): (path: string) => ProjectPath | undefined {
  const roots = projects
    .flatMap(({ projectId, roots }) =>
      [...roots].map((root) => ({ projectId, root: resolve(root) })),
    )
    .filter(({ root }) => root !== '/')
    .sort((a, b) => b.root.length - a.root.length);
  return (path) => {
    const owner = roots.find(({ root }) => path === root || path.startsWith(`${root}/`));
    return (
      owner && { ...owner, path: path === owner.root ? '' : path.slice(owner.root.length + 1) }
    );
  };
}

/**
 * The projects a session worked in, from the paths its tool calls access (`toolCallPaths`) and its
 * working directory: `project:<projectId>` for each project with a root (or worktree) holding
 * one, the longest root winning. Mentions (text written, prompts, messages, prose) never count. A
 * pure container (a root holding other projects' roots, like `~/code/inixiative`) named by itself
 * tags nothing: listing the folder of every checkout is not working in any. A project's own root
 * (`git -C ~/code/zealot`), even one holding its own worktrees, counts. Routing is unaffected: a
 * session keeps its own project and is tagged with every project it touched, its own included.
 */
export function projectTags(
  snapshot: Pick<ArchiveSnapshot, 'entries'>,
  projects: { projectId: string; roots: Iterable<string> }[],
  cwd?: string,
  limit = 20,
): string[] {
  const roots = projects
    .flatMap(({ projectId, roots }) =>
      [...roots].map((root) => ({ projectId, root: resolve(root) })),
    )
    .filter(({ root }) => root !== '/');
  if (!roots.length) return [];
  const containers = new Set(
    roots
      .filter(({ projectId, root }) =>
        roots.some((other) => other.projectId !== projectId && other.root.startsWith(`${root}/`)),
      )
      .map(({ root }) => root),
  );
  const resolvePath = projectPaths(projects);
  const counts = new Map<string, number>();
  const count = (path: string) => {
    if (containers.has(path)) return;
    const owner = resolvePath(path);
    if (owner) counts.set(owner.projectId, (counts.get(owner.projectId) ?? 0) + 1);
  };
  if (cwd) count(resolve(cwd));
  for (const entry of snapshot.entries)
    if (entry.kind === 'tool-call') for (const path of toolCallPaths(entry.text, cwd)) count(path);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([projectId]) => `${PROJECT_TAG_PREFIX}${projectId}`)
    .filter((tag) => tag.length <= 120);
}
