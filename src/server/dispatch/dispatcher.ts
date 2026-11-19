// Workforce inventory and dispatch on the live office: reads the records the worker manager and the queue
// already keep (no second database, no polling, nothing that calls a model), hands them to the pure
// routing in shared/dispatch.ts, and, only when a person confirms, gives a waiting task to a worker that
// is free. It can type one prompt to one worker and mark one queue task as started. It cannot hire,
// restart, rename, send home, push, open or merge a pull request, or deploy: none of those is reachable
// from here (tests/dispatch.test.ts checks the imports and the calls).
import { DESK_BY_ID } from '../../shared/layout.js';
import { USAGE_BLOCK_PCT, inventoryRow, previewDispatch, type Conditions, type TaskFacts, type WorkerFacts } from '../../shared/dispatch.js';
import type { Blocked, DispatchPolicy, DispatchPreview, Inventory, SeatKind, TaskNeeds } from '../../shared/protocol/dispatch.js';
import type { GhPull, PlanLimits, QueueState, QueueTask, WorkerInfo } from '../../shared/protocol.js';
import { workerPr } from '../../shared/status.js';
import { subagentsOf } from './subagents.js';

/** What this release does by itself: nothing. A person confirms every dispatch; no hiring; humans merge. */
export const POLICY: DispatchPolicy = { auto: false, merge: 'human', hires: false };

/** The slice of a floor that dispatch reads. A floor (server/floor.ts) is one; a test can fake one. */
export interface DispatchFloor {
  readonly id: string;
  readonly dir: string;
  readonly def: { readonly name: string };
  readonly workers: {
    list(): WorkerInfo[];
    get(id: string): WorkerInfo | undefined;
    ownerOf(id: string): string | undefined;
    prompt(id: string, text: string, by?: string): string | undefined;
  };
  readonly queue: {
    state(): QueueState;
    readonly running: number;
    readonly limit: number;
    assign(taskId: string, w: WorkerInfo, by: string, send: () => string | undefined): string | undefined;
  };
  readonly github: { readonly pulls: { readonly items: GhPull[] } };
}

/** Who is looking. Another floor's workers, their tasks and its subagents are for admins only: anyone else sees what they can already see on their own floor. */
export interface Viewer {
  readonly admin: boolean;
}

/** The agents' route has no account behind it: a worker looks at its own floor only. */
export const AGENT: Viewer = { admin: false };

export interface DispatchOffice {
  floors(): Iterable<DispatchFloor>;
  planLimits(): PlanLimits;
}

const seatOf = (w: WorkerInfo): SeatKind => {
  const desk = DESK_BY_ID.get(w.deskId);
  if (desk?.station) return 'board-agent';
  if (w.kind === 'shell') return 'shell';
  if (w.meeting || desk?.room) return 'meeting-seat';
  return 'worker';
};

function factsOf(floor: DispatchFloor, w: WorkerInfo, tasks: QueueTask[]): WorkerFacts {
  const pr = workerPr(w, floor.github.pulls.items, tasks);
  const mine = tasks.filter((t) => t.workerId === w.id);
  return {
    id: w.id,
    name: w.name,
    floorId: floor.id,
    floorName: floor.def.name,
    seat: seatOf(w),
    provider: w.kind === 'agent' ? w.provider : undefined,
    role: w.role,
    status: w.status,
    desk: DESK_BY_ID.get(w.deskId)?.label ?? w.deskId,
    task: w.task?.name ?? w.activity,
    branch: w.worktree?.branch,
    lost: !!w.lost,
    prOpening: !!w.prOpening,
    openPr: pr?.state === 'open' ? pr.number : undefined,
    queueTask: mine.find((t) => t.status === 'running')?.id,
    owner: floor.workers.ownerOf(w.id),
    finishedTasks: mine.filter((t) => t.status === 'done').length,
    lastActiveAt: w.lastInput?.at ?? w.waitingSince ?? w.createdAt,
  };
}

/** Claude's plan windows that are spent, in words. Only Claude reports them; other agents are not held back by it. */
function usageBlock(limits: PlanLimits): Partial<Record<'claude', string>> {
  const spent = limits.windows.filter((w) => w.pct >= USAGE_BLOCK_PCT).sort((a, b) => b.pct - a.pct)[0];
  if (!spent) return {};
  const back = spent.resetsAt ? `, back around ${new Date(spent.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  return { claude: `Claude's ${spent.label} is ${Math.round(spent.pct)}% used${back}: no new work goes to a Claude worker until then` };
}

export function usageNote(office: DispatchOffice): string | undefined {
  return usageBlock(office.planLimits()).claude;
}

/** The floors `viewer` may look into: all of them for an admin, otherwise the one they are on. */
function visible(office: DispatchOffice, floor: DispatchFloor, viewer: Viewer): DispatchFloor[] {
  return [...office.floors()].filter((f) => viewer.admin || f.id === floor.id);
}

/** Every worker they may see, whether it could take a task, and those floors' own Claude subagents. Read-only. */
export function inventory(office: DispatchOffice, floor: DispatchFloor, viewer: Viewer): Inventory {
  const rows = [];
  const subagents = [];
  for (const f of visible(office, floor, viewer)) {
    const tasks = f.queue.state().tasks;
    for (const w of f.workers.list()) rows.push(inventoryRow(factsOf(f, w, tasks)));
    subagents.push(...subagentsOf(f.id, f.dir));
  }
  const note = usageNote(office);
  return { floorId: floor.id, scope: viewer.admin ? 'all-floors' : 'this-floor', rows, subagents, ...(note ? { usageNote: note } : {}), policy: POLICY, at: Date.now() };
}

/** What a task may ask: a person's `needs` for this look, else the ones saved on the task. */
function taskFacts(floor: DispatchFloor, task: QueueTask, needs?: TaskNeeds): TaskFacts {
  return { id: task.id, title: task.title, floorId: floor.id, owner: task.owner, provider: task.provider, needs: needs ?? task.needs };
}

function conditions(office: DispatchOffice, floor: DispatchFloor): Conditions {
  const state = floor.queue.state();
  const full = floor.queue.running >= state.maxWorkers;
  return {
    usage: usageBlock(office.planLimits()),
    ...(full ? { taskBlock: `the queue already has ${floor.queue.running} of ${state.maxWorkers} tasks at work (workers at once)` } : {}),
  };
}

const waiting = (floor: DispatchFloor, taskId: string): QueueTask | string => {
  const t = floor.queue.state().tasks.find((x) => x.id === taskId);
  if (!t) return 'No such task on this floor';
  return t.status === 'queued' ? t : 'That task is not waiting';
};

/** Who could take a waiting task of `floor`, best first, and why not the others. Changes nothing, hires nobody. */
export function preview(office: DispatchOffice, floor: DispatchFloor, taskId: string, viewer: Viewer, needs?: TaskNeeds): DispatchPreview | string {
  const task = waiting(floor, taskId);
  if (typeof task === 'string') return task;
  const workers: WorkerFacts[] = [];
  // Another floor's workers are never candidates; whether they are even named among those that cannot is up to who is looking.
  for (const f of visible(office, floor, viewer)) {
    const tasks = f.queue.state().tasks;
    for (const w of f.workers.list()) workers.push(factsOf(f, w, tasks));
  }
  return previewDispatch(taskFacts(floor, task, needs), workers, conditions(office, floor));
}

/**
 * Gives a waiting task to a worker of this floor, once a person has chosen it. The worker is looked up
 * on this floor only, and checked again now (it may have been given something else since the preview).
 * On any doubt nothing happens and the task stays waiting.
 */
export function confirm(office: DispatchOffice, floor: DispatchFloor, taskId: string, workerId: string, by: string, needs?: TaskNeeds): { ok: boolean; message: string } {
  const task = waiting(floor, taskId);
  if (typeof task === 'string') return { ok: false, message: task };
  const w = floor.workers.get(workerId);
  if (!w) return { ok: false, message: 'No such worker on this floor' };
  const tasks = floor.queue.state().tasks;
  const verdict = previewDispatch(taskFacts(floor, task, needs), [factsOf(floor, w, tasks)], conditions(office, floor));
  if (!verdict.candidates.length) {
    const why: Blocked | undefined = verdict.blocked[0];
    return { ok: false, message: `${w.name} cannot take it now: ${why?.reasons.join('; ') ?? verdict.pending ?? 'not eligible'}` };
  }
  const err = floor.queue.assign(taskId, w, by, () => floor.workers.prompt(workerId, task.prompt, by));
  return err ? { ok: false, message: err } : { ok: true, message: `${by} gave “${task.title}” to ${w.name}` };
}
