// What a worker is called and what it's for: the name and role a new one is hired with, and changing
// them afterwards. What a name and a role are (and aren't) is in shared/worker-identity.ts; the short
// version is that they're labels. A worker is its id, which nothing here touches, so changing a name
// or role never moves its session, worktree, branch, task, terminal or what anyone sent it.
import { DEFAULT_ROLE, SHELL_MARK, given, nameKey, parseWorkerName, parseWorkerRole, workerRole } from '../../shared/worker-identity.js';
import { DESK_BY_ID } from '../../shared/layout.js';
import type { WorkerInfo, WorkerKind } from '../../shared/protocol.js';
import type { WorkerContext } from './types.js';

/** What changing a worker's name and role asks: a field left out stays as it is. */
export interface IdentityChange {
  name?: unknown;
  role?: unknown;
  /** What the person asking last saw. If it isn't what the worker has now, someone got there first and nothing is changed. */
  expect?: { name?: string; role?: string };
}

export interface IdentityChanged {
  info: WorkerInfo;
  /** What it was called and was for before. */
  was: { name: string; role: string };
  /** Which of the two actually changed (none when it already was what was asked). */
  changed: ('name' | 'role')[];
}

const BOARD_FIXED = "A board agent's name and role are fixed";

export class WorkerIdentity {
  constructor(private ctx: WorkerContext) {}

  /** The worker on this floor, other than `except`, whose name can't be told from `name`. */
  private holder(name: string, except?: string): WorkerInfo | undefined {
    const key = nameKey(name);
    for (const { info } of this.ctx.workers.values()) if (info.id !== except && nameKey(info.name) === key) return info;
    return undefined;
  }

  private clash(name: string, except?: string): string | undefined {
    const other = this.holder(name, except);
    return other && `Another worker on this floor is already called ${other.name}: pick a different name`;
  }

  /**
   * The name and role a worker being hired gets: the ones asked for, checked, else its board's own name,
   * else the next free one in `pool`. A string says why not. Only an agent that isn't a board agent has a role.
   */
  pick(asked: { name?: unknown; role?: unknown } | undefined, kind: WorkerKind, board: boolean, pool: readonly string[], fixed?: string): { name: string; role?: string } | string {
    let name = fixed;
    let role: string | undefined;
    // A blank name or role is not one: the next free name, the default role.
    const [wantName, wantRole] = [given(asked?.name), given(asked?.role)];
    if (board && (wantName !== undefined || wantRole !== undefined)) return BOARD_FIXED;
    if (wantName !== undefined) {
      const parsed = parseWorkerName(wantName);
      if ('error' in parsed) return parsed.error;
      const taken = this.clash(parsed.name);
      if (taken) return taken;
      name = parsed.name;
    }
    if (wantRole !== undefined) {
      if (kind === 'shell') return 'A shell has no role';
      const parsed = parseWorkerRole(wantRole);
      if ('error' in parsed) return parsed.error;
      role = parsed.role;
    }
    // Nobody picked one: the pool's next free name, and once that's out, "Worker 7" (unless that's somebody's).
    name ??= pool.find((n) => !this.holder(n));
    for (let n = this.ctx.workers.size + 1; !name; n++) if (!this.holder(`Worker ${n}`)) name = `Worker ${n}`;
    return { name, role: kind === 'agent' && !board ? (role ?? DEFAULT_ROLE) : undefined };
  }

  /**
   * Renames a worker and/or gives it another role, as one change: both are checked first, and if either
   * is refused neither is made. It carries on as it was meanwhile; only what it's called and what it's for
   * change, and everyone is told. A string says why it couldn't.
   */
  update(id: string, change: IdentityChange): IdentityChanged | string {
    const w = this.ctx.workers.get(id);
    if (!w) return 'No such worker';
    const { info } = w;
    if (DESK_BY_ID.get(info.deskId)?.station) return BOARD_FIXED;
    if (change.name === undefined && change.role === undefined) return 'Give a new name or a new role';
    const was = { name: info.name, role: workerRole(info) };
    const { expect } = change;
    if ((expect?.name !== undefined && expect.name !== was.name) || (expect?.role !== undefined && expect.role !== was.role)) {
      return `${was.name} was changed by someone else while you were editing: look at it again first`;
    }
    const shell = info.kind === 'shell';
    let name: string | undefined;
    let role: string | undefined;
    if (change.name !== undefined) {
      const parsed = parseWorkerName(change.name);
      if ('error' in parsed) return parsed.error;
      const taken = this.clash(parsed.name, id);
      if (taken) return taken;
      // A shell keeps its mark, which is how it's told from an agent in lists.
      name = shell ? `${parsed.name} ${SHELL_MARK}` : parsed.name;
    }
    if (change.role !== undefined) {
      if (shell) return 'A shell has no role';
      const parsed = parseWorkerRole(change.role);
      if ('error' in parsed) return parsed.error;
      role = parsed.role;
    }
    const changed: IdentityChanged['changed'] = [];
    if (name !== undefined && name !== info.name) {
      info.name = name;
      changed.push('name');
    }
    if (role !== undefined && role !== was.role) {
      info.role = role;
      changed.push('role');
    }
    if (changed.length) {
      this.ctx.emit(w);
      this.ctx.persist();
    }
    return { info, was, changed };
  }
}
