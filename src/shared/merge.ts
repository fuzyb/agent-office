// Which pull requests may be merged without a person reading them, decided from the changed files alone by
// plain code. The rule is an allowlist: a change qualifies only if EVERY file is low-risk (documentation, tests,
// or a path the owner added for that repository) and NONE is sensitive. Sensitive wins over everything: the
// owner's extra paths can never include one. A change qualifies only when its whole file list is known.
//
// Whether a qualifying change IS merged is another matter (server/merge/): the policy, the gate, the checks and
// the independent review of the exact commit, all asked again immediately before.
//
// Browser-safe: no node imports.
import { FILES_SEEN_MAX, NEEDS_HUMAN, riskOf } from './qa.js';
import type { MergeClassification, MergeMethod, RepoMergePolicy } from './protocol/merge.js';

export const DEFAULT_MAX_LINES = 300;
export const DEFAULT_MAX_FILES = 20;
export const METHODS: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];

/** Paths that are never low-risk, whatever the owner adds: configuration, CI, installs, dependencies, secrets, governance, build and test infrastructure. */
const PROTECTED: RegExp[] = [
  /^\.github\//i,
  /^\.claude\//i,
  /^(AGENTS|CLAUDE|CODEOWNERS|SECURITY|GOVERNANCE)(\.md)?$/i,
  /^(roles|playbooks|templates|projects|private)\//i,
  /^(install\.(sh|ps1)|Dockerfile[^/]*|docker-compose[^/]*)$/i,
  /^(bin|deploy|infra|infrastructure|terraform|k8s|helm|scripts)\//i,
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc[^/]*)$/i,
  /(^|\/)(tsconfig[^/]*\.json|vite\.config\.[a-z]+|eslint[^/]*|\.eslintrc[^/]*|\.prettierrc[^/]*|\.gitignore|\.gitattributes|\.editorconfig)$/i,
  /(^|\/)\.env/i,
  /(^|\/)[^/]*\.(pem|key|crt|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)[^/]*$/i,
  /^[^/]+\.(ya?ml|toml|ini|cfg)$/i, // configuration files at the root
];

/** Low-risk without the owner saying so: documentation and tests. */
const LOW_RISK: RegExp[] = [/^docs\/[^]*\.(md|mdx|txt|png|svg|jpg)$/i, /^[^/]+\.(md|mdx)$/i, /(^|\/)tests?\//i, /\.(test|spec)\.[tj]sx?$/i];

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

/** Whether `path` is somewhere a person must always look, whatever any policy says. */
export const isSensitive = (path: string): boolean => PROTECTED.some((re) => re.test(path)) || riskOf([path]).some((r) => NEEDS_HUMAN.has(r));

/** A path the owner may count as low-risk: not a sensitive one, and a glob that is not just "everything". */
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
}

/** Whether the change is the kind that may be merged without a person, under `policy`. Every reason it is not is listed. */
export function classify(change: ChangeFacts, policy: Pick<RepoMergePolicy, 'bases' | 'maxChangedLines' | 'maxFiles' | 'extraLowRisk'>): MergeClassification {
  const why: string[] = [];
  const files = change.files;
  if (!files || files.length === 0) why.push('its file list is not known');
  else if (files.length >= FILES_SEEN_MAX) why.push('its file list is cut off, so some changes are unseen');
  if (change.fork) why.push('it comes from a fork');
  if (!policy.bases.includes(change.base)) why.push(`it targets ${change.base}, which is not one of the branches automatic merging covers`);
  if (change.lines > policy.maxChangedLines) why.push(`it changes ${change.lines} lines (the limit is ${policy.maxChangedLines})`);
  if (files && files.length > policy.maxFiles) why.push(`it changes ${files.length} files (the limit is ${policy.maxFiles})`);
  if (files?.length) {
    const extra = policy.extraLowRisk.filter(validExtraGlob).map(globToRegExp);
    const sensitive = files.filter(isSensitive);
    if (sensitive.length) why.push(`it touches sensitive or protected files: ${sensitive.slice(0, 5).join(', ')}${sensitive.length > 5 ? ` and ${sensitive.length - 5} more` : ''}`);
    const unknown = files.filter((f) => !isSensitive(f) && !LOW_RISK.some((re) => re.test(f)) && !extra.some((re) => re.test(f)));
    if (unknown.length) why.push(`it touches files that are not documentation, tests or a path the owner marked low-risk: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}`);
  }
  return why.length ? { verdict: 'human', reasons: why } : { verdict: 'eligible', reasons: ['only documentation, tests and paths the owner marked low-risk, within the size limits'] };
}
