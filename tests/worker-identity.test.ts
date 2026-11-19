import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOOLS, ROLES, formatWorker, parseArgs } from '../bin/office-workers.js';
import { findWorker, readHireRequest, workerRow, type PullsView } from '../src/server/office-workers.js';
import { TaskQueue, type QueueEvents } from '../src/server/queue.js';
import { Ledger } from '../src/server/usage.js';
import { workerHandlers } from '../src/server/ws/handlers/workers.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { DESK_BY_ID, nextFreeSeat } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { DEFAULT_ROLE, NAME_MAX, WORKER_ROLES, given, nameKey, parseWorkerName, parseWorkerRole, roleLabel, savedRole, shownRole, workerRole, workerSlug } from '../src/shared/worker-identity.js';

// What a worker is called and what it's for (src/shared/worker-identity.ts, server/workers/identity.ts):
// a name a person gave it, a role it was hired for, and the id that stays the same through both.

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Fixture {
  root: string;
  data: string;
  /** What the fake agent has been typed, from every worker. */
  typed(): string;
  updates: WorkerInfo[];
  manager(): WorkerManager;
}

/** A git project, and a manager whose agent is a Node script that stays up and writes down what it is typed (the same on every OS). */
function fixture(t: { after(fn: () => void): void }): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'ao-identity-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  const log = path.join(root, 'typed.log');
  const script = path.join(root, 'agent.mjs');
  writeFileSync(script, `import { appendFileSync } from 'node:fs'; process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(log)}, d)); setInterval(() => {}, 1000);`);
  const data = path.join(root, '.agent-office');
  mkdirSync(data, { recursive: true });
  const updates: WorkerInfo[] = [];
  const events: WorkerEvents = { update: (i) => updates.push(i), remove() {}, data() {}, screen() {}, toast() {} };
  const made: WorkerManager[] = [];
  t.after(() => {
    for (const m of made) m.shutdown();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps a folder while the process that was in it is still going; the temp folder is cleared later.
    }
  });
  return {
    root,
    data,
    updates,
    typed: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    manager() {
      const m = new WorkerManager(root, data, process.execPath, [script], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
      made.push(m);
      return m;
    },
  };
}

type Asked = { name?: unknown; role?: unknown };
/** The first desk nobody is at. */
const free = (w: WorkerManager): string => nextFreeSeat((id) => w.deskOccupied(id), 0)!.id;
/** Hires an agent in its own worktree at the next free desk. */
function hire(w: WorkerManager, asked?: Asked, worktree = true): WorkerInfo {
  const r = w.spawn(free(w), 'Ada', 'do the task', worktree, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, asked);
  assert.equal(typeof r, 'object', String(r));
  return r as WorkerInfo;
}
const refused = (r: unknown): string => {
  assert.equal(typeof r, 'string', JSON.stringify(r));
  return r as string;
};
const branches = (root: string) => git(root, 'branch', '--list', 'office/*').split('\n').filter(Boolean);

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  let v = read();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    v = read();
  }
  assert.ok(ok(v), 'timed out');
  return v;
}

// --- Names and roles as plain data -----------------------------------------------------------------

test('names are trimmed, kept in their composed form, and limited to what a person would call a worker', () => {
  const ok = (raw: string, expected = raw) => assert.deepEqual(parseWorkerName(raw), { name: expected }, raw);
  const bad = (raw: unknown) => assert.ok('error' in parseWorkerName(raw), String(raw));
  // The examples a person would type.
  ok('Chief — Galexii');
  ok('Backend Engineer — Galexii');
  ok('QA Reviewer — HQ');
  ok("  spaced   out\u00a0here  ", 'spaced out here');
  ok('x'.repeat(NAME_MAX));
  bad('x'.repeat(NAME_MAX + 1));
  bad('x'.repeat(5000));
  bad('');
  bad('   ');
  bad('—');
  bad(42);
  bad(null);
  bad(['a']);
  // Not markup, commands, paths, mentions, issue references, links or the shell mark.
  for (const attack of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg/onload=1>', 'a; rm -rf /', '$(whoami)', '`id`', 'a|b', '../../etc/passwd', 'C:\\Windows', '@octocat', '#12', '[x](http://evil.example)', 'a\nb', 'a\tb', 'bell\u0007', 'Shelly 🐚']) bad(attack);
  // Text that reorders or hides: bidi overrides, zero-width spaces, word joiners, line separators.
  for (const sneaky of ['rtl\u202eevil', 'iso\u2066late\u2069', 'zero\u200bwidth', 'join\u2060er', 'bom\ufeffname', 'line\u2028sep']) bad(sneaky);
  // Not a worker's id, a board agent's name, or a pile of accents.
  bad('a1b2c3d4e5f6');
  bad('PR agent');
  bad('pr   AGENT');
  bad('Z\u0335\u0327\u031b\u0353\u0330a');
});

test('ordinary Unicode names are fine, and a word that mixes lookalike alphabets is not', () => {
  for (const name of ['José', 'Zoë', '李雷', 'Алексей', 'محمد', 'עדי', '👩‍🔬 Ada', '🇺🇸 Team', 'Dr. O\u2019Neil', 'A+ (beta) & co']) assert.deepEqual(parseWorkerName(name), { name }, name);
  // A decomposed é is stored composed.
  assert.deepEqual(parseWorkerName('Jose\u0301'), { name: 'José' });
  // Latin with a Cyrillic а in one word is a way to pass as somebody else.
  assert.ok('error' in parseWorkerName('P\u0430xel'));
  // Whole words in either alphabet are fine, in one name.
  assert.deepEqual(parseWorkerName('Pixel Алексей'), { name: 'Pixel Алексей' });
});

test('two names are the same name when only case, spacing around a dash or a compatibility form tell them apart', () => {
  const key = nameKey('Chief — Galexii');
  for (const same of ['chief - galexii', 'CHIEF—GALEXII', 'Chief – Galexii', 'Chief  —  Galexii']) assert.equal(nameKey(same), key, same);
  assert.equal(nameKey('ＰＩＸＥＬ'), nameKey('Pixel'));
  assert.equal(nameKey('Pixel 🐚'), nameKey('pixel'));
  assert.notEqual(nameKey('Chief — Galexii'), nameKey('Chief — HQ'));
  assert.notEqual(nameKey('A+'), nameKey('A'));
});

test('a worktree is made from a plain-letter slug of the name, whatever the name is made of', () => {
  assert.equal(workerSlug('Chief — Galexii'), 'chief-galexii');
  assert.equal(workerSlug('Pixel'), 'pixel');
  assert.equal(workerSlug('Worker 7'), 'worker-7');
  assert.equal(workerSlug('José Ünï'), 'jose-uni');
  assert.equal(workerSlug('李雷'), 'worker');
  assert.equal(workerSlug('x'.repeat(NAME_MAX)).length, 24);
  for (const name of ['Chief — Galexii', "Dr. O'Neil", '👩‍🔬 Ada', 'A+ (b) & c', '-_-', 'con']) assert.match(workerSlug(name), /^[a-z0-9]+(-[a-z0-9]+)*$/, name);
});

test('roles are ids from one list that a person can write as the id or as the label', () => {
  assert.equal(WORKER_ROLES[0].id, DEFAULT_ROLE);
  assert.deepEqual(new Set(WORKER_ROLES.map((r) => r.id)).size, WORKER_ROLES.length);
  for (const r of WORKER_ROLES) {
    assert.deepEqual(parseWorkerRole(r.id), { role: r.id });
    assert.deepEqual(parseWorkerRole(r.label), { role: r.id }, r.label);
    assert.equal(roleLabel(r.id), r.label);
  }
  assert.deepEqual(parseWorkerRole('PR Reviewer'), { role: 'reviewer' });
  assert.deepEqual(parseWorkerRole('backend_engineer'), { role: 'backend-engineer' });
  for (const bad of ['admin', 'root', 'merge', '', 7, null, undefined]) assert.ok('error' in parseWorkerRole(bad), String(bad));
  // The roles the HQ repository has files for keep their file's name.
  for (const id of ['engineering-chief', 'qa-engineer', 'product-architect', 'researcher', 'developer', 'reviewer', 'chief-of-staff']) assert.ok(WORKER_ROLES.some((r) => r.id === id), id);
  // One a newer office wrote is kept as it is; garbage is not.
  assert.equal(savedRole('future-role'), 'future-role');
  assert.equal(roleLabel('future-role'), 'future-role');
  for (const junk of ['Future Role', '../x', '', 5, null, 'a'.repeat(60)]) assert.equal(savedRole(junk), undefined);
  assert.equal(workerRole({}), DEFAULT_ROLE);
  assert.equal(workerRole({ role: 'qa-engineer' }), 'qa-engineer');
  // A blank field is "not given"; anything else, wrong or not, is checked.
  assert.equal(given(undefined), undefined);
  assert.equal(given('  '), undefined);
  assert.equal(given(null), undefined);
  assert.equal(given(0), 0);
  assert.equal(given('Chief'), 'Chief');
});

// --- Hiring -----------------------------------------------------------------------------------------

test('hired with a name and a role, a worker is called that and keeps its own id, worktree and a plain branch', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w, { name: '  Backend Engineer — Galexii ', role: 'Backend Engineer' });
  assert.equal(info.name, 'Backend Engineer — Galexii');
  assert.equal(info.role, 'backend-engineer');
  assert.match(info.id, /^[0-9a-f]{12}$/);
  // The branch and folder are plain letters and the id's, not the name.
  assert.match(info.worktree!.branch, /^office\/backend-engineer-galexii-[0-9a-f]{4}$/);
  assert.ok(info.worktree!.branch.endsWith(info.id.slice(0, 4)));
  assert.ok(existsSync(path.join(f.root, info.worktree!.path)));
  assert.equal(git(path.join(f.root, info.worktree!.path), 'rev-parse', '--abbrev-ref', 'HEAD'), info.worktree!.branch);
  assert.deepEqual(branches(f.root).map((b) => b.replace(/^[*+]?\s*/, '')), [info.worktree!.branch]);
  // What the page and the file get is the same.
  assert.equal(w.get(info.id)?.name, 'Backend Engineer — Galexii');
});

test('a name no branch or folder could be made from still gets a worktree', (t) => {
  const f = fixture(t);
  const w = f.manager();
  for (const name of ['李雷', '👩‍🔬', "Dr. O'Neil", 'A+ (b) & c']) {
    const info = hire(w, { name });
    assert.equal(info.name, name);
    assert.match(info.worktree!.branch, /^office\/[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{4}$/, name);
    assert.ok(existsSync(path.join(f.root, info.worktree!.path)), name);
  }
});

test('hired with neither, a worker gets the next free name in the pool and the default role, as before', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const [a, b, c] = [hire(w), hire(w, {}), hire(w, { name: '', role: '   ' })];
  assert.deepEqual([a.name, b.name, c.name], ['Pixel', 'Byte', 'Nibble']);
  for (const info of [a, b, c]) {
    assert.equal(info.role, DEFAULT_ROLE);
    assert.match(info.worktree!.branch, new RegExp(`^office/${info.name.toLowerCase()}-${info.id.slice(0, 4)}$`));
  }
});

test('the pool skips a name somebody chose, and runs on to "Worker n" without repeating one', (t) => {
  const f = fixture(t);
  const w = f.manager();
  hire(w, { name: 'pixel' });
  assert.equal(hire(w).name, 'Byte');
  // With the pool used up (an empty one here): "Worker 3", and when that is somebody's, the next.
  const next = () => w.identity.pick(undefined, 'agent', false, []) as { name: string; role?: string };
  assert.deepEqual(next(), { name: 'Worker 3', role: DEFAULT_ROLE });
  hire(w, { name: 'worker 3' }, false);
  assert.equal(next().name, 'Worker 4');
});

test('a bad name or role is refused before anything is made for the worker', (t) => {
  const f = fixture(t);
  const w = f.manager();
  assert.match(refused(w.spawn(free(w), 'Ada', 'x', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: '<b>x</b>' })), /letters, numbers/);
  assert.match(refused(w.spawn(free(w), 'Ada', 'x', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'x'.repeat(33) })), /at most 32/);
  assert.match(refused(w.spawn(free(w), 'Ada', 'x', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'Fine', role: 'superuser' })), /role is one of/);
  assert.match(refused(w.spawn(free(w), 'Ada', 'x', true, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 7 })), /name is text/);
  // No worker, no branch, no folder, nothing saved.
  assert.equal(w.list().length, 0);
  assert.deepEqual(branches(f.root), []);
  assert.ok(!existsSync(path.join(f.data, 'worktrees')) || readdirSync(path.join(f.data, 'worktrees')).length === 0);
});

test('two workers on a floor cannot be told apart by name; the same name is free on another floor and once the first has gone', async (t) => {
  const f = fixture(t);
  const w = f.manager();
  const first = hire(w, { name: 'Chief — Galexii' });
  for (const twin of ['Chief — Galexii', 'chief — galexii', 'CHIEF—GALEXII', 'Chief - Galexii']) {
    assert.match(refused(w.spawn(free(w), 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: twin })), /already called Chief — Galexii/, twin);
  }
  assert.equal(w.list().length, 1);
  // Another floor is another manager: its own names.
  const elsewhere = fixture(t);
  const other = hire(elsewhere.manager(), { name: 'Chief — Galexii' }, false);
  assert.equal(other.name, first.name);
  assert.notEqual(other.id, first.id);
  // Sent home, the name is free again, and the new worker is not the old one.
  await w.kill(first.id);
  const again = hire(w, { name: 'Chief — Galexii' });
  assert.notEqual(again.id, first.id);
});

test('a shell keeps its mark, takes no role, and a board agent keeps the name it has', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const sh = w.spawn(free(w), 'Ada', undefined, false, 'shell', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'Logs' });
  assert.equal(typeof sh, 'object');
  assert.equal((sh as WorkerInfo).name, 'Logs 🐚');
  assert.equal((sh as WorkerInfo).role, undefined);
  assert.match(refused(w.spawn(free(w), 'Ada', undefined, false, 'shell', undefined, undefined, undefined, undefined, undefined, [], undefined, { role: 'qa-engineer' })), /no role/);
  // A name is taken by the shell too.
  assert.match(refused(w.spawn(free(w), 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'logs' })), /already called Logs/);
  const kiosk = [...DESK_BY_ID.values()].find((d) => d.station)!;
  assert.match(refused(w.spawn(kiosk.id, 'Ada', 'x', false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name: 'Boss' })), /fixed/);
  const board = w.spawn(kiosk.id, 'Ada', 'x', false);
  assert.equal(typeof board, 'object');
  assert.equal((board as WorkerInfo).role, undefined);
  assert.match((board as WorkerInfo).name, /agent$/);
});

// --- Renaming and changing roles -------------------------------------------------------------------

test('renaming an idle worker changes only its name: same id, worktree, branch and desk', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w);
  const { id, deskId, worktree } = { ...info, worktree: { ...info.worktree! } };
  const was = info.name;
  const r = w.identity.update(id, { name: '  QA Reviewer — HQ ' });
  assert.ok(typeof r === 'object', String(r));
  if (typeof r === 'string') return;
  assert.deepEqual(r.changed, ['name']);
  assert.equal(r.was.name, was);
  const now = w.get(id)!;
  assert.equal(now.name, 'QA Reviewer — HQ');
  assert.equal(now.id, id);
  assert.equal(now.deskId, deskId);
  assert.deepEqual(now.worktree, worktree);
  assert.equal(git(path.join(f.root, now.worktree!.path), 'rev-parse', '--abbrev-ref', 'HEAD'), worktree.branch);
  assert.equal(w.list().length, 1);
  // The one the page was told about is the renamed one, and the old name is just gone.
  assert.equal(f.updates.at(-1)?.name, 'QA Reviewer — HQ');
  assert.equal(f.updates.at(-1)?.id, id);
  assert.ok(!w.list().some((i) => i.name === was));
});

test('renaming a worker in the middle of a turn does not interrupt it', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w);
  const live = (w as unknown as { workers: Map<string, { pty?: { pid: number }; info: WorkerInfo }> }).workers.get(info.id)!;
  assert.ok(live.pty, 'it has a process');
  const pid = live.pty!.pid;
  live.info.status = 'working';
  const r = w.identity.update(info.id, { name: 'Busy Bee', role: 'researcher' });
  assert.ok(typeof r === 'object', String(r));
  assert.equal(w.get(info.id)!.status, 'working');
  assert.equal(live.pty!.pid, pid);
  assert.doesNotThrow(() => process.kill(pid, 0), 'still running');
  assert.equal(w.get(info.id)!.name, 'Busy Bee');
  assert.equal(w.get(info.id)!.role, 'researcher');
});

test('a message for a worker reaches it by id before and after a rename, and the name that finds it follows', async (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w);
  const other = hire(w);
  assert.equal(w.prompt(info.id, 'before-rename', 'Ada'), undefined);
  await waitFor(f.typed, (s) => s.includes('before-rename'));
  assert.ok(typeof w.identity.update(info.id, { name: 'Lead Bee' }) === 'object');
  assert.equal(w.prompt(info.id, 'after-rename', 'Ada'), undefined);
  await waitFor(f.typed, (s) => s.includes('after-rename'));
  // How an agent finds a worker: the id always, and the name it has now (in any case or spacing), never the old one.
  const list = w.list();
  assert.equal((findWorker(list, info.id) as WorkerInfo).id, info.id);
  assert.equal((findWorker(list, 'lead bee') as WorkerInfo).id, info.id);
  assert.equal((findWorker(list, '  LEAD  BEE ') as WorkerInfo).id, info.id);
  assert.equal(typeof findWorker(list, 'Pixel'), 'string');
  assert.equal((findWorker(list, other.name) as WorkerInfo).id, other.id);
  // An id beats any name, including a legacy worker whose name happens to be another's id.
  const legacy = { ...list[0], id: 'aaaaaaaaaaaa', name: 'bbbbbbbbbbbb' } as WorkerInfo;
  const real = { ...list[1], id: 'bbbbbbbbbbbb', name: 'Real' } as WorkerInfo;
  assert.equal((findWorker([legacy, real], 'bbbbbbbbbbbb') as WorkerInfo).id, 'bbbbbbbbbbbb');
});

test('a task stays with its worker through a rename: the queue shows the new name for it while it is at its desk, and the old one once it has gone', async (t) => {
  const f = fixture(t);
  const w = f.manager();
  const events: QueueEvents = { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} };
  const queue = new TaskQueue(f.data, w, true, events);
  t.after(() => queue.shutdown());
  assert.equal(queue.add('queued work', 'Ada'), undefined);
  const running = (await waitFor(() => queue.state().tasks, (ts) => ts[0]?.status === 'running'))[0];
  const id = running.workerId!;
  assert.equal(running.workerName, 'Pixel');
  assert.ok(typeof w.identity.update(id, { name: 'Task Owner' }) === 'object');
  const after = queue.state().tasks[0];
  assert.equal(after.workerId, id);
  assert.equal(after.workerName, 'Task Owner');
  assert.equal(after.branch, running.branch);
  // Gone, the task keeps the name it was taken under (which is what that record said).
  await w.kill(id);
  assert.equal(queue.state().tasks[0].workerId, id);
  assert.equal(queue.state().tasks[0].workerName, 'Pixel');
});

test('a role can be changed on its own, and changing nothing says nothing', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w, { name: 'Steady' });
  const before = f.updates.length;
  const r = w.identity.update(info.id, { role: 'Engineering Chief' });
  assert.ok(typeof r === 'object', String(r));
  assert.deepEqual((r as { changed: string[] }).changed, ['role']);
  assert.equal(w.get(info.id)!.role, 'engineering-chief');
  assert.equal(w.get(info.id)!.name, 'Steady');
  assert.equal(f.updates.length, before + 1);
  // The same again: nothing changed, nothing sent, nothing saved over.
  const same = w.identity.update(info.id, { name: 'steady'.replace('s', 'S'), role: 'engineering-chief' });
  assert.deepEqual((same as { changed: string[] }).changed, []);
  assert.equal(f.updates.length, before + 1);
  assert.match(refused(w.identity.update(info.id, {})), /new name or a new role/);
  assert.match(refused(w.identity.update('nobody', { name: 'x' })), /No such worker/);
});

test('a rename or role that is refused changes nothing, and a name and role are applied together or not at all', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const a = hire(w, { name: 'Alpha', role: 'qa-engineer' });
  const b = hire(w, { name: 'Beta' });
  const sent = f.updates.length;
  for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(40) }, { name: '<i>' }, { name: 'beta' }, { name: 'Gamma', role: 'root' }, { name: 'BETA', role: 'reviewer' }, { role: 'nope' }]) {
    assert.equal(typeof w.identity.update(a.id, bad), 'string', JSON.stringify(bad));
  }
  assert.equal(w.get(a.id)!.name, 'Alpha');
  assert.equal(w.get(a.id)!.role, 'qa-engineer');
  assert.equal(w.get(b.id)!.name, 'Beta');
  assert.equal(f.updates.length, sent);
  // A worker can keep its own name (in another case) without clashing with itself.
  assert.deepEqual((w.identity.update(a.id, { name: 'ALPHA' }) as { changed: string[] }).changed, ['name']);
});

test('a shell can be renamed and keeps its mark, but takes no role; a board agent cannot be renamed', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const sh = w.spawn(free(w), 'Ada', undefined, false, 'shell') as WorkerInfo;
  const r = w.identity.update(sh.id, { name: 'Build Logs' });
  assert.ok(typeof r === 'object', String(r));
  assert.equal(w.get(sh.id)!.name, 'Build Logs 🐚');
  assert.match(refused(w.identity.update(sh.id, { role: 'qa-engineer' })), /no role/);
  const kiosk = [...DESK_BY_ID.values()].find((d) => d.station)!;
  const board = w.spawn(kiosk.id, 'Ada', 'x', false) as WorkerInfo;
  assert.match(refused(w.identity.update(board.id, { name: 'Boss' })), /fixed/);
  assert.match(refused(w.identity.update(board.id, { role: 'qa-engineer' })), /fixed/);
});

test('two people changing the same worker at once: the first wins and the second is told, not silently overwritten', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const a = hire(w, { name: 'Alpha' });
  const b = hire(w, { name: 'Beta' });
  // Two different workers to one name in the same moment: one gets it.
  const [one, two] = [w.identity.update(a.id, { name: 'Chief' }), w.identity.update(b.id, { name: 'chief' })];
  assert.equal(typeof one, 'object');
  assert.match(refused(two), /already called Chief/);
  assert.equal(w.get(b.id)!.name, 'Beta');
  // Two people editing one worker from the same page of it: the one that saw an older name is turned away.
  const first = w.identity.update(a.id, { name: 'Lead', expect: { name: 'Chief', role: DEFAULT_ROLE } });
  const second = w.identity.update(a.id, { name: 'Boss', expect: { name: 'Chief', role: DEFAULT_ROLE } });
  assert.equal(typeof first, 'object');
  assert.match(refused(second), /changed by someone else/);
  assert.equal(w.get(a.id)!.name, 'Lead');
  // The same for a role.
  assert.equal(typeof w.identity.update(a.id, { role: 'reviewer', expect: { role: DEFAULT_ROLE } }), 'object');
  assert.match(refused(w.identity.update(a.id, { role: 'researcher', expect: { role: DEFAULT_ROLE } })), /changed by someone else/);
  assert.equal(w.get(a.id)!.role, 'reviewer');
  // Many at once, in any order: no two workers ever end up with a name that can't be told apart.
  for (const x of [a, b, a, b]) for (const n of ['Zed', 'zed', 'Z E D']) w.identity.update(x.id, { name: n });
  assert.equal(new Set(w.list().map((i) => nameKey(i.name))).size, w.list().length);
});

// --- Floors, permissions, persistence --------------------------------------------------------------

test('only a worker on the floor you are on can be changed, found by its id', (t) => {
  const fa = fixture(t);
  const fb = fixture(t);
  const [ma, mb] = [fa.manager(), fb.manager()];
  const onA = hire(ma, { name: 'On A' });
  const onB = hire(mb, { name: 'On B' });
  const warns: (string | undefined)[] = [];
  const toasts: string[] = [];
  const floors = { a: { workers: ma }, b: { workers: mb } } as Record<string, unknown>;
  const ctx = { floorOf: (c: { peer: { floor: string } }) => floors[c.peer.floor], warn: (_c: unknown, e: string | undefined) => warns.push(e), toastFloor: (_f: unknown, text: string) => toasts.push(text) } as never;
  const onFloorA = { peer: { name: 'Ada', floor: 'a' } } as never;
  const handler = workerHandlers['worker.identity'];
  // Another floor's worker, by its id: out of reach, and untouched.
  handler(ctx, onFloorA, { t: 'worker.identity', workerId: onB.id, name: 'Hijacked', role: 'engineering-chief' });
  assert.deepEqual(warns, ['No such worker on this floor']);
  assert.equal(mb.get(onB.id)!.name, 'On B');
  assert.equal(mb.get(onB.id)!.role, DEFAULT_ROLE);
  // A name is not an id.
  handler(ctx, onFloorA, { t: 'worker.identity', workerId: 'On A', name: 'By Name' });
  assert.equal(warns.length, 2);
  assert.equal(ma.get(onA.id)!.name, 'On A');
  // Its own floor's, by id: done, and the floor is told by whom.
  handler(ctx, onFloorA, { t: 'worker.identity', workerId: onA.id, name: 'Renamed', role: 'Web Engineer', expect: { name: 'On A', role: DEFAULT_ROLE } });
  assert.equal(ma.get(onA.id)!.name, 'Renamed');
  assert.equal(ma.get(onA.id)!.role, 'web-engineer');
  assert.deepEqual(toasts, ['Ada renamed On A to Renamed and gave Renamed the Web Engineer role']);
  // Garbage in the message is refused as the same, not thrown.
  handler(ctx, onFloorA, { t: 'worker.identity', workerId: onA.id, name: { $ne: 1 } as never, expect: 5 as never });
  assert.equal(ma.get(onA.id)!.name, 'Renamed');
  // And no floor at all.
  handler(ctx, { peer: { name: 'Ada', floor: 'nowhere' } } as never, { t: 'worker.identity', workerId: onA.id, name: 'X' });
  assert.equal(ma.get(onA.id)!.name, 'Renamed');
});

test('a role is a label: nothing on the server decides what a worker may do by reading it', () => {
  const server = path.join(import.meta.dirname, '..', 'src', 'server');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(server);
  // Where a worker's own role is read or written: keeping it, saving it, listing it, saying so. A new place is a place to look at.
  const allowed = new Set(['workers/identity.ts', 'workers/persist.ts', 'office-workers.ts', 'ws/handlers/workers.ts']);
  const reads = files.filter((f) => /\b(workerRole|shownRole|savedRole)\b|\.info\.role\b/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(server, f).split(path.sep).join('/'));
  for (const f of reads) assert.ok(allowed.has(f), `${f} reads a worker's role: it is only a label (see shared/worker-identity.ts), so don't let it decide anything`);
  // The hire route's own checks do not take the asker's role into account.
  const hook = readFileSync(path.join(server, 'hooks', 'office-workers.ts'), 'utf8');
  assert.ok(!/(?<!ask)\.role\b/.test(hook.replace(/\/\/.*$/gm, '')), 'hooks/office-workers.ts decides by role');
});

test('a worker comes back after a restart with the same id, name, role and worktree', (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w, { name: 'Persistent — HQ', role: 'security-engineer' });
  assert.ok(typeof w.identity.update(info.id, { name: 'Renamed — HQ' }) === 'object');
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as { id: string; name: string; role: string }[];
  assert.deepEqual(saved.map((s) => [s.id, s.name, s.role]), [[info.id, 'Renamed — HQ', 'security-engineer']]);
  // The next office reads the same file.
  const next = f.manager();
  const back = next.get(info.id)!;
  assert.equal(back.name, 'Renamed — HQ');
  assert.equal(back.role, 'security-engineer');
  assert.deepEqual(back.worktree, info.worktree);
  assert.equal(back.status, 'offline');
  assert.equal(back.deskId, info.deskId);
});

test('workers saved before names and roles existed load with safe defaults, and what a newer office wrote is kept', (t) => {
  const f = fixture(t);
  const row = (id: string, more: Record<string, unknown>) => ({ id, kind: 'agent', provider: 'claude', deskId: 'desk-1', color: '#fff', createdBy: 'Ada', createdAt: 1, ...more });
  writeFileSync(
    path.join(f.data, 'workers.json'),
    JSON.stringify([
      row('000000000001', { name: 'Old Pixel' }),
      row('000000000002', { deskId: 'desk-2', name: 42, role: { admin: true } }),
      row('000000000003', { deskId: 'desk-3', name: '   ', role: 'future-role' }),
      row('000000000004', { deskId: 'desk-4', kind: 'shell', name: 'Logs 🐚', role: 'qa-engineer' }),
      row('000000000005', { deskId: 'desk-5', name: 'Mixed', role: 'Not A Role Id' }),
    ]),
  );
  const w = f.manager();
  const by = (id: string) => w.get(id)!;
  assert.equal(by('000000000001').name, 'Old Pixel');
  assert.equal(by('000000000001').role, DEFAULT_ROLE);
  assert.equal(by('000000000002').name, 'Worker');
  assert.equal(by('000000000002').role, DEFAULT_ROLE);
  assert.equal(by('000000000003').name, 'Worker');
  assert.equal(by('000000000003').role, 'future-role');
  assert.equal(shownRole(by('000000000003')), 'future-role');
  assert.equal(by('000000000004').role, undefined);
  assert.equal(shownRole(by('000000000004')), undefined);
  assert.equal(by('000000000005').role, DEFAULT_ROLE);
  // They are still workers: found, renamed, saved again, with the role a newer office gave kept.
  assert.ok(typeof w.identity.update('000000000001', { name: 'New Name' }) === 'object');
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as { id: string; name: string; role?: string }[];
  assert.equal(saved.find((s) => s.id === '000000000001')!.name, 'New Name');
  assert.equal(saved.find((s) => s.id === '000000000003')!.role, 'future-role');
});

test('sending a worker home still frees its desk, name and branch', async (t) => {
  const f = fixture(t);
  const w = f.manager();
  const info = hire(w, { name: 'Short Lived' });
  // (Keeping the worktree: on Windows a folder can't be deleted while the process that was in it is still going.)
  const result = await w.kill(info.id, 'keep');
  assert.equal(result.error, undefined, result.error);
  assert.equal(w.get(info.id), undefined);
  assert.equal(w.list().length, 0);
  assert.equal(w.deskOccupied(info.deskId), false);
  const saved = JSON.parse(readFileSync(path.join(f.data, 'workers.json'), 'utf8')) as unknown[];
  assert.deepEqual(saved, []);
  assert.equal(hire(w, { name: 'Short Lived' }).name, 'Short Lived');
});

// --- What agents see: the hook route, the CLI and the MCP tools -----------------------------------

test('a hire request from an agent may name and role the new worker, and says what is wrong when it is not allowed', () => {
  const ok = readHireRequest({ prompt: 'p', name: ' Backend Engineer — Galexii ', role: 'Backend Engineer' }, ['claude']);
  assert.deepEqual(ok, { prompt: 'p', name: 'Backend Engineer — Galexii', role: 'backend-engineer' });
  assert.deepEqual(readHireRequest({ prompt: 'p' }, ['claude']), { prompt: 'p' });
  assert.deepEqual(readHireRequest({ prompt: 'p', name: '', role: ' ' }, ['claude']), { prompt: 'p' });
  assert.match(String(readHireRequest({ prompt: 'p', name: '<b>' }, ['claude'])), /letters, numbers/);
  assert.match(String(readHireRequest({ prompt: 'p', name: 'x'.repeat(99) }, ['claude'])), /at most 32/);
  assert.match(String(readHireRequest({ prompt: 'p', name: 12 }, ['claude'])), /name is text/);
  assert.match(String(readHireRequest({ prompt: 'p', role: 'root' }, ['claude'])), /role is one of/);
});

const worker = (more: Partial<WorkerInfo>): WorkerInfo => ({ id: 'aaaaaaaaaaaa', kind: 'agent', deskId: 'desk-1', name: 'Pixel', color: '#fff', status: 'idle', acked: true, createdBy: 'Ada', createdAt: 0, cols: 80, rows: 24, viewers: [], ...more });
const view: PullsView = { pulls: [], tasks: [] };

test('the list shows each agent its workers by id, name and role; a shell and a board agent have none', () => {
  const kiosk = [...DESK_BY_ID.values()].find((d) => d.station)!;
  const chief = workerRow(worker({ role: 'engineering-chief', name: 'Chief — Galexii' }), view);
  assert.equal(chief.id, 'aaaaaaaaaaaa');
  assert.equal(chief.name, 'Chief — Galexii');
  assert.equal(chief.role, 'engineering-chief');
  assert.equal(chief.roleLabel, 'Engineering Chief');
  // Saved before roles: the default.
  assert.equal(workerRow(worker({}), view).role, DEFAULT_ROLE);
  assert.equal(workerRow(worker({ kind: 'shell', name: 'Logs 🐚' }), view).role, undefined);
  assert.equal(workerRow(worker({ deskId: kiosk.id }), view).role, undefined);
  assert.match(formatWorker(chief), /Chief — Galexii \(.*Engineering Chief\)/);
  assert.doesNotMatch(formatWorker(workerRow(worker({}), view)), /General Worker/);
});

test('office-workers hire takes a name and a role, and its tool says which roles there are', () => {
  assert.deepEqual(parseArgs(['hire', '--name', 'Backend Engineer — Galexii', '--role', 'backend-engineer', '--prompt', 'x']), { cmd: 'hire', json: false, prompt: 'x', name: 'Backend Engineer — Galexii', role: 'backend-engineer' });
  assert.deepEqual(parseArgs(['hire', '--name=Chief', '--role=reviewer']), { cmd: 'hire', json: false, name: 'Chief', role: 'reviewer' });
  const hireTool = TOOLS.find((t) => t.name === 'hire_worker')!;
  const props = hireTool.inputSchema.properties as Record<string, { type: string; enum?: string[]; maxLength?: number }>;
  assert.equal(props.name.type, 'string');
  assert.equal(props.name.maxLength, NAME_MAX);
  assert.deepEqual(props.role.enum, ROLES);
  // The CLI has no build step, so its list is its own: it must be the office's.
  assert.deepEqual(ROLES, WORKER_ROLES.map((r) => r.id));
  // No tool renames a worker or changes its role: that is for the people at the office.
  assert.deepEqual(TOOLS.filter((t) => /rename|role|identity|name/i.test(t.name)), []);
  // And the tools that take a worker say that the id is the one to use.
  assert.match(TOOLS.find((t) => t.name === 'tell_worker')!.description, /Use the id/);
});

test('names and roles are drawn as text everywhere the page shows them', () => {
  const client = path.join(import.meta.dirname, '..', 'src', 'client');
  for (const f of ['ui/identity.ts', 'ui/workers-panel.ts', 'ui/prompt.ts', 'ui/terminal.ts', 'lite.ts', 'features/workers/actions.ts', 'features/workers/views.ts']) {
    const src = readFileSync(path.join(client, f), 'utf8');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src), `${f} puts text in as markup`);
  }
});
