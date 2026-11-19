import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AGENT, confirm, inventory, preview, POLICY, type DispatchFloor, type DispatchOffice, type Viewer } from '../src/server/dispatch/dispatcher.js';
import { conservative, manual } from '../src/server/dispatch/extension.js';
import { subagentsOf } from '../src/server/dispatch/subagents.js';
import { officeWorkers } from '../src/server/hooks/office-workers.js';
import { TaskQueue, type QueueEvents, type QueueWorkers } from '../src/server/queue.js';
import { Ledger } from '../src/server/usage.js';
import { dispatchHandlers } from '../src/server/ws/handlers/dispatch.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { USAGE_BLOCK_PCT, classify, cleanNeeds, previewDispatch, type WorkerFacts } from '../src/shared/dispatch.js';
import { AGENT_PROVIDERS } from '../src/shared/providers.js';
import type { AgentProvider, PlanLimits, QueueTask, WorkerInfo, WorkerStatus } from '../src/shared/protocol.js';
import { WORKER_ROLES } from '../src/shared/worker-identity.js';

// Unified workforce inventory and role-aware, human-confirmed dispatch: what it may and may not do.

const root = mkdtempSync(path.join(tmpdir(), 'ao-dispatch-'));
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

// --- Fakes: a floor that is a real TaskQueue over a fake set of workers, and records everything done to it ---------------------

let n = 0;
function worker(over: Partial<WorkerInfo> & { name: string }): WorkerInfo {
  return { id: `w${String(++n).padStart(11, '0')}`, kind: 'agent', provider: 'claude', role: 'developer', color: '#fff', status: 'idle', acked: true, createdBy: 'test', createdAt: 1000, deskId: `desk-${n}`, cols: 80, rows: 24, viewers: [], viewerIds: [], ...over };
}

interface Fake {
  floor: DispatchFloor;
  queue: TaskQueue;
  workers: WorkerInfo[];
  /** Everything the dispatcher did to the workers' side. */
  calls: string[];
  prompts: { id: string; text: string }[];
  spawned: number;
}

function fakeFloor(t: { after(fn: () => void): void }, id: string, name: string, workers: WorkerInfo[], opts: { owners?: Record<string, string>; maxWorkers?: number; promptError?: string; defaultProvider?: AgentProvider; pulls?: { number: number; state: string; headRefName: string }[] } = {}): Fake {
  const fake: Fake = { floor: undefined as never, queue: undefined as never, workers, calls: [], prompts: [], spawned: 0 };
  const qworkers: QueueWorkers = {
    defaultProvider: opts.defaultProvider ?? 'claude',
    list: () => workers,
    deskOccupied: (d) => workers.some((w) => w.deskId === d),
    spawn: () => {
      fake.spawned++;
      return 'the test does not hire';
    },
    kill: async (wid) => {
      fake.calls.push(`kill ${wid}`);
      return {};
    },
  };
  const events: QueueEvents = { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} };
  const queue = new TaskQueue(tmp(`queue-${id}`), qworkers, false, events);
  if (opts.maxWorkers !== undefined) queue.setLimit(opts.maxWorkers);
  t.after(() => queue.shutdown());
  fake.queue = queue;
  fake.floor = {
    id,
    dir: tmp(`floor-${id}`),
    def: { name },
    workers: {
      list: () => workers,
      get: (wid) => workers.find((w) => w.id === wid),
      ownerOf: (wid) => opts.owners?.[wid],
      prompt: (wid, text) => {
        fake.calls.push(`prompt ${wid}`);
        fake.prompts.push({ id: wid, text });
        return opts.promptError;
      },
    },
    queue,
    github: { pulls: { items: (opts.pulls ?? []).map((p) => ({ ...p, title: '', isDraft: false, url: '', author: '', labels: [], reviewDecision: '', baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: 'none' as const, body: '', closes: [] })) } },
  };
  return fake;
}

const office = (floors: Fake[], limits: PlanLimits = { windows: [], at: 0 }): DispatchOffice => ({ floors: () => floors.map((f) => f.floor), planLimits: () => limits });
const held = (f: Fake, title = 'Fix the login redirect', provider: AgentProvider = 'claude', opts: { needs?: object; owner?: string } = {}) => {
  assert.equal(f.queue.add(`${title}: details`, 'Ada', title, undefined, provider, undefined, undefined, opts.owner, { hold: true, needs: opts.needs as never }), undefined);
  return f.queue.state().tasks.at(-1)!;
};
const ADMIN: Viewer = { admin: true };
const previewOf = (o: DispatchOffice, f: Fake, taskId: string, needs?: object, viewer: Viewer = ADMIN) => {
  const p = preview(o, f.floor, taskId, viewer, needs as never);
  assert.ok(typeof p !== 'string', String(p));
  return p;
};

// --- 1, 2: what the office keeps after a restart is what the inventory shows ---------------------------------------------------

const git = async () => {
  const { execFileSync } = await import('node:child_process');
  return (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
};

function realManager(rootDir: string, dataDir: string) {
  const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };
  const script = path.join(rootDir, 'agent.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  return new WorkerManager(rootDir, dataDir, process.execPath, [script], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(dataDir, { pauseHiring: false }, () => {}, () => {}));
}

test('workers saved by an older office, with missing or unknown roles, all appear after a restart, unchanged, and none is hired or moved', async (t) => {
  const dir = tmp('restart');
  (await git())(dir, 'init', '-q', '-b', 'main');
  const data = path.join(dir, '.agent-office');
  mkdirSync(data, { recursive: true });
  const first = realManager(dir, data);
  const a = first.spawn('desk-1', 'test', 'task a', false) as WorkerInfo;
  const b = first.spawn('desk-2', 'test', 'task b', false) as WorkerInfo;
  const c = first.spawn('desk-3', 'test', 'task c', false) as WorkerInfo;
  assert.ok(a.id && b.id && c.id);
  const before = Object.fromEntries([a, b, c].map((w) => [w.id, { name: w.name, desk: w.deskId, createdAt: w.createdAt }]));
  first.shutdown();
  // The file as an older office left it: one worker with no role at all, one with a role from a newer office.
  const file = path.join(data, 'workers.json');
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[];
  assert.equal(saved.length, 3);
  delete saved.find((s) => s.id === a.id)!.role;
  saved.find((s) => s.id === b.id)!.role = 'future-role';
  writeFileSync(file, JSON.stringify(saved));

  const second = realManager(dir, data);
  t.after(() => second.shutdown());
  const f: DispatchFloor = { id: 'f1', dir, def: { name: 'Floor' }, workers: second, queue: { state: () => ({ tasks: [], maxWorkers: 3 }), running: 0, limit: 3, assign: () => 'no' }, github: { pulls: { items: [] } } };
  const inv = inventory({ floors: () => [f], planLimits: () => ({ windows: [], at: 0 }) }, f, ADMIN);
  assert.deepEqual(inv.rows.map((r) => r.id).sort(), [a.id, b.id, c.id].sort(), 'every saved worker is listed');
  for (const r of inv.rows) assert.deepEqual({ name: r.name, desk: r.desk.replace('Desk ', 'desk-'), createdAt: second.get(r.id)!.createdAt }, { name: before[r.id].name, desk: before[r.id].desk, createdAt: before[r.id].createdAt }, 'identity unchanged');
  const row = (id: string) => inv.rows.find((r) => r.id === id)!;
  assert.equal(row(a.id).roleKnown, true, 'a worker with no role counts as the default one');
  assert.equal(row(a.id).roleLabel, 'General Worker');
  assert.equal(row(b.id).roleKnown, false);
  assert.equal(row(b.id).roleLabel, 'future-role', 'an unknown role shows as itself');
  assert.ok(inv.rows.every((r) => r.status === 'offline' && !r.assignable), 'restored workers are asleep: listed, not given tasks until someone resumes them');
  assert.ok(inv.rows.every((r) => r.blockedBy.some((why) => /asleep/.test(why))));
  // Reading the inventory changed no worker: the records on disk are what they were.
  const after = JSON.parse(readFileSync(file, 'utf8')) as { id: string; name: string; deskId: string }[];
  assert.deepEqual(after.map((s) => [s.id, s.name, s.deskId]).sort(), saved.map((s) => [s.id, s.name, s.deskId]).sort());
});

// --- 3: every provider can be represented ------------------------------------------------------------------------------------

test('a worker of every supported agent is listed with its own, and a task for that agent goes to it and not to the others', (t) => {
  const workers = AGENT_PROVIDERS.map((p) => worker({ name: `W-${p}`, provider: p, role: 'developer' }));
  // A floor started with a custom agent can queue for every agent; a plain one cannot queue for 'custom'.
  const f = fakeFloor(t, 'f1', 'Floor', workers, { defaultProvider: 'custom' });
  const o = office([f]);
  const inv = inventory(o, f.floor, ADMIN);
  assert.deepEqual(inv.rows.map((r) => r.provider), [...AGENT_PROVIDERS]);
  assert.ok(inv.rows.every((r) => r.seat === 'worker' && r.assignable));
  for (const p of AGENT_PROVIDERS) {
    const task = held(f, `for ${p}`, p);
    const pv = previewOf(o, f, task.id);
    assert.deepEqual(pv.candidates.map((c) => c.provider), [p], `${p}: only its own agent`);
    assert.equal(pv.blocked.length, AGENT_PROVIDERS.length - 1);
    f.queue.remove(task.id);
  }
  // Said to take any agent, all of them qualify.
  const any = held(f, 'anything');
  assert.equal(previewOf(o, f, any.id, { providers: [...AGENT_PROVIDERS] }).candidates.length, AGENT_PROVIDERS.length);
});

// --- 4: never reassign a busy worker; 5: an idle one takes an approved task; 11: nobody is hired ------------------------------

test('a busy worker is never reassigned; an idle one takes the task a person confirms; nobody is hired', (t) => {
  const busy = worker({ name: 'Busy', status: 'working' });
  const asking = worker({ name: 'Asking', status: 'needs_input' });
  const idle = worker({ name: 'Idle' });
  const f = fakeFloor(t, 'f1', 'Floor', [busy, asking, idle]);
  const o = office([f]);
  const task = held(f);
  const pv = previewOf(o, f, task.id);
  assert.deepEqual(pv.candidates.map((c) => c.name), ['Idle']);
  assert.deepEqual(pv.blocked.map((b) => b.name).sort(), ['Asking', 'Busy']);
  assert.match(pv.blocked.find((b) => b.name === 'Busy')!.reasons.join(' '), /working on something else/);
  // Asking for the busy one by name, as a stale page could, changes nothing.
  for (const w of [busy, asking]) {
    const r = confirm(o, f.floor, task.id, w.id, 'Ada');
    assert.equal(r.ok, false);
    assert.match(r.message, /cannot take it now/);
  }
  assert.deepEqual(f.prompts, []);
  assert.equal(f.queue.state().tasks[0].status, 'queued');
  // The idle one takes it, once.
  const done = confirm(o, f.floor, task.id, idle.id, 'Ada');
  assert.deepEqual(done, { ok: true, message: 'Ada gave “Fix the login redirect” to Idle' });
  assert.deepEqual(f.prompts, [{ id: idle.id, text: 'Fix the login redirect: details' }]);
  const t0 = f.queue.state().tasks[0];
  assert.equal(t0.status, 'running');
  assert.equal(t0.workerId, idle.id);
  assert.equal(t0.assigned?.by, 'Ada');
  assert.equal(f.spawned, 0, 'no worker was hired for it');
  assert.deepEqual(f.calls, [`prompt ${idle.id}`], 'the only thing done to a worker is the one prompt');
  // Now it is on a task: it is reserved, and a second task cannot go to it.
  const second = held(f, 'Second');
  assert.deepEqual(previewOf(o, f, second.id).candidates, []);
  assert.match(previewOf(o, f, second.id).pending ?? '', /Nobody was hired/);
  assert.equal(confirm(o, f.floor, second.id, idle.id, 'Ada').ok, false);
  assert.equal(f.spawned, 0);
});

test('with no suitable worker the task stays pending, says why, and nobody is hired, even with a free desk and an unheld queue limit', (t) => {
  const f = fakeFloor(t, 'f1', 'Floor', [worker({ name: 'Busy', status: 'working' }), worker({ name: 'Shell', kind: 'shell', provider: undefined, role: undefined })]);
  const task = held(f);
  const pv = previewOf(office([f]), f, task.id);
  assert.equal(pv.candidates.length, 0);
  assert.match(pv.pending ?? '', /^Waiting: none of the 2 workers on this floor can take it now/);
  assert.match(pv.pending ?? '', /Nobody was hired/);
  f.queue.pump();
  assert.equal(f.spawned, 0);
  assert.equal(f.queue.state().tasks[0].status, 'queued');
});

// --- 6: the wrong floor ---------------------------------------------------------------------------------------------------------

test("another floor's worker is excluded from the preview and out of reach of a confirm, whatever its role", (t) => {
  const mine = worker({ name: 'Mine', status: 'working' });
  const theirs = worker({ name: 'Theirs', role: 'qa-engineer' });
  const a = fakeFloor(t, 'a', 'Alpha', [mine]);
  const b = fakeFloor(t, 'b', 'Beta', [theirs]);
  const o = office([a, b]);
  const task = held(a, 'Verify the release', 'claude', { needs: { role: 'qa-engineer' } });
  const pv = previewOf(o, a, task.id);
  assert.equal(pv.candidates.length, 0);
  const why = pv.blocked.find((x) => x.name === 'Theirs')!;
  assert.equal(why.floorName, 'Beta');
  assert.match(why.reasons[0], /on Beta, and this task belongs to another floor/);
  const r = confirm(o, a.floor, task.id, theirs.id, 'Ada');
  assert.deepEqual(r, { ok: false, message: 'No such worker on this floor' });
  assert.deepEqual(b.prompts, []);
  assert.deepEqual(a.prompts, []);
  // The inventory lists both floors, each worker with its own floor.
  assert.deepEqual(inventory(o, a.floor, ADMIN).rows.map((r) => [r.name, r.floorName]), [['Mine', 'Alpha'], ['Theirs', 'Beta']]);
});

// --- 7: legacy and unknown roles ------------------------------------------------------------------------------------------------

test('a missing or unknown role does not break dispatch: such a worker is a general one, and fails only a task that asks for a role', (t) => {
  const legacy = worker({ name: 'Legacy', role: undefined });
  const future = worker({ name: 'Future', role: 'time-traveller' });
  const f = fakeFloor(t, 'f1', 'Floor', [legacy, future]);
  const o = office([f]);
  const open = held(f, 'Anything');
  assert.deepEqual(previewOf(o, f, open.id).candidates.map((c) => c.name), ['Legacy', 'Future']);
  assert.match(previewOf(o, f, open.id).candidates[1].reasons.join(' '), /not one this office knows, so it counts as a general worker/);
  const wants = held(f, 'Needs a QA', 'claude', { needs: { role: 'qa-engineer' } });
  const pv = previewOf(o, f, wants.id);
  assert.deepEqual(pv.candidates, []);
  assert.match(pv.blocked.find((b) => b.name === 'Future')!.reasons.join(' '), /a role this office does not know \(time-traveller\)/);
  assert.match(pv.blocked.find((b) => b.name === 'Legacy')!.reasons.join(' '), /needs a QA Engineer and it is General Worker/);
  const skilled = held(f, 'Needs tests', 'claude', { needs: { skills: ['test'] } });
  assert.deepEqual(previewOf(o, f, skilled.id).candidates, []);
  const row = inventory(o, f.floor, ADMIN).rows.find((r) => r.name === 'Future')!;
  assert.deepEqual([row.roleKnown, row.roleLabel, row.assignable], [false, 'time-traveller', true]);
});

// --- 8: board agents and the rest of what is not an ordinary worker -------------------------------------------------------------

test('board agents, shells and meeting seats are listed apart and are never given a task, however idle', (t) => {
  const board = ['station-issues', 'station-pulls', 'station-queue'].map((d, i) => worker({ name: `Board ${i}`, deskId: d, role: undefined, status: 'idle' }));
  const shell = worker({ name: 'Logs 🐚', kind: 'shell', provider: undefined, role: undefined, status: 'idle' });
  const seated = worker({ name: 'Seated', deskId: 'meeting-1', meeting: 'm1', status: 'idle' });
  const ordinary = worker({ name: 'Ordinary' });
  const f = fakeFloor(t, 'f1', 'Floor', [...board, shell, seated, ordinary]);
  const o = office([f]);
  const inv = inventory(o, f.floor, ADMIN);
  assert.deepEqual(inv.rows.filter((r) => r.seat !== 'worker').map((r) => r.seat), ['board-agent', 'board-agent', 'board-agent', 'shell', 'meeting-seat']);
  assert.ok(inv.rows.filter((r) => r.seat !== 'worker').every((r) => !r.assignable && r.availability === 'unavailable'));
  assert.deepEqual(inv.rows.filter((r) => r.assignable).map((r) => r.name), ['Ordinary']);
  const task = held(f);
  const pv = previewOf(o, f, task.id, { providers: [...AGENT_PROVIDERS] });
  assert.deepEqual(pv.candidates.map((c) => c.name), ['Ordinary']);
  for (const w of [...board, shell, seated]) assert.equal(confirm(o, f.floor, task.id, w.id, 'Ada').ok, false, w.name);
  assert.deepEqual(f.prompts, []);
});

test("a project's Claude subagents are listed as definitions, never as workers", (t) => {
  const f = fakeFloor(t, 'f1', 'Floor', [worker({ name: 'Real' })]);
  mkdirSync(path.join(f.floor.dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(f.floor.dir, '.claude', 'agents', 'code-reviewer.md'), '---\nname: code-reviewer\ndescription: "Reviews diffs"\ntools: Read\n---\nbody that is not read');
  writeFileSync(path.join(f.floor.dir, '.claude', 'agents', 'plain.md'), 'no front matter');
  const inv = inventory(office([f]), f.floor, ADMIN);
  assert.deepEqual(inv.subagents.map((s) => [s.name, s.description, s.file]), [['code-reviewer', 'Reviews diffs', '.claude/agents/code-reviewer.md'], ['plain', undefined, '.claude/agents/plain.md']]);
  assert.deepEqual(inv.rows.map((r) => r.name), ['Real']);
  assert.deepEqual(subagentsOf('x', path.join(root, 'no-such-folder')), []);
});

// --- 9: a role is not authorization -----------------------------------------------------------------------------------------------

const ROLE_VALUES = [...WORKER_ROLES.map((r) => r.id), undefined, 'future-role'];

test('changing a worker\'s role never makes it eligible for what it was not, and never un-blocks anything', (t) => {
  const outcomes = new Map<string, string>();
  for (const role of ROLE_VALUES) {
    // One worker per situation that excludes it; each gets the role under test.
    const cases: [string, Partial<WorkerInfo>, Record<string, string>?][] = [
      ['working', { status: 'working' }],
      ['asking', { status: 'needs_input' }],
      ['asleep', { status: 'offline' }],
      ['shell', { kind: 'shell', provider: undefined }],
      ['board', { deskId: 'station-queue' }],
      ['meeting', { meeting: 'm1' }],
      ['codex', { provider: 'codex' }],
      ['lost', { lost: { branch: 'gone' } }],
      ['free', {}],
    ];
    const here = cases.map(([label, over]) => worker({ name: label, role, ...over }));
    const f = fakeFloor(t, 'f1', 'Floor', here);
    const other = fakeFloor(t, 'f2', 'Other', [worker({ name: 'elsewhere', role })]);
    const o = office([f, other]);
    // A task that asks for exactly the role under test: matching it must open no door.
    const task = held(f, 'T', 'claude', { needs: role ? { role } : undefined });
    const pv = previewOf(o, f, task.id);
    outcomes.set(role ?? '(none)', JSON.stringify({ ok: pv.candidates.map((c) => c.name), blocked: pv.blocked.map((b) => b.name).sort() }));
    // The task-independent look is identical for every role value.
    const inv = inventory(o, f.floor, ADMIN);
    outcomes.set(`${role ?? '(none)'}/inventory`, JSON.stringify(inv.rows.map((r) => [r.name, r.availability, r.assignable])));
  }
  const inventories = [...outcomes].filter(([k]) => k.endsWith('/inventory')).map(([, v]) => v);
  assert.equal(new Set(inventories).size, 1, 'whether a worker is available never depends on its role');
  const previews = [...outcomes].filter(([k]) => !k.endsWith('/inventory')).map(([, v]) => v);
  // Whatever the role, the only worker that can take a task is the free one on this floor; matching the task's role added nobody.
  for (const p of previews) assert.deepEqual(JSON.parse(p).ok, ['free'], p);
});

test("a role can be changed to the one a task needs, and the worker is still refused for every other reason", (t) => {
  const busy = worker({ name: 'Busy', status: 'working', role: 'developer' });
  const f = fakeFloor(t, 'f1', 'Floor', [busy]);
  const o = office([f]);
  const task = held(f, 'Needs QA', 'claude', { needs: { role: 'qa-engineer' } });
  assert.equal(previewOf(o, f, task.id).candidates.length, 0);
  busy.role = 'qa-engineer'; // what ✏️ does; the office checks nothing else about it
  const pv = previewOf(o, f, task.id);
  assert.equal(pv.candidates.length, 0, 'the role now matches, the status still refuses');
  assert.deepEqual(pv.blocked[0].reasons, ['is working on something else']);
  assert.equal(confirm(o, f.floor, task.id, busy.id, 'Ada').ok, false);
  assert.deepEqual(f.prompts, []);
});

test('the account a worker runs on, its agent, a plan at its limit and the queue limit each refuse it, whatever its role', (t) => {
  const mine = worker({ name: 'Mine', role: 'qa-engineer' });
  const theirs = worker({ name: 'Theirs', role: 'qa-engineer' });
  const codex = worker({ name: 'Codex', role: 'qa-engineer', provider: 'codex' });
  const f = fakeFloor(t, 'f1', 'Floor', [mine, theirs, codex], { owners: { [theirs.id]: 'acct-2' }, maxWorkers: 1 });
  const spent: PlanLimits = { windows: [{ label: '5h session', pct: USAGE_BLOCK_PCT + 2 }], at: 1 };
  const task = held(f, 'QA it', 'claude', { needs: { role: 'qa-engineer' } });
  const pv = previewOf(office([f]), f, task.id);
  assert.deepEqual(pv.candidates.map((c) => c.name), ['Mine']);
  assert.match(pv.blocked.find((b) => b.name === 'Theirs')!.reasons.join(' '), /account's sign-ins, and the task was queued on the office's own/);
  assert.match(pv.blocked.find((b) => b.name === 'Codex')!.reasons.join(' '), /runs codex, and the task is for claude/);
  // Claude's plan is spent: Claude workers wait; the Codex one is not held back by Claude's plan.
  const limited = previewOf(office([f], spent), f, task.id);
  assert.deepEqual(limited.candidates, []);
  assert.match(limited.blocked.find((b) => b.name === 'Mine')!.reasons.join(' '), /5h session is 97% used/);
  assert.deepEqual(previewOf(office([f], spent), f, task.id, { providers: ['codex'], role: 'qa-engineer' }).candidates.map((c) => c.name), ['Codex']);
  // At the queue's own limit nothing can start.
  assert.equal(confirm(office([f]), f.floor, task.id, mine.id, 'Ada').ok, true);
  const next = held(f, 'Another');
  const full = previewOf(office([f]), f, next.id);
  assert.deepEqual(full.candidates, []);
  assert.match(full.pending ?? '', /the queue already has 1 of 1 tasks at work/);
});

test('an open pull request or a queue task keeps a worker reserved: its branch is not handed a second job', (t) => {
  const w = worker({ name: 'Owner', status: 'done', worktree: { path: 'wt', branch: 'office/owner-1', base: 'abc' } });
  const f = fakeFloor(t, 'f1', 'Floor', [w], { pulls: [{ number: 7, state: 'OPEN', headRefName: 'office/owner-1' }] });
  const o = office([f]);
  const task = held(f);
  assert.deepEqual(previewOf(o, f, task.id).candidates, []);
  assert.match(previewOf(o, f, task.id).blocked[0].reasons.join(' '), /its pull request #7 is still open/);
  assert.equal(inventory(o, f.floor, ADMIN).rows[0].availability, 'reserved');
  assert.equal(inventory(o, f.floor, ADMIN).rows[0].openPr, 7);
});

// --- ranking and the reasons ---------------------------------------------------------------------------------------------------

test('among eligible workers the best match comes first, with the reasons that decided it, the same way every time', () => {
  const base: Omit<WorkerFacts, 'id' | 'name'> = { floorId: 'f', floorName: 'F', seat: 'worker', provider: 'claude', role: 'developer', status: 'idle', desk: 'Desk 1', finishedTasks: 0, lastActiveAt: 100 };
  const w = (id: string, over: Partial<WorkerFacts>): WorkerFacts => ({ ...base, id, name: id, ...over });
  const workers = [
    w('general', { role: 'general-worker' }),
    w('qa-tired', { role: 'qa-engineer', finishedTasks: 4 }),
    w('qa-done', { role: 'qa-engineer', status: 'done' }),
    w('qa-fresh', { role: 'qa-engineer' }),
    w('qa-rested', { role: 'qa-engineer', lastActiveAt: 1 }),
  ];
  const task = { id: 't', title: 'T', floorId: 'f', provider: 'claude' as const, needs: { role: 'qa-engineer' } };
  const first = previewDispatch(task, workers, { usage: {} }, 5);
  assert.deepEqual(first.candidates.map((c) => c.name), ['qa-rested', 'qa-fresh', 'qa-tired', 'qa-done'], 'idle (a fresh prompt) before done (a conversation to carry), then the least used, then the most rested');
  assert.match(first.candidates[0].reasons[0], /its role is QA Engineer, as the task needs/);
  assert.deepEqual(previewDispatch(task, [...workers].reverse(), { usage: {} }, 5), first, 'the order they are listed in changes nothing');
  assert.deepEqual(first.blocked.map((b) => b.name), ['general']);
  // With no needs, every free worker qualifies and a prompt that skips the hiring is what is offered first.
  const open = previewDispatch({ ...task, needs: undefined }, workers, { usage: {} }, 5);
  assert.equal(open.candidates.length, 5);
});

test('needs read from the browser or queue.json are cleaned to what they should be', () => {
  assert.deepEqual(cleanNeeds({ role: 'qa-engineer', skills: ['test', 'Bad Skill', 5], providers: ['claude', 'nope'] }), { role: 'qa-engineer', skills: ['test'], providers: ['claude'] });
  assert.equal(cleanNeeds({ role: '../etc', skills: [], providers: [] }), undefined);
  assert.equal(cleanNeeds('qa'), undefined);
  assert.equal(classify({ id: 'a', name: 'a', floorId: 'f', floorName: 'F', seat: 'worker', status: 'idle', desk: 'd', finishedTasks: 0, lastActiveAt: 0 }).availability, 'available');
});

// --- the queue: held tasks, assigned workers, nobody sent home -------------------------------------------------------------

test('a held task is never hired for; a task that is not held still is, as before', (t) => {
  const f = fakeFloor(t, 'f1', 'Floor', []);
  assert.equal(f.queue.add('plain task', 'Ada', 'Plain'), undefined);
  assert.equal(f.spawned, 1, 'the queue hires for an ordinary task, as it always did');
  const task = held(f, 'Held');
  f.queue.pump();
  assert.equal(f.spawned, 1, 'a held task is skipped');
  assert.equal(f.queue.state().tasks.find((x) => x.id === task.id)!.status, 'queued');
  assert.equal(f.queue.setHold(task.id, false), undefined, 'releasing it is a person letting the queue hire');
  assert.equal(f.spawned, 2);
});

test('an assigned task does not finish while its worker is still at the prompt it was at, finishes when the worker does, and its worker is never sent home by the queue', (t) => {
  const w = worker({ name: 'Idle', status: 'done' });
  const f = fakeFloor(t, 'f1', 'Floor', [w]);
  const o = office([f]);
  const task = held(f);
  assert.equal(confirm(o, f.floor, task.id, w.id, 'Ada').ok, true);
  f.queue.pump();
  assert.equal(f.queue.state().tasks[0].status, 'running', "'done' before it started is not the end of the task");
  w.status = 'working';
  f.queue.onWorker(w);
  assert.equal(f.queue.state().tasks[0].engaged, true);
  w.status = 'done';
  f.queue.onWorker(w);
  const finished = f.queue.state().tasks[0];
  assert.deepEqual([finished.status, finished.outcome], ['done', 'done']);
  // No desk free and another task waiting: the queue recycles workers IT hired. This one was already there.
  f.queue.add('next', 'Ada', 'Next');
  f.queue.pump();
  assert.deepEqual(f.calls.filter((c) => c.startsWith('kill')), [], 'the worker that was already there is not sent home');
  assert.equal((f.queue as unknown as { recyclable(): unknown }).recyclable(), undefined, 'the queue would not send it home to make room either');
});

test('an assigned worker that stops, or never starts, ends the task as stopped and does not hang the queue', (t) => {
  const gone = worker({ name: 'Gone', status: 'idle' });
  const f = fakeFloor(t, 'f1', 'Floor', [gone]);
  const task = held(f);
  assert.equal(confirm(office([f]), f.floor, task.id, gone.id, 'Ada').ok, true);
  gone.status = 'exited';
  f.queue.onWorker(gone);
  assert.deepEqual([f.queue.state().tasks[0].status, f.queue.state().tasks[0].outcome], ['done', 'exited']);
  // One that stays at its prompt and never goes to work on it: stopped after the allowed time, with the reason.
  const stuck = worker({ name: 'Stuck', status: 'idle' });
  const g = fakeFloor(t, 'f2', 'Floor 2', [stuck]);
  const second = held(g);
  assert.equal(confirm(office([g]), g.floor, second.id, stuck.id, 'Ada').ok, true);
  (g.queue as unknown as { tasks: QueueTask[] }).tasks[0].startedAt = Date.now() - 200_000;
  g.queue.pump();
  const ended = g.queue.state().tasks[0];
  assert.deepEqual([ended.status, ended.outcome, ended.error], ['done', 'exited', 'The worker did not go to work on it']);
});

test('a prompt the worker did not take leaves the task waiting and unassigned', (t) => {
  const w = worker({ name: 'Deaf' });
  const f = fakeFloor(t, 'f1', 'Floor', [w], { promptError: 'Worker is not running' });
  const task = held(f);
  const r = confirm(office([f]), f.floor, task.id, w.id, 'Ada');
  assert.deepEqual(r, { ok: false, message: 'Worker is not running' });
  const after = f.queue.state().tasks[0];
  assert.deepEqual([after.status, after.workerId, after.assigned], ['queued', undefined, undefined]);
});

test('held, needs and assigned survive a restart of the queue; an assigned task that was running is stopped, as any running task is', (t) => {
  const w = worker({ name: 'W' });
  const f = fakeFloor(t, 'f1', 'Floor', [w]);
  const kept = held(f, 'Kept', 'claude', { needs: { role: 'reviewer', skills: ['review'] } });
  const running = held(f, 'Running');
  assert.equal(confirm(office([f]), f.floor, running.id, w.id, 'Ada').ok, true);
  const dataDir = (f.queue as unknown as { statePath: string }).statePath;
  const again = new TaskQueue(path.dirname(dataDir), { defaultProvider: 'claude', list: () => [w], deskOccupied: () => true, spawn: () => 'no', kill: async () => ({}) }, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} });
  t.after(() => again.shutdown());
  const [a, b] = again.state().tasks;
  assert.deepEqual([a.hold, a.needs], [true, { role: 'reviewer', skills: ['review'] }]);
  assert.deepEqual([b.status, b.outcome, b.assigned?.by], ['done', 'exited', 'Ada']);
});

// --- 10: it cannot hire, merge, push or deploy --------------------------------------------------------------------------------

test('dispatch can only type one prompt and start one task: it has no way to hire, restart, send home, push, open or merge a pull request, or deploy', (t) => {
  const w = worker({ name: 'Idle' });
  const f = fakeFloor(t, 'f1', 'Floor', [w]);
  const task = held(f);
  confirm(office([f]), f.floor, task.id, w.id, 'Ada');
  assert.deepEqual(f.calls, [`prompt ${w.id}`]);
  assert.equal(f.spawned, 0);
  // And the code that does it cannot reach those things: what it imports, and what it names.
  const files = ['src/server/dispatch/dispatcher.ts', 'src/server/dispatch/subagents.ts', 'src/server/dispatch/office.ts', 'src/server/dispatch/extension.ts', 'src/shared/dispatch.ts', 'src/server/ws/handlers/dispatch.ts'];
  for (const file of files) {
    const src = readFileSync(path.join(import.meta.dirname, '..', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(!/child_process|github|worktree|workers\/manager|\.\.\/workers\.js$|deploy|(^|\/)prs?\.js$|merge/.test(m[1]), `${file} imports ${m[1]}`);
    }
    assert.ok(!/\b(spawn|spawnSync|execFile|execFileSync|kill|sendHome|openPr|resume|mergePr)\s*\(/.test(src), `${file} calls something that acts on workers or GitHub`);
    assert.ok(!/['"`](push|merge|deploy|git)['"`]/.test(src), `${file} names a git or deploy action`);
  }
  assert.deepEqual(POLICY, { auto: false, merge: 'human', hires: false });
  assert.equal(manual.choose({ taskId: 't', title: 't', floorId: 'f', needs: {}, providers: [], candidates: [{ workerId: 'w', name: 'w', roleLabel: 'r', status: 'idle', reasons: [] }], blocked: [], at: 0 }), undefined, 'the one strategy in this release picks nobody');
  assert.deepEqual(conservative.classify({ number: 1, checks: 'pass', draft: false }), { readyForHuman: false, merge: 'human', reasons: ['not classified: PR readiness is a later release, and humans merge'] });
});

// --- the browser's messages and the agents' read-only route ---------------------------------------------------------------------

function fakeCtx(floors: Fake[], current: string, accountId?: string) {
  const sent: unknown[] = [];
  const warned: string[] = [];
  const map = new Map(floors.map((f) => [f.floor.id, f.floor]));
  const ctx = { floors: map, limits: { state: { windows: [], at: 0 } }, meOf: (accountId?: string) => ({ admin: accountId === 'admin' }), floorOf: (c: { peer: { floor: string } }) => map.get(c.peer.floor), sendTo: (_c: unknown, m: unknown) => void sent.push(m), warn: (_c: unknown, text?: string) => void (text && warned.push(text)) };
  return { ctx, sent, warned, client: { accountId, peer: { name: 'Ada', floor: current } } };
}

test("the browser's messages work on the floor the person is on: a task or worker of another floor is out of reach", (t) => {
  const a = fakeFloor(t, 'a', 'Alpha', [worker({ name: 'Mine' })]);
  const b = fakeFloor(t, 'b', 'Beta', [worker({ name: 'Theirs' })]);
  const taskA = held(a, 'On alpha');
  const taskB = held(b, 'On beta');
  const { ctx, sent, warned, client } = fakeCtx([a, b], 'a', 'admin');
  const h = dispatchHandlers as unknown as Record<string, (c: unknown, cl: unknown, m: unknown) => void>;
  h['dispatch.inventory'](ctx, client, { t: 'dispatch.inventory' });
  assert.equal((sent[0] as { inventory: { rows: unknown[] } }).inventory.rows.length, 2);
  h['dispatch.preview'](ctx, client, { t: 'dispatch.preview', taskId: taskA.id });
  assert.equal((sent[1] as { t: string }).t, 'dispatch.preview');
  h['dispatch.preview'](ctx, client, { t: 'dispatch.preview', taskId: taskB.id });
  assert.deepEqual(sent[2], { t: 'dispatch.result', taskId: taskB.id, ok: false, message: 'No such task on this floor' });
  h['dispatch.confirm'](ctx, client, { t: 'dispatch.confirm', taskId: taskB.id, workerId: b.workers[0].id });
  assert.equal((sent[3] as { ok: boolean }).ok, false);
  assert.deepEqual(b.prompts, []);
  h['dispatch.confirm'](ctx, client, { t: 'dispatch.confirm', taskId: taskA.id, workerId: a.workers[0].id });
  assert.equal((sent[4] as { ok: boolean }).ok, true);
  assert.equal(a.prompts.length, 1);
  assert.equal(warned.length, 1, 'the refused confirm is also said to the person');
  // Hold and release are the floor's own.
  const other = held(a, 'Other');
  h['queue.hold'](ctx, client, { t: 'queue.hold', taskId: other.id, hold: false });
  assert.equal(a.queue.state().tasks.find((x) => x.id === other.id)!.hold, undefined);
});

async function call(ctx: unknown, me: { id: string; token: string }, method: string, route: string): Promise<{ status: number; json: any }> {
  const req = Object.assign(Readable.from([Buffer.from('{}')]), { method, headers: { authorization: `Bearer ${me.token}` } }) as unknown as http.IncomingMessage;
  const out = { status: 0, text: '' };
  const res = { writeHead: (s: number) => void (out.status = s), end: (b: string) => void (out.text = b) } as unknown as http.ServerResponse;
  await officeWorkers(ctx as never, req, res, new URL(`http://office.local/office/workers${route}${route.includes('?') ? '&' : '?'}worker=${me.id}`));
  return { status: out.status, json: out.text ? JSON.parse(out.text) : undefined };
}

test('an agent can look at the inventory and a preview through its own token, and cannot dispatch, hire or reach another floor through them', async (t) => {
  const dir = tmp('route');
  (await git())(dir, 'init', '-q', '-b', 'main');
  const data = path.join(dir, '.agent-office');
  mkdirSync(data, { recursive: true });
  const manager = realManager(dir, data);
  t.after(() => manager.shutdown());
  const me = manager.spawn('desk-1', 'test', 'me', false) as WorkerInfo;
  const token = (manager as unknown as { workers: Map<string, { hookToken: string }> }).workers.get(me.id)!.hookToken;
  const q = fakeFloor(t, 'f1', 'Floor', []);
  const spawned: string[] = [];
  const floor = { ...q.floor, id: 'f1', dir, workers: manager, github: { pulls: { items: [] } }, queue: q.queue, project: { branch: 'main', agentProviders: ['custom'] }, plan: { wing: 0 }, landed: () => undefined, sendHome: () => spawned.push('home') };
  const other = fakeFloor(t, 'f2', 'Other', [worker({ name: 'Elsewhere' })]);
  const ctx = { workerFloor: (id: string) => (manager.get(id) ? floor : undefined), floors: new Map<string, unknown>([['f1', floor], ['f2', other.floor]]), limits: { state: { windows: [], at: 0 } }, leaveOnMerge: { on: false }, ledger: { hiringPaused: undefined }, toastFloor: () => {}, signins: {} };
  const task = q.queue;
  task.add('a held one', 'Ada', 'Held', undefined, 'claude', undefined, undefined, undefined, { hold: true });
  const taskId = task.state().tasks[0].id;
  const inv = await call(ctx, { id: me.id, token }, 'GET', '/inventory');
  assert.equal(inv.status, 200);
  assert.deepEqual(inv.json.rows.map((r: { floorName: string }) => r.floorName), ['Floor'], 'a worker is not an admin: its own floor only');
  assert.equal(inv.json.scope, 'this-floor');
  assert.equal(inv.json.policy.auto, false);
  const pv = await call(ctx, { id: me.id, token }, 'GET', `/preview?task=${taskId}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.json.taskId, taskId);
  assert.ok(pv.json.candidates.every((c: { name: string }) => c.name !== 'Elsewhere'));
  assert.equal((await call(ctx, { id: me.id, token }, 'GET', '/preview?task=nope')).status, 404);
  assert.equal((await call(ctx, { id: me.id, token: 'wrong' }, 'GET', '/inventory')).status, 401);
  // There is no route that dispatches: a POST to one is refused as unknown.
  for (const route of ['/dispatch', '/confirm', '/inventory', '/preview']) assert.equal((await call(ctx, { id: me.id, token }, 'POST', route)).status, 405, route);
  assert.equal(task.state().tasks[0].status, 'queued');
});

// --- who may see another floor ----------------------------------------------------------------------------------------------------

test("another floor's workers, tasks and subagents are shown to admins only; anyone else sees what their own floor already shows", (t) => {
  const mine = worker({ name: 'Mine' });
  const secret = worker({ name: 'Secret Worker', task: { name: 'Hidden Project Plan', summary: 'Hidden summary' }, role: 'security-engineer' });
  const a = fakeFloor(t, 'a', 'Alpha', [mine]);
  const b = fakeFloor(t, 'b', 'Beta Confidential', [secret]);
  held(b, 'Beta private task');
  mkdirSync(path.join(b.floor.dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(path.join(b.floor.dir, '.claude', 'agents', 'beta-agent.md'), '---\nname: beta-agent\n---\n');
  const taskA = held(a, 'Alpha task');
  const o = office([a, b]);
  const h = dispatchHandlers as unknown as Record<string, (c: unknown, cl: unknown, m: unknown) => void>;
  const leaks = (value: unknown) => JSON.stringify(value).match(/Secret Worker|Hidden Project Plan|Hidden summary|Beta Confidential|Beta private task|beta-agent|security-engineer|Security Engineer/g) ?? [];

  // A member (an account that is not an admin) over the browser's messages: nothing of floor b anywhere in what comes back.
  const member = fakeCtx([a, b], 'a', 'member');
  h['dispatch.inventory'](member.ctx, member.client, { t: 'dispatch.inventory' });
  h['dispatch.preview'](member.ctx, member.client, { t: 'dispatch.preview', taskId: taskA.id, needs: { providers: [...AGENT_PROVIDERS] } });
  const inv = (member.sent[0] as { inventory: { rows: { name: string }[]; subagents: unknown[]; scope: string } }).inventory;
  assert.deepEqual(inv.rows.map((r) => r.name), ['Mine']);
  assert.deepEqual(inv.subagents, []);
  assert.equal(inv.scope, 'this-floor');
  const pv = (member.sent[1] as { preview: { candidates: unknown[]; blocked: unknown[] } }).preview;
  assert.deepEqual((pv.candidates as { name: string }[]).map((c) => c.name), ['Mine']);
  assert.deepEqual(pv.blocked, [], "another floor's worker is not even named among those that cannot take it");
  assert.deepEqual(leaks(member.sent), []);
  // Nor can a member reach it with a confirm, or learn anything from the refusal.
  h['dispatch.confirm'](member.ctx, member.client, { t: 'dispatch.confirm', taskId: taskA.id, workerId: secret.id });
  const refusal = member.sent[2] as { ok: boolean; message: string };
  assert.deepEqual([refusal.ok, refusal.message], [false, 'No such worker on this floor']);
  assert.deepEqual(b.prompts, []);
  assert.deepEqual(member.warned, ['No such worker on this floor']);

  // A guest with no account behind the connection is not an admin either.
  const guest = fakeCtx([a, b], 'a', undefined);
  h['dispatch.inventory'](guest.ctx, guest.client, { t: 'dispatch.inventory' });
  assert.deepEqual(leaks(guest.sent), []);

  // An admin sees the whole building; the preview still never offers another floor's worker, and says why not.
  const admin = fakeCtx([a, b], 'a', 'admin');
  h['dispatch.inventory'](admin.ctx, admin.client, { t: 'dispatch.inventory' });
  const all = (admin.sent[0] as { inventory: { rows: { name: string; floorName: string }[]; subagents: { name: string }[]; scope: string } }).inventory;
  assert.deepEqual(all.rows.map((r) => [r.name, r.floorName]), [['Mine', 'Alpha'], ['Secret Worker', 'Beta Confidential']]);
  assert.deepEqual(all.subagents.map((s) => s.name), ['beta-agent']);
  assert.equal(all.scope, 'all-floors');
  h['dispatch.preview'](admin.ctx, admin.client, { t: 'dispatch.preview', taskId: taskA.id, needs: { providers: [...AGENT_PROVIDERS] } });
  const apv = (admin.sent[1] as { preview: { candidates: { name: string }[]; blocked: { name: string; reasons: string[] }[] } }).preview;
  assert.deepEqual(apv.candidates.map((c) => c.name), ['Mine']);
  assert.match(apv.blocked.find((x) => x.name === 'Secret Worker')!.reasons[0], /another floor/);

  // Admin status is asked of the office at the moment of the request, not remembered from when the page connected.
  let admin_now = true;
  const demoted = { ...member.ctx, meOf: () => ({ admin: admin_now }) };
  h['dispatch.inventory'](demoted, member.client, { t: 'dispatch.inventory' });
  admin_now = false;
  h['dispatch.inventory'](demoted, member.client, { t: 'dispatch.inventory' });
  const rowsNow = (member.sent.slice(-2) as { inventory: { rows: unknown[] } }[]).map((m) => m.inventory.rows.length);
  assert.deepEqual(rowsNow, [2, 1]);

  // An agent's own token never opens another floor either: the inventory it fetches is its floor's.
  assert.deepEqual(inventory(o, a.floor, AGENT).rows.map((r) => r.name), ['Mine']);
  assert.deepEqual(leaks(preview(o, a.floor, taskA.id, AGENT)), []);
});

test('no source under src/server (other than the pinned ones) changed what it does with a role: dispatch reads it only to rank and to match a task', () => {
  const lines = readFileSync(path.join(import.meta.dirname, 'worker-role-lines.json'), 'utf8');
  const parsed = JSON.parse(lines) as Record<string, string[]>;
  assert.deepEqual(parsed['dispatch/dispatcher.ts'], ['role: w.role,'], 'the server side only passes the role on to shared/dispatch.ts, which ranks and matches');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((e) => (statSync(path.join(dir, e)).isDirectory() ? walk(path.join(dir, e)) : [path.join(dir, e)]));
  const users = walk(path.join(import.meta.dirname, '..', 'src', 'shared')).filter((f) => /\b(workerRole|skillsOf)\(/.test(readFileSync(f, 'utf8'))).map((f) => path.basename(f)).sort();
  assert.deepEqual(users, ['dispatch.ts', 'worker-identity.ts'], 'only shared/dispatch.ts compares a role to anything');
});
