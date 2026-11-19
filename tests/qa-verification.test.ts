import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { PullExtra, ShaChecks } from '../src/server/gh-checks.js';
import { GitHub } from '../src/server/github.js';
import { officeWorkers } from '../src/server/hooks/office-workers.js';
import { QaService, type QaFloor, type QaGitHub } from '../src/server/qa/service.js';
import { QaStore } from '../src/server/qa/store.js';
import { TaskQueue, type QueueEvents, type QueueWorkers } from '../src/server/queue.js';
import { qaHandlers } from '../src/server/ws/handlers/qa.js';
import { assess, riskOf, FILES_SEEN_MAX, type Inputs, type PrFacts } from '../src/shared/qa.js';
import type { GhCheck, GhPull, QaEvidence, QaViewState, WorkerInfo } from '../src/shared/protocol.js';

// PR verification: where a pull request stands, what counts as a review of it, and who may give one.

const root = mkdtempSync(path.join(tmpdir(), 'ao-qa-'));
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
const pass = (name = 'CI / test'): GhCheck => ({ name, state: 'pass', url: `https://ci.example/${encodeURIComponent(name)}` });
const check = (name: string, state: GhCheck['state']): GhCheck => ({ name, state });

// --- The pure standing ------------------------------------------------------------------------------------------------------------

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ number: 7, title: 'Fix it', url: 'https://github.com/o/r/pull/7', author: 'bot', sha: SHA1, base: 'main', draft: false, mergeable: 'MERGEABLE', fork: false, files: ['src/a.ts'], checks: [pass()], updatedAt: '', ...over });
const inputs = (over: Partial<Inputs> = {}): Inputs => ({ required: ['test'], requiredKnown: true, evidence: [], authors: { known: true, ids: ['author'], names: ['Author'], providers: ['claude'] }, ...over });
const ev = (over: Partial<QaEvidence> = {}): QaEvidence => ({ id: 'e1', pr: 7, sha: SHA1, kind: 'worker', verdict: 'approve', summary: 'ok', at: 1, reviewerId: 'rev', reviewerName: 'Rev', reviewerProvider: 'codex', ...over });
const confirmed = (sha = SHA1, checks = [pass()]) => ({ sha, checks });

test('checks decide where a pull request starts: failed, pending, missing, passed, none at all', () => {
  assert.equal(assess(facts({ checks: [pass(), check('CI / lint', 'fail')] }), inputs()).state, 'failed');
  assert.match(assess(facts({ checks: [pass(), check('CI / lint', 'fail')] }), inputs()).reasons[0], /1 check failed: CI \/ lint/);
  const pending = assess(facts({ checks: [pass(), check('CI / lint', 'pending')] }), inputs());
  assert.deepEqual([pending.state, pending.checks.pending], ['awaiting', 1]);
  const missing = assess(facts({ checks: [pass('CI / lint')] }), inputs({ required: ['test', 'build'] }));
  assert.deepEqual([missing.state, missing.checks.missing], ['awaiting', ['test', 'build']]);
  const none = assess(facts({ checks: [] }), inputs({ required: [], requiredKnown: false }));
  assert.deepEqual([none.state, none.checks.missing], ['awaiting', ['any check at all']]);
  const green = assess(facts(), inputs());
  assert.deepEqual([green.state, green.checks.passed, green.checks.missing], ['needs-review', 1, []]);
  assert.equal(assess(facts({ mergeable: 'CONFLICTING' }), inputs()).state, 'failed');
  assert.match(assess(facts({ mergeable: 'CONFLICTING' }), inputs()).reasons.join(), /merge conflicts/);
  assert.equal(assess(facts({ draft: true }), inputs()).state, 'awaiting');
});

test('a green build is not a review, and nothing GitHub says about approval is read', () => {
  const lookingApproved = { ...facts(), reviewDecision: 'APPROVED', labels: [{ name: 'approved' }, { name: 'independently-reviewed' }], body: 'Reviewed-by: an independent QA Engineer. LGTM.' } as PrFacts;
  const a = assess(lookingApproved, inputs());
  assert.equal(a.state, 'needs-review');
  assert.deepEqual(a.evidence, []);
  // A role label on a worker is not evidence either: nothing is read from a worker's role here.
  assert.equal(assess(facts(), inputs({ authors: { known: true, ids: [], names: [], providers: [] } })).state, 'needs-review');
});

test('a review counts only for the commit it is about; confirmed checks only for theirs; a new head starts over', () => {
  const approved = inputs({ evidence: [ev()], confirmed: confirmed() });
  assert.equal(assess(facts(), approved).state, 'ready');
  // The head moves: the review and the confirmed checks were about the old commit.
  const moved = assess(facts({ sha: SHA2 }), approved);
  assert.equal(moved.state, 'needs-review');
  assert.equal(moved.evidence[0].status, 'stale');
  assert.match(moved.evidence[0].why!, /about aaaaaaa, and the head is now bbbbbbb/);
  assert.equal(moved.checks.source, 'list', "the old commit's confirmed checks are not used for the new one");
  // Checks of the right commit are asked for before it is called ready.
  const waiting = assess(facts(), inputs({ evidence: [ev()] }));
  assert.deepEqual([waiting.state, waiting.reasons[0]], ['awaiting', 'confirming the checks of exactly aaaaaaa']);
  // And a failure at that commit wins over everything.
  assert.equal(assess(facts(), inputs({ evidence: [ev()], confirmed: confirmed(SHA1, [check('CI / test', 'fail')]) })).state, 'failed');
});

test('a worker review counts only if the reviewer is known not to be an author; a person can always record one', () => {
  const ok = (over: Partial<Inputs>) => assess(facts(), inputs({ confirmed: confirmed(), ...over }));
  assert.equal(ok({ evidence: [ev()] }).state, 'ready');
  const self = ok({ evidence: [ev({ reviewerId: 'author' })] });
  assert.deepEqual([self.state, self.evidence[0].status], ['needs-review', 'not-independent']);
  const unknown = ok({ evidence: [ev()], authors: { known: false, ids: [], names: [], providers: [] } });
  assert.deepEqual([unknown.state, unknown.evidence[0].status], ['needs-review', 'unverifiable']);
  assert.match(unknown.reasons.join(), /a person has to record it/);
  assert.equal(ok({ evidence: [ev(), ev({ id: 'h', kind: 'human', reviewerId: undefined, by: 'Ada' })], authors: { known: false, ids: [], names: [], providers: [] } }).state, 'ready');
  assert.equal(ok({ evidence: [ev({ verdict: 'changes' })] }).state, 'blocked');
  assert.equal(ok({ evidence: [ev({ verdict: 'comment' })] }).state, 'needs-review');
  assert.equal(ok({ evidence: [ev()] }).evidence[0].crossProvider, true, 'codex reviewing claude work is cross-provider');
  assert.equal(ok({ evidence: [ev({ reviewerProvider: 'claude' })] }).evidence[0].crossProvider, false);
});

test('what a change touches: workflows, installs, dependencies, security and unseen files need a person; sources, tests and docs do not', () => {
  assert.deepEqual(riskOf(['src/a.ts', 'tests/a.test.ts', 'docs/x.md']).sort(), ['docs', 'source', 'tests']);
  assert.ok(riskOf(['.github/workflows/ci.yml']).includes('ci-workflow'));
  assert.ok(riskOf(['install.sh']).includes('install'));
  assert.ok(riskOf(['package-lock.json']).includes('dependencies'));
  assert.ok(riskOf(['src/server/signins.ts']).includes('security'));
  assert.deepEqual(riskOf(undefined), ['unknown']);
  assert.ok(riskOf(Array.from({ length: FILES_SEEN_MAX }, (_, i) => `src/f${i}.ts`)).includes('unknown'), 'a cut-off file list is not trusted');
  const approved = (files: string[], fork = false) => assess(facts({ files, fork }), inputs({ evidence: [ev()], confirmed: confirmed() }));
  assert.equal(approved(['docs/x.md']).state, 'ready');
  const wf = approved(['.github/workflows/release.yml']);
  assert.deepEqual([wf.state, wf.needsHuman], ['blocked', true]);
  assert.match(wf.reasons[0], /changes CI workflows.*a person has to review it/);
  assert.equal(approved(['src/a.ts'], true).state, 'blocked', 'a pull request from a fork');
  const human = assess(facts({ files: ['.github/workflows/release.yml'] }), inputs({ evidence: [ev({ id: 'h', kind: 'human', reviewerId: undefined, by: 'Ada' })], confirmed: confirmed() }));
  assert.equal(human.state, 'ready', "a person's own review is what the rule asks for");
  assert.equal(assess(facts({ files: ['.github/workflows/release.yml'], checks: [check('CI / test', 'fail')] }), inputs()).state, 'failed', 'a failure is still a failure first');
});

// --- The service on a floor --------------------------------------------------------------------------------------------------------

const pull = (n: number, over: Partial<GhPull> = {}): GhPull => ({ number: n, title: `PR ${n}`, state: 'OPEN', isDraft: false, url: `https://github.com/o/r/pull/${n}`, author: 'the-shared-bot', labels: [], reviewDecision: '', headRefName: `feature-${n}`, headRefOid: SHA1, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 1, deletions: 0, checks: 'pass', body: '', closes: [], ...over });

class FakeGh implements QaGitHub {
  pulls = { items: [] as GhPull[] };
  extra = new Map<number, PullExtra>();
  required: string[] | null = ['test'];
  shaCalls: string[] = [];
  /** Heads GitHub already has that the last sync has not seen; and whether asking fails. */
  live = new Map<number, string>();
  headError = false;
  async pullHead(n: number) {
    if (this.headError) throw new Error('offline');
    return this.live.get(n) ?? this.pulls.items.find((p) => p.number === n)?.headRefOid ?? '';
  }
  /** What GitHub says about a commit asked for by its SHA. */
  bySha = new Map<string, ShaChecks>();
  extras(n: number) {
    return this.extra.get(n);
  }
  async requiredChecks() {
    return this.required;
  }
  async shaChecks(sha: string) {
    this.shaCalls.push(sha);
    return this.bySha.get(sha) ?? { sha, checks: [pass('test')], exact: true, at: Date.now() };
  }
  /** One open pull request with its extras. */
  open(p: GhPull, extra: Partial<PullExtra> = {}) {
    this.pulls.items = [...this.pulls.items.filter((x) => x.number !== p.number), p];
    this.extra.set(p.number, { sha: p.headRefOid!, mergeable: 'MERGEABLE', mergeState: 'CLEAN', files: ['src/a.ts'], fork: false, checks: [pass()], ...extra });
  }
}

let n = 0;
function worker(over: Partial<WorkerInfo> & { name: string }): WorkerInfo {
  return { id: `w${String(++n).padStart(11, '0')}`, kind: 'agent', provider: 'claude', role: 'qa-engineer', color: '#fff', status: 'idle', acked: true, createdBy: 't', createdAt: 1000, deskId: `desk-${n}`, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over };
}

interface Rig {
  qa: QaService;
  gh: FakeGh;
  workers: WorkerInfo[];
  queue: TaskQueue;
  prompts: { id: string; text: string }[];
  emitted: QaViewState[];
  toasts: string[];
  spawned: number;
  dir: string;
}

function rig(t: { after(fn: () => void): void }, workers: WorkerInfo[] = [], dir = tmp('floor')): Rig {
  const r = { workers, prompts: [], emitted: [], toasts: [], spawned: 0, gh: new FakeGh(), dir } as unknown as Rig;
  const qworkers: QueueWorkers = { defaultProvider: 'claude', list: () => workers, deskOccupied: (d) => workers.some((w) => w.deskId === d), spawn: () => (r.spawned++, 'the test does not hire'), kill: async () => ({}) };
  const events: QueueEvents = { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} };
  r.queue = new TaskQueue(dir, qworkers, false, events);
  t.after(() => r.queue.shutdown());
  const floor = { id: 'f1', dir, def: { name: 'Floor' }, workers: { list: () => workers, get: (id: string) => workers.find((w) => w.id === id), ownerOf: () => undefined, prompt: (id: string, text: string) => (r.prompts.push({ id, text }), undefined) }, queue: r.queue, github: r.gh } as unknown as QaFloor;
  r.qa = new QaService(dir, floor, () => ({ floors: () => [floor], planLimits: () => ({ windows: [], at: 0 }) }), r.gh, { emit: (s) => r.emitted.push(s), toast: (x) => r.toasts.push(x) });
  return r;
}
const stateOf = (r: Rig, num: number) => r.qa.state().prs.find((p) => p.number === num)!;

test('each sync recomputes where every open pull request stands; a settled commit is asked about once', async (t) => {
  const r = rig(t);
  r.gh.open(pull(1));
  r.gh.open(pull(2), { checks: [check('CI / test', 'fail')] });
  r.gh.open(pull(3), { checks: [check('CI / test', 'pending')] });
  r.gh.open(pull(4), { mergeable: 'CONFLICTING' });
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual(r.qa.state().prs.map((p) => [p.number, p.state]), [[1, 'needs-review'], [2, 'failed'], [3, 'awaiting'], [4, 'failed']]);
  assert.equal(r.qa.state().policy.merge, 'human');
  assert.equal(r.qa.state().policy.autoReview, false);
  assert.deepEqual(r.gh.shaCalls, [], 'no review yet, so nobody needs the exact-commit checks');
  const before = r.emitted.length;
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(r.emitted.length, before, 'nothing changed, so nothing is sent');
});

test('ready needs the checks of exactly the reviewed commit, asked of GitHub once and kept; a new head asks again', async (t) => {
  const tutor = worker({ name: 'Rev', role: 'reviewer', provider: 'codex' });
  const r = rig(t, [tutor]);
  r.gh.open(pull(1));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(r.qa.attest(1, SHA1, 'approve', 'QA-1', 'looked', 'Ada').ok, true);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(stateOf(r, 1).state, 'ready');
  assert.deepEqual(r.gh.shaCalls, [SHA1]);
  assert.equal(r.toasts.filter((x) => /PR #1 is ready/.test(x)).length, 1);
  await r.qa.onPulls(r.gh.pulls.items);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual(r.gh.shaCalls, [SHA1], 'its checks were all done: GitHub is not asked again');
  assert.equal(r.toasts.filter((x) => /ready/.test(x)).length, 1, 'said once');
  // The head moves: the review is stale, the old confirmation is not reused, and nothing is ready.
  r.gh.open(pull(1, { headRefOid: SHA2 }));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 1).state, stateOf(r, 1).evidence[0].status], ['needs-review', 'stale']);
  assert.equal(r.qa.attest(1, SHA1, 'approve', undefined, undefined, 'Ada').ok, false, 'a review of the old commit cannot be recorded now');
  assert.equal(r.qa.attest(1, SHA2, 'approve', undefined, undefined, 'Ada').ok, true);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual(r.gh.shaCalls, [SHA1, SHA2]);
  assert.equal(stateOf(r, 1).state, 'ready');
});

test('checks that do not all belong to the reviewed commit, or fail there, never make it ready', async (t) => {
  const r = rig(t);
  r.gh.open(pull(1));
  await r.qa.onPulls(r.gh.pulls.items);
  // GitHub is asked as soon as a review is recorded, so what it will say is set first.
  r.gh.bySha.set(SHA1, { sha: SHA1, checks: [pass('test')], exact: false, at: 1 });
  r.qa.attest(1, SHA1, 'approve', undefined, undefined, 'Ada');
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(stateOf(r, 1).state, 'awaiting', 'a check run for another commit is not this one');
  r.gh.bySha.set(SHA1, { sha: SHA1, checks: [check('test', 'fail')], exact: true, at: 2 });
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(stateOf(r, 1).state, 'failed');
});

test('a worker that did the work, known by its branch and remembered after it goes home, cannot review it', async (t) => {
  const author = worker({ name: 'Author', role: 'qa-engineer', worktree: { path: 'wt', branch: 'feature-1', base: 'x' } });
  const other = worker({ name: 'Other', role: 'qa-engineer' });
  const reviewer = worker({ name: 'Reviewer', role: 'reviewer', provider: 'codex' });
  const r = rig(t, [author, other, reviewer]);
  r.gh.open(pull(1));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 1).authors, stateOf(r, 1).authorsKnown], [['Author'], true]);
  const offer = r.qa.offer(1);
  assert.ok(typeof offer !== 'string');
  assert.deepEqual(offer.candidates.map((c) => c.name).sort(), ['Other', 'Reviewer']);
  assert.match(offer.blocked.find((b) => b.name === 'Author')!.reasons[0], /did this work, and cannot review it/);
  assert.deepEqual(r.qa.assign(1, SHA1, author.id, 'Ada').ok, false);
  assert.match(r.qa.assign(1, SHA1, author.id, 'Ada').message, /did this work/);
  assert.deepEqual(r.prompts, []);
  // Even after the author goes home, its record stays: the queue task and the remembered authors say who it was.
  r.workers.splice(r.workers.indexOf(author), 1);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual(stateOf(r, 1).authors, ['Author'], 'remembered');
  const again = r.qa.offer(1);
  assert.ok(typeof again !== 'string' && !again.candidates.some((c) => c.name === 'Author'));
  // A pull request nobody here wrote cannot show a worker's review independent.
  r.gh.open(pull(2, { headRefName: 'from-a-person' }));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 2).authorsKnown, stateOf(r, 2).authors], [false, []]);
  assert.equal(r.qa.assign(2, SHA1, other.id, 'Ada').ok, true);
  assert.equal((await r.qa.submit(other.id, 2, SHA1, 'approve', 'fine')).ok, true);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 2).state, stateOf(r, 2).evidence[0].status], ['needs-review', 'unverifiable']);
  r.qa.attest(2, SHA1, 'approve', 'qa-20261119-xxxxxx', 'imported verdict', 'Ada');
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(stateOf(r, 2).state, 'ready');
});

test('a review goes to an idle QA Engineer or Reviewer of this floor, through dispatch: never a busy one, never hired', async (t) => {
  const busy = worker({ name: 'Busy', status: 'working' });
  const dev = worker({ name: 'Dev', role: 'developer' });
  const free = worker({ name: 'Free', role: 'qa-engineer' });
  const r = rig(t, [busy, dev, free]);
  r.gh.open(pull(1));
  await r.qa.onPulls(r.gh.pulls.items);
  const offer = r.qa.offer(1);
  assert.ok(typeof offer !== 'string');
  assert.deepEqual(offer.candidates.map((c) => c.name), ['Free']);
  assert.match(offer.blocked.find((b) => b.name === 'Busy')!.reasons.join(), /working on something else/);
  assert.match(offer.blocked.find((b) => b.name === 'Dev')!.reasons.join(), /not a QA Engineer or a Reviewer/);
  for (const w of [busy, dev]) assert.equal(r.qa.assign(1, SHA1, w.id, 'Ada').ok, false, w.name);
  assert.equal(r.qa.assign(1, 'c'.repeat(40), free.id, 'Ada').ok, false, 'a look at a different commit is refused');
  const done = r.qa.assign(1, SHA1, free.id, 'Ada');
  assert.deepEqual(done, { ok: true, message: `Ada gave the review of PR #1 (${SHA1.slice(0, 7)}) to Free` });
  assert.equal(r.spawned, 0);
  assert.equal(r.prompts.length, 1);
  assert.deepEqual(r.prompts[0].id, free.id);
  assert.match(r.prompts[0].text, new RegExp(`exactly commit ${SHA1}`));
  assert.match(r.prompts[0].text, /office-workers review-submit --pr 1 --sha a{40}/);
  assert.match(r.prompts[0].text, /a comment is not evidence here/);
  assert.match(r.prompts[0].text, /Do not merge, push, approve or comment on GitHub/);
  const task = r.queue.state().tasks[0];
  assert.deepEqual([task.status, task.workerId, task.assigned?.by, task.title], ['running', free.id, 'Ada', `Review PR #1 @ ${SHA1.slice(0, 7)}`]);
  assert.equal(stateOf(r, 1).assigned?.workerName, 'Free');
  // No second review of the same commit while one is out, and none once one counts.
  assert.match(r.qa.assign(1, SHA1, free.id, 'Ada').message, /already has the review of this commit/);
  const second = r.qa.offer(1);
  assert.ok(typeof second !== 'string' && second.candidates.length === 0);
  assert.match(second.pending ?? '', /Nobody was hired/);
});

test('only the worker given a review can report it, once, for that commit, as itself', async (t) => {
  const reviewer = worker({ name: 'Reviewer', role: 'reviewer', provider: 'codex' });
  const bystander = worker({ name: 'Bystander', role: 'reviewer' });
  const second = worker({ name: 'Second', role: 'reviewer' });
  const r = rig(t, [reviewer, bystander, second]);
  r.gh.open(pull(1));
  r.gh.open(pull(2, { headRefName: 'feature-2' }));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(r.qa.assign(1, SHA1, reviewer.id, 'Ada').ok, true);
  assert.match((await r.qa.submit(bystander.id, 1, SHA1, 'approve', 'I say so')).message, /only the worker a person gave it to/);
  assert.match((await r.qa.submit(reviewer.id, 2, SHA1, 'approve', 'wrong pr')).message, /not given the review of PR #2/);
  assert.match((await r.qa.submit(reviewer.id, 1, SHA2, 'approve', 'wrong commit')).message, /not recorded/);
  assert.match((await r.qa.submit(reviewer.id, 1, SHA1, 'lgtm', '')).message, /verdict is approve, changes or comment/);
  assert.equal(r.qa.store.evidence.length, 0, 'none of that was recorded');
  assert.equal((await r.qa.submit(reviewer.id, 1, SHA1, 'approve', 'checked the diff')).ok, true);
  assert.match((await r.qa.submit(reviewer.id, 1, SHA1, 'approve', 'again')).message, /only the worker a person gave it to/);
  const e = r.qa.store.evidence[0];
  assert.deepEqual([e.kind, e.reviewerId, e.reviewerName, e.reviewerProvider, e.sha], ['worker', reviewer.id, 'Reviewer', 'codex', SHA1]);
});

test('a pull request that changes during review: the diff is pinned to the commit, the head is checked before and after, and a verdict about a commit that is no longer the head is rejected', async (t) => {
  const author = worker({ name: 'Author', role: 'developer', worktree: { path: 'w', branch: 'feature-1', base: 'x' } });
  const first = worker({ name: 'First', role: 'reviewer' });
  const second = worker({ name: 'Second', role: 'qa-engineer' });
  const r = rig(t, [author, first, second]);
  r.gh.open(pull(1));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.equal(r.qa.assign(1, SHA1, first.id, 'Ada').ok, true);
  // What the reviewer is told: a diff of exactly that commit, and the head checked before and after. Never the moving pull request.
  const text = r.prompts[0].text;
  assert.ok(text.includes(`gh api -H "Accept: application/vnd.github.diff" repos/{owner}/{repo}/compare/main...${SHA1}`), 'the diff is of the pinned commit');
  assert.equal(text.split('gh pr view 1 --json headRefOid --jq .headRefOid').length - 1, 2, 'the head is checked before and after');
  assert.ok(!/gh pr diff 1\b|gh pr checkout 1\b/.test(text), 'no command that follows the moving head');
  assert.match(text, /Do not use \`gh pr diff\` or \`gh pr checkout\`/);
  // While the reviewer works, the author pushes: GitHub's head moves, and the office has not even synced yet.
  r.gh.live.set(1, SHA2);
  const late = await r.qa.submit(first.id, 1, SHA1, 'approve', 'looked fine');
  assert.equal(late.ok, false);
  assert.match(late.message, /The head moved to bbbbbbb while you reviewed aaaaaaa/);
  assert.match(late.message, /needs a review of its own/);
  assert.equal(r.qa.store.evidence.length, 0, 'the verdict was not recorded, not even as stale evidence');
  assert.equal(r.qa.store.assignments[0].closed, 'stale');
  assert.match((await r.qa.submit(first.id, 1, SHA1, 'approve', 'again')).message, /only the worker a person gave it to/, 'and it cannot be answered again');
  // Once the sync sees the new head, the pull request needs a review of the new commit, and a fresh one can be asked for.
  r.gh.open(pull(1, { headRefOid: SHA2 }));
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 1).state, stateOf(r, 1).evidence.length, stateOf(r, 1).assigned], ['needs-review', 0, undefined]);
  const offer = r.qa.offer(1);
  assert.ok(typeof offer !== 'string' && offer.sha === SHA2 && offer.candidates.some((c) => c.name === 'Second'));
  assert.equal(r.qa.assign(1, SHA2, second.id, 'Ada').ok, true);
  assert.ok(r.prompts[1].text.includes(`compare/main...${SHA2}`), 'the new review is pinned to the new commit');
  // The reviewer of the old commit cannot be heard about the new one, and the new reviewer's verdict counts while the head stays.
  assert.equal((await r.qa.submit(second.id, 1, SHA1, 'approve', 'wrong commit')).ok, false);
  assert.equal((await r.qa.submit(second.id, 1, SHA2, 'approve', 'checked it')).ok, true);
  await r.qa.onPulls(r.gh.pulls.items);
  assert.deepEqual([stateOf(r, 1).state, stateOf(r, 1).evidence[0].status], ['ready', 'counts']);
  assert.deepEqual(r.gh.shaCalls, [SHA2], "only the reviewed commit's checks were asked for");
  // If GitHub cannot say what the head is, nothing is recorded and the review stays open to be reported again.
  r.gh.open(pull(2));
  await r.qa.onPulls(r.gh.pulls.items);
  const third = worker({ name: 'Third', role: 'reviewer' });
  r.workers.push(third);
  assert.equal(r.qa.assign(2, SHA1, third.id, 'Ada').ok, true);
  r.gh.headError = true;
  assert.match((await r.qa.submit(third.id, 2, SHA1, 'approve', 'x')).message, /could not confirm PR #2's head/);
  assert.equal(r.qa.store.evidence.filter((e) => e.pr === 2).length, 0);
  r.gh.headError = false;
  assert.equal((await r.qa.submit(third.id, 2, SHA1, 'approve', 'x')).ok, true);
});

test('reviews, assignments and who did the work survive a restart; a damaged file is not trusted', async (t) => {
  const dir = tmp('persist');
  const a = rig(t, [worker({ name: 'Author', worktree: { path: 'w', branch: 'feature-1', base: 'x' } })], dir);
  a.gh.open(pull(1));
  await a.qa.onPulls(a.gh.pulls.items);
  a.qa.attest(1, SHA1, 'approve', 'ref', 'ok', 'Ada');
  const b = new QaStore(dir);
  assert.deepEqual([b.evidence.length, b.evidence[0].by, b.authors.get(1)?.names], [1, 'Ada', ['Author']]);
  writeFileSync(path.join(dir, 'qa.json'), JSON.stringify({ evidence: [{ id: 'x', pr: 1, sha: 'not a sha', verdict: 'approve', kind: 'human' }, { id: 'y', pr: 1, sha: SHA1, verdict: 'approve', kind: 'robot' }], assignments: 7 }));
  assert.equal(new QaStore(dir).evidence.length, 0, 'entries that are not what they should be are dropped');
  writeFileSync(path.join(dir, 'qa.json'), '{ not json');
  assert.equal(new QaStore(dir).evidence.length, 0);
});

// --- Who may do what, and where ---------------------------------------------------------------------------------------------------------

function fakeCtx(r: Rig, other: Rig | undefined, accountId: string | undefined) {
  const sent: unknown[] = [];
  const floors = new Map<string, { qa: QaService }>([['f1', { qa: r.qa }], ...(other ? ([['f2', { qa: other.qa }]] as const) : [])]);
  const ctx = { floorOf: (c: { peer: { floor: string } }) => floors.get(c.peer.floor), meOf: (id?: string) => ({ admin: id === 'admin' }), sendTo: (_c: unknown, m: unknown) => void sent.push(m), warn() {}, toastFloor() {} };
  return { ctx, sent, client: { accountId, peer: { name: 'Ada', floor: 'f1' } } };
}

test('everyone on a floor can look; giving a review and recording one are admins; another floor is out of reach', async (t) => {
  const free = worker({ name: 'Free', role: 'reviewer' });
  const r = rig(t, [free]);
  const other = rig(t, [worker({ name: 'Elsewhere', role: 'reviewer' })]);
  r.gh.open(pull(1));
  other.gh.open(pull(9));
  await r.qa.onPulls(r.gh.pulls.items);
  await other.qa.onPulls(other.gh.pulls.items);
  const h = qaHandlers as unknown as Record<string, (c: unknown, cl: unknown, m: unknown) => void>;
  const member = fakeCtx(r, other, 'member');
  h['qa.state'](member.ctx, member.client, { t: 'qa.state' });
  assert.deepEqual((member.sent[0] as { state: QaViewState }).state.prs.map((p) => p.number), [1], "this floor's pull requests only");
  h['qa.reviewers'](member.ctx, member.client, { t: 'qa.reviewers', pr: 1 });
  assert.equal((member.sent[1] as { t: string }).t, 'qa.reviewers');
  h['qa.reviewers'](member.ctx, member.client, { t: 'qa.reviewers', pr: 9 });
  assert.deepEqual(member.sent[2], { t: 'qa.result', pr: 9, ok: false, message: 'No open pull request #9 on this floor' });
  h['qa.assign'](member.ctx, member.client, { t: 'qa.assign', pr: 1, sha: SHA1, workerId: free.id });
  h['qa.attest'](member.ctx, member.client, { t: 'qa.attest', pr: 1, sha: SHA1, verdict: 'approve' });
  assert.deepEqual([member.sent[3], member.sent[4]].map((m) => (m as { message: string }).message), ['Only admins can give a review to a worker', 'Only admins can record a review']);
  assert.deepEqual([r.prompts.length, r.qa.store.evidence.length], [0, 0]);
  const guest = fakeCtx(r, other, undefined);
  h['qa.attest'](guest.ctx, guest.client, { t: 'qa.attest', pr: 1, sha: SHA1, verdict: 'approve' });
  assert.equal((guest.sent[0] as { ok: boolean }).ok, false);
  const admin = fakeCtx(r, other, 'admin');
  h['qa.attest'](admin.ctx, admin.client, { t: 'qa.attest', pr: 9, sha: SHA1, verdict: 'approve' });
  assert.equal((admin.sent[0] as { ok: boolean }).ok, false, "even an admin on this floor cannot record a review of another floor's pull request");
  h['qa.attest'](admin.ctx, admin.client, { t: 'qa.attest', pr: 1, sha: SHA1, verdict: 'approve', reference: 'qa-1' });
  h['qa.assign'](admin.ctx, admin.client, { t: 'qa.assign', pr: 1, sha: SHA1, workerId: free.id });
  assert.deepEqual([admin.sent[1], admin.sent[2]].map((m) => (m as { ok: boolean }).ok), [true, true]);
  assert.equal(other.prompts.length, 0);
});

async function call(ctx: unknown, me: { id: string; token: string }, body: unknown): Promise<{ status: number; json: any }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', headers: { authorization: `Bearer ${me.token}` } }) as unknown as http.IncomingMessage;
  const out = { status: 0, text: '' };
  const res = { writeHead: (s: number) => void (out.status = s), end: (b: string) => void (out.text = b) } as unknown as http.ServerResponse;
  await officeWorkers(ctx as never, req, res, new URL(`http://office.local/office/workers/review?worker=${me.id}`));
  return { status: out.status, json: out.text ? JSON.parse(out.text) : undefined };
}

test("a verdict reported over the worker route is the authenticated worker's own, whatever the body says", async () => {
  const seen: unknown[][] = [];
  const me = { id: 'w-real', name: 'Real', token: 'tok-real' };
  const floor = { workers: { authenticate: (id: string, token: string) => (id === me.id && token === me.token ? me : undefined) }, qa: { submit: (...a: unknown[]) => (seen.push(a), { ok: true, message: 'Recorded' }) }, queue: { state: () => ({ tasks: [] }) }, github: { pulls: { items: [] } } };
  const ctx = { workerFloor: (id: string) => (id === me.id ? floor : undefined), floors: new Map(), toastFloor: () => {}, limits: { state: { windows: [], at: 0 } } };
  const ok = await call(ctx, me, { pr: 7, sha: SHA1, verdict: 'approve', summary: 'fine', worker: 'someone-else', reviewer: 'the Chief of Staff', role: 'qa-engineer' });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen[0], ['w-real', 7, SHA1, 'approve', 'fine']);
  assert.equal((await call(ctx, { id: me.id, token: 'forged' }, { pr: 7, sha: SHA1, verdict: 'approve' })).status, 401);
  assert.equal((await call(ctx, me, { sha: SHA1, verdict: 'approve' })).status, 400);
  assert.equal(seen.length, 1);
});

// --- GitHub: read-only, and the exact commit ----------------------------------------------------------------------------------------------

test('what is asked of GitHub is read-only, keyed by commit, and kept; nothing merges, comments or reruns a check', async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const url = args[1] ?? '';
    if (url.includes('/check-runs')) return `${JSON.stringify({ name: 'test', status: 'completed', conclusion: 'success', detailsUrl: 'https://ci/1', sha: SHA1 })}\n${JSON.stringify({ name: 'lint', status: 'completed', conclusion: 'success', detailsUrl: 'https://ci/2', sha: SHA1 })}\n`;
    if (url.includes('/status')) return `${JSON.stringify({ context: 'external', state: 'success', targetUrl: 'https://ext/1' })}\n`;
    if (url.includes('required_status_checks')) return 'test\nlint\n';
    if (args[0] === 'pr') return '[]';
    return '';
  };
  const gh = new GitHub(tmp('gh'), () => {}, () => {}, run);
  const first = await gh.shaChecks(SHA1);
  assert.deepEqual([first.exact, first.checks.map((c) => [c.name, c.state])], [true, [['test', 'pass'], ['lint', 'pass'], ['external', 'pass']]]);
  await gh.shaChecks(SHA1);
  await Promise.all([gh.shaChecks(SHA2), gh.shaChecks(SHA2)]);
  assert.equal(calls.filter((c) => c[1].includes(SHA1)).length, 2, 'a finished commit is asked about once (a run list and a status list), not again');
  assert.equal(calls.filter((c) => c[1].includes(SHA2) && c[1].includes('check-runs')).length, 1, 'two asks at once make one question');
  assert.deepEqual(await gh.requiredChecks('feature/x'), ['test', 'lint']);
  await gh.requiredChecks('feature/x');
  assert.equal(calls.filter((c) => c[1]?.includes('required_status_checks')).length, 1);
  for (const c of calls) {
    assert.equal(c[0], 'api', `only reads: ${c.join(' ')}`);
    assert.ok(!c.some((a) => /^(--method|-X|-f|-F|--input)$/.test(a)), `no write flags: ${c.join(' ')}`);
    assert.ok(!/merge|review|comment|rerun|dispatches|\/runs\//.test(c.join(' ')), c.join(' '));
  }
  // A check run that belongs to another commit is not taken for this one.
  const odd = new GitHub(tmp('gh2'), () => {}, () => {}, async (args: string[]) => (args[1].includes('/check-runs') ? `${JSON.stringify({ name: 'test', status: 'completed', conclusion: 'success', sha: SHA2 })}\n` : ''));
  assert.equal((await odd.shaChecks(SHA1)).exact, false);
  // A repository that will not say what is required, or a login that may not ask, is not an error.
  const mute = new GitHub(tmp('gh3'), () => {}, () => {}, async () => { throw new Error('404'); });
  assert.equal(await mute.requiredChecks('main'), null);
});

test('the QA code cannot merge, push, comment, rerun or hire, and runs no timer and no model', () => {
  for (const file of ['src/shared/qa.ts', 'src/server/qa/service.ts', 'src/server/qa/store.ts', 'src/server/ws/handlers/qa.ts']) {
    const src = readFileSync(path.join(import.meta.dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.ok(!/child_process|worktree|workers\/manager|\.\.\/workers\.js$|deploy|(^|\/)prs?\.js$|merge|anthropic|openai/.test(m[1]), `${file} imports ${m[1]}`);
    assert.ok(!/\b(spawn|spawnSync|execFile|execFileSync|kill|sendHome|resume|mergePr|openPr|setInterval|setTimeout|fetch)\s*\(/.test(src), `${file} acts, waits or reaches out`);
    assert.ok(!/['"`](merge|push|--method|--admin|--auto|rerun)['"`]/.test(src), `${file} names a write`);
  }
});
