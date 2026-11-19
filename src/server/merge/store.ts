// What the office keeps about automatic merging. The POLICY is office-wide (one file in the office's data
// folder: which repositories it is on for, and the emergency stop). The AUDIT and the APPROVALS are per floor
// (in its own data folder). The audit is append-only: one JSON line per decision, attempt, merge or refusal, and
// it is never rewritten. None of it holds a credential.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MAX_FILES, DEFAULT_MAX_LINES, METHODS } from '../../shared/merge.js';
import type { AuditEntry, AuditKind, MergeApproval, MergeMode, RepoMergePolicy } from '../../shared/protocol/merge.js';

const MODES: readonly MergeMode[] = ['off', 'approve', 'auto'];
const KINDS: ReadonlySet<string> = new Set<AuditKind>(['decision', 'approval', 'revoked', 'attempt', 'merging', 'merged', 'blocked', 'policy', 'stop', 'resume', 'assigned', 'routed', 'escalated']);

interface SavedPolicy {
  repos: Record<string, RepoMergePolicy>;
  stopped?: { by: string; at: number; reason?: string };
}

/** The disk, as the policy file uses it. Tests replace it to make a write fail. */
export interface PolicyIo {
  read(file: string): string | undefined;
  /** Writes the whole file or throws; never leaves half of one (a temporary file, then a rename). */
  write(file: string, text: string): void;
  remove(file: string): void;
  exists(file: string): boolean;
}

export const realIo: PolicyIo = {
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
  write: (file, text) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file);
  },
  remove: (file) => rmSync(file, { force: true }),
  exists: existsSync,
};

/** A change to the policy or the stop could not be saved. Says what state the running office is left in. */
export class PolicyWriteError extends Error {}

/**
 * Per-repository policy and the emergency stop, for the whole office. Only an admin changes it, through the browser.
 *
 * It fails closed. `revision` moves on every change, so anything that began before one can tell it did. A change that
 * loosens (switching a repository on or changing it, resuming after a stop) takes effect only once it is saved: if the
 * write fails, nothing changed and it says so. A change that tightens (switching off, stopping) takes effect at once
 * whether or not it can be saved; if it cannot, the office stays stopped, the older file is removed if that can be done
 * and a marker is written if that can, so a restart does not bring back what was just taken away, and it says it
 * could not be saved. A marker found at startup means: nothing is on, and it is stopped until an admin resumes it.
 */
export class MergePolicyStore {
  readonly repos = new Map<string, RepoMergePolicy>();
  stopped?: { by: string; at: number; reason?: string };
  /** Moves on every change, even one that could not be saved. */
  revision = 0;
  private file: string;
  private marker: string;

  constructor(
    dataDir: string,
    private io: PolicyIo = realIo,
  ) {
    this.file = path.join(dataDir, 'automerge.json');
    this.marker = `${this.file}.failed`;
    this.restore();
  }

  get(repo: string | undefined): RepoMergePolicy | undefined {
    return repo ? this.repos.get(repo.toLowerCase()) : undefined;
  }

  /** Switches a repository's policy on or changes it (saved before it counts), or off (counts at once). Throws PolicyWriteError when it could not be saved. */
  set(repo: string, policy: RepoMergePolicy | undefined) {
    this.revision++;
    const key = repo.toLowerCase();
    const before = this.repos.get(key);
    if (policy && policy.mode !== 'off') this.repos.set(key, policy);
    else this.repos.delete(key);
    const loosens = !!policy && policy.mode !== 'off';
    try {
      this.persist();
    } catch {
      if (loosens) {
        // Nothing changed: it is not switched on, and the older policy is what is on disk.
        if (before) this.repos.set(key, before);
        else this.repos.delete(key);
        throw new PolicyWriteError('The policy could not be saved to disk, so it was not switched on and nothing changed');
      }
      this.lock('the policy could not be saved');
      throw new PolicyWriteError('It is off in the running office, but the change could not be saved to disk: the office stays stopped until an admin resumes it, and nothing from before is trusted after a restart');
    }
  }

  /** Stops everything. Takes effect at once; throws PolicyWriteError if it could not be saved (it is still on in the running office). */
  stop(by: string, reason?: string) {
    this.revision++;
    this.stopped = { by, at: Date.now(), ...(reason ? { reason: reason.slice(0, 200) } : {}) };
    try {
      this.persist();
    } catch {
      this.lock('the emergency stop could not be saved');
      throw new PolicyWriteError('The stop is on in the running office, but it could not be saved to disk: the office stays stopped until an admin resumes it, and a restart does not bring back anything that was on');
    }
  }

  /** Resumes, but only once that is saved: if the write fails it stays stopped. Throws PolicyWriteError when it could not be saved. */
  resume() {
    this.revision++;
    const was = this.stopped;
    this.stopped = undefined;
    try {
      this.persist();
    } catch {
      this.stopped = was ?? { by: 'office', at: Date.now(), reason: 'could not be resumed' };
      throw new PolicyWriteError('It could not be resumed: the change could not be saved to disk, so it stays stopped');
    }
  }

  /** Writes the whole state, then forgets any failure marker. Throws if the state could not be written. */
  private persist() {
    const saved: SavedPolicy = { repos: Object.fromEntries(this.repos), ...(this.stopped ? { stopped: this.stopped } : {}) };
    this.io.write(this.file, JSON.stringify(saved, null, 2));
    try {
      this.io.remove(this.marker);
    } catch {
      // a marker that stays only keeps it stopped for one more start
    }
  }

  /** A tightening change could not be saved: stay stopped, and make sure a restart cannot bring back the older, looser file. */
  private lock(reason: string) {
    this.stopped ??= { by: 'office', at: Date.now(), reason };
    try {
      this.io.remove(this.file);
    } catch {
      // the marker below is the second way
    }
    try {
      this.io.write(this.marker, `${reason}; automatic merging stays stopped until an admin resumes it`);
    } catch {
      // nothing more can be done: the failure has been reported
    }
  }

  private restore() {
    // A marker means a change could not be saved last time: nothing is on, whatever the file says, and it is stopped.
    if (this.io.exists(this.marker)) {
      this.stopped = { by: 'office', at: Date.now(), reason: 'a change to the policy could not be saved last time: switch each repository on again' };
      return;
    }
    let text: string | undefined;
    try {
      text = this.io.read(this.file);
    } catch {
      return;
    }
    if (text === undefined) return;
    try {
      const raw = JSON.parse(text) as Partial<SavedPolicy>;
      for (const [repo, p] of Object.entries(raw.repos ?? {})) {
        // Anything that is not exactly what it should be is not switched on.
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !p || !MODES.includes(p.mode) || p.mode === 'off' || !METHODS.includes(p.method) || !Array.isArray(p.bases) || typeof p.authorization !== 'string' || !p.authorization.trim()) continue;
        this.repos.set(repo.toLowerCase(), {
          mode: p.mode,
          method: p.method,
          bases: p.bases.filter((b): b is string => typeof b === 'string').slice(0, 10),
          maxChangedLines: Number.isFinite(p.maxChangedLines) ? Math.max(1, Math.min(5000, Math.floor(p.maxChangedLines))) : DEFAULT_MAX_LINES,
          maxFiles: Number.isFinite(p.maxFiles) ? Math.max(1, Math.min(100, Math.floor(p.maxFiles))) : DEFAULT_MAX_FILES,
          humanPaths: (p.humanPaths ?? []).filter((g): g is string => typeof g === 'string').slice(0, 20),
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
  /** From the record, so they survive a restart: commits already merged, and the times GitHub was asked to merge each commit. */
  readonly merged = new Set<string>();
  readonly attempts = new Map<string, number>();

  constructor(dataDir: string) {
    this.auditFile = path.join(dataDir, 'merge-audit.jsonl');
    this.approvalsFile = path.join(dataDir, 'merge-approvals.json');
    for (const e of this.read(100000)) {
      if (e.pr === undefined || !e.sha) continue;
      const key = `${e.pr}@${e.sha}`;
      if (e.kind === 'merged') this.merged.add(key);
      if (e.kind === 'merging') this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
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
      if (e.kind === 'merging') this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
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
