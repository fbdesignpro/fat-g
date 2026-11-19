// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `file` kind (docs/planning/_archive/M19b.md, Design 8; C31, C36): a tab for a file of the session's
// project, opened from a reference in the chat or in another shown file. Its reference is the
// file's real path, as main answered it. The one kind M19b has; docs/adding-a-tab-kind.md takes it
// as its example.
import { FILE_KIND } from '../opener';
import { tabKind } from '../tab-kind';
import { FileBody, type FileViewState } from './FileBody';
import { fileTitle } from './words';

export const fileKind = tabKind<string, FileViewState>({ id: FILE_KIND, title: fileTitle, Body: FileBody });
