// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from 'react';
import { preselectPreset, presetOffer, type ModelPreset } from '@shared/contracts/presets';
import { orderedPresetIds, savedPresetProblem } from '@shared/contracts/saved-presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import { ChatArea } from '../chat/ChatArea';
import { focusPrompt } from '../chat/prompt-focus';
import { invoke } from '../ipc/client';
import type { ProjectView } from '../session-area/selected';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { openSettings } from '../settings/settings-store';
import { createNewSession, finishNewSession, useNewSession } from './new-session-store';
import { ModelPickerPopup } from './ModelPickerPopup';
import { PresetsCarousel } from '../model-chooser/PresetsCarousel';
import { RecentModels } from '../model-chooser/RecentModels';
import { DraftModelButton } from './DraftModelButton';
import { NewChatHeading } from './NewChatHeading';
import styles from './NewChat.module.css';

/**
 * A draft no turn has run, from the `+` visit that creates it to its first accepted Send, sharing the
 * ordinary chat's draft, input and sending path. `draftId` is null while the visit's is created.
 */
export function NewChatScreen({ project, draftId }: { readonly project: ProjectView; readonly draftId: string | null }) {
  const opening = useNewSession();
  const app = useAppState((state) => state.snapshot);
  const prefs = usePrefs((state) => state.snapshot?.values);
  const entry = app?.sessions?.sessions.find((session) => session.record.id === draftId);
  const initial = preselectPreset({ catalog: app?.catalog, offer: presetOffer(project.providers, app?.providers ?? []), projectId: project.id, sessions: app?.sessions?.sessions.map((session) => session.record) ?? [] });
  const selected = entry?.record ?? initial;
  const preset: ModelPreset | null = selected === null ? null : { providerId: selected.providerId, instanceId: selected.instanceId, model: selected.model, effort: selected.effort, speed: selected.speed };
  const presets = prefs?.presets ?? {};
  const savedPreset = preset === null ? undefined : orderedPresetIds(presets, prefs?.presetRecency ?? [])
    .map((id) => presets[id]).find((saved) => saved !== undefined && modelSelectionKey(saved) === modelSelectionKey(preset));
  const selectionProblem = preset === null ? null : !project.providers.includes(preset.providerId) ? 'This project is not set up for this provider.' : savedPresetProblem(preset, app?.catalog, app?.providers ?? []);
  const button = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState(false);
  const [changing, setChanging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = opening.creating || changing || entry?.changingMode === true;
  const closePicker = useCallback(() => setPicker(false), []);

  useEffect(() => {
    if (draftId === null && opening.projectId === project.id && !opening.creating && opening.problem === null && initial !== null) void createNewSession(initial);
  }, [initial, draftId, project.id, opening.projectId, opening.creating, opening.problem]);

  const apply = async (choice: ModelPreset, savedId?: string): Promise<boolean> => {
    if (busy) return false;
    // Records and named presets carry other fields; the IPC accepts only the five selection keys.
    const selection: ModelPreset = { providerId: choice.providerId, instanceId: choice.instanceId, model: choice.model, effort: choice.effort, speed: choice.speed };
    setChanging(true);
    setProblem(null);
    try {
      const applied = draftId === null ? await createNewSession(selection)
        : (await invoke('sessions:setDraftPreset', { id: draftId, preset: selection })).status === 'saved';
      if (!applied) { setProblem('This selection could not be applied. Your draft is still here.'); return false; }
      if (savedId !== undefined) await patchPrefs({ usePreset: savedId });
      const current = useNewSession.getState();
      const id = draftId ?? (current.serial === opening.serial ? current.sessionId : null);
      if (id !== null) focusPrompt(id, true);
      return true;
    } catch { setProblem('fat-g could not apply this selection. Try again.'); return false; }
    finally { setChanging(false); }
  };

  const modelButton = initial === null ? null : <DraftModelButton anchor={button} preset={preset} busy={busy} expanded={picker} onOpen={() => setPicker(true)} />;

  return <main className={styles.screen} aria-label={`New chat in ${project.name}`} data-new-chat-screen="">
    <NewChatHeading name={project.name} />
    <hr className={styles.rule} />
    {initial === null && <p role="status">No models detected. Open <button type="button" className={styles.preferencesLink} onClick={() => openSettings({ section: 'accounts' })}>Preferences</button> to set up or refresh your accounts.</p>}
    {entry === undefined ? initial !== null && <div className={styles.waiting}>{modelButton}<p role="status">{opening.problem ?? 'Preparing your draft…'}</p></div>
      : <ChatArea entry={entry} startModel={modelButton} startPresetName={savedPreset?.name} startBusy={busy || preset === null || selectionProblem !== null} onStarted={() => finishNewSession(entry.record.id)} />}
    {entry !== undefined && initial !== null && selectionProblem !== null && <p role="status">{selectionProblem} Choose another model to send.</p>}
    {problem !== null && <p role="alert">{problem}</p>}
    {picker && initial !== null && <ModelPickerPopup project={project} anchor={button} value={preset} onApply={apply} onClose={closePicker} />}
    <PresetsCarousel providers={project.providers} busy={busy} selection={preset} onChoose={apply} onEdit={() => openSettings({ section: 'presets' })} />
    <RecentModels className={styles.recentSettings} providers={project.providers} busy={busy} selection={preset} onChoose={apply} />
    <hr className={`${styles.rule} ${styles.lowerRule}`} />
  </main>;
}
