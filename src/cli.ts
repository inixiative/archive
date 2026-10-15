#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  agentStatus,
  collectorPlan,
  defaultHistoryDirectory,
  defaultHome,
  installAgents,
  readAgents,
  uninstallAgents,
  upsertCollector,
  writeAgents,
} from './agents';
import { importChatGPTThread } from './chatgpt';
import { archiveRequest, type SyncBackoff, searchRemotes, syncArchives } from './client';
import { type CollectorCache, collectSessions, defaultExclusions, UNROUTED } from './collector';
import {
  archiveDestinationSchema,
  connectDestination,
  destinationsFile,
  kingdomDirectory,
  readDestinations,
} from './config';
import { stampedRun } from './exemption';
import { importTranscriptFile } from './import-file';
import { pairingRequest, pairWithKingdom, verifyKingdomDestination } from './kingdom';
import { previewImports } from './preview';
import { ArchiveClient, DEFAULT_URL } from './remote';
import { startArchiveServer } from './server';

/** Applies pending schema migrations to the archive database. */
export function migrate(databaseUrl: string) {
  const schema = fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url));
  const run = Bun.spawnSync(
    [process.execPath, 'x', 'prisma', 'migrate', 'deploy', '--schema', schema],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdout: 'ignore', stderr: 'pipe' },
  );
  if (!run.success) throw new Error(`Archive migration failed: ${run.stderr.toString().trim()}`);
}

export async function runCli(args = Bun.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: 'string', default: defaultHome() },
      config: { type: 'string' },
      url: { type: 'string' },
      kind: { type: 'string', default: 'archive' },
      'project-id': { type: 'string' },
      'integration-id': { type: 'string' },
      'resource-id': { type: 'string' },
      'credential-file': { type: 'string' },
      kingdom: { type: 'string' },
      organization: { type: 'string' },
      library: { type: 'string', multiple: true },
      'token-env': { type: 'string' },
      'token-file': { type: 'string' },
      file: { type: 'string' },
      directory: { type: 'string' },
      source: { type: 'string' },
      title: { type: 'string' },
      'session-id': { type: 'string' },
      id: { type: 'string' },
      query: { type: 'string', default: '' },
      'project-root': { type: 'string', multiple: true },
      worktrees: { type: 'boolean', default: false },
      subdirectories: { type: 'boolean', default: false },
      'catch-all': { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true },
      agent: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'access-path': { type: 'string' },
      atlas: { type: 'boolean', default: false },
      tag: { type: 'string', multiple: true },
      untag: { type: 'string', multiple: true },
      description: { type: 'string' },
      exempt: { type: 'string' },
      suggested: { type: 'string' },
      batch: { type: 'string', default: '8' },
      concurrency: { type: 'string', default: '2' },
      refresh: { type: 'boolean', default: false },
      limit: { type: 'string' },
      port: { type: 'string' },
      name: { type: 'string' },
      hostname: { type: 'string', default: '127.0.0.1' },
      watch: { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  const home = resolve(v.home!),
    config = v.config ?? destinationsFile(home),
    tokenFile = v['token-file'] ? resolve(v['token-file']) : join(home, 'server.token');
  // Not console.log: with Prisma loaded, console.log to a pipe stops at 64 KB.
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const command = positionals[0];
  if (v.help || !command) {
    process.stdout.write(
      'Archive: init | up | down | serve | connect (setup) | preview | import | collect | repair | list | export | tag | tags | suggest | routes | sync | search | agents\n' +
        'up | down   (the local Archive: bundled compose.yaml with Postgres, data in --home)\n' +
        'serve [--port 4700 --hostname 127.0.0.1] [--sync]   (DATABASE_URL; token from ARCHIVE_SERVER_TOKEN or --token-file)\n' +
        'import --file PATH --source codex|claude-code|chatgpt --project-id ID [--tag TAG]\n' +
        'collect --directory HISTORY --source codex|claude-code (--project-root CWD [--project-root ...] --project-id ID [--worktrees] [--subdirectories] | --catch-all) [--exclude PATH ...] [--atlas] [--watch]\n' +
        'collect --agent NAME [--watch]   (one collector from agents.json, routed against the others, re-read each scan)\n' +
        'repair [--agent NAME]   (every collector once, from the transcripts still on disk: re-captures each session as it routes now, taking over one another project holds, and reports every session re-imported or refused)\n' +
        'list | search --query TEXT [--remote]   [--project-id ID] [--source S] [--tag T] [--suggested T] [--exempt exclude|include|only] [--provider P] [--model M] [--effort E] [--access-path subscription|api|unknown]\n' +
        'export --id ID | tag --id ID [--tag TAG ...] [--untag TAG ...]\n' +
        'tags list | tags define --tag TAG [--description TEXT] | tags remove --tag TAG   (the category tags the archive offers)\n' +
        'suggest [--limit N] [--batch 8] [--concurrency 2] [--model claude-haiku-5-5] [--refresh]   (tag suggestions on the Claude subscription; test and Oracle runs are exempt)\n' +
        "pair --kingdom KINGDOM_API_URL [--name NAME] [--organization SLUG|ID] [--library ID|NAME ...] [--yes]   (register this Archive with Kingdom, asking for sessions.write on those libraries, by default the ones its Kingdom destinations name, else the owner's; claim the review code there, then confirm the owner)\n" +
        'connect --url HTTPS_URL --project-id ID (--token-env ENV | --token-file PATH)   (a remote Archive, for serve --sync)\n' +
        'connect --kind kingdom --url KINGDOM_API_URL --credential-file PATH --integration-id UUID --resource-id UUID --project-id ID   (a hosted Archive through Kingdom)\n' +
        'sync | routes   (the server publishes to, or previews, its destinations once)\n' +
        'agents add-collector --name N --source codex|claude-code (--project-id ID --project-root DIR [--project-root ...] [--worktrees] [--subdirectories] | --catch-all) [--directory HISTORY] [--atlas]\n' +
        'agents remove-collector --name N | exclude [--exclude PATH ...] | server --url URL | install | uninstall | status\n' +
        `Data commands talk to the Archive server at --url (default ${DEFAULT_URL}) with the token in --token-file (default <home>/server.token) or ARCHIVE_TOKEN.\n`,
    );
    return;
  }
  const exemptMode = (value: string): 'exclude' | 'include' | 'only' => {
    if (value !== 'exclude' && value !== 'include' && value !== 'only')
      throw new Error('--exempt is exclude, include or only');
    return value;
  };
  const whole = (value: string, name: string, max: number) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > max)
      throw new Error(`--${name} must be a whole number from 1 to ${max}`);
    return parsed;
  };
  const readToken = () =>
    existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : undefined;
  const init = () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!existsSync(tokenFile))
      writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tokenFile, 0o600);
  };
  if (command === 'init') {
    init();
    output({ initialized: true, home, tokenFile });
    return;
  }
  const packageVersion = () =>
    (
      JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      }
    ).version;
  if (command === 'up' || command === 'down') {
    // The machine's one local Archive: the bundled compose file, with its data in the home.
    if (command === 'up') init();
    const compose = fileURLToPath(new URL('../compose.yaml', import.meta.url));
    const run = Bun.spawnSync(
      [
        'docker',
        'compose',
        '--project-name',
        'archive',
        '--file',
        compose,
        ...(command === 'up' ? ['up', '--detach', '--wait'] : ['down']),
      ],
      {
        env: {
          ...process.env,
          ARCHIVE_DATA_DIR: home,
          ARCHIVE_VERSION: process.env.ARCHIVE_VERSION ?? packageVersion(),
          // Compose requires the variable even to stop; down never needs the real token.
          ARCHIVE_SERVER_TOKEN: readToken() ?? 'x'.repeat(32),
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    if (!run.success) throw new Error(`docker compose ${command} failed`);
    output(command === 'up' ? { running: DEFAULT_URL, home } : { stopped: true });
    return;
  }
  const databaseUrl = () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    return url;
  };
  if (command === 'serve') {
    const url = databaseUrl();
    migrate(url);
    const instance = await startArchiveServer({
      databaseUrl: url,
      token: process.env.ARCHIVE_SERVER_TOKEN ?? readToken() ?? '',
      port: Number(v.port ?? process.env.PORT ?? 4700),
      hostname: v.hostname,
      config: { destinationsFile: config, kingdomDirectory: kingdomDirectory(home) },
    });
    output({ listening: instance.server.url.href, sync: v.sync });
    let stopped = false;
    // One process owns the database connection: the server and its sync share it.
    // Failed deliveries back off across cycles instead of being re-sent every 30 seconds.
    const backoff: SyncBackoff = new Map();
    const sync = (async () => {
      while (v.sync && !stopped) {
        try {
          const results = await syncArchives(instance.store, readDestinations(config), { backoff });
          const failed = results.filter((r) => r.status.startsWith('failed'));
          if (failed.length) console.error(JSON.stringify({ sync: 'failed', archives: failed }));
        } catch {
          console.error(JSON.stringify({ sync: 'unavailable' }));
        }
        for (let i = 0; i < 30 && !stopped; i++) await Bun.sleep(1000);
      }
    })();
    const stop = async () => {
      stopped = true;
      await sync;
      await instance.close();
      process.exit(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  if (command === 'pair') {
    if (!v.kingdom) throw new Error('pair requires --kingdom KINGDOM_API_URL');
    const local = new ArchiveClient({
      url: v.url ?? DEFAULT_URL,
      token: process.env.ARCHIVE_TOKEN ?? readToken() ?? '',
    });
    output(
      await pairWithKingdom({
        kingdom: v.kingdom,
        name: v.name ?? `${hostname()} Archive`,
        sourceId: await local.sourceId(),
        directory: kingdomDirectory(home),
        request: pairingRequest({
          kingdom: v.kingdom,
          organization: v.organization,
          libraries: v.library,
          destinations: readDestinations(config),
        }),
        onReview: (review) => console.error(JSON.stringify(review)),
        onError: (error) =>
          console.error(`Still waiting: ${error instanceof Error ? error.message : String(error)}`),
        confirmOwner: async ({ ownerName }) => {
          if (v.yes) return true;
          if (!process.stdin.isTTY)
            throw new Error(`Registered with ${ownerName}; rerun with --yes to accept it`);
          const answer = prompt(`Kingdom registered this Archive with ${ownerName}. Accept? [y/N]`);
          return /^y(es)?$/i.test(answer?.trim() ?? '');
        },
      }),
    );
    return;
  }
  if (command === 'connect' || command === 'setup') {
    const destination = archiveDestinationSchema.parse(
      v.kind === 'kingdom'
        ? {
            kind: 'kingdom',
            projectId: v['project-id'],
            url: v.url,
            credentialFile: v['credential-file'] && resolve(v['credential-file']),
            integrationId: v['integration-id'],
            resourceId: v['resource-id'],
          }
        : {
            kind: 'archive',
            projectId: v['project-id'],
            url: v.url,
            tokenEnv: v['token-env'] ?? (v['token-file'] ? undefined : 'ARCHIVE_TOKEN'),
            tokenFile: v['token-file'] && resolve(v['token-file']),
          },
    );
    // Verify credentials and protocol before saving; no records uploaded by setup.
    if (destination.kind === 'kingdom') await verifyKingdomDestination(destination);
    else {
      const probe = await archiveRequest(destination, 'search', {
        query: '',
        budget: 16,
        limit: 1,
        projectId: destination.projectId,
      });
      if (!Array.isArray(probe.data?.archives))
        throw new Error('Destination is not an Archive-compatible endpoint');
    }
    output(connectDestination(config, destination));
    return;
  }
  if (command === 'agents') {
    const file = join(home, 'agents.json');
    const current = readAgents(file);
    const action = positionals[1];
    const base = { collectors: [], ...current };
    if (action === 'add-collector') {
      const catchAll = v['catch-all'];
      if (!v.name || !v.source || (!catchAll && (!v['project-id'] || !v['project-root'])))
        throw new Error(
          'add-collector requires --name, --source, and --project-id with --project-root (or --catch-all)',
        );
      const source = v.source as 'codex' | 'claude-code';
      output(
        writeAgents(
          file,
          upsertCollector(current, {
            name: v.name,
            source,
            directory: resolve(v.directory ?? defaultHistoryDirectory(source)),
            projectId: catchAll ? UNROUTED : v['project-id']!,
            projectRoots: catchAll ? [] : v['project-root']!.map((root) => resolve(root)),
            ...(v.worktrees ? { worktrees: true } : {}),
            ...(v.subdirectories ? { subdirectories: true } : {}),
            ...(catchAll ? { catchAll: true } : {}),
            ...(v.atlas ? { atlas: true } : {}),
          }),
        ),
      );
    } else if (action === 'exclude') {
      const { exclude: _, ...rest } = base;
      output(writeAgents(file, { ...rest, ...(v.exclude?.length ? { exclude: v.exclude } : {}) }));
    } else if (action === 'remove-collector') {
      if (!v.name) throw new Error('remove-collector requires --name');
      output(
        writeAgents(file, {
          ...base,
          collectors: base.collectors.filter((c) => c.name !== v.name),
        }),
      );
    } else if (action === 'server') {
      if (!v.url) throw new Error('agents server requires --url');
      output(writeAgents(file, { ...base, server: { url: v.url } }));
    } else if (action === 'install') {
      if (!current) throw new Error('No agents.json; declare agents first');
      output(installAgents(current, { home }));
    } else if (action === 'uninstall') output(uninstallAgents({ home }));
    else if (action === 'status') output(agentStatus(current, { home }));
    else throw new Error('Unknown agents command; use --help');
    return;
  }
  if (command === 'preview') {
    if (
      Boolean(v.file) === Boolean(v.directory) ||
      !['codex', 'claude-code'].includes(v.source ?? '')
    )
      throw new Error('Preview requires one --file or --directory and --source codex|claude-code');
    output(
      previewImports(
        v.file ?? v.directory!,
        v.source as 'codex' | 'claude-code',
        Number(v.limit ?? 100),
      ),
    );
    return;
  }
  if (command === 'search' && v.remote) {
    const results = await searchRemotes(readDestinations(config), v.query!);
    output(results);
    if (results.some((r) => 'error' in r)) process.exitCode = 1;
    return;
  }
  const token = process.env.ARCHIVE_TOKEN ?? readToken();
  if (!token) throw new Error('No Archive token: run `archive init` or set ARCHIVE_TOKEN');
  const agentsFile = join(home, 'agents.json');
  const archive = new ArchiveClient({ url: v.url ?? DEFAULT_URL, token });
  if ((command === 'list' || command === 'search') && (v.tag?.length ?? 0) > 1)
    throw new Error('Filter by one --tag at a time');
  const filter = {
    ...(v['project-id'] ? { projectId: v['project-id'] } : {}),
    ...(v.source ? { source: v.source as 'claude-code' | 'codex' | 'foundry' | 'chatgpt' } : {}),
    ...(v.tag?.length ? { tag: v.tag[0] } : {}),
    ...(v.provider ? { provider: v.provider } : {}),
    ...(v.model ? { model: v.model } : {}),
    ...(v.effort ? { effort: v.effort } : {}),
    ...(v['access-path']
      ? { accessPath: v['access-path'] as 'subscription' | 'api' | 'unknown' }
      : {}),
    ...(v.exempt === undefined ? {} : { exempt: exemptMode(v.exempt) }),
    ...(v.suggested ? { suggestedTag: v.suggested } : {}),
  };
  if (command === 'routes') output(await archive.routes());
  else if (command === 'tags') {
    const action = positionals[1] ?? 'list';
    if (action === 'list') output(await archive.tagDefinitions());
    else if (action === 'define' || action === 'remove') {
      if (v.tag?.length !== 1) throw new Error(`tags ${action} requires one --tag`);
      output(
        action === 'define'
          ? await archive.defineTag({
              tag: v.tag[0]!,
              ...(v.description ? { description: v.description } : {}),
            })
          : await archive.undefineTag({ tag: v.tag[0]! }),
      );
    } else throw new Error('Unknown tags command; use --help');
  } else if (command === 'suggest') {
    // Session content goes to this machine's own Claude login, so only this machine's Archive is read.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(v.url ?? DEFAULT_URL).hostname))
      throw new Error('suggest reads only this machine’s Archive');
    const { runSuggestions } = await import('./suggest');
    const { claudeSuggestModel } = await import('./suggest-claude');
    const concurrency = whole(v.concurrency!, 'concurrency', 8);
    const model = await claudeSuggestModel({
      home,
      ...(v.model ? { model: v.model } : {}),
      concurrency,
    });
    // Collectors' roots name the projects whose ids are opaque (a Foundry or Kingdom id).
    const projectLabels: Record<string, string> = {};
    for (const collector of readAgents(agentsFile)?.collectors ?? [])
      if (collector.projectRoots.length)
        projectLabels[collector.projectId] = [
          ...new Set([projectLabels[collector.projectId], ...collector.projectRoots]),
        ]
          .filter(Boolean)
          .join(', ');
    try {
      output(
        await runSuggestions(archive, {
          model,
          batch: whole(v.batch!, 'batch', 20),
          concurrency,
          ...(v.limit ? { limit: whole(v.limit, 'limit', 100_000) } : {}),
          refresh: v.refresh,
          projectLabels,
          progress: (line) => console.error(line),
        }),
      );
    } finally {
      await model.close();
    }
  } else if (command === 'sync') {
    const results = await archive.sync();
    output(results);
    if (results.some((r) => r.status.startsWith('failed'))) process.exitCode = 1;
  } else if (command === 'import') {
    if (
      !v.file ||
      !['codex', 'claude-code', 'chatgpt'].includes(v.source ?? '') ||
      !v['project-id']
    )
      throw new Error(
        'Import requires --file, --source codex|claude-code|chatgpt and --project-id',
      );
    const sourceId = await archive.sourceId();
    const snapshot =
      v.source === 'chatgpt'
        ? importChatGPTThread(JSON.parse(readFileSync(v.file, 'utf8')), {
            sourceId,
            projectId: v['project-id'],
            title: v.title,
          })
        : importTranscriptFile(v.file, {
            source: v.source as 'codex' | 'claude-code',
            sourceId,
            projectId: v['project-id'],
            sessionId: v['session-id'],
            title: v.title,
          });
    const run = stampedRun();
    snapshot.tags = [...new Set([...(run ? [run] : []), ...(v.tag ?? [])])];
    output({
      ...(await archive.capture(snapshot)),
      entries: snapshot.entries.length,
      coverage: snapshot.coverage,
    });
  } else if (command === 'list') output(await archive.list(filter));
  else if (command === 'collect') {
    const flagged = () => {
      const catchAll = v['catch-all'];
      if (
        !v.directory ||
        !['codex', 'claude-code'].includes(v.source ?? '') ||
        (!catchAll && (!v['project-root'] || !v['project-id']))
      )
        throw new Error(
          'Collect requires --agent, or --directory, --source and --project-root with --project-id (or --catch-all)',
        );
      const collector = {
        directory: v.directory,
        source: v.source as 'codex' | 'claude-code',
        projectRoots: catchAll ? [] : v['project-root']!,
        projectId: catchAll ? UNROUTED : v['project-id']!,
        worktrees: v.worktrees,
        subdirectories: v.subdirectories,
        catchAll,
        atlas: v.atlas,
        tags: v.tag,
      };
      return {
        collector,
        peers: [collector],
        exclude: [...defaultExclusions(), ...(v.exclude ?? [])],
        server: undefined as { url: string } | undefined,
      };
    };
    // A named collector re-reads agents.json each scan, so its routing follows edits without a restart.
    const plan = () => {
      if (!v.agent) return flagged();
      const config = readAgents(agentsFile);
      if (!config) throw new Error('No agents.json; declare agents first');
      return collectorPlan(config, v.agent);
    };
    plan();
    const cache: CollectorCache = new Map();
    // A named collector writes to the server agents.json declares (unless --url), re-read each scan.
    let client = archive;
    let clientUrl = v.url ?? DEFAULT_URL;
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    do {
      let current: ReturnType<typeof plan>;
      try {
        current = plan();
      } catch (error) {
        if (!v.watch) throw error;
        console.error(
          JSON.stringify({ collect: 'agents.json unusable', error: (error as Error).message }),
        );
        for (let i = 0; !stopped && i < 30; i++) await Bun.sleep(1000);
        continue;
      }
      try {
        const { collector, peers, exclude, server } = current;
        const url = v.url ?? server?.url ?? DEFAULT_URL;
        if (url !== clientUrl) {
          client = new ArchiveClient({ url, token });
          clientUrl = url;
        }
        const started = Date.now();
        const result = await collectSessions(client, collector, { peers, exclude, cache });
        output({ ...result, ms: Date.now() - started });
        if (!v.watch && result.failed) process.exitCode = 1;
      } catch (error) {
        // The server may be starting; a watching collector retries.
        if (!v.watch) throw error;
        console.error(JSON.stringify({ collect: 'server unavailable' }));
      }
      // Short waits allow prompt shutdown; network requests have their own timeout.
      for (let i = 0; v.watch && !stopped && i < 30; i++) await Bun.sleep(1000);
    } while (v.watch && !stopped);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  } else if (command === 'repair') {
    // Every collector once, as the collectors route today, taking over sessions held under another
    // project (a row that holds a subagent's transcript under its parent's key, from before 0.2).
    const config = readAgents(agentsFile);
    if (!config) throw new Error('No agents.json; declare agents first');
    const names = v.agent ? [v.agent] : config.collectors.map((c) => c.name);
    const results = [];
    for (const name of names) {
      const { collector, peers, exclude, server } = collectorPlan(config, name);
      const client = new ArchiveClient({ url: v.url ?? server?.url ?? DEFAULT_URL, token });
      const started = Date.now();
      const result = await collectSessions(client, collector, { peers, exclude, repair: true });
      results.push({ collector: name, ...result, ms: Date.now() - started });
      if (result.failed) process.exitCode = 1;
    }
    output(results);
  } else if (command === 'search')
    output(
      await archive.search({
        ...filter,
        query: v.query,
        limit: Math.min(100, Number(v.limit ?? 100)),
      }),
    );
  else if (command === 'export' || command === 'tag') {
    if (!v.id) throw new Error('Valid --id required');
    if (command === 'export') {
      const read = await archive.read(v.id);
      if (!read) throw new Error('Valid --id required');
      output(read.snapshot);
    } else {
      if (!v.tag?.length && !v.untag?.length)
        throw new Error('Tag requires at least one --tag or --untag');
      output(await archive.tag(v.id, { add: v.tag, remove: v.untag }));
    }
  } else throw new Error('Unknown command; use --help');
}

if (import.meta.main)
  runCli().catch((error) => {
    console.error(
      process.env.ARCHIVE_DEBUG
        ? error
        : 'Archive command failed. Check arguments, server and destination access, and local paths. Use --help for usage. Set ARCHIVE_DEBUG=1 for details.',
    );
    process.exitCode = 1;
  });
