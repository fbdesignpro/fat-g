// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { ATTACHMENT_WORDS, attachmentAddress } from '@shared/contracts/attachments';
import { imageFileAddress } from '@shared/contracts/files';
import type { TabBodyProps } from '../tab-kind';
import { ARTIFACT_WORDS, ArtifactAction, ArtifactBar } from '../ArtifactBar';
import { FileRefreshStatus } from '../FileRefreshStatus';
import { invoke } from '../../ipc/client';
import { copyImage, copyImageFile } from './copy-image';
import { IMAGE_WORDS } from './words';
import { useImageRefresh } from './useImageRefresh';
import { imageFileFailure, IMAGE_FILE_FAILURE_WORDS, IMAGE_FILE_STORAGE_NOTE, type ImageFileFailure } from '../../images/file-failure';
import styles from './Image.module.css';

/**
 * What an image's tab is: a chat's attachment by its hash (M23, C27), or an image file by its real
 * path (decision 0022, item 15). Either is its identity in the session.
 */
export type ImageReference = string | { readonly path: string };

/** What the opener hands an image's tab beside its reference (C27): its name and size, and whether fat-g holds its file. */
export interface ImageDisplay {
  readonly name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly available: boolean;
  /** Its place among its message's images, which an image with no name is titled by. */
  readonly ordinal: number;
  /** An image file's: the id main gave it for the run, which it is drawn by. */
  readonly file?: string;
}

/** What the pane keeps for an image's tab between showings: what it was opened with, and whether it is shown at actual size. */
export interface ImageViewState {
  readonly display?: ImageDisplay;
  readonly actual?: boolean;
  /** Each explicit opening retries the image, even if an earlier load of this same id failed. */
  readonly serial?: number;
  /** Time the last automatic replacement successfully loaded; kept only for this tab's lifetime. */
  readonly autoUpdatedAt?: number;
}

/** The tab's title (C27): the image's name, else "Image n". */
export const imageTitle = (display: ImageDisplay | undefined): string => (display === undefined ? IMAGE_WORDS.title : display.name ?? IMAGE_WORDS.numbered(display.ordinal));

/**
 * An image's tab (docs/planning/_archive/M23.md, Design 4; C8, C26, C27): the image drawn through the confined
 * media route — an attachment by its hash, an image file by its id (decision 0022, item 15) — fitted
 * to the pane's width; a press — or Enter or Space on it — shows it at its actual size, the pane
 * scrolling, and another fits it again. An image whose file fat-g no longer holds, or that changed or
 * went since it was read, keeps its name and size, and says it is not available. Its title is its
 * name, else its place.
 */
export function ImageBody({ sessionId, reference, viewState, setViewState, setTitle }: TabBodyProps<ImageReference, ImageViewState>) {
  const display = viewState?.display;
  const actual = viewState?.actual === true;
  // The opening that failed to draw: another press may retry even an unchanged image.
  const [failed, setFailed] = useState<string | null>(null);
  const [fileFailure, setFileFailure] = useState<{ readonly key: string; readonly failure: ImageFileFailure } | null>(null);
  useEffect(() => { setTitle(imageTitle(display)); }, [display, setTitle]);
  const hash = typeof reference === 'string' ? reference : null;
  const file = display?.file;
  const address = hash !== null ? attachmentAddress(hash) : file === undefined ? null : imageFileAddress(file);
  const path = typeof reference === 'string' ? null : reference.path;
  const refresh = useImageRefresh(sessionId, path, file, viewState?.serial ?? 0, (image) => {
    setViewState({ ...viewState, autoUpdatedAt: Date.now(), display: { ...display, name: display?.name ?? null, ordinal: display?.ordinal ?? 1, file: image.id, width: image.width, height: image.height, available: true } });
  });
  const failureKey = `${sessionId}\0${path ?? ''}\0${address ?? ''}\0${viewState?.serial ?? 0}`;
  useEffect(() => {
    if (path === null || address === null || failed !== failureKey) return;
    let live = true;
    // A media request reports no reason to <img>. Ask the same checked reader for the
    // current state; a good header alone does not prove that Chromium can draw the image.
    void invoke('files:read', { sessionId, target: path }).then((read) => {
      if (live) setFileFailure({ key: failureKey, failure: imageFileFailure(read) });
    }).catch(() => {
      if (live) setFileFailure({ key: failureKey, failure: { why: 'read-failed' } });
    });
    return () => { live = false; };
  }, [sessionId, path, address, failed, failureKey]);
  const fileWhy = fileFailure?.key === failureKey ? fileFailure.failure.why : 'load-failed';
  const available = address !== null && display?.available !== false && failed !== failureKey;
  const label = display?.name ?? (display?.width != null && display.height != null ? ATTACHMENT_WORDS.unnamed(display.width, display.height, display.ordinal) : IMAGE_WORDS.title);
  const show = async (): Promise<void> => {
    if (hash !== null) await invoke('attachments:showInFolder', { hash });
    else if (path !== null) await invoke('files:showInFolder', { sessionId, path });
  };
  const copy = (): Promise<void> => (hash !== null ? copyImage(hash) : file === undefined ? Promise.reject(new Error('image unavailable')) : copyImageFile(sessionId, file));
  return (
    <div className={styles.tab} data-image-tab={!available ? 'unavailable' : actual ? 'actual' : 'fit'}>
      <ArtifactBar label={IMAGE_WORDS.title} metadata={path === null ? undefined : <FileRefreshStatus failed={refresh.failed} updatedAt={viewState?.autoUpdatedAt ?? null} failedTip={IMAGE_WORDS.refreshFailedTip} />}>
        <ArtifactAction kind="folder" label={ARTIFACT_WORDS.folder} disabled={!available} action={show} />
        <ArtifactAction kind="copy" label={ARTIFACT_WORDS.imageCopy} disabled={!available} action={copy} />
      </ArtifactBar>
      {refresh.pending !== null && <img hidden aria-hidden="true" data-image-refresh-candidate="" key={refresh.pending.id} src={imageFileAddress(refresh.pending.id)} alt="" onLoad={() => { if (refresh.pending !== null) refresh.loaded(refresh.pending.id, true); }} onError={() => { if (refresh.pending !== null) refresh.loaded(refresh.pending.id, false); }} />}
      <div className={styles.content}>
        {!available || address === null ? <>
          <p className={styles.unavailable}>{path === null ? IMAGE_WORDS.unavailable : IMAGE_FILE_FAILURE_WORDS[fileWhy]}</p>
          <p className={styles.meta}>{display?.width != null && display.height != null ? ATTACHMENT_WORDS.tooltip(display.name, display.width, display.height) : label}</p>
          {path !== null && fileWhy === 'not-found' && <p className={styles.meta}>{IMAGE_FILE_STORAGE_NOTE}</p>}
        </> : (
          <button
            type="button"
            className={actual ? styles.actual : styles.fit}
            aria-pressed={actual}
            aria-label={IMAGE_WORDS.actual}
            title={actual ? IMAGE_WORDS.fit : IMAGE_WORDS.actual}
            onClick={() => setViewState({ ...viewState, actual: !actual })}
          >
            <img key={failureKey} src={address} alt={label} draggable={false} onError={() => setFailed(failureKey)} />
          </button>
        )}
      </div>
    </div>
  );
}
