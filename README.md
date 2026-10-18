# Archive

MIT-licensed, local-first session storage for Claude Code, Codex and Foundry. Run it independently or connect through Foundry and Kingdom.

## What runs today

- Public transcript extraction, exact-project collection, immutable revisions in Postgres (only the current one is kept) (pgvector and pg_trgm enabled), lexical search and lossless text chunks.
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

Use `--source claude-code` for Claude histories. Collection matches the exact working-directory metadata recorded by the provider. Repeat `--project-root` to map several checkouts to one project; `--worktrees` also accepts every current git worktree of each root, re-read on each scan. Nested checkouts are separate mappings unless `--subdirectories` lets a root also take the directories below it; the longest matching root wins. `--catch-all` (no roots) takes every session no other collector of that source claims, as projectId `unrouted`; no destination may take `unrouted`, so those sessions never leave the machine. Subdirectory and catch-all matches skip the exclusions: temp directories (test fixtures, agent scratchpads) and `.foundry/decision-receipts` by default, plus each `--exclude` (absolute paths match below them, relative ones match those path segments anywhere); an exact root is explicit and still matches. Unknown directories, symlinks and sessions without usable metadata are skipped. Incomplete or changing files remain at source and retry on the next scan. The collector rescans every 30 seconds. A session whose digest the server already holds is not sent again, and a watching collector does not re-read a file whose size and mtime have not moved since its last outcome (it re-checks a stored session against the server every 10 minutes, so one deleted there is captured again). A session is captured into one project; a collector refuses one another project holds, except one the catch-all holds as `unrouted`, which moves to the project that now claims it. Collectors compete only with collectors over the same history directory. `archive repair [--agent NAME]` runs every collector in `agents.json` once from the transcripts still on disk, re-capturing each session as it routes now. It takes over a session another project holds only when that row holds another transcript (no entry in common): a row captured before subagent transcripts had their own identity holds a subagent's content under its parent's key and the subagent's project, which the guard would otherwise refuse forever. A row holding its own transcript keeps its project; it reports every session re-imported, with the project it left, and every refusal with its reason. A watching collector waits out a server that is still starting. `serve --sync` backs off failed deliveries: 30 seconds after the first failure, doubling to at most 30 minutes, cleared on delivery. An archive a destination refuses waits alone, and is tried again at once when it has a new revision; a destination that does not answer (or answers 5xx) is skipped for all its archives until it is due.

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

Tag edits apply to that archive without a new revision, survive re-capture, and do not sync. Offered tags are defined archive-wide or for one actor. Each session can name its **actor**: a `user`, a `service` such as an API-key run, or a `job` (its id is the job name), with the `integrationId` it ran under when there is one. An organization's archive mostly holds its members' work, filterable per person. Entries the model produced record its `model` and `effort` (from Claude Code assistant records and Codex turn context, per turn); listings summarize them per session as `models` and filter by `model` and `effort`. Each session also records its `runtime`: `provider` (`anthropic` for Claude Code, Codex's `model_provider`) and `accessPath` (`subscription`, `api` or `unknown`), with `evidence` `transcript` when the transcript proves it (a subscription's rate-limit window: Claude Code `quotaLimits`, Codex `rate_limits.plan_type`) or `harness` when the collector read the harness login instead (Claude Code's `oauthAccount` unless its settings supply an API key; Codex `auth.json`). A subagent run is its own session with `lineage`: `kind` (`subagent` or `fork`), `parentSessionId`, and what the harness recorded (`agentType`, `agentName`, `description`, `toolUseId`, `depth`; Claude Code's `agent-<id>.meta.json`, Codex's subagent `session_meta`). A Claude Code subagent transcript (`<session>/subagents/agent-<id>.jsonl`) is the session `<session>/agent-<id>`, never its parent's, with the agent id from its records or its file name; its `rootSessionId` is the thread, its `parentSessionId` the agent that spawned it (`meta.json` `parentAgentId`) or the thread, and `isFork` makes it a `fork`. A tree of sessions written by its driver (Foundry: a thread, its subagents, theirs) also carries `rootSessionId` (the tree's root) and `parentEntryId` (the parent's entry that spawned it), with `parentSessionId` the direct parent. Example: `models: [{model: 'claude-opus-5-5', effort: 'medium'}]`, `runtime: {provider: 'anthropic', accessPath: 'subscription', evidence: 'harness'}`.

A driver that records its own sessions (Foundry, for the native sessions it runs) **claims** them with a lease:
- **Holding.** `claims/hold` takes the lease, and holding again renews it. A re-hold also reopens a fulfilled claim. Another claimant's live lease is never taken over.
- **What the collector skips.** It skips a claimed session while the lease is live, or once the claim is **fulfilled** and the transcript has not changed since. `claims/fulfil` names this store's archive that covers the session, and only the claimant can fulfil.
- **What it falls back to.** Every session is kept. A lapsed, unfulfilled claim (the driver died), or a change made after fulfilment with no live lease, is captured raw on the next scan.
- **Superseded captures.** A raw capture of a fulfilled session is marked `supersededBy` the driver's archive. It is kept, and never delivered onward.
- **Subagents.** A Claude subagent transcript follows its session's claim. A Codex sub-agent thread is its own session, so the driver claims each one.
- **Checking.** `claims/state` reports `none`, `live` (with `until`), `fulfilled` or `lapsed`. The collector asks before it parses a transcript, and asks again when a lease it saw runs out.

The **retention** setting (`retentionDays`, off by default) deletes archives whose latest capture is older than that. It deletes only from the archive it is set on; deletions never sync.

**Compaction.** Each capture stores the session as a new immutable revision and deletes the revision it replaces, so an Archive holds only each session's current revision (a growing session's earlier revisions are prefixes of it). A revision an outbox row still names stays until that destination acknowledges it. Revision numbers keep counting. `read` with an earlier `revision` answers 410 (`Revision N was compacted`); one that never existed answers 404.

**Tool activity.** The `captureToolCallsAndResults` setting (on by default) says whether this Archive keeps tool calls and tool results. Off, the server drops `tool-call` and `tool-result` entries from every snapshot it ingests, whoever writes it (collectors, Foundry, a syncing Archive), and marks the snapshot's coverage `partial` with an omission saying so. What the person said or decided through a tool is not tool activity, and the importers record it as theirs (one recogniser per shape, `src/tool-activity.ts`):
- `user`: Claude Code's AskUserQuestion answers (`The user answered: "question"="answer"`, or the older `Your questions have been answered: …`), a rejected tool use or plan with typed feedback (`… the user said: …`), and Codex `request_user_input` answers, written with their questions;
- `event`: asking to clarify instead of answering; a rejection without feedback (`{"rejected": tool, "command"?}`); an ExitPlanMode approval, with the approved plan.

The strip keeps them too, re-deriving them from tool results captured before the importers did. Links found only in dropped tool output (a PR `gh pr create` opened) are recorded in `references` (at most 100; a coverage omission counts any cut). Two kinds of call stay as small `event`s with the call's id and `callId`: a subagent spawn (`Agent`, `Task`, `spawn_agent`), so a child's `lineage.toolUseId` still resolves, and a Codex `request_user_input_async` question whose answer message (`<send_user_message_question_reply>`, kept as an event) does not carry it. Foundry wraps native tool output in JSON and asks no questions through tools today, so these shapes are not looked for inside Foundry captures.

The ingest `digest` stays the digest of the snapshot as its writer sent it, so a collector's unchanged session stays unchanged and a change only to tool activity stores nothing new. `head` also returns `storedDigest`, the digest of what this Archive holds and publishes onward; `read` and `search` return the digest of the revision they return, which is that stored digest. Turning the setting off queues removal of the tool activity already held: each affected session gets one new revision without it, and the old one is compacted. That new revision is published to the session's destinations like any change, so a destination converges to the stripped copy even where it keeps tool activity itself: we keep no tool activity anywhere (Aron, 2026-10-18), so this is intended. Turning the setting back on keeps new tool activity from then on; it does not restore what was removed, and an unchanged session stays as stored.

**Maintenance** (retention, compaction, removal of past tool activity, then rebuilding the search index if it is missing) runs in the background at server start and hourly; an upgrade from an Archive that kept every revision compacts it there, one revision per statement. Shutting the server down stops it after the statement in progress; the next start resumes. A session whose tool activity cannot be removed is logged, listed in `maintenance status` and retried on the next run, without holding up the rest. Outbox rows no configured route will deliver (a removed destination, a superseded capture) are released, so the revisions they held are compacted. Maintenance and reclaim never run at once, and an index build already in progress is left to finish. Deleted rows free space inside Postgres; `maintenance reclaim` returns it to the operating system once compaction is done: it drops the trigram search index, runs `VACUUM (FULL, ANALYZE)` on `revisions` and `chunks` (each table locked while it is rewritten; needs free disk for the live rows) and rebuilds the index concurrently over current rows. `maintenance status` reports what is left, the table sizes and the last reclaim. On a disk too full to compact, drop the index first (`DROP INDEX CONCURRENTLY chunks_text_idx`): search still works without it, and maintenance rebuilds it when compaction finishes.

```sh
bun run archive settings --capture-tool-calls-and-results false
bun run archive maintenance status
bun run archive maintenance reclaim
```

### HTTP API

All data endpoints are `POST /api/v1/archive/<action>` with a JSON body and `Authorization: Bearer <token>`:

| Action | Body | Returns |
|---|---|---|
| `ingest` | `snapshot`, `previousDigest` | id, digest, revision |
| `read` | `archiveId`, `revision?` | snapshot and chunks; 410 for a compacted revision |
| `list` | filters, `limit?`, `beforeId?` | metadata, `nextCursor` |
| `search` | filters, `query`, `budget?`, `limit?`, `beforeId?` | matching chunks within the token budget |
| `tag` | `archiveId`, `add?`, `remove?` | tags |
| `delete` | `archiveId` | deleted |
| `head` | `archiveId` | `digest` (as its writer sent it), `storedDigest`, `revision`, `projectId`, `supersededBy` |
| `settings/read`, `settings/update` | `integrations?`, `retentionDays?`, `captureToolCallsAndResults?` | settings |
| `maintenance/status` | none | `supersededRevisions` (left to compact), `revisionsAwaitingDelivery`, `toolActivitySweepPending`, `toolActivitySweepFailures`, table sizes, `reclaim` state |
| `maintenance/reclaim` | none | `started`; 409 while maintenance runs or has work left, or a reclaim runs |
| `tags/list`, `tags/define`, `tags/remove` | `tag`, `actorId?`, `description?` | offered tags with usage counts |
| `claims/hold` | `claimant`, `ttlMs`, `sessions: [{source, sessionId}]` | `expiresAt` (holding again renews and reopens); 409 while another claimant's lease is live |
| `claims/fulfil` | `claimant`, `source`, `sessionId`, `archiveId` | `fulfilledBy`, `superseded` (raw captures marked); 404 when unclaimed or the archive is missing, 409 for another claimant |
| `claims/state` | `source`, `sessionId`, `modifiedAt?` | `state`: `none`, `live` (+ `until`), `fulfilled` or `lapsed` |
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
