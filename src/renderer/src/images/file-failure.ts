// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { FileReadAnswer, FileRefusal, FileUnshown } from '@shared/contracts/files';

/** Shared preview words, independent of the chat and pane. A missing file does not tell us who removed it. */
export interface ImageFileFailure {
  readonly why: FileRefusal | FileUnshown | 'load-failed' | 'read-failed';
}

export const IMAGE_FILE_FAILURE_WORDS: Readonly<Record<ImageFileFailure['why'], string>> = {
  'not-found': 'Image file no longer found',
  outside: 'Image location is not allowed',
  several: 'More than one image file matches this name',
  folder: 'This path is a folder, not an image file',
  'not-regular': 'This path is not a regular file',
  'no-answer': 'Image file could not be read',
  'not-image': 'Unsupported image or preview limit exceeded',
  'other-kind': 'Image format is not supported',
  'too-large': 'Image exceeds preview limits',
  'not-text': 'Image format is not supported',
  'load-failed': 'Image preview could not be loaded',
  'read-failed': 'Could not check the image file',
};

export const IMAGE_FILE_STORAGE_NOTE = 'Preview uses the original file; fat-g does not save a copy. Temporary files may have been cleaned up.';

/** Also used after a media-route failure: a successful header read cannot explain a decode failure. */
export function imageFileFailure(read: FileReadAnswer): ImageFileFailure {
  return { why: read.outcome === 'refused' || read.outcome === 'unshown' ? read.why : 'load-failed' };
}
