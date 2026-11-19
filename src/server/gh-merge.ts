// The only place the office asks GitHub to merge a pull request, and what it reads just before. The merge is
// `gh pr merge <n> --squash|--merge|--rebase --match-head-commit <sha>`: GitHub itself refuses it if the head is
// no longer that commit, and it honours the branch's protection and required checks. Never `--admin` (which
// bypasses protection), never `--auto`, never `--delete-branch`, never a force-push, and no setting is changed.
import type { MergeMethod } from '../shared/protocol/merge.js';
import type { GhRun } from './gh-checks.js';

/** A pull request as GitHub says it is right now. */
export interface FreshPull {
  state: string;
  draft: boolean;
  head: string;
  base: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable: string;
  /** CLEAN means GitHub would merge it with every branch rule met; anything else is a rule or a state that says no. */
  mergeState: string;
  fork: boolean;
  /** owner/name, from its URL. */
  repo: string;
  mergeCommit?: string;
}

const FLAG: Record<MergeMethod, string> = { squash: '--squash', merge: '--merge', rebase: '--rebase' };

export class MergeOps {
  constructor(
    private run: GhRun,
    private dir: string,
  ) {}

  async pull(n: number): Promise<FreshPull> {
    const out = await this.run(['pr', 'view', String(n), '--json', 'state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,isCrossRepository,url,mergeCommit'], this.dir);
    const p = JSON.parse(out);
    return {
      state: String(p.state ?? ''),
      draft: !!p.isDraft,
      head: String(p.headRefOid ?? ''),
      base: String(p.baseRefName ?? ''),
      mergeable: String(p.mergeable ?? 'UNKNOWN'),
      mergeState: String(p.mergeStateStatus ?? 'UNKNOWN'),
      fork: p.isCrossRepository === true,
      repo: /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(String(p.url ?? ''))?.[1] ?? '',
      ...(p.mergeCommit?.oid ? { mergeCommit: String(p.mergeCommit.oid) } : {}),
    };
  }

  /** Whether the login the office's `gh` runs as may push to the repository (so GitHub would let it merge). Read-only. */
  async canMerge(): Promise<boolean> {
    const out = await this.run(['api', 'repos/{owner}/{repo}', '--jq', '.permissions'], this.dir);
    const p = JSON.parse(out || '{}');
    return p.push === true || p.maintain === true || p.admin === true;
  }

  /** The change `sha` makes on `base`, as GitHub's unified diff, pinned to that commit (not a diff that moves with the pull request). Read-only. */
  async diff(base: string, sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/.test(sha) || !/^[w./-]{1,100}$/.test(base)) throw new Error('not a commit and a branch');
    return this.run(['api', '-H', 'Accept: application/vnd.github.diff', `repos/{owner}/{repo}/compare/${base}...${sha}`], this.dir);
  }

  /** Merges, or throws with GitHub's reason (head moved, branch rule not met, not mergeable...). */
  async merge(n: number, sha: string, method: MergeMethod): Promise<void> {
    await this.run(['pr', 'merge', String(n), FLAG[method], '--match-head-commit', sha], this.dir);
  }
}
