// The workforce inventory and role-aware dispatch (see shared/dispatch.ts and docs/dispatch.md).
// Everything here is read-only data, except `dispatch.confirm`, which a person sends to say "yes, this
// worker, this task".

import type { AgentProvider } from './agents.js';
import type { WorkerStatus } from './workers.js';

/**
 * What a seat at a desk is, for dispatch. Only a 'worker' can be given a task: a shell would run the
 * text as a command, a board agent has a job of its own, and a meeting seat belongs to the meeting.
 * A project's Claude subagents (.claude/agents) are not seats at all: see Subagent.
 */
export type SeatKind = 'worker' | 'shell' | 'board-agent' | 'meeting-seat';

/** Whether a worker could take a task right now. */
export type Availability =
  | 'available' // at its prompt with nothing to finish
  | 'busy' // working on something
  | 'waiting' // needs a person's answer first
  | 'reserved' // it holds work that isn't finished: a task of the queue's, or a pull request still open
  | 'unavailable'; // not running, not a worker, or its folder is gone

/** One worker, as the office sees it. Built from the live worker records; no second copy is kept. */
export interface InventoryRow {
  id: string;
  name: string;
  floorId: string;
  floorName: string;
  seat: SeatKind;
  provider?: AgentProvider;
  /** The role id on its record, or undefined for a worker saved before roles existed. */
  role?: string;
  /** What to show for it: the label, the id of a role this office does not know, or "General Worker" for none. */
  roleLabel?: string;
  /** False for a role id this office has no row for (written by a newer one): the worker still counts, as a general one. */
  roleKnown: boolean;
  status: WorkerStatus;
  desk: string;
  /** What it is doing or did last, in a few words. */
  task?: string;
  branch?: string;
  /** A pull request of its that is still open. */
  openPr?: number;
  /** The queue task it is on, while it is on one. */
  queueTask?: string;
  availability: Availability;
  /** Could any task on its floor go to it now? Task-independent: the preview adds the task's own conditions. */
  assignable: boolean;
  /** Why not, in words, when it is not assignable. */
  blockedBy: string[];
}

/** A project's own Claude subagent (a file in its .claude/agents): a definition a worker may use, never a worker. */
export interface Subagent {
  floorId: string;
  name: string;
  /** The file, relative to the floor's folder. */
  file: string;
  description?: string;
}

export interface DispatchPolicy {
  /** Whether the office sends tasks to workers by itself. Always false in this release: a person confirms each one. */
  auto: false;
  /** Who merges pull requests. Always 'human' here: no dispatch code can merge, push or deploy. */
  merge: 'human';
  /** Whether a task that finds no worker may hire one. Always false: hiring stays an act of its own. */
  hires: false;
}

export interface Inventory {
  /** The floor the person is on: the one whose tasks they can dispatch. */
  floorId: string;
  /** What the person may see: every floor's workers (an admin), or only this floor's, which is all a person sees anywhere else in the office. */
  scope: 'all-floors' | 'this-floor';
  rows: InventoryRow[];
  subagents: Subagent[];
  /** Claude plan windows near their limit, in words, when there are any. */
  usageNote?: string;
  policy: DispatchPolicy;
  at: number;
}

/** What a task asks of its worker, besides the floor it belongs to. */
export interface TaskNeeds {
  /** A role id: workers of it come first. With nothing else asked, others still qualify. */
  role?: string;
  /** Skills the worker's role must cover, all of them (see ROLE_SKILLS). */
  skills?: string[];
  /** The agents it may run on. Left out: the one the task was queued for. */
  providers?: AgentProvider[];
}

export interface Candidate {
  workerId: string;
  name: string;
  roleLabel: string;
  provider?: AgentProvider;
  status: WorkerStatus;
  /** Why this one, in the order that decided it. */
  reasons: string[];
}

export interface Blocked {
  workerId: string;
  name: string;
  floorName: string;
  /** Why it cannot have this task. */
  reasons: string[];
}

export interface DispatchPreview {
  taskId: string;
  title: string;
  floorId: string;
  needs: TaskNeeds;
  /** The agents the task may use, after the default is filled in. */
  providers: AgentProvider[];
  /** Eligible workers, best first. */
  candidates: Candidate[];
  blocked: Blocked[];
  /** Set when nobody can take it: why it stays pending. It is never hired for. */
  pending?: string;
  at: number;
}

export type DispatchClientMsg =
  /** The workers of every floor, each with whether it could take a task, and the project subagents. */
  | { t: 'dispatch.inventory' }
  /** Who could take a queued task, best first, and why the others cannot. Changes nothing. */
  | { t: 'dispatch.preview'; taskId: string; needs?: TaskNeeds }
  /** Sends the queued task to this worker: its prompt typed to a worker that is free, after checking again. */
  | { t: 'dispatch.confirm'; taskId: string; workerId: string; needs?: TaskNeeds }
  /** Keeps a queued task for dispatch (hold) or lets the queue hire for it, as it always did (release). */
  | { t: 'queue.hold'; taskId: string; hold: boolean };

export type DispatchServerMsg =
  | { t: 'dispatch.inventory'; inventory: Inventory }
  | { t: 'dispatch.preview'; preview: DispatchPreview }
  | { t: 'dispatch.result'; taskId: string; ok: boolean; message: string; workerId?: string };
