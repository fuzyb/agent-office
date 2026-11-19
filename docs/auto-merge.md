# Controlled automatic merging

Back to the [features](features.md). Builds on [dispatch](dispatch.md) and [PR verification](qa-verification.md).

The owner's operating model: **most development pull requests go from implementation to independent QA to merge without a person**
(the target is about 95%), and **billing, payments, subscriptions, spending and financial commitments are the one exception**,
which a person always decides. This is the mechanism for that. **It is off, in two separate ways, until the owner turns it on, and nothing in
this change turns it on.** Humans merge today, and the rules that say so (the HQ `AGENTS.md`) are not touched by this code: see
[what the owner has to authorize first](#before-it-is-switched-on).

## Two keys, both closed by default

1. **The operator's gate.** Unless the office is started with `AGENT_OFFICE_AUTOMERGE=enabled` in its environment, the whole feature
   is inert: the QA view says automatic merging is not available, the policy cannot be turned on (even by an admin, even by sending the
   message by hand), QA does nothing by itself, and the merge code refuses. It cannot be opened from the browser.
2. **A policy per repository,** set by an **admin**, in the QA view, **with a written authorization** (a link or reference to the owner's
   governance record; it is kept with the policy and written into every merge in the audit). It is for the floor's own repository only: no
   message can name another. Modes: *off* (default), *approve* (an admin approves each commit; everything else is the same), *auto* (the
   operating model: nobody clicks).

An **emergency stop** (anyone can press it, an admin resumes) halts every automatic merge, review assignment and correction in the office at
once, including an attempt in progress, and survives a restart.

## The loop

It runs when the GitHub sync reports (no timer, no model, nobody is hired):

1. **Read the change.** For each new commit, the office reads its own diff from GitHub, pinned to that commit, and rules billing and spending out
   *before* any review is asked for. A diff that cannot be read keeps it with a person.
2. **QA.** Checks of exactly that commit and an independent review of it, as in [PR verification](qa-verification.md).
3. **Review, automatically.** A pull request that needs a review is given to an **existing, idle QA Engineer or Reviewer** through dispatch.
   Never the worker that wrote it (or anyone the office knows touched it), never one that already reviewed this commit, never a busy worker (it
   waits for the next sync; nobody is interrupted), never one whose plan window is spent, never a worker on another floor, and nobody is hired. If
   nobody is free the pull request waits.
4. **Merge.** When QA says *ready* and everything is asked of GitHub again (see below), the office merges. No owner click.
5. **When it does not pass,** it stays unmerged and the problem goes back to **the worker that wrote it**, as a prompt in its own terminal: the
   failed checks (with links), a conflict or being behind its base, or what a reviewer asked to change (quoted as data, never as orders). Once per
   commit, never to a busy author, at most three rounds per pull request. Pushing a new commit starts the checks and the review over.
6. **Escalate only what is genuinely blocked:** billing/spending, the rules themselves, a change that is not fully known, an author who has left
   (nobody is hired to take over), an author the office cannot identify, three rounds that did not get through, GitHub refusing a merge three
   times. Each is written to the record once and shown to the owner as "needs a person".

## Which pull requests qualify

Decided from the change by plain code (`src/shared/merge.ts`, `src/shared/financial.ts`). **Eligible:** application code, tests, documentation,
infrastructure, security, dependencies and CI, from the floor's own repository into a branch the policy names, with the whole file list known and
within the size limits (2000 lines / 60 files by default; the owner can set them up to 5000 / 99).

| Tier | What | Verified by |
| --- | --- | --- |
| standard | everything eligible that is not below | the checks of the exact commit and **one** independent review |
| strict | CI workflows, installs and deploy, infrastructure scripts, dependencies and lockfiles, authentication/security code, secrets and keys, tool and root configuration | the checks, and **two different independent reviewers** of the exact commit (or one person), with a review prompt that names what to look for |

**Never unattended, whatever any policy, approval or review says (a person decides):**

- **Billing, payments, subscriptions, spending and financial commitments.** Found in the changed **paths** (billing, payments, checkout, subscriptions,
  invoices, pricing, refunds, wallets, budgets, a payment processor...), the **title**, and every **added or removed line** of the diff: payment
  processors and their SDKs, live payment keys, billing/payment/refund/invoice/card terms, subscription and pricing terms, spend/budget/purchase
  terms, paid model and credit-spending APIs, and provisioned cloud resources. camelCase and snake_case are split into words. Removing a payment
  check counts as much as adding one, and so does renaming a file out of a billing folder. It is deliberately broad: a false alarm costs one
  person's merge, a miss spends money. When the diff cannot be read, or is too large for GitHub to return, a person decides.
- **The rules and the safeguards themselves:** `AGENTS.md`, `CLAUDE.md`, `roles/`, `playbooks/`, `templates/`, `projects/`, `private/`, `.claude/`,
  `CODEOWNERS`, and the code, tests and docs of this mechanism, its financial classifier, the merge and check code that talks to GitHub, and the QA
  code that judges reviews. The office does not merge unattended a change to the thing that decides what it merges. This is a deliberate exception
  the owner can lift in the code, not in a setting.
- A change that is **not fully known** (file list missing or cut off), from a **fork**, aimed at a branch the policy does not name, over the size
  limits, or touching a path the owner listed as **always for a person** (the policy's "paths that always need a person").

## What has to be true to merge

Only a pull request QA calls **ready** is a candidate: the checks of exactly its head commit pass and an independent review of that commit stands (a
worker's review the office recorded, only when the office knows the reviewer did not write the code, or a person's; two for the strict tier).
Pull request comments, GitHub's approval state, labels, role names and the shared GitHub account are never read as approval.

Then, **immediately before merging, all of this is asked of GitHub again, not taken from memory**, and any change, any doubt and any failure to
ask means no merge and a line in the audit saying why:

- the pull request is open, not a draft, in this floor's repository, not from a fork, and aimed at an allowed branch;
- its head is still the commit that was reviewed;
- **the change itself, read again, pinned to that commit:** not billing, payments, subscriptions or spending, not the rules, and which tier;
- the login the office runs as may merge there;
- the base branch has readable **branch protection with required checks** (so GitHub enforces them), and GitHub calls the pull request
  mergeable with every branch rule met (`CLEAN`); the office does not get round a rule that says otherwise (a branch that is behind or conflicting is
  sent back to its author);
- the checks of exactly that commit, asked by its SHA: all done, all passing, every required one present;
- the review(s) of exactly that commit still count: one, or two different reviewers for the strict tier;
- the gate is open, no emergency stop, the policy still on (and, in approve mode, the approval still stands).

The merge itself is `gh pr merge <n> --squash|--merge|--rebase --match-head-commit <sha>`: GitHub refuses it if the head is no longer that
commit. Never `--admin`, `--auto`, `--delete-branch` or a force-push, and no repository or security setting is touched. One merge is tried per
commit at a time, never again once merged (also after a restart), and a commit GitHub refuses three times is left to a person.

## Changes while it verifies, and failed saves

- **A change during verification voids the attempt.** The policy and the emergency stop carry a revision that moves on every change (even one that
  could not be saved). An attempt notes it when it begins and looks again after every question it asks GitHub and just before the merge call: if it
  moved, the attempt is void and nothing is merged, **even if the state is back to what it was** (a stop followed by a resume). It is not resumed:
  a new attempt starts over and asks everything again. Just before the call the office also reads again the current policy (allowlist, branches, method)
  and, in approve mode, that the approval standing is the one it started with.
- **A save that fails fails closed.** Switching a repository on, changing its policy, and resuming after a stop take effect only once they are saved: if
  the write fails, nothing changed and it says so. Switching off and stopping take effect at once, saved or not; if they cannot be saved the office stays
  stopped, says it could not be saved (never reports a success), removes the older file if it can and writes a marker if it can, so a restart does not bring
  back the policy that was just taken away. A marker found at startup means nothing is on and it is stopped until an admin resumes it and switches each
  repository on again. Files are written whole (a temporary file, then a rename). If the disk refuses every write and every removal, nothing more can be
  promised after a restart: the failure is reported, and the running office stays stopped.

## The record

Every decision, approval, review given, correction sent, escalation, attempt, call to GitHub, merge, refusal, policy change, stop and resume is one
line in the floor's `.agent-office/merge-audit.jsonl` (kinds `decision`, `approval`, `assigned`, `routed`, `escalated`, `attempt`, `merging`,
`merged`, `blocked`, `policy`, `stop`, `resume`): append-only, never rewritten, with who (a person's name, or `office`) and why. The QA view shows the
latest. **If a line cannot be written, no merge is attempted.** A pull request that keeps being refused for the same reason is written down once.
No credential is ever in it. Reading the record is how the owner checks the target: the share of merged pull requests with no `escalated` line.

## Agents cannot touch it

There is no worker route, no MCP tool, no `office-workers` command and no message a worker can send for the policy, the gate, an approval, the stop or
a merge; a test checks the route's source, its answers and the tool list. A worker cannot activate it, change its policy or approve its own work, and
no pull request can change the code that decides what merges unattended. A reviewer speaks only through its own authenticated tool call, and only for
the commit it was given. Nothing here hires, calls a model, or runs on a timer of its own.

## Before it is switched on

Nothing in this change activates it, edits `AGENTS.md` or any project governance, or performs a merge. **Do not bypass the existing governance:**
until the owner approves the changes below in HQ, humans merge. These are the owner's decisions and actions, in this order:

1. **Governance (HQ), in a reviewed HQ pull request.** The HQ rule that humans merge (`AGENTS.md`, "How work moves", step 5: *"Humans merge. No agent
   merges…"*) says changing it needs a **separately approved security design**. The design should record, and the changes should state:
   - the autonomy policy: development pull requests may be merged by the office after independent QA and passing required checks; **billing, payments,
     subscriptions, spending and financial commitments are the manual-approval exception** and may never be merged unattended;
   - which repositories (by name), which branches, which merge method, and the authorization reference that goes in each policy;
   - the strict tier (what counts as sensitive, and that it needs two independent reviewers), and that the rules and the safeguards (above) stay human;
   - who may press the emergency stop and who may resume it, and how often the record is reviewed;
   - that agents never activate it, edit its policy, approve their own work, or review what they wrote (and the office's own enforcement of that);
   - the amended text of `AGENTS.md` and `CLAUDE.md`, `docs/WORKFLOW.md`, and the *Repository permissions* of each affected project's
     `projects/<slug>/brief.md` (which today says *Never: merge… PRs*), and the amended wording of the QA playbook if reviews are no longer human-only.
   The link to that merged HQ record is what goes in the policy's **authorization** field.
2. **GitHub, for each repository.** Branch protection on the target branch with named **required status checks**, up to date before merging, and **no
   bypass** (including administrators); owners for sensitive paths. Merging needs a login with write access: prefer a dedicated, least-privilege machine
   login for the office's `gh`, not the identity every agent shares (a shared identity cannot show who approved).
3. **The operator** starts the office with `AGENT_OFFICE_AUTOMERGE=enabled`.
4. **An admin** turns it on for one repository with the authorization reference: *approve* mode to watch the first merges, then *auto*, which is the
   operating model. Both use the same checks.
5. **To stop:** press the emergency stop; set the repository to *off*; unset the variable and restart the office.

## Limits

- **The 95% is an outcome to measure, not a guarantee.** The design removes the person from the normal path; what stays with a person is what is listed
  above, plus pull requests whose author the office cannot identify (a worker review cannot be shown independent, so a person's review is needed),
  oversized changes, forks, and anything while no QA Engineer or Reviewer is free.
- **Money detection is text matching.** It reads paths, the title and the diff, not the pull request body, linked issues, binaries or generated
  assets, and it can both over-block (the word "subscription" in unrelated code) and miss a financial change described in unusual words or hidden in a
  value it does not know. GitHub's own required checks and the independent review are the other layers, and the owner can add paths that always need a
  person.
- It knows only the open pull requests the GitHub sync lists (150) and their first 100 files; more counts as unknown, which needs a person.
- A correction is a prompt to the author's own terminal; it relies on that worker still being on the floor and idle, and nobody is hired to replace it.
- Independence is only as good as the office's records of who wrote the code. The merge method is one per repository; approvals do not carry over to
  a new commit.
