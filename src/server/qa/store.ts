// What the office remembers for the QA view: the reviews it holds (each bound to one commit), the reviews
// it has given to workers, and who did the work on each pull request (kept after a worker goes home, so
// the answer to "may this worker review it?" does not change when the author's desk is emptied).
// One small file per floor, in the floor's own data folder. Nothing here is a credential.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { QaAssignment, QaEvidence } from '../../shared/protocol/qa.js';

export interface AuthorsSeen {
  ids: string[];
  names: string[];
  providers: (string | undefined)[];
}

interface Saved {
  evidence: QaEvidence[];
  assignments: QaAssignment[];
  authors: Record<string, AuthorsSeen>;
}

const KEEP = 500;
const VERDICTS = new Set(['approve', 'changes', 'comment']);

export class QaStore {
  evidence: QaEvidence[] = [];
  assignments: QaAssignment[] = [];
  authors = new Map<number, AuthorsSeen>();
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'qa.json');
    this.restore();
  }

  save() {
    // The oldest go first: a floor keeps a few hundred reviews, which is a long while at the pace reviews are made.
    this.evidence = this.evidence.slice(-KEEP);
    this.assignments = this.assignments.slice(-KEEP);
    const saved: Saved = { evidence: this.evidence, assignments: this.assignments, authors: Object.fromEntries(this.authors) };
    try {
      writeFileSync(this.file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      // disk issues shouldn't take the office down
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
      for (const e of raw.evidence ?? []) {
        if (typeof e?.id !== 'string' || !Number.isSafeInteger(e.pr) || typeof e.sha !== 'string' || !/^[0-9a-f]{7,64}$/.test(e.sha) || !VERDICTS.has(e.verdict) || (e.kind !== 'worker' && e.kind !== 'human')) continue;
        this.evidence.push({ id: e.id, pr: e.pr, sha: e.sha, kind: e.kind, verdict: e.verdict, summary: str(e.summary, 4000) ?? '', at: Number(e.at) || 0, reviewerId: str(e.reviewerId, 32), reviewerName: str(e.reviewerName, 64), reviewerProvider: e.reviewerProvider, by: str(e.by, 64), reference: str(e.reference, 200) });
      }
      for (const a of raw.assignments ?? []) {
        if (typeof a?.id !== 'string' || !Number.isSafeInteger(a.pr) || typeof a.sha !== 'string' || typeof a.workerId !== 'string' || typeof a.taskId !== 'string') continue;
        this.assignments.push({ id: a.id, pr: a.pr, sha: a.sha, workerId: a.workerId, workerName: str(a.workerName, 64) ?? '', workerProvider: a.workerProvider, taskId: a.taskId, by: str(a.by, 64) ?? '', at: Number(a.at) || 0, ...(typeof a.evidenceId === 'string' ? { evidenceId: a.evidenceId } : {}) });
      }
      for (const [n, v] of Object.entries(raw.authors ?? {})) {
        if (Number.isSafeInteger(Number(n)) && Array.isArray(v?.ids)) this.authors.set(Number(n), { ids: v.ids.filter((x) => typeof x === 'string'), names: (v.names ?? []).filter((x) => typeof x === 'string'), providers: v.providers ?? [] });
      }
    } catch {
      // a corrupt file starts the QA view over: reviews are asked for again, nothing is trusted from it
    }
  }
}
