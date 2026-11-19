// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ImageSource } from '../../avatars/image-source';
import type { AvatarService } from '../../avatars/service';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';

/**
 * The Avatars tab's channels (M102, C40, C63; decision 0031): the listing of both roots — once any scan
 * under way has landed, so the tab draws the catalog that stands — and Rescan, answered once a scan
 * begun after the press has landed. The tab then asks the listing again; every drawn avatar follows by
 * the app state. The family editor's: a family as its file holds it now, a draft saved into that
 * file, a new avatar added to it and an avatar's image replaced (decision 0036), each write answered
 * once the scan after it has landed; and Browse, which answers an image's name and bytes, with the
 * dropped file's folder the preload tells it.
 */
export function avatarHandlers(avatars: Pick<AvatarService, 'idle' | 'listing' | 'scan' | 'openFamily' | 'saveFamily' | 'copyFamily' | 'createFamily' | 'addAvatar' | 'replaceImage' | 'familyFolder'>, openFolder: (folder: string) => Promise<string>, images: Pick<ImageSource, 'choose' | 'noteDropped'>): Pick<InvokeHandlers, 'avatars:list' | 'avatars:rescan' | 'avatars:family' | 'avatars:saveFamily' | 'avatars:copyFamily' | 'avatars:createFamily' | 'avatars:addAvatar' | 'avatars:replaceImage' | 'avatars:chooseImage' | 'avatars:noteDropped' | 'avatars:openFamilyFolder'> {
  return {
    async 'avatars:list'() {
      await avatars.idle();
      return avatars.listing();
    },
    async 'avatars:rescan'() {
      await avatars.scan();
      return null;
    },
    async 'avatars:family'(ref) {
      await avatars.idle();
      return avatars.openFamily(ref);
    },
    'avatars:saveFamily': (request) => avatars.saveFamily(request),
    'avatars:copyFamily': (ref) => avatars.copyFamily(ref),
    'avatars:createFamily': (request) => avatars.createFamily(request),
    'avatars:addAvatar': (request) => avatars.addAvatar(request),
    'avatars:replaceImage': (request) => avatars.replaceImage(request),
    'avatars:chooseImage': () => images.choose(),
    'avatars:noteDropped'(request) {
      images.noteDropped(request.path);
      return Promise.resolve(null);
    },
    async 'avatars:openFamilyFolder'(ref) {
      await avatars.idle();
      const folder = await avatars.familyFolder(ref);
      if (folder === null) throw new InvalidIpcRequest();
      // shell.openPath's error can contain a path: keep it out of the reply and logs.
      let opened = false;
      try { opened = (await openFolder(folder)) === ''; } catch { /* Report only the fixed error below. */ }
      if (!opened) throw new Error('the family folder could not be opened');
      return null;
    },
  };
}
