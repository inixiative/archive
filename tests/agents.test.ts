import { afterEach, expect, test } from 'bun:test';
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
  defaultHome,
  installAgents,
  packageCliPath,
  planAgents,
  readAgents,
  renderPlist,
  renderSystemdUnit,
  uninstallAgents,
} from '../src/agents';
import { runCli } from '../src/cli';
import { archiveRequest } from '../src/client';
import { archiveDestinationSchema, readTokenFile } from '../src/config';
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

test('units run this package CLI with the runtime and add --home only when non-default', () => {
  expect(packageCliPath()).toBe(join(import.meta.dir, '..', 'src', 'cli.ts'));
  const home = '/tmp/archive-home';
  const units = agentUnits(config, unitOptions(home));
  expect(units.map((u) => u.label)).toEqual([
    'com.inixiative.archive.collect.claude-code.kingdom',
    'com.inixiative.archive.collect.codex.kingdom',
  ]);
  expect(units[0]!.args.slice(2)).toEqual([
    'collect',
    '--url',
    'http://127.0.0.1:4700',
    '--directory',
    '/Users/me/.claude/projects',
    '--source',
    'claude-code',
    '--project-root',
    '/Users/me/code/kingdom',
    '--project-root',
    '/Users/me/code/kingdom & co',
    '--worktrees',
    '--atlas',
    '--project-id',
    'kingdom',
    '--watch',
    '--home',
    home,
  ]);
  expect(units[0]!.stdout).toBe(
    `${home}/logs/com.inixiative.archive.collect.claude-code.kingdom.out.log`,
  );
  expect(agentUnits({ collectors: [codex] }, unitOptions(defaultHome()))[0]!.args).toEqual([
    '/bin/bun',
    '/pkg/src/cli.ts',
    'collect',
    '--directory',
    '/Users/me/.codex/sessions',
    '--source',
    'codex',
    '--project-root',
    '/Users/me/code/kingdom',
    '--project-id',
    'kingdom',
    '--watch',
  ]);
});

test('plist and systemd unit rendering', () => {
  const [unit] = agentUnits(config, unitOptions('/tmp/h'));
  const plist = renderPlist(unit!);
  expect(plist).toContain(
    '<key>Label</key>\n  <string>com.inixiative.archive.collect.claude-code.kingdom</string>',
  );
  expect(plist).toContain('<string>/Users/me/code/kingdom &amp; co</string>');
  expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
  expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
  expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>30</integer>');
  expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/tmp/h</string>');
  expect(plist).toContain(
    '<key>StandardErrorPath</key>\n  <string>/tmp/h/logs/com.inixiative.archive.collect.claude-code.kingdom.err.log</string>',
  );
  if (process.platform === 'darwin') {
    const file = join(temp(), 'unit.plist');
    writeFileSync(file, plist);
    expect(Bun.spawnSync(['plutil', '-lint', file]).exitCode).toBe(0);
  }
  const service = renderSystemdUnit({ ...unit!, args: [...unit!.args, '100%', '$HOME', 'a"b'] });
  expect(service).toContain('ExecStart="/bin/bun" "/pkg/src/cli.ts" "collect"');
  expect(service).toContain('"/Users/me/code/kingdom & co"');
  expect(service).toContain('"100%%" "$$HOME" "a\\"b"');
  expect(service).toContain('Restart=always\nRestartSec=30');
  expect(service).toContain(
    'StandardOutput=append:/tmp/h/logs/com.inixiative.archive.collect.claude-code.kingdom.out.log',
  );
  expect(service).toContain('WantedBy=default.target');
});

test('planning writes changed units, keeps identical ones and removes only undeclared Archive units', () => {
  const units = agentUnits(config, unitOptions('/tmp/h'));
  const plan = planAgents(
    units,
    [
      {
        label: 'com.inixiative.archive.collect.claude-code.kingdom',
        content: renderPlist(units[0]!),
      },
      { label: 'com.inixiative.archive.collect.codex.kingdom', content: 'old' },
      { label: 'com.inixiative.archive.collect.gone' },
      { label: 'com.inixiative.foundry' },
    ],
    'darwin',
    '/LA',
  );
  expect(plan.unchanged).toEqual(['com.inixiative.archive.collect.claude-code.kingdom']);
  expect(plan.write.map((w) => w.file)).toEqual([
    '/LA/com.inixiative.archive.collect.codex.kingdom.plist',
  ]);
  expect(plan.remove).toEqual(['com.inixiative.archive.collect.gone']);
});

test('launchd install writes plists, reloads with I/O error retry, prunes and uninstalls', () => {
  const home = temp(),
    dir = join(temp(), 'LaunchAgents');
  mkdirSync(dir);
  writeFileSync(join(dir, 'com.inixiative.archive.collect.gone.plist'), 'stale');
  writeFileSync(join(dir, 'com.inixiative.foundry.plist'), 'other');
  let failures = 1;
  const { calls, run } = fakeRunner((argv) => {
    if (argv[1] === 'bootstrap' && argv[3]!.endsWith('codex.kingdom.plist') && failures-- > 0)
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
  expect(result.loaded).toHaveLength(2);
  expect(existsSync(join(dir, 'com.inixiative.archive.collect.gone.plist'))).toBe(false);
  expect(existsSync(join(dir, 'com.inixiative.foundry.plist'))).toBe(true);
  expect(
    readFileSync(join(dir, 'com.inixiative.archive.collect.codex.kingdom.plist'), 'utf8'),
  ).toContain('<string>collect</string>');
  expect(existsSync(join(home, 'logs'))).toBe(true);
  const commands = calls.map((c) => c.slice(0, 3).join(' '));
  expect(commands[0]).toBe('launchctl bootout gui/501/com.inixiative.archive.collect.gone');
  expect(commands.filter((c) => c === 'launchctl bootstrap gui/501')).toHaveLength(3);
  expect(calls).toContainEqual([
    'launchctl',
    'bootout',
    'gui/501/com.inixiative.archive.collect.codex.kingdom',
  ]);

  calls.length = 0;
  const again = installAgents(config, options);
  expect(again).toMatchObject({ loaded: [], removed: [] });
  expect(again.unchanged).toHaveLength(2);
  expect(calls.every((c) => c[1] === 'print')).toBe(true);

  writeFileSync(
    join(home, 'logs', 'com.inixiative.archive.collect.codex.kingdom.out.log'),
    'one\n{\n  "imported": 1\n}\n',
  );
  const status = agentStatus(config, options);
  expect(status.find((s) => s.label.endsWith('.codex.kingdom'))).toMatchObject({
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

  expect(uninstallAgents(options).removed).toHaveLength(2);
  expect(existsSync(join(dir, 'com.inixiative.foundry.plist'))).toBe(true);
  expect(existsSync(join(dir, 'com.inixiative.archive.collect.codex.kingdom.plist'))).toBe(false);
});

test('systemd install reloads the daemon and enables units', () => {
  const home = temp(),
    dir = join(temp(), 'systemd');
  const { calls, run } = fakeRunner((argv) =>
    argv[2] === 'show' ? { stdout: 'ActiveState=active\nMainPID=7\n' } : {},
  );
  const options = { dir, run, platform: 'linux' as const, ...unitOptions(home) };
  const service = 'com.inixiative.archive.collect.codex.kingdom';
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
  await expect(runCli(['agents', 'install', '--home', temp()])).rejects.toThrow('agents.json');
});

test('token files: exactly one credential source, private regular file, read at request time', async () => {
  const dir = temp();
  const file = join(dir, 'archive.token');
  const base = { kind: 'archive', projectId: 'p', url: 'https://a.example/' };
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
      '--project-id',
      'p',
      '--token-file',
      file,
    ]);
    const saved = JSON.parse(readFileSync(join(home, 'destinations.json'), 'utf8'));
    expect(saved).toEqual([
      { projectId: 'p', url: instance.server.url.href, tokenFile: file, kind: 'archive' },
    ]);
  } finally {
    await instance.close();
  }
});
