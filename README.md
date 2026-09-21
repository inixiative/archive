# Archive

MIT-licensed, local-first session storage for Claude Code, Codex and Foundry. Run it independently or connect through Foundry and Kingdom/Kastles.

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

`init` creates a local database and a private `server.token` under `~/.local/share/archive`. It prints the token's file path, never its value. `serve` binds to loopback port 4411. The server requires bearer authentication for data endpoints; `/health` has no session data.

```sh
bun run archive preview --directory /path/to/history --source codex
bun run archive import --file /path/to/session.jsonl --source codex --project-id inixiative --tag coding
bun run archive collect --directory /path/to/history --source codex --project-root /exact/session/cwd --project-id inixiative --watch
bun run archive list
bun run archive search --query 'migration'
```

Use `--source claude-code` for Claude histories. Collection matches the exact working-directory metadata recorded by the provider. Nested checkouts are separate mappings. Unknown directories, symlinks and sessions without usable metadata are skipped. Incomplete or changing files remain at source and retry on the next scan. The initial collector rescans files every 30 seconds; it deduplicates normalized content rather than maintaining byte-offset ingestion cursors. It retains prior manually assigned tags. It does not upload: run sync separately.

## Connect to BYO hosting

Deploy the included Dockerfile with a persistent volume mounted at `/data`, HTTPS, and a unique `ARCHIVE_SERVER_TOKEN` of at least 32 characters. Compose binds only to loopback; put an HTTPS reverse proxy in front for remote use. Railway needs a `/data` volume. The Render blueprint provisions a dedicated disk and generated token.

Place the destination's token in an environment variable, then run:

```sh
bun run archive connect --url https://your-archive.example --project-id inixiative --token-env INIXIATIVE_ARCHIVE_TOKEN
bun run archive routes
bun run archive sync
bun run archive sync --watch
bun run archive search --remote --query 'migration'
```

`setup` is an alias for `connect`. Setup verifies access before saving configuration and does not upload. The URL locates the server; the token grants access. Configuration stores only the environment variable name. Secrets must be available in the collector/sync process environment. Redirects are refused; only HTTPS or loopback HTTP is allowed.

`--home PATH`, `--store FILE` and `--config FILE` support custom paths. Keep the database with its source UUID when moving machines. Back up the entire database; a new store creates a new source identity.

## Connect through Kingdom

Use Kingdom's existing runtime enrollment for a user who manages the destination Kastle, then:

```sh
bun run archive connect --kind kingdom --url https://your-kingdom.example --kastle-id UUID --project-id inixiative --token-env KINGDOM_ARCHIVE_TOKEN
```

Optional repeated `--keep-id UUID` places sessions in Keeps owned by that Kastle. A Kingdom runtime credential is distinct from a standalone Archive token. Kingdom retains responsibility for user memberships, shares, revocation and hosted browsing. Connecting directly to Archive does not automatically register that server as a Kastle resource or mirror it into Kingdom; these are separate destinations.

Foundry exposes the same commands through `bun run archive`. Its defaults remain `.foundry/archives/archives.sqlite` and `.foundry/archives.json`. Its durable journal capture automatically publishes matching projects once destination credentials are in the viewer's environment. Restart the viewer after changing destination configuration.

## Routing, tagging and Jev

Only explicit `projectId` matches authorize publication. An archive with no matching destination stays local. Multiple matches create deliberate separate copies. `routes` previews these destinations before upload.

```sh
bun run archive tag --id ARCHIVE_ID --tag reviewed
```

Tags and heuristic category suggestions do not change ownership or routing. Jev integration is not enabled: the next step is labeled, shadow-mode tag/destination proposals, scored for accuracy and cross-organization mistakes before any automatic action. Session content must not be sent to Jev without selecting that service for the relevant ownership boundary.

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
