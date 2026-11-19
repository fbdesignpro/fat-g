// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Channel names and window kinds: the part of the IPC contract that exists at RUNTIME in the
// sandboxed preload, which uses the guards below as its allowlist. Keep this file free of
// dependencies — the typed contract (with zod) is contract.ts, which the preload may only
// import types from (lint-enforced).
//
// Adding a channel starts here; see contract.ts for the rest of the steps.

/** Calls from a window to main that resolve with a result (`window.fatg.invoke`). */
export const INVOKE_CHANNELS = [
  'state:getSnapshot',
  'prefs:get',
  'prefs:patch',
  'prefs:startFresh',
  'prefs:retry',
  'records:startFresh',
  'records:retry',
  'projects:pickFolder',
  'projects:openFolder',
  'projects:add',
  'projects:update',
  'projects:setHidden',
  'projects:setCollapsed',
  'projects:move',
  'projects:remove',
  'projects:checkRoots',
  'sessions:create',
  'sessions:setDraftPreset',
  'sessions:select',
  'sessions:search',
  'sessions:closeSearch',
  'sessions:acknowledge',
  'sessions:setFlag',
  'sessions:rename',
  'sessions:describeDraft',
  'sessions:complete',
  'sessions:shelve',
  'sessions:restore',
  'sessions:doing',
  'sessions:move',
  'sessions:setEffort',
  'sessions:setSpeed',
  'sessions:remove',
  'sessions:removeOrphans',
  'chat:read',
  'chat:page',
  'chat:readWorker',
  'chat:send',
  'chat:stop',
  'chat:loadHistory',
  'chat:ask',
  'chat:readAside',
  'chat:stopAside',
  'chat:removeAside',
  'chat:answer',
  'chat:dismiss',
  'chat:setMode',
  'chat:decide',
  'chat:draft',
  'chat:queue',
  'chat:unqueue',
  'chat:editQueued',
  'chat:resumeQueue',
  'chat:commands',
  'drafts:flushed',
  'attachments:stage',
  'attachments:readForCopy',
  'attachments:showInFolder',
  'plans:read',
  'plans:list',
  'plans:remove',
  'plans:decide',
  'plans:bring',
  'plans:storage',
  'plans:workflow',
  'reviews:start',
  'reviews:mark',
  'reviews:note',
  'reviews:send',
  'reviews:explain',
  'reviews:integrate',
  'reviews:close',
  'reviews:read',
  'conversations:storage',
  'conversations:startFresh',
  'conversations:listDetached',
  'conversations:readDetached',
  'conversations:removeDetached',
  'conversations:removeSetAside',
  'providers:refresh',
  'providers:redetect',
  'providers:discover',
  'providers:acknowledgeDiscovery',
  'providers:pickExecutable',
  'instances:pickFolder',
  'instances:add',
  'instances:remove',
  'instances:openLoginTerminal',
  'instances:setupSandbox',
  'catalog:reload',
  'audio:list',
  'audio:rescan',
  'audio:ui',
  'avatars:list',
  'avatars:rescan',
  'avatars:family',
  'avatars:saveFamily',
  'avatars:copyFamily',
  'avatars:createFamily',
  'avatars:addAvatar',
  'avatars:replaceImage',
  'avatars:chooseImage',
  'avatars:noteDropped',
  'avatars:openFamilyFolder',
  'files:read',
  'files:refresh',
  'files:refreshImage',
  'files:showInFolder',
  'files:locate',
  'files:openFolder',
  'files:readImageForCopy',
  'shell:openLink',
  'shell:openAddress',
  'shell:showDataFolder',
  'pet:hide',
  'pet:setSize',
  'pet:open',
  'pet:showMain',
  'zoom:change',
  'diagnostics:dataResetInfo',
  'diagnostics:resetAllData',
  'app:quit',
  'app:answerQuit',
] as const;

/** Messages main sends to windows (`window.fatg.on`). */
export const PUSH_CHANNELS = ['audio:play', 'state:snapshot', 'prefs:changed', 'chat:message', 'plans:changed', 'plans:workflowChanged', 'reviews:changed', 'drafts:flush', 'sessions:reveal'] as const;

/**
 * The most bytes an image may hand over (M23, C79): the preload refuses a stage request whose view is
 * past it before anything is forwarded, and main checks it again. Equal to the attachments contract's
 * `MAX_IMAGE_BYTES`, which this dependency-free file cannot import (a test holds them equal).
 */
export const MAX_STAGE_BYTES = 5 * 1024 * 1024;

/**
 * Whether a stage request's bytes are within the bound (M23, C79): a view of at most MAX_STAGE_BYTES,
 * measured as the view itself, never an unchecked buffer behind it. What the preload asks before it
 * forwards; anything else of the request is main's to check.
 */
export function stageBytesWithin(request: unknown): boolean {
  return bytesWithin(request, ['bytes']);
}

/**
 * The channels whose requests carry an image's bytes, and the fields that hold them (M23, C79;
 * decision 0036): the preload measures each field as stageBytesWithin does, and forwards its own copy.
 * A field ending in `?` may be null instead.
 */
export const BYTE_FIELDS: Readonly<Partial<Record<InvokeChannel, readonly string[]>>> = {
  'attachments:stage': ['bytes'],
  'avatars:createFamily': ['portrait', 'small'],
  'avatars:addAvatar': ['portrait', 'small'],
  'avatars:replaceImage': ['portrait?', 'small'],
};

/** A byte field's name in a request, without its `?`. */
export const byteField = (field: string): string => field.replace(/\?$/, '');

/**
 * Whether each named field of a request is a view of at least one byte and at most MAX_STAGE_BYTES;
 * one named with `?` may be null instead.
 */
export function bytesWithin(request: unknown, fields: readonly string[]): boolean {
  if (typeof request !== 'object' || request === null) return false;
  return fields.every((field) => {
    const bytes = (request as Readonly<Record<string, unknown>>)[byteField(field)];
    if (bytes === null && field.endsWith('?')) return true;
    return bytes instanceof Uint8Array && bytes.byteLength >= 1 && bytes.byteLength <= MAX_STAGE_BYTES;
  });
}

/**
 * The channel only the preload sends (decision 0036): the folder of an image the user dropped, told
 * main by the file's path, which the page never holds. A page that names it itself is refused.
 */
export const PRELOAD_ONLY_CHANNELS: ReadonlySet<string> = new Set(['avatars:noteDropped']);

/** The kinds of window the app opens. IPC permissions are granted per kind. */
export const WINDOW_KINDS = ['main', 'pet'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type PushChannel = (typeof PUSH_CHANNELS)[number];
export type WindowKind = (typeof WINDOW_KINDS)[number];

const invokeChannels: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const pushChannels: ReadonlySet<string> = new Set(PUSH_CHANNELS);

export function isInvokeChannel(value: unknown): value is InvokeChannel {
  return typeof value === 'string' && invokeChannels.has(value);
}

export function isPushChannel(value: unknown): value is PushChannel {
  return typeof value === 'string' && pushChannels.has(value);
}
