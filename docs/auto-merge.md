# Controlled automatic merging

Back to the [features](features.md). Builds on [dispatch](dispatch.md) and [PR verification](qa-verification.md).

An optional way for the office to merge a pull request that is both low-risk and fully verified. **It is off, in two
separate ways, until the owner turns it on, and nothing in this change turns it on.** Humans merge today, and the
rules that say so (the HQ `AGENTS.md`) are not touched by this code: see [what the owner has to authorize first](#before-it-is-switched-on).

## Two keys, both closed by default

1. **The operator's gate.** Unless the office is started with `AGENT_OFFICE_AUTOMERGE=enabled` in its environment, the whole feature
   is inert: the QA view says automatic merging is not available, the policy cannot be turned on (even by an admin, even by sending the
   message by hand), and the merge code refuses. It cannot be opened from the browser.
2. **A policy per repository,** set by an **admin**, in the QA view, **with a written authorization** (a link or reference to the owner's
   governance record; it is kept with the policy and written into every merge in the audit). The policy is for the floor's own
   repository only: no message can name another. Modes: *off* (default), *approve* (an admin approves each commit, and the office
   still checks everything again), *auto* (merges when everything passes).

An **emergency stop** (anyone can press it, an admin resumes) halts every automatic merge in the office at once, including one that is
in progress, and survives a restart.

## Which pull requests qualify

Decided from the changed files alone (`src/shared/merge.ts`), as an allowlist: **every** file must be documentation, tests, or a path the
owner marked low-risk for that repository, and **none** may be sensitive. Sensitive always wins: the owner's extra paths cannot include
CI workflows, installs and deploy scripts, dependencies and lockfiles, authentication/security code, secrets and keys, build and tool
configuration, `AGENTS.md` and other governance files, infrastructure, or root configuration files. Also required: the whole file list is
known (not cut off), at most 300 changed lines and 20 files (the owner can lower or raise within bounds), not from a fork, and aimed at
a branch the policy names. Everything else is **a person's to merge**, with every reason listed.

## What has to be true to merge

Only a pull request QA calls **ready** is a candidate: the checks of exactly its head commit pass and an independent review of that
commit stands (a worker's review the office recorded, only when the office knows the reviewer did not write the code, or a person's).
Pull request comments, GitHub's approval state, labels, role names and the shared GitHub account are never read as approval.

Then, **immediately before merging, all of this is asked of GitHub again, not taken from memory**, and any change, any doubt and any
failure to ask means no merge and a line in the audit saying why:

- the pull request is open, not a draft, in this floor's repository, not from a fork, and aimed at an allowed branch;
- its head is still the commit that was reviewed;
- the login the office runs as may merge there;
- the base branch has readable **branch protection with required checks** (so GitHub enforces them), and GitHub calls the pull request
  mergeable with every branch rule met (`CLEAN`); the office does not get round a rule that says otherwise;
- the checks of exactly that commit, asked by its SHA: all done, all passing, every required one present;
- the review of exactly that commit still counts;
- the gate is open, no emergency stop, the policy still on (and, in approve mode, the approval still stands).

The merge itself is `gh pr merge <n> --squash|--merge|--rebase --match-head-commit <sha>`: GitHub refuses it if the head is no longer that
commit. Never `--admin`, `--auto`, `--delete-branch` or a force-push, and no repository or security setting is touched. One merge is tried
per commit at a time, never again once merged (also after a restart), and a commit GitHub keeps refusing is left to a person after three
attempts.

## The record

Every decision, approval, attempt, call to GitHub, merge, refusal, policy change, stop and resume is one line in the floor's
`.agent-office/merge-audit.jsonl`: append-only, never rewritten, with who (a person's name, or `office`) and why. The QA view shows the
latest. **If a line cannot be written, no merge is attempted.** No credential is ever in it.

## Agents cannot touch it

There is no worker route, no MCP tool, no `office-workers` command and no message a worker can send for the policy, the gate, an approval,
the stop or a merge; a test checks the route's source, its answers and the tool list. A worker cannot activate it, change its policy or
approve its own work. Hiring and reviewing stay as they were: nothing here hires or calls a model, and it runs when the GitHub sync reports
(no timer of its own).

## Before it is switched on

Nothing in this change activates it. These are the owner's decisions and actions, in this order:

1. **Governance (HQ).** The HQ rule that humans merge (`AGENTS.md`, "How work moves", step 5: *"Humans merge. No agent merges…"*) says changing
   it needs a **separately approved security design**. Before any use, the owner writes and approves that design and changes, in a
   reviewed HQ pull request: `AGENTS.md` and `CLAUDE.md` (what the office may merge, in which repositories, what still needs a person, who may
   press the stop), `docs/WORKFLOW.md`, and the *Repository permissions* of each affected project's `projects/<slug>/brief.md` (which today says
   *Never: merge… PRs*). The link to that merged HQ record is what goes in the policy's **authorization** field.
2. **GitHub, for each repository.** Branch protection on the target branch with named **required status checks**, up to date before merging,
   and **no bypass** (including administrators); owners for sensitive paths. Merging needs a login with write access: prefer a dedicated,
   least-privilege machine login for the office's `gh`, not the identity every agent shares (a shared identity cannot show who approved).
3. **The operator** starts the office with `AGENT_OFFICE_AUTOMERGE=enabled`.
4. **An admin** turns it on for one repository, in **approve** mode first, with the authorization reference, and watches the record. Only
   later, if wanted, **auto**.
5. **To stop:** press the emergency stop; set the repository to *off*; unset the variable and restart the office.

## Limits

- It knows only the open pull requests the GitHub sync lists (150) and their first 100 files; more counts as unknown, which needs a person.
- "Low-risk" is by path and size, not by reading the change: a documentation or test change can still be wrong. That is why the review of the
  exact commit and GitHub's own required checks are both required, and why the owner decides the paths.
- Independence is only as good as the office's records of who wrote the code; where it is unknown, only a person's review counts.
- The merge method is one per repository; approvals do not carry over to a new commit.
