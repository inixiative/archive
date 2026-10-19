import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  type CollectionSource,
  collectionRoots,
  defaultExclusions,
  excludeGlob,
  type FolderFilters,
  folderGlob,
  UNROUTED,
} from './collector';

export const defaultHome = () => join(homedir(), '.local/share/archive');
export const AGENT_LABEL_PREFIX = 'com.inixiative.archive.';
/** History each provider writes by default. */
export const defaultHistoryDirectory = (source: 'claude-code' | 'codex') =>
  join(homedir(), source === 'codex' ? '.codex/sessions' : '.claude/projects');

const absolute = z.string().max(4096).refine(isAbsolute, 'Path must be absolute');
/** Folder globs, normalized; an empty entry is refused, never read as "all". */
const folderGlobs = (normalize: (entry: string) => string) =>
  z
    .array(
      z
        .string()
        .max(4096)
        .transform((entry, ctx) => {
          try {
            return normalize(entry);
          } catch (error) {
            ctx.addIssue({ code: 'custom', message: (error as Error).message });
            return z.NEVER;
          }
        }),
    )
    .max(100);
export const collectorAgentSchema = z
  .strictObject({
    name: z
      .string()
      .max(64)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    source: z.enum(['claude-code', 'codex']),
    directory: absolute,
    projectId: z.string().min(1).max(256),
    projectRoots: z.array(absolute).max(100),
    worktrees: z.boolean().optional(),
    subdirectories: z.boolean().optional(),
    /** Every session no other collector of this source claims; projectId `unrouted`, never synced. */
    catchAll: z.boolean().optional(),
    atlas: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.catchAll && (c.projectId !== UNROUTED || c.projectRoots.length))
      ctx.addIssue({
        code: 'custom',
        message: `A catch-all collector has projectId ${UNROUTED} and no roots`,
      });
    if (!c.catchAll && (c.projectId === UNROUTED || !c.projectRoots.length))
      ctx.addIssue({
        code: 'custom',
        message: `A collector needs a root and a projectId other than ${UNROUTED}`,
      });
  });
export const agentsConfigSchema = z
  .strictObject({
    /** The Archive server collectors write to; the token is the home's `server.token`. */
    server: z.strictObject({ url: z.url() }).optional(),
    /** Only sessions in folders these globs name are collected, by any collector. */
    include: folderGlobs(folderGlob).optional(),
    /** Never collected, by any collector; added to the default exclusions (decision receipts). */
    exclude: folderGlobs(excludeGlob).optional(),
    collectors: z.array(collectorAgentSchema).max(100),
  })
  .refine(
    (c) => new Set(c.collectors.map((x) => x.name)).size === c.collectors.length,
    'Collector names must be unique',
  );
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;
export type CollectorAgent = z.infer<typeof collectorAgentSchema>;

export const readAgents = (file: string): AgentsConfig | undefined =>
  existsSync(file) ? agentsConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
export function writeAgents(file: string, input: AgentsConfig) {
  const config = agentsConfigSchema.parse(input);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  chmodSync(file, 0o600);
  return config;
}
export function upsertCollector(config: AgentsConfig | undefined, collector: CollectorAgent) {
  const collectors = (config?.collectors ?? []).filter((c) => c.name !== collector.name);
  return { ...config, collectors: [...collectors, collectorAgentSchema.parse(collector)] };
}

export interface AgentUnit {
  label: string;
  /** Full argv: runtime, CLI entrypoint, command. */
  args: string[];
  workingDirectory: string;
  stdout: string;
  stderr: string;
}
export interface AgentUnitOptions {
  home: string;
  execPath?: string;
  /** Defaults to this package's own CLI, wherever it is installed. */
  cliPath?: string;
}
export const packageCliPath = () => fileURLToPath(new URL('./cli.ts', import.meta.url));

/** A unit runs one named collector; it re-reads agents.json each scan, so edits apply live. */
export function collectorArgs(c: CollectorAgent) {
  return ['collect', '--agent', c.name, '--watch'];
}

const source = (c: CollectorAgent): CollectionSource => ({
  directory: c.directory,
  source: c.source,
  projectRoots: c.projectRoots,
  projectId: c.projectId,
  ...(c.worktrees ? { worktrees: true } : {}),
  ...(c.subdirectories ? { subdirectories: true } : {}),
  ...(c.catchAll ? { catchAll: true } : {}),
  ...(c.atlas ? { atlas: true } : {}),
});

/**
 * Every project on the machine and the directories that are its checkouts (worktrees included,
 * read now), as the collectors tag `project:` with: what `projectPaths` resolves paths against.
 */
export function machineProjects(config: AgentsConfig) {
  return config.collectors
    .filter((c) => !c.catchAll)
    .map((c) => ({ projectId: c.projectId, roots: collectionRoots(source(c)) }));
}

/**
 * A named collector, the peers it is routed against, the folder filters, every project on the
 * machine (for `project:` tags) and the server, from agents.json.
 */
export function collectorPlan(config: AgentsConfig, name: string) {
  const collector = config.collectors.find((c) => c.name === name);
  if (!collector) throw new Error(`No collector named ${name} in agents.json`);
  // Collectors over the same history compete for its sessions; another directory is another history.
  const named = config.collectors.filter(
    (c) => c.source === collector.source && resolve(c.directory) === resolve(collector.directory),
  );
  const peers = named.map(source);
  const filters: FolderFilters = {
    ...(config.include?.length ? { include: config.include } : {}),
    exclude: [...defaultExclusions(), ...(config.exclude ?? [])],
  };
  return {
    collector: peers[named.indexOf(collector)]!,
    peers,
    filters,
    projects: config.collectors.filter((c) => !c.catchAll).map(source),
    server: config.server,
  };
}

/** One supervised unit per declared agent. */
export function agentUnits(config: AgentsConfig, options: AgentUnitOptions): AgentUnit[] {
  const home = resolve(options.home);
  const base = [options.execPath ?? process.execPath, options.cliPath ?? packageCliPath()];
  const homeArgs = home === resolve(defaultHome()) ? [] : ['--home', home];
  const unit = (suffix: string, command: string[]): AgentUnit => {
    const label = AGENT_LABEL_PREFIX + suffix;
    return {
      label,
      args: [...base, ...command, ...homeArgs],
      workingDirectory: home,
      stdout: join(home, 'logs', `${label}.out.log`),
      stderr: join(home, 'logs', `${label}.err.log`),
    };
  };
  return config.collectors.map((c) => unit(`collect.${c.name}`, collectorArgs(c)));
}

const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function renderPlist(unit: AgentUnit) {
  const string = (value: string) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(unit.label)}
  <key>ProgramArguments</key>
  <array>
${unit.args.map((arg) => `    ${string(arg)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  ${string(unit.workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  ${string(unit.stdout)}
  <key>StandardErrorPath</key>
  ${string(unit.stderr)}
</dict>
</plist>
`;
}

// systemd expands % specifiers and $ variables even inside quotes.
const systemdEscape = (value: string) => value.replace(/%/g, '%%').replace(/\$/g, '$$$$');
const systemdQuote = (arg: string) =>
  `"${systemdEscape(arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;
export function renderSystemdUnit(unit: AgentUnit) {
  return `[Unit]
Description=Archive ${unit.label.slice(AGENT_LABEL_PREFIX.length)}

[Service]
ExecStart=${unit.args.map(systemdQuote).join(' ')}
WorkingDirectory=${systemdEscape(unit.workingDirectory)}
Restart=always
RestartSec=30
StandardOutput=append:${systemdEscape(unit.stdout)}
StandardError=append:${systemdEscape(unit.stderr)}

[Install]
WantedBy=default.target
`;
}

export type AgentPlatform = 'darwin' | 'linux';
export const unitFileName = (label: string, platform: AgentPlatform) =>
  label + (platform === 'darwin' ? '.plist' : '.service');
const ownedLabel = (label: string) =>
  label === `${AGENT_LABEL_PREFIX}local` ||
  label === `${AGENT_LABEL_PREFIX}sync` ||
  label.startsWith(`${AGENT_LABEL_PREFIX}collect.`);
/** Labels of Archive units present in a supervisor directory. */
export function installedLabels(dir: string, platform: AgentPlatform) {
  const extension = unitFileName('', platform);
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => file.endsWith(extension))
        .map((file) => file.slice(0, -extension.length))
        .filter(ownedLabel)
        .sort()
    : [];
}

export interface AgentPlan {
  write: { label: string; file: string; content: string }[];
  unchanged: string[];
  remove: string[];
}
/** Pure: which unit files to write, keep, or remove, given what is on disk. */
export function planAgents(
  units: AgentUnit[],
  installed: { label: string; content?: string }[],
  platform: AgentPlatform,
  dir: string,
): AgentPlan {
  const current = new Map(installed.map((i) => [i.label, i.content]));
  const render = platform === 'darwin' ? renderPlist : renderSystemdUnit;
  const plan: AgentPlan = { write: [], unchanged: [], remove: [] };
  for (const unit of units) {
    const content = render(unit);
    if (current.get(unit.label) === content) plan.unchanged.push(unit.label);
    else
      plan.write.push({
        label: unit.label,
        file: join(dir, unitFileName(unit.label, platform)),
        content,
      });
  }
  const wanted = new Set(units.map((u) => u.label));
  plan.remove = installed.map((i) => i.label).filter((l) => ownedLabel(l) && !wanted.has(l));
  return plan;
}

export type AgentRunner = (argv: string[]) => { code: number; stdout: string; stderr: string };
const spawnRunner: AgentRunner = (argv) => {
  const run = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode ?? 1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
};
export interface AgentHostOptions {
  home?: string;
  platform?: AgentPlatform;
  /** Supervisor directory; defaults to ~/Library/LaunchAgents or ~/.config/systemd/user. */
  dir?: string;
  run?: AgentRunner;
  uid?: number;
  sleep?: (ms: number) => void;
  execPath?: string;
  cliPath?: string;
}
function host(options: AgentHostOptions) {
  const platform =
    options.platform ??
    (process.platform === 'darwin' || process.platform === 'linux'
      ? process.platform
      : (() => {
          throw new Error('Agents support macOS launchd and Linux systemd only');
        })());
  const home = resolve(options.home ?? defaultHome());
  const dir =
    options.dir ??
    join(homedir(), platform === 'darwin' ? 'Library/LaunchAgents' : '.config/systemd/user');
  const run = options.run ?? spawnRunner;
  const domain = `gui/${options.uid ?? process.getuid?.()}`;
  const sleep = options.sleep ?? Bun.sleepSync;
  const file = (label: string) => join(dir, unitFileName(label, platform));
  const systemctl = (...args: string[]) => run(['systemctl', '--user', ...args]);
  const unload = (label: string) => {
    if (platform === 'darwin') run(['launchctl', 'bootout', `${domain}/${label}`]);
    else systemctl('disable', '--now', `${label}.service`);
  };
  const load = (label: string) => {
    if (platform === 'linux') {
      const enabled = systemctl('enable', `${label}.service`);
      const started = systemctl('restart', `${label}.service`);
      if (enabled.code || started.code) throw new Error(`systemctl failed for ${label}`);
      return;
    }
    run(['launchctl', 'bootout', `${domain}/${label}`]);
    // bootout returns before launchd finishes tearing down; bootstrap then fails with I/O error 5.
    for (let attempt = 1; ; attempt++) {
      const result = run(['launchctl', 'bootstrap', domain, file(label)]);
      if (!result.code) return;
      if (attempt >= 5 || (result.code !== 5 && !/Input\/output error/.test(result.stderr)))
        throw new Error(`launchctl bootstrap failed for ${label}: ${result.stderr.trim()}`);
      sleep(1000);
    }
  };
  const loaded = (label: string) => {
    if (platform === 'darwin') {
      const result = run(['launchctl', 'print', `${domain}/${label}`]);
      if (result.code) return { loaded: false };
      const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1];
      return { loaded: true, pid: pid ? Number(pid) : undefined };
    }
    const result = systemctl('show', `${label}.service`, '--property=ActiveState,MainPID');
    const state = /ActiveState=(\w+)/.exec(result.stdout)?.[1];
    const pid = Number(/MainPID=(\d+)/.exec(result.stdout)?.[1] ?? 0);
    return { loaded: state === 'active' || state === 'activating', pid: pid || undefined };
  };
  const remove = (labels: string[]) => {
    for (const label of labels) {
      unload(label);
      rmSync(file(label), { force: true });
    }
    if (platform === 'linux' && labels.length) systemctl('daemon-reload');
  };
  return { platform, home, dir, file, load, loaded, remove, systemctl };
}

/** Writes and (re)loads declared agents; removes Archive units no longer declared. */
export function installAgents(config: AgentsConfig, options: AgentHostOptions = {}) {
  const h = host(options);
  const units = agentUnits(config, {
    home: h.home,
    execPath: options.execPath,
    cliPath: options.cliPath,
  });
  mkdirSync(join(h.home, 'logs'), { recursive: true, mode: 0o700 });
  mkdirSync(h.dir, { recursive: true });
  const installed = installedLabels(h.dir, h.platform).map((label) => ({
    label,
    content: readFileSync(h.file(label), 'utf8'),
  }));
  const plan = planAgents(units, installed, h.platform, h.dir);
  h.remove(plan.remove);
  const previous = new Map(installed.map((i) => [i.label, i.content]));
  const write = (file: string, content: string) => {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, { mode: 0o644, flag: 'wx' });
    renameSync(temp, file);
  };
  const loaded: string[] = [];
  const failed: { label: string; error: string }[] = [];
  // Write and load one unit at a time. A unit that fails to load gets its old file back (or none),
  // so the next install sees it as changed and loads it, instead of trusting a stale running copy.
  const install = (label: string, content?: string) => {
    try {
      if (content !== undefined) {
        write(h.file(label), content);
        if (h.platform === 'linux') h.systemctl('daemon-reload');
      }
      h.load(label);
      loaded.push(label);
    } catch (error) {
      failed.push({ label, error: error instanceof Error ? error.message : String(error) });
      if (content === undefined) return;
      const old = previous.get(label);
      try {
        if (old === undefined) rmSync(h.file(label), { force: true });
        else write(h.file(label), old);
        if (h.platform === 'linux') h.systemctl('daemon-reload');
        // Loading stopped the unit that ran before; bring it back as it was.
        if (old !== undefined) h.load(label);
      } catch {}
    }
  };
  for (const { label, content } of plan.write) install(label, content);
  // Unchanged units that are not running are loaded again.
  for (const label of plan.unchanged) if (!h.loaded(label).loaded) install(label);
  if (failed.length)
    throw new Error(
      `Archive agents failed to load: ${failed.map((f) => `${f.label} (${f.error})`).join('; ')}`,
    );
  return {
    platform: h.platform,
    dir: h.dir,
    loaded,
    unchanged: plan.unchanged.filter((l) => !loaded.includes(l)),
    removed: plan.remove,
  };
}

export function uninstallAgents(options: AgentHostOptions = {}) {
  const h = host(options);
  const labels = installedLabels(h.dir, h.platform);
  h.remove(labels);
  return { platform: h.platform, dir: h.dir, removed: labels };
}

/** Last log entry: CLI output is pretty JSON, so the last top-level value, compacted; else the last line. */
function lastEntry(file: string) {
  if (!existsSync(file)) return undefined;
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65_536));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer.toString('utf8').trimEnd().split('\n');
    // Source ships to consumers compiled against older libs, so no findLastIndex.
    let start = lines.length - 1;
    while (start >= 0 && lines[start] !== '{' && lines[start] !== '[') start--;
    if (start >= 0)
      try {
        return JSON.stringify(JSON.parse(lines.slice(start).join('\n'))).slice(0, 500);
      } catch {}
    return lines.at(-1) || undefined;
  } finally {
    closeSync(fd);
  }
}

export function agentStatus(config: AgentsConfig | undefined, options: AgentHostOptions = {}) {
  const h = host(options);
  const units = config
    ? agentUnits(config, { home: h.home, execPath: options.execPath, cliPath: options.cliPath })
    : [];
  const declared = new Set(units.map((u) => u.label));
  const labels = [...new Set([...declared, ...installedLabels(h.dir, h.platform)])].sort();
  return labels.map((label) => ({
    label,
    declared: declared.has(label),
    installed: existsSync(h.file(label)),
    ...h.loaded(label),
    lastOut: lastEntry(join(h.home, 'logs', `${label}.out.log`)),
    lastErr: lastEntry(join(h.home, 'logs', `${label}.err.log`)),
  }));
}
