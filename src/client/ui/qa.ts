// 🧪 QA: where each open pull request of this floor stands, with the evidence behind it. The office works
// it out from the board it already syncs (shared/qa.ts); this window only asks and shows. A pull request is
// "ready" only for a person to merge: nothing here merges, and a green build is not a review.
import './qa.css';
import type { PrAssessment, QaState, QaViewState, ReviewerOffer, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from './dom';
import { mergeView, type MergeView } from './merge';

interface Open {
  state?: QaViewState;
  offers: Map<number, ReviewerOffer>;
  /** The pull request whose "record a review" form is open. */
  recording?: number;
  merge?: MergeView;
  draw(): void;
}
let open: Open | null = null;

/** The office's answers to this window; ignored when it isn't open. */
export function routeQaMessage(msg: ServerMsg) {
  if (!open) return;
  if (open.merge?.route(msg)) return;
  if (msg.t === 'qa.state') open.state = msg.state;
  else if (msg.t === 'qa.reviewers') open.offers.set(msg.offer.pr, msg.offer);
  else if (msg.t === 'qa.result') {
    toast(msg.message, msg.ok ? 'info' : 'warn');
    if (msg.ok) open.offers.delete(msg.pr);
  } else return;
  open.draw();
}

const SECTIONS: { title: string; note: string; pick: (p: PrAssessment) => boolean }[] = [
  { title: '⏳ Awaiting checks', note: 'Checks running or not reported, or still a draft.', pick: (p) => p.state === 'awaiting' },
  { title: '❌ Failed', note: 'A check failed or it cannot merge cleanly.', pick: (p) => p.state === 'failed' },
  { title: '🔎 Needs an independent review', note: 'Its checks pass, but no review of this commit counts yet.', pick: (p) => p.state === 'needs-review' },
  { title: '📝 Review evidence on file', note: 'A review of the current commit that counts, whatever else it still needs.', pick: (p) => p.evidence.some((e) => e.status === 'counts') },
  { title: '✅ Ready for a person to merge', note: 'Checks of this exact commit pass and an independent review of it stands. Nothing merges by itself.', pick: (p) => p.state === 'ready' },
  { title: '🛡️ Blocked by security or policy', note: 'A rule needs a person, or a review asked for changes.', pick: (p) => p.state === 'blocked' },
];

const STATE_LABEL: Record<QaState, string> = { awaiting: 'Awaiting checks', failed: 'Failed', 'needs-review': 'Needs review', blocked: 'Blocked', ready: 'Ready for human merge' };

export function openQa(net: Net) {
  const body = h('div.body.qa');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const refresh = h('button.btn', { type: 'button', title: 'Ask GitHub again now', onclick: () => net.send({ t: 'gh.refresh' }) }, '🔄 Refresh');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'QA', style: 'width:min(920px,100%)' }, h('header', {}, h('h2', {}, '🧪 QA'), refresh, close), body, h('footer', {}, h('span.grow', {}, 'It updates when GitHub is read, never on a timer of its own, and costs no model usage. A review counts only for the commit it was about. Humans merge.')));
  const state: Open = { offers: new Map(), draw: () => render() };
  open = state;
  state.merge = mergeView(net, () => render());
  const ask = () => {
    net.send({ t: 'qa.state' });
    state.merge?.ask();
  };
  const admin = () => store.me.admin;

  const chip = (text: string, cls = '') => h('span.qa-chip', { class: cls }, text);

  const record = (p: PrAssessment) => {
    const verdict = h('select', { 'aria-label': 'Verdict' }, h('option', { value: 'approve' }, 'Approve'), h('option', { value: 'changes' }, 'Changes requested'), h('option', { value: 'comment' }, 'Comment only')) as HTMLSelectElement;
    const ref = h('input', { type: 'text', placeholder: 'QA Director review id, or a note (optional)', maxlength: 200, 'aria-label': 'Reference' }) as HTMLInputElement;
    const sum = h('textarea', { rows: 2, placeholder: 'What was checked (optional)', maxlength: 2000, 'aria-label': 'Summary' }) as HTMLTextAreaElement;
    const send = h('button.btn.primary', { type: 'button' }, `Record for ${p.sha.slice(0, 7)}`);
    send.addEventListener('click', () => {
      net.send({ t: 'qa.attest', pr: p.number, sha: p.sha, verdict: verdict.value as 'approve', reference: ref.value, summary: sum.value });
      state.recording = undefined;
    });
    return h('div.qa-record', {}, h('p.note', {}, 'Record only a verdict a person reached, or imported from the QA Director desk. It is about this commit and stops counting when the head moves.'), verdict, ref, sum, send);
  };

  const offerOf = (p: PrAssessment) => {
    const o = state.offers.get(p.number);
    if (!o) return null;
    if (o.sha !== p.sha) return h('p.note.warn', {}, 'The head changed: look for reviewers again.');
    return h(
      'div.qa-offer',
      {},
      o.candidates.length
        ? h('ol', {}, ...o.candidates.map((c, i) => h('li', {}, h('b', {}, c.name), ` · ${c.roleLabel}${c.provider ? ` · ${c.provider}` : ''}`, i === 0 ? chip('best match', 'good') : null, h('div.reason', {}, c.reasons.join(' · ')), admin() ? h('button.btn.primary', { type: 'button', onclick: () => net.send({ t: 'qa.assign', pr: p.number, sha: p.sha, workerId: c.workerId }) }, `Give the review to ${c.name}`) : null)))
        : null,
      o.pending ? h('p.note.warn', { role: 'status' }, o.pending) : null,
      o.blocked.length ? h('details', {}, h('summary', {}, `${o.blocked.length} that cannot take it`), h('ul', {}, ...o.blocked.map((b) => h('li', {}, h('b', {}, b.name), `: ${b.reasons.join('; ')}`)))) : null,
    );
  };

  const card = (p: PrAssessment): HTMLElement => {
    const c = p.checks;
    const counts = `${c.passed} passed · ${c.failed} failed · ${c.pending} pending${c.missing.length ? ` · not reported: ${c.missing.join(', ')}` : ''}`;
    const flags = [p.draft ? chip('draft', 'warn') : null, p.conflicts ? chip('conflicts', 'bad') : null, p.fork ? chip('fork', 'warn') : null, ...p.risk.filter((r) => r !== 'source' && r !== 'other').map((r) => chip(r, ['ci-workflow', 'install', 'dependencies', 'security', 'unknown'].includes(r) ? 'warn' : ''))];
    return h(
      'li',
      { class: `qa-pr ${p.state}` },
      h('div.qa-head', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number} ${p.title}`), chip(STATE_LABEL[p.state], p.state), h('code', { title: 'The exact commit everything here is about' }, p.sha.slice(0, 7)), ...flags),
      h('ul.qa-reasons', {}, ...p.reasons.map((r) => h('li', {}, r))),
      h('div.reason', {}, `Checks (${c.source === 'commit' ? 'of exactly this commit, from GitHub' : 'from the board'}): ${counts}`, ...c.items.filter((x) => x.url).slice(0, 8).flatMap((x) => [' · ', h('a', { href: x.url, target: '_blank', rel: 'noopener', title: `${x.name}: ${x.state}` }, x.name)])),
      h('div.reason', {}, p.authorsKnown ? `Did the work (by the office's records): ${p.authors.join(', ')}` : "Who did the work is not known to the office, so a worker's review cannot be shown independent."),
      ...p.evidence.map((e) => h('div.qa-evidence', { class: e.status }, `${e.kind === 'human' ? `🧑 ${e.by ?? 'a person'}` : `🤖 ${e.reviewerName ?? 'a worker'}${e.reviewerProvider ? ` (${e.reviewerProvider})` : ''}`}: ${e.verdict} for ${e.sha.slice(0, 7)}`, chip(e.status === 'counts' ? 'counts' : e.status, e.status === 'counts' ? 'good' : 'warn'), e.crossProvider === true ? chip('cross-provider') : null, e.why ? h('span.reason', {}, ` ${e.why}`) : null, e.reference ? h('span.reason', {}, ` ref: ${e.reference}`) : null)),
      p.assigned ? h('div.reason', {}, `🤖 ${p.assigned.workerName} has the review and has not answered.`) : null,
      state.merge?.badge(p.number) ?? null,
      p.state === 'needs-review' || p.state === 'blocked' || p.state === 'awaiting'
        ? h('div.qa-actions', {}, p.state === 'needs-review' && !p.assigned ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'qa.reviewers', pr: p.number }) }, '🔍 Find a reviewer') : null, admin() ? h('button.btn', { type: 'button', onclick: () => ((state.recording = state.recording === p.number ? undefined : p.number), render()) }, '🧑 Record a review') : null)
        : null,
      state.recording === p.number ? record(p) : null,
      offerOf(p),
    );
  };

  const render = () => {
    const s = state.state;
    const kids: (Node | null)[] = [state.merge?.panel() ?? null];
    if (!s) kids.push(h('p.note', {}, 'Looking…'));
    else if (!s.prs.length) kids.push(h('p.note', {}, 'No open pull requests on this floor (or GitHub has not been read yet).'));
    else {
      if (!s.policy.requiredKnown) kids.push(h('p.note', {}, "The repository did not say which checks are required, so every check that reported must pass, and at least one must."));
      for (const sec of SECTIONS) {
        const list = s.prs.filter(sec.pick);
        if (!list.length) continue;
        kids.push(h('h4', {}, sec.title, h('span.count', {}, String(list.length))), h('p.note', {}, sec.note), h('ul.qa-list', {}, ...list.map(card)));
      }
    }
    body.replaceChildren(...kids.filter((n): n is Node => n !== null));
  };

  // The office pushes a fresh answer whenever it has read GitHub, so there is nothing to poll or subscribe to here.
  const modal = openModal(el, { doing: '🧪 checking pull requests', onClose: () => { if (open === state) open = null; } });
  close.addEventListener('click', () => modal.close());
  render();
  ask();
}
