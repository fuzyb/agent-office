// The owner's controls for automatic merging, inside the QA view: whether it is available at all, the policy of
// this floor's repository, the emergency stop, what waits for a person's approval, and the permanent record. Everything
// is shown, nothing is hidden: it is off unless the operator opened the gate AND an admin turned it on with a written
// authorization. Nothing here can be reached by an agent.
import type { MergeMode, MergePr, MergeViewState, ServerMsg } from '../../shared/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo, toast } from './dom';

const MODE_LABEL: Record<MergeMode, string> = { off: 'Off', approve: 'On: a person approves each commit', auto: 'On: merges by itself when everything passes' };

export interface MergeView {
  /** The office's answers about merging; whether it was one. */
  route(msg: ServerMsg): boolean;
  /** The panel for the top of the QA view. */
  panel(): HTMLElement;
  /** What to say about one pull request. */
  badge(pr: number): HTMLElement | null;
  ask(): void;
}

export function mergeView(net: Net, draw: () => void): MergeView {
  let state: MergeViewState | undefined;
  const admin = () => store.me.admin;

  const route = (msg: ServerMsg): boolean => {
    if (msg.t === 'merge.state') state = msg.state;
    else if (msg.t === 'merge.result') toast(msg.message, msg.ok ? 'info' : 'warn');
    else return false;
    draw();
    return true;
  };

  const find = (n: number): MergePr | undefined => state?.prs.find((p) => p.number === n);

  const badge = (n: number): HTMLElement | null => {
    const p = find(n);
    if (!state?.gate || !p) return null;
    const text = p.status === 'human' ? `🧑 needs a person to merge: ${p.reasons[0]}` : p.status === 'awaiting-approval' ? '⏳ eligible for automatic merging: waiting for a person to approve this commit' : p.status === 'merged' ? '🔀 merged automatically' : p.status === 'queued' ? '🤖 eligible for automatic merging' : p.status === 'blocked' ? `⛔ refused at the last check: ${p.reasons[0]}` : `· not yet (${p.reasons[0] ?? p.qa})`;
    return h('div.reason', {}, text, p.status === 'awaiting-approval' && admin() ? h('button.btn.primary', { type: 'button', onclick: () => net.send({ t: 'merge.approve', pr: p.number, sha: p.sha }) }, `Approve merging ${p.sha.slice(0, 7)}`) : null, p.approval ? h('span', {}, ` approved by ${p.approval.by}`) : null);
  };

  const panel = (): HTMLElement => {
    if (!state) return h('div.qa-merge', {}, h('p.note', {}, 'Automatic merging: looking…'));
    if (!state.gate) return h('div.qa-merge', {}, h('p.note', {}, '🔒 Automatic merging is not available in this installation: whoever starts the office has not enabled it. A person merges every pull request.'));
    const pol = state.policy;
    const mode = h('select', { 'aria-label': 'Mode' }, ...(['off', 'approve', 'auto'] as MergeMode[]).map((m) => h('option', { value: m }, MODE_LABEL[m]))) as HTMLSelectElement;
    mode.value = pol?.mode ?? 'off';
    const auth = h('input', { type: 'text', placeholder: 'What authorizes this: a link or reference to the owner’s governance record', value: pol?.authorization ?? '', maxlength: 300, 'aria-label': 'Authorization' }) as HTMLInputElement;
    const method = h('select', { 'aria-label': 'Merge method' }, ...['squash', 'merge', 'rebase'].map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
    method.value = pol?.method ?? 'squash';
    const bases = h('input', { type: 'text', value: (pol?.bases ?? ['main']).join(', '), 'aria-label': 'Branches' }) as HTMLInputElement;
    const extra = h('input', { type: 'text', value: (pol?.extraLowRisk ?? []).join(', '), placeholder: 'Extra low-risk paths, e.g. src/client/ui/**', 'aria-label': 'Extra low-risk paths' }) as HTMLInputElement;
    const save = h('button.btn.primary', { type: 'button' }, 'Save policy');
    save.addEventListener('click', () => net.send({ t: 'merge.policy', mode: mode.value as MergeMode, authorization: auth.value, method: method.value as 'squash', bases: bases.value.split(',').map((s) => s.trim()).filter(Boolean), extraLowRisk: extra.value.split(',').map((s) => s.trim()).filter(Boolean) }));
    const waiting = state.prs.filter((p) => p.status === 'awaiting-approval');
    return h(
      'div.qa-merge',
      {},
      h('h4', {}, '🔀 Automatic merging', h('span.count', {}, state.repo ?? 'no repository')),
      state.stopped ? h('p.note.warn', { role: 'alert' }, `🛑 Emergency stop: ${state.stopped.by} stopped all automatic merging ${timeAgo(state.stopped.at)}${state.stopped.reason ? ` (${state.stopped.reason})` : ''}.`, admin() ? h('button.btn', { type: 'button', onclick: () => net.send({ t: 'merge.resume' }) }, 'Resume') : null) : null,
      h('p.note', {}, `${state.repo ?? 'This floor'}: ${pol ? MODE_LABEL[pol.mode] : 'off'}.`, pol ? ` Authorized by ${pol.authorizedBy} ${timeAgo(pol.authorizedAt)}: ${pol.authorization}.` : ' Nothing merges unless an admin turns it on with a written authorization.', ' Only documentation, tests and paths marked low-risk qualify; CI, installs, dependencies, security, configuration and unknown files always need a person. Every merge is asked about again, from GitHub, just before.'),
      h('div.qa-actions', {}, h('button.btn', { type: 'button', title: 'Stops every automatic merge in the office at once', onclick: () => net.send({ t: 'merge.stop' }) }, '🛑 Emergency stop')),
      admin() && state.repo ? h('div.qa-record', {}, mode, auth, method, bases, extra, save) : h('p.note', {}, 'Only admins change the policy.'),
      state.allowlist.length ? h('p.note', {}, `Switched on for: ${state.allowlist.map((a) => `${a.repo} (${a.mode})`).join(', ')}`) : null,
      waiting.length ? h('div', {}, h('h4', {}, '⏳ Waiting for your approval', h('span.count', {}, String(waiting.length))), h('ul', {}, ...waiting.map((p) => h('li', {}, h('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number} ${p.title}`), ` at ${p.sha.slice(0, 7)} `, admin() ? h('button.btn.primary', { type: 'button', onclick: () => net.send({ t: 'merge.approve', pr: p.number, sha: p.sha }) }, 'Approve') : null)))) : null,
      state.audit.length ? h('details', {}, h('summary', {}, `Record of decisions, attempts and merges (${state.audit.length} latest)`), h('ul.qa-reasons', {}, ...state.audit.slice().reverse().map((e) => h('li', {}, `${new Date(e.at).toLocaleString()} · ${e.kind}${e.pr ? ` #${e.pr}` : ''}${e.sha ? ` @${e.sha.slice(0, 7)}` : ''} · ${e.by}${e.ok === false ? ' · refused' : ''}${e.reasons?.[0] ? `: ${e.reasons[0]}` : ''}`)))) : null,
    );
  };

  return { route, panel, badge, ask: () => net.send({ t: 'merge.state' }) };
}
