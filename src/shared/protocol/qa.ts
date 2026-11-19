// PR verification and the QA view (see shared/qa.ts and docs/qa-verification.md). Read-only data, plus
// three things a person does: look for reviewers, give a review to one, and record a review they made or
// imported themselves. Nothing here merges anything.

import type { AgentProvider } from './agents.js';
import type { Blocked, Candidate } from './dispatch.js';
import type { GhCheck } from './github.js';

/** Where a pull request stands. Merging is never a state: a person does that. */
export type QaState =
  | 'awaiting' // checks pending or missing, or still a draft
  | 'failed' // a check failed, or it cannot merge cleanly
  | 'needs-review' // checks pass, no independent review of this commit yet
  | 'blocked' // a security or policy rule needs a person, or a review asked for changes
  | 'ready'; // checks pass on this commit and an independent review of this commit stands: ready for a person to merge

/** What a change touches that decides how much trust it needs (see riskOf in shared/qa.ts). */
export type RiskCategory = 'ci-workflow' | 'install' | 'dependencies' | 'security' | 'source' | 'tests' | 'docs' | 'other' | 'unknown';

/** The checks of one commit, counted. */
export interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  /** Required checks that have not reported at all. */
  missing: string[];
  /** The name and link of every check, for the evidence. */
  items: GhCheck[];
  /** Where they came from: the board's list (one look, as of the sync) or the commit asked for by its exact SHA. */
  source: 'list' | 'commit';
}

/**
 * A review of one commit that the office holds. 'worker': a worker the office gave the review to, which
 * said so through its own authenticated tool call (never from a comment, a label or a role). 'human': a
 * person recorded it, as the verdict they reached themselves or imported from the QA Director desk.
 */
export interface QaEvidence {
  id: string;
  pr: number;
  /** The commit it is about. It counts only while that is still the pull request's head. */
  sha: string;
  kind: 'worker' | 'human';
  verdict: 'approve' | 'changes' | 'comment';
  summary: string;
  at: number;
  /** A worker's: who, as the office knew it then. */
  reviewerId?: string;
  reviewerName?: string;
  reviewerProvider?: AgentProvider;
  /** A human's: who recorded it, and what it points to (a QA Director review id, a note). */
  by?: string;
  reference?: string;
}

/** A review given to a worker, waiting for its verdict. */
export interface QaAssignment {
  id: string;
  pr: number;
  sha: string;
  workerId: string;
  workerName: string;
  workerProvider?: AgentProvider;
  /** The queue task that carries it. */
  taskId: string;
  by: string;
  at: number;
  /** Set when the verdict came in. */
  evidenceId?: string;
}

export type EvidenceStatus =
  | 'counts' // about this commit, and independent enough to count
  | 'stale' // about an earlier commit
  | 'not-independent' // the reviewer is (or may be) the author
  | 'unverifiable' // who wrote the code is not known, so independence cannot be shown: a person must record it
  | 'not-approval';

export interface EvidenceView extends QaEvidence {
  status: EvidenceStatus;
  /** Why, in words, when it does not count. */
  why?: string;
  /** For a worker's review: whether its agent differs from the author's. */
  crossProvider?: boolean;
}

export interface PrAssessment {
  number: number;
  title: string;
  url: string;
  /** The GitHub account that opened it. Every agent shares one, so it says nothing about who wrote the code. */
  author: string;
  /** The commit everything below is about. */
  sha: string;
  base: string;
  state: QaState;
  /** What is holding it, or what it needs, in the order that matters. */
  reasons: string[];
  checks: CheckSummary;
  draft: boolean;
  conflicts: boolean;
  fork: boolean;
  risk: RiskCategory[];
  /** Workers the office knows did the work (by their own record), by name: they cannot review it. */
  authors: string[];
  authorsKnown: boolean;
  evidence: EvidenceView[];
  /** A review given to a worker for this commit and not yet answered. */
  assigned?: { workerName: string; at: number };
  /** Whether a person's own review is what it needs (a security or policy rule). */
  needsHuman: boolean;
  updatedAt: string;
}

export interface QaPolicy {
  /** Always 'human': nothing here merges. */
  merge: 'human';
  /** Always false: no model-driven watching, no automatic review. */
  autoReview: false;
  /** Whether the board's checks were compared with the repository's required ones (it may not say). */
  requiredKnown: boolean;
}

export interface QaViewState {
  floorId: string;
  prs: PrAssessment[];
  policy: QaPolicy;
  at: number;
}

export interface ReviewerOffer {
  pr: number;
  sha: string;
  candidates: Candidate[];
  blocked: Blocked[];
  /** Why nobody is offered. */
  pending?: string;
}

export type QaClientMsg =
  | { t: 'qa.state' }
  /** Who could review it: idle QA Engineers and Reviewers on this floor, never its author. Changes nothing. */
  | { t: 'qa.reviewers'; pr: number }
  /** Admin only. Gives the review of this commit to one existing worker (through dispatch): never hires, never interrupts. */
  | { t: 'qa.assign'; pr: number; sha: string; workerId: string }
  /** Admin only. Records a review a person made or imported (the QA Director's), about this commit. */
  | { t: 'qa.attest'; pr: number; sha: string; verdict: 'approve' | 'changes' | 'comment'; reference?: string; summary?: string };

export type QaServerMsg =
  | { t: 'qa.state'; state: QaViewState }
  | { t: 'qa.reviewers'; offer: ReviewerOffer }
  | { t: 'qa.result'; pr: number; ok: boolean; message: string };
