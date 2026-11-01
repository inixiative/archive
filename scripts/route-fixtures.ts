#!/usr/bin/env bun
/**
 * Scores the routing planner against real sessions with known answers. It imports transcripts into
 * a scratch database, plans them as a dry run (`runBackfill`, parents before their subagents, so a
 * subagent is judged against its parent's dry-run reach), and checks each case's parts as they
 * would publish (`recordPlan` with `preview`): the organizations each part reaches, whether a
 * stretch that must stay personal publishes anywhere, and whether sensitive text reaches an
 * organization. It also scores a stricter evidence gate, simulated over the same plans.
 *
 * Cases and transcripts are private: the cases file lives outside the repo.
 *   bun scripts/route-fixtures.ts --database URL --cases FILE --agents agents.json --home DIR
 *     [--charter FILE] [--import | --import-only] [--label NAME] [--out FILE]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { machineProjectMap, readAgents } from '../src/agents';
import { sessionMetadata } from '../src/collector';
import { type Routing, routingSchema } from '../src/config';
import { evidenceByOrganization, type SessionEvidence } from '../src/evidence';
import { importTranscriptFile } from '../src/import-file';
import type { ArchiveSnapshot } from '../src/index';
import {
  PERSONAL,
  type ProposedPlan,
  parsePlan,
  type RecordPlanResult,
  ROUTE_PROMPT,
  type RoutingArchive,
  runBackfill,
} from '../src/route';
import { ArchiveStore } from '../src/store';
import type { SuggestModel } from '../src/suggest';
import { claudeRouteModel } from '../src/suggest-claude';
import { withoutToolActivity } from '../src/tool-activity';

const range = z.strictObject({ from: z.number().int(), to: z.number().int() });
const casesSchema = z.strictObject({
  organizations: z.array(
    z.strictObject({ id: z.string(), projects: z.array(z.string()), roster: z.array(z.string()) }),
  ),
  files: z.array(
    z.strictObject({
      file: z.string(),
      source: z.enum(['codex', 'claude-code']),
      projectId: z.string(),
    }),
  ),
  cases: z.array(
    z.strictObject({
      label: z.string(),
      /** The session's title starts with this (titles are the first prompt). */
      title: z.string(),
      /** Why the expected plan is in question, if it is: totals are reported with and without. */
      disputed: z.string().optional(),
      expect: z.strictObject({
        /** Every organization the session's parts reach, together. Empty: personal only. */
        organizations: z.array(z.string()),
        /** Each published part's organizations must be one of these sets, and each set appear. */
        parts: z.array(z.array(z.string())).optional(),
        /** Entries (stripped indices) that must publish nowhere: a stretch cut off as personal. */
        personal: range.optional(),
        /** Text that must reach no organization (case-insensitive), within `within` when given. */
        sensitive: z
          .strictObject({ text: z.array(z.string()).min(1), within: range.optional() })
          .optional(),
      }),
    }),
  ),
});
type Cases = z.infer<typeof casesSchema>;
type Case = Cases['cases'][number];

const { values: v } = parseArgs({
  options: {
    database: { type: 'string' },
    cases: { type: 'string' },
    agents: { type: 'string' },
    home: { type: 'string' },
    charter: { type: 'string' },
    import: { type: 'boolean', default: false },
    'import-only': { type: 'boolean', default: false },
    label: { type: 'string', default: 'run' },
    out: { type: 'string' },
    concurrency: { type: 'string', default: '2' },
    /** UNDER EXPERIMENT: run the sanitizing second call per work part. */
    sensitivity: { type: 'boolean', default: false },
    /** Plan and score only these case labels (comma-separated): a tiny test. */
    only: { type: 'string' },
    /**
     * Re-score a recorded run with no model call: its proposals are fed back through this code
     * (a control for code that changed after the run).
     */
    replay: { type: 'string' },
  },
});
if (!v.database || !v.cases || !v.agents || !v.home)
  throw new Error('--database, --cases, --agents and --home are required');
const database = new URL(v.database);
// A scratch database only: never this machine's Archive (the registry's port 6132).
if (database.hostname !== '127.0.0.1' || database.port === '6132')
  throw new Error('--database must be a scratch Postgres on 127.0.0.1, not port 6132');

const cases: Cases = casesSchema.parse(JSON.parse(readFileSync(v.cases, 'utf8')));
const only = v.only ? new Set(v.only.split(',').map((label) => label.trim())) : undefined;
const routing: Routing = routingSchema.parse({
  organizations: cases.organizations,
  destinations: [],
});
const store = new ArchiveStore(database.href);
const agents = readAgents(resolve(v.agents));
if (!agents) throw new Error(`No agents config at ${v.agents}`);

if (v.import || v['import-only']) {
  const push = Bun.spawnSync([process.execPath, 'x', 'prisma', 'db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: database.href },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (!push.success) throw new Error(`db push: ${push.stderr.toString()}`);
  // As this machine's Archive runs: tool activity is stripped at capture.
  await store.updateSettings({ captureToolCallsAndResults: false });
  await store.setProjectMap(machineProjectMap(agents));
  const sourceId = await store.sourceId();
  for (const f of cases.files) {
    const snapshot = importTranscriptFile(f.file, {
      source: f.source,
      sourceId,
      projectId: f.projectId,
    });
    const cwd = sessionMetadata(f.file, f.source)?.cwd;
    const captured = await store.capture(snapshot, cwd ? { cwd } : {});
    console.error(`imported ${captured.id.slice(0, 10)} ${snapshot.entries.length} entries`);
  }
}

const settings = await store.settings();
const map = await store.projectMap();
type Session = { id: string; evidence: SessionEvidence | null; snapshot: ArchiveSnapshot };
const sessions: Session[] = [];
for (const row of await store.db.archive.findMany({
  where: { partOf: null },
  select: { id: true, evidence: true },
})) {
  const read = await store.read(row.id);
  if (!read) continue;
  sessions.push({
    id: row.id,
    evidence: (row.evidence ?? null) as SessionEvidence | null,
    // What the planner reads: the session stripped of tool activity.
    snapshot: withoutToolActivity(read.snapshot, settings.integrations).snapshot,
  });
}
const sessionOf = (c: Case) => {
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  const found = sessions.find((s) => flat(s.snapshot.title).startsWith(flat(c.title)));
  if (!found) throw new Error(`No session titled ${c.title}`);
  return found;
};
const hits = (s: Session, needle: string) =>
  s.snapshot.entries.flatMap((e, i) =>
    e.text.toLowerCase().includes(needle.toLowerCase()) ? [i] : [],
  );

if (v['import-only']) {
  // What the cases need checked before any model call: the window, and where each marker sits.
  for (const c of cases.cases) {
    const s = sessionOf(c);
    const input = await store.routingInput(s.id, routing);
    console.log(
      `${c.label} ${s.id.slice(0, 10)} entries ${input.total}, first window E0–E${input.through}` +
        ` · start ${input.session.startOrganization ?? '-'} · evidence ${JSON.stringify(input.evidence)}`,
    );
    for (const needle of c.expect.sensitive?.text ?? [])
      console.log(`  marker "${needle}": entries ${hits(s, needle).join(', ') || 'none'}`);
  }
  await store.close();
  process.exit(0);
}

// The charter under test replaces the shipped one; everything else is the shipped path.
const charter = v.charter ? readFileSync(v.charter, 'utf8') : ROUTE_PROMPT;
const recorded = v.replay
  ? (JSON.parse(readFileSync(v.replay, 'utf8')) as { proposals: Record<string, unknown> }).proposals
  : undefined;
/** In a replay (concurrency 1), the session whose input was read last: the one being planned. */
let replaying: string | undefined;
// A replay answers the planner from the recorded run; the sensitivity pass, when on, is live.
const live =
  !recorded || v.sensitivity
    ? await claudeRouteModel({ home: resolve(v.home), concurrency: Number(v.concurrency) })
    : undefined;
const base: SuggestModel & { close(): Promise<void> } = recorded
  ? {
      model: live?.model ?? 'replay',
      async decide(request) {
        if (request.key !== 'archive-route') {
          if (!live) throw new Error('A replay without --sensitivity makes no other call');
          return live.decide(request);
        }
        if (!replaying || !(replaying in recorded))
          throw new Error(`No recorded proposal for ${replaying ?? 'an unknown session'}`);
        const proposal = recorded[replaying];
        // A recorded failure replays as an answer that does not parse, which holds as it did.
        return {
          content: proposal && typeof proposal === 'object' ? JSON.stringify(proposal) : 'no plan',
        };
      },
      async close() {
        await live?.close();
      },
    }
  : live!;
/** Answers the plan parser refused, kept whole so a parse failure can be told from a bad plan. */
const unparseable: { session: string; content: string }[] = [];
/** Every planner answer and sanitizer answer, by the session title line, for offline re-scoring. */
const answers: {
  key: string;
  session: string;
  archiveId?: string;
  content: string;
  tokens?: unknown;
}[] = [];
const model: SuggestModel = {
  model: base.model,
  decide: async (request) => {
    // Only the planner's call takes the charter under test; the sanitizing call keeps its own.
    if (request.key !== 'archive-route') {
      const checked = await base.decide(request);
      answers.push({
        key: request.key,
        session: request.input.split('\n')[0] ?? '',
        ...(replaying ? { archiveId: replaying } : {}),
        content: checked.content,
        ...(checked.tokens ? { tokens: checked.tokens } : {}),
      });
      return checked;
    }
    const answer = await base.decide({ ...request, instructions: charter });
    if (!parsePlan(answer.content))
      unparseable.push({ session: request.input.split('\n')[1] ?? '', content: answer.content });
    answers.push({
      key: request.key,
      session: request.input.split('\n')[1] ?? '',
      ...(replaying ? { archiveId: replaying } : {}),
      content: answer.content,
      ...(answer.tokens ? { tokens: answer.tokens } : {}),
    });
    return answer;
  },
};
const proposals = new Map<string, ProposedPlan | string>();
const results = new Map<string, RecordPlanResult>();
const archive: RoutingArchive = {
  routingInput: ({ archiveId }) => {
    replaying = archiveId;
    return store.routingInput(archiveId, routing);
  },
  recordPlan: async (body) => {
    proposals.set(body.archiveId, body.proposal ?? body.failure ?? 'none');
    const result = await store.recordPlan({ ...body, preview: true }, routing);
    results.set(body.archiveId, result);
    return result;
  },
  routingDue: async (body) =>
    store.routingDue({ ...body, contextKey: await store.routingContextKey(routing) }),
};
const started = Date.now();
let report: Awaited<ReturnType<typeof runBackfill>>;
try {
  report = await runBackfill(archive, model, {
    dryRun: true,
    ...(v.sensitivity ? { sensitivity: true } : {}),
    ...(only
      ? { only: new Set(cases.cases.filter((c) => only.has(c.label)).map((c) => sessionOf(c).id)) }
      : {}),
    concurrency: recorded ? 1 : Number(v.concurrency),
    progress: (line) => console.error(line),
  });
} finally {
  await base.close();
}

const startOrganization = (e: SessionEvidence | null) =>
  e?.startProjectId
    ? routing.organizations.find((o) => o.projects.includes(e.startProjectId!))?.id
    : undefined;
/**
 * The stricter gate over an entry range: an organization counts when the range wrote in its
 * repositories, or the session started in one of its projects and the range read there. A subagent
 * spawned inside the range counts by the same rule over its own evidence.
 */
function strictAllowed(session: Session, ids: ReadonlySet<string>) {
  const allowed = new Set<string>();
  const admit = (e: SessionEvidence | null, within?: ReadonlySet<string>) => {
    const start = startOrganization(e);
    for (const [o, counts] of Object.entries(evidenceByOrganization(e, routing, map, within)))
      if (counts.writes > 0 || (o === start && counts.reads > 0)) allowed.add(o);
  };
  admit(session.evidence, ids);
  for (const child of sessions) {
    const lineage = child.snapshot.lineage;
    if (
      !lineage ||
      lineage.kind === 'part' ||
      lineage.parentSessionId !== session.snapshot.sessionId
    )
      continue;
    const spawn = session.snapshot.entries.find(
      (e) =>
        (lineage.toolUseId && e.callId === lineage.toolUseId) || e.id === lineage.parentEntryId,
    );
    if (spawn && ids.has(spawn.id)) admit(child.evidence);
  }
  allowed.delete(PERSONAL);
  return allowed;
}

type Published = { organizations: string[]; snapshot: ArchiveSnapshot };
type Judgement = {
  reached: string[];
  organizationsOk: boolean;
  partsOk?: boolean;
  personalOk?: boolean;
  sensitiveOk?: boolean;
  leaked?: string[];
  pass: boolean;
};
const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
/** A case's parts as they publish, against its expected plan. */
function judge(c: Case, session: Session, valid: boolean, published: Published[]): Judgement {
  const index = new Map(session.snapshot.entries.map((e, i) => [e.id, i]));
  const reached = [...new Set(published.flatMap((p) => p.organizations))].sort();
  const organizationsOk = valid && same(reached, c.expect.organizations);
  const { parts, personal, sensitive } = c.expect;
  const partsOk = parts
    ? valid &&
      published.every((p) => parts.some((s) => same(s, p.organizations))) &&
      parts.every((s) => published.some((p) => same(s, p.organizations)))
    : undefined;
  const inRange = (id: string, r: { from: number; to: number }) => {
    const i = index.get(id) ?? -1;
    return i >= r.from && i <= r.to;
  };
  const personalOk = personal
    ? valid && !published.some((p) => p.snapshot.entries.some((e) => inRange(e.id, personal)))
    : undefined;
  // The published text, every redaction applied (echoes included), as partSnapshot writes it.
  const leaked = sensitive
    ? sensitive.text.filter((needle) =>
        published.some((p) =>
          p.snapshot.entries.some(
            (e) =>
              (!sensitive.within || inRange(e.id, sensitive.within)) &&
              e.text.toLowerCase().includes(needle.toLowerCase()),
          ),
        ),
      )
    : undefined;
  const sensitiveOk = leaked ? valid && leaked.length === 0 : undefined;
  return {
    reached,
    organizationsOk,
    ...(partsOk === undefined ? {} : { partsOk }),
    ...(personalOk === undefined ? {} : { personalOk }),
    ...(sensitiveOk === undefined ? {} : { sensitiveOk, leaked }),
    pass: organizationsOk && partsOk !== false && personalOk !== false && sensitiveOk !== false,
  };
}

const reachOf = (id: string | undefined) => {
  const result = id ? results.get(id) : undefined;
  return {
    status: result?.status ?? 'not planned',
    ...(result?.issues?.length ? { issues: result.issues } : {}),
    reach: [...new Set((result?.parts ?? []).flatMap((p) => p.organizations))].sort(),
  };
};
type Score = Judgement & {
  label: string;
  disputed?: string;
  status: string;
  issues?: string[];
  parts: { from: number; to: number; organizations: string[]; sensitive: boolean }[];
  redactions: number;
  prunes: number;
  parent?: { status: string; reach: string[] };
  strict: Judgement;
};
const scores: Score[] = [];
for (const c of cases.cases.filter((c) => !only || only.has(c.label))) {
  const session = sessionOf(c);
  const result = results.get(session.id);
  const valid = result?.status === 'valid';
  const index = new Map(session.snapshot.entries.map((e, i) => [e.id, i]));
  const published: Published[] = (result?.parts ?? []).map((p, i) => ({
    organizations: p.organizations,
    snapshot: result!.snapshots![i]!,
  }));
  // The stricter gate narrows each part to what it allows; a part left with none publishes nowhere.
  const strict: Published[] = published.flatMap((p) => {
    const ids = p.snapshot.entries.map((e) => index.get(e.id) ?? -1).filter((i) => i >= 0);
    const span = new Set(
      session.snapshot.entries.slice(Math.min(...ids), Math.max(...ids) + 1).map((e) => e.id),
    );
    const allowed = strictAllowed(session, span);
    const organizations = p.organizations.filter((o) => allowed.has(o));
    return organizations.length ? [{ ...p, organizations }] : [];
  });
  const parentId = (await store.routingInput(session.id, routing)).parentArchiveId;
  scores.push({
    label: c.label,
    ...(c.disputed ? { disputed: c.disputed } : {}),
    status: result?.status ?? 'not planned',
    ...(result?.issues?.length ? { issues: result.issues } : {}),
    parts: (result?.plan?.parts ?? []).map((p) => ({
      from: index.get(p.firstEntryId) ?? -1,
      to: index.get(p.lastEntryId) ?? -1,
      organizations: p.organizations,
      sensitive: p.sensitive,
    })),
    redactions: result?.plan?.redactions.length ?? 0,
    prunes: result?.plan?.prune.length ?? 0,
    ...(parentId ? { parent: reachOf(parentId) } : {}),
    ...judge(c, session, valid, published),
    strict: judge(c, session, valid, strict),
  });
}
const caseIds = new Set(cases.cases.map((c) => sessionOf(c).id));
const others = sessions
  .filter((s) => !caseIds.has(s.id))
  .map((s) => ({ id: s.id.slice(0, 10), title: s.snapshot.title.slice(0, 60), ...reachOf(s.id) }));
const count = (pick: (s: Score) => boolean, undisputed = false) =>
  scores.filter((s) => (!undisputed || !s.disputed) && pick(s)).length;
const output = {
  label: v.label,
  charter: new Bun.CryptoHasher('sha256').update(charter).digest('hex').slice(0, 16),
  at: new Date(started).toISOString(),
  seconds: Math.round((Date.now() - started) / 1000),
  calls: report.calls,
  tokens: report.tokens,
  passed: count((s) => s.pass),
  passedUndisputed: count((s) => s.pass, true),
  undisputed: count(() => true, true),
  strictPassed: count((s) => s.strict.pass),
  held: count((s) => s.status === 'held'),
  of: scores.length,
  scores,
  others,
  proposals: Object.fromEntries(proposals),
  unparseable,
  answers,
};
if (v.out) {
  mkdirSync(resolve(v.out, '..'), { recursive: true });
  writeFileSync(v.out, `${JSON.stringify(output, null, 2)}\n`);
}
const flags = (j: Judgement) =>
  [
    j.partsOk === undefined ? '' : `parts=${j.partsOk ? 'ok' : 'no'}`,
    j.personalOk === undefined ? '' : `split=${j.personalOk ? 'ok' : 'no'}`,
    j.sensitiveOk === undefined
      ? ''
      : `sensitive=${j.sensitiveOk ? 'ok' : `LEAK(${j.leaked?.length})`}`,
  ]
    .filter(Boolean)
    .join(' ');
for (const s of scores)
  console.log(
    `${s.pass ? 'PASS' : 'fail'} ${s.label.padEnd(12)} ${s.status.padEnd(6)} → ${s.reached.join('+') || PERSONAL} ${flags(s)}` +
      `${s.parent ? ` (parent ${s.parent.status} → ${s.parent.reach.join('+') || PERSONAL})` : ''}` +
      ` | strict → ${s.strict.reached.join('+') || PERSONAL}${s.strict.pass ? ' PASS' : ''}`,
  );
for (const o of others)
  console.log(`  parent ${o.id} ${o.status} → ${o.reach.join('+') || PERSONAL}`);
console.log(
  `${output.passed}/${output.of} pass (${output.passedUndisputed}/${output.undisputed} undisputed) · held ${output.held} · strict ${output.strictPassed}/${output.of} · ${output.calls} calls · ${JSON.stringify(output.tokens)} · ${output.seconds}s`,
);
await store.close();
