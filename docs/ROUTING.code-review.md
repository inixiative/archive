# Adversarial code review: PR #29 `feat/agentic-routing` (2026-11-01)

**Verdict: REVISE. Do not install the router (`agents router`) or run a non-dry backfill yet.** The shape matches v3: one parser with two modes, plans in their own table, parts as local rows, publishing gated on `partOf` and `routedTo`, failure holds, and the old "touched project" routing is cut over. But the validator can **widen** routing in two proven ways. Three more paths publish text nobody planned or redacted. And the cleanup of the leaked whole-session copies on UE skips every session that never gets a valid plan.

Ground truth: the worktree at `cbd362b`, `git diff origin/main...HEAD`. `bun run typecheck` passes. `bun run lint` reports 0 errors and 187 warnings. `bun test` ran against a throwaway Postgres (`pgvector:pg17` on port 6199), not the live instance on 6132, which the test preload would otherwise use. The first run had 1 fail and 1 error, a Prisma "Response from the Engine was empty" inside `compaction.test.ts`. The second run passed 145 of 145. The probes are in the session scratchpad (`probe/continues.ts`, `probe/cwd.ts`) and call `validatePlan` and `partSnapshot` directly. No live server, `~/.local/share/archive` or hosted Archive was touched, and no secrets were printed.

---

## Blocking: leak paths

### L1. `continues` sweeps unplanned entries into the prior part's organization (validator widens; proven)
`route.ts:309-322`: when the first proposed part sets `continues`, the prior last part is extended to `stored.lastEntryId`. Nothing checks that `part.from === context.from`. The evidence check (`:292-300`) covers only `[part.from, part.to]`. Entries between the prior plan's end and `part.from`, which the planner put in **no** part, end up inside the continued range. `publishedParts` then publishes the whole contiguous slice (`:402-410`).
**Probe:** prior part E0–E2 goes to userevidence. The new window is E3–E7, and E4 = "I am interviewing at another company; Vlad is useless". The proposal is `[{from:6,to:7,organizations:['userevidence'],continues:true}]`. Result: `valid`, and the published entry ids are `e0…e7`, so E4 reaches UE with no evidence check and no part naming it.
Fix: when `continues` is set, require `part.from === context.from`; otherwise hold. More generally, require the parts to tile the window exactly, or treat any uncovered entry as an explicit personal part.

### L2. A part that names `personal` and an organization publishes to the organization (proven)
`route.ts:298-305`: `personal` is just one more member of the closed set. `sensitive` is silently dropped unless every organization is personal. **Probe:** `{organizations:['personal','userevidence'], sensitive:true}` returns `valid` and publishes to UE. The charter says "use personal … whenever you are unsure". A plan that says personal and UE at once is the model's own uncertainty marker, and code turns it into a publish. Fix: hold, or narrow to personal, any part that mixes `personal` with an organization or sets `sensitive` together with one.

### L3. Text past 8,000 characters of an entry publishes unseen
`store.ts:139, 1714-1735`: each window entry is shown clipped to `ROUTE_ENTRY_CHARS = 8_000` with "… [N more characters]". `partSnapshot` publishes the full `entry.text` (`parts.ts:57-59`). The planner can't redact or prune what it never saw, and validation doesn't know an entry was clipped. Long pastes (Slack threads, PR bodies, a vent) are exactly the large user entries. **Scenario:** a 20k-character pasted Slack export in a Zealot session; the complaint about a coworker is at character 12,000; it is published to UE. Fix: never publish a clipped entry unless the plan prunes it. Either chunk the entry so the planner sees all of it, or hold the part.

### L4. Overlapping redactions leak the remainder (proven)
`parts.ts:51-55` applies redactions in sequence with `replaceAll`. The validator checks each redaction against the **original** text (`route.ts:325-335`). Once one redaction replaces its span, an overlapping one no longer matches. **Probe:** "interviewing at another company" (career) plus "company; Vlad is useless" (coworker) produces `I am [redacted: career]; Vlad is useless`. Fix: compute the spans on the original text, merge overlapping intervals, then replace once.

### L5. The evidence gate doesn't bound the case this PR exists for (proven)
Per v3, `evidencedOrganizations` (`evidence.ts:191-209`) admits an organization for a part when that part has any write, read or **reference**, or when the session's **start project** is in that organization. A reference is any GitHub link in any entry, including user text (`evidence.ts:106-109`). The start project adds that organization to every part of the session. **Probes:**
- a career and "my manager Grant is awful" part with only `startProjectId: zealot` → `valid` for userevidence;
- the same with a single `userevidence/zealot` link → `valid`;
- the same with a single read → `valid`.

So the 65fa49fe13 class (career advice in a session that read Zealot docs) and the B4 scenario (a personal thread started in `~/code/zealot`) are bounded only by the model's judgment. The dry run's held case was held only because the model named inixiative, which had no evidence. Had it named UE, the validator would have passed it. Prompt-injected text that names UE in a UE-touching session passes the same way. The B1 injection test (`route.test.ts:297-322`) covers only the no-evidence organization.

Nothing then gates publishing. Confidence and redactions only order the review queue (`store.ts:1945-1981`), and a valid plan applies at once (`:1927`). The pass bar in ROUTING.md isn't met (30 UE parts unread, splitting and over-inclusion untuned), so this is the real exposure. Fix options for Aron, since this changes the meaning of the gate:
- (a) a non-personal destination needs **writes** in that part, or a person's `route:`; reads, references and start cwd only order the queue;
- (b) any part going to an organization other than the session's start organization, or any plan with a redaction or a `sensitive` part, is held until reviewed;
- (c) at minimum, a go-live switch so plans are recorded but nothing publishes until the pass bar is met.

### L6. Leaked whole-session copies on UE are deleted only after a valid plan, and several kinds never get one
`client.ts:276-279` skips any held receipt where `!row.partOf && !row.routingPlan?.plan`. The test asserts this on purpose (`hosting.test.ts:434`, "neither sent nor deleted"). The whole copies already on UE then stay forever for:
- **held sessions.** A non-dry backfill only takes `unplanned` sessions (`store.ts:2045`), so a held row (it has a `RoutingPlan` with `plan: null`) is never retried by the backfill. The scheduler retries a held plan only when the digest changes or its parent was planned (`:2053-2059`). Old sessions don't change. The 65fa49fe13 first run is exactly this: held, so its UE copy stays.
- **superseded raw captures.** `routingDue` excludes `supersededBy` rows (`:2008`), so a raw copy published under the old rule and later fulfilled by Foundry is never planned and never deleted.
- **exempt run sessions.** These are never planned (`:2033`); the old sync did publish them (`exempt: 'include'`).
- **removed destinations.** `client.ts` ("A removed route keeps its receipts") skips them. If the UE destination is paused, as the design review's B7 suggests, the cleanup can never run against it.

Since a whole session never routes again (`config.ts` `sessionOrganizations`), any receipt on a non-part row is a leak by definition. Delete it regardless of plan status. That needs no plan, so do it before the backfill.

### L7. Deleting a source locally orphans its published parts; deleting a part locally is undone
- The migration's `archives_partOf_fkey … ON DELETE CASCADE` and `Receipt … onDelete: Cascade` mean that `store.delete(source)`, and the retention `prune` (`store.ts:849-860`, which skips parts but cascades through the source), delete the parts and their receipts. `deliveries()` then has nothing to act on, and the parts stay at UE.
  **Scenario:** Aron deletes a sensitive session locally and its UE part survives. Or retention prunes a 90-day-old session and its parts at UE become untracked.
- `store.delete(partId)` is allowed. It tombstones the part locally, and its receipt cascades away. The next plan of the source runs `applyParts`, which calls `capture(..., { restore: true })` (`:775`) and lifts the tombstone. Sync then republishes with `previousDigest: null`.

Fix: retire parts through `routedTo: []` before a source is deleted or pruned, and keep the source row, or a tombstone carrying its parts' receipts, until the destinations confirm. Refuse `delete` on a part, or route it to retire.

---

## Should fix

### S1. `recordPlan` ignores the digest the planner read; plans are not atomic
- `RecordPlanBody.digest` is sent, but `recordPlan` never compares it (`store.ts:1823-1846`; only `body.through` bounds are checked). The proposal's indices are resolved against the stripped entries **at record time**. The strip isn't append-only: `CALL_SHAPES` `codex question` drops a kept event once its answer arrives (`tool-activity.ts:155-170`), which shifts every later index by one.
  **Scenario:** a Codex session is captured during the Sonnet call. Part boundaries move by one entry, and the first entry of a `sensitive` part falls into the preceding UE part. Validation recomputes evidence on the shifted ranges and passes when there are no redactions to mismatch.
  Fix: send entry ids with the window and resolve proposals by id, or reject when the digest differs.
- `recordPlan` upserts the valid plan (`:1922`) before `applyParts` (`:1927`), which runs several captures and updates with no transaction. If a capture throws partway (an `ArchiveConflict`, or a dropped run tag carried in `source.tags`), the plan says valid, some parts keep their old `routedTo`, and the session is no longer due. Nothing locks two planners on one session (`route --watch` plus a manual `route` or `--backfill`), and their `applyParts` calls interleave.

### S2. A subagent's reach falls back to the parent's whole plan; parent changes don't reach children
- `store.ts:1631-1633` calls `planReach(plan, entries, spawn)` with `spawn` undefined whenever `bySpawn` fails. `planReach` then returns every organization the parent reaches (`route.ts:441-451`). Codex lineage never carries `toolUseId` or `parentEntryId` (`import.ts:173-179`). Claude subagents without `agent-*.meta.json` don't either (`import-file.ts:64-91`). So "a subagent reaches only the parent's part at the spawn" (ROUTING.md, B4) holds only for Claude subagents with meta.
  **Scenario:** a Codex thread's first part is UE work and its later part is a personal career thread. A subagent spawned in the career part reads Zealot and is allowed UE. Fix: no spawn found means no reach (personal), not the whole reach.
- A parent's later `route:personal` or `route reset` retires the parent's parts only. Children are re-planned only on their own changes (`store.ts:2050-2061`), so their UE parts stay. Sessions that quote the parent keep entries admitted under its old reach. Make a parent's plan change mark its children and quoters due.

### S3. Foreign-content detection is narrow, and a second recogniser
`quotedSessions` (`route.ts:459-468`) runs only for `source === 'claude-code'` (`store.ts:1650`). It knows three tags. A `<task-notification>` whose agent isn't archived (still uncaptured, or dropped as a run) is classed `'own'` (`:1659-1667`), so the subagent's result text publishes with the parent. Codex and Foundry threads never mark foreign content. `import.ts:34-58` already classifies harness-injected tags (`injectedTags`, `onlyTagBlocks`); build on it rather than adding a parallel regex list. Unknown should mean excluded, not own.

### S4. Prior parts are never re-validated
`validatePlan` carries `priorParts` verbatim (`route.ts:342`). Moving a project between organizations (`organizations set`), removing a repository from the map, or adding a roster changes nothing that is already published. `sessionOrganizations` only intersects `routedTo` with organization ids (`config.ts`). Re-validate prior parts on a `routeKey`, `projectMapKey` or routing change, or at least narrow them.

### S5. `restore` and lineage kind `part` are open to every writer
`server.ts:41-42, 183-188` accept `restore` on any ingest, and `store.ts:306` skips the tombstone for any session. So any writer, or an old client, can resurrect a session that a destination's operator deleted. Accept `restore` only when `snapshot.lineage.kind === 'part'`. Separately, any writer may send `lineage.kind: 'part'` (`index.ts` enum). Planning such a row skips the parent wait (`store.ts:2036`) and the parent reach (`:1628`), for example an exported part imported back. Only `applyParts` should be able to create that kind; reject it at ingest otherwise.

### S6. Parts carry whole-session metadata to the destination
`parts.ts:89-103` keeps every non-`project:` tag (Atlas concept tags of every repo the session touched, collector `config.tags`), `goalIds`, `runIds`, `actor`, `runtime` and the source's `coverage.omissions`. **Scenario:** a UE part of a mixed session carries `atlas:` concepts from Kingdom or Oracle internals. Scope these to the part's projects, or drop them.

### S7. The login pin is an assumption
`claudeRouteModel` forces the default `~/.claude` (`suggest-claude.ts:200-208`). `claudeSubscription` checks only `authMethod === 'claude.ai'`. Nothing checks *which* login `~/.claude` holds; I didn't check it myself. Assert the expected account (`auth status` org or email against a configured personal identity), or every session's text goes to whatever organization owns the default login.

### S8. Destinations and Kingdom
- An older destination refuses parts. `lineage.kind: 'part'` fails its enum, and the `restore` key fails its `strictObject` ingest schema. That is a 400, so a per-archive backoff and retries; nothing leaks, and `delete` still works there. Upgrade UE's Render Archive before go-live, or every UE part fails.
- Kingdom has no `sessions.delete` yet, so deletes on inixiative's hosted library retry forever. The test's fake Kingdom accepts it (`hosting.test.ts:361-369`). What Kingdom's own snapshot validation does with kind `part` is unverified.

---

## Parallel machinery

1. **`sessionEvidence` re-implements `projectTags`' loop.** It has its own root flattening, container set and `resolvePath` walk (`evidence.ts:74-84` against `tags.ts` `projectTags`). ROUTING.md says the evidence counts "come from the loop `projectTags` already runs". It doesn't, and the two have already diverged: `projectTags` drops a `/` root and counts the cwd itself. Make `projectTags` a reduction of `sessionEvidence`, or the other way round, so "which project is this path" has one definition.
2. **`sweepDecisionRuns` and `transcriptsOf` duplicate agent-session.** `ClaudePrimedSessions._projectDirectory` and `_sweepTranscripts` (`node_modules/@inixiative/agent-session/src/claude-primed.ts:310-357`) use the same folder encoding, re-typed in `suggest-claude.ts:59-70`. Extend agent-session with a stale-run sweep and remove-on-close instead.
3. **A second injected-content recogniser:** `quotedSessions` beside `import.ts` `injectedTags` (S3).
4. **Three repository-slug parsers** (`evidence.ts` `slugOf`, `tags.ts` `repositorySlug`, `provenanceReferences`), and two worker pools in `route.ts` (`runRouting` and `runBackfill`'s `pool`).
5. **`routedTo` denormalizes `RoutingPlan.plan`** and can drift from it (S1, the non-atomic apply).

These reuse what exists, correctly: `shellAccess` / `toolCallAccess` (one parser, two modes); `RoutingPlan` as its own record (not `Suggestion`); `deleteRemote` over the existing `delete` endpoint; publishing through `publishArchive` and its digest-ack; overrides as tag edits. The diff adds no `any`. `projectMap(db = this.db)` follows Archive's existing `settings(db)` pattern, which conflicts with the "never pass the database" rule. That's a repo-wide question, not this PR's.

---

## Scheduler and runner

- **Cost bounds.** A non-dry pass plans a long session window after window, up to 51 windows of 300k characters each, in one pass (`route.ts:604-616`). There is no per-session or per-pass token budget. Only a dry run stops after the first window. The 120 s timeout (`suggest-claude.ts:154`) against a window of about 75k tokens is unmeasured. If it times out, the session is held and retried hourly while it is live, spending a full window each time with no progress.
- **Load.** Every 2 minutes, `routingDue` loads every archive row with its summary, tag edits and plan JSON (`store.ts:2007-2028`). `routingContext` runs an unindexed JSON-path query for children and re-reads and re-strips every quoted session. Every 30-second sync, `deliveries()` loads every receipt with its plan JSON.
- **Re-capture churn.** `route --watch` and `collect` re-send the project map on every pass (`cli.ts`). Any new worktree changes `projectMapKey`, and the collector then re-captures every session to recompute evidence (`collector.ts:563-564`).
- **Crashed runs and stray transcripts.** Mostly handled: `.owner` plus a sweep at start, and close removes its own run. Two caveats:
  - The `.owner` file is written after `mkdir` (`suggest-claude.ts:142-143`), so a concurrent sweep can remove a live run's directory.
  - The router sweeps `suggest-*` directories too, but looks for their transcripts under its own config directory. A tagger that ran under another `CLAUDE_CONFIG_DIR` leaves its primed transcripts orphaned. They hold the charter only.
- **Review churn.** `changed` compares the whole plan, `throughEntryId` included (`store.ts:1910`). Every delta bumps the version and clears `reviewedAt`, so a reviewed plan with redactions re-enters the queue on every delta.

---

## Data model and migrations
- The `partOf` cascade with receipt cascade is L7.
- `routedTo` duplicates the plan (P5).
- `RoutingPlan.entries = -1` as "partial" is a sentinel. It works only because `summary.entries > -1`.
- The evidence columns stay local and never reach a snapshot or the API (`listing` builds its own shape). Good.
- The migrations are additive. On upgrade, every whole-session publish stops at once (intended), and the existing receipts stay until L6 is fixed.
- Tombstone `restore` is tested both ways (`parts.test.ts:124`), but it is open to every writer (S5).

## Tests: what they prove and what they don't
They prove the happy paths and the narrowings in the spec: unknown organizations, no-evidence organizations, byte-exact redactions, the parent-reach filter at a found spawn, sticky sensitive parts, superseded parts, delete and restore on re-plan, and the Kingdom delete call against a fake. The model is scripted throughout, so the charter itself is never tested; the dry run in ROUTING.md is the only evidence on that. Missing, each one a finding above:
- L1: a gap plus `continues`.
- L2: `personal` mixed with an organization.
- L3: a clipped entry.
- L4: overlapping redactions.
- L5: injection, or a model mistake, on an organization that *has* weak evidence (start cwd, one read, one link).
- L6: held, superseded and exempt whole copies, and a removed destination.
- L7: a source deleted or pruned with published parts; a part deleted locally.
- S1: a capture landing between input and record that shifts entries; two concurrent planners; `applyParts` failing partway.
- S2: a Codex subagent, or a spawn not found; a parent re-routed personal after its child published.
- S3: a task notification for an uncaptured agent; Codex foreign content.

Separately, the flake in `compaction.test.ts` ("Response from the Engine was empty") should be looked at.

## Ranked verdict
1. **L1** `continues` gap widening. Proven; a real widening by the validator.
2. **L5** weak evidence (start cwd, one read, one link) admits UE for personal parts, and no publish gate exists. Proven; this is the leak class the PR exists for.
3. **L6** leaked whole copies are kept for held, superseded, exempt and removed-route sessions.
4. **L3** text past 8,000 characters publishes unseen.
5. **L4** overlapping redactions leak. Proven.
6. **L2** `personal` with an organization publishes. Proven.
7. **L7** a local delete or retention prune orphans remote parts; a local part delete is undone.
8. **S2** subagent reach falls back to the parent's whole plan (all Codex subagents); a parent's re-route doesn't reach its children.
9. **S1** the digest is ignored, so indices shift on re-capture; plan and apply are not atomic; no planner lock.
10. **S3, S5, S4, S6, S7, S8**, then the parallel machinery (P1, P2 first), then the scheduler, cost and test gaps.

What holds:
- Whole sessions no longer publish.
- Failure holds the session.
- The planner's organization names come from a closed set.
- Unknown foreign reach excludes the entry.
- New entries publish nowhere until they are planned.
- Superseded parts are deleted.
- The router is opt-in.
- Plans are their own record, and evidence never travels.

---

## Re-review (2026-11-01, commits `6cdedd9..dd713e6`)

**Verdict: ship with publish off, after two small fixes (R1, R2) and one pre-flight count (R3).** This assumes Aron accepts that genuine UE work published whole before is deleted from UE, and that some of it won't come back on its own (R4). With publish off, no change in this range can publish anything new; I checked every remote write path. Every leak I reported either now fails closed or is unreachable while publish is off. Two new gaps are left. One could publish once publish is on (R1). The other can leave a leaked copy at UE, which defeats the point of shipping now (R2).

Ground truth: `dd713e6`. `bun run typecheck` passes. `bun run lint` reports 0 errors and 200 warnings. `bun test` passed 159 of 159 against a throwaway `pgvector:pg17` on random port 38401, not 6132. Probes are in `probe/rereview.test.ts` in the session scratchpad: nine tests that call `validatePlan`, `redactText`, `ArchiveStore`, `syncArchives`, an in-process destination Archive and the test Kingdom fake. Nothing live was touched, and no secrets were printed.

### (1) The original leaks
| Finding | Probe | Result |
|---|---|---|
| L1 gap plus `continues` | proposal `[{from:6,to:7,continues:true}]` after a plan through E2 | **held**: "continues the last part but does not start at E3" |
| L2 personal beside an organization | `['personal','userevidence']`, sensitive | **valid, kept personal**; only the prior E0–E2 part publishes |
| L4 overlapping redactions | "interviewing at another company" plus "company; Vlad is useless" | `I am [redacted: career, coworker]`: fixed |
| L3 unseen text | a clipped entry in a new UE part, not pruned | **held**. **But see R1**: a *continuing* part bypasses the check |
| L6 leaked whole copies | builder's test (unplanned, held, superseded, exempt) plus my Kingdom probe | all deleted with publish off; nothing ingested |
| L7 orphaned parts | builder's test (a source deleted, a source pruned, a part deleted) | parts' copies deleted, and a deleted part isn't re-cut. **But see R2**: the source's *own* whole copy is orphaned |
| S1 digest | capture, `routingInput`, capture with more entries, `recordPlan` with the old digest | **stale**; plan and parts now write in one transaction under the session lock (`underSessionLock`) |

The other fixes read correctly:
- **S2:** a subagent whose spawn isn't found now holds; plan changes mark the parent and subagents due.
- **S3:** `quotedOrigins` sits beside `injectedTags` and runs for every source; an unknown origin is excluded.
- **S4:** every prior part is narrowed again under today's evidence.
- **S5:** `restore` is honored only for kind `part`, and received parts are never planned.
- **S6:** part metadata is scoped to the part.

### (2) `routing.publish off`
**Nothing new publishes. Confirmed.**
- The only remote writes are `publishArchive` (an ingest or `sessions.write`) and `deleteRemote`.
- `publishArchive` has one caller, `syncArchives`. That covers both the `serve --sync` loop (`cli.ts:245`) and `/api/v1/archive/sync` (`server.ts:393`).
- With publish off, `syncArchives` builds no publish list (`client.ts:220-222`). That is independent of destination kind.
- The Kingdom probe executed only `sessions.delete`, while a leaked whole copy and a planned part were both present.
- `readRouting` defaults a missing key to `off`, and every config writer spreads the existing routing. So an upgrade, or a writer that drops the key, lands on off, never on.
- Defense in depth: `publishArchive` itself doesn't check `publish`. Add the guard there too, so a future caller can't bypass it.

**What it deletes.** Every receipt on a non-part row, at every configured destination (`client.ts:283`), plus parts no longer routed. That includes **inixiative's Kingdom library**, not only UE: every whole session there is deleted until parts publish. Nothing else is deleted: routed parts are skipped, and the destination ids are this Archive's own `archiveKey`s. Kingdom refuses with 403 any document written by another Archive.

**R1, a new leak (once publish is on).** A clipped entry inside a continuing part publishes. The clip check loops over `parts` only (`route.ts:355`), and a continuation is never pushed into `parts`; it becomes `continued`.
**Probe:** a prior UE part through E2, then `{from:3,to:7,continues:true}` with E4 clipped. Result: **valid**, and the published entries are `e0…e7`. It takes an entry over 300k characters as the first new entry, so it's rare, but it's exactly L3 again. Run the clip check over `continued` too. With publish off this is unreachable.

**R2, a whole copy is orphaned when its session is deleted or pruned locally.**
- `Receipt` still cascades with its archive. For a whole session with no parts, `store.delete` (`store.ts:927`) and the retention `prune` remove its receipt, and the copy at UE is never deleted.
- **Probe:** a leaked whole copy at a destination, its receipt held here; the session is deleted locally. Sync returns `[]`, and the remote still holds 1.
- Normally sync deletes within 30 s. But it stays open whenever that delete is failing or backing off: an outage, or a Kingdom pair made before `sessions.delete` that gets 403s until it's re-paired.
- Fix: retire the source's own receipts the same way parts are retired (keep the row, or keep a tombstone holding the pending deletes), or refuse `delete` and `prune` while receipts remain.

**R3, receipts are the only inventory.** The deletion pass finds leaks only through this store's receipts. A copy at UE with no receipt here can't be found. That happens for sessions deleted locally before this branch, when receipts cascaded away; for copies sent from another machine; and for a destination whose identity changed (`destinationIdentity`: the URL origin and path, or the Kingdom ids). The "158 on UE" figure came from a routing preview, not from receipts. Before relying on publish off to clean UE, compare this store's receipt count for the UE destination with UE's own listing of documents carrying this Archive's `sourceId`. Delete the difference by id, or add a reconcile pass that lists the destination. I didn't run that count; it reads the live database.

**R4, genuine UE work: is deleting it acceptable?** It is deleted at once, whatever its plan. It comes back only as **parts**, only after `publish on`, and only for sessions with a valid plan. New part ids mean UE's tombstones on the whole-session ids don't block them; the builder's L6 test shows a planned part publishing once publish is on.
Rows captured before a project map existed have `evidence: null`. When their transcript is gone from disk (Claude's 30-day cleanup), the collector can't recompute it. Their UE plans hold with "no evidence for userevidence" (probe), so **that UE work never returns on its own**. The way back is a person's `route:userevidence` tag, which counts as evidence.
Aron should accept this gap explicitly: older genuine UE sessions disappear from UE's Archive, along with anything there that reads them. The alternative is a backfill with publish on for UE-only plans, after review.

### (3) Parallel machinery and regressions in the fixes
- **Resolved:** `projectTags` is now a reduction of `sessionEvidence` over one `projectPaths`, with `containers` exposed. There's one `repositorySlug` and one `pool`, exported from `suggest.ts`. Capture and `applyParts` share `writeRevision` instead of duplicating it. `transcriptsOf` still mirrors agent-session's folder naming, with a stated reason (agent-session's sweep is private and needs a live host). That's acceptable; the cleaner fix is an exported helper in agent-session.
- **A regression in quote detection.** `quotedBlock` (`import.ts:72`) now needs the closing tag. The old checks matched the opening tag alone. An unclosed `<cross-session-message …>` (cut by the harness, or a block that runs to the end of the entry) is now treated as the session's own text. Match an opening tag with no close as `unknown`.
- **Minor:**
  - A crash between `mkdirSync` and `renameSync` leaves `.pending-*` directories that the sweep never matches. They hold only `.owner`.
  - Every Codex subagent now holds: fail-closed, but none of it reaches an organization until lineage carries the spawn.
  - `routingContextKey` includes the roster, so any roster edit marks every plan due. It's a re-apply without a model call when nothing is new, but each due session with new entries costs a planner call.
  - Tests: the builder added L6 and L7 tests (`hosting.test.ts`) and validator tests. Still missing: R1, R2, the unclosed-quote case, and a test that `publishArchive` refuses when publish is off.

### Ranked
1. **R2:** a local delete or prune orphans a whole copy at UE. Fix before shipping, because it's the leak the switch exists to remove.
2. **R3:** reconcile receipts against UE's own listing before trusting the cleanup. Operational, read-only.
3. **R4:** Aron accepts that UE loses older genuine work, or a reviewed UE re-publish follows.
4. **R1:** clip check on continuations. Must be fixed before `publish on`.
5. The quote-detection regression; the `publishArchive` guard; `.pending-*` directories.

---

## Final gate (2026-11-01, commits `e001cf9`, `26d5b8d`, `3132d4d`)

**Verdict: MERGE.** Nothing blocks shipping with `publish off` and `cleanup off`. Before setting `cleanup userevidence leaked`, fix G1 or accept it on the record, and do G2.

Ground truth: `3132d4d`. `bun run typecheck` passes. `bun run lint` reports 0 errors and 207 warnings. `bun test` passed 165 of 165 against a throwaway `pgvector:pg17` on random port 39151, never 6132. Probes are in `probe/gate.test.ts` (six tests) and the migration rehearsal in `mig/`, both in the session scratchpad. The probes run real `syncArchives` against in-process destination Archives, a counting proxy and the Kingdom fake. Nothing live was touched, and no secrets were printed.

### (1) Publish off and cleanup off: nothing is sent and nothing is deleted
- **Probe:** the local store held a leaked whole copy (with receipts at a direct UE Archive and at a Kingdom library), a planned part routed to both, a session deleted here that held a copy, and a retention prune. `syncArchives` and `sync --dry-run` both returned `[]`. The counting proxy in front of UE saw **0 requests**. Kingdom executed **no** operation: no write, no delete and no `documents.read` listing. `publishArchive` called directly threw "Publishing is off" (`client.ts:133`).
- **Why it holds:** with publish off, the publish list is empty. With cleanup off, the cleanup loop skips the destination before any listing or delete (`client.ts:332`). A missing `publish`, `cleanup` or `cleanupFor` key defaults to off, so the first sync after the upgrade, before any command has written the keys, is off and off.
- **Retention and `delete`** only push the destinations onto the tombstone's `pending`, with no network call. Those deletes stay queued.
- **`repair` and `collect`** write only to the local Archive. **`agents install`** adds the router only when it is declared. **Re-pairing** (`pair`) talks to Kingdom's pairing flow, not to a library. A config writer that drops the keys can only fall back to off.
- **Operational:** run `archive publish off` and `archive cleanup off` once after the upgrade, so `destinations.json` carries the keys explicitly. 0.24.0's `routingSchema` is strict and would refuse those keys. If the keys are missing and the machine is ever rolled back to 0.24.0, that version would go back to publishing every touched-project session whole.

### (2) `cleanupFor: { userevidence: 'leaked' }`
- **Probe:** UE held:
  - our whole copy with a receipt;
  - our whole copy with **no** receipt (found only through UE's listing);
  - a copy written by **another** sourceId.

  inixiative held our whole copy with a receipt. The dry run listed exactly the two copies of ours at UE. Sync deleted those two. **UE still holds the other Archive's copy, and inixiative still holds ours** (inixiative's cleanup is off).
- **R2:** a whole copy whose session was deleted here, and one whose session was pruned, were queued while cleanup was off (2 pending, nothing sent). Under `leaked` both were deleted at UE, and pending dropped to 0.
- **Candidates:** only this Archive's own ids. They come from receipts, tombstone `pending`, and the direct listing filtered on `sourceId`; through Kingdom, only ids this store knows. Those ids are `archiveKey`s that include this sourceId, so another Archive's copies can't be targets. Deletes are capped at 100 per destination per pass.
- **G1, should fix: a genuine UE copy a plan keeps is deleted as soon as its session grows.** `copiesToKeep` keeps a whole copy only while the plan's digest equals the row's current digest (`store.ts:900`).
  **Probe:** a UE review session with a valid whole-UE plan; sync keeps its copy. One more capture, then sync → **deleted**, before the scheduler re-plans it (up to about an hour, or after a 30-minute pause). With publish off, nothing re-sends it. Every UE session that is active when `leaked` is turned on, or later, loses its whole copy for good.
  Fix: keep the copy while the receipt's digest is a revision the plan covered (its entries run up to `throughEntryId`), or skip whole rows whose plan is due `new entries` until they are re-planned.
- **G2, do before `leaked`: decide what kept copies carry.** A kept whole copy is whatever was sent under the old rule:
  - the whole session's Atlas tags, references, goals and runs (S6 scoped these for parts, not for kept whole copies);
  - possibly tool calls and results, if `captureToolCallsAndResults` was on when it was sent.

  The plan validated the stripped entries only. Either confirm tool capture was off for every copy sent to UE, or narrow "kept" to copies whose receipt digest matches a stripped revision.
- **Footgun:** `archive cleanup leaked` without an organization sets the default for every organization, inixiative included. Use `archive cleanup userevidence leaked`, and check `archive sync --dry-run` before the first real sync.
- **R4 still applies.** Under `leaked`, deleted genuine UE work comes back only as parts with publish on. Rows without evidence need a person's `route:userevidence`.

### (3) Migrations on existing data
Rehearsal: I applied origin/main's seven migrations to a fresh database and seeded it with **1,500 archives**, **158 receipts** and **50 tombstones** in the old shape. Then I applied the branch's seven migrations (`20261101120000` through `20261101180000`, all after main's last, `20261018180000`).
- **Results:** all applied. Every archive got `routedTo = '{}'`, `partOf` NULL and `evidence` NULL. All 158 receipts are intact. Every tombstone got `pending = '{}'`. The `partOf` FK is gone after `150000` (it is added in `130000` and dropped in `150000`). `prisma migrate diff` against `schema.prisma` returned an empty migration, so there is no drift.
- **Locking:** every change is a nullable or defaulted column, one index or a new table. On about 1,200 rows the locks are milliseconds.
- **Deploy notes:**
  - the server applies migrations on start (`cli.ts` `migrate`), so the new image migrates the live database the first time it runs;
  - rolling back to 0.24.0 after that leaves extra columns, which 0.24.0 ignores, but see the downgrade note in (1);
  - evidence stays NULL until each row is re-captured, which is R4's gap for transcripts that are gone.

### (4) Earlier findings
- **R1:** fixed. A continuing UE part holding a clipped entry now **holds** (probe); the clip check runs on `continued` too (`route.ts:355`).
- **R2:** fixed. Probe above: pending deletes survive the local delete and the prune, and complete under cleanup.
- **Quote regression:** fixed. An unclosed `<cross-session-message …>` and an unclosed `<agent-message …>` both return `unknown`.
- Also confirmed:
  - the `publishArchive` guard;
  - the `.pending-*` sweep;
  - R3 reconciliation (the copy with no receipt was found through UE's listing).
- **Parallel machinery:** none new. Reconciliation uses the destination's existing `list` and Kingdom's `documents.read`; `copiesToKeep` reuses `sessionOrganizations`, `storedPlanSchema` and `plannedSession`; pending deletes live on the existing tombstone.

### Ranked before `cleanup userevidence leaked`
1. **G1:** fix the digest-staleness rule, or accept that active UE sessions lose their whole copy.
2. **G2:** confirm whether any copy at UE was sent with tool activity, and decide what kept whole copies may carry.
3. Pin `publish off` and `cleanup off` in `destinations.json` (rollback safety), use the per-organization form, and dry-run first.

---

## PR #33 gate (2026-11-01, `fix/cleanup-keep-guards`, `e100a50..3bcde77`)

**Verdict: BLOCK on B1. B2 is small and should go in the same PR.** G1/G2, the `--all-organizations` guard, Codex `archived_sessions`, the no-evidence hold, `formerRoots` and both migrations pass.

Ground truth: `3bcde77`. `bun run typecheck` passes. `bun run lint` reports 0 errors and 213 warnings. `bun test` passed 171 of 171 against a throwaway `pgvector:pg17` on random port 27729, never 6132. Probes are in `probe/pr33.test.ts` (five tests) and the migration rehearsal in `mig33/`, both in the session scratchpad. They call `ArchiveStore.capture` / `routingInput` / `recordPlan` and `syncArchives` against an in-process destination Archive. Nothing live was touched, and no secrets were printed.

### B1, blocking: a rebuild drops the replaced plan's sticky sensitive decisions on the next delta (proven)
`store.ts:2119-2136` merges the governing plan's prunes and redactions into the rebuilt plan. The governing plan's **sensitive personal parts** are honored only through the swap's `sticky` set. They are never stored in the new plan. The next delta builds `sticky` from the new plan alone, so those entries are no longer excluded.

**Probe:**
1. Plan A: E0–E1 ("I am interviewing elsewhere", "career advice") is sensitive personal; E2–E3 go to UE.
2. Plan B (new key) re-plans E0–E3 as one UE part. At the swap, the UE part correctly holds only E2–E3.
3. The session grows, and the B delta continues the part. The **UE part now holds the career entries**.

The plan also records `wholeTo: ['userevidence']` with a whole digest. So with publish on, career talk publishes to UE. With publish off and `cleanup userevidence leaked`, a UE copy of that revision would count as reviewed and be **kept**.

Fix: on the swap, carry the governing plan's sensitive entries into the stored plan, either as sticky prunes or as sensitive personal parts the rebuilt parts can't cover. Better, have `validatePlan` hold any rebuilt part that overlaps a governing sensitive range. Add a test for exactly this three-step sequence.

### B2, should fix in this PR: an evidence-only capture can delete the row (proven)
The run-drop check runs **before** the `evidenceOnly` branch (`store.ts:272` vs `:280`). A non-owning collector's snapshot carries that collector's own `config.tags`. If those tags include a run stamp and `captureRunSessions` is off, the evidence-only capture takes the drop path. That runs `deleteMany` on the stored row, with no tombstone and no `pending`, and its receipts cascade away.

**Probe:** a stored session with a receipt, then `capture({...s, tags:['run:oracle']}, {evidenceOnly:true})`. It returns `dropped: run:oracle`, the row is gone and the receipts are 0. Any destination copy is now orphaned, which is R2 again.

Before this PR a held session wasn't sent at all, so this is new. Fix: take the `evidenceOnly` branch before the drop check (it only needs `old` and `map`), or ignore the incoming tags in that mode.

Pre-existing, for the record: that drop path (`deleteMany` with no tombstone and no pending deletes) orphans copies whenever a session newly gains a run stamp. Route it through `delete()`.

### (1) The evidence-only capture otherwise changes only evidence (proven)
Another project's collector re-sent the same transcript with a different `projectId`, different tags and its own `cwd`. `digest`, `storedDigest`, `revision`, `projectId`, `summary` and receipts were all unchanged; only `evidence` changed (`startProjectId` undefined → `zealot`). A different transcript is a no-op. It writes no revision, no outbox row, no receipt and no tombstone, and it doesn't mark the plan due.
- Caveat: the incoming `cwd` sets `startProjectId`, which counts as evidence for every part (L5). The collector sends the transcript's own `cwd`, so that's fine. Any other token holder can set it at will, but that is trusted-writer territory.

### (2) Rebuild
- **Mid-rebuild it publishes and deletes nothing new.** A window short of the last is stored aside (`rebuild`, due `charter`, `parts: []`), and the governing plan's parts, `wholeTo` and `wholeDigests` stay as they were. A held window clears `rebuild`, and the governing plan stands. The swap happens only at the last entry.
- **Sticky prunes and redactions** carry over (merged). **Sensitive personal decisions** carry over only for the swap itself (B1).
- **A person's decision mid-rebuild is deferred.** A `route:personal` change during a multi-window rebuild is applied to a stored-aside window; the governing parts and `wholeTo` keep publishing, or keep a UE copy kept, until the rebuild reaches the last entry, one window per 2-minute pass. My two-window probe swapped at once (the decision landed). Three windows or more defers it by minutes. Low, but a person's `route:personal` should apply to the governing plan immediately.
- **No-evidence shortcut.** For a rebuild with no evidence, `input.prior` is undefined, so it is recorded held under the **new** key while the old plan governs. That is safe; it just means "held" can describe a session whose old-charter parts still route.

### (3) G1/G2 keep exactly the reviewed copies (proven)
`wholeTo` is set only when the plan covers the last entry, has no redactions, and publishes one part holding every entry. That rules out prunes, sticky exclusions and foreign exclusions. `wholeDigests` holds the stripped digests of those reviewed revisions, reset whenever `wholeTo` changes. `copiesToKeep` keeps a whole copy only when the digest the destination holds (its listing, else the receipt) is one of them.

**Probe** under `cleanupFor userevidence leaked` with publish off:
- a whole-reviewed copy is **kept**, and **still kept** after the session grows (G1 fixed);
- a copy sent with tool activity, which the plan reviewed only stripped, is **deleted** (G2);
- a copy whose plan has a redaction is **deleted**.

Owed receipts (digest `''`) and Kingdom copies without a listing digest fall back to the receipt digest and fail closed. Kept copies still carry whole-session tags and references; the plan reviewed those, since they are in the stripped snapshot. **Except B1**, nothing broader is kept.

### (4) Migrations on live-shaped data
Rehearsal: main's migrations at `e100a50`, then 1,500 archives, 1,172 valid `routing_plans` and 158 receipts, then the PR's `190000_routing_whole` and `200000_routing_rebuild`.
- **Results:** both applied. Every plan has `wholeTo = '{}'`, `wholeDigests = '{}'` and `rebuild` NULL, and its `plan` is intact. Receipts are intact. `prisma migrate diff` returned an empty migration. All changes are defaulted or nullable columns, so the locks are milliseconds.
- **Consequence, operational:** an existing plan keeps **no** whole copy until it is re-recorded. This PR changes the `projectMapKey` formula (`formerRoots` is added), so every `contextKey` changes. Every plan then becomes due `context` and is re-applied with no model call, which fills `wholeTo` from the current revision. Every row's `evidenceKey` goes stale too, so the collector re-sends every session once.
  - **Order:** upgrade → `archive collect` → one `route` pass → `sync --dry-run` → `cleanup userevidence leaked`. Setting `leaked` earlier deletes every genuine UE whole copy.
  - A UE copy of a revision older than the one re-applied (the session grew after the leak) is deleted. That is conservative.

### (5) Parallel machinery
None of substance:
- `historyFiles` wraps `transcriptFiles`.
- `formerRoots` rides the existing resolvable-roots path.
- `evidenceOnly` is a mode of `capture`, built on `sessionEvidence`.
- `rebuild` is a JSON slot on the existing `RoutingPlan`.
- `wholeDigests` reuses `snapshotDigest`.

Two small duplications. The `evidenceOnly` branch re-implements the `stripOf` / `evidenceOf` closures defined a few lines below it; moving the branch after them also fixes B2. `planSession`'s no-evidence test (`route.ts:540-559`) restates `validatePlan`'s `allowedFor` (evidence, start organization, overrides, subagents) on the client, which is a drift risk. Exposing one shared predicate would fix it.

### Ranked
1. **B1:** rebuild loses sticky sensitive decisions after the swap. A leak with publish on; a wrongful keep under `leaked`. Blocking.
2. **B2:** an evidence-only capture can delete the row through the run-drop path. Fix in this PR.
3. **Operational:** don't set `leaked` before a router pass has re-applied the plans, or genuine UE whole copies are deleted.
4. **Deferred decision:** a person's `route:personal` waits for a multi-window rebuild to finish. Low.

---

## PR #33 re-gate (2026-11-01, `4d15438`)

**Verdict: MERGE.** B1 and B2 are fixed, and nothing in the new code widens routing.

Ground truth: `4d15438`. `bun run typecheck` passes. `bun run lint` reports 0 errors and 216 warnings. `bun test` passed 174 of 174 against a throwaway Postgres on random port 24979, never 6132. I re-ran four probes from `probe/pr33.test.ts`: (1a), (1b), (2a) and (3).

- **B1, fixed (probe 2a).** Plan B re-plans E0–E3 as one UE part over A's sensitive E0–E1, and that proposal now **holds** ("covers entries kept personal as sensitive"). Plan A keeps governing. After the session grows, the next delta's UE part holds `fix zealot bug, fixed, more zealot, done`, with no career entries, and `wholeTo` is `[]`. `StoredPlan.sensitive` accumulates across plan generations, rebuilds included; `sensitiveEntries` reads it; and any work part over a sticky entry holds. The fix fails closed.
- **B2, fixed (probe 1b).** An evidence-only capture whose tags carry `run:oracle`, with `captureRunSessions` off, keeps the row (revision 1, 1 receipt). The `evidenceOnly` branch now runs before the drop check and reuses `evidenceOf` / `stripOf`. The drop path itself now goes through `deleteIn`, so a dropped session is tombstoned with its pending deletes queued. That also closes the pre-existing orphan path. Probe (1a) is unchanged: only evidence moves.
- **G1/G2 still hold (probe 3).** The reviewed copy is kept, and still kept after the session grows. The tool-activity copy and the redacted copy are deleted.
- **`allowedOrganizations` doesn't widen.** It computes the same set the old inline code did (range evidence plus start organization, subagents spawned in the range, a person's `route:` organizations, never personal). `validatePlan` calls it per range, exactly as before. `planSession` calls it over the whole session, which is broader, but only to skip the model call. A broader set can only send a session to the model instead of holding it, never publish more.
- **The mid-rebuild decision doesn't widen.** I didn't probe this one; this is from reading the code. A `route:` change during a rebuild re-applies the decision to the governing plan under the governing plan's key, and `rebuild` is kept so the rebuild resumes afterwards. Any new entries in that pass are validated the usual way against the governing plan. A held attempt clears `rebuild`, so the rebuild starts again; that is safe.

---

## PR #35 gate (2026-11-01, `fix/planner-robustness`, `7a6594f`, `308a928`)

**Verdict: BLOCK on P1.** P2 should be fixed in the same PR.

Ground truth: `308a928`. `bun run typecheck` passes. `bun run lint` reports 0 errors. `bun test` passed 179 of 179 against a throwaway Postgres on random port 32516, never 6132. The probe is `probe/pr35.ts` in the session scratchpad; it calls `validatePlan`, `publishedParts` and `redactText` directly.

- **P1, blocking: a part held for a bad redaction leaks through its neighbour (proven).** The bad redaction is dropped (`route.ts:347`), so the echo redaction in other parts has nothing to echo.
  **Probe:** part E0–E2 goes to UE, with the redaction misquoted in case (`vlad deleted my work again` against `Vlad deleted…`); part E3–E5 goes to UE. The plan is **valid**: E0–E2 is held personal, and E3–E5 publishes `sorry vlad deleted your work again, ported anyway` **unredacted**. With the redaction quoted correctly, the echo in E4 is caught (`[redacted: coworker]`). Before this PR the whole plan held, so this widens what publishes.
  Fix: keep a failed redaction's text as an echo-only redaction for every other part (its normalized and 4-word forms), or hold every part containing such an echo. A failed redaction "in no part" has the same gap.
- **P2, should fix: the roster clause over-redacts work text.** A redaction whose text contains a roster name as a plain word fires the clause rule, case-insensitively, for every clause containing that word (`parts.ts:101-115`).
  **Probe:** with the roster `Grant` and the career redaction "I applied for a grant at UE", the text `Issue the Signet grant to the Foundry. Revoke the grant on deletion.` becomes all markers. "grant" is core vocabulary in these repos. Fix: match the name case-sensitively, as written in the roster, and only for `coworker` redactions.
- **Echo redaction otherwise only removes text.** Spans come from the original text, are merged, and each is replaced by a marker, so nothing can widen and nothing can be silently inverted. Minor: a 4-word run of common phrasing ("I think we should") is cut wherever it appears (`[redacted: career] not merge the lock change`). A `.` inside a filename ends a clause early (`Vlad (see notes.md) deleted my work` leaves `.md) deleted my work`), but the exact span still applies wherever the redacted text appears byte for byte.
- **Held part via a continuation or a subagent: no leak.** Parts are disjoint. A held part can't continue (`!held`), and the next plan's continuation requires the same organizations as a personal last part. A subagent spawned in the held part gets an empty reach at its spawn (`planReach`) and stays personal.
  Two caveats. A held part is personal but not sticky, so a rebuild or `route reset` can route it with no redaction. And its review signal is the `held part` note, which the next delta's `notes` overwrite. Mark held parts sensitive (sticky) until reviewed.
- **(1) `organizations: []` means personal.** No widening: it maps to `[PERSONAL]` before the evidence and `unsure` checks.

---

## PR #35 re-gate (2026-11-01, `d42dc27`)

**Verdict: BLOCK. P1 still leaks in its own probe, now through the P2 fix.**

Ground truth: `d42dc27`. `bun run typecheck` passes. `bun run lint` reports 0 errors. `bun test` passed 182 of 182 against a throwaway Postgres on random port 34290, never 6132. I re-ran `probe/pr35.ts` with two more checks.

- **P1 is not fixed for the probed case.** Part E0–E2 is held, `heldForReview` is `[e0, e1, e2]`, and the bad redaction is kept as echo-only. But the neighbouring UE part still publishes `sorry vlad deleted your work again, ported anyway` **unredacted**, and so does the **correctly** redacted variant, which d42dc27's parent caught.
  - The echo was only ever caught by the roster clause, and that clause is now case-sensitive (`parts.ts:116`, flag `g`), so a lowercase `vlad` no longer matches.
  - The normalized match and the 4-word runs miss the echo, because the planner wrote "deleted my work" and the echo says "deleted your work".
  - Measured against main, the bad-redaction case still widens (main held the whole plan).
  - Fix: match the roster name case-insensitively again, now that the clause only fires for `coworker` redactions. Gating on the reason is what fixes P2's "grant", and a coworker-only clause redacting work sentences that mention the coworker is narrowing that's acceptable. Add the probe's two cases as tests.
- **P2 is fixed for the probed case.** A career redaction no longer redacts `Signet grant` sentences. A coworker redaction of "Grant is slow" redacts both clauses that name `Grant`.
- **The sticky held-part code doesn't widen.**
  - `heldForReview` is excluded from publishing (`sensitiveEntries` includes it by default), and a work part over a held entry holds. Probe: a rebuild covering E0–E5 holds with "covers entries kept personal as sensitive (e0, e1, e2)".
  - It carries through rebuilds (`held` in the context) and into `plan.heldForReview`.
  - Echo-only redactions count as redactions, so a plan that has any is never `wholeTo`.
  - Review clears only `heldForReview`; the held parts stay personal in the plan.
- **Should fix, a lost update in review.** `reviewPlan` (`store.ts:2476`) reads the plan and writes the whole JSON back outside the session lock. If `recordPlan` lands between the two, the stored plan reverts to the older one: its newer redactions, prunes and `sensitive` entries are lost, while the part rows match the newer plan. Update only `heldForReview`, under `underSessionLock` (or as an atomic JSON update).

**Addressed on `fix/echo-and-review` (after #35 merged as-is):**
- Roster names match case-insensitively again (`parts.ts`). The clause still fires only for `coworker` redactions, and that is what keeps "grant" from taking work text. The P2 test now asserts the accepted narrowing: a coworker redaction of a name also removes work clauses that share it, in any case.
- The probe's two cases are tests: a mis-cased and an exactly quoted coworker redaction, each with the lowercase neighbour echo. No "vlad" publishes in either.
- `reviewPlan` clears only `heldForReview`, in place (`jsonb_set`), with `reviewedAt` in the same statement, under the session's advisory lock. It never writes the plan back. Tested against a racing re-plan.
