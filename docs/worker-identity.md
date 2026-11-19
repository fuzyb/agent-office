# Worker names and roles

Back to the [README](../README.md).

Every worker has three things that used to be one. This page says which is which, how to name and rename a worker, what a role is (and isn't), and what the office keeps.

| | What it is | Changes? | Used for |
| --- | --- | --- | --- |
| **id** | 12 random hex characters, made when the worker is hired (`WorkerInfo.id`) | Never | Everything that points at a worker: its terminal, messages to it, the queue's tasks, its pull request, `workers.json` |
| **name** | What it is called (`WorkerInfo.name`) | Yes: ✏️ | What people read. Not unique across floors or over time |
| **role** | What it was hired for, as a role id like `engineering-chief` (`WorkerInfo.role`) | Yes: ✏️ | Telling workers apart by what they're for. A label, never a permission |

A worker's floor is where it sits, so `(floor id, worker id)` names one worker in the whole building. Two workers with the same name are two workers, whether they are on different floors or were at the same desk a day apart.

## Hiring with a name and a role

The hire dialog (E or P at an empty desk) has an optional **Worker name** and a **Role**. Leave the name blank and the worker gets the next free name from the pool (Pixel, Byte, Nibble…), exactly as before. The role is **General Worker** unless you pick another. Nothing else about hiring changed.

Agents can do the same: `hire_worker` and `office-workers hire` take `name` and `role` (`--name "Backend Engineer — Galexii" --role backend-engineer`).

## Renaming, and changing a role

Press **✏️** in the worker's terminal window (E at its desk), or in the workers list in the sidebar. The window changes its name and its role together, and nothing else: its session keeps running, its worktree and branch stay where they are, its task and its place in the queue carry on, and a message sent to it still reaches it. Everyone on the floor sees a toast saying who renamed whom.

If two people change the same worker at the same moment, the second is told it was changed meanwhile and nothing is overwritten.

A board agent (the Issues, PR and Queue agents) has a fixed name and no role. A shell can be renamed, keeps its 🐚, and has no role.

There is no tool for an agent to rename another worker. Agents choose a name when they hire, and people change it afterwards.

## What a name can be

Up to 32 characters, in any script: letters, numbers, spaces, emoji (with their joiners and skin tones) and `- – — _ . , ' ’ & + ( )`. `Chief — Galexii`, `José`, `李雷` and `👩‍🔬 Ada` are fine.

Everything else is refused with a message, by the page as you type and again by the office, which is what decides: markup and quotes (`< > "`), shell characters (`` ` $ ; | ``), path characters (`/ \ :`), `@` and `#` (which would mention someone or link an issue in a pull request), brackets, line breaks and invisible or direction-changing characters, more than three accents stacked on a letter, a name that looks like a worker id, the shell mark 🐚, a board agent's name, and a word that mixes Latin with Cyrillic or Greek letters (a way to pass as another worker).

**Names are unique on a floor.** Two names are the same when only case, spacing around a dash, or a compatibility form of a letter differs (`Chief — Galexii`, `chief-galexii` and `ＣＨＩＥＦ—ＧＡＬＥＸＩＩ` collide). A second one is refused with the name it clashed with, and the pool skips any name someone chose. The same name is free on another floor, and once its worker has gone.

A name is drawn as text everywhere (the page builds its elements, never markup), and it is never used as a path: the worker's branch and folder are made once, when it is hired, as `office/<name as plain letters>-<first four of its id>`. A name with no plain letters (`李雷`) gets `office/worker-<id>`. A rename leaves both alone.

## Roles

| Id | Label |
| --- | --- |
| `general-worker` (default) | General Worker |
| `engineering-chief` | Engineering Chief |
| `chief-of-staff` | Chief of Staff |
| `product-architect` | Product Architect |
| `developer` | Software Developer |
| `backend-engineer` | Backend Engineer |
| `web-engineer` | Web Engineer |
| `mobile-engineer` | Mobile Engineer |
| `qa-engineer` | QA Engineer |
| `reviewer` | PR Reviewer |
| `security-engineer` | Security Engineer |
| `devops-engineer` | DevOps Engineer |
| `researcher` | Researcher |

The ids that have a file in the HQ repository's `roles/` folder use that file's name, so whatever matches work to workers later can map a role id to its brief. A role is a row in `WORKER_ROLES` (`src/shared/worker-identity.ts`) and has no code of its own; to add one, add a row there and the same id to `ROLES` in `bin/office-workers.js` (a test fails until both match).

**A role grants nothing.** Hiring, sending home, merging, reaching another floor and everything else are decided exactly as before, by who is asking and the office's own rules. No server code reads a worker's role to decide anything, and a test fails if one starts to (`tests/worker-identity.test.ts`). A worker called the Engineering Chief has no more access than any other.

## What agents see

`list_workers` (and `office-workers list --json`) gives each agent worker its `id`, `name`, `role` and `roleLabel`; a shell and a board agent have no role. The list is of the floor the asking worker is on, and it says which (`floor.id`), so `(floor.id, id)` is the reference that is unique across the building.

`tell_worker`, `send_home` and `link_pr` still take a worker's id **or** name, as before. The id is checked first and always wins, then the name (any case, spacing around a dash as above). Use the id when you have it: a name is only what the worker is called now, and a person can change it.

## What the office keeps

The identity is in each floor's `workers.json`, in the office's data folder ([configuration](configuration.md)). A worker saved by an older office has no `role`; it loads as a General Worker, and a name that is missing or isn't text loads as `Worker`. A role id this office has no row for (written by a newer one) is kept as it is and shown as itself, so rolling back and forward again loses nothing.

**Sent home, a worker's name goes with it.** The office keeps no profile of a worker once it's gone, and a name is free to use again. The queue's tasks and the meeting's seats remember the name the worker had when it took them, so what a record says about who did the work stays true: a task shows the worker's current name while it is at a desk, and the name it had once it has gone home.

### Migration and rollback

There is no migration step: the new field is optional, and the old file loads as it is.

To go back to an office without this change, put the previous build back, as for any upgrade. Its `workers.json` reader ignores the `role` key and keeps every name (any text is a name to it), so every worker still loads; the roles are dropped the next time the older office saves, and everyone is a General Worker again when you move forward. If you want them back after that, copy `workers.json` somewhere before you roll back: it is a plain JSON list, and its `role` fields are the only thing that's lost.

## What a rename has to leave alone

These are the places that used a worker's name, and what they do now.

| Where | What it does |
| --- | --- |
| The worktree's folder and branch (`office/<name>-<id>`) | Made once from a plain-letter form of the name, and stored. A rename never touches them |
| Finding a worker from `office-workers` and the MCP tools | The id first, then the name as it is now. The old name finds nothing |
| The queue's `workerName`, a meeting seat's `workerName` | A snapshot from when it started. The queue and the meeting window show the worker's name as it is while the worker is at a desk |
| The worker's 3D nameplate and desk hint | Follow the rename as soon as the office says so |
| Pull request text, toasts, text already printed in a terminal | Written with the name at the time, which is what they should say |
| The automatic pool | Skips any name in use, however it was written |

## Not here

Nothing routes work by role yet. Choosing a worker for a task, checking that it may take it, and anything about permissions are a separate piece of work that can build on `(floor, id, role)`.
