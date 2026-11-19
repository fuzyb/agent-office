// Controlled automatic merging (server/merge/), from the browser only. Turning it on, approving a commit and resuming
// after a stop are admins'; the emergency stop is anyone's, because it can only make things safer. Every refusal
// is written to the audit. The repository is always the floor's own: no message names another.
import { num, str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap } from './types.js';
import type { MergeClientMsg } from '../../../shared/protocol.js';

const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 120)).slice(0, max) : []);

export const mergeHandlers = {
  'merge.state'(ctx, c) {
    const floor = here(ctx, c);
    if (floor) ctx.sendTo(c, { t: 'merge.state', state: floor.merge.state() });
  },
  'merge.policy'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) {
      floor.merge.denied(who, 'change the automatic merge policy');
      return ctx.sendTo(c, { t: 'merge.result', ok: false, message: 'Only admins can change the automatic merge policy' });
    }
    const r = floor.merge.setPolicy(who, { mode: msg.mode, authorization: str(msg.authorization, 300), method: str(msg.method, 10) || undefined, bases: strings(msg.bases, 10), maxChangedLines: num(msg.maxChangedLines) || undefined, maxFiles: num(msg.maxFiles) || undefined, extraLowRisk: strings(msg.extraLowRisk, 20) });
    ctx.sendTo(c, { t: 'merge.result', ok: r.ok, message: r.message });
  },
  async 'merge.approve'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const who = c.peer.name;
    if (!ctx.meOf(c.accountId).admin) {
      floor.merge.denied(who, `approve PR #${num(msg.pr)}`);
      return ctx.sendTo(c, { t: 'merge.result', ok: false, message: 'Only admins can approve an automatic merge' });
    }
    const r = await floor.merge.approve(num(msg.pr), str(msg.sha, 64), who);
    ctx.sendTo(c, { t: 'merge.result', ok: r.ok, message: r.message });
  },
  'merge.revoke'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    if (!ctx.meOf(c.accountId).admin) return ctx.sendTo(c, { t: 'merge.result', ok: false, message: 'Only admins can withdraw an approval' });
    const r = floor.merge.revoke(num(msg.pr), c.peer.name);
    ctx.sendTo(c, { t: 'merge.result', ok: r.ok, message: r.message });
  },
  'merge.stop'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const r = floor.merge.stop(c.peer.name, str(msg.reason, 200) || undefined);
    ctx.sendTo(c, { t: 'merge.result', ok: r.ok, message: r.message });
    ctx.toastFloor(floor, `🛑 ${c.peer.name} stopped automatic merging`);
  },
  'merge.resume'(ctx, c) {
    const floor = here(ctx, c);
    if (!floor) return;
    if (!ctx.meOf(c.accountId).admin) {
      floor.merge.denied(c.peer.name, 'resume automatic merging');
      return ctx.sendTo(c, { t: 'merge.result', ok: false, message: 'Only admins can resume automatic merging' });
    }
    const r = floor.merge.resume(c.peer.name);
    ctx.sendTo(c, { t: 'merge.result', ok: r.ok, message: r.message });
  },
} satisfies HandlerMap<MergeClientMsg>;
