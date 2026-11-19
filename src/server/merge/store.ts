// What the office keeps about automatic merging. The POLICY is office-wide (one file in the office's data
// folder: which repositories it is on for, and the emergency stop). The AUDIT and the APPROVALS are per floor
// (in its own data folder). The audit is append-only: one JSON line per decision, attempt, merge or refusal, and
// it is never rewritten. None of it holds a credential.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_FILES, DEFAULT_MAX_LINES, METHODS } from '../../shared/merge.js';
import type { AuditEntry, AuditKind, MergeApproval, MergeMode, RepoMergePolicy } from '../../shared/protocol/merge.js';

const MODES: readonly MergeMode[] = ['off', 'approve', 'auto'];
const KINDS: ReadonlySet<string> = new Set<AuditKind>(['decision', 'approval', 'revoked', 'attempt', 'merging', 'merged', 'blocked', 'policy', 'stop', 'resume']);

interface SavedPolicy {
  repos: Record<string, RepoMergePolicy>;
  stopped?: { by: string; at: number; reason?: string };
}

/** Per-repository policy and the emergency stop, for the whole office. Only an admin changes it, through the browser. */
export class MergePolicyStore {
  readonly repos = new Map<string, RepoMergePolicy>();
  stopped?: { by: string; at: number; reason?: string };
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'automerge.json');
    this.restore();
  }

  get(repo: string | undefined): RepoMergePolicy | undefined {
    return repo ? this.repos.get(repo.toLowerCase()) : undefined;
  }

  set(repo: string, policy: RepoMergePolicy | undefined) {
    if (policy && policy.mode !== 'off') this.repos.set(repo.toLowerCase(), policy);
    else this.repos.delete(repo.toLowerCase());
    this.save();
  }

  stop(by: string, reason?: string) {
    this.stopped = { by, at: Date.now(), ...(reason ? { reason: reason.slice(0, 200) } : {}) };
    this.save();
  }

  resume() {
    this.stopped = undefined;
    this.save();
  }

  private save() {
    const saved: SavedPolicy = { repos: Object.fromEntries(this.repos), ...(this.stopped ? { stopped: this.stopped } : {}) };
    try {
      writeFileSync(this.file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch {
      // A policy that cannot be saved is not left switched on: the next start finds none.
    }
  }

  private restore() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SavedPolicy>;
      for (const [repo, p] of Object.entries(raw.repos ?? {})) {
        // Anything that is not exactly what it should be is not switched on.
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !p || !MODES.includes(p.mode) || p.mode === 'off' || !METHODS.includes(p.method) || !Array.isArray(p.bases) || typeof p.authorization !== 'string' || !p.authorization.trim()) continue;
        this.repos.set(repo.toLowerCase(), {
          mode: p.mode,
          method: p.method,
          bases: p.bases.filter((b): b is string => typeof b === 'string').slice(0, 10),
          maxChangedLines: Number.isFinite(p.maxChangedLines) ? Math.max(1, Math.min(5000, Math.floor(p.maxChangedLines))) : DEFAULT_MAX_LINES,
          maxFiles: Number.isFinite(p.maxFiles) ? Math.max(1, Math.min(100, Math.floor(p.maxFiles))) : DEFAULT_MAX_FILES,
          extraLowRisk: (p.extraLowRisk ?? []).filter((g): g is string => typeof g === 'string').slice(0, 20),
          authorization: p.authorization.slice(0, 300),
          authorizedBy: String(p.authorizedBy ?? '').slice(0, 64),
          authorizedAt: Number(p.authorizedAt) || 0,
        });
      }
      if (raw.stopped && typeof raw.stopped.by === 'string') this.stopped = { by: raw.stopped.by.slice(0, 64), at: Number(raw.stopped.at) || 0, ...(raw.stopped.reason ? { reason: String(raw.stopped.reason).slice(0, 200) } : {}) };
    } catch {
      // A damaged file switches nothing on.
    }
  }
}

/** One floor's permanent record, and the approvals a person gave. */
export class FloorMergeStore {
  readonly approvals = new Map<number, MergeApproval>();
  private auditFile: string;
  private approvalsFile: string;
  /** From the record, so they survive a restart: commits already merged, and attempts made per commit. */
  readonly merged = new Set<string>();
  readonly attempts = new Map<string, number>();

  constructor(dataDir: string) {
    this.auditFile = path.join(dataDir, 'merge-audit.jsonl');
    this.approvalsFile = path.join(dataDir, 'merge-approvals.json');
    for (const e of this.read(100000)) {
      if (e.pr === undefined || !e.sha) continue;
      const key = `${e.pr}@${e.sha}`;
      if (e.kind === 'merged') this.merged.add(key);
      if (e.kind === 'attempt') this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    }
    try {
      for (const a of JSON.parse(readFileSync(this.approvalsFile, 'utf8')) as MergeApproval[]) if (Number.isSafeInteger(a?.pr) && /^[0-9a-f]{7,64}$/.test(a.sha) && typeof a.by === 'string') this.approvals.set(a.pr, { pr: a.pr, sha: a.sha, by: a.by.slice(0, 64), at: Number(a.at) || 0 });
    } catch {
      // none, or damaged: nothing is approved
    }
  }

  /** Appends one line. Never rewrites what is there. */
  add(e: AuditEntry) {
    const entry: AuditEntry = { ...e, ...(e.reasons ? { reasons: e.reasons.map((r) => r.slice(0, 300)).slice(0, 12) } : {}) };
    try {
      appendFileSync(this.auditFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // the record is the one thing that must not be lost silently: the merge code refuses to merge when it cannot write (see MergeService.write)
      throw new Error('The merge audit file could not be written');
    }
    if (e.pr !== undefined && e.sha) {
      const key = `${e.pr}@${e.sha}`;
      if (e.kind === 'merged') this.merged.add(key);
      if (e.kind === 'attempt') this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
    }
  }

  recent(n: number): AuditEntry[] {
    return this.read(n);
  }

  saveApprovals() {
    try {
      writeFileSync(this.approvalsFile, JSON.stringify([...this.approvals.values()], null, 2), { mode: 0o600 });
    } catch {
      // not saved: after a restart nothing stays approved, which is the safe way to lose it
    }
  }

  private read(n: number): AuditEntry[] {
    if (!existsSync(this.auditFile)) return [];
    const out: AuditEntry[] = [];
    let text: string;
    try {
      text = readFileSync(this.auditFile, 'utf8');
    } catch {
      return [];
    }
    for (const line of text.split('\n').slice(-n - 1)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (KINDS.has(e.kind) && typeof e.repo === 'string') out.push(e);
      } catch {
        // a torn last line is skipped
      }
    }
    return out.slice(-n);
  }
}
