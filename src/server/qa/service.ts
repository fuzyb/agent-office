// PR verification for one floor. It reads what the office already knows (the board's pull requests, which
// the existing GitHub sync refreshes on its own timer; the workers; the queue) and recomputes a pull
// request's standing when that sync reports, never on a timer of its own and never by asking a model. A
// review is given to an existing worker through dispatch, and counts only through records the office made
// itself. Nothing here merges, pushes, comments, or starts a check run.
import { randomBytes } from 'node:crypto';
import { assess, wantsConfirmation, type Authors, type PrFacts } from '../../shared/qa.js';
import { previewDispatch, type TaskFacts, type WorkerFacts } from '../../shared/dispatch.js';
import type { Blocked } from '../../shared/protocol/dispatch.js';
import type { GhPull, WorkerInfo } from '../../shared/protocol.js';
import type { PrAssessment, QaAssignment, QaEvidence, QaViewState, ReviewerOffer } from '../../shared/protocol/qa.js';
import { conditions, confirm, factsOf, type DispatchFloor, type DispatchOffice } from '../dispatch/dispatcher.js';
import type { PullExtra, ShaChecks } from '../gh-checks.js';
import { QaStore, type AuthorsSeen } from './store.js';

/** The roles whose workers are offered a review. A role is only what a worker is for here: whether it may review this pull request is about who wrote it. */
const REVIEWERS: ReadonlySet<string> = new Set(['qa-engineer', 'reviewer']);

/** The GitHub side QA needs: the board's pull requests, what the sync kept of them, and two read-only questions. */
export interface QaGitHub {
  readonly pulls: { readonly items: GhPull[] };
  extras(n: number): PullExtra | undefined;
  requiredChecks(base: string): Promise<string[] | null>;
  shaChecks(sha: string): Promise<ShaChecks>;
}

export interface QaFloor extends DispatchFloor {
  readonly queue: DispatchFloor['queue'] & { add(...a: Parameters<import('../queue.js').TaskQueue['add']>): string | undefined; remove(taskId: string): string | undefined };
}

export interface QaEvents {
  emit(state: QaViewState): void;
  toast(text: string): void;
}

const id = () => randomBytes(6).toString('hex');

/** The instructions a reviewer gets. Plain text from the facts: it costs nothing to make and nothing to read twice. */
export function reviewPrompt(pr: { number: number; title: string; url: string; sha: string; base: string }): string {
  return [
    `Review pull request #${pr.number} “${pr.title}” (${pr.url}) at exactly commit ${pr.sha}.`,
    '',
    `Read only that commit's diff (\`gh pr diff ${pr.number}\`), check it against the project's rules and tests, and say what you found. Do not merge, push, approve or comment on GitHub, and do not change the code: you are not its author, so your job is to judge it.`,
    '',
    `When you have decided, report it to the office with your own tool, not in a GitHub comment (a comment is not evidence here):`,
    `  office-workers review-submit --pr ${pr.number} --sha ${pr.sha} --verdict approve|changes|comment <<'EOF'`,
    `  …what you checked and found, briefly…`,
    `  EOF`,
    `(or the MCP tool submit_pr_review). If the pull request's head is no longer ${pr.sha.slice(0, 7)}, stop and say so: this review would be about a different commit.`,
  ].join('\n');
}

export class QaService {
  readonly store: QaStore;
  private last = '';
  private states = new Map<number, PrAssessment>();
  /** The checks of exact commits, by SHA: asked once a pull request is otherwise ready, and kept while they are all done. */
  private commits = new Map<string, ShaChecks>();
  private announced = new Set<string>();
  private going = new Map<string, Promise<boolean>>();
  private requiredKnown = false;
  /** The checks each base branch requires, as the last sync found them (null: the repository did not say). */
  private required = new Map<string, string[] | null>();

  constructor(
    dataDir: string,
    private floor: QaFloor,
    private office: () => DispatchOffice,
    private github: QaGitHub,
    private events: QaEvents,
  ) {
    this.store = new QaStore(dataDir);
  }

  /** The pull requests as the board last had them, each with where it stands. */
  state(): QaViewState {
    return { floorId: this.floor.id, prs: [...this.states.values()].sort((a, b) => a.number - b.number), policy: { merge: 'human', autoReview: false, requiredKnown: this.requiredKnown }, at: Date.now() };
  }

  /** The board's pull requests changed (the sync reported): work out where each stands. Nothing is asked of a model, and a settled commit is not asked about again. */
  async onPulls(items: GhPull[]): Promise<void> {
    const open = items.filter((p) => p.state === 'OPEN' && typeof p.headRefOid === 'string' && this.github.extras(p.number));
    const bases = [...new Set(open.map((p) => p.baseRefName))];
    const required = new Map<string, string[] | null>(await Promise.all(bases.map(async (b) => [b, await this.github.requiredChecks(b).catch(() => null)] as const)));
    this.required = required;
    this.requiredKnown = [...required.values()].some((r) => r !== null);
    this.rememberAuthors(open);
    await this.settle(open, required);
  }

  /** Recomputes, then asks GitHub for the checks of exactly the commits that are otherwise ready, and recomputes if that told anything. */
  private async settle(open: GhPull[], required: Map<string, string[] | null>): Promise<void> {
    const wanted = this.recompute(open, required);
    if (!wanted.length) return;
    const got = await Promise.all(wanted.map((sha) => this.confirmSha(sha)));
    if (got.some(Boolean)) this.recompute(open, required);
  }

  /** Asks GitHub for the checks of exactly `sha`, unless it already answered and everything was done. Whether it changed anything. */
  private confirmSha(sha: string): Promise<boolean> {
    let going = this.going.get(sha);
    if (!going) {
      going = this.askSha(sha).finally(() => this.going.delete(sha));
      this.going.set(sha, going);
    }
    return going;
  }

  private async askSha(sha: string): Promise<boolean> {
    const have = this.commits.get(sha);
    if (have && have.exact && have.checks.length && have.checks.every((c) => c.state === 'pass' || c.state === 'skip')) return false;
    try {
      const got = await this.github.shaChecks(sha);
      if (have && JSON.stringify(have.checks) === JSON.stringify(got.checks) && have.exact === got.exact) return false;
      this.commits.set(sha, got);
      return true;
    } catch {
      return false;
    }
  }

  private authorsOf(p: GhPull): Authors {
    const workers = this.floor.workers.list();
    const tasks = this.floor.queue.state().tasks;
    const seen = this.store.authors.get(p.number) ?? { ids: [], names: [], providers: [] };
    const ids = new Set(seen.ids);
    const names = new Map(seen.ids.map((x, i) => [x, seen.names[i] ?? x]));
    const prov = new Map(seen.ids.map((x, i) => [x, seen.providers[i]]));
    const add = (w: { id: string; name: string; provider?: string }) => {
      ids.add(w.id);
      names.set(w.id, w.name);
      prov.set(w.id, w.provider);
    };
    for (const w of workers) {
      if (w.pr?.number === p.number || w.pastPrs?.includes(p.number) || (w.worktree && (w.worktree.branch === p.headRefName || w.worktree.made === p.headRefName))) add(w);
    }
    // A worker that has gone home still did the work: its queue task remembers who it was.
    for (const t of tasks) if (t.pr?.number === p.number && t.workerId) add({ id: t.workerId, name: t.workerName ?? t.workerId, provider: t.provider });
    const list = [...ids];
    return { known: list.length > 0, ids: list, names: list.map((x) => names.get(x) ?? x), providers: list.map((x) => prov.get(x)) };
  }

  private rememberAuthors(open: GhPull[]) {
    let changed = false;
    for (const p of open) {
      const a = this.authorsOf(p);
      const before = this.store.authors.get(p.number);
      if (!a.known || (before && before.ids.length === a.ids.length)) continue;
      this.store.authors.set(p.number, { ids: [...a.ids], names: [...a.names], providers: [...a.providers] } satisfies AuthorsSeen);
      changed = true;
    }
    if (changed) this.store.save();
  }

  private factsFor(p: GhPull): PrFacts {
    const x = this.github.extras(p.number)!;
    return { number: p.number, title: p.title, url: p.url, author: p.author, sha: p.headRefOid!, base: p.baseRefName, draft: p.isDraft, mergeable: x.mergeable, fork: x.fork, files: x.files, checks: x.checks, updatedAt: p.updatedAt };
  }

  /** Recomputes every open pull request; tells the floor when anything changed. Returns the commits whose own checks are worth asking for. */
  private recompute(open: GhPull[], required: Map<string, string[] | null>): string[] {
    const next = new Map<number, PrAssessment>();
    const wanted: string[] = [];
    for (const p of open) {
      const facts = this.factsFor(p);
      const asked = this.commits.get(facts.sha);
      const pending = this.store.assignments.find((a) => a.pr === p.number && a.sha === facts.sha && !a.evidenceId);
      const a = assess(facts, {
        required: required.get(p.baseRefName) ?? [],
        requiredKnown: required.get(p.baseRefName) != null,
        confirmed: asked?.exact ? { sha: asked.sha, checks: asked.checks } : undefined,
        evidence: this.store.evidence,
        authors: this.authorsOf(p),
        ...(pending ? { assigned: { workerName: pending.workerName, at: pending.at } } : {}),
      });
      next.set(p.number, a);
      if (wantsConfirmation(a)) wanted.push(facts.sha);
      const key = `${p.number}@${facts.sha}`;
      if (a.state === 'ready' && !this.announced.has(key)) {
        this.announced.add(key);
        this.events.toast(`🧪 PR #${p.number} is ready for a person to merge: ${p.title}`);
      }
    }
    this.states = next;
    const json = JSON.stringify([...next.values()]);
    if (json !== this.last) {
      this.last = json;
      this.events.emit(this.state());
    }
    return wanted;
  }

  private current(n: number): PrAssessment | string {
    const a = this.states.get(n);
    return a ?? `No open pull request #${n} on this floor`;
  }

  // --- Giving a review to an existing worker ---------------------------------------------------------------------------------------------------

  /** Idle QA Engineers and Reviewers who could take the review of pull request `n`, never one that did the work. Changes nothing. */
  offer(n: number): ReviewerOffer | string {
    const a = this.current(n);
    if (typeof a === 'string') return a;
    const office = this.office();
    const facts: WorkerFacts[] = [];
    for (const f of office.floors()) {
      if (f.id !== this.floor.id) continue; // another floor's workers are never offered
      for (const w of f.workers.list()) facts.push({ ...factsOf(f, w, f.queue.state().tasks), owner: undefined });
    }
    const task: TaskFacts = { id: `review-${n}`, title: `Review PR #${n}`, floorId: this.floor.id, needs: { providers: [...new Set(facts.map((w) => w.provider).filter((p): p is NonNullable<typeof p> => !!p))] } };
    const base = previewDispatch(task, facts, conditions(office, this.floor));
    const pull = this.github.pulls.items.find((p) => p.number === n);
    const authors = pull ? this.authorsOf(pull) : { known: false, ids: [] as string[], names: [], providers: [] };
    const byId = new Map(facts.map((w) => [w.id, w]));
    // Whoever did the work is told so first, whatever else keeps it from taking a review.
    const blocked: Blocked[] = base.blocked.map((b) => (authors.ids.includes(b.workerId) ? { ...b, reasons: ['it did this work, and cannot review it', ...b.reasons] } : b));
    const candidates = base.candidates.filter((c) => {
      const w = byId.get(c.workerId)!;
      if (authors.ids.includes(w.id)) return blocked.push({ workerId: w.id, name: w.name, floorName: w.floorName, reasons: ['it did this work, and cannot review it'] }), false;
      if (!w.role || !REVIEWERS.has(w.role)) return blocked.push({ workerId: w.id, name: w.name, floorName: w.floorName, reasons: ['it is not a QA Engineer or a Reviewer'] }), false;
      return true;
    });
    const pending = candidates.length ? undefined : `Nobody on this floor can take it now (${blocked.length} worker${blocked.length === 1 ? '' : 's'} excluded). Nobody was hired: free a QA Engineer or Reviewer, or record a review yourself.`;
    return { pr: n, sha: a.sha, candidates, blocked, ...(pending ? { pending } : {}) };
  }

  /** Gives the review of the head commit to one existing worker, through dispatch: never hires, never interrupts, never the author. */
  assign(n: number, sha: string, workerId: string, by: string): { ok: boolean; message: string } {
    const a = this.current(n);
    if (typeof a === 'string') return { ok: false, message: a };
    if (a.sha !== sha) return { ok: false, message: `PR #${n} changed since you looked (the head is now ${a.sha.slice(0, 7)}): look again` };
    if (a.evidence.some((e) => e.status === 'counts' && e.kind === 'worker')) return { ok: false, message: `This commit already has a review that counts: no second one is asked for` };
    const open = this.store.assignments.find((x) => x.pr === n && x.sha === sha && !x.evidenceId);
    if (open) return { ok: false, message: `${open.workerName} already has the review of this commit` };
    const offer = this.offer(n);
    if (typeof offer === 'string') return { ok: false, message: offer };
    const pick = offer.candidates.find((c) => c.workerId === workerId);
    if (!pick) return { ok: false, message: `${offer.blocked.find((b) => b.workerId === workerId)?.reasons.join('; ') ?? 'That worker is not one of those who can take it'}` };
    const w = this.floor.workers.get(workerId) as WorkerInfo;
    const text = reviewPrompt({ number: n, title: a.title, url: a.url, sha, base: a.base });
    const owner = this.floor.workers.ownerOf(workerId);
    const before = new Set(this.floor.queue.state().tasks.map((t) => t.id));
    const err = this.floor.queue.add(text, by, `Review PR #${n} @ ${sha.slice(0, 7)}`, undefined, w.provider, undefined, undefined, owner, { hold: true, needs: { providers: w.provider ? [w.provider] : undefined } });
    if (err) return { ok: false, message: err };
    const task = this.floor.queue.state().tasks.find((t) => !before.has(t.id))!;
    const given = confirm(this.office(), this.floor, task.id, workerId, by, { providers: w.provider ? [w.provider] : undefined });
    if (!given.ok) {
      this.floor.queue.remove(task.id);
      return given;
    }
    const rec: QaAssignment = { id: id(), pr: n, sha, workerId, workerName: w.name, workerProvider: w.provider, taskId: task.id, by, at: Date.now() };
    this.store.assignments.push(rec);
    this.store.save();
    this.refresh();
    return { ok: true, message: `${by} gave the review of PR #${n} (${sha.slice(0, 7)}) to ${w.name}` };
  }

  // --- Reviews the office holds ------------------------------------------------------------------------------------------------------------------

  /**
   * A worker's verdict, through its own authenticated tool call: `workerId` is who the office knows the caller
   * is, from its token. Only the worker a review was given to, and only for the commit it was given for.
   */
  submit(workerId: string, n: number, sha: string, verdict: string, summary: string): { ok: boolean; message: string } {
    if (!['approve', 'changes', 'comment'].includes(verdict)) return { ok: false, message: 'verdict is approve, changes or comment' };
    const given = this.store.assignments.find((x) => x.pr === n && x.workerId === workerId && !x.evidenceId);
    if (!given) return { ok: false, message: `You were not given the review of PR #${n}, or you have answered it: only the worker a person gave it to can report a verdict` };
    if (given.sha !== sha) return { ok: false, message: `You were given the review of ${given.sha.slice(0, 7)}, not ${sha.slice(0, 7)}: a verdict about another commit is not recorded` };
    const w = this.floor.workers.get(workerId);
    const e: QaEvidence = { id: id(), pr: n, sha, kind: 'worker', verdict: verdict as QaEvidence['verdict'], summary: summary.trim().slice(0, 4000), at: Date.now(), reviewerId: workerId, reviewerName: w?.name ?? given.workerName, reviewerProvider: w?.provider ?? given.workerProvider };
    this.store.evidence.push(e);
    given.evidenceId = e.id;
    this.store.save();
    this.refresh();
    return { ok: true, message: `Recorded: ${verdict} for PR #${n} at ${sha.slice(0, 7)}. It counts while that stays the head and you are not known to have written it.` };
  }

  /** A person records a review they made, or imported from the QA Director desk, about the head commit. The caller checks they may. */
  attest(n: number, sha: string, verdict: 'approve' | 'changes' | 'comment', reference: string | undefined, summary: string | undefined, by: string): { ok: boolean; message: string } {
    const a = this.current(n);
    if (typeof a === 'string') return { ok: false, message: a };
    if (a.sha !== sha) return { ok: false, message: `PR #${n} changed since you looked (the head is now ${a.sha.slice(0, 7)}): a review is about one commit, so look again` };
    this.store.evidence.push({ id: id(), pr: n, sha, kind: 'human', verdict, summary: (summary ?? '').trim().slice(0, 2000), at: Date.now(), by, ...(reference?.trim() ? { reference: reference.trim().slice(0, 200) } : {}) });
    this.store.save();
    this.refresh();
    return { ok: true, message: `${by} recorded: ${verdict} for PR #${n} at ${sha.slice(0, 7)}` };
  }

  /** Recomputes from the last list the board had, after a record changed. */
  private refresh() {
    const open = this.github.pulls.items.filter((p) => p.state === 'OPEN' && typeof p.headRefOid === 'string' && this.github.extras(p.number));
    void this.settle(open, this.required);
  }
}
