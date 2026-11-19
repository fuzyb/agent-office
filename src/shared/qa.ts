// Where a pull request stands, decided by plain code on plain data: its checks, what it touches, whether
// it merges cleanly, and which reviews of this exact commit the office holds. No model, no network.
//
// What counts as proof, and what does not:
//  - A green build is not a review. Checks say the code builds and passes its tests, nothing more.
//  - Every agent here shares one GitHub account, so a comment, an approval or an author name on GitHub says
//    nothing about who wrote or reviewed the code. `reviewDecision`, labels and comment text are never read.
//  - A worker's role label is not evidence either. A review counts only when the office itself recorded it:
//    a worker it gave the review to, speaking through its own authenticated tool call, or a person recording
//    their own (or the QA Director's) verdict. Either is bound to one commit and stops counting when the head moves.
//  - Whether a worker may review a pull request depends on who did the work, which the office knows from its
//    own records of workers, branches and queue tasks. Where that is not known, only a person's word is enough.
//
// Browser-safe: no node imports.
import type { GhCheck } from './protocol/github.js';
import type { CheckSummary, EvidenceView, PrAssessment, QaEvidence, QaState, RiskCategory } from './protocol/qa.js';

// --- What a change touches -----------------------------------------------------------------------------------------------

/** Most files `gh pr list` returns for one pull request: at that many, the rest are unseen. */
export const FILES_SEEN_MAX = 100;

const RULES: [RiskCategory, RegExp][] = [
  ['ci-workflow', /^\.github\/(workflows|actions)\/|^\.github\/(dependabot|CODEOWNERS)/i],
  ['install', /^(install\.(sh|ps1)|bin\/|deploy\/|Dockerfile|docker-compose)/i],
  ['dependencies', /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum))$/i],
  ['security', /(^|\/)(auth|accounts|signins|secrets?|credentials?|tunnel|crypto|permissions?|policy)[^/]*\.(ts|js|mjs|cjs|py|go|rs)$|(^|\/)(\.env|.*\.pem|.*\.key)/i],
  ['tests', /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[tj]sx?$/i],
  ['docs', /(^|\/)docs\/|\.mdx?$|^LICENSE/i],
  ['source', /^(src|lib|app|server|client)\//i],
];

/** Independent reviews of the exact commit, by different reviewers, that a sensitive technical change needs while automatic merging is on, instead of a person's review. */
export const STRICT_REVIEWS = 2;

/** Categories that need a person's own review before a pull request can be ready (or, while automatic merging is on, the strict tier: see STRICT_REVIEWS). 'unknown' always needs a person. */
export const NEEDS_HUMAN: ReadonlySet<RiskCategory> = new Set(['ci-workflow', 'install', 'dependencies', 'security', 'unknown']);

const WHY_HUMAN: Record<string, string> = {
  'ci-workflow': 'it changes CI workflows (what runs with the repository’s credentials)',
  install: 'it changes how the app is installed or deployed',
  dependencies: 'it changes dependencies',
  security: 'it touches authentication, accounts, secrets or permissions',
  unknown: 'its file list is incomplete or unknown',
};

/** Technical areas that are verified harder (the strict tier): CI, installs, infrastructure, dependencies, configuration, keys and secrets. */
const SENSITIVE: RegExp[] = [
  /^\.github\//i,
  /^(install\.(sh|ps1)|Dockerfile[^/]*|docker-compose[^/]*)$/i,
  /^(bin|deploy|infra|infrastructure|terraform|k8s|helm|scripts)\//i,
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc[^/]*)$/i,
  /(^|\/)(tsconfig[^/]*\.json|vite\.config\.[a-z]+|eslint[^/]*|\.eslintrc[^/]*|\.prettierrc[^/]*|\.gitignore|\.gitattributes|\.editorconfig)$/i,
  /(^|\/)\.env/i,
  /(^|\/)[^/]*\.(pem|key|crt|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)[^/]*$/i,
  /^[^/]+\.(ya?ml|toml|ini|cfg)$/i, // configuration files at the root
];


/** Whether `path` is a sensitive technical area (CI, installs, infrastructure, dependencies, security, configuration, keys): verified harder, never just waved through. */
export const isSensitive = (path: string): boolean => SENSITIVE.some((re) => re.test(path)) || riskOf([path]).some((r) => NEEDS_HUMAN.has(r) && r !== 'unknown');

/** The categories of the files a pull request changes: every one that applies. Unknown when the list is missing or cut off. */
export function riskOf(files: readonly string[] | undefined): RiskCategory[] {
  if (!files || files.length === 0) return ['unknown'];
  const found = new Set<RiskCategory>();
  for (const f of files) found.add(RULES.find(([, re]) => re.test(f))?.[0] ?? 'other');
  if (files.length >= FILES_SEEN_MAX) found.add('unknown');
  return [...found];
}

// --- Checks ---------------------------------------------------------------------------------------------------------------------

/** A check named like a required context: the name itself, or the job inside "workflow / job". */
const matches = (name: string, context: string) => name === context || name.endsWith(` / ${context}`);

/** The checks counted, with which required ones have not reported. With none required, having none at all is what is missing. */
export function summarizeChecks(items: readonly GhCheck[], required: readonly string[], source: CheckSummary['source']): CheckSummary {
  const count = (s: GhCheck['state']) => items.filter((c) => c.state === s).length;
  const missing = required.filter((r) => !items.some((c) => matches(c.name, r)));
  if (!items.length && !required.length) missing.push('any check at all');
  return { passed: count('pass'), failed: count('fail'), pending: count('pending'), skipped: count('skip'), missing, items: [...items], source };
}

// --- Reviews --------------------------------------------------------------------------------------------------------------------

/** Who did the work, as the office's own records say: worker ids (kept after a worker goes home) and whether any is known. */
export interface Authors {
  known: boolean;
  ids: readonly string[];
  names: readonly string[];
  providers: readonly (string | undefined)[];
}

/** One review of the current head, judged. Worker evidence counts only when the reviewer is known not to be an author. */
export function judge(e: QaEvidence, head: string, authors: Authors): EvidenceView {
  const view = (status: EvidenceView['status'], why?: string): EvidenceView => ({
    ...e,
    status,
    ...(why ? { why } : {}),
    ...(e.kind === 'worker' && e.reviewerProvider && authors.known ? { crossProvider: !authors.providers.includes(e.reviewerProvider) } : {}),
  });
  if (e.sha !== head) return view('stale', `it was about ${e.sha.slice(0, 7)}, and the head is now ${head.slice(0, 7)}`);
  if (e.verdict !== 'approve') return view('not-approval', e.verdict === 'changes' ? 'the review asked for changes' : 'it is a comment, not an approval');
  if (e.kind === 'human') return view('counts');
  if (e.reviewerId && authors.ids.includes(e.reviewerId)) return view('not-independent', 'the reviewer is a worker that did this work');
  if (!authors.known) return view('unverifiable', 'the office does not know who wrote this, so a worker review cannot be shown independent: a person has to record it');
  return view('counts');
}

// --- Where it stands -----------------------------------------------------------------------------------------------------------------

/** Everything about a pull request that is not a review. */
export interface PrFacts {
  number: number;
  title: string;
  url: string;
  author: string;
  /** The head commit. Everything is about this one. */
  sha: string;
  base: string;
  draft: boolean;
  /** GitHub's word: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable?: string;
  fork: boolean;
  /** Changed paths, when the list says. */
  files?: string[];
  /** The board's look at its checks. */
  checks: GhCheck[];
  updatedAt: string;
}

export interface Inputs {
  /** Check names the repository requires, when it says. */
  required: readonly string[];
  requiredKnown: boolean;
  /** The checks of exactly `sha`, asked for by that commit; none yet when it has not been asked. */
  confirmed?: { sha: string; checks: GhCheck[] };
  evidence: readonly QaEvidence[];
  authors: Authors;
  /** A review given to a worker for this commit, still unanswered. */
  assigned?: { workerName: string; at: number };
  /** Automatic merging is on for this repository: a sensitive technical change then needs STRICT_REVIEWS independent reviews instead of a person's. Billing and spending are decided elsewhere (shared/financial.ts). */
  autonomy?: boolean;
}

/**
 * Where `pr` stands. In order: a failed check or a conflict; a security or policy rule that needs a person; a
 * review that asked for changes; a draft, or checks still running or missing; no independent review of this
 * commit; checks of this exact commit not confirmed yet; ready. Only the last is ready, and ready is for a
 * person to merge.
 */
export function assess(pr: PrFacts, input: Inputs): PrAssessment {
  const exact = input.confirmed && input.confirmed.sha === pr.sha ? input.confirmed : undefined;
  const checks = summarizeChecks(exact ? exact.checks : pr.checks, input.required, exact ? 'commit' : 'list');
  const risk = riskOf(pr.files);
  const evidence = input.evidence.filter((e) => e.pr === pr.number).map((e) => judge(e, pr.sha, input.authors)).sort((a, b) => b.at - a.at);
  const counting = evidence.filter((e) => e.status === 'counts');
  const humanCounts = counting.some((e) => e.kind === 'human');
  const conflicts = pr.mergeable === 'CONFLICTING';
  const needsHuman = [...new Set(risk.filter((r) => NEEDS_HUMAN.has(r)))];
  // With automatic merging on, a sensitive technical area is verified harder rather than handed to a person; an unknown change, or a fork, still is.
  const personFor = input.autonomy ? needsHuman.filter((r) => r === 'unknown') : needsHuman;
  const mustHuman = personFor.length > 0 || pr.fork;
  const need = input.autonomy && (pr.files ?? []).some(isSensitive) ? STRICT_REVIEWS : 1;
  const reviewers = new Set(counting.map((e) => (e.kind === 'human' ? `human:${e.by ?? e.id}` : `worker:${e.reviewerId ?? e.id}`)));
  const enough = humanCounts || reviewers.size >= need;
  const reasons: string[] = [];
  let state: QaState;

  if (checks.failed || conflicts) {
    state = 'failed';
    if (checks.failed) reasons.push(`${checks.failed} check${checks.failed === 1 ? '' : 's'} failed: ${checks.items.filter((c) => c.state === 'fail').map((c) => c.name).join(', ')}`);
    if (conflicts) reasons.push('it has merge conflicts: it needs a rebase');
  } else if (mustHuman && !humanCounts) {
    state = 'blocked';
    for (const r of personFor) reasons.push(`${WHY_HUMAN[r]}: a person has to review it`);
    if (pr.fork) reasons.push('it comes from a fork: a person has to review it');
  } else if (evidence.some((e) => e.status === 'not-approval' && e.verdict === 'changes')) {
    state = 'blocked';
    reasons.push('a review of this commit asked for changes');
  } else if (pr.draft || checks.pending || checks.missing.length) {
    state = 'awaiting';
    if (pr.draft) reasons.push('it is still a draft');
    if (checks.pending) reasons.push(`${checks.pending} check${checks.pending === 1 ? '' : 's'} still running`);
    if (checks.missing.length) reasons.push(`not reported: ${checks.missing.join(', ')}`);
  } else if (!enough) {
    state = 'needs-review';
    const have = reviewers.size ? ` (${reviewers.size} of ${need} so far)` : '';
    reasons.push(input.assigned ? `${input.assigned.workerName} has the review and has not answered` : need > 1 ? `checks pass; it changes a sensitive area, so it needs ${need} independent reviewers of this commit${have}` : 'checks pass; no independent review of this commit yet');
    const odd = evidence.find((e) => e.status === 'unverifiable' || e.status === 'not-independent');
    if (odd?.why) reasons.push(`a review exists but does not count: ${odd.why}`);
  } else if (!exact) {
    // A review stands and the board's checks pass; whether those checks are this commit's own is asked of GitHub by its SHA.
    state = 'awaiting';
    reasons.push(`confirming the checks of exactly ${pr.sha.slice(0, 7)}`);
  } else {
    state = 'ready';
    reasons.push(input.autonomy ? `checks of ${pr.sha.slice(0, 7)} pass and ${reviewers.size} independent review${reviewers.size === 1 ? '' : 's'} of it ${reviewers.size === 1 ? 'stands' : 'stand'}: ready to merge` : `checks of ${pr.sha.slice(0, 7)} pass and an independent review of it stands: ready for a person to merge`);
  }

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    sha: pr.sha,
    base: pr.base,
    state,
    reasons,
    checks,
    draft: pr.draft,
    conflicts,
    fork: pr.fork,
    risk,
    authors: [...input.authors.names],
    authorsKnown: input.authors.known,
    evidence,
    ...(input.assigned ? { assigned: input.assigned } : {}),
    needsHuman: mustHuman,
    reviewsNeeded: need,
    updatedAt: pr.updatedAt,
  };
}

/** Whether a confirmation of the checks of this exact commit is worth asking GitHub for: only once everything else is in place. */
export function wantsConfirmation(a: PrAssessment): boolean {
  return a.state === 'awaiting' && a.checks.source === 'list' && a.reasons.some((r) => r.startsWith('confirming the checks'));
}
