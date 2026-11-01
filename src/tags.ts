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

/** A whole shell word that is a path: absolute, `~/…`, `./…`, `../…`, or relative with a folder. */
const PATH_WORD = /^(?:~(?=\/|$)|\/|\.{1,2}\/|[\w@.+-]+\/)[\w@.+~/-]*$/;

/**
 * One shell command: its words, and the targets of its redirections apart from them (`>`, `>>`,
 * `&>`, `>|` write; `<` reads). File-descriptor duplications (`2>&1`), heredoc delimiters and
 * here-strings are not targets.
 */
type ShellCommand = { words: string[]; writes: string[]; reads: string[] };

/**
 * Shell words, quote-aware, split into commands at `;`, `&&`, `||`, `|`, `&`, newlines and
 * parentheses, with each command's redirection targets. Heredoc bodies are dropped: they are
 * content written, not paths accessed.
 */
function shellCommands(script: string): ShellCommand[] {
  const lines = script.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]!);
    const heredoc = lines[i]!.match(/<<-?\s*(['"]?)(\w+)\1/);
    if (heredoc) while (i + 1 < lines.length && lines[i + 1]!.trim() !== heredoc[2]) i++;
  }
  const fresh = (): ShellCommand => ({ words: [], writes: [], reads: [] });
  const commands: ShellCommand[] = [fresh()];
  let word: string | null = null;
  let quote: string | null = null;
  // Where the next whole word goes: a redirection's target, or nowhere (a heredoc delimiter).
  let target: 'writes' | 'reads' | 'skip' | null = null;
  const end = () => {
    if (word !== null) {
      if (target === null) commands.at(-1)!.words.push(word);
      else if (target !== 'skip') commands.at(-1)![target].push(word);
      target = null;
    }
    word = null;
  };
  const split = () => {
    end();
    target = null;
    const last = commands.at(-1)!;
    if (last.words.length || last.writes.length || last.reads.length) commands.push(fresh());
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
    else if (c === '>' || (c === '&' && text[i + 1] === '>')) {
      // `2>`: the digits name a file descriptor, not a word.
      if (c === '>' && word !== null && /^\d+$/.test(word)) word = null;
      end();
      if (c === '&') i++;
      if (text[i + 1] === '>' || text[i + 1] === '|') i++;
      if (text[i + 1] === '&') {
        // `>&2`, `>&-`: a duplication; `>& file` writes the file.
        i++;
        const dup = /^\s*(?:\d+|-)(?![\w./~-])/.exec(text.slice(i + 1));
        if (dup) {
          i += dup[0].length;
          continue;
        }
      }
      target = 'writes';
    } else if (c === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      end();
      if (text[i + 1] === '(') {
        // A process substitution is a command of its own.
        split();
        i++;
      } else if (text[i + 1] === '<') {
        i += text[i + 2] === '<' ? 2 : 1;
        if (text[i + 1] === '-') i++;
        target = 'skip';
      } else if (text[i + 1] === '&') {
        i++;
        const dup = /^\s*(?:\d+|-)/.exec(text.slice(i + 1));
        if (dup) i += dup[0].length;
      } else target = 'reads';
    } else if (
      c === '\n' ||
      c === ';' ||
      c === '|' ||
      c === '&' ||
      c === '(' ||
      c === ')' ||
      c === '`'
    )
      split();
    else word = (word ?? '') + c;
  }
  end();
  return commands.filter(
    (command) => command.words.length || command.writes.length || command.reads.length,
  );
}

const home = (word: string) => (word === '~' ? homedir() : resolve(homedir(), word.slice(2)));
/** A shell word as an absolute path: `~/` from home, relative from `at`. */
const absoluteWord = (word: string, at?: string) =>
  word === '~' || word.startsWith('~/')
    ? home(word)
    : word.startsWith('/')
      ? resolve(word)
      : at
        ? resolve(at, word)
        : undefined;

/** What a shell script (or one tool call) does with paths and repositories. */
export type ShellAccess = {
  /** Every path it accesses: path-shaped arguments, redirections, `cd` and `git -C` targets. */
  paths: string[];
  /** The paths it writes: redirection targets, edited and created files, and the work trees git and package managers change. */
  writes: string[];
  /** GitHub repositories (`owner/name`, lower case) it changes remotely: `gh pr|issue` and mutating `gh api` calls. */
  repositories: string[];
};

const GIT_WRITES = new Set([
  'add',
  'am',
  'apply',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'switch',
  'tag',
  'worktree',
]);
const GH_WRITES = new Set(['create', 'merge', 'edit', 'comment', 'review', 'close', 'reopen']);
/** Commands whose path arguments are all written. */
const PATH_WRITES = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'unlink',
  'tee',
  'chmod',
  'chown',
  'truncate',
]);
/** Commands whose last path argument (or `-t DIR`) is written. */
const COPY_WRITES = new Set(['cp', 'mv', 'rsync', 'install', 'ln']);
/** Commands that run a project's scripts or change its dependencies, writing in its directory. */
const RUNNERS: Record<string, Set<string> | true> = {
  bun: new Set(['add', 'install', 'i', 'remove', 'rm', 'update', 'run', 'x', 'test', 'publish']),
  npm: new Set(['add', 'install', 'i', 'ci', 'uninstall', 'update', 'run', 'test', 'publish']),
  pnpm: new Set(['add', 'install', 'i', 'remove', 'update', 'run', 'test', 'exec', 'publish']),
  yarn: new Set(['add', 'install', 'remove', 'upgrade', 'run', 'test', 'publish']),
  bunx: true,
  npx: true,
  make: true,
  prisma: true,
};
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec']);
const repositorySlug = (value: string) =>
  value
    .replace(/^https?:\/\/github\.com\//, '')
    .match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?].*)?$/)?.[1]
    ?.toLowerCase();

/**
 * One parser, two modes: the paths a shell script accesses (path-shaped arguments, redirections,
 * `cd` and `git -C` targets) and, of those, what it writes. Relative paths resolve against `cwd`
 * and any `cd` before them.
 */
export function shellAccess(script: string, cwd?: string): ShellAccess {
  const access: ShellAccess = { paths: [], writes: [], repositories: [] };
  let at = cwd;
  const write = (word: string | undefined, from = at) => {
    // `host:path` is another machine's.
    if (word !== undefined && /^[\w.-]+:/.test(word)) return;
    const path = word === undefined ? from : absoluteWord(word, from);
    if (path && !path.startsWith('/dev/')) access.writes.push(path);
  };
  for (const { words, writes, reads } of shellCommands(script)) {
    for (const [i, raw] of words.entries()) {
      // `gh --repo owner/name` names a repository, not a path.
      if (
        words[0] === 'gh' &&
        (raw.startsWith('--repo=') || ['-R', '--repo'].includes(words[i - 1] ?? ''))
      )
        continue;
      const value =
        raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      const path = PATH_WORD.test(value) ? absoluteWord(value, at) : undefined;
      if (path) access.paths.push(path);
    }
    for (const word of [...reads, ...writes]) {
      const path = absoluteWord(word, at);
      if (path) access.paths.push(path);
    }
    for (const word of writes) write(word);
    let command = words;
    while (command.length && (/^[A-Za-z_]\w*=/.test(command[0]!) || WRAPPERS.has(command[0]!)))
      command = command.slice(1);
    const [verb, ...args] = command;
    if (!verb) continue;
    const operands = args.filter((arg) => !arg.startsWith('-'));
    if (verb === 'cd') {
      // A later relative path resolves against the directory `cd` moved to.
      const path = args[0] ? absoluteWord(args[0], at) : undefined;
      if (path) at = path;
    } else if (verb === 'git') {
      let dir = at;
      let i = 0;
      for (; i < args.length && args[i]!.startsWith('-'); i++) {
        const option = args[i]!;
        if (option === '-C') dir = absoluteWord(args[++i] ?? '', dir) ?? dir;
        else if (option === '--work-tree' || option === '--git-dir')
          dir = absoluteWord(args[++i] ?? '', dir) ?? dir;
        else if (option.startsWith('--work-tree=') || option.startsWith('--git-dir='))
          dir = absoluteWord(option.slice(option.indexOf('=') + 1), dir) ?? dir;
        else if (option === '-c') i++;
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      if (!sub || !GIT_WRITES.has(sub)) continue;
      // Switching branches by name only moves HEAD; `-b`, `--` or paths change the tree.
      if (sub === 'checkout' && !rest.some((a) => ['-b', '-B', '--orphan', '--'].includes(a)))
        continue;
      if (sub === 'worktree') {
        if (rest[0] !== 'add' && rest[0] !== 'remove') continue;
        const tree = rest.slice(1).filter((a) => !a.startsWith('-'))[0];
        if (tree) write(tree, dir);
      }
      if (sub === 'stash' && rest[0] === 'list') continue;
      write(undefined, dir);
    } else if (verb === 'gh') {
      const [group, action] = operands;
      let repository: string | undefined;
      for (const [i, arg] of args.entries()) {
        if (arg === '-R' || arg === '--repo') repository = args[i + 1];
        else if (arg.startsWith('--repo=')) repository = arg.slice('--repo='.length);
      }
      if ((group === 'pr' || group === 'issue') && action && GH_WRITES.has(action)) {
        const link = operands.slice(2).find((a) => a.startsWith('https://github.com/'));
        const slug = repositorySlug(repository ?? link ?? '');
        if (slug) access.repositories.push(slug);
        else write(undefined);
      } else if (group === 'api') {
        const flag = args.findIndex((a) => a === '-X' || a === '--method');
        const method = (
          args.find((a) => a.startsWith('--method='))?.slice('--method='.length) ??
          (flag >= 0 ? args[flag + 1] : undefined)
        )?.toUpperCase();
        const fields = args.some((a) =>
          ['-f', '-F', '--field', '--raw-field', '--input'].includes(a),
        );
        // A field without a method is a POST.
        if (!(method ? method !== 'GET' : fields)) continue;
        const endpoint = operands.find((a) => /^\/?repos\//.test(a));
        const slug = endpoint?.match(/^\/?repos\/([^/]+\/[^/]+)/)?.[1];
        if (slug && !slug.includes('{')) access.repositories.push(slug.toLowerCase());
        else if (slug) write(undefined);
      }
    } else if (verb === 'sed' || verb === 'perl') {
      const inPlace = args.some(
        (a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='),
      );
      if (!inPlace) continue;
      // The script is the first operand unless -e or -f gave it.
      const scripted = args.some((a) => a === '-e' || a === '-f' || a === '--expression');
      const values = new Set<number>();
      for (const [i, arg] of args.entries())
        if (arg === '-e' || arg === '-f' || arg === '--expression') values.add(i + 1);
      const files = args.filter((a, i) => !a.startsWith('-') && !values.has(i) && a !== '');
      for (const file of scripted ? files : files.slice(1)) write(file);
    } else if (COPY_WRITES.has(verb)) {
      const directory = args[args.indexOf('-t') + 1];
      const target = args.includes('-t') ? directory : operands.at(-1);
      if (target && (args.includes('-t') || operands.length > 1)) write(target);
    } else if (PATH_WRITES.has(verb)) for (const operand of operands) write(operand);
    else {
      const runs = RUNNERS[verb];
      if (runs === true || (runs && operands[0] && runs.has(operands[0]))) write(undefined);
    }
  }
  return access;
}

/** The paths a shell script accesses: path-shaped arguments, redirections, `cd` and `git -C` targets. */
export const shellPaths = (script: string, cwd?: string) => shellAccess(script, cwd).paths;

/** A tool's path argument, absolute: `~/` from home, relative from the working directory. */
const pathArgument = (value: string, cwd?: string): string[] =>
  value === '~' || value.startsWith('~/')
    ? [home(value)]
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
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'unified_exec']);
const PATCH_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
/** A JavaScript string literal's value; undefined when it is not one. */
const jsString = (quote: string, body: string) => {
  if (quote === '"')
    try {
      return JSON.parse(`"${body}"`) as string;
    } catch {}
  return body.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1');
};
const literal = (key: string) =>
  new RegExp(`["']?\\b${key}["']?\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`, 's');

/**
 * What one tool call does with paths, in both modes: the paths it accesses (the path arguments of
 * file tools such as Claude Code's Read, Edit, Write, Glob, Grep; the commands and working
 * directory of shell calls such as Claude Code's Bash and Codex's exec_command and shell; the files
 * a Codex patch names; the commands, working directories and patches inside a Codex `exec` code
 * cell) and what it writes. Importers write calls as `{name, input|arguments}`, Foundry as
 * `{tool, input}`. Never the content written, a subagent's prompt, a message, or prose.
 */
export function toolCallAccess(text: string, cwd?: string): ShellAccess {
  const access: ShellAccess = { paths: [], writes: [], repositories: [] };
  let call: { name?: unknown; tool?: unknown; input?: unknown; arguments?: unknown };
  try {
    call = JSON.parse(text);
  } catch {
    return access;
  }
  if (!call || typeof call !== 'object') return access;
  const name =
    typeof call.name === 'string' ? call.name : typeof call.tool === 'string' ? call.tool : '';
  let input: Record<string, unknown> = {};
  let raw = '';
  if (call.input && typeof call.input === 'object') input = call.input as Record<string, unknown>;
  else if (typeof call.arguments === 'string' || typeof call.input === 'string') {
    raw = String(call.arguments ?? call.input);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') input = parsed;
    } catch {}
  } else if (call.arguments && typeof call.arguments === 'object')
    input = call.arguments as Record<string, unknown>;
  const string = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const add = (more: ShellAccess) => {
    access.paths.push(...more.paths);
    access.writes.push(...more.writes);
    access.repositories.push(...more.repositories);
  };
  const directory = (workdir: string | undefined, from?: string) =>
    workdir ? (shellPaths(workdir, from)[0] ?? from) : from;
  const workdir = string(input.workdir) ?? string(input.cwd);
  const here = directory(workdir, cwd);
  if (workdir && here) access.paths.push(here);
  for (const key of FILE_TOOLS[name] ?? []) {
    const value = string(input[key]);
    if (!value) continue;
    const paths = pathArgument(value, here);
    access.paths.push(...paths);
    if (WRITE_TOOLS.has(name)) access.writes.push(...paths);
  }
  if (SHELL_TOOLS.has(name)) {
    const command = input.cmd ?? input.command;
    const script = Array.isArray(command)
      ? command
          .filter((w): w is string => typeof w === 'string')
          .map((w) => JSON.stringify(w))
          .join(' ')
      : string(command);
    if (script) add(shellAccess(script, here));
  }
  const patched = (patch: string, at?: string) => {
    for (const [, file, moved] of patch.matchAll(PATCH_HEADER)) {
      const paths = pathArgument((file ?? moved)!.trim(), at);
      access.paths.push(...paths);
      access.writes.push(...paths);
    }
  };
  if (name === 'apply_patch') patched(string(input.input) ?? string(input.patch) ?? raw, here);
  if (name === 'exec') {
    // A Codex code cell: each nested tool call, with its own working directory, best effort.
    for (const segment of raw.split(/\btools\./).slice(1)) {
      const nested = segment.match(/^(\w+)\s*\(/)?.[1];
      if (nested === 'exec_command') {
        const cmd = segment.match(literal('cmd'));
        if (!cmd) continue;
        const dir = segment.match(literal('workdir'));
        const at = dir ? directory(jsString(dir[1]!, dir[2]!), here) : here;
        if (dir && at) access.paths.push(at);
        add(shellAccess(jsString(cmd[1]!, cmd[2]!), at));
      } else if (nested === 'apply_patch') {
        const patch = segment.match(/^apply_patch\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/s);
        if (patch) patched(jsString(patch[1]!, patch[2]!), here);
      }
    }
  }
  return access;
}

/** The paths one tool call accesses (`toolCallAccess`). */
export const toolCallPaths = (text: string, cwd?: string) => toolCallAccess(text, cwd).paths;

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
