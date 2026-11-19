// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `image` kind (docs/planning/_archive/M23.md, Design 4; C27; docs/adding-a-tab-kind.md): an image of the
// chat, opened from a user's message's thumbnail. Its reference is the image's hash, which is its
// identity in the session whatever name it was dropped under; what it is drawn with besides is handed
// by the opener in its view state. Its title is the image's name, else its place, which its body sets.
// An image file (decision 0022, item 15) — one an agent read, or one a reference names — is a tab of
// the same kind, by its real path, drawn by the id main's read gave it.
import { IMAGE_KIND } from '../opener';
import { tabKind } from '../tab-kind';
import { ImageBody, type ImageReference, type ImageViewState } from './ImageBody';
import { IMAGE_WORDS } from './words';

export const imageKind = tabKind<ImageReference, ImageViewState>({ id: IMAGE_KIND, title: () => IMAGE_WORDS.title, Body: ImageBody, framed: false });
