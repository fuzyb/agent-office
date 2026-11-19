import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { officeWorkers } from '../src/server/hooks/office-workers.js';
import { landedWork, notLeaving } from '../src/server/leave-on-merge.js';
import { workerRow, type PullsView } from '../src/server/office-workers.js';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { nextFreeSeat } from '../src/shared/layout.js';
import type { GhPull, WorkerInfo } from '../src/shared/protocol.js';
import { DEFAULT_ROLE, WORKER_ROLES } from '../src/shared/worker-identity.js';

// A role is a label. These tests are the guard on that: nothing decides what a worker may do by reading
// it (a reviewed list of every line that mentions one), and the real /office/workers route, which is
// where an agent's authority is decided, answers a worker of any role the same.

const ROLES_TO_TRY = [...WORKER_ROLES.map((r) => r.id), 'future-role'];

// --- Where `role` appears in the server's code ---------------------------------------------------------

const server = path.join(import.meta.dirname, '..', 'src', 'server');

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function roleLines(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const lines = stripComments(readFileSync(p, 'utf8')).split('\n').filter((l) => /\brole\b/.test(l)).map((l) => l.trim());
        if (lines.length) found.set(path.relative(server, p).split(path.sep).join('/'), lines);
      }
    }
  };
  walk(server);
  return found;
}

/** Files that have a `role` that is not a worker's: an account's (admin, member), a meeting seat's, a chat message's. */
const NOT_A_WORKERS_ROLE: Record<string, string> = {
  'accounts.ts': 'an account is an admin or a member',
  'ws/handlers/accounts.ts': 'an account is an admin or a member',
  'config.ts': 'an account is an admin or a member',
  'http/routes/auth.ts': 'an account is an admin or a member',
  'office/people.ts': 'an account is an admin or a member',
  'office/services.ts': 'an account is an admin or a member',
  'meetings.ts': "a seat's part in a meeting (Advocate, Skeptic…), not a worker's role",
  'opencode.ts': "a chat message's author ('assistant')",
  'pi.ts': "a chat message's author ('assistant')",
};

test("every line of server code that mentions a worker's role has been looked at, and nothing else mentions one", () => {
  const snapshot = JSON.parse(readFileSync(path.join(import.meta.dirname, 'worker-role-lines.json'), 'utf8')) as Record<string, string[]>;
  const found = roleLines();
  for (const [file, lines] of found) {
    if (file in snapshot) assert.deepEqual(lines, snapshot[file], `${file}: a line that mentions a worker's role changed. A role is a label (shared/worker-identity.ts): if this line only passes it along, saves it, or compares it to notice a clash, update tests/worker-role-lines.json; if it decides anything, it is a permission, which a role must not be`);
    else assert.ok(file in NOT_A_WORKERS_ROLE, `${file} uses \`role\`: if it is a worker's, nothing may decide anything by it; if it is something else, say what in NOT_A_WORKERS_ROLE`);
  }
  for (const file of Object.keys(snapshot)) assert.ok(found.has(file), `${file} no longer mentions a role: take it off tests/worker-role-lines.json`);
  // What the reviewed lines do is read in the review: pass it on, parse it, save it, say it, compare it for a clash. None is a branch on what a role is.
  const all = Object.values(snapshot).flat().join('\n');
  for (const id of WORKER_ROLES.map((r) => r.id)) assert.ok(!all.includes(`'${id}'`) && !all.includes(`"${id}"`), `a reviewed line names the role ${id}`);
});

// --- The route that decides what an agent may do --------------------------------------------------------

const git = async () => {
  const { execFileSync } = await import('node:child_process');
  return (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
};

async function floorOf(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'ao-role-'));
  const run = await git();
  run(root, 'init', '-q', '-b', 'main');
  const data = path.join(root, '.agent-office');
  mkdirSync(data, { recursive: true });
  const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };
  const script = path.join(root, 'agent.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  const manager = new WorkerManager(root, data, process.execPath, [script], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => {
    manager.shutdown();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps a folder while a process that was in it is still going.
    }
  });
  const floor = {
    id: 'f1',
    def: { name: 'Floor', repo: undefined },
    workers: manager,
    github: { pulls: { items: [] as GhPull[] } },
    queue: { state: () => ({ tasks: [], maxWorkers: 3 }) },
    project: { branch: 'main', agentProviders: ['custom'] },
    plan: { wing: 0 },
    landed: () => undefined,
    sendHome: (id: string) => manager.kill(id, 'keep'),
  };
  const toasts: string[] = [];
  const ctx = { workerFloor: (id: string) => (manager.get(id) ? floor : undefined), floors: new Map([['f1', floor]]), leaveOnMerge: { on: false }, ledger: { hiringPaused: undefined }, toastFloor: (_f: unknown, text: string) => toasts.push(text), signins: {} };
  return { manager, floor, ctx, toasts };
}

async function call(ctx: unknown, me: { id: string; token: string }, method: string, route: string, body?: unknown): Promise<{ status: number; json: any }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { method, headers: { authorization: `Bearer ${me.token}` } }) as unknown as http.IncomingMessage;
  const out = { status: 0, text: '' };
  const res = { writeHead: (s: number) => void (out.status = s), end: (b: string) => void (out.text = b) } as unknown as http.ServerResponse;
  await officeWorkers(ctx as never, req, res, new URL(`http://office.local/office/workers${route}?worker=${me.id}`));
  return { status: out.status, json: out.text ? JSON.parse(out.text) : undefined };
}

const hookToken = (m: WorkerManager, id: string): string => (m as unknown as { workers: Map<string, { hookToken: string }> }).workers.get(id)!.hookToken;

test('what an agent may do through /office/workers is the same whatever its role is', async (t) => {
  const outcomes: Record<string, unknown> = {};
  for (const role of ROLES_TO_TRY) {
    const { manager, ctx } = await floorOf(t);
    const seat = nextFreeSeat((id) => manager.deskOccupied(id), 0)!.id;
    const meInfo = manager.spawn(seat, 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, role === 'future-role' ? undefined : { role }) as WorkerInfo;
    assert.equal(typeof meInfo, 'object', String(meInfo));
    // A role this office doesn't know is one a newer office wrote: it is on the worker as it came back from a file.
    if (role === 'future-role') manager.get(meInfo.id)!.role = role;
    const me = { id: meInfo.id, token: hookToken(manager, meInfo.id) };
    const bad = { id: me.id, token: 'not-the-token' };
    const list = await call(ctx, me, 'GET', '');
    const refused = await call(ctx, bad, 'GET', '');
    const homeSelf = await call(ctx, me, 'POST', '/home', { workers: [me.id] });
    const tellSelf = await call(ctx, me, 'POST', '/tell', { worker: me.id, prompt: 'x' });
    const noPrompt = await call(ctx, me, 'POST', '', { worktree: false });
    const hired = await call(ctx, me, 'POST', '', { prompt: 'sub task', worktree: false });
    const wantsChief = await call(ctx, me, 'POST', '', { prompt: 'sub task', worktree: false, role: 'engineering-chief', name: `Sub ${role}`.slice(0, 30) });
    const dupName = await call(ctx, me, 'POST', '', { prompt: 'sub task', worktree: false, name: `Sub ${role}`.slice(0, 30) });
    outcomes[role] = {
      list: [list.status, list.json.you === me.id, list.json.workers.length, list.json.freeDesk !== null],
      refused: refused.status,
      homeSelf: homeSelf.json.results.map((r: { error?: string }) => r.error),
      tellSelf: [tellSelf.status, tellSelf.json.error],
      noPrompt: [noPrompt.status, noPrompt.json.error],
      hired: [hired.status, hired.json.worker?.role],
      wantsChief: [wantsChief.status, wantsChief.json.worker?.role],
      dupName: [dupName.status, /already called/.test(dupName.json.error ?? '')],
    };
    // Hired by a worker of this role, the new one is a general worker unless it was hired for another: the role is not inherited.
    assert.equal(hired.json.worker.role, DEFAULT_ROLE, `${role} passed its role on`);
    // Naming a role on a hire is allowed to anyone, for any role (it grants nothing), and a clash is refused for every one of them.
    assert.equal(wantsChief.json.worker.role, 'engineering-chief');
  }
  const baseline = outcomes[DEFAULT_ROLE];
  for (const role of ROLES_TO_TRY) assert.deepEqual(outcomes[role], baseline, `${role} gets different answers from a general worker`);
  assert.deepEqual((baseline as { homeSelf: unknown[] }).homeSelf, ["That's you: someone else has to send you home"]);
  assert.equal((baseline as { refused: number }).refused, 401);
});

test('a worker of any role cannot reach another floor, and cannot ask for another floor’s worker by name', async (t) => {
  const a = await floorOf(t);
  const b = await floorOf(t);
  const seat = (m: WorkerManager) => nextFreeSeat((id) => m.deskOccupied(id), 0)!.id;
  const chief = a.manager.spawn(seat(a.manager), 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { role: 'engineering-chief', name: 'Chief' }) as WorkerInfo;
  const other = b.manager.spawn(seat(b.manager), 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'Elsewhere' }) as WorkerInfo;
  const me = { id: chief.id, token: hookToken(a.manager, chief.id) };
  const list = await call(a.ctx, me, 'GET', '');
  assert.deepEqual(list.json.workers.map((w: { id: string }) => w.id), [chief.id]);
  // By name and by id: nobody on this floor, so nothing to tell or send home.
  for (const key of ['Elsewhere', other.id]) {
    assert.equal((await call(a.ctx, me, 'POST', '/tell', { worker: key, prompt: 'x' })).status, 404, key);
    assert.match((await call(a.ctx, me, 'POST', '/home', { workers: [key] })).json.results[0].error, /No worker here/, key);
  }
  assert.ok(b.manager.get(other.id), 'it is still at its desk');
});

// --- The functions that decide things about a worker -----------------------------------------------------

const head = 'a'.repeat(40);
const pull = (number: number, state: string, headRefName: string, headRefOid?: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: `https://github.com/acme/app/pull/${number}`, author: '', labels: [], reviewDecision: '',
  headRefName, headRefOid, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0, checks: 'none', body: '', closes: [],
});

test('whether a worker has landed, may go home by itself, and how its row reads do not depend on its role', () => {
  const view: PullsView = { pulls: [pull(7, 'MERGED', 'office/bolt', head), pull(8, 'OPEN', 'office/zed')], tasks: [] };
  const make = (role?: string, more: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: 'bolt', kind: 'agent', deskId: 'desk-1', name: 'Bolt', color: '#fff', status: 'done', acked: false, createdBy: 'Ada', createdAt: 0, cols: 80, rows: 24, viewers: [], worktree: { path: '.agent-office/worktrees/bolt', branch: 'office/bolt', base: 'abc' }, ...(role ? { role } : {}), ...more });
  // Everything they answer, with the role itself (which is data a result may carry) taken out.
  const decisions = (w: WorkerInfo) =>
    JSON.parse(JSON.stringify({ row: workerRow(w, view, 'someone-else'), landed: landedWork(w, view.pulls, view.tasks), staying: notLeaving(w), busyStaying: notLeaving({ ...w, viewers: ['Ada'], status: 'working' }) }), (k, v) => (k === 'role' || k === 'roleLabel' ? undefined : v));
  const baseline = decisions(make());
  assert.ok(baseline.landed, 'the scenario has a worker whose work landed');
  for (const role of ROLES_TO_TRY) assert.deepEqual(decisions(make(role)), baseline, role);
  // The row itself says the role, and only that differs.
  assert.equal(workerRow(make('engineering-chief'), view).role, 'engineering-chief');
});
