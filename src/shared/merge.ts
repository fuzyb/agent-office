// Which pull requests may be merged without a person, decided from the change by plain code. The owner's policy is
// broad: application code, infrastructure, security, dependencies and CI are all eligible, because they are verified
// harder, not because they are trusted. A change is NOT eligible, and a person merges it, only when:
//   - it touches billing, payments, subscriptions, spending or any financial commitment (shared/financial.ts); this
//     can never be switched off by any policy, approval or review;
//   - it touches governance or the safeguards themselves (see GOVERNANCE): the office never merges unattended a change to
//     the rules it is merged under, to the code that decides what merges, or to how reviews are judged;
//   - the whole change is not known (a file list that is missing or cut off), or it is from a fork, or aimed at a
//     branch the policy does not name, or larger than the policy's limits, or touches a path the owner listed.
// A change that touches a sensitive technical area (CI, installs, dependencies, security, infrastructure,
// configuration, keys) is eligible at the STRICT tier: it needs more independent review (see STRICT_REVIEWS), not a person.
//
// Whether an eligible change IS merged is another matter (server/merge/): the policy, the gate, the checks, the
// independent review(s) of the exact commit, and everything asked of GitHub again immediately before.
//
// Browser-safe: no node imports.
import { financialReasons } from './financial.js';
import { FILES_SEEN_MAX, STRICT_REVIEWS, isSensitive } from './qa.js';
import type { MergeClassification, MergeMethod, RepoMergePolicy } from './protocol/merge.js';

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_FILES = 60;
export const MAX_LINES = 5000;
export const MAX_FILES = FILES_SEEN_MAX - 1;
export const METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

export { STRICT_REVIEWS, isSensitive };

/**
 * Where a change is a person's, whatever the owner's policy says: the rules the office works under (HQ governance and
 * the agent configuration), and the code that decides what merges and who reviewed it, so that the safeguards cannot be
 * edited by the thing they safeguard. Changing them is a deliberate, human act.
 */
const GOVERNANCE: RegExp[] = [
  /^\.claude\//i,
  /^(AGENTS|CLAUDE|SECURITY|GOVERNANCE)(\.md)?$/i,
  /(^|\/)CODEOWNERS$/i,
  /^(roles|playbooks|templates|projects|private)\//i,
  // the merge machinery, its financial classifier and gate, the QA code that judges reviews, and their tests and docs
  /^src\/(shared|server|client)\/(ui\/)?(protocol\/)?(merge|financial)(\/|\.ts$)/i,
  // the GitHub integration (what is merged, what counts as passing), the floor that wires QA, merging and the policy together, who may do what
  // over the socket (QA and merge messages, the registry of handlers) and over the worker route (a reviewer's verdict), and dispatch (who may take a review)
  /^src\/server\/(github|gh-merge|gh-checks|floor)\.ts$/i,
  /^src\/server\/office\/floors\.ts$/i,
  /^src\/server\/ws\/handlers\/(merge|qa|index|common)\.ts$/i,
  /^src\/server\/hooks\/office-workers\.ts$/i,
  /^src\/server\/dispatch\//i,
  /^src\/shared\/(dispatch|protocol\/dispatch)\.ts$/i,
  /^src\/server\/(qa|merge)\//i,
  /^src\/shared\/(qa|protocol\/qa)\.ts$/i,
  /^tests\/(auto-merge|qa-verification)[^/]*$/i,
  /^docs\/(auto-merge|qa-verification)\.md$/i,
];

/** A glob as a regular expression: `**` any path, `*` anything within a folder, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Whether `path` is the rules or the safeguards: always a person's. */
export const isGovernance = (path: string): boolean => GOVERNANCE.some((re) => re.test(path));

/** A path pattern the owner may add: a real pattern, not just "everything". */
export function validExtraGlob(glob: string): boolean {
  return /^[A-Za-z0-9_.\-*?/]{1,120}$/.test(glob) && !glob.startsWith('/') && !glob.includes('..') && !/^(\*\*?\/?)+$/.test(glob);
}

export interface ChangeFacts {
  /** Changed paths, when known; undefined when the list is missing. */
  files?: readonly string[];
  /** Lines added plus removed. */
  lines: number;
  base: string;
  fork: boolean;
  title?: string;
  /** What the changed lines of the diff say about billing, payments and spending (financialReasons of the diff), when the diff has been read. */
  diffMoney?: string[];
}

/** The paths a unified diff names, old and new (so a rename out of a protected path is seen too). */
export function filesOfDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = line.startsWith('diff --git ') ? /^diff --git a\/(.+?) b\/(.+)$/.exec(line) : null;
    if (m) {
      out.add(m[1]);
      out.add(m[2]);
    }
  }
  return [...out];
}

const some = (list: readonly string[], n = 5) => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

/**
 * Whether the change may be merged without a person, under `policy`, and how hard it must be verified. Every reason it is not is
 * listed. `hard` marks the reasons nothing can lift (financial, governance): the office will not even ask for a review of those.
 */
export function classify(change: ChangeFacts, policy: Pick<RepoMergePolicy, 'bases' | 'maxChangedLines' | 'maxFiles' | 'humanPaths'>): MergeClassification {
  const why: string[] = [];
  let hard = false;
  const files = change.files;
  if (!files || files.length === 0) why.push('its file list is not known');
  else if (files.length >= FILES_SEEN_MAX) why.push('its file list is cut off, so some changes are unseen');
  if (change.fork) why.push('it comes from a fork');
  if (!policy.bases.includes(change.base)) why.push(`it targets ${change.base}, which is not one of the branches automatic merging covers`);
  if (change.lines > policy.maxChangedLines) why.push(`it changes ${change.lines} lines (the limit is ${policy.maxChangedLines})`);
  if (files && files.length > policy.maxFiles) why.push(`it changes ${files.length} files (the limit is ${policy.maxFiles})`);
  const money = [...financialReasons({ files, title: change.title }), ...(change.diffMoney ?? [])];
  if (money.length) {
    hard = true;
    why.push(`billing, payments, subscriptions or spending is always a person's decision: ${money[0]}`, ...money.slice(1));
  }
  let strict = false;
  if (files?.length) {
    const rules = files.filter(isGovernance);
    if (rules.length) {
      hard = true;
      why.push(`it changes the rules or the safeguards that automatic merging runs under (${some(rules)}): a person decides`);
    }
    const owner = policy.humanPaths.filter(validExtraGlob).map(globToRegExp);
    const listed = files.filter((f) => owner.some((re) => re.test(f)));
    if (listed.length) why.push(`it touches paths the owner keeps for a person: ${some(listed)}`);
    strict = files.some(isSensitive);
  }
  if (why.length) return { verdict: 'human', tier: strict ? 'strict' : 'standard', hard, reasons: why };
  return strict
    ? { verdict: 'eligible', tier: 'strict', hard: false, reasons: [`it touches a sensitive technical area (${some(files!.filter(isSensitive), 3)}): stronger QA, ${STRICT_REVIEWS} independent reviews of the exact commit`] }
    : { verdict: 'eligible', tier: 'standard', hard: false, reasons: ['not billing, payments or spending, not governance, within the size limits'] };
}
