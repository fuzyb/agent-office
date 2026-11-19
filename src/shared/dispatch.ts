// Which worker can take a task, decided by plain code on plain data: no model, no network, nothing
// that spends usage. The server builds the facts from the live worker records (server/dispatch/) and
// calls this; the answer is the same every time for the same facts, and says why.
//
// A role is a label (shared/worker-identity.ts). Here it only answers "what kind of work is this
// worker for", to rank workers that may already be given a task and to match a task that asks for a
// kind of work. Whether a worker may be given a task at all is never a matter of its role: the floor,
// the account, the status, the queue's limit and the person's confirmation decide that, and the tests
// change a worker's role to every value to show it.
//
// Browser-safe: no node imports.
import { DEFAULT_ROLE, isWorkerRole, roleLabel } from './worker-identity.js';
import type { AgentProvider } from './protocol/agents.js';
import { isAgentProvider } from './providers.js';
import type { Availability, Blocked, Candidate, DispatchPreview, InventoryRow, SeatKind, TaskNeeds } from './protocol/dispatch.js';
import type { WorkerStatus } from './protocol/workers.js';

/** What each role is for, as skills a task can ask for. A role id this office has no row for has none. */
export const ROLE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  'general-worker': ['general'],
  'engineering-chief': ['plan', 'coordinate', 'review'],
  'chief-of-staff': ['plan', 'coordinate'],
  'product-architect': ['plan', 'design', 'docs'],
  developer: ['code', 'test', 'docs'],
  'backend-engineer': ['code', 'test', 'backend'],
  'web-engineer': ['code', 'test', 'frontend'],
  'mobile-engineer': ['code', 'test', 'mobile'],
  'qa-engineer': ['test', 'verify', 'review'],
  reviewer: ['review'],
  'security-engineer': ['security', 'review', 'code'],
  'devops-engineer': ['ops', 'code'],
  researcher: ['research', 'docs'],
};

/** A task's needs from something untrusted (a message, queue.json): only the parts that are what they should be. Undefined when nothing is left. */
export function cleanNeeds(raw: unknown): TaskNeeds | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: TaskNeeds = {};
  if (typeof r.role === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(r.role)) out.role = r.role;
  if (Array.isArray(r.skills)) {
    const skills = r.skills.filter((s): s is string => typeof s === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(s)).slice(0, 8);
    if (skills.length) out.skills = skills;
  }
  if (Array.isArray(r.providers)) {
    const providers = r.providers.filter(isAgentProvider).slice(0, 9);
    if (providers.length) out.providers = providers;
  }
  return out.role || out.skills || out.providers ? out : undefined;
}

/** A Claude plan window at or past this is treated as spent: no new task goes to a Claude worker. */
export const USAGE_BLOCK_PCT = 95;

/** The skills of a worker's role (the default one's when it has none), and whether this office knows the role. */
export function skillsOf(role: string | undefined): { skills: readonly string[]; known: boolean } {
  const id = role || DEFAULT_ROLE;
  return isWorkerRole(id) ? { skills: ROLE_SKILLS[id] ?? [], known: true } : { skills: [], known: false };
}

/** What dispatch needs to know about one worker. The server fills it from the live record. */
export interface WorkerFacts {
  id: string;
  name: string;
  floorId: string;
  floorName: string;
  seat: SeatKind;
  provider?: AgentProvider;
  role?: string;
  status: WorkerStatus;
  desk: string;
  task?: string;
  branch?: string;
  lost?: boolean;
  prOpening?: boolean;
  /** A pull request of its that is still open. */
  openPr?: number;
  /** The queue task it is on right now. */
  queueTask?: string;
  /** The account whose sign-ins it runs on; none for the office's own. */
  owner?: string;
  /** Tasks the queue gave it that are done: how much it has already been used. */
  finishedTasks: number;
  /** When it last did something (ms), so a rested worker goes before a tired one. */
  lastActiveAt: number;
}

/** What a task asks, as the server knows it. */
export interface TaskFacts {
  id: string;
  title: string;
  floorId: string;
  owner?: string;
  /** The agent it was queued for. */
  provider?: AgentProvider;
  needs?: TaskNeeds;
}

/** Conditions of the moment that apply to every worker. */
export interface Conditions {
  /** Why no task may start now at all (the queue is at its limit, hiring paused is not one: this hires nobody). */
  taskBlock?: string;
  /** A provider's plan window at its limit, in words. Only providers that report one appear. */
  usage: Partial<Record<AgentProvider, string>>;
}

const READY: ReadonlySet<WorkerStatus> = new Set(['idle', 'done']);

const STATUS_WORDS: Record<WorkerStatus, string> = {
  starting: 'is still starting',
  idle: 'is idle',
  working: 'is working on something else',
  needs_input: 'is waiting for a person to answer it',
  done: 'has finished its last turn',
  exited: 'has stopped',
  offline: 'is asleep (resume it first)',
};

/** Whether a worker could take any task on its floor now, whatever the task is. Role plays no part. */
export function classify(w: WorkerFacts): { availability: Availability; blockedBy: string[] } {
  if (w.seat === 'shell') return { availability: 'unavailable', blockedBy: ['it is a shell: a prompt would run as a command'] };
  if (w.seat === 'board-agent') return { availability: 'unavailable', blockedBy: ['it is a board agent with a job of its own'] };
  if (w.seat === 'meeting-seat') return { availability: 'unavailable', blockedBy: ['it is in a meeting'] };
  if (w.lost) return { availability: 'unavailable', blockedBy: ['its worktree was deleted: rebuild it or send it home'] };
  if (w.status === 'working') return { availability: 'busy', blockedBy: [STATUS_WORDS.working] };
  if (w.status === 'needs_input') return { availability: 'waiting', blockedBy: [STATUS_WORDS.needs_input] };
  if (!READY.has(w.status)) return { availability: 'unavailable', blockedBy: [STATUS_WORDS[w.status]] };
  const held: string[] = [];
  if (w.queueTask) held.push(`it is on a queue task (${w.queueTask})`);
  if (w.openPr !== undefined) held.push(`its pull request #${w.openPr} is still open: its branch belongs to that work`);
  if (w.prOpening) held.push('it is opening a pull request');
  return held.length ? { availability: 'reserved', blockedBy: held } : { availability: 'available', blockedBy: [] };
}

/** The worker as an inventory row. */
export function inventoryRow(w: WorkerFacts): InventoryRow {
  const { availability, blockedBy } = classify(w);
  const { known } = skillsOf(w.role);
  return {
    id: w.id,
    name: w.name,
    floorId: w.floorId,
    floorName: w.floorName,
    seat: w.seat,
    ...(w.provider ? { provider: w.provider } : {}),
    ...(w.role !== undefined ? { role: w.role } : {}),
    ...(w.seat === 'worker' ? { roleLabel: roleLabel(w.role || DEFAULT_ROLE) } : {}),
    roleKnown: w.seat === 'worker' ? known : true,
    status: w.status,
    desk: w.desk,
    ...(w.task ? { task: w.task } : {}),
    ...(w.branch ? { branch: w.branch } : {}),
    ...(w.openPr !== undefined ? { openPr: w.openPr } : {}),
    ...(w.queueTask ? { queueTask: w.queueTask } : {}),
    availability,
    assignable: availability === 'available',
    blockedBy,
  };
}

/** The agents a task may run on: what it asks, else the one it was queued for, else any. */
export function providersFor(task: TaskFacts): AgentProvider[] {
  return task.needs?.providers?.length ? task.needs.providers : task.provider ? [task.provider] : [];
}

/**
 * Why `w` cannot have `task` (empty: it can), and, for one that can, how it ranks. Everything but the
 * match with what the task asks is about the worker's situation, not what its role says.
 */
function judge(w: WorkerFacts, task: TaskFacts, cond: Conditions): { blocked: string[]; rank: number[]; why: string[] } {
  const base = classify(w);
  const blocked = [...base.blockedBy];
  // Another floor's worker is never sent a task, whatever it is for: a floor is a project.
  if (w.floorId !== task.floorId) blocked.unshift(`it is on ${w.floorName}, and this task belongs to another floor`);
  // Its terminal is signed in as someone: the task is paid for on the same sign-ins it was queued on.
  if ((w.owner ?? '') !== (task.owner ?? '')) blocked.push(task.owner ? 'it runs on another account\'s sign-ins than the task was queued on' : 'it runs on an account\'s sign-ins, and the task was queued on the office\'s own');
  const providers = providersFor(task);
  if (providers.length && (!w.provider || !providers.includes(w.provider))) blocked.push(`it runs ${w.provider ?? 'no agent'}, and the task is for ${providers.join(' or ')}`);
  const spent = w.provider && cond.usage[w.provider];
  if (spent) blocked.push(spent);
  const { skills, known } = skillsOf(w.role);
  const wantRole = task.needs?.role;
  const wantSkills = task.needs?.skills ?? [];
  const roleId = w.role || DEFAULT_ROLE;
  if (wantRole && roleId !== wantRole) blocked.push(`the task needs a ${roleLabel(wantRole)} and it is ${known ? roleLabel(roleId) : `a role this office does not know (${roleId})`}`);
  const missing = wantSkills.filter((s) => !skills.includes(s));
  if (missing.length) blocked.push(`its role does not cover ${missing.join(', ')}`);
  if (blocked.length) return { blocked, rank: [], why: [] };

  const exact = wantRole && roleId === wantRole ? 1 : 0;
  const covered = wantSkills.length;
  const providerAt = w.provider ? Math.max(0, providers.indexOf(w.provider)) : 0;
  const why: string[] = [];
  if (exact) why.push(`its role is ${roleLabel(roleId)}, as the task needs`);
  if (covered) why.push(`its role covers ${wantSkills.join(', ')}`);
  if (!exact && !covered) why.push(known ? `${roleLabel(roleId)}; the task asks for no particular role` : `role ${roleId} is not one this office knows, so it counts as a general worker`);
  why.push(w.status === 'idle' ? 'idle at its prompt' : 'finished its last turn and is free');
  why.push(w.finishedTasks ? `${w.finishedTasks} queue task${w.finishedTasks === 1 ? '' : 's'} done so far` : 'no queue task so far');
  if (w.provider && providers.length) why.push(`runs ${w.provider} as the task asks`);
  why.push('on this floor, nothing open on its branch');
  // Higher first (exact role, skills), then lower first: the agent the task listed first, a fresh one before a used one, the least used, the most rested.
  const rank = [-exact, providerAt, w.status === 'idle' ? 0 : 1, w.finishedTasks, w.lastActiveAt];
  return { blocked: [], rank, why };
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** Who could take `task` among `workers` (of every floor), best first, and why the rest cannot. Never asks for a hire. */
export function previewDispatch(task: TaskFacts, workers: readonly WorkerFacts[], cond: Conditions, at = Date.now()): DispatchPreview {
  const candidates: (Candidate & { rank: number[]; id: string })[] = [];
  const blocked: Blocked[] = [];
  for (const w of workers) {
    const j = judge(w, task, cond);
    if (cond.taskBlock || j.blocked.length) {
      blocked.push({ workerId: w.id, name: w.name, floorName: w.floorName, reasons: cond.taskBlock && !j.blocked.length ? [cond.taskBlock] : j.blocked });
      continue;
    }
    candidates.push({ workerId: w.id, id: w.id, name: w.name, roleLabel: roleLabel(w.role || DEFAULT_ROLE), provider: w.provider, status: w.status, reasons: j.why, rank: j.rank });
  }
  candidates.sort((a, b) => compare(a.rank, b.rank) || a.id.localeCompare(b.id));
  const out: Candidate[] = candidates.map(({ rank: _rank, id: _id, ...c }) => c);
  let pending: string | undefined;
  if (!out.length) {
    const sameFloor = blocked.filter((b) => workers.find((w) => w.id === b.workerId)?.floorId === task.floorId);
    pending = cond.taskBlock
      ? `Waiting: ${cond.taskBlock}. Nobody was hired.`
      : sameFloor.length
        ? `Waiting: none of the ${sameFloor.length} worker${sameFloor.length === 1 ? '' : 's'} on this floor can take it now (${summarize(sameFloor)}). Nobody was hired: free one up, or hire one yourself.`
        : 'Waiting: there is no worker on this floor to give it to. Nobody was hired: hire one yourself.';
  }
  return { taskId: task.id, title: task.title, floorId: task.floorId, needs: task.needs ?? {}, providers: providersFor(task), candidates: out, blocked, ...(pending ? { pending } : {}), at };
}

/** The first reason of each blocked worker, counted: "2 are working on something else, 1 is a shell". */
function summarize(blocked: Blocked[]): string {
  const counts = new Map<string, number>();
  for (const b of blocked) counts.set(b.reasons[0], (counts.get(b.reasons[0]) ?? 0) + 1);
  return [...counts].map(([why, n]) => (n > 1 ? `${n}: ${why}` : why)).join('; ');
}
