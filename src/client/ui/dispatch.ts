// 🧭 Dispatch: the workers at a glance, and giving a waiting task to one of them. Everything on it is a
// look until you press Dispatch and confirm; the office computes the answers (shared/dispatch.ts) from the
// worker records it already has, so this window only asks and shows. Nobody is hired from here.
import './dispatch.css';
import type { DispatchPreview, Inventory, InventoryRow, QueueTask, ServerMsg } from '../../shared/protocol';
import { AGENT_PROVIDERS } from '../../shared/providers';
import { WORKER_ROLES } from '../../shared/worker-identity';
import type { Net } from '../net';
import { store } from '../state';
import { h, openModal, toast, STATUS_LABEL, timeAgo } from './dom';

/** What the open window shows, and where to redraw it. One window at a time. */
interface Open {
  inventory?: Inventory;
  previews: Map<string, DispatchPreview>;
  /** Per task: the role it must have (or '') and whether any agent will do, as the person set them for the look. */
  asks: Map<string, { role: string; anyAgent: boolean }>;
  draw(): void;
}
let open: Open | null = null;

/** The office's answers to this window; ignored when it isn't open. */
export function routeDispatchMessage(msg: ServerMsg) {
  if (!open) return;
  if (msg.t === 'dispatch.inventory') open.inventory = msg.inventory;
  else if (msg.t === 'dispatch.preview') open.previews.set(msg.preview.taskId, msg.preview);
  else if (msg.t === 'dispatch.result') {
    toast(msg.message, msg.ok ? 'info' : 'warn');
    open.previews.delete(msg.taskId);
  } else return;
  open.draw();
}

const AVAILABILITY: Record<string, string> = { available: 'Available', busy: 'Busy', waiting: 'Waiting on a person', reserved: 'Reserved', unavailable: 'Not assignable' };

function needsFor(open: Open, t: QueueTask) {
  const ask = open.asks.get(t.id) ?? { role: t.needs?.role ?? '', anyAgent: !!t.needs?.providers && t.needs.providers.length > 1 };
  return { ask, needs: { ...(ask.role ? { role: ask.role } : {}), ...(t.needs?.skills ? { skills: t.needs.skills } : {}), ...(ask.anyAgent ? { providers: [...AGENT_PROVIDERS] } : t.needs?.providers ? { providers: t.needs.providers } : {}) } };
}

export function openDispatch(net: Net) {
  const body = h('div.body.dispatch');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Dispatch', style: 'width:min(900px,100%)' },
    h('header', {}, h('h2', {}, '🧭 Dispatch'), close),
    body,
    h('footer', {}, h('span.grow', {}, 'A look, until you confirm. Nothing is sent without you, nobody is hired, and pull requests are merged by people.')),
  );
  const state: Open = { previews: new Map(), asks: new Map(), draw: () => render() };
  open = state;
  const ask = () => net.send({ t: 'dispatch.inventory' });

  const confirmGive = (t: QueueTask, workerId: string, name: string, needs: object) => {
    const yes = h('button.btn.primary', { type: 'button' }, 'Dispatch');
    const no = h('button.btn', { type: 'button' }, 'Never mind');
    const sure = h('div.modal', { role: 'alertdialog', 'aria-label': 'Confirm dispatch' }, h('header', {}, h('h2', {}, `Give it to ${name}?`)), h('div.body', {}, h('p', { style: 'margin:0;font-weight:700' }, `“${t.title}” will be typed into ${name}'s terminal as its next message. ${name} is free now; nobody is hired, and nothing else is interrupted.`)), h('footer', {}, no, yes));
    const m = openModal(sure);
    no.addEventListener('click', () => m.close());
    yes.addEventListener('click', () => {
      m.close();
      net.send({ t: 'dispatch.confirm', taskId: t.id, workerId, needs: needs as never });
    });
  };

  const taskCard = (t: QueueTask): HTMLElement => {
    const { ask: a, needs } = needsFor(state, t);
    const p = state.previews.get(t.id);
    const role = h('select', { 'aria-label': 'Role the task needs' }, h('option', { value: '' }, 'Any role'), ...WORKER_ROLES.map((r) => h('option', { value: r.id }, r.label))) as HTMLSelectElement;
    role.value = a.role;
    const any = h('input', { type: 'checkbox', id: `any-${t.id}` }) as HTMLInputElement;
    any.checked = a.anyAgent;
    const look = () => {
      state.asks.set(t.id, { role: role.value, anyAgent: any.checked });
      const n = needsFor(state, t).needs;
      net.send({ t: 'dispatch.preview', taskId: t.id, needs: n });
    };
    role.addEventListener('change', look);
    any.addEventListener('change', look);
    const parts: (HTMLElement | null)[] = [
      h('div.dispatch-task-head', {}, h('b', {}, t.title), t.hold ? h('span.pill', { title: 'The queue will not hire a worker for it' }, 'held for dispatch') : h('span.pill.warn', { title: 'The queue will hire a worker for it when it has room, unless you dispatch it first' }, 'queue may hire')),
      h('div.dispatch-ask', {}, h('label', {}, 'Role ', role), h('label', { for: `any-${t.id}` }, any, ' any agent (default: only ', t.provider ?? 'its own', ')'), h('button.btn', { type: 'button', onclick: look }, p ? '↻ Look again' : '🔍 Who could take it?'),
        h('button.btn', { type: 'button', title: t.hold ? 'Let the queue hire a worker for it, as it always did' : 'Keep it for dispatch: the queue will not hire for it', onclick: () => net.send({ t: 'queue.hold', taskId: t.id, hold: !t.hold }) }, t.hold ? 'Release to the queue' : '✋ Hold for dispatch')),
    ];
    if (p) {
      parts.push(
        p.candidates.length
          ? h('ol.dispatch-candidates', {}, ...p.candidates.map((c, i) => h('li', {}, h('div', {}, h('b', {}, c.name), ` · ${c.roleLabel}${c.provider ? ` · ${c.provider}` : ''}`, i === 0 ? h('span.pill.good', {}, 'best match') : null), h('div.reason', {}, c.reasons.join(' · ')), h('button.btn.primary', { type: 'button', onclick: () => confirmGive(t, c.workerId, c.name, needs) }, `Dispatch to ${c.name}…`))))
          : null,
        p.pending ? h('p.note.warn', { role: 'status' }, p.pending) : null,
        p.blocked.length ? h('details', {}, h('summary', {}, `${p.blocked.length} that cannot take it`), h('ul.dispatch-blocked', {}, ...p.blocked.map((b) => h('li', {}, h('b', {}, b.name), ` (${b.floorName}): ${b.reasons.join('; ')}`)))) : null,
      );
    }
    return h('li', {}, ...parts.filter((n): n is HTMLElement => n !== null));
  };

  const rowEl = (r: InventoryRow): HTMLElement => {
    const who = r.seat === 'worker' ? [r.roleLabel, r.provider].filter(Boolean).join(' · ') : r.seat === 'board-agent' ? 'board agent' : r.seat === 'shell' ? 'shell' : 'meeting seat';
    return h(
      'tr',
      { class: r.availability },
      h('td', {}, h('b', {}, r.name), r.seat !== 'worker' ? h('span.pill', {}, r.seat === 'board-agent' ? 'board agent' : r.seat) : null),
      h('td', {}, who, !r.roleKnown ? h('span.pill.warn', { title: 'A role this office does not know (from a newer one). It still works as a general worker.' }, 'role unknown') : null),
      h('td', {}, STATUS_LABEL[r.status] ?? r.status),
      h('td', {}, h('span.pill', { class: r.availability === 'available' ? 'good' : '' }, AVAILABILITY[r.availability] ?? r.availability), r.blockedBy.length ? h('div.reason', {}, r.blockedBy.join('; ')) : null),
      h('td', {}, r.task ?? '', r.openPr !== undefined ? ` 🔀 #${r.openPr}` : ''),
    );
  };

  const render = () => {
    const q = store.queue.tasks;
    const waiting = q.filter((t) => t.status === 'queued');
    const running = q.filter((t) => t.status === 'running');
    const inv = state.inventory;
    const mine = inv?.rows.filter((r) => r.floorId === inv.floorId) ?? [];
    const others = inv?.rows.filter((r) => r.floorId !== inv.floorId) ?? [];
    const count = (n: number, w: string) => `${n} ${w}`;
    const table = (rows: InventoryRow[]) => h('table.dispatch-table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Worker'), h('th', {}, 'Role · agent'), h('th', {}, 'Status'), h('th', {}, 'Availability'), h('th', {}, 'Doing'))), h('tbody', {}, ...rows.map(rowEl)));
    const kids: (Node | null)[] = [
      h('p.note', {}, count(mine.filter((r) => r.assignable).length, 'available'), ' · ', count(running.length, 'assigned or running'), ' · ', count(waiting.length, 'pending'), ' · ', count(mine.filter((r) => !r.assignable && r.seat === 'worker').length, 'blocked'), inv?.usageNote ? h('span.warn', {}, ` · ⚠ ${inv.usageNote}`) : null),
      h('h4', {}, '⏳ Pending tasks', h('span.count', {}, String(waiting.length))),
      waiting.length ? h('ul.dispatch-tasks', {}, ...waiting.map(taskCard)) : h('p.note', {}, 'Nothing is waiting. Add a task from the queue, ✋ held for dispatch if you do not want a worker hired for it.'),
      running.length ? h('h4', {}, '🤖 Assigned or running', h('span.count', {}, String(running.length))) : null,
      running.length ? h('ul.dispatch-running', {}, ...running.map((t) => h('li', {}, h('b', {}, t.title), ` → ${store.workers.get(t.workerId ?? '')?.name ?? t.workerName ?? 'a worker'}`, t.assigned ? h('span.pill', {}, `given by ${t.assigned.by} ${timeAgo(t.assigned.at)}`) : h('span.pill', {}, 'hired for it')))) : null,
      h('h4', {}, '👥 Workforce on this floor', h('span.count', {}, String(mine.length))),
      mine.length ? table(mine) : h('p.note', {}, inv ? 'Nobody is at a desk on this floor. Dispatch never hires: hire a worker yourself.' : 'Looking…'),
      others.length ? h('details', {}, h('summary', {}, `Other floors (${others.length}): never given this floor's tasks`), table(others)) : null,
      inv && inv.scope === 'this-floor' ? h('p.note', {}, 'Workers of other floors are shown to admins only.') : null,
      inv?.subagents.length ? h('details', {}, h('summary', {}, `Project subagents (${inv.subagents.length}): definitions, not workers`), h('ul.dispatch-blocked', {}, ...inv.subagents.map((s) => h('li', {}, h('b', {}, s.name), s.description ? ` — ${s.description}` : '')))) : null,
    ];
    body.replaceChildren(...kids.filter((n): n is Node => n !== null));
  };

  // The office is asked again when its workers or queue change, never on a timer: it answers from what it already has.
  let later: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    clearTimeout(later);
    later = setTimeout(() => {
      ask();
      for (const id of state.previews.keys()) {
        const t = store.queue.tasks.find((x) => x.id === id && x.status === 'queued');
        if (t) net.send({ t: 'dispatch.preview', taskId: id, needs: needsFor(state, t).needs as never });
        else state.previews.delete(id);
      }
    }, 400);
  };
  const unsubs = [store.on('queue', () => { render(); refresh(); }), store.on('workers', () => { render(); refresh(); })];
  const modal = openModal(el, { doing: '🧭 dispatching', onClose: () => { unsubs.forEach((u) => u()); clearTimeout(later); if (open === state) open = null; } });
  close.addEventListener('click', () => modal.close());
  render();
  ask();
}
