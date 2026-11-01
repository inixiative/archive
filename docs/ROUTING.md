# Archive routing: an agentic pass over each session artifact (draft v2 for Aron, 2026-11-01)

v1 (two signals must agree, whole-session skip) is superseded by Aron's 11-01 direction; v1's measurements still stand and feed v2 as evidence.

## The rule, one paragraph

Every session is captured locally and kept whole there (the personal Archive; local only for now). After a session has been idle ~30 min, a **routing agent** (Sonnet 5.5 on the subscription, low effort, no tools, through the same isolated runner the tagger uses, its own run exempt from capture) reads the **stripped artifact**, i.e. the typed text, assistant text and events that survive the tool-activity strip, plus an **evidence table** the collector computed at capture while the tool calls still existed: write targets and reads per organization (path → project by longest root → organization through Archive's org map: Zealot → UserEvidence, the `~/code/inixiative` container and its repos → inixiative, else personal), the start cwd, and references (repos, PRs, Linear keys). It returns a **routing plan**: zero or more **parts** (entry ranges; a whole session is one part), and for each part the organizations it is relevant to (several allowed; duplication is fine), the entries to **prune** as irrelevant to that organization, **redactions** (span → replacement, with a reason: disparaging or complaining about coworkers, career or job plans, personal life, investor or advisor talk, secrets), a relevance and confidence, and a one-line rationale per decision. The agent is free to overrule the evidence table: the table says where files changed, the agent decides whose work it was. Each part publishes to each named organization as a **derived snapshot** (lineage pointing at the source session and its entries). What isn't confidently some organization's stays personal only. A new revision re-runs the agent with the prior plan plus the new entries; a part whose plan changes is republished, and a part that no longer belongs is deleted from that organization. Failure (runner down, timeout, unparseable plan) holds the session; nothing publishes by default. Every plan and its rationale is stored and visible; low-confidence plans and every redaction go to a review queue; a person's override is a tag edit that survives re-capture and re-runs. The same agent runs once over the existing 1,172 sessions and recategorizes them, including deleting the already-leaked sessions from the UserEvidence Archive.

## Why this shape

- Aron 11-01: "an agentic run on the session artifacts … to figure out where to put them, how to prune them, how to sanitize them, and if they're relevant"; "you can split up sessions"; "things can get duplicated … routed to multiple things if they're relevant"; Sonnet, "a single-digit percentage of your tokens"; the routing run itself "should not generate a session that we care about"; "recategorize things that you think are wrong". Earlier the same day: route by where the session is working, not where it started; Zealot → UE, inixiative GitHub → inixiative, else personal.
- Aron 10-31: default personal; work only when very convinced; sensitive stays personal or redacted; routing gets a review loop; touched-project routing isn't enough.
- Why the evidence table still matters: measured over 2,876 native transcripts (1,055 with tool calls), raw touches mislead (77's coordinator thread touched `~/code/zealot` 97 times, all reads, while building Zealot Wardens in Foundry), and the stripped text loses which repo files changed. Writes per organization are the one thing the agent can't recover from the artifact, so the collector records them before the strip.
- Cost, measured on the local Archive: the stripped artifacts total ~8.6M tokens across 1,172 sessions (events 5.0M, i.e. cross-session messages, notifications and subagent prompts; assistant 3.0M; user 0.5M). Median session ~1.3k tokens, p90 ~10k, p99 ~108k; 7 sessions over 150k get chunked. The one-time backfill is ~9M input tokens of Sonnet; steady state is new sessions plus deltas on revisions.

## Existing primitives reused (no parallel machinery)

| Concern | Primitive (path) | How / bridge |
|---|---|---|
| model runner, isolation, subscription | `suggest-claude.ts` (`ClaudePrimedSessions`, per-run dir under `decision-receipts/`, allowlisted env, user hooks/plugins off, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`) | same runner, second charter; model Sonnet instead of the tagger's Haiku |
| suggestion + review loop | `suggest.ts` queue (`/suggestions/queue`, `/suggestions/record`), `suggestedTags` applied by a person; tag edits survive re-capture | the routing plan is a suggestion record with rationale; override = tag edit |
| routing run not captured | run tags / exemption (`exemption.ts`), collector folder exclusions | the runner's directory is exempt the way the tagger's is; verify with a test that no routing run lands in the Archive |
| paths a tool call touches | `toolCallPaths`, `shellPaths`, `shellCommands` (`tags.ts`) | add a write-target mode to the same parser (one parser, two modes) |
| path → project → org | `projectPaths` (`tags.ts`), collector roots + worktrees (`collector.ts`), `routing.organizations` (`config.ts`) | unchanged; evidence counts come from the loop `projectTags` already runs |
| references | `archiveReferences` (`tags.ts`: "a link is not proof of work") | go into the evidence table, never route on their own |
| capture-time transform | `tool-activity.ts` strip at ingest | evidence computed before the strip, stored as a small record on the session |
| parts | `archiveLineageSchema` (`index.ts:48`, kinds `subagent \| fork`, `parentSessionId`, `parentEntryId`) | add a `part` kind with the source entry range; a part is a derived snapshot, not a new model |
| routing → destinations | `sessionOrganizations` / `sessionDestinations` (`config.ts`), `publishArchive` digest-ack (`client.ts`) | input changes from "own + touched projects" to "the plan's parts × organizations"; publish path unchanged |
| removal | `/api/v1/archive/delete` (`server.ts`) | used when a re-plan drops a part, and for the backfill's leak cleanup |

## Duplicate vs expose (Aron: "or I can just expose my inixiative archive there")

Recommendation: **expose for primitives, duplicate only for UE work.** Template and primitive work (json-rules, permissions, transitions…) that's useful to Zealot stays in the inixiative Archive, and UserEvidence reads it through a Kingdom Signet on the inixiative Archive. One copy, revocable, and no inixiative content lands in the employer's store. Work actually done *for* Zealot inside an inixiative session (the Zealot port PR) is a part published to UE.

The bridge: today an Archive Signet's lens narrows only by `documentIds` and `fields` (`kingdom/apps/api/src/modules/access/services/signets/resolveArchiveSelection.ts:11`). The inixiative Archive also holds closed work (Oracle, Kingdom internals, investor talk), so exposing it whole is wrong. Archive search already filters by `tag` (`archive/src/server.ts:41`). Adding a `tags` field to the Archive lens, enforced by passing it as that filter, scopes UE's Signet to e.g. the open-source projects' tags. That's an extension of the existing lens, not new permission machinery. The UE Archive itself is a direct Render Archive, not on Kingdom; UE's agents would read the inixiative slice through Kingdom.

## Test cases (real sessions; archive id → expected plan)

| Kind | Archive id | What it is | Evidence (measured) | Expected |
|---|---|---|---|---|
| personal | d395f6886b, cf32dc9761, ae88b51ff2 | rice cooker, lagoon salinity, supplements | none | personal only |
| sensitive personal | 65fa49fe13 | Codex career advice; read Zealot docs | reads → UE (8) | personal only. **On UE today → delete.** |
| sensitive opener + inixiative work | 512aaec0a6 | investor-advisor opener, then template work | writes → inixiative (121) | split: opener personal; template work → inixiative. **On UE today → delete.** |
| UE work | 671481a4f6, 95a4acd0e0 | Grant's PR review; ADP Omni export | reads → UE / none, cwd zealot | UE |
| UE work, inixiative cwd | 382e18e4cb | Zealot prod error loop via Render/Doppler | writes → inixiative (3 stray backups); reads UE 14 | UE (agent overrules the stray writes) |
| UE work, inixiative cwd | 388f6c08c7, 1d3942e03f | ADP sales MCP; port template commit into Zealot PR | reads → UE (25); writes → UE (6) | UE |
| inixiative work on Zealot data | 6b93e47069 | Oracle mining Zealot PRs as fixtures | writes → inixiative (34) | inixiative |
| sensitive inside work | 01b0bda06a | Zealot PR 4590 + "vlad deleted a bunch of my work" | mixed (UE 47 / inixiative 26) | UE with the Vlad lines redacted; the json-rules part → inixiative. **On UE today unredacted → replace.** |
| inixiative | 074e44d0, 40b206fa84 | Foundry pool thread; 77's coordinator thread | foundry; writes → inixiative (7) | inixiative |

Pass bar before go-live: every row matches, and every redaction on a sample of 30 more UE-bound sessions is read by Aron once.

## Not in v1

A hosted personal Archive (none exists; personal = local); "another Kingdom" routing (UE is a direct Render Archive); the lens `tags` field ships with the exposure, after routing. Required alongside, not deferred: collector coverage of pool subscription homes (`foundry/.foundry/kingdom/subscriptions/*/claude`), so raw pool transcripts are captured.

## v3: changes from the adversarial review (ROUTING-SPEC.review.md, verdict REVISE; claims spot-checked in code)

1. **The plan can narrow, never widen (B1, injection).** Code validates every plan: a part may go to an organization only if that part's own entries carry evidence for it (writes or reads in its repos, its references, or a start cwd there). Destinations come from a closed enum; each redaction must match the entry text byte for byte; entries quoted from other sessions (cross-session messages, task notifications) follow their own session's decision. A plan that fails validation goes to review, never to publish. Confidence never gates publishing. The planner's text can't send anything anywhere the evidence doesn't already allow.
2. **Parts are real local rows (B2).** A part's session id is `<sessionId>#part-<first entry id>`, stable across re-plans, with lineage kind `part`. Parts are kept out of local search, suggestions and retention. They inherit the source's `supersededBy`, so a superseded raw capture's parts never publish. Re-adding a part that was deleted clears its tombstone; that's an explicit writer action, not a silent swallow. Kingdom gets a `sessions.delete` operation on the Archive integration, which it lacks today.
3. **Subagent trees route as one (B4).** The plan runs on the root session, with its subagents as context. A child can't reach an organization its tree doesn't.
4. **Codex cells (B5).** `toolCallPaths` reads an `exec` cell's `workdir` and the `apply_patch` calls nested in it.
5. **Evidence is computed at ingest (B6).** `store.capture` computes it before the strip, so Foundry threads (their `tool` entries), imports and collector captures all carry it, and it travels with the row that actually publishes.
6. **The planner runs on the host (S4).** A scheduled job beside the collectors, since the sync inside Docker can't spawn the host `claude` login. It's pinned to the personal Claude login (S6). Plans are their own suggestion kind, not the tagger's row, and they never route until validated.
7. **Measure redaction recall, not just precision (S2).** Before go-live, read 30 UE-bound part snapshots whole. That's the published thing, so a missed line is visible. The planner gets a coworker roster (S6), and redactions and "personal" decisions stay sticky across re-plans (S3).
8. **Expose via lens is deferred (B3).** Kingdom applies the lens only to search. Read returns any document, Archive's tag filter takes a single tag, and `project:` tags mean "touched", not "about". Changing what a lens permits gets its own spec. Until then, primitives work useful to Zealot is duplicated as a part, which Aron allowed.
9. **Write attribution (S5).** Zealot worktrees under `/private/tmp` resolve to Zealot through `git worktree list`, not as neutral temp. `gh --repo X` in the space form counts. A third-party repo inside the container is personal.

## Personal-only talk: the second check and hold on detect (Aron, 2026-11-01)

Career or job talk, investor or advisor talk, and complaints about or disparaging remarks on coworkers are personal for every organization, inixiative included; they never publish to any organization. Secrets and personal life are redacted as before.

- **The planner** is told so: such talk is personal whatever organization it is about, even the person's own company.
- **The sensitivity pass** (on by default; `route --no-sensitivity` turns it off) makes a second Sonnet-low call per part that would publish to an organization. The call reads that part's entries, its organizations and their rosters, and returns redactions or a hold. It can only remove: its redactions join the planner's, and a hold or an unreadable answer keeps the part personal.
- **Hold on detect** (`routing.personalSpans: hold`, the default; `archive personal-spans hold|redact`): when the planner or the pass finds a span of personal-only talk in a work part, the whole part stays personal and its entries go to `heldForReview`. They stay personal through re-plans until `route review`. With `redact`, the span is redacted and the part publishes.

- **Hold everywhere** (PR #37 review, Q1): in hold mode the check runs over every part of the plan on every record, re-apply and rebuild, prior parts included. A plan made under `redact`, or before hold existed, can't keep such a part routed. `personalSpans` is part of the routing context key, so switching it makes every plan due to re-validate.
- **Pass holds are sticky** (Q2): a part the pass holds is sent as `held` on the proposal and lands in `heldForReview`. An explicit `hold: true` also marks it `sensitive`, kept personal for good. A rebuild or reset run with `--no-sensitivity`, or by an older router, can't route it.
- **Only checked plans publish** (Q3): a plan records `checked` (`sensitivityKey`: the pass's charter and the model) only when every window it covers was checked. With publishing on, `publishArchive` and sync publish a part only if its plan is checked, whichever client recorded it; sync reports the others as `held: not checked by the sensitivity pass`. The pass's charter is part of `routeKey`, so a change to it makes plans due.
- **Per-wake cap:** `agents router --limit N` (`router.limit`, default 30) is passed to `route --watch --limit`, so a large due set is planned across wakes instead of in one burst. That's about 22k tokens a session with the pass on (measured 2026-11-01).

Why hold and not redact: redaction depends on finding every span, and both the planner and the pass missed spans in the runs measured (ROUTING-TUNING.md). A hold depends only on finding one. Its cost is that a work part holding such talk publishes nothing until a person reviews it.

Open for Aron: Tribe (remote owner `tribeutils`) is in the inixiative org map. Inixiative?

## Cadence (Aron, 2026-11-01; replaces "after ~30 min idle")

The planner doesn't wait for a session to go idle. A host scheduler wakes every couple of minutes. It looks for sessions with new entries since their last plan, picks the ones due (each session at most about once an hour, with due times staggered so not everything runs at once), and spawns one planner run per due session. That run owns the session's plan. Each pass is a **delta**: the prior plan plus the entries added since it. A session that has paused, with no new entries for ~30 minutes, gets its pending delta planned at once, and the plan's version bumps. Published parts change version only when their plan changes.

## As built (2026-11-01, branch `feat/agentic-routing`)

| Concern | Where |
|---|---|
| Evidence (write-target mode, one parser) | `src/tags.ts` `shellAccess` / `toolCallAccess`; `src/evidence.ts`; computed in `store.capture` before the strip, kept on the row (`evidence`, `evidenceKey`) |
| Project map (roots, worktrees, origin repos) | `agents.ts` `machineProjectMap` → `projects/set`; the collector sends each session's `cwd` |
| Parts | `src/parts.ts` `partSnapshot`; `store.applyParts` / `forgetDelivery`; lineage kind `part`; columns `partOf`, `routedTo` |
| Planner, validator | `src/route.ts` (`ROUTE_PROMPT`, `validatePlan`, `publishedParts`, `planSession`); `store.routingInput` / `recordPlan`; `RoutingPlan` table |
| Runner (isolated, pinned login) | `src/suggest-claude.ts` `claudeDecisionModel`, `claudeRouteModel`, `sweepDecisionRuns` |
| Scheduler | `store.routingDue`, `route.ts` `runRouting`, `archive route --watch`, `agents router` (LaunchAgent `com.inixiative.archive.route`) |
| Routing switch, delete on re-plan | `config.ts` `sessionOrganizations`; `client.ts` `syncArchives` deletion pass, `deleteRemote` |
| Backfill | `route.ts` `runBackfill`, `archive route --backfill [--dry-run]` |

**Review items.** B1: `validatePlan` (closed set, evidence per part, byte-exact redactions with a closed reason set and a fixed marker, foreign entries follow their own session, failure holds, confidence only orders the queue). B2: part ids `<sessionId>#part-<first entry id>`; one content per part (prunes and redactions are per part, not per organization, so one id never means two snapshots; a part that needs different content per organization is two parts); parts are local rows out of listings, search, suggestions and retention; they inherit `supersededBy`; the source never routes; `restore` lifts a direct destination's tombstone; receipts are forgotten on delete. B4: a subagent's evidence counts at its spawn entry in the parent, a subagent reaches only the parent's part at the spawn, and waits for the parent's plan. B5: exec cells' nested `exec_command` `workdir` and `apply_patch`. B6: evidence at `store.capture`, every writer; Foundry `{tool}` entries. S1: run directories name their process; dead runs and their primed transcripts are swept; close removes its own. S2: echoes of a redacted span are replaced across the part; the go-live read of 30 UE-bound parts is still to do. S3: sensitive personal parts, prunes and redactions are sticky; a person's `route:<org>` tag is ownership only (redaction still runs on new entries); `route reset` drops stickies. S4: plans are their own record; the planner runs on the host. S5: `gh --repo X` and `--repo=X`, `git --work-tree`, multi-file `sed -i`, `gh api` mutations, temp worktrees through registered roots. S6: the planner ignores `CLAUDE_CONFIG_DIR` and uses the default login; `organizations[].roster`. B3 (lens) deferred; B7 operational.

**Seams.** Kingdom: delete-on-replan calls `sessions.delete` with `{ documentId }`, per the signet contract in progress (`signet/.worktrees/archive-operation-contract/src/archive.ts`); pairing asks for it. Kingdom's `sessions.write` has no `restore`, so a part deleted through Kingdom and later routed there again stays deleted at the hosted Archive until its content changes. Destinations running an Archive older than this branch refuse lineage kind `part`.

**Dry run (scratch copy, 2026-11-01).** The table's transcripts on disk were imported into a scratch database (live ids reproduced), with today's holdings simulated from the old rule's routing preview; Sonnet 5.5 low, 13 sessions, nothing stored. The chatgpt rows (d395f6886b, cf32dc9761) and the Foundry thread (074e44d0) have no transcript on disk and were not run.

| Archive id | Expected | Plan | Match |
|---|---|---|---|
| ae88b51ff2 | personal | personal | yes |
| 65fa49fe13 | personal; delete from UE | 1st run: proposed inixiative, held by validation (no evidence); rerun: personal, sensitive; UE copy deleted | yes on rerun (planner is nondeterministic; the validator caught the bad run) |
| 512aaec0a6 | split: opener personal, template → inixiative | 1st run held (whitespace bug, fixed); rerun: one part → inixiative with the opener's advisor/career spans redacted (4 redactions) | partial: redacted, not split |
| 671481a4f6, 95a4acd0e0 | UE | UE | yes |
| 382e18e4cb | UE (overrule stray writes) | UE; inixiative copy deleted | yes |
| 388f6c08c7 | UE | UE; inixiative copy deleted | yes |
| 1d3942e03f | UE | UE + inixiative | partial |
| 6b93e47069 | inixiative | inixiative; UE copy deleted | yes |
| 01b0bda06a | UE with Vlad redacted; json-rules part → inixiative | no roster: one part → both, unredacted; with roster `Vlad, Grant`: one part → both, Vlad line redacted | partial: redacted only with a roster, not split |
| 40b206fa84 | inixiative | UE + inixiative | no |

A dry run plans the first window of a long session only (nothing is stored to continue from), and judges a subagent against its parent's whole dry-run reach, not the part at its spawn. The pass bar (every row, plus 30 UE-bound parts read whole) is not met: splitting and over-inclusion are charter work, to be tuned and measured before go-live. Tuned 2026-11-01 in [ROUTING-TUNING.md](ROUTING-TUNING.md): no charter variant cleared the gates; the remaining failures trace to plan parsing, whole-plan holds on one bad redaction, and exact-span echo redaction.

## Code review fixes (2026-11-01, `docs/ROUTING.code-review.md`)

| Finding | Fix |
|---|---|
| L1 continuation sweeps gaps | a continuing part must start at the first new entry, or the plan holds |
| L2 personal beside an organization | personal, or sensitive, with an organization is kept personal and keeps `sensitive` |
| L3 unseen text | no per-entry clip; an entry longer than a window is shown cut and a work part holding it holds unless pruned |
| L4 overlapping redactions | `redactText`: spans found on the original text, merged, replaced once |
| L5 evidence gate meaning | **not changed; for Aron.** `routing.publish: off` (default) means plans are made and validated and only leaked whole copies are deleted |
| L6 leaked whole copies | every receipt on a whole-session row is deleted, whatever the plan state; a removed destination's go once it is configured again |
| L7 orphaned parts | `partOf` no longer cascades; deleting or pruning a session retires its parts so their copies are deleted first; a deleted part leaves a tombstone and a sticky prune |
| S1 digest, atomicity | record only at the digest read; plan and parts in one transaction under the session's capture lock (`writeRevision` shared with capture) |
| S2 subagent reach | spawn not found holds; plan changes mark parent and subagents due (`RoutingPlan.due`), re-applied without a model call |
| S3 quoted text | `quotedOrigins` in `import.ts` beside the injected-tag classifier, every source; unknown or unplanned origin excluded |
| S4 prior parts | every part re-validated on each plan or re-apply; `contextKey` makes plans due on an organization or project-map change |
| S5 restore, kind part | `restore` honored only for parts; received parts are never planned |
| S6 part metadata | only its organizations' project tags and run tags; no concept tags, goals, runs or session omissions |
| Parallel machinery | `projectTags` reduces `sessionEvidence` over one `projectPaths`; one `repositorySlug`; one `pool`; agent-session's sweep is private to a live host, so the folder naming stays mirrored for dead runs |
| Scheduler | one window a pass (`partial`), timeout 300 s from a measured window, due rows only, worktrees outside `projectMapKey` |

Not done: S7 (asserting which account the default login is) and S8 (destination upgrades, Kingdom `sessions.delete`), which are operational.

## Re-review fixes (2026-11-01)

| Finding | Fix |
|---|---|
| R1 | the clip check runs on a continuing part |
| R2 | a deleted or pruned session's tombstone keeps the destinations that held it (`pending`) until each confirms; a refusal (an old Kingdom pairing's 403) stays queued; a session that comes back gets them as receipts |
| R3 | sync reconciles each destination's own listing of this `sourceId` every ten minutes (direct Archives page `list`; Kingdom's `documents.read` has no source or paging, so only ids this Archive knows are taken) and deletes what `copiesToKeep` doesn't keep; another Archive's copies are never touched |
| cleanup | `routing.cleanup: off \| leaked \| all` (default `off`, overrides per organization in `cleanupFor`): off deletes nothing there and keeps pending deletes queued; leaked keeps, with publishing off, a whole copy its current valid plan sends there whole and unredacted; `sync --dry-run` lists per destination what would go |
| quote regression | an unclosed quoting tag is `unknown` to the end of the entry |
| guard | `publishArchive` refuses while `routing.publish` is off |
| `.pending-*` | the run sweep removes them |
