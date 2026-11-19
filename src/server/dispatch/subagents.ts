// A project's own Claude subagents: the definitions in its .claude/agents folder. They are listed so
// they can be told apart from workers; they are not at a desk, hold no session and are never given a
// task. Only the folder listing and the first lines of each file are read (its name and description).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Subagent } from '../../shared/protocol/dispatch.js';

const MAX_FILES = 40;
const HEAD_BYTES = 2048;

export function subagentsOf(floorId: string, dir: string): Subagent[] {
  const folder = path.join(dir, '.claude', 'agents');
  if (!existsSync(folder)) return [];
  const out: Subagent[] = [];
  try {
    for (const entry of readdirSync(folder).filter((f) => f.endsWith('.md')).sort().slice(0, MAX_FILES)) {
      const file = path.join(folder, entry);
      if (!statSync(file).isFile()) continue;
      const head = readFileSync(file, 'utf8').slice(0, HEAD_BYTES);
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1] ?? '';
      const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '');
      out.push({ floorId, name: field('name') ?? entry.replace(/\.md$/, ''), file: `.claude/agents/${entry}`, ...(field('description') ? { description: field('description')!.slice(0, 200) } : {}) });
    }
  } catch {
    // an unreadable folder is an empty list, not an error
  }
  return out;
}
