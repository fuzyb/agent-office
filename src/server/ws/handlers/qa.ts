// The QA view (server/qa/): where each pull request on this floor stands, who could review one, and giving
// or recording a review. Looking is for anyone on the floor; giving a review to a worker and recording one
// are admins', because they are what lets a pull request count as reviewed. The floor is the one the person is on.
import { str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap } from './types.js';
import type { QaClientMsg } from '../../../shared/protocol.js';

const pr = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 0);

export const qaHandlers = {
  'qa.state'(ctx, c) {
    const floor = here(ctx, c);
    if (floor) ctx.sendTo(c, { t: 'qa.state', state: floor.qa.state() });
  },
  'qa.reviewers'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const n = pr(msg.pr);
    const offer = floor.qa.offer(n);
    if (typeof offer === 'string') ctx.sendTo(c, { t: 'qa.result', pr: n, ok: false, message: offer });
    else ctx.sendTo(c, { t: 'qa.reviewers', offer });
  },
  'qa.assign'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const n = pr(msg.pr);
    const r = ctx.meOf(c.accountId).admin ? floor.qa.assign(n, str(msg.sha, 64), str(msg.workerId, 32), c.peer.name) : { ok: false, message: 'Only admins can give a review to a worker' };
    // The queue already tells the floor who gave what to whom.
    ctx.sendTo(c, { t: 'qa.result', pr: n, ok: r.ok, message: r.message });
  },
  'qa.attest'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const n = pr(msg.pr);
    const verdict = (['approve', 'changes', 'comment'] as const).find((v) => v === msg.verdict);
    const r = !ctx.meOf(c.accountId).admin ? { ok: false, message: 'Only admins can record a review' } : !verdict ? { ok: false, message: 'verdict is approve, changes or comment' } : floor.qa.attest(n, str(msg.sha, 64), verdict, str(msg.reference, 200), str(msg.summary, 2000), c.peer.name);
    ctx.sendTo(c, { t: 'qa.result', pr: n, ok: r.ok, message: r.message });
    if (r.ok) ctx.toastFloor(floor, `🧪 ${r.message}`);
  },
} satisfies HandlerMap<QaClientMsg>;
