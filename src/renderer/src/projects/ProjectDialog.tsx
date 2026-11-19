// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type SyntheticEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { firstInstances } from '@shared/contracts/instances';
import { normalizeName } from '@shared/contracts/names';
import { MODE_WORDS, modeOf } from '@shared/contracts/permissions';
import {
  type AccountFolderConflict,
  type ProjectColor,
  PROJECT_COLORS,
  PROJECT_COLOR_NAMES,
  type ProjectEntryView,
  type ProjectRefusal,
  proposeColor,
  type RootRelation,
  type TrustAnswer,
} from '@shared/contracts/projects';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { CloseIcon } from '../control-bar/icons';
import { invoke } from '../ipc/client';
import { ModeChoice } from '../settings/ModeChoice';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import dialogStyles from '../ui/Dialog.module.css';
import { closeProjectDialog, useProjectDialog } from './project-dialog-store';
import styles from './ProjectDialog.module.css';
import { FAILED_TEXT } from './ProjectList';
import { accountText, relationText, RootRow } from './RootRow';

/**
 * The project dialog: adding and editing use one modal `<dialog>` in the Main window (C36). It
 * behaves like Settings: Tab stays inside, Escape cancels, the focus goes back to whatever opened it,
 * and it fits the minimum window size, scrolling inside itself (C37). Draft changes are sent only at Save, and
 * Cancel drops the draft, which is kept nowhere (C38).
 *
 * Under the providers the project is offered to, each one that declares modes has the project's
 * default mode (M22, C40, C87): Use my default, or one of the provider's modes, saved with the
 * project. It is what a new chat of the project starts under; a chat that exists keeps its own.
 */
export function ProjectDialog() {
  const open = useProjectDialog((state) => state.open);
  const projectId = useProjectDialog((state) => state.projectId);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // However it closed, the store follows and the focus goes back.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    // Only its own: a dialog inside it closing is not this one closing.
    if (event.target !== event.currentTarget) return;
    closeProjectDialog();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
  };

  return (
    <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby={titleId} onClose={onClose}>
      {open && <ProjectForm key={projectId ?? 'new'} projectId={projectId} titleId={titleId} close={(added) => (added === null ? dialog.current?.close() : closeProjectDialog(added))} />}
    </dialog>
  );
}

interface DraftRoot {
  readonly path: string;
  readonly trust: TrustAnswer | null;
  /** The folder's own name, proposed as the project's while the name is untouched (C17). */
  readonly folderName: string | null;
  /** How it stands to an earlier root of the draft, as main last said (C26). */
  readonly conflict: { readonly index: number; readonly relation: RootRelation } | null;
  /** Main refused it: not picked in this run, and not one the project had (C23). */
  readonly notAllowed: boolean;
  /** The added account whose folder it is, or lies inside or around, as main last said (M14b, C58). */
  readonly account?: AccountFolderConflict | null;
}

interface Draft {
  readonly name: string;
  /** Null for a stored colour this build does not know: none is selected, and Save leaves it (C12). */
  readonly color: ProjectColor | null;
  readonly roots: readonly DraftRoot[];
  readonly providers: readonly string[];
  /** The project's default mode for a provider's new chats, by provider id (M22, C40): a provider with none uses the user's own default. */
  readonly permissionModes: Readonly<Record<string, string>>;
}

type Field = 'name' | 'roots' | 'providers';

function firstDraft(project: Extract<ProjectEntryView, { kind: 'project' }> | undefined, used: readonly (string | null)[], providers: readonly ProviderSnapshot[]): Draft {
  if (project === undefined) {
    return { name: '', color: proposeColor(used), roots: [], providers: providers.map((provider) => provider.id), permissionModes: {} };
  }
  return {
    name: project.name,
    color: project.color,
    roots: project.roots.map((root) => ({ path: root.path, trust: root.trust, folderName: null, conflict: null, notAllowed: false })),
    providers: project.providers,
    permissionModes: project.permissionModes,
  };
}

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];

function ProjectForm({ projectId, titleId, close }: { projectId: string | null; titleId: string; close: (added: string | null) => void }) {
  const records = useAppState((state) => state.snapshot?.records);
  // A project is offered to providers, not to accounts (M14b, C30): one choice a provider.
  const providers = firstInstances(useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS));
  const project = records?.projects.find((entry): entry is Extract<ProjectEntryView, { kind: 'project' }> => entry.kind === 'project' && entry.id === projectId);
  const [draft, setDraft] = useState<Draft>(() =>
    firstDraft(project, records?.projects.map((entry) => (entry.kind === 'project' ? entry.color : null)) ?? [], providers),
  );
  const [nameTouched, setNameTouched] = useState(projectId !== null);
  const [checked, setChecked] = useState(false);
  const [refusal, setRefusal] = useState<{ field: Field | 'general'; text: string } | null>(null);
  const [pickProblem, setPickProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLDivElement>(null);
  const ids = { name: useId(), color: useId(), roots: useId(), providers: useId(), root: useId() };

  // The missing marks are fresh when an edit opens (C29): main checks, and the state follows.
  useEffect(() => {
    if (projectId !== null) invoke('projects:checkRoots', { id: projectId }).catch(() => undefined);
  }, [projectId]);

  // An account by its provider's name and the label the user gave it; the label is in the preferences.
  const accounts = usePrefs((state) => state.snapshot?.instances);
  const accountName = (account: AccountFolderConflict): string => {
    const provider = providers.find((candidate) => candidate.id === account.providerId)?.displayName ?? account.providerId;
    const label = accounts?.[account.providerId]?.added.find((entry) => entry.key === account.key)?.label;
    return label == null ? `a ${provider} account` : `the ${provider} account “${label}”`;
  };

  const missing = (path: string): boolean => project?.roots.some((root) => root.path === path && root.missing) ?? false;

  /** Any edit: what main refused before no longer holds. */
  const edit = (next: Draft): void => {
    setDraft(next);
    setRefusal(null);
  };

  /** A change of folders. The first one's name stands in for the project's until the user types one (C17). */
  const change = (next: Draft): void => {
    edit({ ...next, name: nameTouched ? next.name : (next.roots[0]?.folderName ?? '') });
  };

  // ── Faults (C39): shown once Save was pressed, and an overlap as soon as main names it (C26) ──
  const nameFault = normalizeName(draft.name) === '' ? 'Enter a name.' : refusal?.field === 'name' ? refusal.text : null;
  const rootsFault = draft.roots.length === 0 ? 'Add at least one folder.' : null;
  const providersFault = draft.providers.length === 0 ? 'Choose at least one provider.' : refusal?.field === 'providers' ? refusal.text : null;
  const rootFaults = draft.roots.map((root) => [
    ...(root.conflict !== null ? [`${relationText(root.conflict.relation, draft.roots[root.conflict.index]?.path ?? '')}.`] : []),
    ...(root.notAllowed ? ['fat-g cannot use this folder here. Remove it and add it again.'] : []),
    ...(root.account != null ? [accountText(root.account, accountName(root.account))] : []),
    ...(checked && root.trust === null ? ['Answer whether to trust this folder.'] : []),
  ]);
  const shown = (fault: string | null): string | null => (checked ? fault : null);

  const addFolder = async (): Promise<void> => {
    setPickProblem(null);
    try {
      const answer = await invoke('projects:pickFolder', { projectId, roots: draft.roots.map((root) => root.path) });
      switch (answer.status) {
        case 'cancelled':
          return;
        case 'refused':
          setPickProblem(
            answer.reason === 'busy'
              ? 'A folder picker is already open.'
              : answer.reason === 'records-refused'
                ? 'Your projects file cannot be read, so no folder can be added.'
                : 'fat-g cannot use that folder.',
          );
          return;
        case 'picked':
          change({ ...draft, roots: [...draft.roots, { path: answer.path, trust: null, folderName: answer.folderName, conflict: answer.conflict, notAllowed: false, account: answer.account }] });
      }
    } catch {
      setPickProblem('fat-g could not open the folder picker.');
    }
  };

  const removeRoot = (index: number): void => {
    // The overlaps named were against the old list; Save asks main again.
    change({ ...draft, roots: draft.roots.filter((_, at) => at !== index).map((root) => ({ ...root, conflict: null })) });
  };

  /** After the faults render: the first one's control, or the first control inside it. */
  const focusFirstFault = (): void => {
    requestAnimationFrame(() => {
      const fault = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      const control = fault?.matches('input, button') === true ? fault : fault?.querySelector<HTMLElement>('input, button');
      control?.focus();
    });
  };

  const refuse = (answer: ProjectRefusal): void => {
    switch (answer.reason) {
      case 'name-empty':
        setRefusal({ field: 'name', text: 'Enter a name.' });
        break;
      case 'no-provider':
        setRefusal({ field: 'providers', text: 'Choose at least one provider.' });
        break;
      case 'root-not-allowed':
        setDraft((current) => ({ ...current, roots: current.roots.map((root, index) => (index === answer.index ? { ...root, notAllowed: true } : root)) }));
        break;
      case 'root-overlap':
        setDraft((current) => ({
          ...current,
          roots: current.roots.map((root, index) => (index === answer.second ? { ...root, conflict: { index: answer.first, relation: answer.relation } } : root)),
        }));
        break;
      case 'account-folder':
        setDraft((current) => ({ ...current, roots: current.roots.map((root, index) => (index === answer.index ? { ...root, account: answer.account } : root)) }));
        break;
      case 'records-refused':
        setRefusal({ field: 'general', text: 'Your projects file cannot be read, so nothing was saved.' });
        break;
      case 'unknown-project':
        setRefusal({ field: 'general', text: 'This project is no longer in the list, so nothing was saved.' });
        break;
      // Remove's alone (M14, C96): the dialog saves, and a running session refuses no save.
      case 'session-running':
        setRefusal({ field: 'general', text: 'One of its sessions is running, so nothing was saved.' });
        break;
      // Remove's alone too (M18, C42, C63): a removal takes the saved chats with it, and a save takes none.
      case 'conversations-refused':
      case 'storage-failed':
        setRefusal({ field: 'general', text: 'fat-g could not reach its saved chats, so nothing was saved.' });
        break;
    }
    focusFirstFault();
  };

  const save = async (): Promise<void> => {
    setChecked(true);
    const faulty = nameFault !== null || rootsFault !== null || providersFault !== null || rootFaults.some((faults) => faults.length > 0) || draft.roots.some((root) => root.trust === null);
    if (faulty) {
      focusFirstFault();
      return;
    }
    const roots = draft.roots.map((root) => ({ path: root.path, trust: root.trust ?? 'not-trusted' }));
    // The defaults the dialog's controls say (M22, C40): for the providers the project is offered to,
    // each a mode its provider lists. With no such control drawn nothing is said of them, and what is
    // stored stays; with one, a provider left out is Use my default.
    const moded = providers.filter((provider) => provider.descriptor.capabilities.permissions !== null);
    const permissionModes = Object.fromEntries(moded.flatMap((provider) => {
      const mode = draft.providers.includes(provider.id) ? draft.permissionModes[provider.id] : undefined;
      return mode !== undefined && modeOf(provider.descriptor.capabilities.permissions, mode) !== undefined ? [[provider.id, mode] as const] : [];
    }));
    const defaults = moded.length === 0 ? {} : { permissionModes };
    setSaving(true);
    try {
      if (projectId === null) {
        const answer = await invoke('projects:add', { name: draft.name, color: draft.color ?? proposeColor([]), roots, providers: [...draft.providers], ...defaults });
        if (answer.status === 'saved') close(answer.id);
        else refuse(answer);
      } else {
        const answer = await invoke('projects:update', { id: projectId, name: draft.name, ...(draft.color === null ? {} : { color: draft.color }), roots, providers: [...draft.providers], ...defaults });
        if (answer.status === 'saved') close(null);
        else refuse(answer);
      }
    } catch {
      setRefusal({ field: 'general', text: FAILED_TEXT });
    } finally {
      setSaving(false);
    }
  };

  // A project removed meanwhile is still being edited: Save then says it is gone.
  const title = projectId === null ? 'Add project' : `Edit ${project?.name ?? 'project'}`;
  const nameShown = shown(nameFault);
  const providersShown = shown(providersFault);

  return (
    <>
      <header className={dialogStyles.header}>
        <h2 id={titleId} className={dialogStyles.title}>
          {title}
        </h2>
        <button type="button" className={dialogStyles.closeButton} aria-label="Close without saving" onClick={() => close(null)}>
          <CloseIcon />
        </button>
      </header>
      <div ref={form} className={dialogStyles.body}>
        {refusal?.field === 'general' && (
          <p className={dialogStyles.error} role="alert">
            {refusal.text}
          </p>
        )}

        <div className={styles.field}>
          <label htmlFor={ids.name} className={styles.label}>
            Name
          </label>
          <input
            id={ids.name}
            className={styles.text}
            type="text"
            value={draft.name}
            maxLength={1000}
            autoComplete="off"
            aria-invalid={nameShown !== null || undefined}
            aria-describedby={nameShown !== null ? `${ids.name}-fault` : undefined}
            onChange={(event) => {
              setNameTouched(true);
              setDraft({ ...draft, name: event.target.value });
              setRefusal(null);
            }}
          />
          {nameShown !== null && (
            <p id={`${ids.name}-fault`} className={styles.fault}>
              {nameShown}
            </p>
          )}
        </div>

        <fieldset className={styles.field} hidden>
          <legend className={styles.label}>Colour</legend>
          <div className={styles.colors}>
            {PROJECT_COLORS.map((color) => (
              <label key={color} className={styles.colorChoice}>
                <input type="radio" name={ids.color} checked={draft.color === color} onChange={() => setDraft({ ...draft, color })} />
                <span className={styles.swatch} data-color={color} aria-hidden="true" />
                {PROJECT_COLOR_NAMES[color]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.field} aria-describedby={shown(rootsFault) !== null ? `${ids.roots}-fault` : undefined}>
          <legend className={styles.label}>Folders</legend>
          {draft.roots.length > 0 && (
            <ul className={styles.roots}>
              {draft.roots.map((root, index) => (
                <RootRow
                  // The same folder picked twice is two rows until main's answer says so.
                  key={`${index}:${root.path}`}
                  path={root.path}
                  trust={root.trust}
                  missing={missing(root.path)}
                  faults={rootFaults[index] ?? []}
                  faultId={`${ids.root}-${index}`}
                  onTrust={(trust) => edit({ ...draft, roots: draft.roots.map((item, at) => (at === index ? { ...item, trust } : item)) })}
                  onRemove={() => removeRoot(index)}
                  onOpen={async () => { await invoke('projects:openFolder', { projectId, path: root.path }); }}
                />
              ))}
            </ul>
          )}
          <button type="button" className={styles.smallButton} onClick={() => void addFolder()} aria-invalid={shown(rootsFault) !== null || undefined}>
            Add folder…
          </button>
          {shown(rootsFault) !== null && (
            <p id={`${ids.roots}-fault`} className={styles.fault}>
              {rootsFault}
            </p>
          )}
          {pickProblem !== null && <p className={styles.fault}>{pickProblem}</p>}
        </fieldset>

        <fieldset className={styles.field} aria-describedby={providersShown !== null ? `${ids.providers}-fault` : undefined}>
          <legend className={styles.label}>Providers</legend>
          <div className={styles.providers}>
            {providers.map((provider, index) => (
              <label key={provider.id} className={styles.choice}>
                <input
                  type="checkbox"
                  checked={draft.providers.includes(provider.id)}
                  aria-invalid={(index === 0 && providersShown !== null) || undefined}
                  onChange={(event) =>
                    edit({
                      ...draft,
                      providers: event.target.checked
                        ? providers.map((item) => item.id).filter((id) => id === provider.id || draft.providers.includes(id))
                        : draft.providers.filter((id) => id !== provider.id),
                    })
                  }
                />
                {provider.displayName}
              </label>
            ))}
          </div>
          <p className={styles.hint}>fat-g offers this project to these providers. Their switches in Settings stay as they are.</p>
          {/* A default for each provider the project is offered to (M22, C40): a provider's word, with nothing of an account (C43). */}
          {providers.map((provider) => {
            const permissions = provider.descriptor.capabilities.permissions;
            if (permissions === null || !draft.providers.includes(provider.id)) return null;
            return (
              <ModeChoice
                key={provider.id}
                legend={`${provider.displayName}: ${MODE_WORDS.defaultMode.toLowerCase()} for this project`}
                capability={permissions}
                value={draft.permissionModes[provider.id] ?? null}
                none="use-default"
                disabled={saving}
                onChange={(mode) => {
                  const { [provider.id]: _dropped, ...others } = draft.permissionModes;
                  edit({ ...draft, permissionModes: mode === null ? others : { ...others, [provider.id]: mode } });
                }}
              />
            );
          })}
          {providersShown !== null && (
            <p id={`${ids.providers}-fault`} className={styles.fault}>
              {providersShown}
            </p>
          )}
        </fieldset>
      </div>
      <footer className={dialogStyles.footer}>
        <button type="button" className={dialogStyles.button} disabled={saving} onClick={() => close(null)}>
          Cancel
        </button>
        <button type="button" className={dialogStyles.button} disabled={saving} onClick={() => void save()}>
          Save
        </button>
      </footer>
    </>
  );
}
