// Where the office's automation will plug in later. Nothing here runs: each seat has an interface and a
// default that does nothing, so adding automation means giving a seat a real implementation, behind a
// setting that is off, and a security design that says what it may do. Today dispatch is manual.
//
// What none of these may ever do on the strength of a label: the role on a worker, a comment on a pull
// request, or the GitHub account a review was posted from (every agent here shares one) are claims, not
// evidence. "An independent review happened" has to come from what the office recorded itself: which
// agent and which worker produced the review, and a verdict a person imported at the QA desk.
import type { DispatchPreview } from '../../shared/protocol/dispatch.js';

/** Where tasks come from without a person typing them: the issues board, a plan, a webhook. Would add *held* queue tasks. */
export interface TaskIntake {
  readonly name: string;
  poll(): Promise<{ title: string; prompt: string; issue?: number }[]>;
}

/** Picks a worker from a preview. Manual dispatch is the one in use: it picks nobody, a person does. */
export interface DispatchStrategy {
  readonly name: string;
  choose(preview: DispatchPreview): string | undefined;
}
export const manual: DispatchStrategy = { name: 'manual', choose: () => undefined };

/** Engineering Chief orchestration: splits an objective into tasks. A seat only; the Chief is a worker like any other today. */
export interface Orchestrator {
  readonly name: string;
  plan(objective: string): Promise<{ title: string; prompt: string; needs?: { role?: string; skills?: string[] } }[]>;
}

/** Test results a worker's work produced, read by code (never asked of a model). */
export interface TestResultCollector {
  collect(workerId: string): Promise<{ command: string; passed: number; failed: number; at: number } | undefined>;
}

/** Evidence that a review was independent, recorded by the office. Not a role label, a comment or an account name. */
export interface ReviewEvidence {
  /** The agent that wrote the review, and the worker, as the office recorded them. */
  reviewerProvider: string;
  reviewerWorker: string;
  /** The agent and worker that wrote the code. */
  authorProvider: string;
  authorWorker: string;
  /** A verdict a person imported at the QA desk, when there is one. */
  importedVerdict?: string;
}

export interface PrFacts {
  number: number;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  draft: boolean;
  evidence?: ReviewEvidence;
}

export interface PrReadiness {
  /** Whether the pull request is ready for a person to look at. Never "merge it": that is the person's. */
  readyForHuman: boolean;
  /** Always 'human': the office does not merge. Changing that needs its own approved security design. */
  merge: 'human';
  reasons: string[];
}

export interface PrReadinessClassifier {
  classify(pr: PrFacts): PrReadiness;
}

/** The default: says nothing is ready and that a person merges. */
export const conservative: PrReadinessClassifier = {
  classify: () => ({ readyForHuman: false, merge: 'human', reasons: ['not classified: PR readiness is a later release, and humans merge'] }),
};
