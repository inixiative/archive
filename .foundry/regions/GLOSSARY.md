# archive glossary

**Every term archive's region Wardens use, alphabetical, each with the region that holds it.**

<!-- Generated with the region Warden docs by the region pipeline's assemble.py. A term defined by two regions appears once per region. -->

---

## A

**actor**  
Who produced a session: user, service or job, with an optional integrationId. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**agents.json**  
~/.local/share/archive/agents.json: server, folder filters, collectors and router settings. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**alwaysPersonal**  
True for Muse (collector source `muse`) or Meta-provider sessions; nothing overrides it. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**archive connect**  
Verify access and save a destination (alias `setup`); does not upload. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**archive serve**  
Run migrations then the server against DATABASE_URL; --sync also publishes every 30 seconds. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**archive suggest**  
The CLI tagger: runSuggestions with the Haiku subscription runner. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**archive sync --dry-run**  
Prints per destination the ids cleanup would delete; publishes nothing. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**archive up / archive down**  
Create the token and start, or stop, the local Compose stack. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**.archive-run**  
Marker file (RUN_MARKER) holding a run kind, in the run's working directory or an ancestor; ignored at the filesystem root, the home directory, and at or above any collector root. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**archive-settings**  
Class: the settings row and its schema (integrations, retentionDays, captureToolCallsAndResults, captureRunSessions) and the defaults. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**ARCHIVE_DATA_DIR**  
The archive home Compose mounts: postgres/ data and config/ (destinations.json, token files, pairing). *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**ARCHIVE_DEBUG**  
Set to 1 to print the underlying error when a command fails. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**ARCHIVE_RUN**  
Environment variable (RUN_ENV) giving a snapshot-writing process's run kind; read through stampedRun. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**ARCHIVE_SERVER_TOKEN**  
The env var a Compose or hosted server takes its token from. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**ARCHIVE_TEST_DATABASE_URL**  
Points the tests at a pgvector Postgres other than the local Archive's. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**archive_tombstones**  
Table of deleted sessions: key, the writer's last digest, transcriptDigest and projectId; never pruned. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**ARCHIVE_URL / ARCHIVE_TOKEN**  
Read by localArchive to find this machine's server and token. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**ARCHIVE_VERSION**  
The image tag Compose runs; archive up sets it to the CLI's own version. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**ArchiveConflict**  
Thrown by capture on a lost race or out-of-order write; HTTP 409. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**ArchiveFilter**  
list/search filters; actorId, reference and parts are HTTP/library only, no CLI flags. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**archiveKey**  
The stable id of a session across revisions, from sourceId, source and sessionId. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**archiveSettingsSchema**  
The zod schema for an Archive's settings object, from @inixiative/archive/store. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**archiveSnapshotSchema**  
The zod schema a snapshot must parse under before capture or exchange. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**atlas:<concept>**  
Tag for the Atlas concept of repository files a session's tool calls touched. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

## B

**backfill**  
`archive route --backfill [--dry-run]`: plan every unplanned session, parents first. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**background maintenance**  
Runs at server start and hourly: retention, compaction, run-session and tool-activity sweeps, fillStoredEvidence, then an index rebuild if the index is missing. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**backoff**  
30 s doubling to 30 min; per archive per destination for a refusal, whole destination for an outage. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**bun run check**  
tsc --noEmit, biome check . and bun test tests against a pgvector Postgres. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**BYO hosting**  
A hosted Archive on Render (blueprint) or Railway running the same image. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

## C

**Capture guarantee**  
Every Claude Code and Codex session is captured at its latest digest, or deliberately excluded, before the harness deletes it. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**captureRunSessions**  
Setting, on by default: off makes ingest drop explicitly stamped run sessions and starts a sweep of the ones already held. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**captureToolCallsAndResults**  
Setting (on by default): off drops tool-call and tool-result entries at ingest. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**captureToolCallsAndResults**  
Setting, on by default, that decides whether tool calls and results are kept (owned by capturing-sessions). *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**catch-all**  
A collector with no roots that takes every unclaimed session as projectId unrouted. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**checked**  
A plan every window of which passed the sensitivity pass; only its parts publish. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**checked**  
A plan whose every window passed the sensitivity pass (sensitivityKey); only checked plans publish. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**chunk**  
A lossless, ordered, token-counted piece of a revision's text, indexed with pg_trgm for search. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**chunks_text_idx**  
The trigram search index; drop it concurrently on a disk too full to compact. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**claim**  
A lease a driver takes on a native session (claimant, ttlMs) via claims/hold. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**ClaimHeld**  
Error for a claim held by another claimant, or fulfil by a non-holder. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**claims**  
Class: driver leases on native sessions so collectors do not capture them twice. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**claudeDecisionModel**  
Internal: primed, text-only Claude Code sessions with no tools, forked per request. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**claudeSuggestModel**  
Internal Haiku 5.5 runner on the machine's Claude login; not exported. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**cleanup**  
Top-level destinations.json key: off (default) | leaked | all; whether sync deletes at destinations. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**cleanupFor**  
Per-organization cleanup overrides; also the function reading the effective mode. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**cli**  
Class: the archive bin (runCli) and its subcommands, with migrate. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**collector**  
A configured scan of one source's history directory mapping working directories to a projectId. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**collectors**  
Class: collectSessions and its routing, folder filters, roots, catch-all and repair. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**com.inixiative.archive.collect.<name>**  
The launchd/systemd unit per collector, running collect --agent <name> --watch. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**com.inixiative.archive.route**  
The router unit, running route --watch --limit N. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**compaction**  
Each capture deletes the revision it replaces; reading a compacted revision answers 410. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**compaction-maintenance**  
Class: compaction to the current revision, background maintenance sweeps, reclaim and maintenance status. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**container root**  
A directory holding other projects' roots; naming it tags nothing. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**coverage**  
What a snapshot holds; partial with omissions when something (such as tool activity) was dropped. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**coverage partial**  
The mark, with an omission, on a snapshot stripped of tool activity. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

## D

**data-schema**  
Class: the Prisma models in prisma/schema.prisma and their migrations. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**DATABASE_URL**  
The Postgres (vector and pg_trgm) archive serve and a hosted image use. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**decision-receipts**  
Directories (**/decision-receipts) always excluded from collection. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**decision-receipts**  
The run directory planner runs live in; collectors exclude it, so the planner is never captured. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**decision-runner**  
Class: the isolated, text-only Claude Code runner for model passes (internal). *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**declared: false**  
agentStatus's mark for an installed Archive unit no longer in agents.json. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**defaultIntegrations**  
The built-in GitHub and Linear integrations. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**defaultSettings**  
The settings a fresh Archive starts with, from @inixiative/archive/schemas. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**delta**  
A pass over the prior plan plus entries added since. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**deployment**  
Class: running an Archive with Compose locally or the published image on a host. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**destination**  
A top-level `destinations` entry naming its `organizationId`: a direct Archive or a Kingdom library. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**destinations**  
Class: destination config: direct Archive and Kingdom destinations, connect/remove, token files, remote search. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**destinations.json**  
The routing file: top-level `organizations`, `destinations` (each with `organizationId`), `publish`, `cleanup`, `cleanupFor`, `personalSpans`. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**development**  
Class: working on this repo: checks, tests against pgvector Postgres, migrations. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**digests-and-chunks**  
Class: session identity, content digests, token counts and chunking (src/index.ts). *Region:* [Snapshots and the session store](session-store/knowledge.md)

**DPoP**  
Proof-of-possession signature sent fresh with each Kingdom call; @inixiative/signet renews the token. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**droppableRun**  
Decides whether a snapshot is an explicit run that ingest drops when captureRunSessions is off. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**dropped**  
Ingest's answer for a dropped run session: the run tag plus the writer's digest. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**due**  
A session marked for planning: new content after a pause, a route: change, a parent or subagent plan change, an organization or map change. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

## E

**evidence**  
What a session's tool calls wrote and read in which project, computed at ingest before the strip and kept on the row only. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**exact root**  
--project-root: a session's recorded cwd must equal it (or a worktree with --worktrees). *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**exempt session**  
A kept run session: it feeds no suggestions, retention scoring or agent context, and list and search hide it unless exempt is include or only. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**exemptRun**  
Returns the run kind a session's tags exempt it as, inferred tags included. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

## F

**firstEntryId / lastEntryId**  
The source entry range a part's lineage carries. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**folder filters**  
include/exclude globs over the session cwd, applied before any match; exclude wins. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**formerRoots**  
A collector's old checkout paths; evidence resolves them to the project, nothing is collected there. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**fulfilled**  
A claim whose driver named the archive covering the session (claims/fulfil). *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

## G

**ghcr.io/inixiative/archive**  
The published image (version, latest, commit SHA tags; amd64 and arm64). *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

## H

**/health**  
The unauthenticated endpoint; carries no session data. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**held**  
A plan or part kept personal for review: failed run, invalid plan, or a hold. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**held / heldBy**  
A session another project already holds; the collector leaves it there and names the holder. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**heldForReview**  
Plan entries kept personal for a person to review: personal-only talk under hold, unapplied redactions, planner-held parts. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**heldForReview**  
Entries held from personal-only talk under hold, unapplied redactions and parts the planner marked held. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**hold on detect**  
Under personalSpans hold, one found span keeps the whole part personal until `route review`. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**host-agents**  
Class: agents.json and the launchd/systemd units that run collectors and the router. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**http-api**  
Class: the server's POST actions, createArchiveHandler, startArchiveServer and the ArchiveClient side. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

## I

**Installation**  
This Archive registered with Kingdom, named by a key under `<home>/config/kingdom/<host>/`. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**integration**  
A source of references: GitHub and Linear natively, others by a literal link prefix. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

## J

**junk**  
The tagger's suggestion for empty, aborted, probe or accidental sessions. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

## K

**Kingdom**  
The permission hub; keeps no archive store and forwards writes to the hosted Archive. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**kingdom-pairing**  
Class: pairing with Kingdom: pairWithKingdom, held Signets, paired libraries, kingdomArchiveOperation. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

## L

**lapsed**  
An unfulfilled claim whose lease ran out; the collector then captures raw. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**leaked**  
A whole-session copy at a destination; `leaked` mode deletes it unless reviewed and routed whole while publish is off. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**library**  
A hosted Archive resource in Kingdom; pairing asks sessions.write and sessions.delete on it. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**lineage**  
A snapshot's link to its parent: kind subagent, fork or part, parentSessionId, rootSessionId, parentEntryId. *Region:* [Snapshots and the session store](session-store/knowledge.md)

## M

**machine project map**  
Every collector's roots, worktrees and pushed GitHub repos, built by machineProjectMap from agents.json. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**maintenance reclaim**  
Drops the trigram index, runs VACUUM (FULL, ANALYZE) on revisions and chunks, then rebuilds the index. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**MaintenancePending**  
Error (HTTP 409) when reclaim is refused because maintenance is running or sweeps have work left. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**migrate**  
Applies pending Prisma migrations; startArchiveServer does not call it. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**Muse**  
Meta's Muse Spark sessions; personal only, recorded as one personal part without a model call. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

## O

**organization**  
An entry of destinations.json `organizations`: an id, the projects it owns and an optional roster. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**outbox**  
A queued revision awaiting delivery to a destination. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**outbox-held revision**  
A revision an outbox row still names; it survives compaction until its destination acknowledges it. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**ownership boundary**  
One deployment with one access token; Kingdom provides account-based sharing. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

## P

**part**  
A contiguous entry range of a session, the only thing that publishes. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**part**  
A contiguous entry range stored as its own row `<sessionId>#part-<first entry id>`, lineage kind `part`. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**partOf**  
A part row's link to the session it was cut from. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**partOf**  
On an Archive row that is a routing part: the session it was cut from (not a foreign key). *Region:* [Snapshots and the session store](session-store/knowledge.md)

**pending**  
A tombstone's destination deletes still awaiting confirmation; stay queued while cleanup is off. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**personal**  
The organization value meaning stays on this machine only; the default for anything uncertain. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**personal-only**  
Class: what never publishes: career/investor/coworker talk, personalSpans, Muse and alwaysPersonal. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**personal-only talk**  
Career or job, investor or advisor talk and coworker complaints: personal for every organization. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**personalSpans**  
Top-level destinations.json key: `hold` (default) keeps the part personal, `redact` redacts the span. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**pg_trgm / vector**  
The Postgres extensions the schema requires; the embedding column is reserved and unwritten. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**pool**  
Run an async function over items with at most N at once; N is required. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**POST /api/v1/archive/<action>**  
Every data endpoint: JSON body, Authorization: Bearer <token>. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**previousDigest**  
The digest a writer last saw, sent with capture; a mismatch is an ArchiveConflict. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**product-overview**  
Class: what Archive runs today, its ownership boundaries and its stated limits. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**project: tag**  
A search-only tag of the projects a session worked in; never routes. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**project:<id>**  
Tag for each project whose roots hold a path the session accessed; search only, never routes. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**PROJECT_TAG_PREFIX**  
The constant 'project:'. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**projects/set**  
The action the host sends its project map with so the server can compute evidence. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**provenance references**  
The session's recorded GitHub repository and branch. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**prune**  
An entry the plan drops from a part as irrelevant. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**publish**  
The go-live switch (`archive publish on|off`), off by default; nothing new publishes while off. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

## R

**receipt**  
The digest a destination last acknowledged for an archive. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**redaction**  
A byte-exact quoted span replaced with `[redacted: <reason>]` wherever it appears in the part. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**REDACTION_REASONS**  
The closed reason set: coworker, career, personal-life, investor, secret, other. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**reference**  
A pointer {integration, ref} to an item such as owner/repo#24 or KEY-12. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**--refresh**  
Ask the tagger again for sessions already asked at this key. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**refused**  
A scan outcome with a reason, such as a session another project holds. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**remote-deletion**  
Class: deleting at destinations: re-plan deletes, leaked whole copies, cleanup/cleanupFor, tombstone-queued deletes, deleteRemote. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**restore**  
Flag on a re-routed part so a direct destination lifts its tombstone; Kingdom has no restore. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**retention-and-tombstones**  
Class: retentionDays and delete, both hard deletes that leave an archive_tombstones row that head and re-capture consult. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**retention-design**  
Class: docs/RETENTION.md, the capture guarantee and a labelled proposal (tiers, usefulness, citations, summaries) that is not built. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**retentionDays**  
Setting, off by default: deletes archives whose latest capture is older than N days, leaving tombstones. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**revision**  
An immutable stored copy of a session; only the current one (plus one awaiting delivery) is kept. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**RevisionCompacted**  
Thrown when a read asks for a revision compaction removed; HTTP 410. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**roster**  
An organization's coworker names, given to the planner and the sensitivity pass. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**route agent**  
The `com.inixiative.archive.route` unit running `route --watch --limit N` (30 by default). *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**route:<organization>**  
A person's tag edit deciding a session's organization; `route:personal` keeps it here. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**route:<organization>**  
A person's tag edit deciding ownership; `route:personal` keeps the session here. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**ROUTE_PROMPT**  
The planner's charter; with ROUTE_BASE_INSTRUCTIONS, SENSITIVITY_PROMPT and the model it makes routeKey. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**routeKey**  
Hash of the charters and model; a plan made under another key is re-planned. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**routing plan**  
A session's parts, their organizations, prunes, redactions, confidence and rationale; its own RoutingPlan record. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**routing-evidence**  
Class: per-entry write/read evidence, the machine project map, projects/set, formerRoots. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**routing-parts**  
Class: partSnapshot, part ids and lineage, redactText with the closed REDACTION_REASONS set. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**routing-planner**  
Class: ROUTE_PROMPT, parsePlan, validatePlan, scheduling, re-planning, backfill, plan records and review. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**routing-policy**  
Class: destinations.json organizations, the publish switch, sessionOrganizations; parts, never whole sessions. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**routingPreview**  
Backs `archive routes`: where each archive routes; sends nothing, reports no deletes. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**run-exemption**  
Class: run tags, how sessions get stamped as runs, and how exempt runs are kept or dropped. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**run:inferred**  
Written beside a run tag a collector guessed from a directory; such a session is exempt but never dropped. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**RUN_TAGS**  
Maps each run kind to its tag: run:test, run:oracle, run:foundry. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**runSessionSweepPending**  
maintenance status field: held run sessions are still being deleted after captureRunSessions was turned off. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**runSuggestions**  
Batch the due sessions through a caller-supplied model and record results. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**runtime**  
provider and accessPath (subscription, api, unknown) with evidence transcript or harness. *Region:* [Snapshots and the session store](session-store/knowledge.md)

## S

**sensitivity pass**  
A second Sonnet-low check per publishing part that can only add redactions or a hold (routing-planning). *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**sensitivity pass**  
A second Sonnet-low call per publishing part; can only add redactions or a hold; `route --no-sensitivity` turns it off. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**serve --sync**  
The server mode that runs syncArchives every 30 seconds. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**server token**  
The bearer token (32+ characters) the server requires; local one in ~/.local/share/archive/server.token. *Region:* [Serving, calling and running an Archive](running-the-archive/knowledge.md)

**sessionDigest**  
The short view (counts, first prompts, tools, first and last replies) the tagger sees. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**sessionOrganizations**  
The organizations a part publishes to under its validated plan; whole sessions and personal parts get none. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**shellAccess / toolCallAccess**  
Parse paths accessed and written by a shell script / one tool call. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**shellPaths / toolCallPaths**  
Paths accessed only, no writes. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**Signet**  
The credential `archive pair` collects (0600); every call carries its token and a DPoP proof. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**snapshot**  
One session as a validated object: sourceId, source, sessionId, entries, actor, runtime, lineage, references, tags, coverage. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**snapshot-contract**  
Class: the portable snapshot schema archiveSnapshotSchema and its parts. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**snapshotDigest**  
Content digest of one revision, ignoring capture time; changes with tags and references too. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**sourceId**  
This Archive's id; Kingdom accepts only its own, and cleanup never touches another's copies. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**stampRunDirectory**  
Writes a .archive-run marker into a test or eval workspace; refuses home, collector roots and git work-tree roots. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**sticky**  
Prunes, redactions and sensitive personal parts carried across re-plans until `route reset`. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

**store-api**  
Class: ArchiveStore and its errors over Postgres (src/store.ts). *Region:* [Snapshots and the session store](session-store/knowledge.md)

**stored evidence**  
Evidence filled from a stored snapshot (start project and references) under `stored:<key>` when no writer can re-send it. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**storedDigest**  
Digest of what this Archive holds and publishes; differs from digest only when ingest filtered the snapshot. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**storedDigest**  
head's digest of what this Archive holds; the ingest digest stays the writer's. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**--subdirectories**  
Opt-in: a root also takes directories below it; longest root wins. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**SUGGEST_PROMPT**  
The tagger's instruction text. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**suggestedTags**  
The tagger's suggestions (origin model); shown, never applied. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**suggestionKey**  
Hash of SUGGEST_PROMPT, model and tag definitions; a change makes sessions due again. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**supersededBy**  
On a raw capture of a fulfilled session: kept, never delivered onward. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**supersededBy**  
On a raw capture of a session its driver stored itself: kept, never delivered onward. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**sync-publish**  
Class: the sync loop: syncArchives, publishArchive, receipts and outbox, backoff, routes preview. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

## T

**tag**  
A concept label on an archive; a person's edit needs no revision and does not sync. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**tag definition**  
An offered category tag, archive-wide or for one actor (tags define). *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**tagger**  
Class: the model tagger's queue, prompt, parser and runSuggestions; never applied automatically. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**tags-and-references**  
Class: tags, Atlas and project: tags, references, tag definitions and the path parser. *Region:* [Tags, references and the tagger](tags-and-tagger/knowledge.md)

**tokenFile / tokenEnv**  
Where a direct destination's token lives; private file (chmod 600, no symlink) or env var name, never the token. *Region:* [Destinations, sync and Kingdom](destinations-and-sync/knowledge.md)

**tombstone**  
What delete or retentionDays leaves; head answers it with deleted: true and revision 0. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**tool-activity**  
Class: captureToolCallsAndResults and the strip of tool calls/results at ingest. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**transcript-import**  
Class: importers for Claude Code, Codex, Muse, ChatGPT text, and preview. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**transcriptDigest**  
Digest of the imported transcript only (source, session, entries), used to match tombstones. *Region:* [Snapshots and the session store](session-store/knowledge.md)

**transcriptDigest**  
Digest of source, session and entries only, so a re-tagged re-capture still matches its tombstone. *Region:* [What an Archive keeps](what-an-archive-keeps/knowledge.md)

**typedPrompt**  
What the person typed in a user message, minus injected content. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

## U

**unrouted**  
The reserved projectId of catch-all captures; no organization can own it. *Region:* [Capturing sessions into the Archive](capturing-sessions/knowledge.md)

**unrouted**  
The catch-all project id; the projectId schema refuses it so no organization can own it. *Region:* [Organizations, evidence and personal-only](routing-organizations/knowledge.md)

**UNROUTED**  
The reserved projectId 'unrouted' given to catch-all captures; no organization can own it. *Region:* [Snapshots and the session store](session-store/knowledge.md)

## V

**validatePlan**  
Internal check of a proposal against evidence; it narrows, never widens. *Region:* [Routing planner and parts](routing-planning/knowledge.md)

## W

**window**  
300k characters (ROUTE_WINDOW_CHARS); a longer session plans one window a pass. *Region:* [Routing planner and parts](routing-planning/knowledge.md)
