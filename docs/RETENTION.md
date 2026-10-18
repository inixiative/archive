# Retention: Archive keeps the transcripts

> **PROPOSAL. Needs Aron's yes before anything is built.** It changes what the `retentionDays` setting means and adds a usefulness score, so it falls under "talk the plan through before changing what something means." **Built (Aron, 2026-10-18):** §6.1 compaction, and a `captureToolCallsAndResults` setting that keeps tool calls and results out of the Archive (README, "Tags, references, actors and retention"). The rest is not implemented.

**Basis:** Archive `origin/main` 0.13.0 (`44d97a0`), Foundry `origin/main` (`f040582`; foundry-core `src/feedback/correction.ts` from `e10b2f0`), Oracle `origin/main`, and the live local Archive on Aron's machine, read 2026-10-12. Path prefixes: `ar/` = `archive/src`, `pf/` = `foundry/packages/foundry/src`, `pc/` = `foundry/packages/core/src`, `or/` = `oracle/src`.

## 1. Intent

Aron, 2026-10-12: *"The archive is supposed to be keeping the session transcripts. I'm okay with Claude doing whatever it's doing. We should have an archive. We should have our own pruning mechanism too. It has its own retention policy and it should probably classify things that should remain. We could consider applying a MuninnDB-style usefulness retention strategy also."*

So:

- **Claude Code and Codex may delete their own files.** Claude Code deletes transcripts after `cleanupPeriodDays` (default 30; not set on this machine). Archive must already hold every session by then.
- **Archive is the record.** Foundry, Oracle and the Prospector read sessions from Archive, not from `~/.claude/projects`.
- **Archive prunes on its own terms.** It keeps what earned its place, summarizes what might still matter, and drops the rest's content.

## 2. Where it stands today (measured 2026-10-12)

### 2.1 Capture

The local Archive runs: Compose project `archive`, image `ghcr.io/inixiative/archive:0.12.1` (healthy), `pgvector/pgvector:pg17` on loopback 6132, `/health` ok. Seven launchd collectors are loaded (`com.inixiative.archive.collect.*`) with empty error logs. They run `bun …/code/inixiative/archive/src/cli.ts`, the **shared main checkout**, so they run whatever that checkout holds (today `origin/main` plus one local commit).

Each collector captures only sessions whose recorded `cwd` exactly equals one of its roots (or a git worktree of one). `agents.json` declares:

| Collector | Roots | projectId |
|---|---|---|
| `claude-code.archive`, `codex.archive` | `archive` | `archive` |
| `claude-code.foundry`, `codex.foundry` | `foundry`, `kingdom-workspace/foundry` (retired) | `d8deab98-…` |
| `claude-code.kingdom`, `codex.kingdom` | `kingdom-workspace/kingdom` (retired), `kingdom` | `proj_01a0e466-…` |
| `codex.foundry-legacy` | `~/Desktop/inixiative/foundry` | `foundry` |

**What is not captured.** Sessions on disk whose `cwd` matches no collector (counts are top-level sessions + subagent files):

| cwd | Claude Code | Codex | Notes |
|---|---|---|---|
| `~/code/inixiative` (the orchestrator threads) | 23 + 125 (429 MB) | 43 (703 MB) | **The most important sessions.** Only 2 Claude and 1 Codex were imported by hand on 2026-09-21. |
| `~/code/zealot` (+ worktrees) | 25 + 34 | — | UserEvidence; a `userevidence` destination exists, no collector. |
| `template`, `oracle`, `config`, `json-rules`, `transitions`, `agent-session`, `tribe` (+ worktrees) | ~120 subagent files | 2 (tribe) | |
| `kingdom/apps/api/…` and other subdirectories | a few | | Nested directories never match an exact root. |
| Temp fixtures (`/private/var/folders/…/native-text-controlled-*`, `vcr-scenario-*`, scratchpads) | dozens | dozens | Test and probe sessions; should stay out. |

The collector scans every 30 seconds, so a session whose cwd *is* mapped is captured within a minute of each write. The gap is coverage, not latency.

### 2.2 How far back it holds

| projectId | Sessions | Oldest session start |
|---|---|---|
| foundry (`d8deab98-…`) | 107 Claude (85 subagents) + 4 Foundry | 2026-09-24 |
| kingdom (`proj_01a0e466-…`) | 79 Claude (77 subagents) | 2026-09-23 |
| archive | 10 Claude (all subagents) + 1 Codex | 2026-09-30 |
| inixiative, userevidence, foundry (Codex), personal (ChatGPT) | 1–2 each, hand imports | 2026-02-17 to 2026-09-21 |
| none (Foundry captures with no project) | 43 | 2026-10-01 |
| `P` | 32 Foundry captures | 2026-10-08 |

284 archives in all. The oldest Claude transcript left on disk was last written 2026-09-23, so everything Claude wrote before then, outside the hand imports, is gone from both places. Codex keeps its own files back to February.

### 2.3 Other findings

- **90% of storage is superseded revisions.** Every re-capture of a growing session stores a full new revision and re-chunks it. 2,670 of 2,956 revisions and 867k of 934k chunks belong to revisions that are no longer current. Search reads only the current revision (`ar/store.ts`, `searchCurrent`). `chunks` is 2.1 GB and `revisions` 431 MB of a 2.5 GB database.
- **Test captures land in the live Archive.** The 32 `P` archives and the 43 project-less Foundry captures look like Foundry test and probe runs writing through `localArchive()` to the machine's Archive.
- **Dead roots.** `agents.json` still lists `kingdom-workspace/*` roots (retired 2026-09-30/10-01) and a Desktop Foundry path. Harmless to capture, but they are drift.
- **Subagent lineage is only an id prefix.** The collector imports `subagents/agent-<id>.jsonl` as `<sessionId>/agent-<agentId>` (`ar/import.ts`) and does not read `agent-<id>.meta.json` (`agentType`, `toolUseId`, `spawnDepth`). See Foundry `docs/reference/SUBAGENTS.md` §2.
- **The current retention setting.** `retentionDays` (off by default; not set locally) hard-deletes every archive whose `capturedAt` is older than N days, at server start and hourly (`ArchiveStore.prune`, `ar/server.ts`). `capturedAt` is the last time the content changed. It deletes everything with no exceptions, and a deleted archive whose source file still exists is re-imported on the collector's next scan.

## 3. Capture guarantee

**Guarantee:** every Claude Code and Codex session on this machine is in the local Archive at its latest digest, or deliberately excluded, before the harness can delete it.

### 3.1 Machine-wide collection, routed by project

Keep the exact-root collectors (they are the routing map) and add one **catch-all** per source:

```sh
archive agents add-collector --name claude-code.unrouted --source claude-code --catch-all
archive agents add-collector --name codex.unrouted --source codex --catch-all
```

- A catch-all collector captures every session whose cwd no other collector in `agents.json` claims. It gives those sessions the reserved projectId `unrouted`.
- No destination matches `unrouted`, so by the existing routing rule ("an archive with no matching destination stays local") they never leave the machine. Routing them later is a re-route, not a re-capture.
- **Folder filters** are declared once in `agents.json` (`include` / `exclude` globs, applied to every match; README, "Collect"), always excluding decision receipts; temp directories stay out of broad matches. Test and fixture sessions stay out.
- Ancestor matching for nested directories (`kingdom/apps/api/…`) is opt-in per collector (`--subdirectories`); the default stays exact so another organization's nested checkout is never swept in.

Collectors to add on this machine (an `agents.json` edit, no code):

| Name | Roots | projectId |
|---|---|---|
| `claude-code.inixiative`, `codex.inixiative` | `~/code/inixiative` | `inixiative` (destination exists) |
| `claude-code.zealot`, `codex.zealot` | `~/code/zealot` | `userevidence` (destination exists, Render) |
| per repo, or one collector with several roots | `template`, `oracle`, `config`, `json-rules`, `transitions`, `agent-session`, `tribe`, `whitepaper` | one projectId each |

And remove the `kingdom-workspace` roots.

### 3.2 Coverage check

New command and endpoint, one implementation:

```sh
archive coverage            # also: agents status prints its summary
```

For each harness file it reports one of `captured` (latest digest held), `pending` (file changed since last capture), `excluded`, `unrouted` or `failed`, with the file's age. It flags any file not `captured` or `excluded` whose age passes `cleanupPeriodDays − 7`. Claude's `cleanupPeriodDays` is read from `~/.claude/settings.json` (default 30). Foundry's viewer shows the flag next to the Archive status it already has.

### 3.3 What a capture carries for retention

- **Lineage.** One shape, as shipped (0.20.0): `lineage: { kind: 'subagent' | 'fork', parentSessionId, rootSessionId?, parentEntryId?, toolUseId?, agentType?, agentName?, description?, depth? }`. `parentSessionId` is the direct parent's session id; a parent's archive key is `archiveKey({sourceId, source, sessionId: parentSessionId})`. The collector fills it from `agent-<id>.meta.json` and Codex `session_meta`. Foundry writes the trees it drives (Foundry `docs/THREAD-TREE.md` spec A), with `rootSessionId` and `parentEntryId`, and claims those native sessions so the collector does not capture them twice. A Foundry child thread is `subagent`; there is no separate `handoff` kind. Retention treats a lineage tree as one unit (§4).
- **Corrections.** At capture, run foundry-core's deterministic `extractCorrections(sessionId, turns)` (`pc/feedback/correction.ts`, MIT, data and pure functions, no model call) over the session's typed prompts (`typedPrompt`, `ar/import.ts`). Store the candidates' ids and signals in the listing summary. The model classification (`CORRECTION_CLASSIFY_PROMPT`) stays with Foundry and Oracle, which report back through citations (§5).

## 4. What must remain

Retention has three tiers:

| Tier | What is kept |
|---|---|
| **keep** | Everything: current revision, chunks, summary. Never pruned automatically. |
| **summarized** | The listing summary, typed prompts, correction candidates, references, lineage and a written summary (§6). Entries and chunks are dropped. |
| **pruned** | A tombstone: the Archive row with its `digest`, summary and citations. Nothing else. |

An archive is **kept** while any of these hold. Each is a *citation* (§5) of a kind that pins:

| Reason | Who records it | Citation kind |
|---|---|---|
| Has a correction candidate the Prospector detector found | Archive at capture | `correction` |
| A correction from it is classified as feedback, or is the provenance of a Foundry feedback item or event (`feedback_item` / `feedback_event`, FEEDBACK-LOOP §1.3–1.4) | Foundry | `feedback` |
| Linked to a commit or PR that merged | Archive, from its references, when a GitHub integration can confirm the merge; or Foundry/Oracle when they link it | `commit` |
| Source of an Oracle fixture (`session/<id>#n`, `or/fixture-store.ts`) or experiment | Oracle | `fixture` |
| A subagent or handoff whose parent is kept, or the parent of a kept child | Archive, from lineage | derived, not stored |
| Pinned by a person | Person (CLI, Foundry, Kingdom) | `pin` |

**Exempt sessions** (`run:test`, `run:oracle`, `run:foundry`; README, "Run tags") are outside this scheme, and an Archive with `captureRunSessions` off does not keep them at all: they get no citations, no usefulness score and no summary, and readers never cite them. They stay until deleted, and a person removing the run tag brings one back under retention. The tagger's `junk` suggestion is evidence for a lower starting confidence, never a deletion.

Releasing is deleting the citation (a feedback item is closed, a fixture is retired, a pin is removed). The archive then falls back to its score.

## 5. Usefulness score (MuninnDB style)

### 5.1 What MuninnDB does

Foundry's MuninnDB adapter (`pf/adapters/muninn-memory.ts`; moved out of template in `0853d47d`) uses its engine-native primitives. From MuninnDB's `docs/cognitive-primitives.md`:

- **Base-level activation (ACT-R / Ebbinghaus).** `B = ln(n + 1) − 0.5 · ln(ageDays / (n + 1))`, with `n` = access count and `ageDays` = days since last access, passed through `softplus(x) = ln(1 + eˣ)`. Only `n` and the last-access time are stored; the score is computed at query time from the clock, so it is deterministic and never needs a decay job.
- **Hebbian associations.** Co-activated items strengthen a link: `w ← min(1, w · (1 + 0.01)ⁿ)`, weighted by `sqrt(scoreA · scoreB)`.
- **Bayesian confidence.** `posterior = p·s / (p·s + (1−p)(1−s))`, clamped `0.95 · posterior + 0.025`. Reinforcement raises it, contradiction lowers it. Every score is multiplied by it.
- **Final score.** `ContentMatch × softplus(B + hebbian + transition) × confidence`. Deletes are soft and restorable for 7 days.

### 5.2 Applied to sessions

Archive stores, per archive, `accessCount` and `lastAccessAt` (MuninnDB's two inputs) and a list of citations. It computes:

```
ageDays   = days since max(lastAccessAt, capturedAt)
B         = ln(n + 1) − 0.5 · ln(max(ageDays, 1) / (n + 1))         n = accessCount
cite      = Σ over unpinned citations: weight(kind)                  (inject 1, cite 3)
usefulness = softplus(B + cite) × confidence
```

- **An access** is a `read` through the API, or an archive whose chunks a `search` returned. It raises `accessCount` and `lastAccessAt`. Publication, routing, listing and the collector's `head` do not count.
- **An injection** is stronger than an access: Foundry's `ArchiveContextSource` (`pf/archives/context-source.ts`) puts search results into an agent's context as historical evidence, and reports each one as an `inject` citation.
- **Citations from Wardens and Oracle** (`cite`) are explicit: a Warden or an Oracle run says "I used this session." They count more than accesses and record who cited and why, so they survive in the tombstone.
- **Confidence** starts from the capture: 0.5 for scripted sessions (Codex `exec`, sessions with no typed prompt, ~0 entries) and 0.8 otherwise. A correction classified as real feedback reinforces (`s = 0.9`); a session marked superseded or wrong contradicts (`s = 0.1`). The Bayesian update above, clamped the same way.
- **Hebbian links are not in the first build.** Archives co-cited in one Foundry turn could strengthen each other, but nothing needs ranking by association yet. Recorded as a later step (§9, step 7).

### 5.3 Tiers from the score

Per ownership boundary (§7), with defaults:

| Condition | Tier |
|---|---|
| Any pinning citation (§4), or in a lineage tree with one | keep |
| `usefulness ≥ keepScore` (default 1.0) | keep |
| Older than `summarizeAfterDays` (default 30) and `usefulness < keepScore` | summarized |
| Summarized for `pruneAfterDays` (default 180) and `usefulness < pruneScore` (default 0.3) | pruned |

A fresh, never-read session has `n = 0`, so `B = −0.5 · ln(ageDays)`: about 0 on day 1, −1.7 at 30 days, −2.6 at 180 days. Its usefulness, with confidence 0.8, is about 0.55 at day 1, 0.13 at 30 days and 0.06 at 180 days. One `cite` at 30 days lifts it to about 1.2 (kept); with no further use it drops under 1.0 again around day 70. Ten reads, the last at day 60, keep it above 1.0 for about seven months after that last read. The defaults are a starting point; §10 asks Aron to set them.

## 6. Pruning mechanism

### 6.1 Compaction first (no knowledge lost) — built

Delete every revision and its chunks except the current one, unless an `outbox` row still names it. A growing session's earlier revisions are prefixes of the current one, so this loses nothing. As built: each capture deletes the revision it replaced; a delivery deletes the revision the outbox held back; the background maintenance at server start and hourly deletes the rest, one revision per statement, so an upgraded Archive compacts what earlier versions kept without a long transaction. `read` of a compacted revision answers 410. Measured 2026-10-18 on this machine: 15,629 of 16,780 revisions superseded; `chunks` 28 GB heap + 23 GB indexes of a 62 GB database. Space returns to the operating system only through `archive maintenance reclaim` (drop the trigram index, `VACUUM FULL`, rebuild the index over current rows). With `captureToolCallsAndResults` off (Aron, 2026-10-18: no tool activity anywhere we own, past captures included), every destination converges to the stripped copies; what the person typed through a tool, references linked from tool output and subagent spawn anchors survive the strip (README).

### 6.2 Summarize before prune

Moving to **summarized**:

1. Writes a summary into the archive: the goal, decisions, corrections and their outcome, references, files touched (Atlas tags). Generated by a Foundry decision role on a warm subscription session (subscription-only execution); Archive itself calls no model. Archive asks Foundry through the local pairing; with no Foundry, the step waits and the archive stays kept.
2. Keeps the typed prompts verbatim. They are small, and they are what the Prospector and `foundry repeats` read.
3. Stores the summary as a new revision with `coverage.completeness: 'partial'` and an omission "summarized from revision N", then compacts (§6.1). Search keeps working on the summary's chunks.

Moving to **pruned** deletes that revision and its chunks and leaves the tombstone. The tombstone keeps `digest`, so the collector's `head()` sees an unchanged file as unchanged and does not re-import it. If the session is resumed, the digest differs, a new revision is captured and the archive is back in **keep**.

### 6.3 Schedule

The existing hourly job (`ar/server.ts`) runs compaction, then tier transitions, at most `batch` archives per run. Every transition writes a line to a `retention_log` (archive id, from, to, score, reasons) and is listed by `archive retention --dry-run`, which prints what the next run would do. A transition to pruned waits `graceDays` (default 7) after it is first listed, like MuninnDB's 7-day restorable delete. `archive retention restore --id` undoes a summarize while the source file or a destination still has the content.

### 6.4 Deletion

`delete` (explicit, per archive) stays a hard delete. The hard age cap that `retentionDays` is today becomes optional `deleteAfterDays`, applied only to tombstones. Deletions still never sync.

## 7. Settings and ownership boundaries

One deployment is one ownership boundary (README). Settings live where they do today, in the deployment's `settings` row:

```ts
retention: {
  mode: 'off' | 'usefulness',        // default 'off' until Aron turns it on
  keepScore: number, pruneScore: number,
  summarizeAfterDays: number, pruneAfterDays: number, graceDays: number,
  deleteAfterDays: number | null,
  pinningKinds: CitationKind[],       // default: correction, feedback, commit, fixture, pin
}
```

`retentionDays` goes; no alias.

- **Personal and organization Archives** are separate deployments, so each owner sets its own policy. Kingdom shows and edits the hosted ones through the Archive integration's settings endpoints (`settings/read`, `settings/update`), under a Signet that grants `settings.write`.
- **The local Archive is multi-project.** Per-project overrides: `retention.projects[projectId]` with the same fields. `unrouted` defaults to `summarizeAfterDays: 14`.
- **Retention is per copy.** Each Archive prunes its own copy; deletions and tier changes do not sync. A hosted org Archive can keep forever what a laptop prunes.
- **Zealot / UserEvidence.** Zealot sessions get their own collector and projectId `userevidence`, publish only to the UserEvidence Archive (Render), and are never summarized by an inixiative-paired Foundry. Summaries are generated under the session's own boundary: Foundry runs the summarizer only with a model account and owner that match the projectId's context. Until that context exists in Foundry, `userevidence` sessions stay **keep** locally and are never summarized.

## 8. Who reads from Archive instead of `~/.claude/projects`

| Reader | Today | With this |
|---|---|---|
| **Oracle** `oracle mine` | `transcriptDirFor(repo)` reads `~/.claude/projects/<encoded>` (`or/session-miner.ts`) | `ArchiveClient.list/read` by projectId; writes `fixture` and `feedback` citations |
| **Foundry** `foundry repeats` (on `feat/repeat-report`) | Unions harness files, `~/.claude/history.jsonl` and the local Archive | Archive only once coverage reports nothing pending; the harness files stay a fallback while the catch-all rolls out |
| **Foundry** feedback lifecycle (FEEDBACK-LOOP) | Live turns | Backfill from Archive; each feedback item's provenance is a `feedback` citation |
| **Foundry** `ArchiveContextSource` | Already Archive search | Reports `inject` citations |
| **Foundry** session restore (HARNESS_LIFECYCLE: "if it's been garbage-collected, Foundry replays from its own archive") | Unbuilt | `read` the archive |
| **Wardens** | Do not read sessions | When one cites a past session, it writes a `cite` citation |
| **Prospector detector** | Runs inside Oracle and Foundry over raw files | Also runs at capture (§3.3); readers use the stored candidates |

New API, one action family, on the existing `POST /api/v1/archive/<action>`:

| Action | Body | Returns |
|---|---|---|
| `citations/add` | `archiveId`, `kind`, `ref`, `actor?` | the citation (idempotent on archive + kind + ref) |
| `citations/remove` | `archiveId`, `kind`, `ref` | removed |
| `citations/list` | `archiveId` or `kind` + `ref` | citations |
| `retention/plan` | none | the next run's transitions (the dry run) |
| `retention/restore` | `archiveId` | the archive back in keep, when content can be recovered |

Listings gain `tier`, `usefulness` and `citations` (counts per kind), and filter by `tier`.

### 8.1 Schema (extends the existing tables)

- `Archive`: add `accessCount Int @default(0)`, `lastAccessAt Float?`, `confidence Float @default(0.8)`, `tier String @default("keep")`, `tierAt Float?`.
- New `Citation`: `archiveId`, `kind`, `ref`, `actorId?`, `at`; `@@id([archiveId, kind, ref])`, cascade with the archive.
- New `RetentionLog`: `id`, `archiveId`, `from`, `to`, `usefulness`, `reasons Json`, `at`. Not cascaded, so a hard delete leaves its record.

No parallel store: summaries are revisions, tombstones are Archive rows, settings are the existing `settings` row.

## 9. Build order

1. **Coverage now (no code):** add the inixiative, zealot and per-repo collectors, drop the `kingdom-workspace` roots, `archive agents install`. This captures the 23 + 125 orchestrator sessions and 43 Codex sessions before Claude's cleanup reaches them. Run collectors from the installed package, not the shared checkout.
2. **Stop test pollution:** Foundry tests and probes must not write to the machine's Archive; delete the `P` captures.
3. **Revision compaction** (§6.1), compacting existing data in the background maintenance. Built 2026-10-18.
4. **Catch-all collector, exclusions and `archive coverage`** (§3.1–3.2).
5. **Lineage and capture-time corrections** (§3.3).
6. **Citations, access counts, score, `retention/plan` dry run.** `mode` stays `off`; the plan is visible but nothing transitions.
7. **Summarize (Foundry decision role) and tier transitions,** turned on per deployment by Aron. Then Oracle and `foundry repeats` move to Archive-only reads. Hebbian co-citation links after that, if ranking needs them.

## 10. Test cases

Against a real Postgres, as the existing tests do (`tests/db.ts`):

1. A session whose cwd matches no collector is captured by the catch-all as `unrouted` and appears in no `routes` result.
2. A session under an excluded temp directory is reported `excluded` by `coverage` and never captured.
3. `coverage` flags a file older than `cleanupPeriodDays − 7` that is `pending`.
4. Capturing revision 3 of a session deletes revisions 1–2 and their chunks; a revision named by an `outbox` row survives until delivered.
5. A subagent file with `meta.json` gets `lineage.parentSessionId` naming its parent (whose key is computed from it); pinning the parent keeps the child.
6. A session with a "once and for all" correction gets a `correction` citation at capture and stays in keep at any age.
7. A never-read session at 31 days moves to summarized in the plan; with `mode: 'off'` nothing changes.
8. Ten reads spread over 60 days keep a session's usefulness above `keepScore`.
9. A pruned tombstone with an unchanged source file is `unchanged` on the next scan; a resumed session is re-captured into keep.
10. Removing a `fixture` citation drops the session back to its score on the next run.
11. A `userevidence` session is never summarized by an inixiative-paired Foundry and never published to an inixiative destination.
12. Per-project overrides: `unrouted` summarizes at 14 days while `inixiative` keeps the default.
13. A hard `delete` leaves its `RetentionLog` rows.
14. Publication, listing and `head` do not change `accessCount`; `read` and search hits do.

## 11. Open questions for Aron

1. **Turn it on at all, and where?** Should the local Archive ever prune, or only compact and summarize, with pruning reserved for hosted copies? Disk is the only pressure locally, and compaction removes most of it.
2. **Defaults.** `keepScore` 1.0, `summarizeAfterDays` 30, `pruneAfterDays` 180, `graceDays` 7: set your own, or approve these.
3. **Every correction pins?** The deterministic detector over-reports (FEEDBACK-LOOP calls it a prefilter). Pin on any candidate, or only once Foundry/Oracle classify it as feedback?
4. **Summaries need a model.** Archive is OSS and calls no model. Is a Foundry decision role the right summarizer, and what happens on a machine without Foundry: keep everything, or a deterministic summary (typed prompts + corrections + references only)?
5. **"Linked to merged commits":** the references are mentions, not proof (README). Confirm merges through a GitHub integration on the Archive, or only trust Foundry and Oracle links?
6. **Projects to collect.** Which repos get their own projectId and destination, and which stay `unrouted` (local only)? Does `~/code/inixiative` itself map to `inixiative`?
7. **`history.jsonl`.** `~/.claude/history.jsonl` holds every typed prompt across sessions and `foundry repeats` reads it. Should Archive capture it (as a `claude-code` history source), or is the per-session capture enough once coverage is complete?
8. **Hebbian links.** Worth building, or is citation-weighted recency enough for retention?
9. **Should Signets govern reads that count as access?** A hosted Archive read through Kingdom is usage on a Signet; should that usage feed `accessCount` there?
