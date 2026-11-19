// Workforce inventory and dispatch (server/dispatch/): what a person sees, previews and confirms. The
// floor is the one they are on, so a task and a worker of another floor are out of reach here.
import { cleanNeeds } from '../../../shared/dispatch.js';
import { confirm, inventory, preview } from '../../dispatch/dispatcher.js';
import { officeOf, viewerOf } from '../../dispatch/office.js';
import { str } from '../../office/input.js';
import { here } from './common.js';
import type { HandlerMap } from './types.js';
import type { DispatchClientMsg } from '../../../shared/protocol.js';

export const dispatchHandlers = {
  'dispatch.inventory'(ctx, c) {
    const floor = here(ctx, c);
    if (floor) ctx.sendTo(c, { t: 'dispatch.inventory', inventory: inventory(officeOf(ctx), floor, viewerOf(ctx, c)) });
  },
  'dispatch.preview'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const taskId = str(msg.taskId, 32);
    const p = preview(officeOf(ctx), floor, taskId, viewerOf(ctx, c), cleanNeeds(msg.needs));
    if (typeof p === 'string') ctx.sendTo(c, { t: 'dispatch.result', taskId, ok: false, message: p });
    else ctx.sendTo(c, { t: 'dispatch.preview', preview: p });
  },
  'dispatch.confirm'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (!floor) return;
    const taskId = str(msg.taskId, 32);
    const workerId = str(msg.workerId, 32);
    const r = confirm(officeOf(ctx), floor, taskId, workerId, c.peer.name, cleanNeeds(msg.needs));
    ctx.sendTo(c, { t: 'dispatch.result', taskId, ok: r.ok, message: r.message, ...(r.ok ? { workerId } : {}) });
    if (!r.ok) ctx.warn(c, r.message);
  },
  'queue.hold'(ctx, c, msg) {
    const floor = here(ctx, c);
    if (floor) ctx.warn(c, floor.queue.setHold(str(msg.taskId, 32), msg.hold === true));
  },
} satisfies HandlerMap<DispatchClientMsg>;
