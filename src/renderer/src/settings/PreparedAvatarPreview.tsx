// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useMemo } from 'react';
import type { AddedImage } from './AddAvatarDialog';
import { EDITOR_WORDS } from './family-editor-words';
import styles from './Settings.module.css';

/** The same prepared portrait and small preview for adding an avatar or starting a family. */
export function PreparedAvatarPreview({ image }: { readonly image: AddedImage }) {
  const urls = useMemo(() => ({
    portrait: URL.createObjectURL(new Blob([image.prepared.portrait], { type: 'image/png' })),
    small: URL.createObjectURL(new Blob([image.prepared.small], { type: 'image/png' })),
  }), [image]);
  useEffect(() => () => { URL.revokeObjectURL(urls.portrait); URL.revokeObjectURL(urls.small); }, [urls]);
  return <>
    <div className={styles.addAvatarImages}>
      <figure className={styles.addAvatarFigure}>
        <img className={styles.addAvatarPortrait} src={urls.portrait} alt="" data-added-portrait="" />
        <figcaption className={styles.statusLine}>{EDITOR_WORDS.add.portrait}</figcaption>
      </figure>
      <figure className={styles.addAvatarFigure}>
        <img className={styles.addAvatarSmall} src={urls.small} alt="" data-added-small="" />
        <figcaption className={styles.statusLine}>{EDITOR_WORDS.add.small}</figcaption>
      </figure>
    </div>
    <p className={styles.statusLine} data-added-sizes="">{EDITOR_WORDS.add.sizes(image.file, image.prepared.sourceSide, image.prepared.portraitSide)}</p>
  </>;
}
