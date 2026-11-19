// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The project channels (docs/planning/_archive/M12.md, Design 5 and 7). What the page sends is checked here,
// in this order, before a change reaches the store's queue: the providers must be registered, every
// root must be one main's own folder picker returned in this run or one the project's saved record
// already holds (C23), and the request's own roots must not overlap (C25, C26).
//
// The C23 check comes before any lookup, so a path the page made up never reaches the file system.
// Roots of different projects are never compared: one folder may belong to two projects (C27).
import { normalizeName } from '@shared/contracts/names';
import type { AccountFolderConflict, ProjectRefusal, ProjectRootRequest, ProjectSaved } from '@shared/contracts/projects';
import type { Lookups } from '../../records/lookup';
import { firstOverlap, folderName, normalizeRoot, overlapWith } from '../../records/paths';
import type { RecordsStore } from '../../records/store';
import type { Removal } from '../../sessions/removal';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';
import { shownNotOpened } from './files';

export interface ProjectHandlerDeps {
  readonly records: RecordsStore;
  readonly lookups: Lookups;
  /** Whether a provider is registered in this build. */
  readonly hasProvider: (providerId: string) => boolean;
  /** The OS folder picker — or, in a smoke build, its stand-in (C55). Null when cancelled. */
  readonly pickFolder: () => Promise<string | null>;
  /** The same file-manager actions used for a folder reference; never open a file or launch a bundle. */
  readonly openFolder: (path: string) => Promise<string>;
  readonly showInFolder: (path: string) => void;
  /** Checks these roots for a missing folder, after the request has answered (C29). */
  readonly checkRoots: (roots: readonly string[]) => void;
  /** Whether one of a project's sessions is in a turn, or waiting on its workers (M14, C96, C114). */
  readonly sessionRunning?: (projectId: string) => boolean;
  /**
   * A removal, with the project's sessions marked as leaving for as long as it is written (M15,
   * C109): the check for a running session and the marks are one step, so a prompt sent while the
   * removal is under way is refused. Null when one of the sessions runs. Given, it stands for
   * `sessionRunning` at Remove.
   */
  readonly removing?: <T>(projectId: string, write: () => Promise<T>) => Promise<T> | null;
  /**
   * The folders of the accounts the user added, by provider and key (M14b, C58). A CLI keeps an
   * account's login in its folder, so no project's root may be one, or lie inside or around one. The
   * first account's folder is not among them: a project at the home folder already holds it, and
   * that arrangement is the user's.
   */
  readonly accountFolders?: () => readonly { readonly providerId: string; readonly key: string; readonly folder: string }[];
  /**
   * A project's removal takes its sessions' saved chats with their records (M18, C21): marked,
   * removed, then deleted, and refused while the conversation store is (C42). Without it only the
   * records go.
   */
  readonly removal?: Pick<Removal, 'run'>;
  /** Whether a provider's descriptor lists a mode of this id (M22, C40, C43). Without it every id is taken as listed. */
  readonly hasMode?: (providerId: string, mode: string) => boolean;
  /**
   * A project's plans go with it (M22b, C62, C73): every decision waiting on them settled first, then
   * the plan store's mark naming the project and its plans, written whole before the records' write;
   * the mark lifted where that write did not land, and otherwise the plans deleted, the mark last.
   * Without it a project's plans stay.
   */
  readonly plans?: {
    settle(projectId: string): Promise<number>;
    mark(projectId: string): void;
    lift(projectId: string): void;
    finish(projectId: string): void;
  };
  readonly platform?: string;
}

type Channels =
  | 'projects:pickFolder'
  | 'projects:openFolder'
  | 'projects:add'
  | 'projects:update'
  | 'projects:setHidden'
  | 'projects:setCollapsed'
  | 'projects:move'
  | 'projects:remove'
  | 'projects:checkRoots';

export function projectHandlers(deps: ProjectHandlerDeps): Pick<InvokeHandlers, Channels> {
  const platform = deps.platform ?? process.platform;
  /** The folders the picker returned in this run, normalized. Memory only (C23). */
  const picked = new Set<string>();
  const wasPicked = (root: string): boolean => picked.has(root);
  let pickerOpen = false;

  const registered = (providers: readonly string[]): void => {
    if (!providers.every((id) => deps.hasProvider(id))) throw new InvalidIpcRequest();
  };

  /**
   * A project's default modes as they are saved (M22, C40, C43): each for a registered provider, and
   * a mode that provider's descriptor lists — the page offers no other, and one that is not is
   * left out, since no default is ever a mode its provider does not have.
   */
  function listedModes(modes: Readonly<Record<string, string>>): Record<string, string> {
    registered(Object.keys(modes));
    return Object.fromEntries(Object.entries(modes).filter(([providerId, mode]) => deps.hasMode?.(providerId, mode) !== false));
  }

  /** What add and update check before a lookup: the records, the name, a provider, and C23. */
  function precheck(
    name: string,
    roots: readonly ProjectRootRequest[],
    providers: readonly string[],
    allowed: (root: string) => boolean,
  ): ProjectRefusal | { readonly name: string } {
    registered(providers);
    if (deps.records.isRefused()) return { status: 'refused', reason: 'records-refused' };
    const normalized = normalizeName(name);
    if (normalized === '') return { status: 'refused', reason: 'name-empty' };
    if (providers.length === 0) return { status: 'refused', reason: 'no-provider' };
    const index = roots.findIndex((root) => !allowed(root.path));
    if (index !== -1) return { status: 'refused', reason: 'root-not-allowed', index };
    return { name: normalized };
  }

  /** How a root stands to an added account's folder, on the real paths as two roots are compared; null when apart from all. */
  async function accountOf(root: string): Promise<AccountFolderConflict | null> {
    const accounts = deps.accountFolders?.() ?? [];
    if (accounts.length === 0) return null;
    const found = await overlapWith(accounts.map((account) => account.folder), root, platform, deps.lookups);
    const account = found === null ? undefined : accounts[found.index];
    return found === null || account === undefined ? null : { providerId: account.providerId, key: account.key, relation: found.relation };
  }

  /** The first of these roots that an account's folder refuses (C58). */
  async function accountRefusal(roots: readonly ProjectRootRequest[], exempt: (root: string) => boolean = () => false): Promise<ProjectRefusal | null> {
    for (const [index, root] of roots.entries()) {
      if (exempt(root.path)) continue;
      const account = await accountOf(root.path);
      if (account !== null) return { status: 'refused', reason: 'account-folder', index, account };
    }
    return null;
  }

  async function overlap(roots: readonly ProjectRootRequest[]): Promise<ProjectRefusal | null> {
    const found = await firstOverlap(roots.map((root) => root.path), platform, deps.lookups);
    return found === null ? null : { status: 'refused', reason: 'root-overlap', ...found };
  }

  return {
    async 'projects:openFolder'({ projectId, path }) {
      if (deps.records.isRefused()) throw new InvalidIpcRequest();
      const folder = normalizeRoot(path, platform);
      const project = projectId === null ? undefined : deps.records.getProject(projectId);
      if (projectId !== null && project === undefined) throw new InvalidIpcRequest();
      if (folder === null || (!wasPicked(folder) && !project?.roots.some((root) => normalizeRoot(root.path, platform) === folder))) throw new InvalidIpcRequest();
      // Admission comes before the lookup: no renderer-invented path reaches the file system.
      if (await deps.lookups.folder(folder) !== 'present') throw new InvalidIpcRequest();
      const real = await deps.lookups.realpath(folder);
      if (real === null) throw new InvalidIpcRequest();
      let opened = false;
      try {
        // The resolved name matters too: a symlink may lead to a macOS application bundle.
        if (shownNotOpened(real, platform)) { deps.showInFolder(real); opened = true; }
        else opened = await deps.openFolder(real) === '';
      } catch { /* Native errors may contain a private path; report only the fixed failure below. */ }
      if (!opened) throw new Error('the project folder could not be opened');
      return null;
    },
    async 'projects:pickFolder'({ projectId, roots }) {
      if (deps.records.isRefused()) return { status: 'refused', reason: 'records-refused' };
      if (pickerOpen) return { status: 'refused', reason: 'busy' };
      pickerOpen = true;
      let selected: string | null;
      try {
        selected = await deps.pickFolder();
      } finally {
        pickerOpen = false;
      }
      if (selected === null) return { status: 'cancelled' };
      const path = normalizeRoot(selected, platform);
      if (path === null) return { status: 'refused', reason: 'unsupported-path' };
      picked.add(path);
      // Compared with the draft's roots that C23 admits, so the reason shows as soon as the folder is
      // picked; Save checks again. The others would be refused at Save, and are never looked up.
      const saved = new Set(projectId === null ? [] : deps.records.getProject(projectId)?.roots.map((root) => root.path) ?? []);
      const admitted = roots.flatMap((root, index) => (picked.has(root) || saved.has(root) ? [{ root, index }] : []));
      const found = await overlapWith(admitted.map(({ root }) => root), path, platform, deps.lookups);
      const conflict = found === null ? null : { index: admitted[found.index]?.index ?? found.index, relation: found.relation };
      return { status: 'picked', path, folderName: folderName(path, platform), conflict, account: await accountOf(path) };
    },

    async 'projects:add'({ name, color, roots, providers, permissionModes }) {
      const checked = precheck(name, roots, providers, wasPicked);
      if ('status' in checked) return checked;
      const refusal = await overlap(roots) ?? await accountRefusal(roots);
      if (refusal !== null) return refusal;
      return deps.records.add({ name: checked.name, color, roots, providers, ...(permissionModes === undefined ? {} : { permissionModes: listedModes(permissionModes) }) }, wasPicked);
    },

    async 'projects:update'({ id, name, color, roots, providers, permissionModes }) {
      const saved = deps.records.getProject(id);
      if (saved === undefined && !deps.records.isRefused()) {
        registered(providers);
        return { status: 'refused', reason: 'unknown-project' };
      }
      const savedRoots = new Set(saved?.roots.map((root) => root.path) ?? []);
      const checked = precheck(name, roots, providers, (root) => wasPicked(root) || savedRoots.has(root));
      if ('status' in checked) return checked;
      // A root the project already had is left as it is: only a root this change brings is refused (C58).
      const refusal = await overlap(roots) ?? await accountRefusal(roots, (root) => savedRoots.has(root));
      if (refusal !== null) return refusal;
      return deps.records.update(id, { name: checked.name, ...(color === undefined ? {} : { color }), roots, providers, ...(permissionModes === undefined ? {} : { permissionModes: listedModes(permissionModes) }) }, wasPicked);
    },

    'projects:setHidden': ({ id, hidden }) => deps.records.setHidden(id, hidden),
    'projects:setCollapsed': ({ id, collapsed }) => deps.records.setCollapsed(id, collapsed),
    'projects:move': ({ id, hidden, before }) => deps.records.move(id, hidden, before),
    'projects:remove'({ key }) {
      // Refused while one of its sessions runs, whatever the page showed (M14, C96). An entry fat-g
      // cannot read has no session with a summary, so none of its sessions runs.
      const entry = deps.records.getView().projects.find((candidate) => candidate.key === key);
      const write = (): Promise<ProjectSaved | ProjectRefusal> => {
        if (entry?.kind === 'project' && deps.removing !== undefined) {
          return deps.removing(entry.id, () => deps.records.remove(key)) ?? Promise.resolve({ status: 'refused', reason: 'session-running' });
        }
        if (entry?.kind === 'project' && deps.sessionRunning?.(entry.id) === true) return Promise.resolve({ status: 'refused', reason: 'session-running' });
        return deps.records.remove(key);
      };
      const { removal } = deps;
      if (removal === undefined) return write();
      if (deps.records.isRefused()) return { status: 'refused', reason: 'records-refused' };
      if (entry?.kind === 'project' && deps.sessionRunning?.(entry.id) === true) return { status: 'refused', reason: 'session-running' };
      // The sessions its removal takes, by the ids the file stores: their chats go with them (M18, C21, C30).
      const projectId = entry?.kind === 'project' ? entry.id : null;
      const { plans } = deps;
      if (plans === undefined || projectId === null) return removal.run(deps.records.sessionIdsTaken(key), write, (answer) => answer.status === 'saved');
      return (async () => {
        // Its plans' decisions first (C73), then its mark, whole, before anything else is written (C62).
        await plans.settle(projectId);
        try { plans.mark(projectId); } catch { return { status: 'refused' as const, reason: 'storage-failed' as const }; }
        const answer = await removal.run(deps.records.sessionIdsTaken(key), write, (saved) => saved.status === 'saved').catch((error: unknown) => { plans.lift(projectId); throw error; });
        try { if (answer.status === 'saved') plans.finish(projectId); else plans.lift(projectId); } catch { /* the next launch finishes or lifts it */ }
        return answer;
      })();
    },

    'projects:checkRoots'({ id }) {
      const project = deps.records.getProject(id);
      if (project !== undefined) deps.checkRoots(project.roots.map((root) => root.path));
      return null;
    },
  };
}
