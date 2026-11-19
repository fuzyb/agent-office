// The running office as dispatch reads it: its floors and the Claude plan limits. Nothing is copied.
import type { Ctx } from '../office/context.js';
import type { DispatchOffice } from './dispatcher.js';

export const officeOf = (ctx: Pick<Ctx, 'floors' | 'limits'>): DispatchOffice => ({
  floors: () => ctx.floors.values(),
  planLimits: () => ctx.limits.state,
});
