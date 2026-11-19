// Controlled automatic merging (see shared/merge.ts and docs/auto-merge.md). Off by default, behind a gate
// only whoever starts the office can open, and then per repository, by an admin, with a written authorization.
// Nothing here is available to an agent: no worker route, no MCP tool, no message a worker can send.

import type { PrAssessment, QaState } from './qa.js';

/** Per repository: off, merge only what a person approved for this exact commit, or merge what passes every check by itself. */
export type MergeMode = 'off' | 'approve' | 'auto';

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export interface RepoMergePolicy {
  mode: MergeMode;
  method: MergeMethod;
  /** Branches pull requests may be merged into. */
  bases: string[];
  /** Most changed lines (added plus removed) and files a pull request may have. */
  maxChangedLines: number;
  maxFiles: number;
  /** Paths (globs) the owner counts as low-risk besides docs and tests. They can never include a protected or sensitive path. */
  extraLowRisk: string[];
  /** What authorizes it: a link or reference to the owner's governance record. Required to turn it on. */
  authorization: string;
  authorizedBy: string;
  authorizedAt: number;
}

export type MergeVerdict = 'eligible' | 'human';

/** Whether a change is the kind that may be merged without a person reading it. Decided from the files alone. */
export interface MergeClassification {
  verdict: MergeVerdict;
  /** Why a person is needed, or why it qualifies. */
  reasons: string[];
}

/** A person's yes to merging this pull request at this exact commit (only in 'approve' mode). */
export interface MergeApproval {
  pr: number;
  sha: string;
  by: string;
  at: number;
}

export type MergeStatus =
  | 'not-ready' // checks or reviews are not there yet (see its QA state)
  | 'human' // not the kind of change that may be merged automatically: a person merges it
  | 'awaiting-approval' // eligible, and 'approve' mode is waiting for a person's yes to this commit
  | 'queued' // eligible and approved (or 'auto'), about to be revalidated and merged
  | 'merged'
  | 'blocked'; // revalidation refused it

export interface MergePr {
  number: number;
  title: string;
  url: string;
  sha: string;
  qa: QaState;
  classification: MergeClassification;
  approval?: MergeApproval;
  status: MergeStatus;
  /** Why it is not merging (or that it merged). */
  reasons: string[];
}

export type AuditKind = 'decision' | 'approval' | 'revoked' | 'attempt' | 'merging' | 'merged' | 'blocked' | 'policy' | 'stop' | 'resume';

/** One line of the permanent record. Nothing in it is a credential. */
export interface AuditEntry {
  at: number;
  repo: string;
  kind: AuditKind;
  /** A person's name, or 'office' for what the office decided by itself. */
  by: string;
  pr?: number;
  sha?: string;
  ok?: boolean;
  reasons?: string[];
  mergeCommit?: string;
}

export interface MergeViewState {
  floorId: string;
  /** Whether this installation allows automatic merging at all. False unless the operator turned the gate on when starting the office. */
  gate: boolean;
  /** Set while the emergency stop is on, office-wide. */
  stopped?: { by: string; at: number; reason?: string };
  /** This floor's repository, when it has one. */
  repo?: string;
  policy?: RepoMergePolicy;
  /** The repositories with automatic merging on, anywhere in the office (admins only; others see their own). */
  allowlist: { repo: string; mode: MergeMode }[];
  prs: MergePr[];
  audit: AuditEntry[];
  at: number;
}

export type MergeClientMsg =
  | { t: 'merge.state' }
  /** Admin only, and only with the gate open. Sets this floor's repository policy; `mode: 'off'` turns it off. */
  | { t: 'merge.policy'; mode: MergeMode; authorization?: string; method?: MergeMethod; bases?: string[]; maxChangedLines?: number; maxFiles?: number; extraLowRisk?: string[] }
  /** Admin only. A yes to merging this pull request at this exact commit. */
  | { t: 'merge.approve'; pr: number; sha: string }
  | { t: 'merge.revoke'; pr: number }
  /** Anyone: stops every automatic merge in the office at once. Safe to press. */
  | { t: 'merge.stop'; reason?: string }
  /** Admin only. */
  | { t: 'merge.resume' };

export type MergeServerMsg =
  | { t: 'merge.state'; state: MergeViewState }
  | { t: 'merge.result'; ok: boolean; message: string };

/** What QA knows of a pull request, for the merge decision. */
export type MergeQa = Pick<PrAssessment, 'number' | 'sha' | 'state' | 'base' | 'title' | 'url'>;
