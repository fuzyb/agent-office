// Controlled automatic merging for one floor, behind the gate (merge/gate.ts), a per-repository policy an
// admin set with a written authorization, and the owner's emergency stop. It uses what already exists: the QA
// service's standing for each pull request (checks of the exact commit, an independent review of it), and the
// GitHub integration. It starts nothing on a timer, calls no model, and hires nobody; it runs when the QA view
// recomputes (which the GitHub sync drives) and when a person approves one.
//
// A merge happens only after EVERYTHING is asked again, from GitHub, immediately before: the head, the checks of
// that exact commit, the branch's protection, the login's permission, and the review. Any change, any doubt, any
// failure to ask: no merge, and a line in the audit saying why. GitHub is asked to refuse too (`--match-head-commit`).
//
// Nothing in here is reachable by an agent: it has no worker route, no MCP tool, and its messages are the browser's.
import { financialReasons } from '../../shared/financial.js';
import { classify, DEFAULT_MAX_FILES, DEFAULT_MAX_LINES, filesOfDiff, MAX_FILES, MAX_LINES, METHODS, STRICT_REVIEWS, validExtraGlob } from '../../shared/merge.js';
import type { AuditEntry, AuditKind, MergeClassification, MergeMode, MergePr, MergeViewState, RepoMergePolicy } from '../../shared/protocol/merge.js';
import type { GhPull } from '../../shared/protocol.js';
import type { PrAssessment, QaViewState } from '../../shared/protocol/qa.js';
import type { PullExtra, ShaChecks } from '../gh-checks.js';
import type { MergeOps } from '../gh-merge.js';
import { repoOfUrl, sameRepo } from '../gh-scope.js';
import { FloorMergeStore, PolicyWriteError, type MergePolicyStore } from './store.js';

/** What merging needs of QA: where each pull request stands, and the same worked out again now, from GitHub. */
export interface MergeQaSource {
  state(): QaViewState;
  reassess(n: number): Promise<PrAssessment | undefined>;
  /** Sends the problems of this exact commit back to the worker that wrote it (once per commit, only while automatic merging is on). */
  requestCorrection(n: number, sha: string, problems: string[]): 'sent' | 'waiting' | 'escalated' | 'nothing';
}

export interface MergeDeps {
  floorId: string;
  /** This floor's repository, owner/name, when it has one. */
  repo(): string | undefined;
  /** Whether this installation allows automatic merging at all (see merge/gate.ts). */
  gate(): boolean;
  policy: MergePolicyStore;
  qa: MergeQaSource;
  pulls(): GhPull[];
  extras(n: number): PullExtra | undefined;
  ops: Pick<MergeOps, 'pull' | 'canMerge' | 'merge' | 'diff'>;
  checks: { requiredChecks(base: string, fresh?: boolean): Promise<string[] | null> };
  emit(state: MergeViewState): void;
  toast(text: string): void;
}

/** Times GitHub is asked to merge one commit and refuses, before a person is asked to look. A refusal before that (a rule not met yet) is just tried again. */
const MAX_ATTEMPTS = 3;
const RECENT = 40;
const SCANS_KEPT = 300;

/** What reading a commit's own diff found: what it says about billing and spending, and every path it names. */
interface Scan {
  money: string[];
  files: string[];
}

export class MergeService {
  readonly store: FloorMergeStore;
  private inFlight = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private said = new Set<string>();
  /** The last reason each commit was refused for, so a pull request that keeps being refused for the same reason is written down once. */
  private lastRefusal = new Map<string, string>();
  private scans = new Map<string, Scan>();
  private flagged = new Set<string>();
  private last = '';

  constructor(
    dataDir: string,
    private d: MergeDeps,
  ) {
    this.store = new FloorMergeStore(dataDir);
  }

  // --- What a person sees --------------------------------------------------------------------------------------------------------------------

  private repo(): string {
    return this.d.repo() ?? '';
  }

  private policy(): RepoMergePolicy | undefined {
    return this.d.policy.get(this.d.repo());
  }

  /** Whether automatic merging may act at all right now: the gate is open, nobody pressed stop, and this repository is switched on. */
  private active(): { policy: RepoMergePolicy } | string {
    if (!this.d.gate()) return 'automatic merging is not enabled in this installation (the operator gate is closed)';
    if (this.d.policy.stopped) return `the emergency stop is on (${this.d.policy.stopped.by}${this.d.policy.stopped.reason ? `: ${this.d.policy.stopped.reason}` : ''})`;
    const policy = this.policy();
    if (!this.d.repo()) return 'this floor has no GitHub repository';
    if (!policy || policy.mode === 'off') return `automatic merging is off for ${this.repo()}`;
    return { policy };
  }

  /** Whether this pull request belongs to the floor's own repository, by its URL. One whose URL does not say (or says another repository, such as the upstream of a fork) is never acted on. */
  private mine(p: GhPull): boolean {
    return sameRepo(repoOfUrl(p.url), this.d.repo());
  }

  /** Whether anything unattended may happen right now: the gate is open, nobody pressed stop, and this repository is switched on. */
  on(): boolean {
    return typeof this.active() !== 'string';
  }

  private classification(p: GhPull, policy: RepoMergePolicy | undefined): MergeClassification {
    const x = this.d.extras(p.number);
    const scan = p.headRefOid ? this.scans.get(p.headRefOid) : undefined;
    const files = x?.files ? [...new Set([...x.files, ...(scan?.files ?? [])])] : undefined;
    return classify({ files, lines: p.additions + p.deletions, base: p.baseRefName, fork: x?.fork ?? false, title: p.title, ...(scan ? { diffMoney: scan.money } : {}) }, policy ?? { bases: ['main'], maxChangedLines: DEFAULT_MAX_LINES, maxFiles: DEFAULT_MAX_FILES, humanPaths: [] });
  }

  /** Reads the change of exactly this commit from GitHub and remembers what it says about billing and spending. Throws if it cannot be read. */
  private async read(base: string, sha: string): Promise<Scan> {
    const diff = await this.d.ops.diff(base, sha);
    const scan: Scan = { money: financialReasons({ diff }), files: filesOfDiff(diff) };
    this.scans.delete(sha);
    this.scans.set(sha, scan);
    for (const k of this.scans.keys()) {
      if (this.scans.size <= SCANS_KEPT) break;
      this.scans.delete(k);
    }
    return scan;
  }

  /** Reads the changes of the open pull requests not read yet (once per commit), while automatic merging is on, so billing and spending are ruled out before any review is asked for. */
  async scan(items: GhPull[]): Promise<void> {
    if (typeof this.active() === 'string') return;
    for (const p of items) {
      if (!this.mine(p) || p.state !== 'OPEN' || p.isDraft || !p.headRefOid || this.scans.has(p.headRefOid) || !this.d.extras(p.number)) continue;
      try {
        await this.read(p.baseRefName, p.headRefOid);
      } catch {
        // not read: it is not handled unattended until it is (it is asked again at the next sync, and again before any merge)
      }
    }
  }

  /** What QA may do unattended for this exact commit: true, or why not. Never for billing, payments, subscriptions, spending, the rules themselves, or what is not fully known. */
  allows(n: number, sha: string): true | string {
    const on = this.active();
    if (typeof on === 'string') return on;
    const p = this.d.pulls().find((x) => x.number === n && x.state === 'OPEN');
    if (!p || p.headRefOid !== sha) return 'it is not the head that was asked about';
    if (!this.mine(p)) return `it is not a pull request of ${this.repo()}`;
    if (!this.scans.has(sha)) return 'its changes have not been read yet, so billing and spending are not ruled out';
    const c = this.classification(p, on.policy);
    return c.verdict === 'eligible' ? true : c.reasons[0];
  }

  /** QA gave a review, sent a problem back to its author, or found nobody who can: into the record (and, when a person is needed, to the owner). */
  record(kind: 'assigned' | 'routed' | 'escalated', n: number, sha: string, reasons: string[]) {
    this.tryWrite(kind, 'office', { pr: n, sha, ok: kind !== 'escalated', reasons });
    if (kind === 'escalated') this.d.toast(`🧑 PR #${n} needs a person: ${reasons[0]}`);
    this.push();
  }

  state(): MergeViewState {
    const policy = this.policy();
    const prs: MergePr[] = [];
    for (const q of this.d.qa.state().prs) {
      const p = this.d.pulls().find((x) => x.number === q.number);
      if (!p || !this.mine(p)) continue;
      const c = this.classification(p, policy);
      const approval = this.store.approvals.get(q.number);
      const mine = approval && approval.sha === q.sha ? approval : undefined;
      const key = `${q.number}@${q.sha}`;
      let status: MergePr['status'];
      let reasons: string[] = c.reasons;
      if (this.store.merged.has(key)) [status, reasons] = ['merged', ['merged by the office']];
      else if (c.verdict === 'human') status = 'human';
      else if (policy && policy.mode !== 'off' && !this.scans.has(q.sha)) [status, reasons] = ['not-ready', ['its changes are being read, to rule out billing and spending']];
      else if (q.state !== 'ready') [status, reasons] = ['not-ready', [`QA says: ${q.state}${q.reasons[0] ? ` (${q.reasons[0]})` : ''}`]];
      else if (policy?.mode === 'approve' && !mine) [status, reasons] = ['awaiting-approval', ['eligible: waiting for a person to approve this commit']];
      else status = this.inFlight.has(key) ? 'queued' : this.said.has(`blocked:${key}`) ? 'blocked' : 'queued';
      prs.push({ number: q.number, title: q.title, url: q.url, sha: q.sha, qa: q.state, classification: c, ...(mine ? { approval: mine } : {}), status, reasons });
    }
    const allowlist = [...this.d.policy.repos].map(([repo, p]) => ({ repo, mode: p.mode }));
    return { floorId: this.d.floorId, gate: this.d.gate(), ...(this.d.policy.stopped ? { stopped: this.d.policy.stopped } : {}), ...(this.d.repo() ? { repo: this.repo() } : {}), ...(policy ? { policy } : {}), allowlist, prs, audit: this.store.recent(RECENT), at: Date.now() };
  }

  /** Tells the floor when anything it shows changed. */
  push() {
    const s = this.state();
    const json = JSON.stringify({ ...s, at: 0 });
    if (json !== this.last) {
      this.last = json;
      this.d.emit(s);
    }
  }

  // --- The record -----------------------------------------------------------------------------------------------------------------------------

  private write(kind: AuditKind, by: string, e: Partial<AuditEntry> = {}) {
    this.store.add({ at: Date.now(), repo: this.repo(), kind, by, ...e });
  }

  /** For a change that makes things safer: if the record cannot be written, the change still stands. */
  private tryWrite(kind: AuditKind, by: string, e: Partial<AuditEntry>) {
    try {
      this.write(kind, by, e);
    } catch {
      // the stop or the refusal is what matters; the record is told in the message
    }
  }

  /** A decision is written once for each situation, not at every sync. */
  private decide(n: number, sha: string, ok: boolean, reasons: string[]) {
    const key = `${n}@${sha}|${ok}|${reasons.join('|')}`;
    if (this.said.has(key)) return;
    this.said.add(key);
    this.write('decision', 'office', { pr: n, sha, ok, reasons });
  }

  // --- What the owner controls -----------------------------------------------------------------------------------------------------------

  /** Admin only (the caller checks). Turns automatic merging on for THIS floor's repository, or off. */
  setPolicy(by: string, input: { mode: MergeMode; authorization?: string; method?: string; bases?: string[]; maxChangedLines?: number; maxFiles?: number; humanPaths?: string[] }): { ok: boolean; message: string } {
    const repo = this.d.repo();
    if (!repo) return { ok: false, message: 'This floor has no GitHub repository, so there is nothing to switch on' };
    if (input.mode === 'off') {
      try {
        this.d.policy.set(repo, undefined);
      } catch (e) {
        this.tryWrite('policy', by, { ok: false, reasons: ['turned off in the running office; could not be saved'] });
        this.push();
        return { ok: false, message: e instanceof PolicyWriteError ? e.message : 'Automatic merging is off in the running office, but the change could not be saved' };
      }
      this.tryWrite('policy', by, { ok: true, reasons: ['turned off'] });
      this.push();
      return { ok: true, message: `Automatic merging is off for ${repo}` };
    }
    if (!this.d.gate()) return { ok: false, message: 'Automatic merging is not enabled in this installation: whoever starts the office has to open the gate first (docs/auto-merge.md). Nothing was changed' };
    if (!['approve', 'auto'].includes(input.mode)) return { ok: false, message: 'mode is off, approve or auto' };
    const authorization = (input.authorization ?? '').trim();
    if (authorization.length < 8) return { ok: false, message: 'Say what authorizes it: a link or reference to the owner\'s governance record (at least a few words). Nothing was changed' };
    const method = (METHODS as readonly string[]).includes(input.method ?? 'squash') ? (input.method ?? 'squash') : undefined;
    if (!method) return { ok: false, message: 'method is squash, merge or rebase' };
    const bases = (input.bases?.length ? input.bases : ['main']).map((b) => b.trim()).filter((b) => /^[\w./-]{1,100}$/.test(b)).slice(0, 10);
    if (!bases.length) return { ok: false, message: 'Name the branches it may merge into' };
    const extra = (input.humanPaths ?? []).map((g) => g.trim()).filter(Boolean);
    const badGlob = extra.find((g) => !validExtraGlob(g));
    if (badGlob) return { ok: false, message: `“${badGlob}” is not a path pattern it accepts (no “everything”, no “..”)` };
    const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d);
    const policy: RepoMergePolicy = { mode: input.mode, method: method as RepoMergePolicy['method'], bases, maxChangedLines: clamp(input.maxChangedLines, 1, MAX_LINES, DEFAULT_MAX_LINES), maxFiles: clamp(input.maxFiles, 1, MAX_FILES, DEFAULT_MAX_FILES), humanPaths: extra.slice(0, 20), authorization: authorization.slice(0, 300), authorizedBy: by, authorizedAt: Date.now() };
    try {
      this.d.policy.set(repo, policy);
    } catch (e) {
      this.tryWrite('policy', by, { ok: false, reasons: ['not switched on: the policy could not be saved'] });
      return { ok: false, message: e instanceof PolicyWriteError ? e.message : 'The policy could not be saved, so it was not switched on' };
    }
    this.write('policy', by, { ok: true, reasons: [`mode ${policy.mode}, ${policy.method}, into ${bases.join(', ')}`, `authorization: ${policy.authorization}`] });
    this.push();
    return { ok: true, message: `Automatic merging is ${policy.mode === 'auto' ? 'on' : 'on, with your approval of each commit,'} for ${repo}` };
  }

  /** Someone who may not did (or tried to) change the policy: written down. */
  denied(by: string, what: string) {
    this.write('blocked', by, { ok: false, reasons: [`${by} tried to ${what} and is not an admin`] });
  }

  stop(by: string, reason?: string): { ok: boolean; message: string } {
    try {
      this.d.policy.stop(by, reason);
    } catch (e) {
      // It is stopped in the running office either way; what could not be done is making it survive a restart.
      this.tryWrite('stop', by, { ok: false, reasons: [`stopped in the running office; could not be saved${reason ? `: ${reason}` : ''}`] });
      this.push();
      return { ok: false, message: e instanceof PolicyWriteError ? e.message : 'The stop is on in the running office, but it could not be saved' };
    }
    this.tryWrite('stop', by, { ok: true, reasons: reason ? [reason] : [] });
    this.push();
    return { ok: true, message: 'Emergency stop: no pull request is merged automatically until an admin resumes it' };
  }

  resume(by: string): { ok: boolean; message: string } {
    if (!this.d.policy.stopped) return { ok: true, message: 'It was not stopped' };
    try {
      this.d.policy.resume();
    } catch (e) {
      this.tryWrite('blocked', by, { ok: false, reasons: ['could not resume: the change could not be saved'] });
      return { ok: false, message: e instanceof PolicyWriteError ? e.message : 'It could not be resumed, so it stays stopped' };
    }
    this.write('resume', by, { ok: true });
    this.push();
    return { ok: true, message: 'Resumed' };
  }

  /** Admin only (the caller checks). A yes to this exact commit; the merge then still revalidates everything. */
  async approve(n: number, sha: string, by: string): Promise<{ ok: boolean; message: string }> {
    const on = this.active();
    if (typeof on === 'string') return { ok: false, message: `Not approved: ${on}` };
    const q = this.d.qa.state().prs.find((x) => x.number === n);
    const p = this.d.pulls().find((x) => x.number === n);
    if (!q || !p || !this.mine(p)) return { ok: false, message: `No open pull request #${n} on this floor` };
    if (q.sha !== sha) return { ok: false, message: `PR #${n} changed since you looked (the head is now ${q.sha.slice(0, 7)}): an approval is about one commit` };
    const c = this.classification(p, on.policy);
    if (c.verdict !== 'eligible') return { ok: false, message: `Not eligible for automatic merging: ${c.reasons[0]}. A person merges it` };
    this.store.approvals.set(n, { pr: n, sha, by, at: Date.now() });
    this.store.saveApprovals();
    this.write('approval', by, { pr: n, sha, ok: true });
    this.push();
    // The approval is acted on at once, after the same revalidation as any other attempt.
    const r = await this.attempt(n);
    return { ok: true, message: `${by} approved merging PR #${n} at ${sha.slice(0, 7)}: ${r.merged ? 'everything was checked again and it was merged' : `not merged yet (${r.message})`}` };
  }

  revoke(n: number, by: string): { ok: boolean; message: string } {
    if (!this.store.approvals.delete(n)) return { ok: true, message: 'There was no approval' };
    this.store.saveApprovals();
    this.write('revoked', by, { pr: n, ok: true });
    this.push();
    return { ok: true, message: `Approval of PR #${n} withdrawn` };
  }

  // --- Merging ----------------------------------------------------------------------------------------------------------------------------------

  /** QA has recomputed: merge whatever is ready, eligible and (in approve mode) approved, one at a time. Nothing waits on a timer. */
  onQa(): Promise<void> {
    this.push();
    const on = this.active();
    if (typeof on === 'string') return Promise.resolve();
    this.flagPeople(on.policy);
    const ready = this.d.qa.state().prs.filter((q) => q.state === 'ready');
    for (const q of ready) this.chain = this.chain.then(() => this.attempt(q.number)).catch(() => undefined);
    return this.chain.then(() => undefined);
  }

  /** Once per commit: a pull request that is not the office's to merge (money, the rules themselves, not fully known) is written down and shown to the owner. */
  private flagPeople(policy: RepoMergePolicy) {
    for (const p of this.d.pulls()) {
      if (!this.mine(p) || p.state !== 'OPEN' || p.isDraft || !p.headRefOid || !this.d.extras(p.number)) continue;
      const c = this.classification(p, policy);
      if (c.verdict !== 'human' || (!c.hard && !this.scans.has(p.headRefOid))) continue;
      const key = `${p.number}@${p.headRefOid}`;
      if (this.flagged.has(key)) continue;
      this.flagged.add(key);
      this.record('escalated', p.number, p.headRefOid, c.reasons);
    }
  }

  /** One attempt to merge pull request `n`: decide, then ask everything again, then merge or refuse. Returns what happened. */
  async attempt(n: number): Promise<{ merged: boolean; message: string }> {
    const on = this.active();
    if (typeof on === 'string') return { merged: false, message: on };
    const { policy } = on;
    const q = this.d.qa.state().prs.find((x) => x.number === n);
    const p = this.d.pulls().find((x) => x.number === n);
    if (!q || !p || !this.mine(p)) return { merged: false, message: `No open pull request #${n} of ${this.repo() || 'this floor'}` };
    const sha = q.sha;
    const key = `${n}@${sha}`;
    const refuse = (reasons: string[], kind: AuditKind = 'blocked') => {
      this.said.add(`blocked:${key}`);
      if (this.lastRefusal.get(key) !== reasons.join('|')) {
        this.lastRefusal.set(key, reasons.join('|'));
        this.write(kind, 'office', { pr: n, sha, ok: false, reasons });
      }
      this.push();
      return { merged: false, message: reasons[0] };
    };
    // Before anything is asked: is this one even a candidate?
    if (q.state !== 'ready') {
      this.decide(n, sha, false, [`QA says ${q.state}`]);
      return { merged: false, message: `QA says ${q.state}` };
    }
    const c = this.classification(p, policy);
    if (c.verdict !== 'eligible') {
      this.decide(n, sha, false, c.reasons);
      return { merged: false, message: c.reasons[0] };
    }
    if (policy.mode === 'approve') {
      const a = this.store.approvals.get(n);
      if (!a || a.sha !== sha) {
        this.decide(n, sha, false, ['waiting for a person to approve this commit']);
        return { merged: false, message: 'waiting for a person to approve this commit' };
      }
    }
    // Duplicates: one attempt at a time for a commit, none once it merged, a few at most.
    if (this.store.merged.has(key)) return { merged: false, message: 'duplicate: this commit was already merged' };
    if (this.inFlight.has(key)) return { merged: false, message: 'duplicate: an attempt for this commit is already running' };
    if ((this.store.attempts.get(key) ?? 0) >= MAX_ATTEMPTS) {
      if (!this.flagged.has(`gave-up:${key}`)) {
        this.flagged.add(`gave-up:${key}`);
        this.d.toast(`🧑 PR #${n} needs a person: GitHub refused ${MAX_ATTEMPTS} merge attempts`);
      }
      return refuse([`gave up after GitHub refused ${MAX_ATTEMPTS} merge attempts at this commit: a person looks at it`]);
    }
    this.inFlight.add(key);
    // The policy and the stop as they are when this begins. If either changes before the merge call, even if it changes back (a
    // stop and then a resume), this attempt is void: the world it checked is not the world it would merge in.
    const rev = this.d.policy.revision;
    const approvedAt = this.store.approvals.get(n)?.at;
    const moved = () => this.d.policy.revision !== rev;
    const MOVED = ['the policy or the emergency stop changed during verification: this attempt is void'];
    try {
      this.decide(n, sha, true, [...c.reasons, `policy: ${policy.mode}, ${policy.method}`]);
      if (!this.lastRefusal.has(key)) this.write('attempt', 'office', { pr: n, sha, reasons: ['revalidating before merging'] });

      // 1. Everything again, from GitHub, not from the last sync.
      let fresh;
      try {
        fresh = await this.d.ops.pull(n);
      } catch (e) {
        return refuse([`could not read the pull request from GitHub: ${(e as Error).message.slice(0, 120)}`]);
      }
      if (moved()) return refuse(MOVED);
      if (fresh.repo.toLowerCase() !== this.repo().toLowerCase()) return refuse([`it belongs to ${fresh.repo || 'an unknown repository'}, not ${this.repo()}`]);
      if (fresh.state !== 'OPEN' || fresh.draft) return refuse([fresh.draft ? 'it is a draft' : `it is ${fresh.state.toLowerCase()}`]);
      if (fresh.head !== sha) return refuse([`the head moved to ${fresh.head.slice(0, 7)} during verification; everything about ${sha.slice(0, 7)} is void`]);
      if (fresh.fork) return refuse(['it comes from a fork']);
      if (!policy.bases.includes(fresh.base) || fresh.base !== q.base) return refuse([`it targets ${fresh.base}, which the policy does not cover`]);
      // The change itself, read again from GitHub, pinned to this commit: billing, payments, subscriptions and spending are never merged unattended.
      try {
        await this.read(fresh.base, sha);
      } catch {
        return refuse(['could not read the changes of this commit, so billing and spending could not be ruled out: a person decides']);
      }
      if (moved()) return refuse(MOVED);
      const again1 = this.classification(p, policy);
      if (again1.verdict !== 'eligible') return refuse(again1.reasons);
      const tier = again1.tier;
      let canMerge: boolean;
      try {
        canMerge = await this.d.ops.canMerge();
      } catch {
        return refuse(['could not confirm the office may merge here']);
      }
      if (moved()) return refuse(MOVED);
      if (!canMerge) return refuse(['the GitHub login the office runs as may not merge in this repository']);
      let required: string[] | null;
      try {
        required = await this.d.checks.requiredChecks(fresh.base, true);
      } catch {
        required = null;
      }
      if (moved()) return refuse(MOVED);
      if (required === null || required.length === 0) return refuse([`${fresh.base} has no readable branch protection with required checks, so GitHub would not enforce them: a person merges this`]);
      if (fresh.mergeable !== 'MERGEABLE' || fresh.mergeState !== 'CLEAN') {
        // Behind its base or conflicting is something its author can fix; any other rule is not the office's to get round.
        if (fresh.mergeState === 'BEHIND' || fresh.mergeState === 'DIRTY' || fresh.mergeable === 'CONFLICTING') this.d.qa.requestCorrection(n, sha, [`GitHub says the branch is ${fresh.mergeState.toLowerCase()} (${fresh.mergeable.toLowerCase()}) relative to ${fresh.base}: update or rebase it onto ${fresh.base} and push`]);
        return refuse([`GitHub does not call it mergeable (${fresh.mergeable}, ${fresh.mergeState}): the branch's rules or its state say no, and the office does not get round them`]);
      }
      // 2. QA, worked out again now: the checks of exactly this commit, and an independent review of exactly this commit.
      let again: PrAssessment | undefined;
      try {
        again = await this.d.qa.reassess(n);
      } catch {
        return refuse(['could not confirm the checks and the review of this commit']);
      }
      if (moved()) return refuse(MOVED);
      if (!again || again.sha !== sha) return refuse(['the head moved while the review and checks were confirmed']);
      if (again.state !== 'ready') return refuse([`not ready any more: ${again.state}${again.reasons[0] ? ` (${again.reasons[0]})` : ''}`]);
      const counting = again.evidence.filter((e) => e.status === 'counts' && e.sha === sha);
      if (!counting.length) return refuse(['no independent review of this exact commit']);
      // A sensitive technical change is verified harder: a person's review, or STRICT_REVIEWS different reviewers, each of this exact commit.
      const reviewers = new Set(counting.map((e) => (e.kind === 'human' ? `human:${e.by ?? e.id}` : `worker:${e.reviewerId ?? e.id}`)));
      if (tier === 'strict' && !counting.some((e) => e.kind === 'human') && reviewers.size < STRICT_REVIEWS) return refuse([`a sensitive change needs ${STRICT_REVIEWS} independent reviewers of this exact commit, and it has ${reviewers.size}`]);
      // 3. The last look, with nothing awaited between it and the merge call: stop, gate, policy, approval.
      if (moved()) return refuse(MOVED);
      const last = this.active();
      if (typeof last === 'string') return refuse([`stopped before merging: ${last}`]);
      // The allowlist and the policy as they are NOW, not as they were: same bases and method, and the approval is the one that was there.
      if (!last.policy.bases.includes(fresh.base)) return refuse([`${fresh.base} is no longer one of the branches the policy covers`]);
      if (last.policy.mode === 'approve') {
        const a = this.store.approvals.get(n);
        if (!a || a.sha !== sha) return refuse(['the approval was withdrawn']);
        if (a.at !== approvedAt) return refuse(['the approval changed during verification: this attempt is void']);
      }
      this.write('merging', 'office', { pr: n, sha, reasons: [`asking GitHub to merge (${last.policy.method}, matching head ${sha.slice(0, 7)})`] });
      const done = this.d.ops.merge(n, sha, last.policy.method);
      try {
        await done;
      } catch (e) {
        return refuse([`GitHub refused the merge: ${(e as Error).message.slice(0, 200)}`]);
      }
      // 4. Whatever GitHub says now is the truth.
      let after;
      try {
        after = await this.d.ops.pull(n);
      } catch {
        after = undefined;
      }
      if (after && after.state !== 'MERGED') return refuse(['GitHub did not report it merged']);
      this.write('merged', 'office', { pr: n, sha, ok: true, ...(after?.mergeCommit ? { mergeCommit: after.mergeCommit } : {}), reasons: [`merged by the office (${last.policy.method}), authorized by ${last.policy.authorizedBy}: ${last.policy.authorization}`] });
      this.store.approvals.delete(n);
      this.store.saveApprovals();
      this.lastRefusal.delete(key);
      this.d.toast(`🔀 PR #${n} was merged automatically (${sha.slice(0, 7)})`);
      this.push();
      return { merged: true, message: 'merged' };
    } finally {
      this.inFlight.delete(key);
    }
  }
}
