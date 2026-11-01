# Routing planner charter tuning (2026-11-01)

This records every tuning run of the routing planner's charter (`ROUTE_PROMPT` in `src/route.ts`) against the test table in [ROUTING.md](ROUTING.md). It is a result, not a decision.

**Outcome: no variant cleared the pre-registered gates, so the shipped charter stays.** The failures that remain come from code, not from the charter's wording: a schema that rejects personal parts written as `organizations: []`, holds on byte-exact redactions that cascade to subagents, and echo redaction that matches only the exact span. Those are listed under [Findings outside the charter](#findings-outside-the-charter).

## Method

- **Fixture runner.** `scripts/route-fixtures.ts` runs the shipped path: `importTranscriptFile`, then `store.capture` (evidence computed at ingest under the machine's project map), then a `runBackfill` dry run, then `store.recordPlan`.
  - The database is a throwaway pgvector Postgres on a random port. The runner refuses 6132 and any host other than 127.0.0.1.
  - Parents are planned before their subagents. A subagent is judged against its parent's dry-run reach.
  - Only the charter text changes between runs: the runner passes it as `instructions`.
  - The cases file, with transcript paths, expected plans and markers, is private: `~/.foundry/evals/experiments/2026-11-01-archive-route-charter/`. It holds 11 scored cases and 2 unscored parents, 13 calls per run.
- **Scoring.** Each case is scored on the parts exactly as they would publish. That is the new dry-run `preview`, which returns `partSnapshot` output with every redaction applied, echoes included.
  - **(a) Organizations.** The organizations reached equal the table's.
  - **(b) Parts.** Each part's organizations are an expected set. For 01b0bda06a that means a UE part and a separate inixiative part.
  - **(c) Split.** The 512aaec0a6 opener (E0–E2) publishes nowhere. Redacting it inside a work part doesn't count.
  - **(d) Sensitive.** The case's markers reach no organization. The 512 markers are scoped to E0–E2; for 01b0 it is the coworker remark, at E0 and its echo at E1.
  - A held plan fails its case.
- **Configuration.** Sonnet 5.5, low effort. The roster on `userevidence` is Sam Farber, Alexandre Medina, Jose Diaz, Grant Ammons, Davud Khalilov, Jenny Leyva and Vlad.
- **Discipline.**
  - The design was pre-registered (`~/.foundry/evals/experiments/2026-11-01-archive-route-charter.md`).
  - An adversarial review returned "revise" (scorer bugs, fixed) and then "go" on rev 2.
  - Each variant is the current stack plus one change. A change joins the stack when it loses no stable pass and beats the stack's latest run.
  - Gate 1, to keep a variant: no stable pass lost, at least 2 more passes than the worse baseline run, and at least 1 more than the better one. Gate 2 is one confirmation run that must meet gate 1 again.
- **Disputed labels.** Two expected labels are disputed and reported both with and without:
  - 40b206fa84: under today's project map its evidence carries 19 UE writes, from `zealot/.worktrees/ZLT-6582`, created 11-01, after the table was written.
  - 1d3942e03f: ROUTING.md v3 #8 allows duplicating primitives work useful to Zealot.

## Variants

V0 is the shipped charter. Every other variant adds one sentence to a bullet of the stack it names.

| Variant | On | The change |
|---|---|---|
| V1 `evidence` | V0 | In the "Work for an organization" bullet, after "A session started in one folder can be another organization's work.", add: *"Name an organization for a part only when that part's own entries show tool activity in its projects (their "tools:" lines), a subagent spawned there did, or the session started in one of its projects; talking about an organization's work, or reading about it, is not doing it, and a plan naming an organization without such activity is held and nothing publishes."* (It states the validator's rule to the planner.) |
| V2 `cut` | V1 | Replace *"A part may go to several organizations when it is truly work for each."* with *"Cut a new part wherever whose work it is changes: when the session moves from one organization's work to another's, or between personal talk and work, each stretch is its own part with only its own organizations. A part goes to several organizations only when the same entries are work for each of them, not because the session as a whole touched both."* |
| V3 `where-it-lands` | V1 | Replace the same sentence with *"One goal can span organizations: cut it by where each stretch's work lands (its "tools:" lines), not by topic. A stretch whose changes are in one organization's projects is that organization's part alone; a part goes to several organizations only where its entries change each one's projects."* |
| V4 `coworker` | V3 | Before *"A redaction quotes the exact text…"*, add: *"Pasted chats and messages count: what the person says about a named coworker's conduct (blame, complaints, frustration, who broke or deleted what) is redacted even when it is one clause beside the work, and the work it explains stays."* |
| V5 `coworker-everywhere` | V3 | In the same place, add: *"A remark about a named coworker's conduct (blame, complaints, who broke or deleted what) is redacted wherever it appears, in pasted chats and in later entries that quote or paraphrase it, one redaction per occurrence."* |
| V6 `cut-at-switch` | V3 | After V3's sentence, add: *"Sending an organization a stretch that wasn't its work is the costlier mistake, so when a thread alternates between organizations, cut it at each switch rather than send the whole to both."* |

## Per-case scores

How to read the cells:
- **P**: pass.
- **f**: fail.
- **f\***: fail caused by the parent (it was held, or didn't reach the expected organization).
- **H**: held. Validation refused the plan, or the answer didn't parse. Either way the session publishes nothing.

| Case | V0 a | V0 b | V1 | V2 | V3 | V4 | V5 | V6 | V3 confirm |
|---|---|---|---|---|---|---|---|---|---|
| ae88b51ff2 personal | P | P | P | P | P | P | P | P | P |
| 65fa49fe13 personal | H | H | P | H | P | H | P | P | H |
| 512aaec0a6 split | P | P | P | P | P | H | P | H | P |
| 671481a4f6 UE | P | P | P | P | P | P | P | P | P |
| 95a4acd0e0 UE | P | P | P | P | P | P | P | H | P |
| 382e18e4cb UE (subagent) | P | P | P | P | P | P | P | P | P |
| 388f6c08c7 UE | P | P | P | P | P | P | P | P | P |
| 1d3942e03f UE (subagent, disputed) | P | f\* | f\* | P | P | f\* | f\* | P | P |
| 6b93e47069 inixiative (subagent) | P | P | P | P | P | f\* | f\* | P | P |
| 01b0bda06a UE + inixiative, split, redacted | f | f | f | f | f | f | f | f | f |
| 40b206fa84 inixiative (disputed) | f | f | f | f | f | f | f | f | f |
| **Passed** | **8/11** | **7/11** | **8/11** | **8/11** | **9/11** | **5/11** | **7/11** | **7/11** | **8/11** |
| Undisputed | 7/9 | 7/9 | 8/9 | 7/9 | 8/9 | 5/9 | 7/9 | 6/9 | 7/9 |
| Held | 1 | 1 | 0 | 1 | 0 | 2 | 0 | 2 | 1 |
| Stricter gate (simulated) | 5/11 | 4/11 | 5/11 | 5/11 | 6/11 | 2/11 | 4/11 | 5/11 | 5/11 |
| Tokens (k) | 532 | 533 | 534 | 535 | 535 | 536 | 536 | 537 | 534 |
| Charter sha256 | 1f99358a | 1f99358a | 82338a43 | 923391ed | b120cbdd | ae06e697 | 4af0dd42 | 7e4a8fc7 | b120cbdd |

## Reading

- **Baseline and variance.**
  - Seven cases are stable passes across both V0 runs, and stay passes in every run whose plan validated.
  - The run-to-run noise lives in two places. Holds: 65fa49fe13 was held in 5 of 9 runs, 3 by the evidence validator and 2 as unparseable. Parent reach: 1d3942e03f's 13,088-entry parent reached UE in some runs and not others. With that noise, a ±1 difference is not readable.
- **V1 (evidence)** removed the validator holds on 65fa49fe13: it was held by "no evidence for inixiative" in both V0 runs, and passed in V1, V3, V5 and V6. It was held once more by the same validator issue in V4, and by the empty-`organizations` rejection in the V3 confirmation. This is the clearest effect of any change, but it is not a measured gain under the gates.
- **V3** reached 9/11, but its gain was 1d3942e03f, the case that depends on its parent's reach. The confirmation run got 8/11 and failed gate 2, so the stack is not kept.
- **01b0bda06a never passed.**
  - V0 through V5 plan it as one part to both organizations: "one continuous effort".
  - V6 is the only variant that changed this. It cut the session into six parts, with E1–E62 going to inixiative alone and the Zealot stretches to UE. Its last part still went to both, so the case failed.
  - Once the charter asks (V4, V5), the planner redacts the coworker remark in E0. The assistant's echo in E1 stays, because it is capitalised and shorter than the redacted span. Code must close that gap; see below.
- **Pushing redaction harder hurts** (V4, V5). It produces more byte-mismatched redactions and unparseable answers. One held parent plan then sends its subagents personal. V4 lost both children that way.
- **40b206fa84** went to both organizations under V0, V1 and V3, and to UE only under V2 and V6. It never went to inixiative alone. Its current evidence, UE writes in a Zealot worktree, supports at least UE, so the expected label needs Aron's look.

## Findings outside the charter

These came out of the tuning, and none can be fixed by the charter's wording.

1. **Empty `organizations` is rejected as "unparseable".**
   - Sonnet writes a personal part as `"organizations": []`. `proposedPlanSchema` requires at least one organization, so `parsePlan` rejects the whole plan and the session is held.
   - Captured 3 times: 512aaec0a6 and 95a4acd0e0 in V6, and 65fa49fe13 in the V3 confirmation.
   - Three more answers were rejected as unparseable before the runner recorded raw answers (from V5 on): 65fa49fe13 in V2, and 512aaec0a6 and the 13k-entry parent in V4. Their cause isn't known.
   - Of the 8 case holds across the runs, 5 were rejected answers and 3 were the evidence validator (65fa49fe13 in V0 a, V0 b and V4). V4's rejected parent answer also failed both of its subagents.
   - The candidate fix is in code: read `[]` as personal, which narrows and never widens.
2. **One bad redaction holds the whole plan, and the hold cascades.**
   - A redaction that doesn't match its entry byte for byte holds the entire session (V5's 13k-entry parent).
   - Every subagent then plans against an unplanned parent and goes personal.
   - Candidate: drop the one redaction and keep the plan. That only matters if the part still publishes, so it would need its own review.
3. **Echo redaction matches only the exact span.**
   - `redactText` replaces the redacted text wherever that exact text appears.
   - A shorter or differently capitalised echo of the same remark in a later entry publishes.
   - The 01b0 case shows it. With the remark redacted in E0, the assistant's paraphrase in E1 would reach UE.
4. **Evidence drifts with the project map.** A Zealot worktree created after the table was written gives 40b206fa84 UE writes, so labels written against an older map can go stale.

## The stricter evidence gate (simulation, awaiting Aron)

The stricter gate counts an organization only when a part's entries wrote in its repositories, or when the session started in it and the part read there. It is simulated over every run's validated plans, with the gate in code unchanged.

| Case | Current | Under the stricter gate | Runs where it changed |
|---|---|---|---|
| 95a4acd0e0 (UE work, started in Zealot, no tool activity) | UE | personal | 8 of 8 valid |
| 382e18e4cb (UE work from an inixiative cwd, reads only) | UE | personal | 9 of 9 |
| 388f6c08c7 (UE work from an inixiative cwd, reads only) | UE | personal | 9 of 9 |

Every other case is unchanged. In particular 01b0bda06a and 40b206fa84 have writes in both organizations, so the stricter gate doesn't fix their over-inclusion. On this set it turns three correct UE routings personal and fixes nothing: 4–6 of 11 pass, against 5–9 under the current gate.

## Cost

- **Tokens.** 9 runs, 117 planner calls, 4.81M tokens: 4.43M cache writes, 0.35M cache reads and 32k output. Each run was about 0.53M. Nearly all of it is cold prefix writes, since every session is a different prompt.
- **Window.** The five-hour window went from 0% to 9% over the 9 runs, and the seven-day window from 27% to 28%.
- **Review.** The design reviews took 2 Opus agent passes, about 0.3M tokens.
