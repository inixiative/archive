# Archive

MIT-licensed, local-first session storage for Claude Code, Codex and Foundry. Run it independently or connect through Foundry and Kingdom.

## What runs today

- Public transcript extraction, exact-project collection, immutable revisions in Postgres (pgvector and pg_trgm enabled), lexical search and lossless text chunks.
- An authenticated HTTP server, published image, Compose deployment with its own Postgres, Railway configuration and a Render blueprint.
- An HTTP client the CLI, collectors and Foundry write through; only the server holds the database.
- Multiple explicit destinations, durable publication receipts/outbox, conflict detection and retry after interruption.

Each deployment is one ownership boundary with one access token. Kingdom supplies account-based sharing. Use distinct deployments and credentials for personal and organization archives.

## Local setup

Run one Archive per machine with Docker Compose. It runs the published image with its own Postgres, on the `archive` block of the shared port registry (`bunx @inixiative/config ports archive`): HTTP on loopback 4700, Postgres on loopback 6132.

```sh
bun add --global @inixiative/archive
archive up      # creates ~/.local/share/archive/server.token, then docker compose up
archive down
```

`up` runs the `compose.yaml` that ships in the package (project `archive`) with `ARCHIVE_DATA_DIR` set to the archive home and the server token from its `server.token`. Postgres data lives in `$ARCHIVE_DATA_DIR/postgres` and the server's configuration (`destinations.json`, destination token files, the Kingdom pairing) in `$ARCHIVE_DATA_DIR/config`, so both survive rebuilds and volume prunes. Compose mounts the config directory at the same absolute path, so the CLI and the server read one `destinations.json` and every path in it resolves for both. `up` runs the image tagged with the CLI's own version, so a cached `latest` can never sit under a newer config layout; set `ARCHIVE_VERSION` to run another. Running Compose directly requires an absolute `ARCHIVE_DATA_DIR` and an `ARCHIVE_VERSION`; build from a checkout with `ARCHIVE_VERSION=local docker compose -f compose.yaml -f compose.build.yaml up -d --build`.

The server applies its schema migrations on start and requires bearer authentication for data endpoints; `/health` has no session data. Every other command talks to it over HTTP at `--url` (default `http://127.0.0.1:4700`) with the token in `--token-file` (default `~/.local/share/archive/server.token`) or `ARCHIVE_TOKEN`:

```sh
archive preview --directory /path/to/history --source codex
archive import --file /path/to/session.jsonl --source codex --project-id inixiative --tag coding
archive collect --directory /path/to/history --source codex --project-root /exact/session/cwd --project-id inixiative --watch
archive list
archive search --query 'migration'
```

Use `--source claude-code` for Claude histories. Collection matches the exact working-directory metadata recorded by the provider. Repeat `--project-root` to map several checkouts to one project; `--worktrees` also accepts every current git worktree of each root, re-read on each scan. Nested checkouts are separate mappings unless `--subdirectories` lets a root also take the directories below it; the longest matching root wins. `--catch-all` (no roots) takes every session no other collector of that source claims, as projectId `unrouted`; no destination may take `unrouted`, so those sessions never leave the machine. Subdirectory and catch-all matches skip the exclusions: temp directories (test fixtures, agent scratchpads) and `.foundry/decision-receipts` by default, plus each `--exclude` (absolute paths match below them, relative ones match those path segments anywhere); an exact root is explicit and still matches. Unknown directories, symlinks and sessions without usable metadata are skipped. Incomplete or changing files remain at source and retry on the next scan. The collector rescans every 30 seconds. A session whose digest the server already holds is not sent again, and a watching collector does not re-read a file whose size and mtime have not moved since its last outcome (it re-checks a stored session against the server every 10 minutes, so one deleted there is captured again). A session is captured into one project; a collector refuses one another project holds, except one the catch-all holds as `unrouted`, which moves to the project that now claims it. Collectors compete only with collectors over the same history directory. A watching collector waits out a server that is still starting. `serve --sync` backs off failed deliveries: 30 seconds after the first failure, doubling to at most 30 minutes, cleared on delivery. An archive a destination refuses waits alone, and is tried again at once when it has a new revision; a destination that does not answer (or answers 5xx) is skipped for all its archives until it is due.

To run the server without Docker, point `DATABASE_URL` at a Postgres with the `vector` and `pg_trgm` extensions available and run `archive serve [--port 4700] [--sync]`. Set `ARCHIVE_DEBUG=1` to see the underlying error when a command fails.

## Connect to BYO hosting

Every deployment runs the published image `ghcr.io/inixiative/archive` (tags: version, `latest`, commit SHA), built from main for amd64 and arm64, with `DATABASE_URL` pointing at Postgres 15 or later with pgvector, HTTPS in front, and a unique `ARCHIVE_SERVER_TOKEN` of at least 32 characters. It needs nothing else. The Render blueprint provisions the database, the image and a generated token together. On Railway, add a pgvector Postgres service and the image as a service with `DATABASE_URL` referencing it (`railway.json` builds the Dockerfile when deploying from the repository instead).

The local Archive publishes onward to destinations. Place the destination's token in a private file under the server's config directory (`chmod 600`, owned by you) or an environment variable, then run:

```sh
archive connect --url https://your-archive.example --project-id inixiative --token-file ~/.local/share/archive/config/credentials/inixiative.token
archive search --remote --query 'migration'
```

`setup` is an alias for `connect`. Setup verifies access before saving `<home>/config/destinations.json` and does not upload; the Compose server (`serve --sync`) reads it and publishes every 30 seconds. `sync` and `routes` ask that server to run the same publication, or preview it, once. The URL locates the server; the token grants access. Configuration stores only the token file path (`tokenFile`) or environment variable name (`--token-env`, `tokenEnv`), never the token. A token file is read on every request, so rotating it needs no restart; symlinks and files readable by group or others are refused. Redirects are refused; only HTTPS or loopback HTTP is allowed.

## Always-on local archiving

`archive agents` declares collectors in `~/.local/share/archive/agents.json` and installs them as launchd agents (macOS) or systemd user units (Linux). They run on the host, where the session histories are, and write to the local Archive server:

```sh
archive agents add-collector --name claude-code.inixiative --source claude-code --project-id inixiative --project-root ~/code/inixiative --worktrees
archive agents add-collector --name codex.inixiative --source codex --project-id inixiative --project-root ~/code/inixiative --worktrees
archive agents server --url http://127.0.0.1:4700   # only when not the default
archive agents install
archive agents status
```

`add-collector` upserts by `--name` (lowercase letters, digits, `.` and `-`); `--directory` defaults to `~/.claude/projects` or `~/.codex/sessions`, and `--project-root`, `--worktrees`, `--subdirectories`, `--catch-all` and `--atlas` behave as for `collect`. `remove-collector --name N`, `exclude [--exclude PATH ...]` (replaces the extra exclusions) and `server --url URL` edit the same file. `install` writes one unit per collector, `com.inixiative.archive.collect.<name>`, running `collect --agent <name> --watch`: the unit re-reads `agents.json` on every scan and routes each session against every collector of its source, so edits to roots and exclusions apply without a reinstall. Each runs the current Bun with this package's own `src/cli.ts`, restarts on exit (30 second throttle), works in the archive home and logs to `logs/<label>.{out,err}.log` there. Re-running `install` reloads only changed or stopped units and removes Archive units no longer declared. Units are written and loaded one at a time; a unit that fails to load gets its previous file back, so the next `install` loads it again, and `install` reports every failure after trying the rest (including the retired `local` and `sync` units); other launchd agents are untouched. `uninstall` removes every Archive unit; `status` reports each unit's load state, PID and last log entry. Re-run `install` after upgrading the package if its install path changes.

`@inixiative/archive/agents` exports the pure pieces for integrations: `agentsConfigSchema`, `agentUnits`, `renderPlist`, `renderSystemdUnit` and `planAgents`, plus `installAgents`, `uninstallAgents` and `agentStatus` with an injectable command runner and supervisor directory.

## Connect through Kingdom

Kingdom is the permission hub. Your machine's Archive talks directly only to local pieces, such as your local Foundry. It reaches a hosted Archive through Kingdom, by presenting a Signet.

First, pair this Archive with Kingdom:

```sh
bun run archive pair --kingdom https://api.your-kingdom.example --name "Work laptop" --organization your-org
```

`pair` registers this Archive with Kingdom as an **Installation**, named by a key kept in `<home>/config/kingdom/<kingdom host>/`. The same key is reused for every owner it registers with. It then asks to be registered as an integration, saying what it needs, and prints a review code with a link:

- `--organization SLUG|ID`: the organization it belongs to;
- `--library ID|NAME` (repeatable): `sessions.write` on those hosted libraries. Without it, the libraries this Archive's Kingdom destinations already name, or else every hosted Archive library of the owner.

Open the link. The review opens with that owner and those libraries selected; change them if you need to, and approve. The command waits for approval, then shows which owner it was registered with and asks you to accept. Pass `--yes` to accept without the prompt; without a terminal, `--yes` is required. Only then does it collect the Signet (0600) and list the libraries it may write to. Confirming the owner protects you if someone else claimed your code into their own owner.

Next, route a project to one of those libraries:

```sh
bun run archive connect --kind kingdom --url https://api.your-kingdom.example --credential-file ~/.local/share/archive/config/kingdom/KINGDOM_HOST/signet-SIGNET.json --integration-id HOSTED_ARCHIVE_INTEGRATION --resource-id LIBRARY --project-id inixiative
```

`connect` checks that the Signet grants `sessions.write` on that library before it saves anything. `serve --sync` then sends each changed session through `POST /api/v1/access/execute`. Every call carries the Signet's access token and a fresh DPoP proof (`@inixiative/signet` renews the token).

Kingdom enforces the grant on every write:

- It accepts only snapshots whose `sourceId` is this Archive's.
- It records the paired integration on the session's actor.
- It resolves a revision conflict from this source by writing over the hosted head. Older captures are still refused.

Each write is usage on the Signet. Revoke the Signet, or pause the local Archive integration in Kingdom, to stop it. `search --remote` uses `documents.search` when the Signet grants it.

Kingdom keeps no archive store. It forwards each write to the hosted Archive server, whose own token stays in Kingdom as an encrypted credential.

Foundry writes its captures to the local Archive server through `@inixiative/archive/remote`.

## Routing

Only explicit `projectId` matches authorize publication. An archive with no matching destination stays local. Multiple matches create deliberate separate copies. `routes` previews these destinations before upload. Tags, references and actors never change ownership or routing.

The server manages routes over HTTP too, so Foundry can read and set them. Only Kingdom destinations are set this way, through the Signets `pair` collected; direct token destinations stay CLI-only.

| Action | Body | Returns |
|---|---|---|
| `destinations/list` | `projectId?` | `destinations`: each as `connect` reports it, with `delivered` (archives acknowledged at their latest digest) and `pending` |
| `destinations/libraries` | none | `paired`, and the `libraries` (`integrationId`, `resourceId`, `name`) the held Signets may write to |
| `destinations/connect` | `projectId`, `integrationId`, `resourceId` | the saved destination, after Kingdom confirms `sessions.write` on the library (403 otherwise) |
| `destinations/remove` | `projectId`, `integrationId`, `resourceId` | `removed` |
| `destinations/routes` | none | each archive with the destinations its project routes to; nothing is sent |
| `destinations/sync` | none | one publication to every destination: `id`, `destination`, `status` per archive and route |

`@inixiative/archive/remote`'s `ArchiveClient` wraps these as `destinations()`, `libraries()`, `connectDestination()`, `removeDestination()`, `routes()` and `sync()`. The sync loop picks up changes within 30 seconds.

## Tags, references, actors and retention

The archive owns its tag system. It keeps two different things apart:

- **Tags** are concepts: the `atlas:<concept>` of repository files a session's tool calls touched (collectors with `--atlas`, from `atlas graph --json`), collector `--tag`s, and tags people add. **Suggestions** (`suggestedTags`) are the tagger's (`origin: "model"`, below) and are never applied. A person applies one with `tag --tag`; tags a person applied or removed never show as suggestions.
- **Run tags** mark sessions that are not a person's work: `run:test` (tests, probes) and `run:oracle` (Oracle and bench evaluations). The harness that runs a session stamps it explicitly, one of three ways: a `run:test`/`run:oracle` tag on the snapshot it writes (or `collect --tag`); `ARCHIVE_RUN=test|oracle` in the environment of a process that writes snapshots (Foundry, `archive import`); or a `.archive-run` file holding `test` or `oracle` in the working directory the runner made, or an ancestor (`stampRunDirectory` in `@inixiative/archive/exemption`), which collectors read at capture. *Interim, until every fixture and runner stamps:* the archive also infers `run:test` from Foundry's test fixture identities (project `P`, the `watch-A`/`watch-B` threads, ACP client probes outside a project) and from working directories (temp directories, scratchpads, `decision-receipts`), and `run:oracle` from Oracle eval workspaces, `.oracle` and bench run checkouts; these guesses go once the stamps cover them. A session captured earlier keeps its tags until it is captured again. An exempt session is kept but feeds nothing that learns from sessions: suggestions, retention scoring, correction mining (`foundry repeats`) or agent context. `list` and `search` leave exempt sessions out unless asked (`exempt: "include"` or `"only"`); routing and sync still see every session. Removing the run tag (`tag --untag run:test`) lifts the exemption.
- **References** point at items in an integration. Collectors record the session's GitHub repository and branch (`owner/repo`, `owner/repo/tree/branch`); linked GitHub pull requests, issues and commits (`owner/repo#24`, `owner/repo@sha`) and Linear issues (`KEY-12`) are found in the text and counted. A link is a mention, not proof of work. The archive's settings list the integrations it references: GitHub and Linear are recognized natively, and any other integration names the link prefix of its items (for example `https://acme.atlassian.net/browse/`); the item is what follows. Prefixes are literal, so settings cannot make matching slow.

```sh
bun run archive tag --id ARCHIVE_ID --tag reviewed --untag debugging
```

The **tagger** suggests, for every session that is not exempt: `junk` (empty, aborted, probes, accidental starts), up to three of the archive-wide category tags (`tags define`), and `project:<id>` when the session landed `unrouted` or without a project. It runs on the machine's Claude subscription: Claude Haiku 5.5 on primed, text-only Claude Code sessions from `@inixiative/agent-session` (no tools, MCP servers, user settings or instruction files; an API-key login is refused). The model judges every due session, in batches of short digests (counts, the first prompts, tools used, first and last replies), never whole transcripts; nothing is decided by keyword or size rules first. The only skip: a session is asked about once per digest, and is due again only when it changes or when the prompt, model or tag definitions do (`--refresh` asks again, for example after adding a project). Suggestions for an older digest are not shown. It reads only this machine's Archive, since session content goes to this machine's Claude login. Each run prints its calls and tokens.

```sh
bun run archive tags define --tag debugging --description "Diagnosing and fixing a failure"
bun run archive suggest [--limit N] [--batch 8] [--concurrency 2] [--refresh]
bun run archive list --suggested junk
bun run archive list --exempt only
```

Tag edits apply to that archive without a new revision, survive re-capture, and do not sync. Offered tags are defined archive-wide or for one actor. Each session can name its **actor**: a `user`, a `service` such as an API-key run, or a `job` (its id is the job name), with the `integrationId` it ran under when there is one. An organization's archive mostly holds its members' work, filterable per person. Entries the model produced record its `model` and `effort` (from Claude Code assistant records and Codex turn context, per turn); listings summarize them per session as `models` and filter by `model` and `effort`.

The **retention** setting (`retentionDays`, off by default) deletes archives whose latest capture is older than that, at server start and hourly. It deletes only from the archive it is set on; deletions never sync.

### HTTP API

All data endpoints are `POST /api/v1/archive/<action>` with a JSON body and `Authorization: Bearer <token>`:

| Action | Body | Returns |
|---|---|---|
| `ingest` | `snapshot`, `previousDigest` | id, digest, revision |
| `read` | `archiveId`, `revision?` | snapshot and chunks |
| `list` | filters, `limit?`, `beforeId?` | metadata, `nextCursor` |
| `search` | filters, `query`, `budget?`, `limit?`, `beforeId?` | matching chunks within the token budget |
| `tag` | `archiveId`, `add?`, `remove?` | tags |
| `delete` | `archiveId` | deleted |
| `settings/read`, `settings/update` | `integrations?`, `retentionDays?` | settings |
| `tags/list`, `tags/define`, `tags/remove` | `tag`, `actorId?`, `description?` | offered tags with usage counts |
| `suggestions/queue` | `key`, `limit?`, `beforeId?`, `refresh?` | sessions due for suggestions, as digests; routed `projects` |
| `suggestions/record` | `results` (`archiveId`, `digest`, `key`, `by`, `tags`) | recorded, stale (digest moved on), refused (exempt), dropped (tags not offered) |
| `destinations/list`, `destinations/libraries`, `destinations/connect`, `destinations/remove`, `destinations/routes`, `destinations/sync` | see [Routing](#routing) | routes |

Filters are `projectId`, `source`, `tag`, `suggestedTag`, `exempt`, `actorId`, `model`, `effort`, `provider`, `accessPath` and `reference` (`{integration, ref}`); `archive list` and `archive search` take them as flags. Jev integration is not enabled. Session content must not be sent to Jev without selecting that service for the relevant ownership boundary.

## Limits

- Public text/tool records only; no reconstruction of private reasoning or unsupported media. Coverage accompanies each snapshot.
- No automatic secret scrubber. Publication includes recorded public session content.
- Sync currently publishes local records to destinations; it does not mirror remote records locally or propagate deletions.
- Local search budgets are per session; hosted search budgets are across a response. Remote search queries every configured route; each response identifies its destination.
- No automatic remote deletion when routing changes. Existing copies keep their original owner's access rules.
- Deployment credentials, operational receipts and machine-specific routing belong outside the repository.

## Development

Tests create their own databases (`archive_test_*`) in the machine's Archive Postgres, so run `archive up` (or `docker compose up -d postgres`) first, or point `ARCHIVE_TEST_DATABASE_URL` at another pgvector Postgres:

```sh
archive up
bun run check
```

Schema changes go in `prisma/schema.prisma` with a migration (`bunx prisma migrate dev --name <change>` against a development database).

See [provenance](docs/PROVENANCE.md), [license](LICENSE), and [goals](tickets/README.md). The historical tickets describe earlier scope; this implementation now includes explicit provider collection and authenticated standalone hosting.

### ChatGPT conversation text

`archive import --file conversation.json --source chatgpt --project-id personal` accepts the JSON result of the desktop ChatGPT conversation reader (`thread`, `page`, and `turns`). This is a partial text capture, not a ChatGPT account export: tools, attachments, alternate branches and resolved citation targets are unavailable. ChatGPT conversations retain their own source identity.
