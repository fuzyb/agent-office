// The running office as dispatch reads it: its floors and the Claude plan limits. Nothing is copied.
import type { Ctx } from '../office/context.js';
import type { DispatchOffice, Viewer } from './dispatcher.js';

/** Whether they are an admin is asked of the office now, not read from what the connection was told when it opened. */
export const viewerOf = (ctx: Pick<Ctx, 'meOf'>, c: { accountId?: string }): Viewer => ({ admin: ctx.meOf(c.accountId).admin });

export const officeOf = (ctx: Pick<Ctx, 'floors' | 'limits'>): DispatchOffice => ({
  floors: () => ctx.floors.values(),
  planLimits: () => ctx.limits.state,
});
