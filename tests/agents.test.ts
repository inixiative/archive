import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentRunner,
  type AgentsConfig,
  agentStatus,
  agentsConfigSchema,
  agentUnits,
  collectorPlan,
  defaultHome,
  installAgents,
  machineProjects,
  packageCliPath,
  planAgents,
  readAgents,
  renderPlist,
  renderSystemdUnit,
  uninstallAgents,
} from '../src/agents';
import { runCli } from '../src/cli';
import { archiveRequest } from '../src/client';
import { archiveDestinationSchema, destinationsFile, readTokenFile } from '../src/config';
import { startArchiveServer } from '../src/server';
import { freshStore, testDatabaseUrl } from './db';

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-agents-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const collector = {
  name: 'claude-code.kingdom',
  source: 'claude-code' as const,
  directory: '/Users/me/.claude/projects',
  projectId: 'kingdom',
  projectRoots: ['/Users/me/code/kingdom', '/Users/me/code/kingdom & co'],
  worktrees: true,
  atlas: true,
};
const codex = {
  name: 'codex.kingdom',
  source: 'codex' as const,
  directory: '/Users/me/.codex/sessions',
  projectId: 'kingdom',
  projectRoots: ['/Users/me/code/kingdom'],
};
const config: AgentsConfig = {
  server: { url: 'http://127.0.0.1:4700' },
  collectors: [collector, codex],
};
const unitOptions = (home: string) => ({ home, execPath: '/bin/bun', cliPath: '/pkg/src/cli.ts' });

function fakeRunner(
  respond: (argv: string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({}),
) {
  const calls: string[][] = [];
  const run: AgentRunner = (argv) => {
    calls.push(argv);
    const r = respond(argv);
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { calls, run };
}

test('agents schema requires slug names, absolute paths and unique collectors', () => {
  expect(agentsConfigSchema.safeParse(config).success).toBe(true);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...collector, name: 'Bad Name' }] }).success,
  ).toBe(false);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...collector, projectRoots: ['relative'] }] })
      .success,
  ).toBe(false);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...collector, projectRoots: [] }] }).success,
  ).toBe(false);
  expect(agentsConfigSchema.safeParse({ collectors: [collector, collector] }).success).toBe(false);
  expect(agentsConfigSchema.safeParse({ collectors: [], extra: 1 }).success).toBe(false);
});

test('one unit runs every collector, with the runtime and --home only when non-default', () => {
  expect(packageCliPath()).toBe(join(import.meta.dir, '..', 'src', 'cli.ts'));
  const home = '/tmp/archive-home';
  const units = agentUnits(config, unitOptions(home));
  expect(units.map((u) => u.label)).toEqual(['com.inixiative.archive.collect']);
  expect(units[0]!.args.slice(2)).toEqual(['collect', '--watch', '--home', home]);
  expect(units[0]!.stdout).toBe(`${home}/logs/com.inixiative.archive.collect.out.log`);
  expect(agentUnits({ collectors: [codex] }, unitOptions(defaultHome()))[0]!.args).toEqual([
    '/bin/bun',
    '/pkg/src/cli.ts',
    'collect',
    '--watch',
  ]);
  expect(agentUnits({ collectors: [] }, unitOptions(home))).toEqual([]);
});

test('plist and systemd unit rendering', () => {
  const [unit] = agentUnits(config, unitOptions('/tmp/h'));
  const plist = renderPlist(unit!);
  expect(renderPlist({ ...unit!, args: [...unit!.args, 'a & <b>'] })).toContain(
    '<string>a &amp; &lt;b&gt;</string>',
  );
  expect(plist).toContain('<key>Label</key>\n  <string>com.inixiative.archive.collect</string>');
  expect(plist).toContain('<string>--watch</string>');
  expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
  expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/tmp/h</string>');
  expect(plist).toContain(
    '<key>StandardErrorPath</key>\n  <string>/tmp/h/logs/com.inixiative.archive.collect.err.log</string>',
  );
  if (process.platform === 'darwin') {
    const file = join(temp(), 'unit.plist');
    writeFileSync(file, plist);
    expect(Bun.spawnSync(['plutil', '-lint', file]).exitCode).toBe(0);
  }
  const service = renderSystemdUnit({ ...unit!, args: [...unit!.args, '100%', '$HOME', 'a"b'] });
  expect(service).toContain('ExecStart="/bin/bun" "/pkg/src/cli.ts" "collect"');
  expect(service).toContain('"100%%" "$$HOME" "a\\"b"');
  expect(service).toContain('Restart=always\nRestartSec=30');
  expect(service).toContain(
    'StandardOutput=append:/tmp/h/logs/com.inixiative.archive.collect.out.log',
  );
  expect(service).toContain('WantedBy=default.target');
});

test('planning writes changed units, keeps identical ones and removes only undeclared Archive units', () => {
  const units = agentUnits(
    { ...config, router: {} },
    { ...unitOptions('/tmp/h'), claudeBin: '/bin/claude' },
  );
  const plan = planAgents(
    units,
    [
      { label: 'com.inixiative.archive.collect', content: renderPlist(units[0]!) },
      { label: 'com.inixiative.archive.route', content: 'old' },
      // The units of one process per collector, from before every collector ran in one.
      { label: 'com.inixiative.archive.collect.claude-code.kingdom', content: 'old' },
      { label: 'com.inixiative.archive.collect.codex.kingdom' },
      { label: 'com.inixiative.foundry' },
    ],
    'darwin',
    '/LA',
  );
  expect(plan.unchanged).toEqual(['com.inixiative.archive.collect']);
  expect(plan.write.map((w) => w.file)).toEqual(['/LA/com.inixiative.archive.route.plist']);
  expect(plan.remove).toEqual([
    'com.inixiative.archive.collect.claude-code.kingdom',
    'com.inixiative.archive.collect.codex.kingdom',
  ]);
});

test('launchd install writes plists, reloads with I/O error retry, prunes and uninstalls', () => {
  const home = temp(),
    dir = join(temp(), 'LaunchAgents');
  mkdirSync(dir);
  writeFileSync(join(dir, 'com.inixiative.archive.collect.gone.plist'), 'stale');
  writeFileSync(join(dir, 'com.inixiative.foundry.plist'), 'other');
  let failures = 1;
  const { calls, run } = fakeRunner((argv) => {
    if (argv[1] === 'bootstrap' && argv[3]!.endsWith('archive.collect.plist') && failures-- > 0)
      return { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' };
    if (argv[1] === 'print') return { stdout: 'state = running\n\tpid = 4242\n' };
    return {};
  });
  const options = {
    dir,
    run,
    uid: 501,
    sleep: () => {},
    platform: 'darwin' as const,
    ...unitOptions(home),
  };
  const result = installAgents(config, options);
  expect(result.removed).toEqual(['com.inixiative.archive.collect.gone']);
  expect(result.loaded).toEqual(['com.inixiative.archive.collect']);
  expect(existsSync(join(dir, 'com.inixiative.archive.collect.gone.plist'))).toBe(false);
  expect(existsSync(join(dir, 'com.inixiative.foundry.plist'))).toBe(true);
  expect(readFileSync(join(dir, 'com.inixiative.archive.collect.plist'), 'utf8')).toContain(
    '<string>collect</string>',
  );
  expect(existsSync(join(home, 'logs'))).toBe(true);
  const commands = calls.map((c) => c.slice(0, 3).join(' '));
  expect(commands[0]).toBe('launchctl bootout gui/501/com.inixiative.archive.collect.gone');
  expect(commands.filter((c) => c === 'launchctl bootstrap gui/501')).toHaveLength(2);
  expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/com.inixiative.archive.collect']);

  calls.length = 0;
  const again = installAgents(config, options);
  expect(again).toMatchObject({ loaded: [], removed: [] });
  expect(again.unchanged).toEqual(['com.inixiative.archive.collect']);
  expect(calls.every((c) => c[1] === 'print')).toBe(true);

  writeFileSync(
    join(home, 'logs', 'com.inixiative.archive.collect.out.log'),
    'one\n{\n  "imported": 1\n}\n',
  );
  const status = agentStatus(config, options);
  expect(status.find((s) => s.label === 'com.inixiative.archive.collect')).toMatchObject({
    declared: true,
    installed: true,
    loaded: true,
    pid: 4242,
    lastOut: '{"imported":1}',
  });

  expect(() =>
    installAgents(config, {
      ...options,
      run: fakeRunner((argv) =>
        argv[1] === 'bootstrap' ? { code: 1, stderr: 'nope' } : { code: 1 },
      ).run,
    }),
  ).toThrow('bootstrap failed');

  expect(uninstallAgents(options).removed).toEqual(['com.inixiative.archive.collect']);
  expect(existsSync(join(dir, 'com.inixiative.foundry.plist'))).toBe(true);
  expect(existsSync(join(dir, 'com.inixiative.archive.collect.plist'))).toBe(false);
});

test('systemd install reloads the daemon and enables units', () => {
  const home = temp(),
    dir = join(temp(), 'systemd');
  const { calls, run } = fakeRunner((argv) =>
    argv[2] === 'show' ? { stdout: 'ActiveState=active\nMainPID=7\n' } : {},
  );
  const options = { dir, run, platform: 'linux' as const, ...unitOptions(home) };
  const service = 'com.inixiative.archive.collect';
  installAgents({ collectors: [codex] }, options);
  expect(existsSync(join(dir, `${service}.service`))).toBe(true);
  expect(calls).toEqual([
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', `${service}.service`],
    ['systemctl', '--user', 'restart', `${service}.service`],
  ]);
  calls.length = 0;
  expect(installAgents({ collectors: [] }, options).removed).toEqual([service]);
  expect(calls).toEqual([
    ['systemctl', '--user', 'disable', '--now', `${service}.service`],
    ['systemctl', '--user', 'daemon-reload'],
  ]);
});

test('agents CLI edits agents.json declaratively', async () => {
  const home = temp();
  const cli = (...args: string[]) => runCli(['agents', ...args, '--home', home]);
  await cli(
    'add-collector',
    '--name',
    'codex.archive',
    '--source',
    'codex',
    '--project-id',
    'archive',
    '--project-root',
    '/w/archive',
    '--worktrees',
  );
  await cli(
    'add-collector',
    '--name',
    'claude',
    '--source',
    'claude-code',
    '--project-id',
    'p',
    '--project-root',
    '/w/a',
    '--project-root',
    '/w/b',
    '--directory',
    '/h/claude',
    '--atlas',
  );
  await cli(
    'add-collector',
    '--name',
    'codex.archive',
    '--source',
    'codex',
    '--project-id',
    'archive2',
    '--project-root',
    '/w/archive',
  );
  await cli('server', '--url', 'http://127.0.0.1:4799');
  const file = join(home, 'agents.json');
  expect(readAgents(file)).toEqual({
    server: { url: 'http://127.0.0.1:4799' },
    collectors: [
      {
        name: 'claude',
        source: 'claude-code',
        directory: '/h/claude',
        projectId: 'p',
        projectRoots: ['/w/a', '/w/b'],
        atlas: true,
      },
      {
        name: 'codex.archive',
        source: 'codex',
        directory: join(homedir(), '.codex/sessions'),
        projectId: 'archive2',
        projectRoots: ['/w/archive'],
      },
    ],
  });
  await cli('remove-collector', '--name', 'claude');
  expect(readAgents(file)).toMatchObject({ collectors: [{ name: 'codex.archive' }] });
  await expect(cli('server')).rejects.toThrow('--url');
  // The router's per-wake cap is written for the unit to pass on as `route --watch --limit`.
  await cli('router', '--limit', '40', '--concurrency', '3');
  expect(readAgents(file)?.router).toEqual({ concurrency: 3, limit: 40 });
  await cli('router');
  expect(readAgents(file)?.router).toEqual({});
  await cli('router', 'off');
  expect(readAgents(file)?.router).toBeUndefined();
  await expect(runCli(['agents', 'install', '--home', temp()])).rejects.toThrow('agents.json');
});

test('token files: exactly one credential source, private regular file, read at request time', async () => {
  const dir = temp();
  const file = join(dir, 'archive.token');
  const base = { kind: 'archive', organizationId: 'p', url: 'https://a.example/' };
  expect(archiveDestinationSchema.safeParse({ ...base, tokenFile: file }).success).toBe(true);
  expect(archiveDestinationSchema.safeParse({ ...base, tokenFile: 'relative.token' }).success).toBe(
    false,
  );
  expect(
    archiveDestinationSchema.safeParse({ ...base, tokenFile: file, tokenEnv: 'X_TOKEN' }).success,
  ).toBe(false);
  expect(archiveDestinationSchema.safeParse(base).success).toBe(false);

  const token = 'synthetic-archive-token-file-000000000000';
  writeFileSync(file, `${token}\n`, { mode: 0o644 });
  expect(() => readTokenFile(file)).toThrow('0600');
  chmodSync(file, 0o600);
  expect(readTokenFile(file)).toBe(token);
  const link = join(dir, 'link.token');
  symlinkSync(file, link);
  expect(() => readTokenFile(link)).toThrow();

  await freshStore('serve');
  const instance = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  try {
    const destination = archiveDestinationSchema.parse({
      ...base,
      url: instance.server.url.href,
      tokenFile: file,
    });
    if (destination.kind !== 'archive') throw new Error('Expected a direct Archive destination');
    writeFileSync(file, 'wrong\n');
    await expect(
      archiveRequest(destination, 'search', { query: '', projectId: 'p' }),
    ).rejects.toThrow('401');
    writeFileSync(file, `${token}\n`);
    expect(
      (await archiveRequest(destination, 'search', { query: '', projectId: 'p' })).data.archives,
    ).toEqual([]);

    const home = temp();
    await runCli([
      'connect',
      '--home',
      home,
      '--url',
      instance.server.url.href,
      '--organization-id',
      'p',
      '--token-file',
      file,
    ]);
    const saved = JSON.parse(readFileSync(destinationsFile(home), 'utf8'));
    expect(saved).toEqual({
      organizations: [{ id: 'p', projects: [] }],
      destinations: [
        { organizationId: 'p', url: instance.server.url.href, tokenFile: file, kind: 'archive' },
      ],
      publish: 'off',
      cleanup: 'off',
      cleanupFor: {},
      personalSpans: 'hold',
    });
  } finally {
    await instance.close();
  }
});

test('a catch-all collector is unrouted with no roots; a named collector is routed against its source peers', () => {
  const catchAll = {
    name: 'claude-code.unrouted',
    source: 'claude-code' as const,
    directory: '/Users/me/.claude/projects',
    projectId: 'unrouted',
    projectRoots: [],
    catchAll: true,
  };
  const withCatchAll = {
    ...config,
    exclude: ['/Users/me/scratch'],
    collectors: [collector, codex, catchAll],
  };
  expect(agentsConfigSchema.safeParse(withCatchAll).success).toBe(true);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...catchAll, projectId: 'kingdom' }] }).success,
  ).toBe(false);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...catchAll, projectRoots: ['/w'] }] }).success,
  ).toBe(false);
  expect(
    agentsConfigSchema.safeParse({ collectors: [{ ...collector, projectId: 'unrouted' }] }).success,
  ).toBe(false);
  const plan = collectorPlan(withCatchAll, 'claude-code.unrouted');
  expect(plan.collector).toMatchObject({ catchAll: true, projectId: 'unrouted' });
  expect(plan.peers.map((p) => p.projectId)).toEqual(['kingdom', 'unrouted']);
  expect(plan.peers[1]).toBe(plan.collector);
  expect(plan.filters.exclude).toContain('/Users/me/scratch');
  expect(plan.filters.exclude).toContain('**/decision-receipts');
  expect(plan.projects.map((p) => p.projectId)).toEqual(['kingdom', 'kingdom']);
  expect(plan.server).toEqual({ url: 'http://127.0.0.1:4700' });
  // A collector over another history directory is not a peer.
  const elsewhere = {
    ...collector,
    name: 'claude-code.work',
    directory: '/Users/me/.claude-work/projects',
  };
  expect(
    collectorPlan({ collectors: [collector, elsewhere, catchAll] }, 'claude-code.work').peers.map(
      (p) => p.directory,
    ),
  ).toEqual(['/Users/me/.claude-work/projects']);
  expect(() => collectorPlan(withCatchAll, 'missing')).toThrow('No collector named missing');
  expect(
    archiveDestinationSchema.safeParse({
      kind: 'archive',
      projectId: 'unrouted',
      url: 'https://a.example/',
      tokenEnv: 'T',
    }).success,
  ).toBe(false);
});

test('a unit that fails to load does not stop the others, and is reloaded by the next install', () => {
  const home = temp(),
    dir = join(temp(), 'LaunchAgents');
  mkdirSync(dir);
  const collectFile = join(dir, 'com.inixiative.archive.collect.plist');
  const routeFile = join(dir, 'com.inixiative.archive.route.plist');
  // Both units run an older version.
  writeFileSync(collectFile, 'old collect');
  writeFileSync(routeFile, 'old route');
  const running = new Set(['collect', 'route']);
  const failing = new Set(['route']);
  const run: AgentRunner = (argv) => {
    const name = (argv.at(-1) ?? '').replace(/.*com\.inixiative\.archive\.|\.plist$/g, '');
    if (argv[1] === 'print') return { code: running.has(name) ? 0 : 1, stdout: '', stderr: '' };
    if (argv[1] === 'bootout') running.delete(name);
    if (argv[1] === 'bootstrap') {
      if (failing.has(name)) return { code: 1, stdout: '', stderr: 'nope' };
      running.add(name);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = {
    dir,
    run,
    uid: 501,
    sleep: () => {},
    platform: 'darwin' as const,
    ...unitOptions(home),
  };
  const routed = { ...config, router: {} };
  expect(() => installAgents(routed, options)).toThrow('com.inixiative.archive.route');
  // The unit that loaded runs the new file; the one that failed keeps its old file.
  expect(readFileSync(collectFile, 'utf8')).toContain('<string>--watch</string>');
  expect(readFileSync(routeFile, 'utf8')).toBe('old route');
  failing.clear();
  const again = installAgents(routed, options);
  expect(again.loaded).toEqual(['com.inixiative.archive.route']);
  expect(again.unchanged).toEqual(['com.inixiative.archive.collect']);
  expect(readFileSync(routeFile, 'utf8')).toContain('<string>route</string>');
});

test('machineProjects: every non-catch-all project and its checkout roots', () => {
  const project = (name: string, projectId: string, root: string, catchAll = false) => ({
    name,
    source: 'claude-code' as const,
    directory: '/Users/someone/.claude/projects',
    projectId,
    projectRoots: [root],
    ...(catchAll ? { catchAll: true } : {}),
  });
  expect(
    machineProjects({
      collectors: [
        project('claude-code.template', 'template', '/nonexistent/template'),
        project('claude-code.unrouted', 'unrouted', '/nonexistent', true),
      ],
    }),
  ).toEqual([{ projectId: 'template', roots: new Set(['/nonexistent/template']) }]);
});

test('collect with no flags runs every collector in agents.json; --watch re-reads it each scan', async () => {
  const token = 'synthetic-archive-collect-token-00000000';
  await freshStore('serve');
  const instance = await startArchiveServer({
    databaseUrl: testDatabaseUrl('serve'),
    token,
    port: 0,
  });
  const home = temp();
  const claude = join(temp(), 'projects');
  const codexHistory = join(temp(), 'sessions');
  mkdirSync(claude);
  mkdirSync(codexHistory);
  writeFileSync(join(home, 'server.token'), `${token}\n`);
  const session = (id: string, cwd: string) =>
    writeFileSync(
      join(claude, `${id}.jsonl`),
      JSON.stringify({
        sessionId: id,
        cwd,
        type: 'user',
        uuid: `${id}-1`,
        message: { content: 'Work' },
      }),
    );
  session('k', '/w/kingdom');
  session('t', '/w/tribe');
  writeFileSync(
    join(codexHistory, 'c.jsonl'),
    [
      { type: 'session_meta', payload: { id: 'c', cwd: '/w/kingdom' } },
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const collector = (name: string, projectId: string, directory = claude) => ({
    name,
    source: name.startsWith('codex') ? ('codex' as const) : ('claude-code' as const),
    directory,
    projectId,
    projectRoots: [`/w/${projectId}`],
  });
  const file = join(home, 'agents.json');
  const agents = (collectors: AgentsConfig['collectors']) =>
    writeFileSync(file, JSON.stringify({ server: { url: instance.server.url.href }, collectors }));
  agents([
    collector('claude-code.kingdom', 'kingdom'),
    collector('codex.kingdom', 'kingdom', codexHistory),
  ]);
  // The CLI's output, one JSON value a write; anything else written passes through.
  const printed: unknown[] = [];
  const passThrough = process.stdout.write.bind(process.stdout);
  const write = spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest) => {
    const text = String(chunk);
    if (!text.startsWith('{')) return passThrough(chunk, ...(rest as []));
    printed.push(JSON.parse(text));
    return true;
  });
  try {
    await runCli(['collect', '--home', home]);
    expect(printed).toEqual([
      {
        collectors: {
          'claude-code.kingdom': expect.objectContaining({ imported: 1, skipped: 1 }),
          'codex.kingdom': expect.objectContaining({ imported: 1 }),
        },
        ms: expect.any(Number),
      },
    ]);
    const projects = async () =>
      (await instance.store.list({ exempt: 'include' }))
        .map((a) => `${a.source}:${a.sessionId}:${a.projectId}`)
        .sort();
    expect(await projects()).toEqual(['claude-code:k:kingdom', 'codex:c:kingdom']);

    // Watching: a collector declared between scans takes its sessions on the next scan, and a
    // scan with nothing new prints nothing.
    printed.length = 0;
    // Only the collector's one-second waits between scans are skipped and counted, 30 a scan.
    let waits = 0;
    const wait = Bun.sleep;
    const sleep = spyOn(Bun, 'sleep').mockImplementation(async (ms) => {
      if (ms !== 1000) return wait(ms);
      waits++;
      if (waits === 31)
        agents([
          collector('claude-code.kingdom', 'kingdom'),
          collector('claude-code.tribe', 'tribe'),
          collector('codex.kingdom', 'kingdom', codexHistory),
        ]);
      if (waits >= 91) process.emit('SIGTERM');
    });
    try {
      await runCli(['collect', '--watch', '--home', home]);
    } finally {
      sleep.mockRestore();
    }
    expect(printed).toEqual([
      {
        collectors: {
          'claude-code.kingdom': expect.objectContaining({ unchanged: 1, skipped: 1 }),
          'codex.kingdom': expect.objectContaining({ unchanged: 1 }),
        },
        ms: expect.any(Number),
      },
      {
        collectors: { 'claude-code.tribe': expect.objectContaining({ imported: 1 }) },
        ms: expect.any(Number),
      },
    ]);
    expect(await projects()).toEqual([
      'claude-code:k:kingdom',
      'claude-code:t:tribe',
      'codex:c:kingdom',
    ]);
  } finally {
    write.mockRestore();
    await instance.close();
  }
}, 30_000);
