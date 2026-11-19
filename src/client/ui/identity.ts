// What a worker is called and what it's for, on the page: the two fields of the hire dialog, and the
// window that renames a worker and changes its role later (the ✏️ in its terminal and in the list).
// The office checks them all again (see WorkerIdentity); this only says so early, as they're typed.
import './identity.css';
import { DESK_BY_ID } from '../../shared/layout';
import type { WorkerInfo } from '../../shared/protocol';
import { DEFAULT_ROLE, NAME_MAX, SHELL_MARK, WORKER_ROLES, nameKey, parseWorkerName, roleLabel, workerRole } from '../../shared/worker-identity';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast } from './dom';

export interface IdentityFields {
  element: HTMLElement;
  /** What it's called, or undefined while that's left blank. */
  name(): string | undefined;
  role(): string;
  /** Whether both are fine; when not, the field says what's wrong. */
  valid(): boolean;
  focus(): void;
}

export interface IdentityFieldOptions {
  /** Makes the ids of the two fields' labels and notes unique on the page. */
  id: string;
  name?: string;
  role?: string;
  /** Renaming: the name can't be blank (when hiring, blank is the next free name). */
  required?: boolean;
  /** The worker being renamed, whose own name isn't taken by anyone else. */
  self?: string;
  /** A shell has no role. */
  noRole?: boolean;
}

/** A worker's name without a shell's mark. */
const plainName = (name: string) => name.replace(new RegExp(`\\s*${SHELL_MARK}$`, 'u'), '');

/** Whether a worker on this floor already has this name, as far as this page knows. */
const holder = (name: string, except?: string): WorkerInfo | undefined => [...store.workers.values()].find((w) => w.id !== except && nameKey(w.name) === nameKey(name));

export function identityFields(opts: IdentityFieldOptions): IdentityFields {
  const nameId = `${opts.id}-name`;
  const noteId = `${opts.id}-name-note`;
  const input = h('input', {
    type: 'text',
    id: nameId,
    value: opts.name ?? '',
    placeholder: opts.required ? 'Name' : 'Next free name, if left blank',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: NAME_MAX * 4,
    'aria-describedby': noteId,
  }) as HTMLInputElement;
  const note = h('p.identity-note', { id: noteId, 'aria-live': 'polite' });
  const roleId = `${opts.id}-role`;
  const have = opts.role ?? DEFAULT_ROLE;
  const select = h(
    'select',
    { id: roleId, class: 'identity-select' },
    // A role this office has no row for (a newer one's) is still the worker's: it shows as itself and stays unless changed.
    ...[...WORKER_ROLES.map((r) => r.id as string), ...(WORKER_ROLES.some((r) => r.id === have) ? [] : [have])].map((id) => h('option', { value: id }, roleLabel(id))),
  ) as HTMLSelectElement;
  select.value = have;

  /** Why the name won't do, or undefined. */
  const problem = (): string | undefined => {
    if (!input.value.trim()) return opts.required ? 'Give the worker a name' : undefined;
    const parsed = parseWorkerName(input.value);
    if ('error' in parsed) return parsed.error;
    const other = holder(parsed.name, opts.self);
    return other ? `Another worker on this floor is already called ${other.name}: pick a different name` : undefined;
  };
  const show = (bad: string | undefined) => {
    input.toggleAttribute('aria-invalid', !!bad);
    note.classList.toggle('bad', !!bad);
    note.textContent = bad ?? `Up to ${NAME_MAX} characters. Only what it's called changes, never who it is.`;
  };
  show(undefined);
  input.addEventListener('input', () => show(problem()));

  const element = h(
    'div.identity-fields',
    {},
    h('label', { for: nameId }, 'Worker name', opts.required ? null : h('span.identity-optional', {}, ' (optional)')),
    input,
    note,
    opts.noRole ? null : h('label', { for: roleId }, 'Role'),
    opts.noRole ? null : select,
    opts.noRole ? null : h('p.identity-note', {}, 'What it is for. A label only: it gives the worker no extra access.'),
  );
  return {
    element,
    name: () => {
      const parsed = input.value.trim() ? parseWorkerName(input.value) : undefined;
      return parsed && 'name' in parsed ? parsed.name : undefined;
    },
    role: () => select.value,
    valid: () => {
      const bad = problem();
      show(bad);
      if (bad) input.focus();
      return !bad;
    },
    focus: () => input.focus(),
  };
}

/** Renames a worker and/or changes its role: the ✏️ in its terminal and in the workers list. */
export function openIdentityDialog(net: Net, workerId: string) {
  const w = store.workers.get(workerId);
  if (!w) return;
  if (DESK_BY_ID.get(w.deskId)?.station) return void toast("A board agent's name is fixed", 'warn');
  const shell = w.kind === 'shell';
  const shown = plainName(w.name);
  const fields = identityFields({ id: 'identity', name: shown, role: workerRole(w), required: true, self: w.id, noRole: shell });
  const cancel = h('button.btn', { type: 'button' }, 'Never mind');
  const save = h('button.btn.primary', { type: 'submit' }, 'Save');
  const title = `✏️ Rename ${shown}`;
  const form = h(
    'form.modal.identity',
    { role: 'dialog', 'aria-label': title },
    h('header', {}, h('h2', {}, title)),
    h('div.body', {}, h('p', { style: 'margin:0 0 10px;font-weight:700;color:var(--muted)' }, 'Its session, worktree, branch and task carry on as they are.'), fields.element),
    h('footer', {}, h('span.grow', {}), cancel, save),
  ) as HTMLFormElement;
  form.noValidate = true;
  const modal = openModal(form);
  cancel.addEventListener('click', () => modal.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!fields.valid()) return;
    const name = fields.name();
    const role = fields.role();
    const renamed = name !== undefined && name !== shown;
    const reroled = !shell && role !== workerRole(w);
    if (!renamed && !reroled) return modal.close();
    modal.close();
    // `expect` is what this page showed: if someone changed it meanwhile, the office applies neither.
    net.send({ t: 'worker.identity', workerId: w.id, ...(renamed ? { name } : {}), ...(reroled ? { role } : {}), expect: { name: w.name, ...(shell ? {} : { role: workerRole(w) }) } });
  });
  setTimeout(() => {
    fields.focus();
    form.querySelector('input')?.select();
  }, 30);
}
