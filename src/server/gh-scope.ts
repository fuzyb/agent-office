// Pins every `gh` call a floor makes to the floor's own repository, the one it is configured for (its `owner/name`).
//
// Left alone, `gh` decides which repository a command means from the checkout it runs in: its remotes, and a "default" it
// remembers (`gh repo set-default`, which `gh repo fork` and some clones set to the UPSTREAM). On a fork's checkout that is
// often the upstream project, so `gh pr list` showed, and QA, review assignment and merging would have acted on, somebody
// else's pull requests. Nothing the office asks of GitHub for a floor may depend on that: each call names the repository.
//
//  - `gh pr …`, `gh issue …`: `--repo <floor's repo>` is added; a different `--repo` is refused.
//  - `gh repo view`: the floor's repo is named.
//  - `gh api repos/{owner}/{repo}/…`: the placeholders are filled in with the floor's repo, in the endpoint only (never in
//    a message body); an endpoint that names another repository is refused. `gh api user` needs no repository.
//  - anything else is refused: a new kind of call has to be scoped here before it can run.
//  - with no repository configured nothing repository-scoped runs, and nothing is guessed from a remote.
export type GhRunner = (args: string[], cwd: string, timeout?: number, env?: Record<string, string>) => Promise<string>;

const REPO = /^[\w.-]+\/[\w.-]+$/;

export const NO_REPO = 'This floor has no GitHub repository configured, so the office will not guess one from a remote. Push the project to GitHub with an origin remote, then add it again.';

/** GitHub, or gh, answered with rows of another repository. */
export class ForeignRows extends Error {}

/** Whether two `owner/name`s are the same repository (GitHub ignores case). */
export const sameRepo = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The `owner/name` a github.com URL belongs to. */
export const repoOfUrl = (url: unknown): string | undefined => (typeof url === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:[/?#]|$)/i.exec(url)?.[1] : undefined);

/** The arguments of one gh call, pinned to `repo`. Throws for a call that cannot be, so it never runs against another repository. */
export function scoped(args: string[], repo: string | undefined): string[] {
  const [cmd] = args;
  // Who is signed in has no repository.
  if (cmd === 'api' && args[1] === 'user') return args;
  if (!repo || !REPO.test(repo)) throw new Error(NO_REPO);
  const other = (r: string | undefined) => new Error(`Refused: this call names ${r ?? 'another repository'}, and this floor is ${repo}.`);

  if (cmd === 'pr' || cmd === 'issue') {
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--repo' || a === '-R') {
        if (!sameRepo(args[i + 1], repo)) throw other(args[i + 1]);
        return args;
      }
      if (/^(--repo|-R)=/.test(a)) {
        if (!sameRepo(a.slice(a.indexOf('=') + 1), repo)) throw other(a.slice(a.indexOf('=') + 1));
        return args;
      }
      const named = repoOfUrl(a);
      if (named && !sameRepo(named, repo)) throw other(named);
    }
    // Right after the subcommand, so what a caller reads at the end of its arguments (a --json field list, a --jq) is still last.
    return [args[0], args[1], '--repo', repo, ...args.slice(2)];
  }

  if (cmd === 'repo' && args[1] === 'view') {
    const named = args[2] && !args[2].startsWith('-') ? args[2] : undefined;
    if (named) {
      if (!sameRepo(named, repo)) throw other(named);
      return args;
    }
    return [...args.slice(0, 2), repo, ...args.slice(2)];
  }

  if (cmd === 'api') {
    const at = args.findIndex((a, i) => i > 0 && (a.startsWith('repos/') || a.startsWith('/repos/')));
    if (at < 0) throw new Error('Refused: this gh api call is not about a repository the office can scope.');
    const fixed = args[at].replace('{owner}/{repo}', repo);
    if (/[{}]/.test(fixed.split('?')[0])) throw new Error('Refused: this gh api endpoint has a placeholder the office does not fill in.');
    const named = /^\/?repos\/([\w.-]+\/[\w.-]+)(?:\/|$|\?)/.exec(fixed)?.[1];
    if (!sameRepo(named, repo)) throw other(named);
    return args.map((a, i) => (i === at ? fixed : a));
  }

  throw new Error(`Refused: gh ${cmd ?? ''} is not scoped to a repository.`);
}

/** `run`, with every call pinned to `repo`. */
export const scopeGh = (run: GhRunner, repo: string | undefined): GhRunner => (args, cwd, timeout, env) => {
  try {
    return run(scoped(args, repo), cwd, timeout, env);
  } catch (err) {
    return Promise.reject(err);
  }
};
