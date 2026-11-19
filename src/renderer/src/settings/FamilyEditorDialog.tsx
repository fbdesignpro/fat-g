// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import type { AddAvatarAnswer, AvatarDraft, FamilyDraft, FamilyLock, FamilySource, SaveFamilyAnswer } from '@shared/contracts/avatar-family';
import { avatarLayers, MARKED_EFFORTS, NO_LABEL, type OverlayLayer, overridesOf, sameOverlay } from '@shared/contracts/avatar-overlay';
import { type AvatarListing, avatarProblemWords, type AvatarRole, type AvatarView, type FamilyRef, type FamilyView, defaultFolderOf, isMatchKey, LICENSE_FILE, MANIFEST_FILE, type MatchEntry, matchView, matchViewText } from '@shared/contracts/avatars';
import type { CatalogProvider } from '@shared/contracts/catalog';
import { firstInstances } from '@shared/contracts/instances';
import { providerTiles } from '@shared/contracts/presets';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { CloseIcon } from '../control-bar/icons';
import { invoke } from '../ipc/client';
import { Avatar } from '../sessions/Avatar';
import { useAppState } from '../state/store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import dialogStyles from '../ui/Dialog.module.css';
import { AddAvatarDialog, type AddedImage } from './AddAvatarDialog';
import { refusalWords } from './avatar-image-words';
import { AvatarDropZone } from './AvatarDropZone';
import { AvatarFamilyGuide } from './AvatarFamilyGuide';
import { type ImageRefused, prepareAvatarImage, prepareSmallImage } from './avatar-image';
import { AvatarImageRow, type ImageActions } from './AvatarImageRow';
import { familyMatch, resolvedOf, sampleLabel, styledOf } from './avatar-listing';
import { EDITOR_WORDS } from './family-editor-words';
import { keyOf, MatchEditor } from './MatchEditor';
import { useSettingsDialog } from './settings-dialog';
import styles from './Settings.module.css';
import { StyleControls } from './StyleControls';

export { EDITOR_WORDS };

export interface FamilyEditorDialogProps {
  /** The family edited; null while the editor is closed. */
  readonly family: FamilyRef | null;
  /** The listing the tab last read: the avatars' files. */
  readonly listing: AvatarListing | null;
  /** Told after a save, once main has scanned again. */
  readonly onSaved: () => void;
  readonly onCopied: (ref: FamilyRef, listing: AvatarListing) => void;
  /** Told after Add avatar or an image replaced, with the listing that holds it (decision 0036). */
  readonly onListed: (listing: AvatarListing) => void;
  readonly onClose: () => void;
}

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];

/**
 * The family editor (decisions 0031, 0032, 0036): a family's `family.json` as a draft, in three
 * columns. At the left the Family default's row, then its avatars, the ones the file lists with no
 * folder after them, each with its match entries, and under them Add avatar's drop zone. Beside them
 * the chosen row: its name, its preview, the model and effort it is previewed with, and for an avatar
 * its matches. At the right the chosen row's style of the version and the effort marks: the Default
 * style, or an avatar's Overrides, each field it sets highlighted with its way back to the default; the
 * default is shown on the family's face, the avatar its models fall back to. Nothing of the draft is
 * written before Save family, which sends main the draft and the revision it was made from; Cancel,
 * Escape and the close button ask before dropping changes. Add avatar alone writes at once, as Make a
 * copy does. A family fat-g may not write opens read-only, saying why.
 */
export function FamilyEditorDialog({ family, listing, onSaved, onCopied, onListed, onClose }: FamilyEditorDialogProps) {
  const titleId = useId();
  const { dialog, onDialogClose } = useSettingsDialog(family !== null, onClose);
  /** Whether closing would drop changes: the editor asks first, and the close waits. */
  const guardRef = useRef<(() => boolean) | null>(null);
  return (
    <dialog
      ref={dialog}
      className={dialogStyles.dialog}
      aria-labelledby={titleId}
      onClose={onDialogClose}
      onCancel={(event) => { if (event.target === event.currentTarget && guardRef.current?.() === true) event.preventDefault(); }}
      data-family-editor={family?.family}
    >
      {family !== null && (
        <Editor key={`${family.origin}/${family.family}`} family={family} listing={listing} titleId={titleId} guardRef={guardRef} onSaved={onSaved} onCopied={onCopied} onListed={onListed} onDone={() => dialog.current?.close()} />
      )}
    </dialog>
  );
}

/** The listing's family of a reference. */
function listedFamily(listing: AvatarListing | null, ref: FamilyRef): FamilyView | undefined {
  return listing?.roots.find((root) => root.origin === ref.origin)?.families.find((candidate) => candidate.folder === ref.family);
}

/**
 * The family as the draft would make it, for its previews and its account of matches: present avatars
 * alone, its `Default` folder first, then the others in the draft's order.
 */
function draftFamily(listed: FamilyView, draft: FamilyDraft): FamilyView {
  const views = new Map(listed.avatars.map((view) => [view.folder, view]));
  const avatars = draft.avatars.flatMap((avatar): AvatarView[] => {
    const view = views.get(avatar.folder);
    if (view === undefined) return [];
    const matches = avatar.matches.filter((entry) => isMatchKey(typeof entry === 'string' ? entry : entry.key)).map(matchView);
    return [{ ...view, matches, fallback: false, overlay: avatar.overlay }];
  });
  const own = defaultFolderOf(listed.avatars.map((view) => view.folder));
  const defaultView = listed.avatars.find((view) => view.folder === own);
  return { ...listed, provider: draft.provider, avatars: defaultView === undefined ? avatars : [defaultView, ...avatars], overlay: draft.overlay };
}

/** A layer with its empty parts dropped, as main writes it. */
function cleanLayer(layer: OverlayLayer): OverlayLayer {
  const keep = (part: object | undefined): boolean => part !== undefined && Object.keys(part).length > 0;
  return { ...(keep(layer.version) ? { version: layer.version } : {}), ...(keep(layer.effort) ? { effort: layer.effort } : {}) };
}

/**
 * The draft with each avatar's overrides alone: a field an avatar's style shares with the Default style
 * overrides nothing, so a change of the Default style that comes to agree with one ends it.
 */
function withOverrides(draft: FamilyDraft): FamilyDraft {
  return { ...draft, avatars: draft.avatars.map((avatar) => ({ ...avatar, overlay: overridesOf(avatar.overlay, [draft.overlay]) })) };
}

function cleanDraft(draft: FamilyDraft): FamilyDraft {
  return { ...withOverrides(draft), overlay: cleanLayer(draft.overlay) };
}


/** The PNGs an image makes for one of an avatar's images: its main image with its small version, or its small alone. */
async function imagesFor(role: AvatarRole, file: File): Promise<{ readonly kind: 'prepared'; readonly portrait: Uint8Array<ArrayBuffer> | null; readonly small: Uint8Array<ArrayBuffer> } | ImageRefused> {
  if (role === 'small') {
    const prepared = await prepareSmallImage(file);
    return prepared.kind === 'refused' ? prepared : { kind: 'prepared', portrait: null, small: prepared.small };
  }
  const prepared = await prepareAvatarImage(file);
  return prepared.kind === 'refused' ? prepared : { kind: 'prepared', portrait: prepared.portrait, small: prepared.small };
}

/** Why a family may not be written, in words. */
function lockWords(lock: FamilyLock): string {
  return lock.kind === 'manifest' ? avatarProblemWords({ kind: 'manifest', path: 'family.json', cause: lock.cause, field: lock.field }) : EDITOR_WORDS.locks[lock.kind];
}

/** The family default: its `Default` folder, which wears the Default style and which a model nothing matches shows. */
function defaultViewOf(shown: FamilyView): AvatarView | undefined {
  const own = defaultFolderOf(shown.avatars.map((view) => view.folder));
  return shown.avatars.find((view) => view.folder === own);
}

/** The editor's content: made afresh at each opening, from the file as main reads it. */
function Editor({ family, listing, titleId, guardRef, onSaved, onCopied, onListed, onDone }: {
  readonly family: FamilyRef;
  readonly listing: AvatarListing | null;
  readonly titleId: string;
  readonly guardRef: RefObject<(() => boolean) | null>;
  readonly onSaved: () => void;
  readonly onCopied: (ref: FamilyRef, listing: AvatarListing) => void;
  readonly onListed: (listing: AvatarListing) => void;
  readonly onDone: () => void;
}) {
  const baseId = useId();
  const snapshots = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const providers = firstInstances(snapshots);
  /** Each provider's first account's models: what the previews and the account of matches read. */
  const entries = providers.flatMap((provider) => catalog?.providers.find((entry) => entry.id === provider.id) ?? []);
  const [source, setSource] = useState<FamilySource | 'reading' | 'unread' | 'gone'>('reading');
  const [draft, setDraft] = useState<FamilyDraft | null>(null);
  /** The avatar chosen by its folder; null for the Family default's row, where the editor opens. */
  const [selected, setSelected] = useState<string | null>(null);
  const [previewModel, setPreviewModel] = useState('');
  const [previewEffort, setPreviewEffort] = useState('medium');
  const [answer, setAnswer] = useState<SaveFamilyAnswer | null>(null);
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [folderFailed, setFolderFailed] = useState(false);
  const [asking, setAsking] = useState<'discard' | 'reload' | 'copy' | null>(null);
  const [read, setRead] = useState(0);
  /** Add avatar (decision 0036): an image being made ready, the one its popup adds, and why one was refused. */
  const [preparing, setPreparing] = useState(false);
  const [adding, setAdding] = useState<AddedImage | null>(null);
  const [dropProblem, setDropProblem] = useState<string | null>(null);
  /** An avatar's image being replaced, and why one was refused, by its folder (decision 0036). */
  const [replacing, setReplacing] = useState<{ readonly folder: string; readonly role: AvatarRole } | null>(null);
  const [imageProblem, setImageProblem] = useState<{ readonly folder: string; readonly words: string } | null>(null);

  useEffect(() => {
    let live = true;
    invoke('avatars:family', family).then(
      (answered) => {
        if (!live) return;
        setSource(answered ?? 'gone');
        setDraft(answered == null ? null : withOverrides(answered.draft));
        setAnswer(null);
        // A Reload keeps the row chosen where the file still holds it.
        setSelected((before) => (answered?.draft.avatars.some((avatar) => avatar.folder === before) === true ? before : null));
      },
      () => { if (live) setSource('unread'); },
    );
    return () => { live = false; };
  }, [family, read]);

  const loaded = typeof source === 'string' ? null : source;
  const dirty = loaded !== null && draft !== null && JSON.stringify(cleanDraft(draft)) !== JSON.stringify(cleanDraft(loaded.draft));
  useEffect(() => {
    guardRef.current = () => {
      if (copying) return true;
      if (!dirty) return false;
      setAsking('discard');
      return true;
    };
    return () => { guardRef.current = null; };
  }, [dirty, copying, guardRef]);
  const close = (): void => { if (guardRef.current?.() !== true) onDone(); };

  const listed = listedFamily(listing, family);
  const locked = loaded?.lock != null;
  const disabled = locked || saving || copying;
  const badPatterns = draft?.avatars.some((avatar) => avatar.matches.some((entry) => !isMatchKey(keyOf(entry)))) ?? false;

  const update = (change: (before: FamilyDraft) => FamilyDraft): void => setDraft((before) => (before === null ? before : withOverrides(change(before))));
  const updateAvatar = (folder: string, change: (before: AvatarDraft) => AvatarDraft): void => update((before) => ({ ...before, avatars: before.avatars.map((avatar) => (avatar.folder === folder ? change(avatar) : avatar)) }));

  const save = (): void => {
    if (loaded === null || draft === null) return;
    setSaving(true);
    setAnswer(null);
    invoke('avatars:saveFamily', { ref: family, revision: loaded.revision, draft: cleanDraft(draft) }).then(
      (result) => {
        setSaving(false);
        if (result.kind !== 'saved') { setAnswer(result); return; }
        // Saved: nothing is left to lose, and the tab reads the listing again.
        guardRef.current = null;
        onSaved();
        onDone();
      },
      () => { setSaving(false); setAnswer({ kind: 'failed' }); },
    );
  };

  const copyFamily = (): void => {
    if (copying || saving) return;
    setCopying(true);
    setCopyFailed(false);
    invoke('avatars:copyFamily', family).then(
      (result) => {
        if (result.kind === 'copied') {
          guardRef.current = null;
          onCopied(result.ref, result.listing);
        } else { setCopying(false); setCopyFailed(true); }
      },
      () => { setCopying(false); setCopyFailed(true); },
    );
  };

  const makeCopy = (): void => {
    if (dirty) { setAsking('copy'); return; }
    copyFamily();
  };

  const takeImage = (file: File): void => {
    if (preparing) return;
    setPreparing(true);
    setDropProblem(null);
    prepareAvatarImage(file).then(
      (prepared) => {
        setPreparing(false);
        if (prepared.kind === 'prepared') setAdding({ file: file.name, prepared });
        else setDropProblem(refusalWords(prepared));
      },
      () => { setPreparing(false); setDropProblem(EDITOR_WORDS.imageRefusals.unreadable); },
    );
  };

  /**
   * An avatar's main image with its small version, or its small alone, replaced by an image the user
   * dropped or chose: made ready here, written by main at once, the old files to the system's trash.
   */
  const replaceImage = (folder: string, role: AvatarRole, file: File): void => {
    if (replacing !== null) return;
    setReplacing({ folder, role });
    setImageProblem(null);
    const refused = (words: string): void => { setReplacing(null); setImageProblem({ folder, words }); };
    void (async () => {
      try {
        const images = await imagesFor(role, file);
        if (images.kind === 'refused') { refused(refusalWords(images)); return; }
        const result = await invoke('avatars:replaceImage', { ref: family, avatar: folder, portrait: images.portrait, small: images.small });
        if (result.kind === 'replaced') { setReplacing(null); onListed(result.listing); return; }
        refused(result.kind === 'locked' ? lockWords(result.lock) : EDITOR_WORDS.images.answers[result.kind]);
      } catch {
        refused(EDITOR_WORDS.images.answers.failed);
      }
    })();
  };
  const imageActions = (folder: string): ImageActions => ({
    editable: !disabled,
    busy: replacing !== null,
    replacing: replacing?.folder === folder ? replacing.role : null,
    problem: imageProblem?.folder === folder ? imageProblem.words : null,
    onFile: (role, file) => replaceImage(folder, role, file),
    onProblem: (words) => setImageProblem({ folder, words }),
  });

  /** Added and scanned: the file as main read it again, the draft's other changes kept, the new avatar chosen. */
  const added = (result: Extract<AddAvatarAnswer, { readonly kind: 'added' }>, matches: readonly MatchEntry[]): void => {
    const entry = result.source.draft.avatars.find((avatar) => avatar.folder === result.folder) ?? { folder: result.folder, matches, overlay: {} };
    setSource(result.source);
    setDraft((before) => withOverrides(before === null ? result.source.draft : { ...before, avatars: [...before.avatars.filter((avatar) => avatar.folder !== result.folder), entry] }));
    setAnswer(null);
    setSelected(result.folder);
    onListed(result.listing);
  };

  const openFolder = (): void => {
    if (openingFolder) return;
    setOpeningFolder(true);
    setFolderFailed(false);
    invoke('avatars:openFamilyFolder', family).then(
      () => setOpeningFolder(false),
      () => { setOpeningFolder(false); setFolderFailed(true); },
    );
  };

  const shown = draft === null || listed === undefined ? undefined : draftFamily(listed, draft);
  const selectedDraft = draft?.avatars.find((avatar) => avatar.folder === selected);
  const selectedView = shown?.avatars.find((view) => view.folder === selected);
  const missing = new Set(loaded?.missing ?? []);
  const faceView = shown === undefined ? undefined : defaultViewOf(shown);
  const faceDrawn = shown !== undefined && faceView !== undefined && resolvedOf(shown, faceView) !== null;
  const overriding = draft?.avatars.filter((avatar) => Object.keys(cleanLayer(avatar.overlay)).length > 0).length ?? 0;
  const selectedMissing = selectedDraft !== undefined && missing.has(selectedDraft.folder);
  const customized = selectedDraft !== undefined && Object.keys(cleanLayer(selectedDraft.overlay)).length > 0;
  const avatarsId = `${baseId}-avatars`;
  const defaultId = `${baseId}-default-row`;
  const chooseDefault = (): void => {
    setSelected(null);
    document.getElementById(defaultId)?.focus();
  };

  return (
    <>
      <header className={dialogStyles.header}>
        <h2 id={titleId} className={dialogStyles.title}>{EDITOR_WORDS.title(family.family)}</h2>
        <span className={styles.statusLine}>
          {listed !== undefined && [listed.author, listed.licence].filter((part) => part !== null).join(' · ')}
        </span>
        <button type="button" className={dialogStyles.closeButton} aria-label={EDITOR_WORDS.close} disabled={copying} onClick={close}>
          <CloseIcon />
        </button>
      </header>
      <div className={`${dialogStyles.body} ${styles.familyEditor}`}>
        {source === 'reading' && <p className={styles.muted}>{EDITOR_WORDS.reading}</p>}
        {source === 'unread' && <p className={styles.feedback} role="status">{EDITOR_WORDS.unread}</p>}
        {source === 'gone' && <p className={styles.feedback} role="status">{EDITOR_WORDS.gone}</p>}
        {loaded?.lock != null && (
          <p className={styles.editorNote} role="note" data-family-lock={loaded.lock.kind}>
            {loaded.lock.kind === 'manifest'
              ? avatarProblemWords({ kind: 'manifest', path: 'family.json', cause: loaded.lock.cause, field: loaded.lock.field })
              : EDITOR_WORDS.locks[loaded.lock.kind]}
            {loaded.lock.kind === 'packaged' && (
              <> But you can <button type="button" className={styles.copyFamilyButton} disabled={copying} onClick={makeCopy}>{copying ? EDITOR_WORDS.copying : EDITOR_WORDS.makeCopy}</button> and edit it.</>
            )}
          </p>
        )}
        {copyFailed && <p className={styles.feedback} role="status">{EDITOR_WORDS.copyFailed}</p>}
        {folderFailed && <p className={styles.feedback} role="status">{EDITOR_WORDS.folderFailed}</p>}
        {draft !== null && shown !== undefined && (
          <div className={styles.familyEditorColumns} data-family-columns="">
            <section className={styles.familyListPanel} aria-labelledby={`${baseId}-avatars-title`}>
              <label className={styles.familyControl}>
                <span>{EDITOR_WORDS.provider}</span>
                <select
                  value={draft.provider}
                  disabled={disabled}
                  onChange={(event) => update((before) => ({ ...before, provider: event.target.value }))}
                  data-family-provider-scope=""
                >
                  <option value="any">{EDITOR_WORDS.anyProvider}</option>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
                  {draft.provider !== 'any' && !providers.some((provider) => provider.id === draft.provider) && <option value={draft.provider}>{draft.provider}</option>}
                </select>
              </label>
              <div className={styles.familyContentActions}>
                <button type="button" className={dialogStyles.button} disabled={openingFolder || copying} onClick={openFolder}>{EDITOR_WORDS.openFolder}</button>
                <AvatarFamilyGuide compact />
              </div>
              <h3 id={`${baseId}-avatars-title`} className={styles.editorHeading}>{EDITOR_WORDS.avatars}</h3>
              <AvatarList
                id={avatarsId}
                labelledBy={`${baseId}-avatars-title`}
                draft={draft}
                shown={shown}
                missing={missing}
                selected={selected}
                onSelect={setSelected}
                defaultId={defaultId}
                overriding={overriding}
              />
              <AvatarDropZone
                disabled={disabled || adding !== null}
                preparing={preparing}
                onFile={takeImage}
                onProblem={setDropProblem}
              />
              {dropProblem !== null && <p className={styles.feedback} role="status" data-drop-problem="">{dropProblem}</p>}
            </section>
            <section className={styles.familyDetailPanel} aria-label={EDITOR_WORDS.avatarTitle(selectedDraft?.folder ?? EDITOR_WORDS.familyDefault)}>
              {selectedDraft === undefined ? (
                faceView === undefined || !faceDrawn ? (
                  <p className={styles.editorNote} data-default-detail="" data-no-default="">{EDITOR_WORDS.noDefault}</p>
                ) : (
                  <div className={styles.familyDetail} data-default-detail="">
                    <div className={styles.editorHeading}>
                      <h3 className={styles.avatarName}>{EDITOR_WORDS.avatarTitle(EDITOR_WORDS.familyDefault)}</h3>
                    </div>
                    <Preview
                      name={EDITOR_WORDS.familyDefault}
                      view={faceView}
                      shown={shown}
                      layers={avatarLayers(draft.overlay, undefined, false)}
                      fallbackLayers={avatarLayers(draft.overlay, undefined, true)}
                      providers={providers}
                      entries={entries}
                      previewModel={previewModel}
                      previewEffort={previewEffort}
                      onPreviewModel={setPreviewModel}
                      onPreviewEffort={setPreviewEffort}
                      images={imageActions(faceView.folder)}
                    />
                  </div>
                )
              ) : (
                <AvatarDetail
                  key={selectedDraft.folder}
                  avatar={selectedDraft}
                  view={selectedView}
                  shown={shown}
                  missing={selectedMissing}
                  providers={providers}
                  entries={entries}
                  disabled={disabled}
                  previewModel={previewModel}
                  previewEffort={previewEffort}
                  onPreviewModel={setPreviewModel}
                  onPreviewEffort={setPreviewEffort}
                  images={imageActions(selectedDraft.folder)}
                  onChange={(change) => updateAvatar(selectedDraft.folder, change)}
                  onRemove={() => {
                    update((before) => ({ ...before, avatars: before.avatars.filter((avatar) => avatar.folder !== selectedDraft.folder) }));
                    chooseDefault();
                  }}
                />
              )}
            </section>
            <section className={styles.familyStylePanel} aria-labelledby={`${baseId}-style`} data-style-target={selectedDraft === undefined ? 'family' : 'avatar'}>
              <h3 id={`${baseId}-style`} className={styles.editorHeading}>{selectedDraft === undefined ? EDITOR_WORDS.defaultStyle : EDITOR_WORDS.styleOverrides}</h3>
              {selectedDraft !== undefined ? (
                <div className={styles.overrideBar}>
                  <span className={styles.highlightNote} data-customizations-note="">{EDITOR_WORDS.highlighted}</span>
                  <span className={styles.inlineActions}>
                    <button type="button" disabled={disabled || selectedMissing || !customized} onClick={() => updateAvatar(selectedDraft.folder, (before) => ({ ...before, overlay: {} }))} data-reset-style="">{EDITOR_WORDS.reset}</button>
                  </span>
                </div>
              ) : (
                // The Default style overrides nothing, but keeps the bar's room: the editor keeps its height
                // as the chosen row moves between the Family default and an avatar.
                <div className={`${styles.overrideBar} ${styles.reservedRoom}`} aria-hidden="true" data-override-room="">
                  <span className={styles.highlightNote}>{'\u00a0'}</span>
                  <span className={styles.inlineActions}>
                    <button type="button" tabIndex={-1} disabled>{'\u00a0'}</button>
                  </span>
                </div>
              )}
              {selectedDraft === undefined ? (
                <StyleControls layer={draft.overlay} below={[]} overriding={false} disabled={disabled} onChange={(layer) => update((before) => ({ ...before, overlay: layer }))} />
              ) : (
                <StyleControls key={selectedDraft.folder} layer={selectedDraft.overlay} below={[draft.overlay]} overriding disabled={disabled || selectedMissing} onChange={(layer) => updateAvatar(selectedDraft.folder, (before) => ({ ...before, overlay: layer }))} />
              )}
            </section>
          </div>
        )}
      </div>
      <footer className={dialogStyles.footer}>
        {answer !== null && (
          <p className={styles.feedback} role="status" data-save-answer={answer.kind}>
            {answer.kind === 'locked'
              ? lockWords(answer.lock)
              : answer.kind === 'saved' ? '' : EDITOR_WORDS.answers[answer.kind]}
          </p>
        )}
        {answer?.kind === 'conflict' && (
          <button type="button" className={dialogStyles.button} onClick={() => setAsking('reload')} data-reload-family="">{EDITOR_WORDS.reload}</button>
        )}
        {dirty && answer === null && <small className={styles.muted} data-unsaved="">{EDITOR_WORDS.unsaved}</small>}
        {family.origin === 'built-in' && loaded?.lock === null && (
          <button type="button" className={dialogStyles.button} disabled={copying || saving} onClick={makeCopy}>{copying ? EDITOR_WORDS.copying : EDITOR_WORDS.makeCopy}</button>
        )}
        <button type="button" className={dialogStyles.button} disabled={copying} onClick={close}>{EDITOR_WORDS.cancel}</button>
        <button type="button" className={`${dialogStyles.button} ${dialogStyles.primary}`} disabled={disabled || !dirty || badPatterns} onClick={save} data-save-family="">{EDITOR_WORDS.save}</button>
      </footer>
      <ConfirmDialog
        open={asking !== null}
        title={asking === 'reload' ? EDITOR_WORDS.reloadTitle : EDITOR_WORDS.discardTitle}
        confirmLabel={asking === 'reload' ? EDITOR_WORDS.reload : EDITOR_WORDS.discard}
        onConfirm={() => {
          const was = asking;
          setAsking(null);
          if (was === 'reload') { setSource('reading'); setRead((count) => count + 1); }
          else if (was === 'copy') copyFamily();
          else { guardRef.current = null; onDone(); }
        }}
        onCancel={() => setAsking(null)}
      >
        <p>{asking === 'reload' ? EDITOR_WORDS.reloadBody : EDITOR_WORDS.discardBody}</p>
      </ConfirmDialog>
      {draft !== null && shown !== undefined && (
        <AddAvatarDialog
          image={adding}
          family={family}
          revision={loaded?.revision ?? null}
          shown={shown}
          taken={[...draft.avatars.map((avatar) => avatar.folder), ...shown.avatars.map((view) => view.folder), MANIFEST_FILE, LICENSE_FILE]}
          providers={providers}
          entries={entries}
          onAdded={added}
          onRefused={(refusal) => setAnswer(refusal)}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

/** The family default followed by its avatars, in one list and one keyboard tab stop. */
function AvatarList({ id, labelledBy, draft, shown, missing, selected, onSelect, defaultId, overriding }: {
  /** Each row's id is this and its index. */
  readonly id: string;
  readonly labelledBy: string;
  readonly draft: FamilyDraft;
  readonly shown: FamilyView;
  readonly missing: ReadonlySet<string>;
  readonly selected: string | null;
  readonly onSelect: (folder: string | null) => void;
  readonly defaultId: string;
  readonly overriding: number;
}) {
  const rowId = (index: number): string => index === 0 ? defaultId : `${id}-${index - 1}`;
  const faceView = defaultViewOf(shown);
  const face = faceView === undefined ? null : resolvedOf(shown, faceView);
  // Read to assistive technology alone: shown, the row has no room for them.
  const defaultWords = [face === null ? EDITOR_WORDS.noDefault : EDITOR_WORDS.familyDefaultWords, ...(overriding > 0 ? [EDITOR_WORDS.overriding(overriding)] : [])];
  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    const at = selected === null ? 0 : draft.avatars.findIndex((avatar) => avatar.folder === selected) + 1;
    const index = event.key === 'ArrowDown' ? Math.min(draft.avatars.length, at + 1) : event.key === 'ArrowUp' ? Math.max(0, at - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? draft.avatars.length : -1;
    if (index < 0) return;
    event.preventDefault();
    onSelect(draft.avatars[index - 1]?.folder ?? null);
    document.getElementById(rowId(index))?.focus();
  };
  return (
    <ul className={styles.assignmentList} role="listbox" aria-labelledby={labelledBy} onKeyDown={onKey}>
      <li
        id={defaultId}
        role="option"
        aria-selected={selected === null}
        aria-label={[EDITOR_WORDS.familyDefault, ...defaultWords].join(', ')}
        tabIndex={selected === null ? 0 : -1}
        className={styles.assignmentRow}
        data-family-default=""
        onClick={() => onSelect(null)}
      >
        {face === null ? (
          <span className={styles.assignmentEmpty} data-assignment-empty="" aria-hidden="true" />
        ) : (
          <Avatar providerId={shown.defaultFor[0] ?? ''} avatar={face} size="thin" />
        )}
        <span className={styles.assignmentName}>{EDITOR_WORDS.familyDefault}</span>
      </li>
      {draft.avatars.map((avatar, index) => {
        const view = shown.avatars.find((candidate) => candidate.folder === avatar.folder);
        const resolved = view === undefined ? null : resolvedOf(shown, view);
        const customized = Object.keys(cleanLayer(avatar.overlay)).length > 0;
        const words = [
          avatar.matches.length === 0 ? EDITOR_WORDS.noMatches : avatar.matches.map((entry) => matchViewText(matchView(entry))).join(', '),
          ...(missing.has(avatar.folder) ? [EDITOR_WORDS.missing] : []),
          ...(view?.problems ?? []).map(avatarProblemWords),
        ];
        const chosen = avatar.folder === selected;
        return (
          <li
            key={avatar.folder}
            id={rowId(index + 1)}
            role="option"
            aria-selected={chosen}
            aria-label={[avatar.folder, ...words, ...(customized ? [EDITOR_WORDS.customized] : [])].join(', ')}
            tabIndex={chosen ? 0 : -1}
            className={styles.assignmentRow}
            data-family-avatar={avatar.folder}
            data-greyed={missing.has(avatar.folder) ? '' : undefined}
            onClick={() => onSelect(avatar.folder)}
          >
            {resolved === null ? (
              <span className={styles.assignmentEmpty} data-assignment-empty="" aria-hidden="true" />
            ) : (
              <Avatar providerId={shown.defaultFor[0] ?? ''} avatar={resolved} size="thin" />
            )}
            <span className={styles.assignmentName}>{avatar.folder}</span>
            <span className={styles.assignmentWords}>{words.join(' · ')}</span>
            {customized && <span className={styles.customizedTag} data-customized="">{EDITOR_WORDS.customized}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * An avatar's two images, each described at its left with its way to be replaced (decision 0036): its
 * main image at the model column's size and its small version at the capsule's, near its own, both in
 * the style, with the texts of the model chosen under Preview as — else of a model it suits — and the
 * effort chosen under Effort; always as a fast session, so that the fast bolt shows where its place
 * puts it.
 */
function Preview({ name, view, shown, layers, fallbackLayers, providers, entries, previewModel, previewEffort, onPreviewModel, onPreviewEffort, images }: {
  readonly name: string;
  readonly view: AvatarView;
  readonly shown: FamilyView;
  /** The style as the row sets it: for the Family default, as the other avatars wear it. */
  readonly layers: readonly (OverlayLayer | undefined)[];
  /** The Family default's own, its texts fixed: drawn beside the other where it differs. */
  readonly fallbackLayers?: readonly (OverlayLayer | undefined)[];
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly previewModel: string;
  readonly previewEffort: string;
  readonly onPreviewModel: (value: string) => void;
  readonly onPreviewEffort: (value: string) => void;
  /** Its two images' replacing (decision 0036). */
  readonly images: ImageActions;
}) {
  const providerName = (id: string): string => providers.find((provider) => provider.id === id)?.displayName ?? id;
  const [chosenProvider, ...chosenKey] = previewModel.split('/');
  const chosen = previewModel === '' ? undefined : entries.find((entry) => entry.id === chosenProvider)?.models.find((model) => model.key === chosenKey.join('/'));
  const texts = chosen?.label ?? (previewModel === '' ? sampleLabel(shown, view, entries) : NO_LABEL);
  const drawn = styledOf(shown, view, texts, layers);
  // Where Name or Version is off, the Family default draws otherwise than the style says: both are shown.
  const fallback = fallbackLayers === undefined ? null : styledOf(shown, view, texts, fallbackLayers);
  const twofold = fallback !== null && drawn !== null && !sameOverlay(fallback.overlay, drawn.overlay);
  const fallbackId = useId();
  const providerId = chosen === undefined ? (shown.defaultFor[0] ?? chosenProvider ?? '') : (chosenProvider ?? '');
  const effort = previewEffort === '' ? null : previewEffort;
  const portraitFile = view.files.find((file) => file.role === 'portrait');
  const smallFile = view.files.find((file) => file.role === 'small');
  // The small version drawn at the capsule's size, near its own: the main image where it has none.
  const smallDrawn = drawn === null ? null : { ...drawn, portrait: drawn.small ?? drawn.portrait };
  return (
    <div className={styles.stylePreview} role="group" aria-label={`${name}: preview`} data-style-preview="">
      <div className={styles.imageRows}>
        <AvatarImageRow role="portrait" label={EDITOR_WORDS.images.main(portraitFile?.width ?? 0)} hint={EDITOR_WORDS.images.replace} actions={images}>
          <Avatar providerId={providerId} avatar={drawn} size="column" effort={effort} fast />
        </AvatarImageRow>
        <AvatarImageRow role="small" label={smallFile === undefined ? EDITOR_WORDS.images.noSmall : EDITOR_WORDS.images.small(smallFile.width)} hint={smallFile === undefined ? EDITOR_WORDS.images.addSmall : EDITOR_WORDS.images.replace} note={EDITOR_WORDS.images.autogenerated} actions={images}>
          <Avatar providerId={providerId} avatar={smallDrawn} size="capsule" effort={effort} fast />
        </AvatarImageRow>
      </div>
      {images.problem !== null && <p className={styles.feedback} role="status" data-image-problem="">{images.problem}</p>}
      {twofold && (
        <div className={styles.fallbackPreview} role="group" aria-labelledby={fallbackId} data-fallback-preview="">
          <div className={styles.fallbackWords}>
            <h5 id={fallbackId} className={styles.familyGroupTitle}>{EDITOR_WORDS.fallbackTitle}</h5>
            <p className={styles.statusLine}>{EDITOR_WORDS.fallbackWhy}</p>
          </div>
          <div className={styles.fallbackSizes}>
            <Avatar providerId={providerId} avatar={fallback} size="column" effort={effort} fast />
            <Avatar providerId={providerId} avatar={fallback} size="capsule" effort={effort} fast />
          </div>
        </div>
      )}
      {/* The model and the effort the images are drawn with, on one line under a rule. */}
      <div className={styles.previewChoice} data-preview-choice="">
        <label className={`${styles.familyControl} ${styles.previewModel}`}>
          <span>{EDITOR_WORDS.previewAs}</span>
          <select value={previewModel} onChange={(event) => onPreviewModel(event.target.value)} data-preview-model="">
            <option value="">{EDITOR_WORDS.sample}</option>
            {entries.map((entry) => providerTiles(entry).map((model) => (
              <option key={`${entry.id}/${model.key}`} value={`${entry.id}/${model.key}`}>{providerName(entry.id)} · {model.name}</option>
            )))}
          </select>
        </label>
        <span aria-hidden="true">,</span>
        <label className={styles.familyControl}>
          <span>{EDITOR_WORDS.effort}</span>
          <select value={previewEffort} onChange={(event) => onPreviewEffort(event.target.value)} data-preview-effort="">
            <option value="">{EDITOR_WORDS.noEffort}</option>
            {MARKED_EFFORTS.map((effort) => <option key={effort} value={effort}>{EDITOR_WORDS.efforts[effort] ?? effort}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

/** The chosen avatar, under its name: its preview as it is drawn, then its matches and the models they take now. */
function AvatarDetail({ avatar, view, shown, missing, providers, entries, disabled, previewModel, previewEffort, onPreviewModel, onPreviewEffort, images, onChange, onRemove }: {
  readonly avatar: AvatarDraft;
  readonly view: AvatarView | undefined;
  readonly shown: FamilyView;
  readonly missing: boolean;
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly disabled: boolean;
  readonly previewModel: string;
  readonly previewEffort: string;
  readonly onPreviewModel: (value: string) => void;
  readonly onPreviewEffort: (value: string) => void;
  readonly images: ImageActions;
  readonly onChange: (change: (before: AvatarDraft) => AvatarDraft) => void;
  readonly onRemove: () => void;
}) {
  const providerName = (id: string): string => providers.find((provider) => provider.id === id)?.displayName ?? id;
  if (missing || view === undefined) {
    return (
      <div className={styles.familyDetail} data-avatar-detail={avatar.folder} data-missing="">
        <h3 className={styles.avatarName}>{EDITOR_WORDS.avatarTitle(avatar.folder)}</h3>
        <p className={styles.muted}>{EDITOR_WORDS.missingHelp}</p>
        {avatar.matches.length > 0 && <p className={styles.statusLine}>{EDITOR_WORDS.matches}: {avatar.matches.map((entry) => matchViewText(matchView(entry))).join(', ')}</p>}
        <span className={styles.inlineActions}>
          <button type="button" disabled={disabled} onClick={onRemove} data-remove-entry="">{EDITOR_WORDS.removeEntry}</button>
        </span>
      </div>
    );
  }

  const takes = entries.flatMap((entry) => entry.models.filter((model) => familyMatch(shown, entry.id, model)?.view.folder === view.folder).map((model) => `${model.name} (${providerName(entry.id)})`));

  return (
    <div className={styles.familyDetail} data-avatar-detail={avatar.folder}>
      <div className={styles.editorHeading}>
        <h3 className={styles.avatarName}>{EDITOR_WORDS.avatarTitle(avatar.folder)}</h3>
      </div>
      <Preview
        name={avatar.folder}
        view={view}
        shown={shown}
        layers={avatarLayers(shown.overlay, view.overlay, false)}
        providers={providers}
        entries={entries}
        previewModel={previewModel}
        previewEffort={previewEffort}
        onPreviewModel={onPreviewModel}
        onPreviewEffort={onPreviewEffort}
        images={images}
      />
      <MatchEditor matches={avatar.matches} providers={providers} disabled={disabled} takes={takes} onChange={(matches) => onChange((before) => ({ ...before, matches }))} />
    </div>
  );
}
