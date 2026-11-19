// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { dataResetHandlers, type DataResetHandlerDeps } from './data-reset';
import type { AudioEvent } from '@shared/contracts/audio';
import type { AudioService } from '../../audio/service';
import { audioHandlers } from './audio';
// Every invoke handler, grouped by area (one file per area). The InvokeHandlers return type makes
// a channel without a handler a compile error.
import type { ZoomChange } from '@shared/contracts/zoom';
import type { ImageSource } from '../../avatars/image-source';
import type { AvatarService } from '../../avatars/service';
import type { PreferencesStore } from '../../prefs/store';
import type { RecordsStore } from '../../records/store';
import type { CatalogService } from '../../services/catalog-service';
import type { Removal } from '../../sessions/removal';
import type { SessionRuntime } from '../../sessions/runtime';
import type { Secretary } from '../../sessions/secretary/service';
import type { SessionService } from '../../sessions/service';
import type { AppStateStore } from '../../state/app-state-store';
import type { InvokeHandlers } from '../dispatch';
import { appHandlers } from './app';
import { attachmentHandlers } from './attachments';
import { artifactFileHandlers, type ArtifactFileDeps } from './artifact-files';
import { avatarHandlers } from './avatars';
import { catalogHandlers } from './catalog';
import { chatHandlers } from './chat';
import type { KindCounts } from './counts';
import { conversationsHandlers, type ConversationsHandlerDeps } from './conversations';
import { fileHandlers, type FileHandlerDeps } from './files';
import type { ReachesRunning } from './guards';
import { instanceHandlers, type InstanceHandlerDeps } from './instances';
import { type PetHandlerDeps, petHandlers } from './pet';
import { planHandlers, type PlanHandlerDeps } from './plans';
import { prefsHandlers } from './prefs';
import { reviewHandlers, type ReviewHandlerDeps } from './reviews';
import { projectHandlers, type ProjectHandlerDeps } from './projects';
import { recordsHandlers } from './records';
import { sessionHandlers } from './sessions';
import { sessionSearchHandlers } from './session-search';
import type { SessionSearch } from '../../sessions/search/service';
import { stateHandlers } from './state';
import { providerHandlers, type ProviderHandlerDependencies } from './providers';
import { shellHandlers, type ShellHandlerDeps } from './shell';
import { zoomHandlers } from './zoom';

export interface HandlerDeps extends Omit<ProviderHandlerDependencies, 'reachesRunning'>, ShellHandlerDeps, DataResetHandlerDeps {
  readonly audio: AudioService;
  readonly audioCue: (event: AudioEvent) => void;
  readonly store: AppStateStore;
  readonly prefs: PreferencesStore;
  readonly records: RecordsStore;
  readonly sessions: SessionService;
  readonly search: SessionSearch;
  /** The live sessions (M15): the chat channels are its five calls. */
  readonly runtime: Pick<SessionRuntime, 'read' | 'page' | 'readWorker' | 'send' | 'stop' | 'loadHistory' | 'ask' | 'readAside' | 'stopAside' | 'removeAside' | 'answer' | 'dismiss' | 'setMode' | 'decide' | 'draft' | 'stage' | 'setDraftPreset' | 'runningOn' | 'doing' | 'queue' | 'unqueue' | 'editQueued' | 'resumeQueue' | 'commands'>;
  /** The conversation store's channels (M18): its sizes, Start fresh, and the chats without a session. */
  readonly conversations: Omit<ConversationsHandlerDeps, 'records' | 'removal'>;
  /** A removal takes the saved chats with the records (M18, C21). */
  readonly removal: Pick<Removal, 'run' | 'detached'>;
  readonly catalog: Pick<CatalogService, 'reload'>;
  /** The Avatars tab's listing and Rescan (M102, C63). */
  readonly avatars: Pick<AvatarService, 'idle' | 'listing' | 'scan' | 'openFamily' | 'saveFamily' | 'copyFamily' | 'createFamily' | 'addAvatar' | 'replaceImage' | 'familyFolder'>;
  /** Browse for an avatar's image, and the folder a dropped one came from (decision 0036). */
  readonly avatarImages: Pick<ImageSource, 'choose' | 'noteDropped'>;
  /** The secretary (M26, round 2): `sessions:describeDraft` is its one channel. */
  readonly secretary?: Pick<Secretary, 'draft'>;
  /** A file opened from the chat (M19b): the reader, the file manager, and the counts by kind. */
  readonly files: FileHandlerDeps;
  readonly artifactFiles: ArtifactFileDeps;
  readonly projects: Omit<ProjectHandlerDeps, 'records' | 'hasProvider' | 'platform' | 'sessionRunning' | 'removing' | 'openFolder' | 'showInFolder'>;
  readonly instances: Omit<InstanceHandlerDeps, 'prefs' | 'registry' | 'platform' | 'sessionRunning' | 'accountBusy'>;
  /** What main says of a worker's read (M20a, C34): its outcome's kind, counted. Left out, the counts are the handlers' own. */
  readonly workerReads?: KindCounts;
  /** What main says of the asides (M20b, C33): each chat channel's outcomes, by kind. */
  readonly asides?: KindCounts;
  /** What main says of an answer and a dismissal (M21, C34): each outcome's kind, counted. */
  readonly answers?: KindCounts;
  /** What main says of a change of mode and a decision (M22, C26): each outcome's kind, counted. */
  readonly permissions?: KindCounts;
  /** What main says of a staging (M23, C75): each outcome's kind, counted. */
  readonly attachments?: KindCounts;
  /** The plans' six channels (M22b, C75): the plan service, the plan store and the runtime's decisions. */
  readonly plans: PlanHandlerDeps;
  /** The reviews' eight channels (M22e, C44): the review service, and the counts by kind. */
  readonly reviews: ReviewHandlerDeps;
  /** The Pet's asks (decision 0010): functions, because the WindowManager is created after the handlers. */
  readonly pet: PetHandlerDeps;
  /** The Main window's zoom, a step at a time (src/main/windows/zoom.ts). */
  readonly changeZoom: (to: ZoomChange) => void;
  /** `app.quit()`, the normal quit path. */
  readonly quit: () => void;
  /** The quit gate's answer (src/main/app/quit-gate.ts): false when no question is asked. */
  readonly answerQuit: (quit: boolean) => boolean;
  /** The page's answer to the draft flush's ask (src/main/app/draft-flush.ts; M23, C31): false when it names no open ask. */
  readonly draftsFlushed?: (token: number) => boolean;
}

export function createInvokeHandlers(deps: HandlerDeps): InvokeHandlers {
  const hasProvider = (id: string): boolean => deps.registry.has(id);
  // Whether an action would end the runtime of a session that is running, in a turn or on workers
  // alone (M15, C18, C99): the registry says which instances it reaches, the runtime which of them
  // runs a session on a process of its own.
  const reachesRunning: ReachesRunning = (action, ref) => deps.registry.reachOf(action, ref).some((reached) => deps.runtime.runningOn(reached));
  return {
    ...dataResetHandlers(deps),
    ...sessionSearchHandlers(deps.search),
    ...audioHandlers(deps.audio, deps.audioCue),
    ...stateHandlers(deps.store),
    ...prefsHandlers(deps.prefs, reachesRunning),
    ...recordsHandlers(deps.records),
    ...projectHandlers({
      ...deps.projects,
      openFolder: deps.files.openFolder,
      showInFolder: deps.files.showInFolder,
      records: deps.records,
      hasProvider,
      sessionRunning: (projectId) => deps.sessions.runningIn(projectId),
      removing: (projectId, write) => deps.sessions.removingProject(projectId, write),
      removal: deps.removal,
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    }),
    ...sessionHandlers({
      draftPreset: deps.runtime.setDraftPreset,
      sessions: deps.sessions,
      records: deps.records,
      store: deps.store,
      hasProvider,
      removal: deps.removal,
      ...(deps.secretary === undefined ? {} : { secretary: deps.secretary }),
      // What a running session does, for a Complete's or a Remove's refusal (M22e).
      doing: (id) => deps.runtime.doing(id),
    }),
    ...chatHandlers(deps.runtime, deps.workerReads, deps.asides, deps.answers, deps.permissions),
    ...attachmentHandlers(deps.runtime, deps.attachments),
    ...artifactFileHandlers(deps.artifactFiles, deps.files.showInFolder),
    ...planHandlers(deps.plans),
    ...reviewHandlers(deps.reviews),
    ...conversationsHandlers({ ...deps.conversations, records: deps.records, removal: deps.removal }),
    ...providerHandlers({ ...deps, reachesRunning }),
    ...instanceHandlers({
      ...deps.instances,
      prefs: deps.prefs,
      registry: deps.registry,
      sessionRunning: (ref) => deps.sessions.runningOn(ref),
      // A turn, a worker or an aside of the account, on a process of its own (M22, C62): no setup starts meanwhile.
      accountBusy: (ref) => deps.runtime.runningOn(ref),
      ...(deps.platform === undefined ? {} : { platform: deps.platform }),
    }),
    ...catalogHandlers(deps.catalog),
    ...avatarHandlers(deps.avatars, deps.files.openFolder, deps.avatarImages),
    ...fileHandlers(deps.files),
    ...shellHandlers(deps),
    ...petHandlers(deps.pet),
    ...zoomHandlers(deps.changeZoom),
    ...appHandlers({ quit: deps.quit, answerQuit: deps.answerQuit, ...(deps.draftsFlushed === undefined ? {} : { draftsFlushed: deps.draftsFlushed }) }),
  };
}
