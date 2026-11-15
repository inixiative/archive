# archive, for its Wardens

archive (`@inixiative/archive`) keeps every agent session, local-first, and syncs it to the
archives a person chooses. It captures Claude Code, Codex, Muse and Foundry sessions into Postgres
(pgvector, pg_trgm) behind an authenticated HTTP server, and publishes routed parts of them to
destinations. It is a published Bun/TypeScript package shipped as source, with the `archive` CLI.
Decisions about capture, routing and retention are in `docs/rules/archive-and-routing.md` (the docs
repo); a change that contradicts one goes to Aron first.

## Shape of the repository

- Entries (`package.json` exports, all `src/*.ts`): `.` (`index.ts`: the snapshot, entry and
  lineage schemas), `./store`, `./server`, `./client`, `./remote`, `./config`, `./schemas`,
  `./import`, `./import-file`, `./chatgpt`, `./preview`, `./collector`, `./agents`, `./tags`,
  `./exemption`, `./suggest`, `./cli`.
- Not exported: `route.ts` (the planner and decision sessions), `parts.ts`, `evidence.ts`,
  `tool-activity.ts`, `suggest-claude.ts` (the isolated subscription runner the tagger and planner
  share) and `kingdom.ts` (pairing).
- `store.ts` is the only code that touches the database; everything else reaches it through
  `server.ts` over HTTP with `remote.ts` (`ArchiveClient`). `client.ts` publishes to destinations.
  The schema is `prisma/schema.prisma`; `archive serve` migrates before it starts, and
  `startArchiveServer` does not.
- Docs: `README.md` (current behavior), `docs/ROUTING.md` (the routing spec, built),
  `docs/RETENTION.md` (the retention design, mostly not built: its headings say which),
  `docs/PROVENANCE.md`. `docs/ROUTING-TUNING.md` and the two review files are history; `tickets/`
  describe earlier scope.
- Check: `bun run check` (`tsc --noEmit`, `biome check .`, `bun test tests`). The tests need
  Postgres with pgvector (`ARCHIVE_TEST_DATABASE_URL`, or the local Archive's on 6132).

## Rules that hold everywhere

- A session is personal by default. It reaches an organization's archive only as routing-plan
  parts backed by evidence from that organization's closed set of projects; personal-only talk
  never publishes, Muse sessions are personal, and the planner's own runs are not captured.
- `publish` and `cleanup` in `destinations.json` gate what leaves the machine and what is removed.
- Deletes leave tombstones and retire parts; sync deletes at a destination only once that
  organization's `cleanup` is on (off by default).
- Retention today is `retentionDays` hard delete plus compaction. Coverage, citations, tiers and
  summaries in RETENTION.md are not built; never describe them as available.

## Words used here

session, snapshot, entry, revision, chunk, digest, head, tombstone, lineage, subagent, fork, part,
project, `unrouted`, collector, catch-all, root, worktree, folder filter, tag, reference, actor,
claim, lease, tagger, suggestion, routing plan, evidence, sensitivity pass, personal span,
destination, receipt, outbox, publish, cleanup, retention, compaction, tool activity, run session,
Kingdom pairing.
