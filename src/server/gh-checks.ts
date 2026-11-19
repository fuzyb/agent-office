// What GitHub says about checks: one entry of a pull request's rollup, and the read-only questions the QA
// view asks by commit (the checks a commit has, the checks a branch requires). Reads only: nothing here
// starts, reruns or changes a check.
import type { GhCheck } from '../shared/protocol.js';

/** What the QA view needs of an open pull request that the board's card does not carry. Kept in the server, not sent to browsers. */
export interface PullExtra {
  /** The commit the rest is about: the head, as the same answer reported it. */
  sha: string;
  mergeable: string;
  mergeState: string;
  /** Changed paths; undefined when the answer had no file list. */
  files?: string[];
  fork: boolean;
  /** Every check of the head, not only their sum. */
  checks: GhCheck[];
}

/** The checks GitHub reports for one commit asked for by its SHA, and whether every one of them is that commit's own. */
export interface ShaChecks {
  sha: string;
  checks: GhCheck[];
  exact: boolean;
  at: number;
}

export type GhRun = (args: string[], cwd: string) => Promise<string>;

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

/** One entry of statusCheckRollup: a CheckRun (Actions) or a StatusContext (other CI). */
export function checkOf(c: any): GhCheck {
  const concl = String(c.conclusion ?? c.state ?? '').toUpperCase();
  const status = String(c.status ?? '').toUpperCase();
  let state: GhCheck['state'] = 'pass';
  if (FAILED.includes(concl)) state = 'fail';
  else if ((status && status !== 'COMPLETED') || !concl || concl === 'PENDING' || concl === 'EXPECTED') state = 'pending';
  else if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(concl)) state = 'skip';
  const name = String(c.name ?? c.context ?? 'check');
  return { name: c.workflowName ? `${c.workflowName} / ${name}` : name, state, url: c.detailsUrl ?? c.targetUrl ?? undefined };
}

const REQUIRED_TTL_MS = 10 * 60_000;
/** A commit's checks that are all done are kept for good (a commit does not change); others are asked again after this. */
const SHA_RETRY_MS = 60_000;

/** Whether every check of a commit has finished, so its answer will not change by asking again. */
const isFinal = (s: ShaChecks): boolean => s.exact && s.checks.length > 0 && s.checks.every((c) => c.state === 'pass' || c.state === 'skip');

export class CommitChecks {
  private requiredByBase = new Map<string, { at: number; names: string[] | null }>();
  private byRef = new Map<string, ShaChecks>();
  private asking = new Map<string, Promise<ShaChecks>>();

  constructor(
    private run: GhRun,
    private dir: string,
  ) {}

  /** The checks the repository requires of a branch, when it says (null when it does not, or this login may not ask). Kept for ten minutes. */
  async requiredChecks(base: string): Promise<string[] | null> {
    const hit = this.requiredByBase.get(base);
    if (hit && Date.now() - hit.at < REQUIRED_TTL_MS) return hit.names;
    let names: string[] | null = null;
    try {
      const out = await this.run(['api', `repos/{owner}/{repo}/branches/${encodeURIComponent(base)}/protection/required_status_checks`, '--jq', '[(.contexts // [])[], ((.checks // [])[] | .context)] | unique | .[]'], this.dir);
      names = out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
      names = null;
    }
    this.requiredByBase.set(base, { at: Date.now(), names });
    return names;
  }

  /**
   * The checks of exactly commit `sha`, from GitHub's check runs and statuses for that commit, not from the
   * pull request's card. Read-only. A commit whose checks are all done is remembered for good; one still
   * running, or with a failure, is asked again after a minute at the soonest.
   */
  shaChecks(sha: string): Promise<ShaChecks> {
    const kept = this.byRef.get(sha);
    if (kept && (isFinal(kept) || Date.now() - kept.at < SHA_RETRY_MS)) return Promise.resolve(kept);
    let pending = this.asking.get(sha);
    if (!pending) {
      pending = this.ask(sha).finally(() => this.asking.delete(sha));
      this.asking.set(sha, pending);
    }
    return pending;
  }

  private async ask(sha: string): Promise<ShaChecks> {
    const lines = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    const [runs, statuses] = await Promise.all([
      this.run(['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--jq', '.check_runs[] | {name, status, conclusion, detailsUrl: .details_url, sha: .head_sha}'], this.dir),
      this.run(['api', `repos/{owner}/{repo}/commits/${sha}/status`, '--jq', '.statuses[] | {context, state, targetUrl: .target_url}'], this.dir),
    ]);
    const runList = lines(runs);
    const checks = [...runList.map((r: any) => checkOf({ ...r, status: String(r.status ?? '').toUpperCase(), conclusion: String(r.conclusion ?? '').toUpperCase() })), ...lines(statuses).map((s: any) => checkOf({ ...s, state: String(s.state ?? '').toUpperCase() }))];
    const result: ShaChecks = { sha, checks, exact: runList.every((r: any) => r.sha === sha), at: Date.now() };
    this.byRef.set(sha, result);
    return result;
  }
}
