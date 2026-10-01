#!/usr/bin/env bun
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  agentStatus,
  defaultHistoryDirectory,
  defaultHome,
  installAgents,
  readAgents,
  uninstallAgents,
  upsertCollector,
  writeAgents,
} from './agents';
import { importChatGPTThread } from './chatgpt';
import {
  archiveRequest,
  kingdomFields,
  publishArchive,
  routingPreview,
  searchRemotes,
  syncArchives,
} from './client';
import { collectSessions } from './collector';
import { archiveDestinationSchema, connectDestination, readDestinations } from './config';
import { importTranscriptFile } from './import-file';
import { archiveKey } from './index';
import { LocalArchiveStore } from './local';
import { previewImports } from './preview';
import { startArchiveServer } from './server';

export async function runCli(args = Bun.argv.slice(2)) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      home: { type: 'string', default: defaultHome() },
      store: { type: 'string' },
      config: { type: 'string' },
      url: { type: 'string' },
      kind: { type: 'string', default: 'archive' },
      'project-id': { type: 'string' },
      'connection-id': { type: 'string' },
      'owner-model': { type: 'string' },
      'organization-id': { type: 'string' },
      'space-id': { type: 'string' },
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
      atlas: { type: 'boolean', default: false },
      tag: { type: 'string', multiple: true },
      untag: { type: 'string', multiple: true },
      limit: { type: 'string', default: '100' },
      port: { type: 'string' },
      name: { type: 'string' },
      hostname: { type: 'string', default: '127.0.0.1' },
      watch: { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
      remote: { type: 'boolean', default: false },
      destination: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const home = resolve(v.home!),
    config = v.config ?? join(home, 'destinations.json');
  const storePath = v.store ?? join(home, 'archives.sqlite');
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const command = positionals[0];
  if (v.help || !command) {
    console.log(
      'Archive: init | serve | connect (setup) | preview | import | collect | list | export | tag | routes | sync | search | agents\n' +
        'connect --url HTTPS_URL --project-id ID (--token-env ENV | --token-file PATH) [--kind kingdom [--connection-id ID] [--owner-model M --organization-id UUID --space-id UUID]]\n' +
        'import --file PATH --source codex|claude-code --project-id ID [--tag TAG]\n' +
        'tag --id ID [--tag TAG ...] [--untag TAG ...]\n' +
        'collect --directory HISTORY --source codex|claude-code --project-root EXACT_CWD [--project-root ...] [--worktrees] [--atlas] --project-id ID [--watch]\n' +
        'sync [--watch] | routes | search --query TEXT [--remote]\n' +
        'serve --home PATH [--port 4411 --hostname 127.0.0.1] [--sync]\n' +
        'agents add-collector --name N --source codex|claude-code --project-id ID --project-root DIR [--project-root ...] [--directory HISTORY] [--worktrees] [--atlas]\n' +
        'agents remove-collector --name N | serve on|off [--port P] | sync on|off | install | uninstall | status\n' +
        'All commands accept --home PATH; integrations may use --store FILE --config FILE.',
    );
    return;
  }
  if (command === 'init') {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tokenFile = join(home, 'server.token');
    if (!existsSync(tokenFile))
      writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(tokenFile, 0o600);
    const store = new LocalArchiveStore(storePath);
    store.close();
    output({ initialized: true, home, store: storePath, tokenFile });
    return;
  }
  if (command === 'serve') {
    const tokenFile = v['token-file'] ?? join(home, 'server.token');
    const token =
      process.env.ARCHIVE_SERVER_TOKEN ??
      (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
    const instance = startArchiveServer({
      store: storePath,
      token,
      port: Number(v.port ?? process.env.PORT ?? 4411),
      hostname: v.hostname,
    });
    output({ listening: instance.server.url.href, store: storePath, sync: v.sync });
    let stopped = false;
    // One process owns the store: the server and its sync share it, as in a container.
    const sync = (async () => {
      while (v.sync && !stopped) {
        try {
          const results = await syncArchives(instance.store, readDestinations(config));
          const failed = results.filter((r) => r.status.startsWith('failed')).length;
          if (failed) console.error(JSON.stringify({ sync: 'failed', archives: failed }));
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
  if (command === 'connect' || command === 'setup') {
    const tokenFile = v['token-file'] && resolve(v['token-file']);
    const destination = archiveDestinationSchema.parse({
      projectId: v['project-id'],
      url: v.url,
      tokenEnv: v['token-env'] ?? (tokenFile ? undefined : 'ARCHIVE_TOKEN'),
      tokenFile,
      kind: v.kind,
      ...(v.kind === 'kingdom'
        ? {
            connectionId: v['connection-id'],
            ownerModel: v['owner-model'],
            organizationId: v['organization-id'],
            spaceId: v['space-id'],
          }
        : {}),
    });
    // Verify credentials and protocol before saving; no records uploaded by setup.
    const probe = await archiveRequest(destination, 'search', {
      query: '',
      budget: 16,
      limit: 1,
      ...(destination.kind === 'archive'
        ? { projectId: destination.projectId }
        : kingdomFields(destination)),
    });
    if (!Array.isArray(probe.data?.archives))
      throw new Error('Destination is not an Archive-compatible endpoint');
    output(connectDestination(config, destination));
    return;
  }
  if (command === 'agents') {
    const file = join(home, 'agents.json');
    const current = readAgents(file);
    const [action, state] = positionals.slice(1);
    const toggle = () => {
      if (state !== 'on' && state !== 'off') throw new Error(`agents ${action} requires on|off`);
      return state === 'on';
    };
    const base = { collectors: [], ...current };
    if (action === 'add-collector') {
      if (!v.name || !v['project-id'] || !v['project-root'] || !v.source)
        throw new Error('add-collector requires --name, --source, --project-id and --project-root');
      const source = v.source as 'codex' | 'claude-code';
      output(
        writeAgents(
          file,
          upsertCollector(current, {
            name: v.name,
            source,
            directory: resolve(v.directory ?? defaultHistoryDirectory(source)),
            projectId: v['project-id'],
            projectRoots: v['project-root'].map((root) => resolve(root)),
            ...(v.worktrees ? { worktrees: true } : {}),
            ...(v.atlas ? { atlas: true } : {}),
          }),
        ),
      );
    } else if (action === 'remove-collector') {
      if (!v.name) throw new Error('remove-collector requires --name');
      output(
        writeAgents(file, {
          ...base,
          collectors: base.collectors.filter((c) => c.name !== v.name),
        }),
      );
    } else if (action === 'serve') {
      const { serve: _, ...rest } = base;
      output(
        writeAgents(
          file,
          toggle() ? { ...rest, serve: v.port ? { port: Number(v.port) } : {} } : rest,
        ),
      );
    } else if (action === 'sync') output(writeAgents(file, { ...base, sync: toggle() }));
    else if (action === 'install') {
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
      previewImports(v.file ?? v.directory!, v.source as 'codex' | 'claude-code', Number(v.limit)),
    );
    return;
  }
  if (command === 'search' && v.remote) {
    const results = await searchRemotes(readDestinations(config), v.query!);
    output(results);
    if (results.some((r) => 'error' in r)) process.exitCode = 1;
    return;
  }
  const store = new LocalArchiveStore(storePath);
  try {
    if (command === 'import') {
      if (
        !v.file ||
        !['codex', 'claude-code', 'chatgpt'].includes(v.source ?? '') ||
        !v['project-id']
      )
        throw new Error(
          'Import requires --file, --source codex|claude-code|chatgpt and --project-id',
        );
      const snapshot =
        v.source === 'chatgpt'
          ? importChatGPTThread(JSON.parse(readFileSync(v.file, 'utf8')), {
              sourceId: store.sourceId,
              projectId: v['project-id'],
              title: v.title,
            })
          : importTranscriptFile(v.file, {
              source: v.source as 'codex' | 'claude-code',
              sourceId: store.sourceId,
              projectId: v['project-id'],
              sessionId: v['session-id'],
              title: v.title,
            });
      snapshot.tags = [
        ...new Set([...(store.read(archiveKey(snapshot))?.snapshot.tags ?? []), ...(v.tag ?? [])]),
      ];
      output({
        ...store.capture(snapshot),
        entries: snapshot.entries.length,
        coverage: snapshot.coverage,
      });
    } else if (command === 'list') output(store.list());
    else if (command === 'routes') output(routingPreview(store, readDestinations(config)));
    else if (command === 'sync' || command === 'collect') {
      if (
        command === 'collect' &&
        (!v.directory ||
          !v['project-root'] ||
          !v['project-id'] ||
          !['codex', 'claude-code'].includes(v.source ?? ''))
      )
        throw new Error('Collect requires --directory, --source, --project-root and --project-id');
      let stopped = false;
      const stop = () => {
        stopped = true;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      do {
        if (command === 'collect') {
          const result = await collectSessions(store, {
            directory: v.directory!,
            source: v.source as 'codex' | 'claude-code',
            projectRoots: v['project-root']!,
            worktrees: v.worktrees,
            atlas: v.atlas,
            projectId: v['project-id']!,
            tags: v.tag,
          });
          output(result);
          if (!v.watch && result.failed) process.exitCode = 1;
        } else {
          const results = await syncArchives(store, readDestinations(config));
          output(results);
          if (!v.watch && results.some((r) => r.status.startsWith('failed'))) process.exitCode = 1;
        }
        if (v.watch && !stopped) await Bun.sleep(1000);
        // Short waits allow prompt shutdown; network requests have their own timeout.
        for (let i = 1; v.watch && !stopped && i < 30; i++) await Bun.sleep(1000);
      } while (v.watch && !stopped);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    } else if (command === 'publish') {
      if (!v.id || !v.destination) throw new Error('Publish requires --id and --destination');
      output(
        await publishArchive(
          store,
          v.id,
          archiveDestinationSchema.parse(JSON.parse(readFileSync(v.destination, 'utf8'))),
        ),
      );
    } else if (command === 'search')
      output(store.search(v.id ? [v.id] : store.list().map((a) => a.id), v.query!));
    else if (command === 'export' || command === 'tag') {
      const archive = v.id ? store.read(v.id) : undefined;
      if (!archive) throw new Error('Valid --id required');
      if (command === 'export') output(archive.snapshot);
      else {
        if (!v.tag?.length && !v.untag?.length)
          throw new Error('Tag requires at least one --tag or --untag');
        output(store.tag(archive.id, { add: v.tag, remove: v.untag }));
      }
    } else throw new Error('Unknown command; use --help');
  } finally {
    store.close();
  }
}

if (import.meta.main)
  runCli().catch(() => {
    console.error(
      'Archive command failed. Check arguments, destination access and local paths. Use --help for usage.',
    );
    process.exitCode = 1;
  });
