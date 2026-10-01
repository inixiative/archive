# Archive

MIT-licensed, local-first session storage for Claude Code, Codex and Foundry. Run it independently or connect through Foundry and Kingdom.

## What runs today

- Public transcript extraction, exact-project collection, immutable SQLite revisions, local lexical search and lossless text chunks.
- A standalone authenticated HTTP server, Docker image, persistent Compose deployment, Railway configuration and a Render blueprint.
- Multiple explicit destinations, durable publication receipts/outbox, conflict detection and retry after interruption.
- Native Foundry capture and context retrieval; Kingdom's existing Archives browser, ownership and sharing APIs.

This is an initial pilot, not a general multi-user standalone hosting service. Each standalone deployment is one ownership boundary with one access token. Kingdom supplies account-based sharing. Use distinct storage and credentials for personal and organization archives.

## Local setup

Install Bun 1.4.2 or later, then install the published CLI:

```sh
bun add --global @inixiative/archive
archive init
archive serve
```

For development from source:

```sh
bun install
bun run archive init
bun run archive serve
```

`init` creates a local database and a private `server.token` under `~/.local/share/archive`. It prints the token's file path, never its value. `serve` binds to loopback port 4411; with `--sync` it also publishes to its destinations every 30 seconds from the same process. The server requires bearer authentication for data endpoints; `/health` has no session data.

```sh
bun run archive preview --directory /path/to/history --source codex
bun run archive import --file /path/to/session.jsonl --source codex --project-id inixiative --tag coding
bun run archive collect --directory /path/to/history --source codex --project-root /exact/session/cwd --project-id inixiative --watch
bun run archive list
bun run archive search --query 'migration'
```

Use `--source claude-code` for Claude histories. Collection matches the exact working-directory metadata recorded by the provider. Repeat `--project-root` to map several checkouts to one project; `--worktrees` also accepts every current git worktree of each root, re-read on each scan. Nested checkouts are separate mappings. Unknown directories, symlinks and sessions without usable metadata are skipped. Incomplete or changing files remain at source and retry on the next scan. The initial collector rescans files every 30 seconds; it deduplicates normalized content rather than maintaining byte-offset ingestion cursors. It keeps tags captured earlier. It does not upload: run sync separately.

## Connect to BYO hosting

Every deployment runs the published image `ghcr.io/inixiative/archive` (tags: version, `latest`, commit SHA), built from main for amd64 and arm64. Give it a persistent volume at `/data`, HTTPS, and a unique `ARCHIVE_SERVER_TOKEN` of at least 32 characters; it needs nothing else and creates its store on first start. Compose (`compose.yaml`, also shipped in the npm package) bind-mounts `./data` (or `ARCHIVE_DATA_DIR`) at `/data`, so the store survives rebuilds, `down -v` and volume prunes, and binds only to loopback on port 4411 (or `ARCHIVE_PORT`); put an HTTPS reverse proxy in front for remote use. Pin a version with `ARCHIVE_VERSION`; build from a checkout with `docker compose -f compose.yaml -f compose.build.yaml up -d --build`. The Render blueprint runs the image with a dedicated disk and generated token. Railway deploys the image as a service with a `/data` volume (`railway.json` builds the Dockerfile when deploying from the repository instead).

Place the destination's token in a private file (`chmod 600`, owned by you) or an environment variable, then run:

```sh
bun run archive connect --url https://your-archive.example --project-id inixiative --token-file ~/.local/share/archive/credentials/inixiative.token
bun run archive routes
bun run archive sync
bun run archive sync --watch
bun run archive search --remote --query 'migration'
```

`setup` is an alias for `connect`. Setup verifies access before saving configuration and does not upload. The URL locates the server; the token grants access. Configuration stores only the token file path (`tokenFile`) or environment variable name (`--token-env`, `tokenEnv`), never the token. A token file is read on every request, so rotating it needs no restart; symlinks and files readable by group or others are refused. An environment variable must be set in the sync process environment. Redirects are refused; only HTTPS or loopback HTTP is allowed.

`--home PATH`, `--store FILE` and `--config FILE` support custom paths. Keep the database with its source UUID when moving machines. Back up the entire database; a new store creates a new source identity.

## Always-on local archiving

`archive agents` declares long-running agents in `~/.local/share/archive/agents.json` and installs them as launchd agents (macOS) or systemd user units (Linux):

```sh
archive init
archive connect --url https://your-archive.example --project-id inixiative --token-file ~/.local/share/archive/credentials/inixiative.token
archive agents add-collector --name claude-code.inixiative --source claude-code --project-id inixiative --project-root ~/code/inixiative --worktrees
archive agents add-collector --name codex.inixiative --source codex --project-id inixiative --project-root ~/code/inixiative --worktrees
archive agents serve on
archive agents sync on
archive agents install
archive agents status
```

`add-collector` upserts by `--name` (lowercase letters, digits, `.` and `-`); `--directory` defaults to `~/.claude/projects` or `~/.codex/sessions`, and `--project-root`, `--worktrees` and `--atlas` behave as for `collect`. `remove-collector --name N`, `serve on|off [--port P]` and `sync on|off` edit the same file. `install` writes one unit per agent: `com.inixiative.archive.local` (serve), `com.inixiative.archive.sync` (`sync --watch`) and `com.inixiative.archive.collect.<name>`. Each runs the current Bun with this package's own `src/cli.ts`, restarts on exit (30 second throttle), works in the archive home and logs to `logs/<label>.{out,err}.log` there. Re-running `install` reloads only changed or stopped units and removes Archive units no longer declared; other launchd agents are untouched. `uninstall` removes every Archive unit; `status` reports each unit's load state, PID and last log entry. One archive home per user account: units are named by agent, not by home. Sync reads destination token files itself, so no wrapper script is needed. Re-run `install` after upgrading the package if its install path changes.

Docker Compose is the alternative for the server: `docker compose up -d` runs `serve --sync`, so the container publishes to the destinations in its own `/data/destinations.json` (token files must live under `/data` too). It is a separate store from the host agents': connect it as a destination and let the `sync` agent publish to it; do not bind-mount the store the host agents are writing, since SQLite locking across the Docker VM boundary is unreliable. Collectors run on the host, where the session histories are.

`@inixiative/archive/agents` exports the pure pieces for integrations: `agentsConfigSchema`, `agentUnits`, `renderPlist`, `renderSystemdUnit` and `planAgents`, plus `installAgents`, `uninstallAgents` and `agentStatus` with an injectable command runner and supervisor directory.

## Connect through Kingdom

Pair a runtime with Kingdom (Foundry: Settings → Kingdom) and expose its `kingdom_runtime_` credential in an environment variable, then either let Kingdom store the archives:

```sh
bun run archive connect --kind kingdom --url https://your-kingdom.example --project-id inixiative --token-env KINGDOM_ARCHIVE_TOKEN
```

or forward them through Kingdom to a hosted Archive it has bound for that project:

```sh
bun run archive connect --kind kingdom --url https://your-kingdom.example --connection-id inixiative --project-id inixiative --token-env KINGDOM_ARCHIVE_TOKEN
```

Kingdom takes the owner from the runtime credential; `--owner-model`, `--organization-id` and `--space-id` narrow it to an organization or space that owner manages. A forwarding connection accepts only its bound `projectId`, and the hosted Archive's own token stays in Kingdom's server environment. A Kingdom runtime credential is distinct from a standalone Archive token. Kingdom retains responsibility for memberships, shares, revocation and hosted browsing.

Foundry exposes the same commands through `bun run archive`. Its defaults remain `.foundry/archives/archives.sqlite` and `.foundry/archives.json`. Its durable journal capture automatically publishes matching projects once destination credentials are in the viewer's environment. Restart the viewer after changing destination configuration.

## Routing

Only explicit `projectId` matches authorize publication. An archive with no matching destination stays local. Multiple matches create deliberate separate copies. `routes` previews these destinations before upload. Tags, references and actors never change ownership or routing.

## Tags, references, actors and retention

The archive owns its tag system. It keeps two different things apart:

- **Tags** are concepts: the `atlas:<concept>` of repository files a session's tool calls touched (collectors with `--atlas`, from `atlas graph --json`), collector `--tag`s, and tags people add. Heuristic categories are offered as `suggestedTags`, computed on read and never stored.
- **References** point at items in an integration. Collectors record the session's GitHub repository and branch (`owner/repo`, `owner/repo/tree/branch`); linked GitHub pull requests, issues and commits (`owner/repo#24`, `owner/repo@sha`) and Linear issues (`KEY-12`) are found in the text and counted. A link is a mention, not proof of work. The archive's settings list the integrations it references: GitHub and Linear are recognized natively, and any other integration names the link prefix of its items (for example `https://acme.atlassian.net/browse/`); the item is what follows. Prefixes are literal, so settings cannot make matching slow.

```sh
bun run archive tag --id ARCHIVE_ID --tag reviewed --untag debugging
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

Filters are `projectId`, `source`, `tag`, `actorId`, `model`, `effort` and `reference` (`{integration, ref}`). Jev integration is not enabled. Session content must not be sent to Jev without selecting that service for the relevant ownership boundary.

## Limits

- Public text/tool records only; no reconstruction of private reasoning or unsupported media. Coverage accompanies each snapshot.
- No automatic secret scrubber. Publication includes recorded public session content.
- Sync currently publishes local records to destinations; it does not mirror remote records locally or propagate deletions.
- Local search budgets are per session; hosted search budgets are across a response. Remote search queries every configured route; each response identifies its destination.
- No automatic remote deletion when routing changes. Existing copies keep their original owner's access rules.
- Deployment credentials, operational receipts and machine-specific routing belong outside the repository.

## Development

```sh
bun test
bun run typecheck
```

See [provenance](docs/PROVENANCE.md), [license](LICENSE), and [goals](tickets/README.md). The historical tickets describe earlier scope; this implementation now includes explicit provider collection and authenticated standalone hosting.

### ChatGPT conversation text

`archive import --file conversation.json --source chatgpt --project-id personal` accepts the JSON result of the desktop ChatGPT conversation reader (`thread`, `page`, and `turns`). This is a partial text capture, not a ChatGPT account export: tools, attachments, alternate branches and resolved citation targets are unavailable. ChatGPT conversations retain their own source identity.
