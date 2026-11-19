import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/server/usage.js';
import { WorkerManager, type WorkerEvents } from '../src/server/workers.js';
import { nextFreeSeat } from '../src/shared/layout.js';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { identityRequest, nameKey, parseWorkerName, type SeenWorker } from '../src/shared/worker-identity.js';

// Names that look the same must not be two names (and an id must not pass as a name), and a window that
// asks for a change asks about what it was opened on, not what the worker is by the time it is saved.

const ok = (name: string) => assert.deepEqual(parseWorkerName(name), { name }, JSON.stringify(name));
const bad = (name: string) => assert.ok('error' in parseWorkerName(name), `${JSON.stringify(name)} was accepted`);

test('a name cannot hide a joiner, a variation selector, a filler or a combining joiner in it to look like another', () => {
  // The cases a reviewer showed: each one is "Pixel" to the eye.
  bad('Pi\u200Dxel'); // zero-width joiner in a Latin word
  bad('Pixel\uFE0F'); // emoji variation selector after a letter
  bad('Pi\u034Fxel'); // combining grapheme joiner
  // And the others that take no room on the line.
  for (const hidden of ['\u200C', '\u200B', '\u2060', '\u2064', '\u00AD', '\uFEFF', '\u3164', '\u115F', '\u1160', '\uFFA0', '\uFE0E', '\u180B', '\u17B4', '\u061C', '\u200E', '\u202E', '\u{E0100}', '\u{E0041}']) {
    bad(`Pi${hidden}xel`);
    bad(`${hidden}Pixel`);
    bad(`Pixel${hidden}`);
  }
  // A joiner or selector with nothing to join, or joining what isn't an emoji.
  bad('a\u200D');
  bad('\u200D\u{1F469}');
  bad('\u{1F469}\u200Dx');
  bad('x\u200D\u{1F52C}');
  bad('\u200Cx');
  // A non-joiner between Latin, Cyrillic or Greek letters has no job either.
  bad('Pi\u200Cxel');
  bad('\u041F\u200C\u0440');
});

test('what the invisible characters are for still works: emoji sequences, skin tones, keycaps, flags and a Persian word', () => {
  for (const name of ['\u{1F469}\u200D\u{1F52C} Ada', '❤\uFE0F Ada', '1\uFE0F⃣ one', '\u{1F3F3}\uFE0F\u200D\u{1F308} Pride', '\u{1F44D}\u{1F3FD} ok', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Family', '\u{1F1FA}\u{1F1F8} Team', 'نامه\u200Cها', 'José', '李雷', '\u0410\u043B\u0435\u043A\u0441\u0435\u0439']) ok(name);
});

test('a worker id written in fullwidth or spaced out is still a worker id, and so is one in lookalike letters', () => {
  bad('a1b2c3d4e5f6');
  bad('A1B2C3D4E5F6');
  bad('\uFF41\uFF11\uFF42\uFF12\uFF43\uFF13\uFF44\uFF14\uFF45\uFF15\uFF46\uFF16'); // fullwidth
  bad('a1b2 c3d4 e5f6');
  bad('0123456789ab');
  // Not an id: too short, too long, or not hex.
  ok('a1b2c3d4e5f');
  ok('a1b2c3d4e5f67');
  ok('g1b2c3d4e5f6');
});

test('names that look the same have the same key, and ones that look different do not', () => {
  const pixel = nameKey('Pixel');
  for (const same of ['pixel', 'PIXEL', 'P i x e l', 'Pi\u200Dxel', 'Pixel\uFE0F', 'Pi\u034Fxel', 'Pi\u3164xel', 'Pi\u115Fxel', 'Pi\u00ADxel', 'Pi\u202Exel', '\uFF30\uFF49\uFF58\uFF45\uFF4C', 'Pixel \u{1F41A}']) assert.equal(nameKey(same), pixel, JSON.stringify(same));
  // A whole word in Cyrillic or Greek drawn like a Latin one.
  assert.equal(nameKey('\u0430\u0441\u0435'), nameKey('ace'));
  assert.equal(nameKey('\u03BF\u03BF'), nameKey('oo'));
  // What really is different stays so.
  for (const different of ['Pixe', 'Pixel2', 'Pi-xel', 'Pi.xel', 'Píxel', 'A+']) assert.notEqual(nameKey(different), pixel, different);
  assert.notEqual(nameKey('A+'), nameKey('A'));
  // And an emoji sequence is one name however the joiner is written.
  assert.equal(nameKey('\u{1F469}\u200D\u{1F52C}'), nameKey('\u{1F469}\u{1F52C}'));
});

// --- Through the manager, where the names are kept --------------------------------------------------------

function floor(t: { after(fn: () => void): void }, saved: object[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'ao-spoof-'));
  const data = path.join(root, '.agent-office');
  mkdirSync(data, { recursive: true });
  const script = path.join(root, 'agent.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  if (saved.length) writeFileSync(path.join(data, 'workers.json'), JSON.stringify(saved));
  const events: WorkerEvents = { update() {}, remove() {}, data() {}, screen() {}, toast() {} };
  const manager = new WorkerManager(root, data, process.execPath, [script], { url: 'http://127.0.0.1:1', token: '' }, events, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
  t.after(() => {
    manager.shutdown();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows keeps a folder while a process that was in it is still going.
    }
  });
  return manager;
}
const seat = (m: WorkerManager) => nextFreeSeat((id) => m.deskOccupied(id), 0)!.id;
const hire = (m: WorkerManager, name: string) => m.spawn(seat(m), 'Ada', undefined, false, 'agent', undefined, undefined, undefined, undefined, undefined, [], undefined, { name });
const legacy = (id: string, deskId: string, name: string) => ({ id, kind: 'agent', provider: 'claude', deskId, name, color: '#fff', createdBy: 'Ada', createdAt: 1 });

test('a name that is "Pixel" to the eye cannot be taken beside a Pixel that is already there, however it is made', (t) => {
  const m = floor(t, [legacy('000000000001', 'desk-1', 'Pi\u200Dxel'), legacy('000000000002', 'desk-2', '\u0430\u0441\u0435')]);
  // Names kept by an older office can have anything in them: they still count as what they look like.
  for (const twin of ['Pixel', 'pixel', '\uFF30\uFF29\uFF38\uFF25\uFF2C', 'P i x e l']) assert.match(String(hire(m, twin)), /already called/, twin);
  assert.match(String(hire(m, 'ace')), /already called/);
  assert.match(String(hire(m, 'ACE')), /already called/);
  assert.equal(m.list().length, 2);
  // Another name is free.
  assert.equal(typeof hire(m, 'Pixels'), 'object');
});

test('a worker cannot be renamed to look like another, and the refusal changes nothing', (t) => {
  const m = floor(t);
  const first = hire(m, 'Pixel') as WorkerInfo;
  const second = hire(m, 'Byte') as WorkerInfo;
  // Ones the parser lets through (a different spelling of the same name): refused as a clash.
  for (const twin of ['\uFF30\uFF29\uFF38\uFF25\uFF2C', 'pixel', 'P I X E L']) {
    const r = m.identity.update(second.id, { name: twin });
    assert.match(String(r), /already called Pixel/, twin);
  }
  // Ones it does not: refused as invalid.
  for (const hidden of ['Pi\u200Dxel', 'Pixel\uFE0F', 'Pi\u034Fxel']) assert.ok(typeof m.identity.update(second.id, { name: hidden }) === 'string', hidden);
  assert.equal(m.get(second.id)!.name, 'Byte');
  assert.equal(m.get(first.id)!.name, 'Pixel');
  // Two new hires cannot be the same name written two ways either.
  assert.match(String(hire(m, '\u0430\u0441\u0435')), /^(?!.*already)/); // "ace" in Cyrillic is free while no Latin "ace" is here
  assert.match(String(hire(m, 'ace')), /already called/);
});

// --- A window asks about what it opened on ----------------------------------------------------------------

const seen = (more: Partial<SeenWorker> = {}): SeenWorker => Object.freeze({ id: 'aaaaaaaaaaaa', kind: 'agent', name: 'Alpha', role: 'general-worker', ...more });

test('the rename window asks only for what changed, and says what it saw', () => {
  assert.deepEqual(identityRequest(seen(), { name: 'Beta' }), { t: 'worker.identity', workerId: 'aaaaaaaaaaaa', name: 'Beta', expect: { name: 'Alpha', role: 'general-worker' } });
  assert.deepEqual(identityRequest(seen(), { role: 'reviewer' }), { t: 'worker.identity', workerId: 'aaaaaaaaaaaa', role: 'reviewer', expect: { name: 'Alpha', role: 'general-worker' } });
  assert.deepEqual(identityRequest(seen(), { name: 'Beta', role: 'reviewer' }), { t: 'worker.identity', workerId: 'aaaaaaaaaaaa', name: 'Beta', role: 'reviewer', expect: { name: 'Alpha', role: 'general-worker' } });
  // Nothing changed (same name, same role, or neither given): nothing is sent.
  assert.equal(identityRequest(seen(), { name: 'Alpha', role: 'general-worker' }), undefined);
  assert.equal(identityRequest(seen(), {}), undefined);
  // A shell has no role, and keeps its mark out of what is typed but not out of what it saw.
  const shell = seen({ kind: 'shell', name: 'Logs \u{1F41A}', role: 'general-worker' });
  assert.deepEqual(identityRequest(shell, { name: 'Build Logs', role: 'reviewer' }), { t: 'worker.identity', workerId: 'aaaaaaaaaaaa', name: 'Build Logs', expect: { name: 'Logs \u{1F41A}' } });
  assert.equal(identityRequest(shell, { name: 'Logs' }), undefined);
});

test('a window opened on an old name cannot overwrite what somebody else did meanwhile, whatever the page has since heard', (t) => {
  const m = floor(t);
  const info = hire(m, 'Alpha') as WorkerInfo;
  // Both people open the window on "Alpha", the page's own copy of the worker frozen as it opens.
  const live = { ...m.get(info.id)!, role: 'general-worker' };
  const mine = seen({ id: info.id, name: live.name, role: live.role });
  const theirs = seen({ id: info.id, name: live.name, role: live.role });
  // Theirs is saved first.
  const first = identityRequest(theirs, { name: 'Their Name', role: 'reviewer' })!;
  assert.equal(typeof m.identity.update(first.workerId, { name: first.name, role: first.role, expect: first.expect }), 'object');
  // Meanwhile this page's copy of the worker is brought up to date IN PLACE (as it would be if the page changed a worker's record rather than replacing it).
  Object.assign(live, m.get(info.id)!);
  assert.equal(live.name, 'Their Name');
  // Mine is saved second: it still says it saw "Alpha", so it is refused, and nothing of it is applied.
  const second = identityRequest(mine, { name: 'My Name', role: 'researcher' })!;
  assert.deepEqual(second.expect, { name: 'Alpha', role: 'general-worker' });
  assert.match(String(m.identity.update(second.workerId, { name: second.name, role: second.role, expect: second.expect })), /changed by someone else/);
  assert.equal(m.get(info.id)!.name, 'Their Name');
  assert.equal(m.get(info.id)!.role, 'reviewer');
  // The same for a role alone.
  const roleOnly = identityRequest(mine, { role: 'researcher' })!;
  assert.match(String(m.identity.update(roleOnly.workerId, { role: roleOnly.role, expect: roleOnly.expect })), /changed by someone else/);
  assert.equal(m.get(info.id)!.role, 'reviewer');
  // Opening the window again shows what is there now, and that goes through.
  const again = identityRequest(seen({ id: info.id, name: 'Their Name', role: 'reviewer' }), { name: 'Agreed Name' })!;
  assert.equal(typeof m.identity.update(again.workerId, { name: again.name, expect: again.expect }), 'object');
  assert.equal(m.get(info.id)!.name, 'Agreed Name');
});
