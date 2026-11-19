// A worker's record as the manager keeps it (see Worker in types.ts): what a new one is called, its
// colour, and the record itself, fresh from hiring or from workers.json.
import { randomBytes } from 'node:crypto';
import type { WorkerInfo } from '../../shared/protocol.js';
import { providerAdapter } from '../providers/index.js';
import type { UsageTracker } from '../usage.js';
import type { Worker } from './types.js';

export const NAMES = [
  'Pixel', 'Byte', 'Nibble', 'Sprocket', 'Widget', 'Gizmo', 'Bolt', 'Cosmo', 'Dot', 'Echo',
  'Fizz', 'Glitch', 'Hopper', 'Jinx', 'Kilo', 'Lumen', 'Mochi', 'Noodle', 'Orbit', 'Pip',
  'Quark', 'Rivet', 'Sparky', 'Tofu', 'Uno', 'Volt', 'Waffle', 'Zippy',
];
export const COLORS = ['#ff8a5b', '#5bc0eb', '#9bc53d', '#fde74c', '#c3423f', '#b388eb', '#f7aef8', '#72ddf7', '#ffb400', '#00a6a6'];

export function newWorker(info: WorkerInfo, tracker: UsageTracker, hookToken = randomBytes(16).toString('hex')): Worker {
  return {
    info,
    viewers: new Map(),
    screenDirty: true,
    lastLines: [],
    leftNeedsInputAt: 0,
    keyframeAt: 0,
    hookToken,
    state: providerAdapter(info.provider)?.createState?.(),
    failStreak: 0,
    prompts: [],
    tools: [],
    toolsSinceNamed: 0,
    namedAt: 0,
    taskEpoch: 0,
    tracker,
  };
}

/** Brings the viewers a worker's info shows (names, and who by connection) up to date with who has its terminal open; whether that changed anything. */
export function syncViewers(w: Worker): boolean {
  const names = [...new Set(w.viewers.values())];
  const ids = [...w.viewers.keys()];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i]);
  if (same(names, w.info.viewers) && same(ids, w.info.viewerIds)) return false;
  w.info.viewers = names;
  w.info.viewerIds = ids;
  return true;
}
