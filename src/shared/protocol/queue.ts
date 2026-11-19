// The floor's task queue.

import type { AgentEffort, AgentProvider } from './agents.js';
import type { TaskNeeds } from './dispatch.js';

export type TaskStatus = 'queued' | 'running' | 'done';

/** A task on the 📋 queue whiteboard: a GitHub issue or free text, seated to a worker by itself. */
export interface QueueTask {
  id: string;
  provider?: AgentProvider;
  /** Model requested for this task, instead of the office's configured default: an id its provider takes (see WorkerInfo.model). */
  model?: string;
  /** Reasoning effort requested for this task, when one was chosen (Claude only). */
  effort?: AgentEffort;
  /** The GitHub issue it came from, when it did. */
  issue?: number;
  title: string;
  prompt: string;
  addedBy: string;
  /** The account that queued it: its worker runs on that account's own sign-ins. None: the office's own. */
  owner?: string;
  addedAt: number;
  status: TaskStatus;
  /** The worker seated for it (it may have gone home since). */
  workerId?: string;
  workerName?: string;
  /** The worker's own branch, when it got a worktree. */
  branch?: string;
  startedAt?: number;
  finishedAt?: number;
  /** How it ended: the worker finished its turn, stopped or fell asleep, was sent home, or never started. */
  outcome?: 'done' | 'exited' | 'killed' | 'failed';
  error?: string;
  /** Kept for dispatch: the queue does not hire for it. A person dispatches it to a worker that is free, or releases it (`queue.hold`) to be hired for as before. */
  hold?: boolean;
  /** What it asks of its worker: a role, skills, the agents it may run on (see shared/dispatch.ts). Left out: any free worker of the agent it was queued for. */
  needs?: TaskNeeds;
  /** Given to a worker that was already at a desk, by a person's dispatch, instead of hiring one: who, and when. Such a worker is never sent home by the queue. */
  assigned?: { by: string; at: number };
  /** An assigned task: the worker has gone to work on it. Until then a worker still showing 'done' is not the task's end. */
  engaged?: boolean;
  /** The pull request that closes the issue, or was opened from the worker's branch. */
  pr?: { number: number; url: string; state: string; title: string };
}

export interface QueueState {
  tasks: QueueTask[];
  /** How many workers the queue may keep busy at once; 0 pauses it. */
  maxWorkers: number;
}

export type QueueClientMsg =
  /** With `hold`, kept for dispatch instead of being given a newly hired worker; `needs` says what kind of worker it asks for. */
  | { t: 'queue.add'; prompt: string; title?: string; issue?: number; provider?: AgentProvider; model?: string; effort?: AgentEffort; hold?: boolean; needs?: TaskNeeds }
  | { t: 'queue.remove'; taskId: string }
  /** Move a queued task up (-1) or down (+1) the queue. */
  | { t: 'queue.move'; taskId: string; delta: number }
  /** Put a finished task back on the queue. */
  | { t: 'queue.retry'; taskId: string }
  /** Forget the finished tasks. */
  | { t: 'queue.clear' }
  | { t: 'queue.limit'; maxWorkers: number };

export type QueueServerMsg =
  | { t: 'queue'; state: QueueState };
