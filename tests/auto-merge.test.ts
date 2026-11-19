import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { TOOLS } from '../bin/office-workers.js';
import type { PullExtra, ShaChecks } from '../src/server/gh-checks.js';
import { GitHub } from '../src/server/github.js';
import type { FreshPull } from '../src/server/gh-merge.js';
import { officeWorkers } from '../src/server/hooks/office-workers.js';
import { gateOpen } from '../src/server/merge/gate.js';
import { MergeService } from '../src/server/merge/service.js';
import { FloorMergeStore, MergePolicyStore } from '../src/server/merge/store.js';
import { QaService, type QaFloor, type QaGitHub } from '../src/server/qa/service.js';
import { TaskQueue, type QueueEvents, type QueueWorkers } from '../src/server/queue.js';
import { mergeHandlers } from '../src/server/ws/handlers/merge.js';
import { classify, globToRegExp, validExtraGlob } from '../src/shared/merge.js';
import type { GhCheck, GhPull, MergeViewState, WorkerInfo } from '../src/shared/protocol.js';

// Controlled automatic merging, entirely against mocked GitHub operations: nothing here can reach GitHub, merge a
// real pull request, or change a real repository.

const root = mkdtempSync(path.join(tmpdir(), 'ao-merge-'));
test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows keeps a folder while a process that was in it is still going.
  }
});
let seq = 0;
const tmp = (name: string) => {
  const dir = path.join(root, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const pass = (name = 'CI / test'): GhCheck => ({ name, state: 'pass', url: `https://ci.example/${name}` });
const policyInput = { mode: 'auto' as const, authorization: 'HQ governance PR #123, approved by the owner 2026-11-19' };

// --- A floor with real QA and a mocked GitHub ---------------------------------------------------------------------------------------------

class FakeGh implements QaGitHub {
  pulls = { items: [] as GhPull[] };
  extra = new Map<number, PullExtra>();
  /** What branch protection says is required (null: it says nothing readable). */
  required: string[] | null = ['test'];
  /** What GitHub says about a commit asked for by its SHA, when it is not the default (all pass). */
  bySha = new Map<string, ShaChecks>();
  live = new Map<number, string>();
  freshAsks = 0;
  extras(n: number) {
    return this.extra.get(n);
  }
  async requiredChecks(_base: string, fresh?: boolean) {
    if (fresh) this.freshAsks++;
    return this.required;
  }
  async shaChecks(sha: string, fresh?: boolean) {
    if (fresh) this.freshAsks++;
    return this.bySha.get(sha) ?? { sha, checks: [pass('test')], exact: true, at: Date.now() };
  }
  async pullHead(n: number) {
    return this.live.get(n) ?? this.pulls.items.find((p) => p.number === n)?.headRefOid ?? '';
  }
  open(n: number, o: { sha?: string; files?: string[]; lines?: number; fork?: boolean; base?: string } = {}) {
    const sha = o.sha ?? SHA1;
    const lines = o.lines ?? 4;
    const p = { number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, url: `https://github.com/o/r/pull/${n}`, author: 'the-shared-bot', labels: [{ name: 'approved', color: '0f0' }], reviewDecision: 'APPROVED', headRefName: `feature-${n}`, headRefOid: sha, baseRefName: o.base ?? 'main', createdAt: '', updatedAt: '', additions: lines - 1, deletions: 1, checks: 'pass', body: 'Reviewed-by: an independent QA Engineer', closes: [] } as GhPull;
    this.pulls.items = [...this.pulls.items.filter((x) => x.number !== n), p];
    this.extra.set(n, { sha, mergeable: 'MERGEABLE', mergeState: 'CLEAN', files: o.files ?? ['docs/guide.md'], fork: o.fork ?? false, checks: [pass('test')] });
  }
}

class FakeOps {
  pulls = new Map<number, FreshPull>();
  canMergeResult = true;
  merges: [number, string, string][] = [];
  mergeError?: string;
  pullCalls = 0;
  /** Runs whenever the office reads a pull request: lets a test change the world mid-verification. */
  onPull?: () => void;
  onMerge?: () => void;
  async pull(n: number) {
    this.pullCalls++;
    this.onPull?.();
    return { ...this.pulls.get(n)! };
  }
  async canMerge() {
    return this.canMergeResult;
  }
  async merge(n: number, sha: string, method: string) {
    this.merges.push([n, sha, method]);
    this.onMerge?.();
    if (this.mergeError) throw new Error(this.mergeError);
    this.pulls.set(n, { ...this.pulls.get(n)!, state: 'MERGED', mergeCommit: 'c'.repeat(40) });
  }
  fresh(n: number, o: Partial<FreshPull> = {}) {
    this.pulls.set(n, { state: 'OPEN', draft: false, head: SHA1, base: 'main', mergeable: 'MERGEABLE', mergeState: 'CLEAN', fork: false, repo: 'o/r', ...o });
  }
}

interface Rig {
  gh: FakeGh;
  ops: FakeOps;
  qa: QaService;
  merge: MergeService;
  policy: MergePolicyStore;
  gate: { open: boolean };
  dir: string;
  officeDir: string;
  emitted: MergeViewState[];
  toasts: string[];
  audit(): { kind: string; ok?: boolean; reasons?: string[]; pr?: number; by: string }[];
}

function rig(t: { after(fn: () => void): void }, o: { repo?: string; policy?: MergePolicyStore; officeDir?: string; dir?: string; gateOpen?: boolean } = {}): Rig {
  const dir = o.dir ?? tmp('floor');
  const officeDir = o.officeDir ?? tmp('office');
  const workers: WorkerInfo[] = [];
  const events: QueueEvents = { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} };
  const qworkers: QueueWorkers = { defaultProvider: 'claude', list: () => workers, deskOccupied: () => false, spawn: () => 'no', kill: async () => ({}) };
  const queue = new TaskQueue(dir, qworkers, false, events);
  t.after(() => queue.shutdown());
  const r = { gh: new FakeGh(), ops: new FakeOps(), gate: { open: o.gateOpen ?? true }, dir, officeDir, emitted: [], toasts: [] } as unknown as Rig;
  const floor = { id: 'f1', dir, def: { name: 'Floor' }, workers: { list: () => workers, get: () => undefined, ownerOf: () => undefined, prompt: () => undefined }, queue, github: r.gh } as unknown as QaFloor;
  r.qa = new QaService(dir, floor, () => ({ floors: () => [floor], planLimits: () => ({ windows: [], at: 0 }) }), r.gh, { emit() {}, toast() {} });
  r.policy = o.policy ?? new MergePolicyStore(officeDir);
  r.merge = new MergeService(dir, { floorId: 'f1', repo: () => o.repo ?? 'o/r', gate: () => r.gate.open, policy: r.policy, qa: r.qa, pulls: () => r.gh.pulls.items, extras: (n) => r.gh.extras(n), ops: r.ops, checks: r.gh, emit: (s) => r.emitted.push(s), toast: (x) => r.toasts.push(x) });
  r.audit = () => r.merge.store.recent(1000);
  return r;
}

/** A pull request that QA calls ready: checks of this commit pass and a person recorded a review of it. */
async function ready(r: Rig, n = 7, o: Parameters<FakeGh['open']>[1] = {}) {
  r.gh.open(n, o);
  r.ops.fresh(n, { head: o.sha ?? SHA1, base: o.base ?? 'main', fork: o.fork ?? false });
  await r.qa.onPulls(r.gh.pulls.items);
  r.qa.attest(n, o.sha ?? SHA1, 'approve', 'QA-1', 'read it', 'Ada');
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(r.qa.state().prs.find((p) => p.number === n)?.state, 'ready', 'the fixture is ready for a person to merge');
}
const on = (r: Rig) => assert.equal(r.merge.setPolicy('Owner', policyInput).ok, true);
const kinds = (r: Rig) => r.audit().map((e) => e.kind);

// --- Which changes qualify ---------------------------------------------------------------------------------------------------------------

const POLICY = { bases: ['main'], maxChangedLines: 300, maxFiles: 20, extraLowRisk: [] as string[] };
const verdict = (files: string[] | undefined, over: Partial<{ lines: number; base: string; fork: boolean }> = {}, extra: string[] = []) => classify({ files, lines: 10, base: 'main', fork: false, ...over }, { ...POLICY, extraLowRisk: extra }).verdict;

test('only documentation, tests and what the owner marked low-risk qualify; sensitive, protected, unknown and oversized changes need a person', () => {
  assert.equal(verdict(['docs/guide.md', 'README.md', 'tests/a.test.ts', 'docs/img/x.png']), 'eligible');
  for (const sensitive of ['.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'install.sh', 'install.ps1', 'bin/office-workers.js', 'deploy/aws.sh', 'Dockerfile', 'src/server/signins.ts', 'src/server/accounts.ts', 'tsconfig.json', 'vite.config.ts', 'AGENTS.md', 'CLAUDE.md', 'roles/qa-engineer.md', '.env', 'keys/server.pem', 'config.yml', 'infra/main.tf', '.claude/agents/x.md', 'scripts/release.sh']) {
    assert.equal(verdict(['docs/a.md', sensitive]), 'human', sensitive);
  }
  assert.equal(verdict(['src/server/queue.ts']), 'human', 'ordinary source is not low-risk unless the owner says so');
  assert.equal(verdict(['docs/a.md'], {}, []), 'eligible');
  assert.equal(verdict(['src/client/ui/x.ts'], {}, ['src/client/ui/**']), 'eligible', 'a path the owner marked');
  assert.equal(verdict(['.github/workflows/ci.yml'], {}, ['**/*.yml', '.github/**']), 'human', "the owner's paths cannot reach a protected file");
  assert.equal(verdict(['src/server/signins.ts'], {}, ['src/server/**']), 'human', 'nor a security file');
  assert.equal(verdict(undefined), 'human', 'unknown files');
  assert.equal(verdict([]), 'human');
  assert.equal(verdict(Array.from({ length: 100 }, (_, i) => `docs/f${i}.md`)), 'human', 'a cut-off list');
  assert.equal(verdict(Array.from({ length: 21 }, (_, i) => `docs/f${i}.md`)), 'human', 'too many files');
  assert.equal(verdict(['docs/a.md'], { lines: 301 }), 'human', 'too many lines');
  assert.equal(verdict(['docs/a.md'], { fork: true }), 'human');
  assert.equal(verdict(['docs/a.md'], { base: 'release' }), 'human');
  const why = classify({ files: ['.github/workflows/x.yml', 'src/a.ts'], lines: 9999, base: 'main', fork: false }, POLICY).reasons;
  assert.ok(why.length >= 3 && why.some((w) => /sensitive or protected/.test(w)) && why.some((w) => /9999 lines/.test(w)), 'every reason is listed');
  assert.ok(!validExtraGlob('**') && !validExtraGlob('/etc/**') && !validExtraGlob('../x') && !validExtraGlob('*') && validExtraGlob('src/ui/**'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts') && !globToRegExp('src/*.ts').test('src/a/b.ts'));
});

// --- The whole workflow ----------------------------------------------------------------------------------------------------------------------

test('an eligible low-risk pull request is merged once, after everything is asked again, and each step is in the audit', async (t) => {
  const r = rig(t);
  on(r);
  await ready(r);
  const before = { pulls: r.ops.pullCalls, fresh: r.gh.freshAsks };
  await r.merge.onQa();
  assert.deepEqual(r.ops.merges, [[7, SHA1, 'squash']], 'one merge, of exactly the reviewed commit');
  assert.ok(r.ops.pullCalls - before.pulls >= 2, 'GitHub was asked about the pull request before and after');
  assert.ok(r.gh.freshAsks - before.fresh >= 3, 'branch protection, the commit’s checks and the review were asked again, fresh');
  const k = kinds(r);
  assert.deepEqual(k, ['policy', 'decision', 'attempt', 'merging', 'merged'], 'the decision, the attempt, the line just before the call to GitHub, and the merge');
  const merged = r.audit().find((e) => e.kind === 'merged')!;
  assert.deepEqual([merged.ok, merged.by, merged.pr], [true, 'office', 7]);
  assert.match(merged.reasons![0], /authorized by Owner: HQ governance PR #123/);
  assert.equal((merged as unknown as { mergeCommit: string }).mergeCommit, 'c'.repeat(40));
  assert.equal(r.merge.state().prs[0].status, 'merged');
  assert.ok(r.toasts.some((x) => /merged automatically/.test(x)));
  await r.merge.onQa();
  assert.equal(r.ops.merges.length, 1, 'a merged commit is not merged again');
});

test('off by default: with the gate closed nothing can be switched on, even by an admin, and nothing is merged', async (t) => {
  assert.equal(gateOpen({}), false, 'the gate is closed unless the operator sets it');
  assert.equal(gateOpen({ AGENT_OFFICE_AUTOMERGE: 'true' }), false);
  assert.equal(gateOpen({ AGENT_OFFICE_AUTOMERGE: 'enabled' }), true);
  const r = rig(t, { gateOpen: false });
  const refused = r.merge.setPolicy('Owner', policyInput);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /not enabled in this installation/);
  assert.equal(r.policy.repos.size, 0);
  await ready(r);
  await r.merge.onQa();
  assert.deepEqual([r.ops.merges.length, r.ops.pullCalls <= 1], [0, true]);
  // A policy file that says "auto" is inert while the gate is closed, and a damaged one switches nothing on.
  r.gate.open = true;
  on(r);
  r.gate.open = false;
  await r.merge.onQa();
  assert.equal(r.ops.merges.length, 0);
  assert.equal(r.merge.state().gate, false);
  const again = new MergePolicyStore(r.officeDir);
  assert.equal(again.repos.size, 1);
  assert.equal((await r.merge.attempt(7)).merged, false);
});

// --- Revalidation: CI, reviews, a moving head --------------------------------------------------------------------------------------------

test('failed, missing or still-running CI at the moment of merging stops it; so does a list that already said failed', async (t) => {
  const r = rig(t);
  on(r);
  await ready(r);
  // CI changes after QA looked: the checks of exactly this commit, asked fresh, now fail.
  r.gh.bySha.set(SHA1, { sha: SHA1, checks: [{ name: 'test', state: 'fail' }], exact: true, at: 1 });
  assert.equal((await r.merge.attempt(7)).merged, false);
  assert.match(r.audit().at(-1)!.reasons![0], /not ready any more: failed/);
  // A required check that has not reported.
  r.gh.bySha.set(SHA1, { sha: SHA1, checks: [pass('lint')], exact: true, at: 2 });
  assert.equal((await r.merge.attempt(7)).merged, false);
  assert.match(r.audit().at(-1)!.reasons![0], /not ready any more: awaiting/);
  // Still running; nothing reported at all; check runs that belong to another commit.
  for (const checks of [[{ name: 'test', state: 'pending' as const }], []]) {
    r.gh.bySha.set(SHA1, { sha: SHA1, checks, exact: true, at: 3 });
    assert.equal((await r.merge.attempt(7)).merged, false);
  }
  r.gh.bySha.set(SHA1, { sha: SHA1, checks: [pass('test')], exact: false, at: 4 });
  assert.equal((await r.merge.attempt(7)).merged, false);
  assert.equal(r.ops.merges.length, 0);
  // The sync already says a check failed: QA does not call it ready, and nothing is even attempted.
  const other = rig(t);
  on(other);
  other.gh.open(9);
  other.gh.extra.get(9)!.checks = [{ name: 'CI / test', state: 'fail' }];
  other.ops.fresh(9);
  await other.qa.onPulls(other.gh.pulls.items);
  await other.merge.onQa();
  assert.deepEqual([other.merge.state().prs[0].qa, other.ops.merges.length, other.ops.pullCalls], ['failed', 0, 0]);
});

test('a review that is missing, stale, not independent, or only claimed never lets a pull request merge', async (t) => {
  const r = rig(t);
  on(r);
  r.gh.open(7);
  r.ops.fresh(7);
  await r.qa.onPulls(r.gh.pulls.items);
  await r.merge.onQa();
  assert.equal(r.merge.state().prs[0].qa, 'needs-review', 'GitHub says APPROVED, there is an approved label and a Reviewed-by line: none of it is a review');
  assert.equal(r.ops.merges.length, 0);
  assert.equal(r.ops.pullCalls, 0, 'nothing was even asked');
  // A review of an earlier commit does not count for a later one.
  r.qa.attest(7, SHA1, 'approve', undefined, undefined, 'Ada');
  r.gh.open(7, { sha: SHA2 });
  r.ops.fresh(7, { head: SHA2 });
  await r.qa.onPulls(r.gh.pulls.items);
  await r.merge.onQa();
  const s = r.qa.state().prs[0];
  assert.deepEqual([s.state, s.evidence[0].status], ['needs-review', 'stale']);
  assert.equal(r.ops.merges.length, 0);
  // A review that changes the picture between QA's look and the merge: the review is asked again too.
  const q = rig(t);
  on(q);
  await ready(q);
  q.qa.store.evidence.length = 0; // the review stops being on file
  assert.equal((await q.merge.attempt(7)).merged, false);
  assert.match(q.audit().at(-1)!.reasons![0], /not ready any more|no independent review/);
  assert.equal(q.ops.merges.length, 0);
});

test('the head changing during verification stops the merge, wherever in the process it changes', async (t) => {
  // 1. GitHub reports another head when the office reads the pull request just before merging.
  const a = rig(t);
  on(a);
  await ready(a);
  a.ops.fresh(7, { head: SHA2 });
  assert.equal((await a.merge.attempt(7)).merged, false);
  assert.match(a.audit().at(-1)!.reasons![0], /the head moved to bbbbbbb during verification/);
  // 2. It moves while the checks and the review are confirmed.
  const b = rig(t);
  on(b);
  await ready(b);
  b.gh.live.set(7, SHA2);
  assert.equal((await b.merge.attempt(7)).merged, false);
  assert.match(b.audit().at(-1)!.reasons![0], /head moved while the review and checks were confirmed/);
  // 3. It moves after everything passed, in the instant before GitHub merges: GitHub refuses, because the office asked it to match the head.
  const c = rig(t);
  on(c);
  await ready(c);
  c.ops.mergeError = 'Head branch was modified. Review and try the merge again.';
  assert.equal((await c.merge.attempt(7)).merged, false);
  assert.deepEqual(c.ops.merges, [[7, SHA1, 'squash']], 'the merge was asked for with the exact commit');
  assert.match(c.audit().at(-1)!.reasons![0], /GitHub refused the merge: Head branch was modified/);
  assert.ok(!kinds(c).includes('merged'));
  for (const x of [a, b]) assert.equal(x.ops.merges.length, 0);
});

// --- Sensitive changes -----------------------------------------------------------------------------------------------------------------------

test('a high-risk change is never merged automatically, even with a counting review and passing checks', async (t) => {
  const cases: [string, Parameters<FakeGh['open']>[1]][] = [
    ['a workflow', { files: ['docs/a.md', '.github/workflows/ci.yml'] }],
    ['a dependency', { files: ['package-lock.json'] }],
    ['an install script', { files: ['install.sh'] }],
    ['authentication', { files: ['src/server/signins.ts'] }],
    ['protected configuration', { files: ['tsconfig.json'] }],
    ['unknown source', { files: ['src/server/queue.ts'] }],
    ['an oversized change', { files: ['docs/a.md'], lines: 1000 }],
    ['a fork', { files: ['docs/a.md'], fork: true }],
    ['another branch', { files: ['docs/a.md'], base: 'release' }],
  ];
  for (const [name, o] of cases) {
    const r = rig(t);
    on(r);
    await ready(r, 7, o);
    await r.merge.onQa();
    assert.equal(r.ops.merges.length, 0, name);
    assert.equal(r.merge.state().prs[0].status, 'human', name);
    assert.equal(r.ops.pullCalls <= 1, true, `${name}: nothing was asked of GitHub for merging`);
    assert.equal((await r.merge.attempt(7)).merged, false, name);
  }
  // No file list at all: not known, so a person.
  const r = rig(t);
  on(r);
  await ready(r);
  r.gh.extra.get(7)!.files = undefined;
  await r.merge.onQa();
  assert.equal(r.merge.state().prs[0].status, 'human');
  assert.equal(r.ops.merges.length, 0);
});

// --- Who may switch it on -------------------------------------------------------------------------------------------------------------------

function fakeCtx(r: Rig, accountId: string | undefined, repoOf: Rig[] = [r], current = 0) {
  const sent: { ok?: boolean; message?: string }[] = [];
  const ctx = { floorOf: () => ({ merge: repoOf[current].merge }), meOf: (id?: string) => ({ admin: id === 'admin' }), sendTo: (_c: unknown, m: { ok?: boolean; message?: string }) => void sent.push(m), warn() {}, toastFloor() {} };
  return { ctx, sent, client: { accountId, peer: { name: accountId ? accountId.toUpperCase() : 'Guest', floor: 'f1' } } };
}
const h = mergeHandlers as unknown as Record<string, (c: unknown, cl: unknown, m: unknown) => unknown>;

test('only an admin, with the gate open and a written authorization, can switch it on, for this repository only; agents have no way to', async (t) => {
  const r = rig(t);
  const member = fakeCtx(r, 'member');
  const guest = fakeCtx(r, undefined);
  for (const who of [member, guest]) {
    await h['merge.policy'](who.ctx, who.client, { t: 'merge.policy', ...policyInput });
    await h['merge.approve'](who.ctx, who.client, { t: 'merge.approve', pr: 7, sha: SHA1 });
    await h['merge.resume'](who.ctx, who.client, { t: 'merge.resume' });
    assert.deepEqual(who.sent.map((m) => m.ok), [false, false, false]);
  }
  assert.equal(r.policy.repos.size, 0);
  assert.ok(r.audit().filter((e) => e.kind === 'blocked' && /is not an admin/.test(e.reasons?.[0] ?? '')).length >= 4, 'each refusal is written down');
  const admin = fakeCtx(r, 'admin');
  // Without a reference to the owner's governance record it does not turn on.
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', mode: 'auto' });
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', mode: 'auto', authorization: 'ok' });
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', ...policyInput, extraLowRisk: ['**'] });
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', ...policyInput, method: 'force-push' });
  assert.deepEqual(admin.sent.map((m) => m.ok), [false, false, false, false]);
  assert.equal(r.policy.repos.size, 0);
  // Gate closed: an admin still cannot.
  r.gate.open = false;
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', ...policyInput });
  assert.equal(admin.sent.at(-1)!.ok, false);
  assert.match(admin.sent.at(-1)!.message!, /not enabled in this installation/);
  r.gate.open = true;
  await h['merge.policy'](admin.ctx, admin.client, { t: 'merge.policy', ...policyInput, repo: 'someone/else', method: 'squash' });
  assert.equal(admin.sent.at(-1)!.ok, true);
  assert.deepEqual([...r.policy.repos.keys()], ['o/r'], "the floor's own repository: a message cannot name another");
  const p = r.policy.get('o/r')!;
  assert.deepEqual([p.mode, p.authorizedBy, p.method], ['auto', 'ADMIN', 'squash']);

  // Agents: no worker route, no MCP tool, nothing in the worker route's source about merging or policy.
  const names = TOOLS.map((x: { name: string }) => x.name);
  assert.ok(!names.some((n: string) => /merge|policy|approve|auto/i.test(n)), names.join());
  const ctx = { workerFloor: () => ({ workers: { authenticate: () => ({ id: 'w', name: 'W' }) }, queue: { state: () => ({ tasks: [] }) }, github: { pulls: { items: [] } } }), floors: new Map(), toastFloor() {} };
  for (const route of ['/merge', '/policy', '/approve', '/automerge', '/stop']) {
    const out = { status: 0 };
    const req = Object.assign(Readable.from([Buffer.from('{}')]), { method: 'POST', headers: { authorization: 'Bearer x' } }) as unknown as http.IncomingMessage;
    await officeWorkers(ctx as never, req, { writeHead: (s: number) => void (out.status = s), end() {} } as unknown as http.ServerResponse, new URL(`http://o/office/workers${route}?worker=w`));
    assert.equal(out.status, 405, route);
  }
  const src = readFileSync(path.join(import.meta.dirname, '..', 'src/server/hooks/office-workers.ts'), 'utf8');
  assert.ok(!/merge\/|MergeService|policy\.set|\.merge\./.test(src), 'the worker route cannot reach the merge code');
});

// --- Repository boundaries ----------------------------------------------------------------------------------------------------------------

test("a repository's policy covers that repository only: another floor, or a pull request from another repository, is out of reach", async (t) => {
  const policy = new MergePolicyStore(tmp('shared-office'));
  const a = rig(t, { repo: 'o/a', policy });
  const b = rig(t, { repo: 'o/b', policy });
  assert.equal(a.merge.setPolicy('Owner', policyInput).ok, true);
  assert.deepEqual([...policy.repos.keys()], ['o/a']);
  await ready(b);
  await b.merge.onQa();
  assert.equal(b.ops.merges.length, 0, 'floor B is a different repository: it is not switched on');
  assert.match((await b.merge.attempt(7)).message, /automatic merging is off for o\/b/);
  // Switching B on from floor A's controls is impossible: the handler works on the floor you are on.
  const adminOnB = fakeCtx(b, 'admin', [a, b], 1);
  await h['merge.policy'](adminOnB.ctx, adminOnB.client, { t: 'merge.policy', ...policyInput });
  assert.deepEqual([...policy.repos.keys()].sort(), ['o/a', 'o/b']);
  assert.equal(a.merge.state().allowlist.length, 2, 'the allowlist is the same office-wide record');
  // A pull request that GitHub says belongs to another repository is refused, even on a switched-on floor.
  const c = rig(t, { repo: 'o/a', policy });
  await ready(c);
  c.ops.fresh(7, { repo: 'o/other' });
  assert.equal((await c.merge.attempt(7)).merged, false);
  assert.match(c.audit().at(-1)!.reasons![0], /belongs to o\/other, not o\/a/);
  assert.equal(c.ops.merges.length, 0);
  // A floor with no repository cannot be switched on at all.
  const d = rig(t, { repo: '', policy });
  assert.equal(d.merge.setPolicy('Owner', policyInput).ok, false);
});

// --- Branch protection and permissions ------------------------------------------------------------------------------------------------

test("GitHub's branch protection, mergeability and permissions are respected and never worked around", async (t) => {
  const refusals: [string, (r: Rig) => void, RegExp][] = [
    ['no readable protection', (r) => void (r.gh.required = null), /no readable branch protection/],
    ['no required checks', (r) => void (r.gh.required = []), /no readable branch protection/],
    ['blocked by a branch rule', (r) => r.ops.fresh(7, { mergeState: 'BLOCKED' }), /does not call it mergeable \(MERGEABLE, BLOCKED\)/],
    ['behind its base', (r) => r.ops.fresh(7, { mergeState: 'BEHIND' }), /BEHIND/],
    ['conflicts', (r) => r.ops.fresh(7, { mergeable: 'CONFLICTING', mergeState: 'DIRTY' }), /CONFLICTING/],
    ['unstable checks', (r) => r.ops.fresh(7, { mergeState: 'UNSTABLE' }), /UNSTABLE/],
    ['no permission', (r) => void (r.ops.canMergeResult = false), /may not merge in this repository/],
    ['a draft', (r) => r.ops.fresh(7, { draft: true }), /it is a draft/],
    ['closed', (r) => r.ops.fresh(7, { state: 'CLOSED' }), /it is closed/],
    ['a fork', (r) => r.ops.fresh(7, { fork: true }), /it comes from a fork/],
    ['another base', (r) => r.ops.fresh(7, { base: 'release' }), /does not cover/],
  ];
  for (const [name, spoil, why] of refusals) {
    const r = rig(t);
    on(r);
    await ready(r);
    spoil(r);
    assert.equal((await r.merge.attempt(7)).merged, false, name);
    assert.match(r.audit().at(-1)!.reasons![0], why, name);
    assert.equal(r.ops.merges.length, 0, name);
  }
  // GitHub itself says no at the last moment (a rule the office could not see): the office stops there and does not try another way.
  const r = rig(t);
  on(r);
  await ready(r);
  r.ops.mergeError = 'Required status check "test" is expected.';
  assert.equal((await r.merge.attempt(7)).merged, false);
  assert.equal(r.ops.merges.length, 1, 'one request, no retry with other flags');
  // What is sent to GitHub: exactly the merge of one commit, never a bypass.
  const calls: string[][] = [];
  const gh = new GitHub(tmp('gh'), () => {}, () => {}, async (args) => (calls.push(args), '{}'));
  await gh.ops.merge(7, SHA1, 'squash');
  await gh.ops.merge(8, SHA2, 'rebase');
  assert.deepEqual(calls, [['pr', 'merge', '7', '--squash', '--match-head-commit', SHA1], ['pr', 'merge', '8', '--rebase', '--match-head-commit', SHA2]]);
  assert.ok(!calls.flat().some((a) => /^--(admin|auto|delete-branch|force)/.test(a)));
});

// --- The emergency stop -------------------------------------------------------------------------------------------------------------------

test('the emergency stop halts everything at once, also in the middle of an attempt; only an admin resumes it; it survives a restart', async (t) => {
  const r = rig(t);
  on(r);
  await ready(r);
  // Anyone can press it.
  const member = fakeCtx(r, 'member');
  await h['merge.stop'](member.ctx, member.client, { t: 'merge.stop', reason: 'something looks wrong' });
  assert.equal(member.sent[0].ok, true);
  assert.equal(r.merge.state().stopped?.by, 'MEMBER');
  assert.equal((await r.merge.attempt(7)).merged, false);
  await r.merge.onQa();
  assert.equal(r.ops.merges.length, 0);
  await h['merge.resume'](member.ctx, member.client, { t: 'merge.resume' });
  assert.equal(member.sent[1].ok, false, 'a member cannot resume it');
  assert.ok(r.merge.state().stopped);
  // It is office-wide: another floor sees it too.
  const other = rig(t, { repo: 'o/z', policy: r.policy, officeDir: r.officeDir });
  assert.match((await other.merge.attempt(1)).message, /emergency stop is on/);
  // A restart keeps it.
  assert.equal(new MergePolicyStore(r.officeDir).stopped?.reason, 'something looks wrong');
  // An admin resumes it, and then the merge goes ahead.
  const admin = fakeCtx(r, 'admin');
  await h['merge.resume'](admin.ctx, admin.client, { t: 'merge.resume' });
  assert.equal(admin.sent[0].ok, true);
  await r.merge.onQa();
  assert.equal(r.ops.merges.length, 1);
  assert.deepEqual(kinds(r).filter((k) => k === 'stop' || k === 'resume'), ['stop', 'resume']);
  // Pressed mid-attempt, after the office began asking GitHub: nothing is merged.
  const m = rig(t);
  on(m);
  await ready(m);
  m.ops.onPull = () => void m.merge.stop('Guest', 'pressed in the middle');
  assert.equal((await m.merge.attempt(7)).merged, false);
  assert.equal(m.ops.merges.length, 0);
  assert.match(m.audit().at(-1)!.reasons![0], /stopped before merging: the emergency stop is on/);
  // And while it is on, nothing can even be approved.
  const approve = rig(t);
  approve.merge.setPolicy('Owner', { ...policyInput, mode: 'approve' });
  await ready(approve);
  approve.merge.stop('Guest');
  assert.equal((await approve.merge.approve(7, SHA1, 'Ada')).ok, false);
});

// --- Duplicates -----------------------------------------------------------------------------------------------------------------------------

test('duplicate merge attempts, at once or later or after a restart, merge once; repeated failures give up', async (t) => {
  const r = rig(t);
  on(r);
  await ready(r);
  const [first, second] = await Promise.all([r.merge.attempt(7), r.merge.attempt(7)]);
  assert.deepEqual([first.merged, second.merged].sort(), [false, true]);
  assert.match([first, second].find((x) => !x.merged)!.message, /duplicate/);
  assert.equal(r.ops.merges.length, 1);
  assert.match((await r.merge.attempt(7)).message, /already merged/);
  // The record remembers it across a restart: a new service over the same folder will not merge it again.
  const restarted = new MergeService(r.dir, { floorId: 'f1', repo: () => 'o/r', gate: () => true, policy: r.policy, qa: r.qa, pulls: () => r.gh.pulls.items, extras: (n) => r.gh.extras(n), ops: r.ops, checks: r.gh, emit() {}, toast() {} });
  assert.match((await restarted.attempt(7)).message, /already merged/);
  assert.equal(r.ops.merges.length, 1);
  // A merge GitHub keeps refusing is tried a few times and then left to a person.
  const f = rig(t);
  on(f);
  await ready(f);
  f.ops.mergeError = 'Pull request is not mergeable';
  for (let i = 0; i < 3; i++) assert.equal((await f.merge.attempt(7)).merged, false);
  assert.equal(f.ops.merges.length, 3);
  assert.match((await f.merge.attempt(7)).message, /gave up after 3 attempts/);
  assert.equal(f.ops.merges.length, 3);
});

test('in approve mode an eligible pull request waits for a person, whose yes is about one commit', async (t) => {
  const r = rig(t);
  assert.equal(r.merge.setPolicy('Owner', { ...policyInput, mode: 'approve' }).ok, true);
  await ready(r);
  await r.merge.onQa();
  assert.deepEqual([r.merge.state().prs[0].status, r.ops.merges.length], ['awaiting-approval', 0]);
  // An approval of another commit does not count.
  r.merge.store.approvals.set(7, { pr: 7, sha: SHA2, by: 'Ada', at: 1 });
  await r.merge.onQa();
  assert.equal(r.ops.merges.length, 0);
  assert.equal((await r.merge.approve(7, SHA2, 'Ada')).ok, false, 'not the commit it is at');
  // An approval of this one is acted on, after the same revalidation.
  const approved = await r.merge.approve(7, SHA1, 'Ada');
  assert.equal(approved.ok, true);
  assert.match(approved.message, /everything was checked again and it was merged/);
  await r.merge.onQa();
  assert.deepEqual(r.ops.merges, [[7, SHA1, 'squash']]);
  assert.ok(kinds(r).includes('approval'));
  // Withdrawn before the last look: no merge.
  const w = rig(t);
  w.merge.setPolicy('Owner', { ...policyInput, mode: 'approve' });
  await ready(w);
  w.ops.onPull = () => void w.merge.revoke(7, 'Ada');
  w.merge.store.approvals.set(7, { pr: 7, sha: SHA1, by: 'Ada', at: 1 });
  assert.equal((await w.merge.attempt(7)).merged, false);
  assert.match(w.audit().at(-1)!.reasons![0], /approval was withdrawn/);
});

// --- The record ----------------------------------------------------------------------------------------------------------------------------

test('the audit is permanent, append-only, readable after a restart, and a merge that cannot be recorded does not happen', async (t) => {
  const r = rig(t);
  on(r);
  await ready(r);
  await r.merge.onQa();
  const file = path.join(r.dir, 'merge-audit.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 5);
  assert.ok(lines.every((l) => JSON.parse(l).repo === 'o/r' && typeof JSON.parse(l).at === 'number'));
  assert.ok(!/token|password|secret|credential/i.test(readFileSync(file, 'utf8')), 'nothing sensitive in it');
  const before = readFileSync(file, 'utf8');
  r.merge.stop('Ada');
  assert.ok(readFileSync(file, 'utf8').startsWith(before), 'only ever appended to');
  assert.equal(new FloorMergeStore(r.dir).recent(1000).length, r.audit().length);
  assert.ok(r.merge.state().audit.length > 0, 'and shown to the floor');
  // The record cannot be written (its path is a folder): no attempt, so no merge.
  const broken = tmp('broken-floor');
  mkdirSync(path.join(broken, 'merge-audit.jsonl'));
  const b = rig(t, { dir: broken });
  b.policy.set('o/r', { mode: 'auto', method: 'squash', bases: ['main'], maxChangedLines: 300, maxFiles: 20, extraLowRisk: [], authorization: 'HQ governance PR #123', authorizedBy: 'Owner', authorizedAt: 1 });
  await ready(b);
  await assert.rejects(b.merge.attempt(7), /audit file could not be written/);
  assert.equal(b.ops.merges.length, 0);
});

test('the merge code cannot bypass, force, change settings, wait on a timer or call a model', () => {
  const dir = path.join(import.meta.dirname, '..', 'src');
  const files = ['server/merge/service.ts', 'server/merge/store.ts', 'server/merge/gate.ts', 'server/gh-merge.ts', 'shared/merge.ts', 'server/ws/handlers/merge.ts'];
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    assert.ok(!/--admin|--auto\b|--force|--delete-branch|push -f|--no-verify/.test(src), `${file}: a bypass`);
    assert.ok(!/\b(setInterval|setTimeout|child_process|execFile|spawn|fetch)\b/.test(src), `${file}: a timer, process or network call`);
    assert.ok(!/anthropic|openai|\bmodels?\b/i.test(src), `${file}: a model`);
    assert.ok(!/['"`](PUT|PATCH|DELETE)['"`]|--method|protection['"`]\s*,\s*['"`]--/.test(src), `${file}: a write to repository settings`);
  }
  const names = readdirSync(path.join(dir, 'server', 'merge')).sort();
  assert.deepEqual(names, ['gate.ts', 'service.ts', 'store.ts']);
  assert.ok(statSync(path.join(dir, 'server', 'gh-merge.ts')).isFile());
});
