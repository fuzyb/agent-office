# Workforce inventory and dispatch

Back to the [features](features.md). Builds on [worker names and roles](worker-identity.md).

One list of everyone who can do work, and a way to give a waiting task to a worker that is already
there, instead of hiring another. Looking is free; giving a task is one click, and a person's.

## What it is, and is not

- **Is:** a read-only **inventory** of every worker on every floor (admins; everyone else sees their own floor) (what it runs, its role, status,
  task, branch, pull request, and whether it could take a task now), a **preview** of who could take
  a waiting queue task (best first, with the reasons), and a **confirm** that types the task into the
  chosen worker's terminal and starts the queue task.
- **Is not:** an automatic dispatcher (that is off, and in this release does not exist), a second
  queue, a second worker list, or something that hires. It reads the records the worker manager and
  the queue already keep, and calls nothing that costs usage: it is plain code, with no model and no polling.
- **Never:** hires, restarts, renames, moves or sends home a worker; pushes, opens or merges a pull
  request; deploys. It cannot reach those (`tests/workforce-dispatch.test.ts` checks what the code
  imports and calls).

## Who sees what

An **admin** sees the whole building: every floor's workers, their tasks and the projects' subagents. Anyone else (a member, or a guest with
no account) sees **their own floor only**, which is what the office already shows them, and another floor's workers are not even named in a
preview. Whether someone is an admin is asked of the office at each request. A worker's own token (`office-workers inventory`, the MCP
tools) is never an admin: it sees its own floor. Giving a task is always limited to the floor the person is on.

## Using it

- **Browser (3D and 2D):** the task queue's **🧭 Dispatch** button. *Pending tasks* → **Who could take
  it?** shows the candidates, best first, each with why; the others are listed with why not. **Dispatch to
  …** asks you to confirm. *Assigned or running* and *Workforce* show the rest. **✋ Hold for dispatch** on a
  task keeps the queue from hiring a worker for it (the queue otherwise still does, as it always has);
  **Release** gives it back to the queue, which is the one way a task gets a new hire.
- **Workers (read-only, their own floor):** `office-workers inventory` and `office-workers preview <task id>`, and the MCP
  tools `workforce_inventory` and `dispatch_preview`. An agent can look; it cannot dispatch. Giving a
  task is a person's confirmation in the browser, so a worker cannot hand work around on its own.

## Who can take a task

A worker is a candidate only if all of these hold (the preview names the one that fails):

1. It is a real worker: not a **shell** (a prompt would run as a command), not a **board agent**, not in a **meeting**.
2. It is on **the task's floor**. A floor is a project: another floor's worker is listed, never used.
3. It is **free**: idle, or done with its turn. Never `working`, waiting for a person, starting, asleep or stopped, and its worktree exists.
4. Nothing of its is **unfinished**: no queue task running on it, no pull request of its still open (its branch belongs to that work).
5. It runs the **agent the task is for** (the task's own, or any you tick), and on the **same sign-ins** the task was queued on.
6. Its agent's **plan is not at its limit** (Claude's windows at 95% or more; other agents report none, so none holds them back).
7. The queue has **room** under *workers at once*, which counts a dispatched task like a hired one.
8. If the task **needs a role or skills**, its role matches or covers them (below).

Role is **not** authorization. It decides only rule 8 and the order below; 1 to 7 and the person's
confirmation are what protect a floor, an account or a branch, and they are re-checked at the moment you confirm,
against the worker's current state. Changing a worker's role (✏️) never makes it eligible for anything it was not. The tests
change roles to every value to show it.

Roles map to skills in `ROLE_SKILLS` (`src/shared/dispatch.ts`), for example `qa-engineer` covers `test, verify, review`. A worker
saved before roles existed counts as a General Worker; a role id this office does not know (from a newer one) is shown as
itself and counts as general: such a worker takes a task that asks for nothing, and is refused one that asks for a role or a skill.

## Which one first

Deterministic, in this order: the exact role the task asks for; the agent the task listed first; **idle** (a fresh prompt) before
**done** (a conversation to carry, which costs more usage to continue); the **fewest queue tasks done** so far; the **most rested**
(oldest activity); then its id. The reasons shown are the ones that applied.

## If nobody fits

The task stays pending and the preview says why (for example *none of the 3 workers on this floor can take it now: 2 are working on
something else, 1 is a shell*). Nobody is hired. Free a worker, or hire one yourself, or release the task so the queue hires.

## Existing workers, subagents, workflows

- Workers hired before this existed need nothing: ids, names, roles, sessions, worktrees, branches, floors and task links are read, not
  rewritten. Restored workers are listed as asleep until resumed.
- A project's **Claude subagents** (`.claude/agents/*.md`) are listed under the inventory as definitions. They are not at a desk and
  are never given a task.
- The **Chief of Staff** and **Engineering Chief** are ordinary roles; the **QA Director** desk is a person with ChatGPT, not a worker.
  Dispatch does not touch it.

## Extension points (`src/server/dispatch/extension.ts`)

Interfaces and conservative defaults only, nothing runs: `TaskIntake`, `DispatchStrategy` (the manual one picks nobody),
`Orchestrator`, `TestResultCollector`, `ReviewEvidence`, `PrReadinessClassifier` (says nothing is ready; `merge` is always `human`).
Automatic dispatch and merging need their own approved design: a role label, a pull request comment and the shared GitHub
account are claims, not evidence that a review was independent.

## Limitations

- Manual only. Asleep workers are listed but not woken; resume them first.
- One task per worker at a time. A worker whose pull request is open is not given another.
- The usage check knows Claude's plan windows only; other agents are not held back by usage and the queue's own limits apply.
- A held task is only one a person made held; tasks queued the usual way are still hired for unless you hold or dispatch them first.
- The existing `tell_worker` and the browser's prompt box can still type to a busy worker, as before; dispatch does not change them.
