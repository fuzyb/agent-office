// Who a worker is, apart from the id it is found by: the display name a person gives it and the role
// it was hired for. Pure code that the browser (to check a name as it is typed) and the server (which
// decides) both use.
//
// The three are kept apart on purpose:
//   - WorkerInfo.id is the worker's identity: random, set when it's hired and never changed. Messages,
//     queue tasks, terminals, worktrees and the persisted state all refer to a worker by it.
//   - WorkerInfo.name is only what it is called. A person can change it at any time, and two workers
//     on different floors (or one after the other on the same floor) can have the same one.
//   - WorkerInfo.role is a stable role id for telling workers apart by what they are for. It is a
//     label, never a permission: nothing in the office decides what a worker may do by reading it.
import { DESK_BY_ID, STATION_AGENT } from './layout.js';
import type { WorkerClientMsg } from './protocol.js';

// --- Roles ----------------------------------------------------------------------------------------

/**
 * The roles a worker can be hired for. A role is a row here and nothing else: no role has code of its
 * own, and the ids that match a file in the HQ repository's roles/ folder are the same as its name
 * (engineering-chief → roles/engineering-chief.md), so whatever matches work to workers later can map
 * one to the other. To add a role, add a row (and the same id to ROLES in bin/office-workers.js, which a
 * test keeps in step).
 */
export const WORKER_ROLES = [
  { id: 'general-worker', label: 'General Worker' },
  { id: 'engineering-chief', label: 'Engineering Chief' },
  { id: 'chief-of-staff', label: 'Chief of Staff' },
  { id: 'product-architect', label: 'Product Architect' },
  { id: 'developer', label: 'Software Developer' },
  { id: 'backend-engineer', label: 'Backend Engineer' },
  { id: 'web-engineer', label: 'Web Engineer' },
  { id: 'mobile-engineer', label: 'Mobile Engineer' },
  { id: 'qa-engineer', label: 'QA Engineer' },
  { id: 'reviewer', label: 'PR Reviewer' },
  { id: 'security-engineer', label: 'Security Engineer' },
  { id: 'devops-engineer', label: 'DevOps Engineer' },
  { id: 'researcher', label: 'Researcher' },
] as const satisfies readonly { id: string; label: string }[];

export type WorkerRoleId = (typeof WORKER_ROLES)[number]['id'];

/** What a worker with no role set is (every worker hired before roles existed, and any hired without one). */
export const DEFAULT_ROLE: WorkerRoleId = 'general-worker';

const ROLE_IDS: ReadonlySet<string> = new Set(WORKER_ROLES.map((r) => r.id));

export const isWorkerRole = (v: unknown): v is WorkerRoleId => typeof v === 'string' && ROLE_IDS.has(v);

/** A role as a person would say it: "Engineering Chief". An id this office doesn't know (a newer one's) shows as itself. */
export function roleLabel(id: string): string {
  return WORKER_ROLES.find((r) => r.id === id)?.label ?? id;
}

/** The role id of a worker: its own, or the default for one that has none. */
export const workerRole = (w: { role?: string }): string => w.role || DEFAULT_ROLE;

/** The role to show beside a worker: an agent at a desk has one; a shell and a board agent don't. */
export const shownRole = (w: { kind: string; role?: string; deskId: string }): string | undefined => (w.kind === 'agent' && !DESK_BY_ID.get(w.deskId)?.station ? roleLabel(workerRole(w)) : undefined);

/** `Backend Engineer`, `backend_engineer` and `backend-engineer` all say the same thing. */
const roleKey = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** A role asked for by its id, or by its label as written in a list ("PR Reviewer"). */
export function parseWorkerRole(raw: unknown): { role: WorkerRoleId } | { error: string } {
  if (typeof raw === 'string') {
    const key = roleKey(raw);
    const hit = WORKER_ROLES.find((r) => r.id === key || roleKey(r.label) === key);
    if (hit) return { role: hit.id };
  }
  return { error: `role is one of ${WORKER_ROLES.map((r) => r.id).join(', ')}` };
}

/**
 * A role read back from workers.json. Lenient on purpose: an id this office has no row for (written by
 * a newer one, then rolled back) is kept as it is, so saving again doesn't wipe it.
 */
export function savedRole(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(raw) ? raw : undefined;
}

/** A field a person may leave blank (hiring without picking a name or role): nothing, or blank text, is "not given". */
export const given = (v: unknown): unknown => (v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? undefined : v);

// --- Names ----------------------------------------------------------------------------------------

/** The longest name, in characters as a person counts them ("👩\u200D🔬" is one). */
export const NAME_MAX = 32;
/** The most code points in one: stops a name made of a few characters under a pile of combining marks. */
const NAME_MAX_CODE_POINTS = 64;

/** The marker a shell's name carries (see WorkerManager.spawn). A name of an agent can't wear it. */
export const SHELL_MARK = '🐚';
/** A shell's mark at the end of its name, and the space before it. */
const SHELL_TAIL = /\s*🐚$/u;

/**
 * What a name is made of: letters and numbers of any script (with their marks), emoji (with their
 * joiners and skin tones), spaces, and a few marks of punctuation. Everything else is out, which keeps
 * a name from being markup, a command, a path, a mention (@), an issue reference (#) or a link.
 */
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200C\u200D\uFE0F\u20E3 \-–—_.,'’&+()]+$/u;
/** Control characters and the like: line breaks, tabs, private use, lone surrogates, line and paragraph separators. */
const CONTROL = /[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
/** Everything that takes no room on the line: joiners, variation selectors, fillers, direction marks, the combining grapheme joiner, soft hyphens. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const SKIN_OR_VS = /[\p{Emoji_Modifier}\uFE0F]/u;
/** A worker's id (see WorkerManager.spawn): a name that looks like one would be taken for it. */
const LOOKS_LIKE_ID = /^[0-9a-f]{12}$/i;
/** Scripts whose letters pass for each other: a word that mixes them is a way to pass as someone else. */
const LOOKALIKES = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

/**
 * Whether every invisible character in `text` has a job: the joiner inside an emoji sequence, the emoji
 * variation selector after an emoji (or before a keycap), or a zero-width non-joiner between letters of a
 * script that needs one. Anywhere else (a joiner in a Latin word, a selector after a letter, a filler) it
 * only makes a name that looks the same as another one differ from it.
 */
function invisiblesAreMeaningful(text: string): boolean {
  const cps = [...text];
  const letter = /^[\p{L}\p{M}]$/u;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (!INVISIBLE.test(c)) continue;
    const prev = cps[i - 1] ?? '';
    const next = cps[i + 1] ?? '';
    if (c === '\u200D') {
      let j = i - 1;
      while (j >= 0 && SKIN_OR_VS.test(cps[j])) j--;
      if (j >= 0 && PICTO.test(cps[j]) && PICTO.test(next)) continue;
    } else if (c === '\uFE0F') {
      if (PICTO.test(prev) || next === '\u20E3') continue;
    } else if (c === '\u200C') {
      if (letter.test(prev) && letter.test(next) && ![prev, next].some((x) => LOOKALIKES.some((s) => s.test(x)))) continue;
    }
    return false;
  }
  return true;
}

const graphemes = (s: string): number => {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of seg.segment(s)) n++;
  return n;
};

/** A name as it will be kept, or why it can't be: trimmed, with runs of spaces made one, and in Unicode's composed form. */
export function parseWorkerName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'name is text' };
  if (raw.length > NAME_MAX * 16) return { error: `A name is at most ${NAME_MAX} characters` };
  const text = raw.normalize('NFC');
  if (CONTROL.test(text) || /[\p{Cf}]/u.test(text.replace(/[\u200C\u200D]/g, ""))) return { error: "A name can't have line breaks, tabs, control or direction-changing characters in it" };
  if (!invisiblesAreMeaningful(text)) return { error: "A name can't have invisible characters in it, other than the joiners of an emoji" };
  const name = text.replace(/\p{Zs}+/gu, ' ').trim();
  if (!name) return { error: 'Give the worker a name' };
  if ([...name].length > NAME_MAX_CODE_POINTS || graphemes(name) > NAME_MAX) return { error: `A name is at most ${NAME_MAX} characters` };
  if (!ALLOWED.test(name)) return { error: "A name can use letters, numbers, spaces, emoji and - – — _ . , ' & + ( )" };
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name)) return { error: 'A name needs a letter, a number or an emoji' };
  // Real scripts stack a few marks on a letter; a pile of them is only there to spill over what's around it.
  if (/\p{M}{4,}/u.test(name)) return { error: "A name can't stack that many accents on one letter" };
  if (name.includes(SHELL_MARK)) return { error: `A name can't use ${SHELL_MARK}: that marks a shell` };
  if (LOOKS_LIKE_ID.test(nameKey(name))) return { error: "A name can't look like a worker id" };
  for (const word of name.split(' ')) {
    if (LOOKALIKES.filter((s) => s.test(word)).length > 1) return { error: "A name can't mix alphabets (Latin, Cyrillic, Greek) within one word" };
  }
  const reserved = Object.values(STATION_AGENT).find((a) => nameKey(a.name) === nameKey(name));
  if (reserved) return { error: `${reserved.name} is a board agent's name` };
  return { name };
}

/** Letters of other alphabets that are drawn like a Latin one (lower case): "аce" is not told from "ace". Not a full confusables table: it is the ones that really are the same shape. */
const LOOKS_LIKE: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w',
  '\u03BF': 'o', '\u03B1': 'a', '\u03BD': 'v', '\u03C1': 'p', '\u03B9': 'i', '\u03BA': 'k', '\u03C5': 'u', '\u03C7': 'x',
};

/**
 * What two names must differ in to be two names. Not: the case; the spacing around a dash; a
 * compatibility form of a letter ("Ｐixel"); anything invisible (a joiner, a variation selector, a filler)
 * anywhere in it; or a letter of another alphabet drawn like a Latin one. A shell's mark doesn't count.
 * Two workers on a floor can't share one of these, which keeps "tell Chief" from reaching someone else
 * and a worker from passing as another. It is applied to names already kept too, whatever they hold.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, '')
    .replace(SHELL_TAIL, '')
    .toLocaleLowerCase('en-US')
    .replace(/[\u0430\u0435\u043E\u0440\u0441\u0443\u0445\u0456\u0458\u0455\u04BB\u0501\u051B\u051D\u03BF\u03B1\u03BD\u03C1\u03B9\u03BA\u03C5\u03C7]/g, (c) => LOOKS_LIKE[c])
    .replace(/\s+/g, '')
    .replace(/[\u2013\u2014\u2212\u2010\u2011]/g, '-');
}

/**
 * A name in the characters a git branch and a folder can be called: its worktree is `office/<slug>-<id>`.
 * Taken once, when a worker is hired. A rename never changes it, so a worker's branch and worktree stay
 * where they were.
 */
export function workerSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  return slug || 'worker';
}

/** A worker's name without a shell's mark: what its rename window shows to edit. */
export const plainName = (name: string): string => name.replace(SHELL_TAIL, '');

/** What a worker was, as a window showed it. Taken once, when the window opened, and never read from the live worker again. */
export interface SeenWorker {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly role: string;
}

/**
 * What the rename window asks the office for, from what it showed when it opened (`seen`) and what was
 * typed: only what changed, with `expect` set to what was seen. If anyone has changed the worker since,
 * the office refuses the whole thing instead of writing over theirs. Nothing when nothing changed.
 */
export function identityRequest(seen: SeenWorker, typed: { name?: string; role?: string }): Extract<WorkerClientMsg, { t: 'worker.identity' }> | undefined {
  const shell = seen.kind === 'shell';
  const renamed = typed.name !== undefined && typed.name !== plainName(seen.name);
  const reroled = !shell && typed.role !== undefined && typed.role !== seen.role;
  if (!renamed && !reroled) return undefined;
  return {
    t: 'worker.identity',
    workerId: seen.id,
    ...(renamed ? { name: typed.name } : {}),
    ...(reroled ? { role: typed.role } : {}),
    expect: { name: seen.name, ...(shell ? {} : { role: seen.role }) },
  };
}
