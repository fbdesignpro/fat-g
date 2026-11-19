// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M105: provider-independent live ownership, separate from durable activity.
import type { ActionKind, ActionWait } from '../contracts/sessions';

export interface LiveAction {
  readonly kind: ActionKind;
  readonly file?: string;
  readonly wait?: ActionWait;
  readonly tool?: true;
  readonly line?: string;
}
export function sameLiveAction(a: LiveAction, b: LiveAction): boolean {
  return a.kind === b.kind && a.file === b.file && a.line === b.line && a.tool === b.tool
    && a.wait?.reason === b.wait?.reason && (a.wait?.reason !== 'subagents' || b.wait?.reason === 'subagents' && a.wait.count === b.wait.count);
}
interface OpenAction extends LiveAction {
  readonly message?: boolean;
  readonly targets?: ReadonlySet<string>;
  readonly releaseWithTargets?: boolean;
}

export class LiveActions {
  private readonly open = new Map<string, OpenAction>();
  private readonly completed = new Set<string>();

  start(id: string, action: OpenAction): void {
    if (!this.open.has(id) && !this.completed.has(id) && action.kind !== 'thinking') this.open.set(id, action);
  }
  end(id: string): void { if (this.open.delete(id)) this.completed.add(id); }
  ended(id: string): boolean { return this.completed.has(id); }
  clear(): void { this.open.clear(); this.completed.clear(); }

  link(id: string, target: string): void {
    const action = this.open.get(id);
    if (action?.wait?.reason === 'subagents') this.open.set(id, { ...action, targets: new Set([target]), releaseWithTargets: true });
  }

  endTarget(target: string): void {
    for (const [id, action] of this.open) {
      if (!action.targets?.has(target)) continue;
      const targets = new Set(action.targets);
      targets.delete(target);
      if (targets.size === 0 && action.releaseWithTargets) this.end(id);
      else this.open.set(id, { ...action, targets });
    }
  }

  current(): LiveAction {
    const all = [...this.open.values()];
    const local = all.filter((action) => action.kind !== 'waiting' && !action.message).at(-1);
    if (local !== undefined) return { kind: local.kind, ...(local.file === undefined ? {} : { file: local.file }), ...(local.kind === 'writing' ? { tool: true } : {}) };
    if (all.some((action) => action.message)) return { kind: 'writing' };
    const waits = all.filter((action) => action.kind === 'waiting');
    if (waits.length === 0) return { kind: 'thinking' };
    if (waits.every((action) => action.wait?.reason === 'subagents' && (action.targets === undefined || action.targets.size > 0))) {
      const known = waits.every((action) => action.targets !== undefined);
      const count = new Set(waits.flatMap((action) => [...(action.targets ?? [])])).size;
      return { kind: 'waiting', wait: { reason: 'subagents', ...(known && count > 0 ? { count: Math.min(256, count) } : {}) } };
    }
    return { kind: 'waiting', wait: { reason: 'provider' } };
  }
}
