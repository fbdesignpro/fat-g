// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session channels (docs/planning/_archive/M14.md, Design 6; C31–C36, C96, C107, C108; M14b.md, Design 8).
// The page asks; main checks against what it holds — the records, and the catalog and the provider
// snapshots in the app state — and only then lets the session service change a record.
//
// A preset, an effort level and a speed tier are checked with the same helpers the page offers them
// with, on the same snapshots (src/shared/contracts/presets.ts), so main refuses whatever the page did
// (C94). A model, a level and a tier are an instance's own: another instance of the provider may list
// what this one does not (M14b, C25, C28). A session's model is fixed at create: no channel changes it (M14b, C55).
import { findModel } from '@shared/contracts/catalog';
import { catalogEntry, checkPreset, presetOffer, speedCheck } from '@shared/contracts/presets';
import { inPlan, type RunningDoing, type SessionRefusal, type SessionRefusalReason, type SessionSaved } from '@shared/contracts/sessions';
import type { RecordsStore } from '../../records/store';
import { admitPreset } from '../../sessions/preset-admission';
import type { Removal } from '../../sessions/removal';
import type { Secretary } from '../../sessions/secretary/service';
import type { SessionService } from '../../sessions/service';
import type { SessionRuntime } from '../../sessions/runtime';
import type { AppStateStore } from '../../state/app-state-store';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';

export interface SessionHandlerDeps {
  readonly draftPreset?: SessionRuntime['setDraftPreset'];
  readonly sessions: SessionService;
  readonly records: Pick<RecordsStore, 'isRefused' | 'getProject' | 'orphanIds'>;
  /**
   * A removal takes the sessions' saved chats with their records (M18, C21): marked, removed, then
   * deleted, and refused while the conversation store is (C42). Without it only the records go.
   */
  readonly removal?: Pick<Removal, 'run'>;
  /** The catalog and the provider snapshots as the Main window has them. */
  readonly store: Pick<AppStateStore, 'getSnapshot'>;
  /** Whether a provider is registered in this build. */
  readonly hasProvider: (providerId: string) => boolean;
  /**
   * The secretary (M26, round 2): what a session with no turn yet is described by, asked of its own
   * instance. Left out, nothing is asked and the channel answers `skipped`.
   */
  readonly secretary?: Pick<Secretary, 'draft'>;
  /**
   * What a running session is doing (M22e; the maintainer's V6 review): a Complete's or a Remove's
   * refusal because it runs says it, so the page can say why. Left out, the refusal names nothing.
   */
  readonly doing?: (id: string) => RunningDoing;
}

type Channels =
  | 'sessions:setDraftPreset'
  | 'sessions:create'
  | 'sessions:select'
  | 'sessions:acknowledge'
  | 'sessions:setFlag'
  | 'sessions:rename'
  | 'sessions:describeDraft'
  | 'sessions:complete'
  | 'sessions:shelve'
  | 'sessions:restore'
  | 'sessions:doing'
  | 'sessions:move'
  | 'sessions:setEffort'
  | 'sessions:setSpeed'
  | 'sessions:remove'
  | 'sessions:removeOrphans';

const refused = (reason: SessionRefusalReason): SessionRefusal => ({ status: 'refused', reason });

export function sessionHandlers(deps: SessionHandlerDeps): Pick<InvokeHandlers, Channels> {
  const catalog = () => deps.store.getSnapshot().catalog;

  /** A refusal because the session runs, saying what it is doing where main can say it. */
  const runs = (id: string): SessionRefusal => (deps.doing === undefined ? refused('running') : { ...refused('running'), doing: deps.doing(id) });
  const saying = <T extends SessionSaved | SessionRefusal>(id: string, answer: T): T | SessionRefusal => (answer.status === 'refused' && answer.reason === 'running' ? runs(id) : answer);

  /**
   * The session's record, when it is not held (C108; M14b, C29, C62): its provider and its instance
   * can be asked for something, and its configuration folder, compared first, is its instance's.
   */
  async function changeable(id: string) {
    if (deps.records.isRefused()) return refused('records-refused');
    if (deps.sessions.record(id) === undefined) return refused('unknown-session');
    const hold = await deps.sessions.hold(id);
    if (hold !== null) return refused(hold);
    // As it is now: the comparison may have taken a moment.
    return deps.sessions.record(id) ?? refused('unknown-session');
  }

  return {
    'sessions:setDraftPreset'({ id, preset }) {
      if (!deps.hasProvider(preset.providerId)) throw new InvalidIpcRequest();
      if (deps.records.isRefused()) return refused('records-refused');
      const record = deps.sessions.record(id);
      if (record === undefined) return refused('unknown-session');
      const project = deps.records.getProject(record.projectId);
      if (project === undefined) return refused('unknown-project');
      const check = checkPreset(catalog(), presetOffer(project.providers, deps.store.getSnapshot().providers), preset);
      if (!check.ok) return refused(check.reason);
      return deps.draftPreset?.(id, check.preset) ?? refused('draft-locked');
    },
    'sessions:create'({ projectId, preset }) {
      // A provider this build does not have is a bad request, as on the provider channels.
      if (!deps.hasProvider(preset.providerId)) throw new InvalidIpcRequest();
      if (deps.records.isRefused()) return refused('records-refused');
      const check = admitPreset({ project: (id) => deps.records.getProject(id), hasProvider: deps.hasProvider, catalog, accounts: () => deps.store.getSnapshot().providers }, projectId, preset);
      if (!check.ok) return refused(check.reason);
      return deps.sessions.create(projectId, check.preset);
    },

    'sessions:select': ({ id }) => deps.sessions.select(id),
    'sessions:acknowledge': ({ id }) => deps.sessions.acknowledge(id),
    'sessions:setFlag': ({ id, flag, on }) => deps.sessions.setFlag(id, flag, on),
    'sessions:rename': ({ id, name }) => deps.sessions.setName(id, name),

    /**
     * The unsent draft of a session no turn has run (M26, round 2): the secretary is asked what it
     * is about, and its answer names the session as any generated title does. Nothing is asked for a
     * session that has run — its first prompt asks for a title of its own — nor for one the user has
     * named, and nothing is saved here: the name arrives as an event, later or never.
     */
    'sessions:describeDraft'({ id, text }) {
      if (deps.records.isRefused()) return refused('records-refused');
      const record = deps.sessions.record(id);
      if (record === undefined) return refused('unknown-session');
      if (record.reference !== null || record.lastTurn !== null || record.nameSource === 'user') return { status: 'skipped' };
      return { status: deps.secretary?.draft(id, record, text) === true ? 'taken' : 'skipped' };
    },
    'sessions:complete': async ({ id }) => saying(id, await deps.sessions.complete(id)),
    'sessions:shelve': async ({ id }) => saying(id, await deps.sessions.shelve(id)),
    'sessions:restore': ({ id }) => deps.sessions.restore(id),
    // What a running session is doing, a kind alone (M22e): the page's Remove says it before asking.
    'sessions:doing'({ id }) {
      if (deps.sessions.record(id) === undefined) return refused('unknown-session');
      return { status: 'read', doing: deps.sessions.isRunning(id) ? deps.doing?.(id) ?? 'turn' : null };
    },
    'sessions:move': ({ id, before, group }) => deps.sessions.move(id, before, group),

    async 'sessions:setEffort'({ id, effort }) {
      const record = await changeable(id);
      if ('status' in record) return record;
      // The levels its own instance reports for its model (M14b, C28).
      const model = findModel(catalog(), record, record.model);
      if (!model.efforts.some((level) => level.id === effort)) return refused('effort-not-listed');
      return deps.sessions.setEffort(id, effort);
    },

    async 'sessions:setSpeed'({ id, speed }) {
      const record = await changeable(id);
      if ('status' in record) return record;
      // The tiers its own instance reports for its model, and whether fat-g may ask that account for one (decision 0016).
      const reason = speedCheck(catalogEntry(catalog(), record), findModel(catalog(), record, record.model), speed);
      if (reason !== null) return refused(reason);
      return deps.sessions.setSpeed(id, speed);
    },

    'sessions:remove'({ id, draftOnly }) {
      if (draftOnly === true) {
        const record = deps.sessions.record(id);
        if (record === undefined) return refused('unknown-session');
        const entry = deps.sessions.snapshot().sessions.find((session) => session.record.id === id);
        if (record.reference !== null || record.lastTurn !== null || deps.sessions.isRunning(id) || (entry !== undefined && (inPlan(entry.summary) || entry.planPending === true))) return refused('draft-locked');
      }
      const { removal } = deps;
      if (removal === undefined) return deps.sessions.remove(id).then((answer) => saying(id, answer));
      // What the service would refuse is refused before anything is marked.
      if (deps.records.isRefused()) return refused('records-refused');
      if (deps.sessions.record(id) === undefined) return refused('unknown-session');
      if (deps.sessions.isRunning(id)) return runs(id);
      return removal.run([id], () => deps.sessions.remove(id), (answer) => answer.status === 'saved');
    },

    'sessions:removeOrphans'() {
      const { removal } = deps;
      if (removal === undefined) return deps.sessions.removeOrphans();
      if (deps.records.isRefused()) return refused('records-refused');
      // The ids the entries store, readable or not: their chats go with them (M18, C30).
      return removal.run(deps.records.orphanIds(), () => deps.sessions.removeOrphans(), (answer) => answer.status === 'saved');
    },
  };
}
