# PR verification and the QA view

Back to the [features](features.md). Builds on [dispatch](dispatch.md).

Where each open pull request of a floor stands, with the evidence behind it, and giving a review to an
existing worker. **Ready** means *ready for a person to merge*. Nothing here merges, pushes, comments, reruns a
check, hires anyone or calls a model.

## Where a pull request stands

Decided by plain code (`src/shared/qa.ts`) from what the office already has: the board's pull requests, which the
existing GitHub sync refreshes on its own timer, the workers, the queue, and the reviews it holds. In this order:

| State | When |
| --- | --- |
| **Failed** | a check failed, or it has merge conflicts |
| **Blocked** | it touches CI workflows, installation, dependencies, authentication/secrets, comes from a fork, or its file list is incomplete, and no person has reviewed it; or a review of this commit asked for changes |
| **Awaiting checks** | a draft, checks running, or a required check that has not reported (or none at all) |
| **Needs review** | checks pass, but no independent review of *this commit* counts |
| **Ready for human merge** | the checks of *exactly this commit* pass and an independent review of it stands |

The **QA** button on the pull request board opens the view: awaiting, failed, needs an independent review, review evidence on
file, ready, blocked. Each pull request shows its exact commit, every check with its link, what it touches, who did the work (by the
office's own records), and each review with whether it counts and why not.

## What counts as proof

- **Not a green build.** Checks say it builds and passes its tests, nothing more.
- **Not anything GitHub says about approval.** Every agent shares one GitHub account, so an approval, a label, an author name, a comment or
  a "Reviewed-by" line proves nothing; they are never read.
- **Not a role label.** A worker's role says what it is for, not that it reviewed anything.
- **Only what the office recorded itself**, bound to one commit, and only while that commit is the head:
  1. a **worker's review**: a person gave the review to that worker (below) and the worker reports its verdict with its own tool
     (`office-workers review-submit`, or the MCP tool `submit_pr_review`), authenticated by its own token. Only the worker given the review, once, for the
     commit it was given. It counts only if the office knows the reviewer is **not an author**: the author is whoever's worker record, branch or
     queue task is linked to the pull request (remembered after the worker goes home). If the office cannot tell who wrote it, a worker's review
     is shown as *unverifiable* and does not count;
  2. a **person's review** (admins): recorded in the QA view, for a verdict they reached or imported from the **QA Director** desk. The
     ChatGPT request and the verdict import stay human, as they are; this only records that a person stands behind a verdict for this commit.
- A pull request that needs a person (the blocked list) is ready only with a person's review.
- A new head invalidates everything: the review shows as *stale*, and the checks and the review are asked for again.

## Exact commit

Ready needs GitHub's own check runs and statuses **for that commit's SHA** (a read-only `gh api`), each check run reporting that SHA as its
own. They are asked for only once a pull request is otherwise ready, and kept while they are all done: a settled commit is not asked about
again, and a passing check is never rerun (nothing here can). Required checks come from the repository's branch protection when it says;
otherwise every check that reported must pass and at least one must.

## Giving a review to an existing worker

**Find a reviewer** lists the idle QA Engineers and Reviewers on this floor, best first with the reasons, and the others with why not. It uses
[dispatch](dispatch.md): never a busy worker, never another floor, never one on a different account or at its plan limit, never a hire.
**The author never qualifies.** Admins can **Give the review** to one: it is queued as a held task and given through dispatch, with a short
fixed prompt naming the pull request and the exact commit. The prompt pins the work to the commit: the head is checked first, the diff is read from GitHub's compare of the base with that
SHA (never `gh pr diff` or a checkout, which follow the head), and the head is checked again at the end. A commit that already has a
review that counts, or one out for answer, is not given a second.

**If the pull request changes during the review**, the verdict is rejected: when it is reported, the office asks GitHub for the head right
then (not the last sync's), and a verdict about a commit that is no longer the head is not recorded, not even as stale evidence. That review
is closed, and the new commit needs a review of its own (a new offer, a new assignment, pinned to the new SHA). If GitHub cannot be asked, nothing
is recorded and the worker reports again.

## Who can do what

Everyone on a floor can look (their own floor's pull requests only). Giving a review to a worker and recording one are for admins. A worker's
verdict is the authenticated worker's own, whatever its request says.

## Usage

No timer of its own and no model. It recomputes when the GitHub sync reports, pushes the answer to the floor, and asks GitHub about a commit
once. Reviews live in `.agent-office/qa.json` of the floor.

## Limits

- Reads the open pull requests the sync lists (150). Changed files beyond 100 are not seen, which counts as unknown, and unknown needs a person.
- Independence is only as good as the office's records of who wrote the code; a pull request from outside the office needs a person's review.
- It does not look at the code or the review's quality: a worker can approve a bad change. A person still merges.
- Same-provider reviews are shown as such (`cross-provider` is marked when the agents differ); policy on that is left to the owner.
