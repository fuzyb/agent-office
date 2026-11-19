import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/server/github.js';
import { NO_REPO, repoOfUrl, sameRepo, scoped, type GhRunner } from '../src/server/gh-scope.js';
import type { GhPull, GhState, GhIssue } from '../src/shared/protocol.js';

// A fork's floor must show, and act on, the fork's pull requests and nothing else. The case that happened: a floor for
// fuzyb/agent-office, whose checkout also has an `upstream` remote that `gh` had remembered as its default repository, listed
// upstream's pull requests (#409 and the rest) because every gh call left the repository to the checkout.

const FORK = 'fuzyb/agent-office';
const UPSTREAM = 'AgentSystemLabs/agent-office';

const row = (repo: string, n: number, state = 'OPEN') => ({ number: n, title: `PR ${n} in ${repo}`, state, isDraft: false, url: `https://github.com/${repo}/pull/${n}`, author: { login: 'someone' }, labels: [], reviewDecision: '', headRefName: `b${n}`, baseRefName: 'main', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 1, body: '', headRefOid: String(n).padStart(40, 'a'), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', files: [{ path: 'docs/a.md' }], isCrossRepository: false });
const issue = (repo: string, n: number) => ({ number: n, title: `Issue ${n} in ${repo}`, state: 'OPEN', url: `https://github.com/${repo}/issues/${n}`, author: { login: 'someone' }, labels: [], assignees: [], createdAt: '', updatedAt: '', body: '', comments: [] });

/**
 * A gh that behaves like the real one on a fork's checkout: with no repository named it means the UPSTREAM (the remembered
 * default). `leaky` ignores every repository a call names, like a gh or a proxy that does not honour --repo.
 */
function emulator(o: { leaky?: boolean; viewName?: string } = {}) {
  const calls: string[][] = [];
  let defaulted = 0;
  const data: Record<string, { pulls: ReturnType<typeof row>[]; issues: ReturnType<typeof issue>[] }> = {
    [FORK]: { pulls: [1, 2, 3, 4, 5].map((n) => row(FORK, n, 'MERGED')), issues: [issue(FORK, 1)] },
    [UPSTREAM]: { pulls: [409, 407, 406, 405].map((n) => row(UPSTREAM, n)), issues: [issue(UPSTREAM, 300), issue(UPSTREAM, 301)] },
  };
  const run: GhRunner = async (args) => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === 'api' && args[1] === 'user') return 'octocat\n';
    let repo: string | undefined;
    const flag = args.indexOf('--repo');
    if (flag >= 0) repo = args[flag + 1];
    if (cmd === 'repo' && args[2] && !args[2].startsWith('-')) repo = args[2];
    const endpoint = args.find((a) => a.startsWith('repos/'));
    if (endpoint) repo = /^repos\/([^/]+\/[^/]+)/.exec(endpoint)?.[1];
    if (!repo || repo.includes('{') || o.leaky) {
      defaulted++;
      repo = UPSTREAM;
    }
    const d = data[repo] ?? { pulls: [], issues: [] };
    if (cmd === 'repo') return JSON.stringify({ nameWithOwner: o.viewName ?? repo, squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true });
    if (cmd === 'pr' && sub === 'list') {
      const state = args[args.indexOf('--state') + 1];
      return JSON.stringify(d.pulls.filter((p) => (state === 'open' ? p.state === 'OPEN' : state === 'merged' ? p.state === 'MERGED' : p.state === 'CLOSED')));
    }
    if (cmd === 'issue' && sub === 'list') return JSON.stringify(args[args.indexOf('--state') + 1] === 'open' ? d.issues : []);
    if (cmd === 'pr' && sub === 'view') return JSON.stringify(d.pulls.find((p) => String(p.number) === args[3] || String(p.number) === args[2]) ?? {});
    if (cmd === 'pr' && sub === 'merge') return '';
    return '[]';
  };
  return { run, calls, defaulted: () => defaulted };
}

const boards = (repo: string | undefined, run: GhRunner) => {
  let pulls: GhState<GhPull> | undefined;
  let issues: GhState<GhIssue> | undefined;
  const github = new GitHub('/floor', (s) => (issues = s), (s) => (pulls = s), repo, run);
  return { github, pulls: () => pulls, issues: () => issues, refresh: () => github.refresh() };
};

test('the baseline: a gh that is left to choose the repository chooses the upstream of a fork (this is what showed upstream PR #409)', async () => {
  const e = emulator();
  const raw = JSON.parse(await e.run(['pr', 'list', '--state', 'open', '--json', 'number'], '/floor')) as { number: number }[];
  assert.deepEqual(raw.map((p) => p.number), [409, 407, 406, 405]);
  assert.equal(e.defaulted(), 1);
});

test('a fork floor shows its own pull requests and issues only, and not one gh call is left to the checkout', async () => {
  const e = emulator();
  const b = boards(FORK, e.run);
  await b.refresh();
  assert.equal(b.pulls()?.error, undefined);
  assert.deepEqual(b.pulls()?.items.map((p) => p.number).sort(), [1, 2, 3, 4, 5], 'the fork has PRs #1-#5 and no #409');
  assert.ok(b.pulls()?.items.every((p) => repoOfUrl(p.url) === FORK));
  assert.deepEqual(b.issues()?.items.map((i) => i.number), [1], "the fork's issues, not upstream's");
  assert.equal(b.github.extras(409), undefined, 'nothing is kept about an upstream pull request');
  assert.equal(e.defaulted(), 0, 'no call depended on what the checkout or gh remembers');
  // Every call that names a repository names the fork, and the repository-free one is only "who am I".
  for (const args of e.calls) {
    const named = [args[args.indexOf('--repo') + 1], args[2], ...args.filter((a) => a.startsWith('repos/')).map((a) => a.split('/').slice(1, 3).join('/'))].filter((x) => typeof x === 'string' && x.includes('/') && !x.startsWith('-'));
    assert.ok(named.every((r) => sameRepo(r, FORK)) && (named.length > 0 || (args[0] === 'api' && args[1] === 'user')), JSON.stringify(args));
  }
});

test('what GitHub or gh answers is checked too: another repository’s rows are never shown, even if the repository flag is ignored', async () => {
  const e = emulator({ leaky: true });
  const b = boards(FORK, e.run);
  await b.refresh();
  assert.deepEqual(b.pulls()?.items ?? [], [], 'none of upstream’s pull requests reach the board');
  assert.match(b.pulls()?.error ?? '', /GitHub returned pull requests of AgentSystemLabs\/agent-office, not of fuzyb\/agent-office, so none are shown/);
  assert.match(b.issues()?.error ?? '', /issues of AgentSystemLabs\/agent-office, not of fuzyb\/agent-office/);
  // A mixed answer keeps only the repository's own.
  const mixed: GhRunner = async (args) => (args[0] === 'pr' && args[args.indexOf('--state') + 1] === 'open' ? JSON.stringify([row(UPSTREAM, 409), row(FORK, 6)]) : '[]');
  const m = boards(FORK, mixed);
  await m.refresh();
  assert.deepEqual(m.pulls()?.items.map((p) => p.number), [6]);
});

test('a floor with no configured repository runs nothing repository-scoped and guesses nothing from a remote', async () => {
  for (const none of [undefined, '', 'not a repo']) {
    const e = emulator();
    const b = boards(none, e.run);
    await b.refresh();
    assert.deepEqual(b.pulls()?.items ?? [], []);
    assert.equal(b.pulls()?.error, NO_REPO);
    assert.equal(b.issues()?.error, NO_REPO);
    assert.equal(e.calls.length, 0, 'gh was never run');
    assert.match(String(await b.github.merge(7, 'squash', false, false)), /will not guess one/);
    await assert.rejects(b.github.ops.pull(7), /will not guess one/);
    await assert.rejects(b.github.ops.canMerge(), /will not guess one/);
    await assert.rejects(b.github.pullHead(7), /will not guess one/);
    assert.equal(e.calls.length, 0);
  }
});

test('the repository GitHub names has to be the configured one before anything is merged', async () => {
  const e = emulator({ viewName: UPSTREAM });
  const b = boards(FORK, e.run);
  assert.match(String(await b.github.merge(7, 'squash', false, false)), /GitHub says this repository is AgentSystemLabs\/agent-office, not fuzyb\/agent-office/);
  assert.ok(!e.calls.some((a) => a[0] === 'pr' && a[1] === 'merge'), 'no merge was attempted');
});

test('every action the office takes on a floor — merge, read for merging, checks, protection, labels, comments — is pinned to the floor’s repository', async () => {
  const e = emulator();
  const b = boards(FORK, e.run);
  await b.github.ops.pull(1);
  await b.github.ops.canMerge();
  await b.github.ops.merge(1, 'a'.repeat(40), 'squash').catch(() => undefined);
  await b.github.ops.diff('main', 'a'.repeat(40)).catch(() => undefined);
  await b.github.pullHead(1).catch(() => undefined);
  await b.github.requiredChecks('main', true).catch(() => undefined);
  await b.github.shaChecks('a'.repeat(40), true).catch(() => undefined);
  await b.github.merge(1, 'squash', false, false);
  await b.github.setLabels('pull', 1, ['x'], []).catch(() => undefined);
  await b.github.comment('pull', 1, 'text with {owner}/{repo} in it').catch(() => undefined);
  assert.equal(e.defaulted(), 0, `calls: ${e.calls.map((c) => c.slice(0, 4).join(' ')).join(' | ')}`);
  assert.ok(e.calls.some((c) => c[0] === 'pr' && c[1] === 'merge' && c.includes('--repo') && c[c.indexOf('--repo') + 1] === FORK));
  // A message body is data: its text is sent as written, never rewritten.
  const post = e.calls.find((c) => c.includes('--method') && c.some((a) => a.startsWith('body=')));
  assert.ok(post?.includes('body=text with {owner}/{repo} in it'));
});

test('scoping rules: a call that names another repository, or none it can pin, is refused before it runs', () => {
  assert.deepEqual(scoped(['pr', 'list', '--state', 'open', '--json', 'number'], FORK), ['pr', 'list', '--repo', FORK, '--state', 'open', '--json', 'number']);
  assert.deepEqual(scoped(['pr', 'list', '--repo', FORK.toUpperCase(), '--json', 'number'], FORK), ['pr', 'list', '--repo', FORK.toUpperCase(), '--json', 'number'], 'GitHub ignores case');
  assert.throws(() => scoped(['pr', 'merge', '9', '--repo', UPSTREAM], FORK), /names AgentSystemLabs\/agent-office, and this floor is fuzyb\/agent-office/);
  assert.throws(() => scoped(['pr', 'merge', '9', `--repo=${UPSTREAM}`], FORK), /Refused/);
  assert.throws(() => scoped(['pr', 'view', `https://github.com/${UPSTREAM}/pull/409`, '--json', 'state'], FORK), /Refused/);
  assert.throws(() => scoped(['issue', 'list', '-R', UPSTREAM], FORK), /Refused/);
  assert.deepEqual(scoped(['repo', 'view', '--json', 'nameWithOwner'], FORK), ['repo', 'view', FORK, '--json', 'nameWithOwner']);
  assert.throws(() => scoped(['repo', 'view', UPSTREAM], FORK), /Refused/);
  assert.deepEqual(scoped(['api', 'repos/{owner}/{repo}/pulls/3/comments?per_page=100', '--paginate'], FORK), ['api', `repos/${FORK}/pulls/3/comments?per_page=100`, '--paginate']);
  assert.deepEqual(scoped(['api', '-H', 'Accept: application/vnd.github.diff', 'repos/{owner}/{repo}/compare/main...abc'], FORK).at(-1), `repos/${FORK}/compare/main...abc`);
  assert.throws(() => scoped(['api', `repos/${UPSTREAM}/pulls/409`], FORK), /Refused/);
  assert.throws(() => scoped(['api', 'repos/{owner}/{other}/x'], FORK), /placeholder/);
  assert.throws(() => scoped(['api', 'graphql', '-f', 'query=x'], FORK), /not about a repository/);
  assert.deepEqual(scoped(['api', 'user', '--jq', '.login'], FORK), ['api', 'user', '--jq', '.login'], 'who is signed in has no repository');
  assert.deepEqual(scoped(['api', 'user'], undefined), ['api', 'user']);
  for (const cmd of ['run', 'release', 'repo', 'auth', 'workflow', 'secret']) assert.throws(() => scoped([cmd, 'list'], FORK), /Refused/, cmd);
  assert.throws(() => scoped(['pr', 'list'], undefined), /will not guess one/);
  assert.throws(() => scoped(['api', 'repos/{owner}/{repo}/labels'], undefined), /will not guess one/);
  assert.ok(sameRepo('Fuzyb/Agent-Office', FORK) && !sameRepo(UPSTREAM, FORK) && !sameRepo(undefined, FORK) && !sameRepo('', ''));
  assert.deepEqual([repoOfUrl(`https://github.com/${UPSTREAM}/pull/409`), repoOfUrl('https://evil.example/fuzyb/agent-office/pull/1'), repoOfUrl(undefined)], [UPSTREAM, undefined, undefined]);
});
