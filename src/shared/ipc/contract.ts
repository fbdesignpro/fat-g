// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DataResetInfo, DataResetResult } from '../contracts/data-reset';
// THE typed IPC contract: for every channel, what goes in, what comes out, and which windows may
// call it. Main validates every request against INVOKE_SPECS before a handler sees it. The
// renderer and preload import TYPES from here only (lint-enforced for the preload, which must stay
// a dependency-free pipe).
//
// Adding an invoke channel:
//   1. name it in INVOKE_CHANNELS (channels.ts)
//   2. describe it in InvokeMap and INVOKE_SPECS below
//   3. handle it in src/main/ipc/handlers/
// The compiler rejects the build until all three agree. Channels without a payload take `null`.
import { z } from 'zod';
import { SessionSearchRequestSchema, type SessionSearchRequest, type SessionSearchResult } from '../contracts/session-search';
import { type AudioListing, type AudioPlay, type UiAudioEvent, UiAudioRequestSchema } from '../contracts/audio';
import type { AppStateSnapshot } from '../contracts/app-state';
import type { OverrideStatus } from '../contracts/catalog';
import {
  type ChatAnswerRequest,
  ChatAnswerRequestSchema,
  type ChatAnswerResult,
  type ChatAsideReadRequest,
  ChatAsideReadRequestSchema,
  type ChatAsideReadResult,
  type ChatAsideRemoveResult,
  type ChatAsideRequest,
  ChatAsideRequestSchema,
  type ChatAsideStopResult,
  type ChatAskRequest,
  ChatAskRequestSchema,
  type ChatAskResult,
  type ChatDecideRequest,
  ChatDecideRequestSchema,
  type ChatDecideResult,
  type ChatDismissRequest,
  ChatDismissRequestSchema,
  type ChatDismissResult,
  type ChatLoadHistoryResult,
  type ChatPageRequest,
  ChatPageRequestSchema,
  type ChatPageResult,
  type ChatPush,
  type ChatReadRequest,
  ChatReadRequestSchema,
  type ChatReadResult,
  type ChatSendRequest,
  ChatSendRequestSchema,
  type ChatSendResult,
  type ChatSessionRequest,
  ChatSessionRequestSchema,
  type ChatSetModeRequest,
  ChatSetModeRequestSchema,
  type ChatSetModeResult,
  type ChatStopResult,
  type ChatWorkerReadRequest,
  ChatWorkerReadRequestSchema,
  type ChatWorkerReadResult,
} from '../contracts/chat';
import {
  type ConversationsRefusal,
  type ConversationsSaved,
  type ConversationsStorage,
  type DetachedConversation,
  type DetachedReadRequest,
  DetachedReadRequestSchema,
  type DetachedRemoveRequest,
  DetachedRemoveRequestSchema,
  type SetAsideRemoved,
  type SetAsideRemoveRequest,
  SetAsideRemoveRequestSchema,
} from '../contracts/conversation';
import { type FileLocateAnswer, type FileReadAnswer, type FileReadRequest, type FileRefreshAnswer, type FileRefreshRequest, type FileShowRequest, IMAGE_FILE_ID, type ImageRefreshAnswer, type ImageRefreshRequest, MAX_ADDRESS_REQUEST, MAX_TARGET, type OpenAddressRequest } from '../contracts/files';
import {
  type InstanceAddRequest,
  InstanceAddRequestSchema,
  type InstanceAddResult,
  type InstancePickFolderRequest,
  InstancePickFolderRequestSchema,
  type InstancePickFolderResult,
  type InstanceRef,
  InstanceRefSchema,
  type InstanceRemoveRequest,
  InstanceRemoveRequestSchema,
  type InstanceLoginTerminalResult,
  type InstanceRemoveResult,
  type InstanceSetupSandboxRequest,
  InstanceSetupSandboxRequestSchema,
  type InstanceSetupSandboxResult,
} from '../contracts/instances';
import { PreferencesPatchSchema, type PreferencesPatch, type PreferencesPatchResult, type PreferencesSnapshot } from '../contracts/prefs';
import {
  type PickFolderResult,
  type ProjectAddRequest,
  ProjectAddRequestSchema,
  ProjectCheckRootsRequestSchema,
  type ProjectMoveRequest,
  ProjectMoveRequestSchema,
  type ProjectPickFolderRequest,
  ProjectPickFolderRequestSchema,
  type ProjectOpenFolderRequest,
  ProjectOpenFolderRequestSchema,
  type ProjectRefusal,
  type ProjectRemoveRequest,
  ProjectRemoveRequestSchema,
  type ProjectSaved,
  type ProjectSetHiddenRequest,
  ProjectSetHiddenRequestSchema,
  type ProjectSetCollapsedRequest,
  ProjectSetCollapsedRequestSchema,
  type ProjectUpdateRequest,
  ProjectUpdateRequestSchema,
} from '../contracts/projects';
import type { ProviderActionResult } from '../contracts/provider';
import {
  type AnswerQuitRequest,
  AnswerQuitRequestSchema,
  type AnswerQuitResult,
  type SessionCreated,
  type SessionCreateRequest,
  SessionCreateRequestSchema,
  type SessionSetDraftPresetRequest,
  SessionSetDraftPresetRequestSchema,
  type SessionDescribeDraftRequest,
  SessionDescribeDraftRequestSchema,
  type RunningDoing,
  type SessionDescribeResult,
  type SessionIdRequest,
  type SessionRemoveRequest,
  SessionIdRequestSchema,
  SessionRemoveRequestSchema,
  type SessionMoveRequest,
  SessionMoveRequestSchema,
  type SessionRefusal,
  type SessionSaved,
  type SessionSetEffortRequest,
  SessionSetEffortRequestSchema,
  type SessionSetSpeedRequest,
  SessionSetSpeedRequestSchema,
  type SessionSetFlagRequest,
  SessionSetFlagRequestSchema,
  type SessionRenameRequest,
  SessionRenameRequestSchema,
} from '../contracts/sessions';
import {
  type PlanBringRequest,
  PlanBringRequestSchema,
  type PlanBringResult,
  type PlanDecideRequest,
  PlanDecideRequestSchema,
  type PlanDecideResult,
  type PlanListRequest,
  PlanListRequestSchema,
  type PlanListResult,
  type PlanPush,
  type PlanReadRequest,
  PlanReadRequestSchema,
  type PlanReadResult,
  type PlanRemoveRequest,
  PlanRemoveRequestSchema,
  type PlanRemoveResult,
  type PlansStorage,
} from '../contracts/plans';
import { type PlanWorkflowRequest, PlanWorkflowRequestSchema, type PlanWorkflowResult, type WorkflowPush } from '../contracts/workflow';
import {
  type ReviewExplainRequest,
  ReviewExplainRequestSchema,
  type ReviewExplainResult,
  type ReviewIntegrateRequest,
  ReviewIntegrateRequestSchema,
  type ReviewIntegrateResult,
  type ReviewMarkRequest,
  ReviewMarkRequestSchema,
  type ReviewMarkResult,
  type ReviewNoteRequest,
  ReviewNoteRequestSchema,
  type ReviewNoteResult,
  type ReviewCloseRequest,
  ReviewCloseRequestSchema,
  type ReviewCloseResult,
  type ReviewPush,
  type ReviewReadRequest,
  ReviewReadRequestSchema,
  type ReviewReadResult,
  type ReviewSendRequest,
  ReviewSendRequestSchema,
  type ReviewSendResult,
  type ReviewStartRequest,
  ReviewStartRequestSchema,
  type ReviewStartResult,
} from '../contracts/review';
import type { RetryResult, StartFreshResult } from '../contracts/stored-file';
import { type AddAvatarAnswer, type AddAvatarRequest, AddAvatarRequestSchema, type ChooseImageAnswer, type CopyFamilyAnswer, type CreateFamilyAnswer, type CreateFamilyRequest, CreateFamilyRequestSchema, type FamilySource, type NoteDroppedRequest, NoteDroppedRequestSchema, type ReplaceImageAnswer, type ReplaceImageRequest, ReplaceImageRequestSchema, type SaveFamilyAnswer, type SaveFamilyRequest, SaveFamilyRequestSchema } from '../contracts/avatar-family';
import { type AvatarListing, type FamilyRef, FamilyRefSchema } from '../contracts/avatars';
import { type AttachmentCopySource, AttachmentHashSchema, type AttachmentStageRequest, AttachmentStageRequestSchema, type AttachmentStageResult } from '../contracts/attachments';
import {
  type ChatDraftRequest,
  ChatDraftRequestSchema,
  type ChatDraftResult,
  type ChatCommandsRequest,
  ChatCommandsRequestSchema,
  type ChatCommandsResult,
  type ChatEditQueuedRequest,
  ChatEditQueuedRequestSchema,
  type ChatQueueRequest,
  ChatQueueRequestSchema,
  type ChatQueueResult,
  type ChatResumeQueueRequest,
  ChatResumeQueueRequestSchema,
  type ChatUnqueueRequest,
  ChatUnqueueRequestSchema,
  type DraftFlushedRequest,
  DraftFlushedRequestSchema,
  type DraftFlushedResult,
  type DraftFlushPush,
} from '../contracts/composer';
import { type PetSizeRequest, PetSizeRequestSchema, type SessionRevealPush } from '../contracts/pet';
import { type ZoomChangeRequest, ZoomChangeRequestSchema } from '../contracts/zoom';
import type { InvokeChannel, PushChannel, WindowKind } from './channels';

/** Which of fat-g's folders Show opens: its data folder, or the plans in it (M22b, C21). */
export type ShowDataFolderRequest = null | { readonly folder: 'plans' | 'avatars' | 'audio' };

export interface InvokeMap {
  'audio:list': { request: null; response: AudioListing };
  'audio:rescan': { request: null; response: AudioListing };
  'audio:ui': { request: { readonly event: UiAudioEvent }; response: null };
  'state:getSnapshot': { request: null; response: AppStateSnapshot };
  'prefs:get': { request: null; response: PreferencesSnapshot };
  'prefs:patch': { request: PreferencesPatch; response: PreferencesPatchResult };
  'prefs:startFresh': { request: null; response: StartFreshResult };
  'prefs:retry': { request: null; response: RetryResult };
  'records:startFresh': { request: null; response: StartFreshResult };
  'records:retry': { request: null; response: RetryResult };
  'projects:pickFolder': { request: ProjectPickFolderRequest; response: PickFolderResult };
  'projects:openFolder': { request: ProjectOpenFolderRequest; response: null };
  'projects:add': { request: ProjectAddRequest; response: { status: 'saved'; id: string } | ProjectRefusal };
  'projects:update': { request: ProjectUpdateRequest; response: ProjectSaved | ProjectRefusal };
  'projects:setHidden': { request: ProjectSetHiddenRequest; response: ProjectSaved | ProjectRefusal };
  'projects:setCollapsed': { request: ProjectSetCollapsedRequest; response: ProjectSaved | ProjectRefusal };
  'projects:move': { request: ProjectMoveRequest; response: ProjectSaved | ProjectRefusal };
  'projects:remove': { request: ProjectRemoveRequest; response: ProjectSaved | ProjectRefusal };
  'projects:checkRoots': { request: { id: string }; response: null };
  'sessions:create': { request: SessionCreateRequest; response: SessionCreated | SessionRefusal };
  'sessions:setDraftPreset': { request: SessionSetDraftPresetRequest; response: SessionSaved | SessionRefusal };
  'sessions:select': { request: SessionIdRequest; response: SessionSaved | SessionRefusal };
  'sessions:search': { request: SessionSearchRequest; response: SessionSearchResult };
  'sessions:closeSearch': { request: null; response: null };
  'sessions:acknowledge': { request: SessionIdRequest; response: SessionSaved | SessionRefusal };
  'sessions:setFlag': { request: SessionSetFlagRequest; response: SessionSaved | SessionRefusal };
  'sessions:rename': { request: SessionRenameRequest; response: SessionSaved | SessionRefusal };
  'sessions:describeDraft': { request: SessionDescribeDraftRequest; response: SessionDescribeResult };
  'sessions:complete': { request: SessionIdRequest; response: SessionSaved | SessionRefusal };
  'sessions:shelve': { request: SessionIdRequest; response: SessionSaved | SessionRefusal };
  /** Back to the active list, from the shelf or from the completed ones: the page's Unshelve and Restore. */
  'sessions:restore': { request: SessionIdRequest; response: SessionSaved | SessionRefusal };
  /** What a running session is doing (M22e), a kind alone: what the page's notice says before a Remove; null for one that does not run. */
  'sessions:doing': { request: SessionIdRequest; response: { readonly status: 'read'; readonly doing: RunningDoing | null } | SessionRefusal };
  'sessions:move': { request: SessionMoveRequest; response: SessionSaved | SessionRefusal };
  'sessions:setEffort': { request: SessionSetEffortRequest; response: SessionSaved | SessionRefusal };
  /** The speed tier its next turns ask for, or null for standard speed (decision 0016). */
  'sessions:setSpeed': { request: SessionSetSpeedRequest; response: SessionSaved | SessionRefusal };
  'sessions:remove': { request: SessionRemoveRequest; response: SessionSaved | SessionRefusal };
  'sessions:removeOrphans': { request: null; response: SessionSaved | SessionRefusal };
  'chat:read': { request: ChatReadRequest; response: ChatReadResult };
  'chat:page': { request: ChatPageRequest; response: ChatPageResult };
  'chat:readWorker': { request: ChatWorkerReadRequest; response: ChatWorkerReadResult };
  'chat:send': { request: ChatSendRequest; response: ChatSendResult };
  'chat:stop': { request: ChatSessionRequest; response: ChatStopResult };
  'chat:loadHistory': { request: ChatSessionRequest; response: ChatLoadHistoryResult };
  'chat:ask': { request: ChatAskRequest; response: ChatAskResult };
  'chat:readAside': { request: ChatAsideReadRequest; response: ChatAsideReadResult };
  'chat:stopAside': { request: ChatAsideRequest; response: ChatAsideStopResult };
  'chat:removeAside': { request: ChatAsideRequest; response: ChatAsideRemoveResult };
  'chat:answer': { request: ChatAnswerRequest; response: ChatAnswerResult };
  'chat:dismiss': { request: ChatDismissRequest; response: ChatDismissResult };
  'chat:setMode': { request: ChatSetModeRequest; response: ChatSetModeResult };
  'chat:decide': { request: ChatDecideRequest; response: ChatDecideResult };
  'chat:draft': { request: ChatDraftRequest; response: ChatDraftResult };
  'chat:queue': { request: ChatQueueRequest; response: ChatQueueResult };
  'chat:unqueue': { request: ChatUnqueueRequest; response: ChatQueueResult };
  'chat:editQueued': { request: ChatEditQueuedRequest; response: ChatQueueResult };
  'chat:resumeQueue': { request: ChatResumeQueueRequest; response: ChatQueueResult };
  'chat:commands': { request: ChatCommandsRequest; response: ChatCommandsResult };
  'drafts:flushed': { request: DraftFlushedRequest; response: DraftFlushedResult };
  'attachments:stage': { request: AttachmentStageRequest; response: AttachmentStageResult };
  'attachments:readForCopy': { request: { hash: string }; response: AttachmentCopySource | null };
  'attachments:showInFolder': { request: { hash: string }; response: null };
  'plans:read': { request: PlanReadRequest; response: PlanReadResult };
  'plans:list': { request: PlanListRequest; response: PlanListResult };
  'plans:remove': { request: PlanRemoveRequest; response: PlanRemoveResult };
  'plans:decide': { request: PlanDecideRequest; response: PlanDecideResult };
  'plans:bring': { request: PlanBringRequest; response: PlanBringResult };
  'plans:storage': { request: null; response: PlansStorage };
  'plans:workflow': { request: PlanWorkflowRequest; response: PlanWorkflowResult };
  'reviews:start': { request: ReviewStartRequest; response: ReviewStartResult };
  'reviews:mark': { request: ReviewMarkRequest; response: ReviewMarkResult };
  'reviews:note': { request: ReviewNoteRequest; response: ReviewNoteResult };
  'reviews:send': { request: ReviewSendRequest; response: ReviewSendResult };
  'reviews:explain': { request: ReviewExplainRequest; response: ReviewExplainResult };
  'reviews:integrate': { request: ReviewIntegrateRequest; response: ReviewIntegrateResult };
  'reviews:close': { request: ReviewCloseRequest; response: ReviewCloseResult };
  'reviews:read': { request: ReviewReadRequest; response: ReviewReadResult };
  'conversations:storage': { request: null; response: ConversationsStorage };
  'conversations:startFresh': { request: null; response: StartFreshResult };
  'conversations:listDetached': { request: null; response: readonly DetachedConversation[] };
  'conversations:readDetached': { request: DetachedReadRequest; response: ChatPageResult | ConversationsRefusal };
  'conversations:removeDetached': { request: DetachedRemoveRequest; response: ConversationsSaved | ConversationsRefusal };
  'conversations:removeSetAside': { request: SetAsideRemoveRequest; response: SetAsideRemoved | ConversationsRefusal };
  'providers:refresh': { request: InstanceRef; response: ProviderActionResult };
  'providers:redetect': { request: InstanceRef; response: ProviderActionResult };
  'providers:discover': { request: null; response: null };
  'providers:acknowledgeDiscovery': { request: { revision: number }; response: boolean };
  'providers:pickExecutable': {
    request: { providerId: string };
    response:
      | { status: 'selected' }
      | { status: 'cancelled' }
      | { status: 'refused'; reason: 'preferences-blocked' | 'busy' | 'stale-selection' | 'unsupported-path' | 'session-running' };
  };
  'instances:pickFolder': { request: InstancePickFolderRequest; response: InstancePickFolderResult };
  'instances:add': { request: InstanceAddRequest; response: InstanceAddResult };
  'instances:remove': { request: InstanceRemoveRequest; response: InstanceRemoveResult };
  'instances:openLoginTerminal': { request: InstanceRef; response: InstanceLoginTerminalResult };
  'instances:setupSandbox': { request: InstanceSetupSandboxRequest; response: InstanceSetupSandboxResult };
  'catalog:reload': { request: null; response: OverrideStatus };
  'avatars:list': { request: null; response: AvatarListing };
  'avatars:rescan': { request: null; response: null };
  'avatars:family': { request: FamilyRef; response: FamilySource | null };
  'avatars:saveFamily': { request: SaveFamilyRequest; response: SaveFamilyAnswer };
  'avatars:copyFamily': { request: FamilyRef; response: CopyFamilyAnswer };
  'avatars:createFamily': { request: CreateFamilyRequest; response: CreateFamilyAnswer };
  'avatars:addAvatar': { request: AddAvatarRequest; response: AddAvatarAnswer };
  'avatars:replaceImage': { request: ReplaceImageRequest; response: ReplaceImageAnswer };
  'avatars:chooseImage': { request: null; response: ChooseImageAnswer };
  'avatars:noteDropped': { request: NoteDroppedRequest; response: null };
  'avatars:openFamilyFolder': { request: FamilyRef; response: null };
  'files:read': { request: FileReadRequest; response: FileReadAnswer };
  'files:refresh': { request: FileRefreshRequest; response: FileRefreshAnswer };
  'files:refreshImage': { request: ImageRefreshRequest; response: ImageRefreshAnswer };
  'files:showInFolder': { request: FileShowRequest; response: null };
  'files:locate': { request: FileReadRequest; response: FileLocateAnswer };
  'files:openFolder': { request: FileReadRequest; response: null };
  /** An image file's bytes for Copy (decision 0022, item 15), by the id its read gave it: checked again, transient. */
  'files:readImageForCopy': { request: { sessionId: string; id: string }; response: AttachmentCopySource | null };
  'shell:openLink': { request: { providerId: string }; response: null };
  'shell:openAddress': { request: OpenAddressRequest; response: null };
  'shell:showDataFolder': { request: ShowDataFolderRequest; response: null };
  'pet:hide': { request: null; response: null };
  'pet:setSize': { request: PetSizeRequest; response: null };
  'pet:open': { request: SessionIdRequest; response: null };
  'pet:showMain': { request: null; response: null };
  'zoom:change': { request: ZoomChangeRequest; response: null };
  'diagnostics:dataResetInfo': { request: null; response: DataResetInfo };
  'diagnostics:resetAllData': { request: null; response: DataResetResult };
  'app:quit': { request: null; response: null };
  'app:answerQuit': { request: AnswerQuitRequest; response: AnswerQuitResult };
}

export interface PushMap {
  'audio:play': AudioPlay;
  'state:snapshot': AppStateSnapshot;
  'prefs:changed': PreferencesSnapshot;
  'chat:message': ChatPush;
  'plans:changed': PlanPush;
  'plans:workflowChanged': WorkflowPush;
  'reviews:changed': ReviewPush;
  'drafts:flush': DraftFlushPush;
  'sessions:reveal': SessionRevealPush;
}

export type InvokeRequest<C extends InvokeChannel> = InvokeMap[C]['request'];
export type InvokeResponse<C extends InvokeChannel> = InvokeMap[C]['response'];

export interface InvokeSpec<Request> {
  /** Parses the raw payload. Nothing that arrives over IPC is trusted until this passes. */
  readonly request: z.ZodType<Request>;
  /** Window kinds allowed to call the channel. */
  readonly from: readonly WindowKind[];
}

/** Annotated as a mapped type, so a channel without a spec (or a spec for no channel) fails to compile. */
export const INVOKE_SPECS: { readonly [C in InvokeChannel]: InvokeSpec<InvokeRequest<C>> } = {
  'audio:list': { request: z.null(), from: ['main'] },
  'audio:rescan': { request: z.null(), from: ['main'] },
  'audio:ui': { request: UiAudioRequestSchema, from: ['main', 'pet'] },
  'state:getSnapshot': { request: z.null(), from: ['main', 'pet'] },
  // Preferences are the Main window's business. The Pet window is always on top and shows up in
  // screen shares, and `providers[id].executablePath` is a path with the user's name in it — so it
  // receives none of this, structurally rather than by convention (docs/planning/_archive/phase-1/phase-1-m3.md).
  'prefs:get': { request: z.null(), from: ['main'] },
  'prefs:patch': { request: PreferencesPatchSchema, from: ['main'] },
  // Settings' note for a refused preferences file (M12, C64, C81): move it aside, or read it again.
  'prefs:startFresh': { request: z.null(), from: ['main'] },
  'prefs:retry': { request: z.null(), from: ['main'] },
  // Projects are the Main window's too, and for the same reason: root paths hold the user's name,
  // and the Pet shows on screen shares (M12, C52, C53, C82). Every path main accepts as a root came
  // from its own folder picker, or from the project's saved record — never from the page (C23).
  'records:startFresh': { request: z.null(), from: ['main'] },
  'records:retry': { request: z.null(), from: ['main'] },
  'projects:pickFolder': { request: ProjectPickFolderRequestSchema, from: ['main'] },
  'projects:openFolder': { request: ProjectOpenFolderRequestSchema, from: ['main'] },
  'projects:add': { request: ProjectAddRequestSchema, from: ['main'] },
  'projects:update': { request: ProjectUpdateRequestSchema, from: ['main'] },
  'projects:setHidden': { request: ProjectSetHiddenRequestSchema, from: ['main'] },
  'projects:setCollapsed': { request: ProjectSetCollapsedRequestSchema, from: ['main'] },
  'projects:move': { request: ProjectMoveRequestSchema, from: ['main'] },
  'projects:remove': { request: ProjectRemoveRequestSchema, from: ['main'] },
  'projects:checkRoots': { request: ProjectCheckRootsRequestSchema, from: ['main'] },
  // Sessions are the Main window's too (M14, C31, C65): a session's name, and the folder its record
  // holds, are the user's own. The Pet gets a view of the sessions running or waiting on the user and
  // may change none (decision 0010): a press there opens its session through the Main window's own
  // page (`pet:open`), so `sessions:acknowledge` is called by no window.
  'sessions:create': { request: SessionCreateRequestSchema, from: ['main'] },
  'sessions:setDraftPreset': { request: SessionSetDraftPresetRequestSchema, from: ['main'] },
  'sessions:select': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:search': { request: SessionSearchRequestSchema, from: ['main'] },
  'sessions:closeSearch': { request: z.null(), from: ['main'] },
  'sessions:acknowledge': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:setFlag': { request: SessionSetFlagRequestSchema, from: ['main'] },
  'sessions:rename': { request: SessionRenameRequestSchema, from: ['main'] },
  'sessions:describeDraft': { request: SessionDescribeDraftRequestSchema, from: ['main'] },
  'sessions:complete': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:shelve': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:restore': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:doing': { request: SessionIdRequestSchema, from: ['main'] },
  'sessions:move': { request: SessionMoveRequestSchema, from: ['main'] },
  'sessions:setEffort': { request: SessionSetEffortRequestSchema, from: ['main'] },
  'sessions:setSpeed': { request: SessionSetSpeedRequestSchema, from: ['main'] },
  'sessions:remove': { request: SessionRemoveRequestSchema, from: ['main'] },
  'sessions:removeOrphans': { request: z.null(), from: ['main'] },
  // A session's conversation (M15, C54, C76): the Main window's only. A prompt and a message are the
  // user's own, and the Pet shows on screen shares, so it may read none and send none. The page names
  // a session and gives a prompt; why one cannot be taken is worked out in main again (C105).
  'chat:read': { request: ChatReadRequestSchema, from: ['main'] },
  'chat:page': { request: ChatPageRequestSchema, from: ['main'] },
  // A worker's conversation (M20a, C32): what a sub-agent said and did, which is conversation content
  // as the session's own is. The Main window's only, for the same reason.
  'chat:readWorker': { request: ChatWorkerReadRequestSchema, from: ['main'] },
  'chat:send': { request: ChatSendRequestSchema, from: ['main'] },
  'chat:stop': { request: ChatSessionRequestSchema, from: ['main'] },
  'chat:loadHistory': { request: ChatSessionRequestSchema, from: ['main'] },
  // A question beside a session, and its aside (M20b, C73; decision 0025): a question, the passage it
  // is about, its answers and what a provider's side thread did are conversation content, as the
  // session's own is. The Main window's only, for the same reason. The page names the session and
  // the aside, whose id it made for a new tab; whether the ask can be taken, and whether the same
  // selection already has an aside, is worked out in main.
  'chat:ask': { request: ChatAskRequestSchema, from: ['main'] },
  'chat:readAside': { request: ChatAsideReadRequestSchema, from: ['main'] },
  'chat:stopAside': { request: ChatAsideRequestSchema, from: ['main'] },
  'chat:removeAside': { request: ChatAsideRequestSchema, from: ['main'] },
  // An answer to a question the session asked, and an async card's dismissal (M21, C31; decision
  // 0026): a question, its options and an answer are conversation content, and a secret's answer is
  // typed here. The Main window's only. The page names the session and the card's item, never a
  // request; whether it can still be answered, and whether the answer fits, is worked out in main.
  'chat:answer': { request: ChatAnswerRequestSchema, from: ['main'] },
  'chat:dismiss': { request: ChatDismissRequestSchema, from: ['main'] },
  // A chat's mode, and a decision on an approval's card (M22, C88; decision 0027): what a session
  // may do, and leave for one action of it — a command line, a file's content and a grant are
  // conversation content. The Main window's only. The page names the session and a mode's id, or
  // the card's item and one of its choices, never a request, a tool's input or a native word;
  // whether the mode can be used, and whether the choice was offered, is worked out in main.
  'chat:setMode': { request: ChatSetModeRequestSchema, from: ['main'] },
  'chat:decide': { request: ChatDecideRequestSchema, from: ['main'] },
  // A session's draft and an image staged into it (M23, C14, C31, C79, C86; decision 0030): a draft's
  // text and an image the user pasted or dropped are conversation content. The Main window's only. The
  // page names the session, hands over bytes it read with the File API and a dropped file's name, and
  // names an image of the draft by its use's id — never a path or a hash it could borrow another
  // session's image by; what the bytes are, and whether they are kept, is worked out in main.
  'chat:draft': { request: ChatDraftRequestSchema, from: ['main'] },
  // The queue (M23, C47–C51, C86, C89): its messages are conversation content, the Main window's alone.
  'chat:queue': { request: ChatQueueRequestSchema, from: ['main'] },
  'chat:unqueue': { request: ChatUnqueueRequestSchema, from: ['main'] },
  'chat:editQueued': { request: ChatEditQueuedRequestSchema, from: ['main'] },
  'chat:resumeQueue': { request: ChatResumeQueueRequestSchema, from: ['main'] },
  // The menu's rows (M23, C86): the Main window's alone, with main's selectors and no path.
  'chat:commands': { request: ChatCommandsRequestSchema, from: ['main'] },
  // The page's answer to main's ask for its unsent drafts (M23, C31).
  'drafts:flushed': { request: DraftFlushedRequestSchema, from: ['main'] },
  'attachments:stage': { request: AttachmentStageRequestSchema, from: ['main'] },
  'attachments:readForCopy': { request: z.strictObject({ hash: AttachmentHashSchema }), from: ['main'] },
  'attachments:showInFolder': { request: z.strictObject({ hash: AttachmentHashSchema }), from: ['main'] },
  // Plans (M22b, C20, C75; decision 0029): a plan's text and title are project content, the chat that
  // made it the user's own. The Main window's only. The page names a plan, a version, a range, a
  // session and its plan's line, never a path; whether a plan is the chat's project's, whether its
  // version is complete with the hash the list showed, and whether a decision is still the user's to
  // take, is worked out in main.
  'plans:read': { request: PlanReadRequestSchema, from: ['main'] },
  'plans:list': { request: PlanListRequestSchema, from: ['main'] },
  'plans:remove': { request: PlanRemoveRequestSchema, from: ['main'] },
  'plans:decide': { request: PlanDecideRequestSchema, from: ['main'] },
  'plans:bring': { request: PlanBringRequestSchema, from: ['main'] },
  'plans:storage': { request: z.null(), from: ['main'] },
  // A chat's part in its plan's shared workflow (decision 0029): which plan, its state, and who holds it — ids and names, never a text.
  'plans:workflow': { request: PlanWorkflowRequestSchema, from: ['main'] },
  // Plan review (M22e, C44; decision 0029): a review's findings, marks and notes are project content,
  // kept with their plan. The Main window's only. The page names a session, a plan and its version, a
  // review, a finding or a tier, a mark, a note, a target and where a finding's row lies in its
  // drawing, never a path or a prompt; whether a review can start, what a round holds, what a
  // target's route is and what each prompt sends is worked out in main.
  'reviews:start': { request: ReviewStartRequestSchema, from: ['main'] },
  'reviews:mark': { request: ReviewMarkRequestSchema, from: ['main'] },
  'reviews:note': { request: ReviewNoteRequestSchema, from: ['main'] },
  'reviews:send': { request: ReviewSendRequestSchema, from: ['main'] },
  'reviews:explain': { request: ReviewExplainRequestSchema, from: ['main'] },
  'reviews:integrate': { request: ReviewIntegrateRequestSchema, from: ['main'] },
  'reviews:close': { request: ReviewCloseRequestSchema, from: ['main'] },
  'reviews:read': { request: ReviewReadRequestSchema, from: ['main'] },
  // The conversation store (M18, C23, C24): its sizes, Start fresh for a store fat-g refused, and the
  // conversations no listed session has — listed by their first prompt, read a page at a time and
  // removed only when the user asks (C31, C32, C35). A set-aside store is named as Start fresh named
  // it, and by nothing else (C41). All of it is a conversation's text or a file's name: the Main
  // window's only.
  'conversations:storage': { request: z.null(), from: ['main'] },
  'conversations:startFresh': { request: z.null(), from: ['main'] },
  'conversations:listDetached': { request: z.null(), from: ['main'] },
  'conversations:readDetached': { request: DetachedReadRequestSchema, from: ['main'] },
  'conversations:removeDetached': { request: DetachedRemoveRequestSchema, from: ['main'] },
  'conversations:removeSetAside': { request: SetAsideRemoveRequestSchema, from: ['main'] },
  // A read and a reconnect name one instance of a provider (M14b, C21): they reach it alone.
  'providers:refresh': { request: InstanceRefSchema, from: ['main'] },
  'providers:redetect': { request: InstanceRefSchema, from: ['main'] },
  'providers:discover': { request: z.null(), from: ['main'] },
  'providers:acknowledgeDiscovery': { request: z.object({ revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(), from: ['main'] },
  'providers:pickExecutable': { request: z.strictObject({ providerId: z.string().min(1).max(128) }), from: ['main'] },
  // A provider's accounts (M14b, C21). The Main window's only: an account's label and its folder's
  // path are the user's own, and the Pet shows on screen shares (C50). Picking and saving are two
  // steps, so Cancel after a pick leaves nothing stored and nothing started; every folder main
  // accepts came from its own picker in this run (C14). A rename and a switch go through prefs:patch.
  'instances:pickFolder': { request: InstancePickFolderRequestSchema, from: ['main'] },
  'instances:add': { request: InstanceAddRequestSchema, from: ['main'] },
  'instances:remove': { request: InstanceRemoveRequestSchema, from: ['main'] },
  'instances:openLoginTerminal': { request: InstanceRefSchema, from: ['main'] },
  // The CLI's own sandbox setup for one account (M22, C60, C88): it changes the machine, so it is
  // sent at the user's press alone. The Main window's only; the request names an account and an action.
  'instances:setupSandbox': { request: InstanceSetupSandboxRequestSchema, from: ['main'] },
  // Settings' Models section (M13, C51, C58): reads catalog.json again and answers its status. The
  // catalog, and the path in that status, are the Main window's only.
  'catalog:reload': { request: z.null(), from: ['main'] },
  // The Avatars tab (M102, C63): the listing of both roots, and a Rescan that answers once its scan
  // has landed. The Main window's only: the Pet receives nothing of avatars (C35).
  'avatars:list': { request: z.null(), from: ['main'] },
  'avatars:rescan': { request: z.null(), from: ['main'] },
  // The family editor (decisions 0031, 0032): a family as its file holds it, and a draft saved into
  // that file, plus Make a copy into a new user family. The page names the family and its avatars'
  // folders, never a path; main checks its scan and refuses writes to installed built-in artwork.
  // Add avatar and an image replaced (decision 0036) hand main the PNGs the page made, which main checks
  // by their headers; Browse answers an image's name and bytes, never its path; a dropped file's path
  // comes from the preload alone, which refuses the page that names one.
  'avatars:family': { request: FamilyRefSchema, from: ['main'] },
  'avatars:saveFamily': { request: SaveFamilyRequestSchema, from: ['main'] },
  'avatars:copyFamily': { request: FamilyRefSchema, from: ['main'] },
  'avatars:createFamily': { request: CreateFamilyRequestSchema, from: ['main'] },
  'avatars:addAvatar': { request: AddAvatarRequestSchema, from: ['main'] },
  'avatars:replaceImage': { request: ReplaceImageRequestSchema, from: ['main'] },
  'avatars:chooseImage': { request: z.null(), from: ['main'] },
  'avatars:noteDropped': { request: NoteDroppedRequestSchema, from: ['main'] },
  'avatars:openFamilyFolder': { request: FamilyRefSchema, from: ['main'] },
  // A file opened from the chat (M19b, C25, C43; decision 0022): the Main window's only, since a
  // file's text and its path are the user's own. The page names a session and a target, an address as
  // a message wrote it; it names no base folder, and main resolves, confines and reads. Show in folder
  // takes the path a tab holds, which main checks the same way.
  'files:read': { request: z.strictObject({ sessionId: z.guid(), target: z.string().min(1).max(MAX_TARGET), from: z.string().min(1).max(MAX_TARGET).optional() }), from: ['main'] },
  'files:refresh': { request: z.strictObject({ sessionId: z.guid(), path: z.string().min(1).max(MAX_TARGET), revision: z.strictObject({ mtimeMs: z.number().finite(), size: z.number().int().nonnegative() }).nullable() }), from: ['main'] },
  'files:refreshImage': { request: z.strictObject({ sessionId: z.guid(), path: z.string().min(1).max(MAX_TARGET), id: z.string().regex(IMAGE_FILE_ID) }), from: ['main'] },
  'files:showInFolder': { request: z.strictObject({ sessionId: z.guid(), path: z.string().min(1).max(MAX_TARGET) }), from: ['main'] },
  // A reference's place and a folder it names (decision 0022): the same claim as a read's. Main
  // answers the real path of the file or folder it leads to, and opens a folder in the file manager
  // after the same checks; a file is never opened by them.
  'files:locate': { request: z.strictObject({ sessionId: z.guid(), target: z.string().min(1).max(MAX_TARGET), from: z.string().min(1).max(MAX_TARGET).optional() }), from: ['main'] },
  'files:openFolder': { request: z.strictObject({ sessionId: z.guid(), target: z.string().min(1).max(MAX_TARGET), from: z.string().min(1).max(MAX_TARGET).optional() }), from: ['main'] },
  'files:readImageForCopy': { request: z.strictObject({ sessionId: z.guid(), id: z.string().regex(IMAGE_FILE_ID) }), from: ['main'] },
  // A provider's installation guide (M13, C25): the page names a registered provider, and main opens
  // the address that provider's module gives. No URL crosses this channel.
  'shell:openLink': { request: z.strictObject({ providerId: z.string().min(1).max(128) }), from: ['main'] },
  // An address a message or a file wrote (M19b, C44; amends M13, C25): the one channel an address
  // crosses. Main hands it to the system's browser only as a parsed `http:` or `https:` URL with no
  // credentials; the bound here is wider than main's, so an address over main's is refused and counted.
  'shell:openAddress': { request: z.strictObject({ address: z.string().min(1).max(MAX_ADDRESS_REQUEST) }), from: ['main'] },
  // fat-g's data folder in the file manager (M13, C59), or its plans folder (M22b, C21, C75). Main
  // names the folder, never the page: the page names which of the two.
  // Or its avatars folder (M102, C40, C63), which main creates empty where it is missing.
  'shell:showDataFolder': { request: z.union([z.null(), z.strictObject({ folder: z.enum(['plans', 'avatars', 'audio']) })]), from: ['main'] },
  // The Pet's × hides it and remembers that; showing it again is the Main window's job through
  // prefs:patch (Settings or the title toggle).
  'pet:hide': { request: z.null(), from: ['pet'] },
  // The Pet's size toggle (decision 0010): main keeps it in the preferences and the Pet's view.
  'pet:setSize': { request: PetSizeRequestSchema, from: ['pet'] },
  // A press on a session in the Pet (decision 0010): main brings the Main window forward and asks its
  // page to open the session (`sessions:reveal`), as a press on its capsule there would. An id that
  // names no active session opens nothing.
  'pet:open': { request: SessionIdRequestSchema, from: ['pet'] },
  // The empty Pet's content brings Main forward without selecting a session.
  'pet:showMain': { request: z.null(), from: ['pet'] },
  // The Main window's zoom, a step at a time or back to 100%: the title strip's indicator and the
  // Appearance tab's buttons. Main applies it and the app state carries the result back.
  'zoom:change': { request: ZoomChangeRequestSchema, from: ['main'] },
  // The menu's Exit (M11). Main takes its normal quit path: process cleanup and the final saves. It
  // only starts a quit: while a session runs, main asks first (M14, C76, C101).
  'diagnostics:dataResetInfo': { request: z.null(), from: ['main'] },
  'diagnostics:resetAllData': { request: z.null(), from: ['main'] },
  'app:quit': { request: z.null(), from: ['main'] },
  // The page's answer to that question (M14, C101): refused while none is asked.
  'app:answerQuit': { request: AnswerQuitRequestSchema, from: ['main'] },
};

// Compile-time proof that InvokeMap and PushMap cover exactly the channels named in channels.ts.
type Assert<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _InvokeMapMatchesChannels = Assert<SameKeys<keyof InvokeMap, InvokeChannel>>;
type _PushMapMatchesChannels = Assert<SameKeys<keyof PushMap, PushChannel>>;
