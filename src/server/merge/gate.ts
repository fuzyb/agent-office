// The feature gate. Automatic merging does not exist in an installation until whoever starts the office sets this
// in its environment: outside the browser, so no page and no admin can open it. Without it
// every part of the feature is inert: the policy cannot be turned on and the merge code refuses. Setting it is the
// owner's act, and it is meant to follow the governance change in docs/auto-merge.md, not to precede it. (No worker
// route or tool exists for any of this, so a worker's environment does not matter.)
export const GATE_ENV = 'AGENT_OFFICE_AUTOMERGE';

export const gateOpen = (env: Record<string, string | undefined> = process.env): boolean => env[GATE_ENV] === 'enabled';
