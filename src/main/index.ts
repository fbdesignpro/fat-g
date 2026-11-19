// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createDataReset } from './app/data-reset';
import { allowsReady, createAudioNotifications } from './audio/notifications';
import { AUDIO_FOLDER, type AudioPlay } from '@shared/contracts/audio';
import { createAudioService } from './audio/service';
import { nodeAudioFs } from './audio/fs';
import { createAudioCues } from './audio/cues';
import path from 'node:path';
import os from 'node:os';
import { app, dialog, Menu, powerMonitor, session, shell, type OpenDialogOptions } from 'electron';
import { unavailable } from '@shared/contracts/availability';
import { modelListed } from '@shared/contracts/catalog';
import { chatCapability } from '@shared/contracts/conversation';
import { FIRST_INSTANCE_ID, type InstanceRef } from '@shared/contracts/instances';
import { modeOf, type PermissionCapability } from '@shared/contracts/permissions';
import { petContentSize } from '@shared/contracts/pet';
import { PLANS_FOLDER, type PlanPush } from '@shared/contracts/plans';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { AVATARS_FOLDER } from '@shared/contracts/avatars';
import { boundedLabel, NO_LABEL, readModelLabel } from '@shared/contracts/avatar-overlay';
import { createBlobFiles } from './attachments/files';
import { createAttachmentImageFiles } from './attachments/file-images';
import { createAvatarResolver, followAvatarChanges } from './avatars/assignments';
import { createChatPresentation } from './avatars/chat-presentation';
import { nodeAvatarFs } from './avatars/fs';
import { createImageSource } from './avatars/image-source';
import { createAvatarService } from './avatars/service';
import { createAttachmentSource } from './media/attachments';
import { createAvatarSource } from './media/avatars';
import { createImageFileSource } from './media/files';
import { createMediaRoute } from './media/route';
import { regularOwnedFile } from './storage/owned-file';
import type { ReviewPush } from '@shared/contracts/review';
import { isActive } from '@shared/contracts/sessions';
import type { WorkflowPush } from '@shared/contracts/workflow';
import { buildCsp } from './app/csp';
import { installLifecycle } from './app/lifecycle';
import { applicationMenuTemplate } from './app/menu';
import { devServerSwitches, resolveTrustedOrigins } from './app/origins';
import { handleAppProtocol, registerAppScheme } from './app/protocol';
import { hardenSession, hardenWebContents } from './app/security';
import { demoFixture, demoSessions, isLiveSmokeRun, isSmokeRun, isStreamForm, smokeScenario } from './app/flavor';
import { appUserModelId, userDataOverride } from './app/identity';
// Types only (erased): the smoke modules themselves load dynamically, and only in builds with them.
import type * as SmokeCheck from './app/smoke';
import type * as SmokeDialogs from './app/smoke-dialogs';
import type * as SmokeProviders from './app/smoke-providers';
import type * as SmokeLive from './app/smoke-live';
// Type only as well: the demo source loads dynamically, and only in builds with the hooks (M14, C27).
import type { DemoSource } from './sessions/demo-source';
// And its stream form (M19, C63).
import type { StreamForm } from './sessions/demo-stream';
import { createInvokeHandlers } from './ipc/handlers';
import { createKindCounts } from './ipc/handlers/counts';
import { installationGuides } from './ipc/handlers/shell';
import { attachIpcHandlers } from './ipc/router';
import { createConversationStore } from './conversations/store';
import { createContentPresence } from './sessions/content';
import { createPlanStore } from './plans/store';
import { refusedFolders } from './files/confine';
import { nodeReaderFs } from './files/fs';
import { createReadLimiter } from './files/limiter';
import { createImageFiles } from './files/images';
import { createFileReader } from './files/reader';
import { createPreferencesStore } from './prefs/store';
import { createLookups } from './records/lookup';
import { createRecordsStore } from './records/store';
import { createAppStateStore } from './state/app-state-store';
import { followAppearance, followPetSize } from './state/appearance';
import { followConversations } from './state/conversations';
import { petView } from './state/pet-view';
import { followRecords } from './state/records';
import { startPrefsBroadcaster, startStateBroadcaster } from './state/broadcaster';
import { startChatPush } from './state/chat-push';
import { createWindowManager, currentDisplayLayout } from './windows/window-manager';
import { followAppIcon } from './windows/app-icon';
import { createZoomControl } from './windows/zoom';
import { createProcessServices } from './process';
import { createLifecycleTrace, lifecycleTraceEnabled } from './process/lifecycle-trace';
import { createInstanceGuard } from './instances/admission';
import { createFolderBinding, instanceFolders } from './instances/binding';
import { addedFolders } from './instances/folders';
import { protectedVariables } from './instances/variables';
import { createPageWatch, createQuitGate, QUIT_BOX_CONFIRM, quitBoxOptions } from './app/quit-gate';
import { quitActivity } from '@shared/contracts/quit';
import { createDraftFlush } from './app/draft-flush';
import { createShutdown, quitSteps } from './app/shutdown';
import { builtInProviders } from './providers';
import { createCatalogService } from './services/catalog-service';
import { createSessionService } from './sessions/service';
import { createSessionSearch } from './sessions/search/service';
import { createChatService } from './sessions/chat-service';
import { createReturnedImages } from './sessions/returned-images';
import { createGate } from './sessions/gate';
import { createPermissions } from './sessions/permissions';
import { createPlanService } from './sessions/plans';
import { createReviewService, type ReviewService } from './sessions/reviews';
import { admitPreset } from './sessions/preset-admission';
import { createWorkflowCoordinator } from './sessions/workflow';
import { createRemoval } from './sessions/removal';
import { createSessionRuntime, type SessionRuntime } from './sessions/runtime';
import { createSecretary } from './sessions/secretary/service';
import { createUsageService } from './services/usage-service';
import { createProviderRegistry } from './services/provider-registry';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import { setupHolds } from '@shared/contracts/permissions';
import { createProviderDiscovery } from './services/provider-discovery';
import { createDiscoveryHistory, PROVIDER_DISCOVERY_FILE } from './storage/provider-discovery-history';
import { expandInstallDirectories } from './services/provider-installation';
import { installProviderLifecycle } from './app/provider-lifecycle';

// Both must happen synchronously, before `ready`.
registerAppScheme();
app.enableSandbox();
// Windows groups windows and the installer's Start-menu shortcut by this ID (the same in both).
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId(app.isPackaged));

const origins = resolveTrustedOrigins({
  isPackaged: app.isPackaged,
  devServerUrl: process.env['ELECTRON_RENDERER_URL'],
});
// Before `ready`, as every switch must be: a page from the dev server is never read from a stale cache.
for (const name of devServerSwitches(origins)) app.commandLine.appendSwitch(name);
const preloadPath = path.join(import.meta.dirname, '../preload/index.cjs');
const rendererRoot = path.join(import.meta.dirname, '../renderer');

// A smoke run exercises the write path, so it gets a throwaway directory: it must never touch the
// preferences of whoever is running it. An unpackaged run gets its own folder beside the installed
// app's, so a development build can neither migrate nor lock the real preferences. This comes before
// the lock, which is keyed on this directory: dev, smoke and installed instances run side by side.
// Use Node's temp directory in smoke runs so the app and its Node runner agree on TMPDIR.
const dataDirectory = userDataOverride({ isPackaged: app.isPackaged, isSmokeRun, isStreamForm, smokeScenario, devSetup: app.isPackaged ? undefined : process.env['FATG_DEV_SETUP'], appData: app.getPath('appData'), temp: isSmokeRun ? os.tmpdir() : app.getPath('temp') });
if (dataDirectory !== undefined) app.setPath('userData', dataDirectory);

interface SmokeModules { readonly check: typeof SmokeCheck; readonly providers: typeof SmokeProviders; readonly dialogs: typeof SmokeDialogs; readonly live: typeof SmokeLive }

// A second instance would mean two writers on the preferences file and duplicate agent
// subprocesses, so the lock comes before anything else — before the preferences are even read.
const dataReset = createDataReset(app.getPath('userData'));
if (app.requestSingleInstanceLock()) {
  if (__FATG_SMOKE_HOOKS__ && isSmokeRun) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // Synchronous: Electron must not open/cache the old profile before cleanup completes.
  const resetOutcome = dataReset.consume();
  if (resetOutcome === 'failed') {
    if (__FATG_SMOKE_HOOKS__ && isSmokeRun) console.error('[smoke] startup reset failed');
    else dialog.showErrorBox('fat-g could not finish the reset', 'No providers were started. The reset request and any remaining data were kept. Close programs using this data folder and start fat-g again to retry.\n\n' + app.getPath('userData'));
    app.exit(1);
  } else {
    if (__FATG_SMOKE_HOOKS__ && isSmokeRun) {
      // A smoke run reads the real page, and a page Chromium takes for covered gets no frame: with the
      // display asleep, or another window over this one, a dialog's `close` event never arrives. So a
      // smoke run's windows are never taken for covered, wherever it runs. No other build has this.
      // Loaded before anything else starts; a release bundle has neither this branch nor the modules.
      Promise.all([import('./app/smoke'), import('./app/smoke-providers'), import('./app/smoke-dialogs'), import('./app/smoke-live')]).then(
        ([check, providers, dialogs, live]) => { start({ check, providers, dialogs, live }); },
        () => { console.error('[smoke] the smoke modules failed to load'); app.exit(1); },
      );
    } else if (__FATG_SMOKE_HOOKS__ && isStreamForm) {
      // The stream form (M19, C63, C69): its data folder is made what every run starts from, and its
      // fixture read, before anything of fat-g opens. A release bundle has neither this branch nor the module.
      import('./app/demo-stream-data').then((module) => module.prepareStreamForm({ dir: app.getPath('userData'), fixtureFile: demoFixture })).then(
        (form) => { start(undefined, form); },
        () => { console.error('[stream] the stream form could not be prepared: start it with do-run-stream.bat'); app.exit(1); },
      );
    } else {
      start();
    }
  }
} else if (__FATG_SMOKE_HOOKS__ && isSmokeRun) {
  // app.quit() would exit 0, and scripts/smoke.mjs would report a run that checked nothing as a pass.
  console.error('[smoke] another instance holds the lock on the smoke directory');
  app.exit(1);
} else {
  app.quit(); // the running instance comes forward instead (`second-instance`, src/main/app/lifecycle.ts)
}

function start(smoke?: SmokeModules, stream?: StreamForm): void {
  // The stream form defines its own provider and no other: it starts no CLI (M19, C69).
  const definitions = stream ? [stream.definition] : builtInProviders(app.getVersion(), smoke ? smoke.providers.smokeProviderOptions(process.env) : {});
  // A smoke run may only ever launch fixtures, never the CLIs installed on this machine.
  if (smoke && !smoke.providers.fixtureOnlyProviders(definitions, process.env)) {
    console.error('[smoke] a provider could resolve an installed CLI; refusing to start');
    app.exit(1);
    return;
  }
  // No per-run override may set a variable a provider declares as its configuration folder (M14b, C8).
  const trace = createLifecycleTrace(lifecycleTraceEnabled(app.isPackaged, process.env['FATG_TRACE_LIFECYCLE']), process.pid, (line) => console.info(line));
  trace?.({ phase: 'spawn', pid: process.pid });
  const processes = createProcessServices(app.getPath('userData'), { protectedVariables: protectedVariables(definitions), trace });
  // Main owns the app state; every window gets its own projection of it, fetched on load and
  // pushed on change (src/main/state, src/main/ipc). Preferences are loaded before any window
  // opens, because windows open where the preferences say. The records (M12) are fat-g's own
  // projects, in a file of their own beside them; the Main window sees them through the app state.
  const providerIds = definitions.map((definition) => definition.descriptor.id);
  const prefs = createPreferencesStore({ dir: app.getPath('userData'), providerIds });
  const records = createRecordsStore({ dir: app.getPath('userData'), providerIds });
  const store = createAppStateStore({ appearance: prefs.getSnapshot().values.appearance });
  followAppearance(prefs, store);
  followPetSize(prefs, store);
  // The avatars (M102; decision 0031): fat-g's own art beside the archive — the repository's
  // assets/avatars in a development run — and the folder the user fills in the data folder, read by
  // one scanner into one catalog in memory. Scanned once the first state is out, and at each Rescan;
  // until then every avatar is the placeholder (C17, C57). A family's `family.json` is written in the
  // user's folder, and in fat-g's own art only in a development run that is no smoke or stream run,
  // where it is the repository's source (decision 0031).
  const builtInAvatars = app.isPackaged ? path.join(process.resourcesPath, AVATARS_FOLDER) : path.join(import.meta.dirname, '../../assets/avatars');
  const avatars = createAvatarService({
    roots: { builtIn: builtInAvatars, user: path.join(app.getPath('userData'), AVATARS_FOLDER) },
    writable: { builtIn: !app.isPackaged && smoke === undefined && stream === undefined },
    fs: nodeAvatarFs,
    // A replaced image goes to the system's trash, where the user can restore it (decision 0036); a smoke
    // or stream run's data folder is scratch, so there it is removed.
    trash: smoke === undefined && stream === undefined ? (file) => shell.trashItem(file) : (file) => nodeAvatarFs.removeCopy(file),
    providers: providerIds,
    log: console,
  });
  // Browse for an avatar's image (decision 0036): the system's chooser at the last folder an image came
  // from; a smoke build answers from the environment and opens no dialog.
  const avatarImages = createImageSource({
    fs: nodeAvatarFs,
    pick: smoke ? smoke.dialogs.smokePickImage(process.env) : async (folder) => {
      const parent = windows.get('main');
      const options: OpenDialogOptions = {
        title: 'Choose an image',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        ...(folder === undefined ? {} : { defaultPath: folder }),
      };
      const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });
  // The Main window's zoom (src/main/windows/zoom.ts): the menu's keys, Ctrl+wheel and the page's buttons.
  const zoom = createZoomControl(store);
  const lookups = createLookups();
  const recordsFollower = followRecords({ records, store, lookups });
  // Each provider's models (M13): its module's defaults and the user's catalog.json now, the CLI's
  // report once its runtime answers. Set here, so the first snapshot a window gets has it (C43).
  // What a model and a session draw (M103, C9, C10; decisions 0031, 0032): the user's override, then
  // the provider's active family searched, its face, the built-in face — with the overlay, whose
  // default texts each provider reads from its model identifiers.
  const labels = new Map(definitions.map((definition) => [definition.descriptor.id, definition.modelLabel]));
  const label = (providerId: string, id: string) => boundedLabel(labels.get(providerId)?.(id) ?? NO_LABEL);
  const resolver = createAvatarResolver({ avatars, preferences: () => prefs.getSnapshot().values.avatars, label });
  const catalog = createCatalogService({
    definitions,
    store,
    dir: app.getPath('userData'),
    avatar: (providerId, key, resolvedId) => resolver.forModel(providerId, key, resolvedId),
    label: (providerId, model) => readModelLabel((id) => label(providerId, id), model),
  });
  // The sessions (M14): each record's live summary, in memory only, and the selection. Set here too,
  // so a window's first snapshot has them. Sources attach below; in M14 that is the demo source alone.
  // A session names one of its provider's instances (M14b): it is held while that instance cannot be
  // used, and while the configuration folder it started in is not the one its instance has now (C29, C62).
  const binding = createFolderBinding({
    platform: process.platform,
    lookups,
    folderOf: instanceFolders({
      platform: process.platform,
      env: process.env,
      home: os.homedir(),
      support: (providerId) => definitions.find((definition) => definition.descriptor.id === providerId)?.instances,
      added: (ref) => {
        const admission = prefs.getInstanceAdmission(ref);
        return 'folder' in admission ? admission.folder : null;
      },
    }),
  });
  // The conversation store (M18): what was said in fat-g's sessions, in a file of its own beside the
  // records, opened before any session is read so the two are reconciled before a window opens (C55).
  // A store this build cannot read is left as it is, and sessions take no prompt until the user
  // starts fresh (C33). It is closed in the quit's last step (C45).
  // Its images (M23; decision 0030): files in `attachments/` beside it, named by the hash of their
  // bytes, which the store names and the media route serves. Swept at the store's open of what no row
  // names, and never while the store is refused (C84).
  const blobs = createBlobFiles(path.join(app.getPath('userData'), ATTACHMENTS_FOLDER));
  const conversations = createConversationStore({ dir: app.getPath('userData'), blobs });
  // Whether each session's draft or queue holds something (M23, C83): ids alone, for the session list and the cleanup of unstarted sessions.
  const contentPresence = createContentPresence(conversations);
  // The confined media route (M23, C10; M102, C23): an image of a chat by its hash, which the active
  // store must name, read from that folder alone and checked before it is served.
  // And an avatar's file (M102, C59–C62), by the id the current scan minted, checked again before it is served.
  const attachmentSource = createAttachmentSource({ image: (hash) => (conversations.status().kind === 'ok' ? conversations.blob(hash) : null), read: (hash, mediaType, bytes) => blobs.read(hash, mediaType, bytes) });
  const attachmentPath = (hash: string): string | null => {
    const held = conversations.status().kind === 'ok' ? conversations.blob(hash) : null;
    if (held === null || !blobs.holds(hash, held.mediaType, held.bytes)) return null;
    return regularOwnedFile(blobs.root, blobs.pathOf(hash, held.mediaType));
  };
  const attachmentImages = createAttachmentImageFiles({
    root: blobs.root,
    platform: process.platform,
    image: (hash) => (conversations.status().kind === 'ok' ? conversations.blob(hash) : null),
    source: attachmentSource,
    locate: attachmentPath,
  });
  // The folders no read of a file may enter, gathered at each read, since an account can be added during the run (M19b, C28).
  const fileRefusals = (): string[] => refusedFolders({ definitions, instances: prefs.getSnapshot().instances, env: process.env, home: os.homedir(), dataFolder: app.getPath('userData'), platform: process.platform });
  const fileLimiter = createReadLimiter();
  // An image file an agent read or a reference names (decision 0022, item 15): read wherever it lies on
  // this machine's own disks, named by an id for the run, and served by that id, checked again each time.
  const imageFiles = createImageFiles({ fs: nodeReaderFs, lookups, limiter: fileLimiter, platform: process.platform, listed: (id) => records.getSession(id) !== undefined, refusedFolders: fileRefusals, owned: attachmentImages });
  const audio = createAudioService({
    root: path.join(app.getPath('userData'), AUDIO_FOLDER),
    defaults: app.isPackaged ? path.join(process.resourcesPath, AUDIO_FOLDER) : path.resolve('assets/audio'),
    fs: nodeAudioFs,
  });
  let sendAudio = (_play: AudioPlay): void => undefined;
  const audioCue = createAudioCues({ prefs: () => prefs.getSnapshot(), idFor: (name) => audio.idFor(name), push: (play) => { sendAudio(play); } });
  const mediaRoute = createMediaRoute([
    audio.source,
    attachmentSource,
    createAvatarSource({ file: (id) => avatars.file(id), fs: nodeAvatarFs }),
    createImageFileSource(imageFiles),
  ]);
  const mediaRefusals = createKindCounts();
  // The stream form's fixture goes into its one session's conversation, through the store (M19, C69).
  stream?.fill(conversations);
  // And its message with two images (M23, C30), through the same staging rows and images' folder as a pasted one.
  void stream?.fillImages(conversations, blobs);
  const conversationsFollower = followConversations({ conversations, records, store });
  const removal = createRemoval({ store: conversations });
  // The plan store (M22b; decision 0029): every plan's versions, in `plans` of the data folder, which
  // nothing else writes. What a crash left is finished, lifted or cleaned before any session is read
  // (C62), against the projects the records list — and nothing is deleted while they cannot be read.
  const projectsListed = (): ReadonlySet<string> | null => (records.isRefused() ? null : new Set(records.getView().projects.flatMap((entry) => (entry.kind === 'project' ? [entry.id] : []))));
  /** App-owned folders main opens in the file manager: the data root, plans, avatars and audio. */
  const dataFolder = (folder: 'plans' | 'avatars' | 'audio' | null): string => (folder === null ? app.getPath('userData') : path.join(app.getPath('userData'), folder === 'plans' ? PLANS_FOLDER : folder === 'audio' ? AUDIO_FOLDER : AVATARS_FOLDER));
  const planStore = createPlanStore({ dir: dataFolder('plans') });
  planStore.recover(projectsListed());
  // A line an earlier run left being written is unfinished (C59, C74): its plan never completed.
  if (conversations.status().kind === 'ok') { try { conversations.unfinishPlans(Date.now()); } catch { console.warn('[plans] the lines left being written were not marked unfinished'); } }
  // Live sessions (M15): why a session cannot take a prompt is worked out in one place, for its entry
  // and again when a prompt is sent; its conversation is written through to the store, and read back
  // a page at a time. The registry and the runtime are made further down, so what the gate asks of
  // them is handed in late.
  let runtime = undefined as SessionRuntime | undefined;
  const chatPresentation = createChatPresentation({
    selected: () => store.getSnapshot().sessions?.selectedId ?? null,
    session: (id) => {
      const record = records.getSession(id);
      if (record === undefined) return null;
      const entry = store.getSnapshot().sessions?.sessions.find((candidate) => candidate.record.id === id);
      return { providerId: record.providerId, instanceId: record.instanceId, model: entry?.summary.model ?? record.model };
    },
    catalog: () => store.getSnapshot().catalog,
    resolver,
  });
  store.subscribe(() => { chatPresentation.select(); });
  // What waits for an answer is the request registry's to say (M21, C61): the runtime, made further down, holds it.
  // And a pending approval's request whole, and the key of a session's live process, by which a grant reads live (M22, C79, C81).
  const chat = createChatService({
    onQuestion: (id, itemId) => notifications.request(id, itemId, 'question'),
    store: conversations,
    presentation: chatPresentation,
    requests: { pending: (sessionId, itemId) => runtime?.requests.pending(sessionId, itemId) ?? false, waiting: (sessionId) => runtime?.requests.waiting(sessionId) ?? [], view: (sessionId, itemId) => runtime?.requests.view(sessionId, itemId) ?? null },
    processKey: (sessionId) => runtime?.processKey(sessionId) ?? null,
  });
  // Plans in their chats (M22b, Design 6): the plan service writes a plan's version and its line,
  // and composes a decision's prompt. A plan's push goes to the Main window alone, whose tab shows
  // it (C25, C60): sent once the windows exist.
  let sendPlanPush = (push: PlanPush): void => { void push; };
  // Plan review (M22e; decision 0029): made once the runtime is, which it sends through. The plan
  // service's chain asks it which integration a turn carries out, and tells it of each complete version.
  let reviews = undefined as ReviewService | undefined;
  const notifications = createAudioNotifications({
    emit: audioCue,
    active: () => runtime?.quitting() !== true,
    canReady: (id, turnId) => {
      const entry = store.getSnapshot().sessions?.sessions.find((one) => one.record.id === id);
      if (conversations.status().kind !== 'ok') return false;
      try { return allowsReady(entry?.summary, conversations.turnAnswer(id, turnId)?.card != null, reviews?.doing(id, turnId) === 'review'); } catch { return false; }
    },
  });
  let sendReviewPush = (push: ReviewPush): void => { void push; };
  // The plans' shared workflow (decision 0029): one state for each plan, which every chat taking part
  // in it draws from, and the one place an operation on it is admitted. It sends through the runtime
  // and the review service, made further down; its push, of ids alone, goes to the Main window alone.
  let sendWorkflowPush = (push: WorkflowPush): void => { void push; };
  const workflow = createWorkflowCoordinator({
    onReady: (planId, version) => notifications.plan(planId, version),
    removed: (planId) => notifications.forgetPlan(planId),
    store: planStore,
    conversations,
    chat,
    host: {
      record: (id) => records.getSession(id),
      name: (id) => records.getSession(id)?.name ?? null,
      running: (id) => sessions.isRunning(id),
      quitting: () => runtime?.quitting() ?? false,
    },
    runtime: () => runtime,
    reviews: () => reviews,
    lines: () => plans,
    push: (push) => { sendWorkflowPush(push); },
  });
  const plans = createPlanService({
    store: planStore,
    conversations,
    chat,
    record: (id) => records.getSession(id),
    chatName: (id) => { const record = records.getSession(id); return record === undefined ? null : record.name ?? ''; },
    requestPending: (sessionId, itemId) => runtime?.requests.pending(sessionId, itemId) ?? false,
    push: (push) => { sendPlanPush(push); },
    integration: (sessionId, turnId) => reviews?.integration(sessionId, turnId) ?? null,
    versionMade: (planId, version) => { reviews?.versionMade(planId, version); workflow.versionMade(planId, version); },
    admits: (planId, sessionId, turnId) => workflow.admits(planId, sessionId, turnId),
    joined: (planId, sessionId) => { workflow.joined(planId, sessionId); },
    workflow: (planId) => workflow.view(planId),
  });
  let hasRuntime: (ref: InstanceRef) => boolean = () => false;
  const sendGate = createGate({
    recordsRefused: () => records.isRefused(),
    conversationsRefused: () => conversations.status().kind === 'refused',
    // The demo source's sessions are scripted: none of them takes a prompt (C32).
    demo: () => __FATG_SMOKE_HOOKS__ && demoSessions !== 'off',
    snapshot: (ref) => store.getSnapshot().providers.find((provider) => provider.id === ref.providerId && provider.instanceId === ref.instanceId),
    // None listed until the providers start, after the launch has woken every queue (M23, C89).
    listed: () => store.getSnapshot().providers.length > 0,
    hasRuntime: (ref) => hasRuntime(ref),
    project: (id) => records.getProject(id),
    isMissing: (root) => recordsFollower.isMissing(root),
    kept: (id) => runtime?.kept(id),
    // What the chat's mode blocks a prompt for (M22, C43, C46): the runtime holds the chat's mode.
    modeBlock: (record) => runtime?.modeBlock(record) ?? null,
    // The exact version a session was made with, in its account's list (decision 0016): a
    // change of the catalog republishes every session, so the block comes and goes with the list.
    modelListed: (record) => modelListed(store.getSnapshot().catalog, { providerId: record.providerId, instanceId: record.instanceId }, record.model),
  });
  const sessions = createSessionService({
    records, store, binding, unavailable: (ref) => unavailable(store.getSnapshot().providers, ref),
    block: (record, hold) => sendGate.block(record, hold),
    // Each entry's mode, and whether a change of it is under way (M22, C1, C90).
    mode: (record) => runtime?.chatMode(record) ?? null,
    changingMode: (id) => runtime?.changingMode(id) ?? false,
    // And whether a plan's decision waits in it (M22b, C56, C58).
    planPending: (id) => runtime?.planPending(id) ?? false,
    // And the avatar its capsule draws: its model in force's, by the key the model column finds (M103, C9).
    avatar: (record, model) => resolver.forSession(store.getSnapshot().catalog, { providerId: record.providerId, instanceId: record.instanceId }, model),
    hasContent: (id) => contentPresence.has(id),
    onReferenceUnsaved: (id) => runtime?.referenceUnsaved(id),
    // The session's end of a turn goes to the conversation store in the step that asks for the record's write (M18, C54).
    onSessionEnded: (id, turnId, at, outcome) => { chat.sessionEnded(id, turnId, at, outcome); notifications.ended(id, turnId, outcome); },
    onRequestRaised: (id, itemId, kind) => notifications.request(id, itemId, kind),
    onTurnStarted: () => audioCue('turnStart'),
    onDisposition: audioCue,
    // The selected session's READY is seen as it arrives only while the user is in the Main window.
    mainHasFocus: () => windows.get('main')?.isFocused() === true,
  });
  // Whatever a session's reason reads has changed (C126): each entry's reason is worked out again, and
  // the selected session's earlier messages are read if they could not be before.
  const reasonsChanged = (): void => { sessions.availabilityChanged(); runtime?.selectionChanged(); };
  let providersSeen = store.getSnapshot().providers;
  let selectedSeen = store.getSnapshot().sessions?.selectedId ?? null;
  store.subscribe((snapshot) => {
    const selected = snapshot.sessions?.selectedId ?? null;
    if (selected !== selectedSeen) {
      selectedSeen = selected;
      queueMicrotask(() => { runtime?.selectionChanged(); });
    }
    if (snapshot.providers === providersSeen) return;
    providersSeen = snapshot.providers;
    // After this change has reached every listener: the sessions' own change follows it, in order.
    queueMicrotask(reasonsChanged);
  });
  let audioSessions = new Set(store.getSnapshot().sessions?.sessions.map((one) => one.record.id));
  store.subscribe((snapshot) => {
    const next = new Set(snapshot.sessions?.sessions.map((one) => one.record.id));
    for (const id of audioSessions) if (!next.has(id)) notifications.forgetSession(id);
    audioSessions = next;
  });
  recordsFollower.onMissingChanged(() => { queueMicrotask(reasonsChanged); });
  // A scan that lands redraws every avatar: each entry and each model asks again (M102, C40, C57).
  avatars.subscribe(() => { sessions.avatarsChanged(); catalog.avatarsChanged(); chatPresentation.changed(); });
  // And a change of the assignments redraws both, and a change of the catalog every session (M103, C12).
  followAvatarChanges({ prefs, store, catalog, sessions, presentation: chatPresentation });
  prefs.subscribe(() => { sessions.instancesChanged(); });
  // As built from the records at start-up, before any source could send an event — smoke mode checks
  // the sessions the previous run left came back as it left them.
  const sessionsAtStart = sessions.snapshot();
  // What an earlier run left provisional (M26, round 2): a session made from the New session popup,
  // never typed into and never started, is shown nowhere once it is no longer the selected one, so
  // it goes now. Sessions made in this run are left alone, and a failure holds nothing up.
  void sessions.removeUnstarted().then((answer) => {
    if (answer.status !== 'saved') console.warn(`[sessions] the sessions left unstarted were not removed (${answer.reason})`);
  }, () => { console.warn('[sessions] the sessions left unstarted were not removed'); });
  // Quitting while a session runs asks first (M14, C76): in the Main page, or in a native message box
  // when the page cannot ask. A smoke build answers the box from a stand-in and opens nothing.
  // The demo source (M14, C27–C29): development and smoke builds only, when FATG_DEMO_SESSIONS asks
  // for it. A release bundle has neither this branch nor the module.
  let demo: DemoSource | undefined;
  if (__FATG_SMOKE_HOOKS__ && demoSessions !== 'off') {
    import('./sessions/demo-source').then(
      ({ createDemoSource }) => {
        demo = createDemoSource({
          sessions: () => sessions.snapshot(),
          ...(demoSessions === 'seed' ? { seed: {
            projects: () => records.getView().projects.flatMap((entry) => (entry.kind === 'project'
              ? [{ id: entry.id, providers: entry.providers.filter((id) => unavailable(store.getSnapshot().providers, { providerId: id, instanceId: FIRST_INSTANCE_ID }) === null), sessions: entry.sessions }]
              : [])),
            catalog: () => store.getSnapshot().catalog,
            create: (projectId, preset) => sessions.create(projectId, preset),
          } } : {}),
          // A smoke run walks the script quickly.
          ...(smoke ? { stepMs: 400 } : {}),
        });
        sessions.attach(demo);
        demo.start();
      },
      () => { console.error('[sessions] the demo source failed to load'); },
    );
  }
  const mainPage = createPageWatch();
  const gate = createQuitGate({
    running: () => sessions.runningCount(),
    activity: () => quitActivity(sessions.snapshot().sessions),
    pageCanAsk: () => mainPage.canAsk(),
    setQuestion: (asked) => store.setQuitQuestion(asked),
    askNatively: smoke ? smoke.dialogs.smokeQuitBox() : async (words, signal) => {
      const parent = windows.get('main');
      const options = { ...quitBoxOptions(words), signal };
      const result = parent === undefined || parent.isDestroyed() ? await dialog.showMessageBox(options) : await dialog.showMessageBox(parent, options);
      return result.response === QUIT_BOX_CONFIRM;
    },
    quit: () => app.quit(),
    closeQuits: process.platform !== 'darwin',
  });
  // The page's unsent drafts, asked for before the Main page goes (M23, C31): at its window's close,
  // and at the quit's start. A page that cannot answer is not asked, and one that does not answer in
  // time holds nothing up.
  const draftFlush = createDraftFlush({
    ask: (token) => {
      const main = windows.get('main');
      if (main === undefined || main.isDestroyed() || main.webContents.isDestroyed() || !mainPage.canAsk()) return false;
      main.webContents.send('drafts:flush', { token });
      return true;
    },
  });
  // As read from disk, before any window could save over it — smoke mode checks the windows
  // opened where this says.
  const loaded = prefs.getSnapshot().values;
  const recordsAtStart = records.getView();
  // `windows` is created just below; nothing can call pet:hide before a window exists.
  const usage = createUsageService({
    store,
    pollIntervalSec: () => smoke ? 1 : prefs.getSnapshot().values.usage.pollIntervalSec,
    minimumPollIntervalSec: smoke ? 1 : undefined,
    onReadEnd: (ref, end) => catalog.readEnded(ref, end),
  });
  // What an account's folder is judged against (M14b, C15): the same gathering for a picked folder
  // and for an instance about to start.
  const instanceGuard = createInstanceGuard({
    platform: process.platform,
    lookups,
    env: process.env,
    home: os.homedir(),
    dataFolder: app.getPath('userData'),
    support: (providerId) => definitions.find((definition) => definition.descriptor.id === providerId)?.instances,
    instances: (providerId) => prefs.getSnapshot().instances[providerId]?.added ?? [],
    projects: () => records.getView().projects.flatMap((entry) => (entry.kind === 'project' ? [{ id: entry.id, roots: entry.roots.map((root) => root.path) }] : [])),
  });
  const knownDirectories = (definition: ProviderDefinition) => {
    const fixtures = smoke?.providers.smokeKnownDirectories(process.env);
    if (fixtures !== undefined) return fixtures;
    return expandInstallDirectories(definition.installDirectoryHints, {
      platform: process.platform, home: os.homedir(), appData: process.env['APPDATA'], localAppData: process.env['LOCALAPPDATA'],
    });
  };
  // The deterministic stream has no installed executable. Smoke uses its fixture-only definitions.
  const discovery = stream ? undefined : createProviderDiscovery({
    definitions, prefs, store, knownDirectories,
    history: createDiscoveryHistory(path.join(app.getPath('userData'), PROVIDER_DISCOVERY_FILE)),
    resolve: processes.discover,
    cwd: path.join(app.getPath('userData'), 'probe-cwd'),
  });
  const providers = createProviderRegistry({
    definitions,
    store,
    prefs,
    usage,
    catalog,
    createContext: processes.createContext,
    // An added account's folder is checked again each time its runtime starts (M14b, C59).
    guard: instanceGuard,
    startedWithout: processes.startedWithout,
    knownDirectories,
    discovery,
    busy: (ref): boolean => sessionRuntime.runningOn(ref) || setupHolds(providers.facet(ref)?.sandbox?.state()),
  });
  hasRuntime = (ref) => providers.hasRuntime(ref);
  providers.onRuntimeChanged(() => { queueMicrotask(reasonsChanged); });
  // Which mode a chat has (M22, C1, C40, C43): the hierarchy, resolved in main and nowhere else, over
  // the descriptors' declarations, the two defaults and what each account's module says it can use.
  const capabilityOf = (providerId: string): PermissionCapability | null => definitions.find((candidate) => candidate.descriptor.id === providerId)?.descriptor.capabilities.permissions ?? null;
  const permissions = createPermissions({
    capability: capabilityOf,
    userDefault: (providerId) => prefs.getSnapshot().values.providers[providerId]?.permissionMode ?? null,
    projectDefault: (projectId, providerId) => records.getProject(projectId)?.permissionModes[providerId] ?? null,
    availability: (ref) => providers.facet(ref)?.modes?.(),
  });
  // One process for each session that runs, started on its instance's runtime (M15, C1–C3).
  // The secretary (M26; decision 0028): a new session's title, asked of its own instance at its first
  // prompt, and what a session with no turn yet is described by, asked on its channel (round 2).
  const secretary = createSecretary({
    facet: (ref) => providers.facet(ref),
    catalog: () => store.getSnapshot().catalog,
    settings: () => prefs.getSnapshot().values.titles,
    apply: (event) => sessions.apply(event),
    log: console,
  });
  const returnedImages = createReturnedImages({
    store: conversations, blobs,
    alive: (id) => records.getSession(id) !== undefined && !removal.pending(id),
    changed: (id) => chat.changed(id),
    unsaved: (id, turnId, item) => chat.add(id, turnId, item),
  });
  const sessionRuntime = createSessionRuntime({
    returnedImages,
    catalog: () => store.getSnapshot().catalog,
    modelUsed: (preset) => prefs.noteModelUse(preset),
    sessions,
    records,
    facet: (ref) => providers.facet(ref),
    providerName: (providerId) => definitions.find((definition) => definition.descriptor.id === providerId)?.descriptor.displayName ?? providerId,
    // A provider with no history capability is asked nothing about an earlier conversation (M18, C6, C25).
    hasHistory: (providerId) => {
      const definition = definitions.find((candidate) => candidate.descriptor.id === providerId);
      return definition !== undefined && chatCapability(definition.descriptor, 'history') === 'supported';
    },
    // A project's other roots go to a provider whose descriptor says its sessions take them (M16, C61).
    takesOtherFolders: (providerId) => definitions.find((candidate) => candidate.descriptor.id === providerId)?.descriptor.capabilities.otherFolders === true,
    // A question beside a session goes to a provider whose descriptor says it answers one (M20b, C24).
    asides: (providerId) => definitions.find((candidate) => candidate.descriptor.id === providerId)?.descriptor.capabilities.asides ?? 'none',
    // A question in a message makes a card for a provider whose descriptor says it asks so (M21, C30).
    questions: (providerId) => definitions.find((candidate) => candidate.descriptor.id === providerId)?.descriptor.capabilities.questions ?? 'none',
    configFolder: (ref) => binding.current(ref),
    gate: sendGate,
    chat,
    store: conversations,
    removal,
    permissions,
    secretary,
    // A plan turn goes to a provider whose descriptor says under which modes it takes one (M22b, C2, C5).
    plans,
    planCapability: (providerId) => definitions.find((candidate) => candidate.descriptor.id === providerId)?.descriptor.capabilities.plans ?? null,
    reviews: () => reviews,
    workflow,
    // A session's draft, its queue and its images (M23; decision 0030).
    composer: { store: conversations, blobs, presence: contentPresence },
  });
  runtime = sessionRuntime;
  // The review service (M22e): a reviewer is a session as any, made by the session service, and its
  // prompts go through the runtime's every check. A session it made and never started is removed
  // with its saved chat, as a session's removal is (M18, C21).
  const reviewService = createReviewService({
    onRoundReady: (reviewId, round) => notifications.review(reviewId, round),
    store: planStore,
    conversations,
    host: {
      record: (id) => sessions.record(id),
      name: (id) => sessions.record(id)?.name ?? null,
      running: (id) => sessions.isRunning(id),
      quitting: () => sessionRuntime.quitting(),
      admit: (projectId, preset) => admitPreset({ project: (id) => records.getProject(id), hasProvider: (id) => providers.has(id), catalog: () => store.getSnapshot().catalog, accounts: () => store.getSnapshot().providers }, projectId, preset),
      create: (projectId, preset, name) => sessions.create(projectId, preset, name),
      remove: (id) => (sessions.record(id) === undefined || sessions.isRunning(id) ? Promise.resolve() : removal.run([id], () => sessions.remove(id), (answer) => answer.status === 'saved')),
      folder: (record) => sendGate.folder(record),
      complete: (id) => sessions.complete(id),
      runtime: sessionRuntime,
    },
    workflow,
    push: (push) => { sendReviewPush(push); },
  });
  reviews = reviewService;
  // What a crash or the quit left of each plan's workflow, recovered from its record and the chats
  // (decision 0029): before the reviews raise their attention, and nothing sent again.
  void workflow.launched().catch(() => { console.warn('[workflow] the plans were not recovered'); });
  // A restart keeps PLAN REVIEW where a review's findings still wait, as the runtime keeps PLAN READY.
  reviewService.launched();
  // The runtime read each chat's saved mode as it was made: the entries show them from here on.
  sessions.availabilityChanged();
  // A file opened from the chat (M19b; decision 0022): read by main alone, at the user's word, inside
  // the session's project's trusted folders, and kept nowhere — an image's file by the image files,
  // wherever it lies on this machine's own disks (item 15).
  const fileReader = createFileReader({
    fs: nodeReaderFs,
    lookups,
    limiter: fileLimiter,
    platform: process.platform,
    session: (id) => records.getSession(id),
    folder: (record) => sendGate.folder(record),
    project: (id) => records.getProject(id),
    isMissing: (root) => recordsFollower.isMissing(root),
    refusedFolders: fileRefusals,
    images: imageFiles,
  });
  // What main says of a read, and of an address it refused: kinds, counted (C35, C44).
  const fileCounts = createKindCounts();
  const addressCounts = createKindCounts();
  // What main says of a worker's reads (M20a, C34): how many, by kind, and nothing of what was read.
  const workerReads = createKindCounts();
  // And of the asides (M20b, C33): an ask, a read, a Stop and a removal, each by its outcome's kind.
  const asideCounts = createKindCounts();
  // And of a change of mode, a decision and a sandbox setup (M22, C26): each by its outcome's kind.
  const permissionCounts = createKindCounts();
  const setupCounts = createKindCounts();
  // And of the plans' channels (M22b, C75): each by its outcome's kind.
  const planCounts = createKindCounts();
  // And of the reviews' (M22e, C16, C44): each by its outcome's kind.
  const reviewCounts = createKindCounts();
  // And of the stagings (M23, C75): each by its outcome's kind, never a name, a hash or a size in pixels.
  const attachmentCounts = createKindCounts();
  const search = createSessionSearch({ conversations, records, sessions: () => sessions.snapshot().sessions });
  const handlers = createInvokeHandlers({
    dataReset,
    quitAfterReset: () => gate.confirmAndQuit(),
    search,
    store,
    prefs,
    records,
    sessions,
    runtime: sessionRuntime,
    removal,
    secretary,
    conversations: {
      conversations,
      detached: () => conversationsFollower.detached(),
      // A new store holds nothing: each session is reconciled against it again, its sub-agents listed
      // from it (M106, C26), and takes a prompt again.
      afterStartFresh: () => { sessionRuntime.reconcile(true); reasonsChanged(); },
    },
    projects: {
      lookups,
      // A project's root may not be an added account's folder, nor lie inside or around one (M14b, C58).
      accountFolders: () => addedFolders(definitions, prefs.getSnapshot().instances),
      checkRoots: (roots) => recordsFollower.checkRoots(roots),
      // A project's default is one of its provider's own modes (M22, C40, C43).
      hasMode: (providerId, mode) => modeOf(capabilityOf(providerId), mode) !== undefined,
      // Its plans go with it (M22b, C62, C73).
      plans: {
        settle: (projectId) => sessionRuntime.settlePlans(planStore.list(projectId).map((plan) => plan.id)),
        mark: (projectId) => { planStore.markProject(projectId); },
        lift: (projectId) => { planStore.liftProject(projectId); },
        finish: (projectId) => { planStore.finishProject(projectId); },
      },
      // A smoke build answers from the environment and never opens a real dialog (C55).
      pickFolder: smoke ? smoke.dialogs.smokePickFolder(process.env) : async () => {
        const parent = windows.get('main');
        const options: OpenDialogOptions = { title: 'Choose a project folder', properties: ['openDirectory', 'dontAddToRecent'] };
        const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
    },
    instances: {
      supports: (providerId) => definitions.some((definition) => definition.descriptor.id === providerId && definition.instances !== undefined),
      guard: instanceGuard,
      // The account's folder picker (M14b, C14); a smoke build answers from a stand-in.
      pickFolder: smoke ? smoke.dialogs.smokePickAccountFolder(process.env) : async () => {
        const parent = windows.get('main');
        const options: OpenDialogOptions = { title: 'Choose a folder for this account', properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'] };
        const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
      // Signing in is the CLI's own: fat-g only opens the user's terminal with its command (M14b, C80).
      loginOf: (providerId) => {
        const definition = definitions.find((candidate) => candidate.descriptor.id === providerId);
        return definition === undefined ? undefined : { command: definition.descriptor.loginCommand, variable: definition.instances?.variable ?? null };
      },
      executableOffPath: (ref) => providers.executableOffPath(ref),
      // A smoke build opens no terminal: its stand-in counts the request.
      openTerminal: smoke ? smoke.dialogs.smokeOpenTerminal() : (providerId, command, note) =>
        processes.openTerminal(definitions.find((candidate) => candidate.descriptor.id === providerId)?.environment, command, note),
      // An account's sandbox setup is its provider's module's (M22, C60): sent at the user's press alone.
      sandbox: (ref) => {
        const sandbox = providers.facet(ref)?.sandbox;
        // A missing CLI cannot start setup, but an existing setup can still be stopped.
        return providers.hasRuntime(ref) || setupHolds(sandbox?.state()) ? sandbox : undefined;
      },
      setups: setupCounts,
    },
    registry: providers,
    discovery,
    catalog,
    avatars,
    avatarImages,
    audio,
    audioCue,
    files: {
      reader: fileReader,
      images: imageFiles,
      counts: fileCounts,
      log: console,
      // The one fallback for a file fat-g does not draw (C43): the file manager shows it selected, and
      // nothing is opened. A smoke build counts the request and shows nothing.
      showInFolder: smoke ? smoke.dialogs.smokeShowInFolder() : (file) => { shell.showItemInFolder(file); },
      // A folder a reference names, which the reader placed as one: the file manager opens it. A smoke
      // build counts the request and opens nothing.
      openFolder: smoke ? smoke.dialogs.smokeOpenFolder() : (folder) => shell.openPath(folder),
    },
    addresses: addressCounts,
    artifactFiles: {
      attachments: attachmentSource,
      attachmentPath,
    },
    workerReads,
    asides: asideCounts,
    permissions: permissionCounts,
    attachments: attachmentCounts,
    plans: { plans, store: planStore, runtime: sessionRuntime, workflow, listedSession: (id) => records.getSession(id) !== undefined, listed: projectsListed, conversationsReadable: () => conversations.status().kind === 'ok', counts: planCounts },
    reviews: { reviews: reviewService, counts: reviewCounts },
    guides: installationGuides(definitions),
    pet: {
      hidePet: () => windows.hidePet(),
      showMain: () => windows.showMain(),
      // At once for this run, so a read-only preferences file still lets the Pet change size.
      setPetSize: (size) => {
        store.setPetSize(size);
        prefs.patch({ windows: { pet: { size } } });
      },
      // The Main window's page opens it as a press on its capsule would: its own selection path, drafts and all.
      openSession: (id) => {
        const entry = store.getSnapshot().sessions?.sessions.find((candidate) => candidate.record.id === id);
        if (entry === undefined || !isActive(entry.record)) return;
        // The focus this brings is the pressed session's: the one the window leaves stays lit.
        sessions.revealing(id);
        windows.showMain();
        const main = windows.get('main');
        if (main === undefined || main.isDestroyed() || main.webContents.isDestroyed()) return;
        main.webContents.send('sessions:reveal', { id });
      },
    },
    changeZoom: (to) => zoom.change(to),
    quit: () => app.quit(),
    answerQuit: (quit) => gate.answer(quit),
    draftsFlushed: (token) => draftFlush.flushed(token),
    // A provider's installation guide, and an address a message wrote, which main has checked (M19b, C44).
    // A smoke build hands either to a stand-in that counts it: it never opens a browser.
    openExternal: smoke ? smoke.dialogs.smokeOpenExternal() : (url) => shell.openExternal(url),
    // Main names the folder (M13, C59); a smoke build answers from a stand-in and opens nothing (C71).
    // Or its plans' folder (M22b, C21, C75), which main names too.
    showDataFolder: smoke ? smoke.dialogs.smokeShowDataFolder() : async (folder) => shell.openPath(folder === 'audio' ? await audio.folder() : dataFolder(folder)),
    // Show avatars folder makes the one folder the user fills, empty, where it is missing (M102, C40).
    createAvatarsFolder: () => nodeAvatarFs.createFolder(dataFolder('avatars')),
    pickExecutable: async () => {
      const parent = windows.get('main');
      const options: OpenDialogOptions = { title: 'Choose a CLI executable', properties: ['openFile'] };
      const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  });
  const windows = createWindowManager({
    mainIcon: (window) => { followAppIcon(window, store); },
    onMainFocus: () => { sessions.mainFocused(); void discovery?.scan(); },
    origins,
    preloadPath,
    prefs,
    emergencyCleanup: () => shutdown.emergency(),
    // A window close flushes drafts. The resumed app quit has already run the draft flush. Vetoing its
    // close would cancel Electron's quit and leave the app running when the window closes on macOS.
    onMainClose: (event) => {
      let prevented = false;
      gate.mainClose({ preventDefault: () => { prevented = true; event.preventDefault(); } });
      if (prevented || shutdown.readyToQuit) return;
      draftFlush.mainClose(event, () => {
        const main = windows.get('main');
        if (main !== undefined && !main.isDestroyed()) main.close();
      });
    },
    mainPage,
    zoom,
    attachIpc: (window, kind) => attachIpcHandlers(window.webContents, kind, handlers, { origins, log: console, detail: app.isPackaged ? 'kinds' : 'full' }),
  });
  // The Pet's window follows its list (decision 0010): its capsules' size and how many it shows.
  const fitPet = (): void => windows.fitPet(petContentSize(petView(store.getSnapshot())));
  store.subscribe(fitPet);
  fitPet();
  let removeProviderLifecycle = (): void => undefined;
  // The quit's drain, in its order (M15, Design 11): new work stops, the running sessions are stopped
  // and their ends awaited, the turns still running are written stopped, and only then is every
  // runtime disposed and every process tree ended.
  const shutdown = createShutdown(quitSteps({
    providers, runtime: sessionRuntime, sessions, processes, windows, conversations, drafts: draftFlush, images: returnedImages,
    demo: () => demo, beforeQuit: () => { removeProviderLifecycle(); search.stop(); },
    resumeQuit: () => app.quit(),
    failure: () => { console.error('[main] process cleanup failed', processes.diagnostics.snapshot()); if (smoke) process.exitCode = 1; },
  }));

  hardenWebContents(origins);

  app
    .whenReady()
    .then(async () => {
      await audio.initialize();
      const csp = buildCsp(origins);
      hardenSession(session.defaultSession, origins, csp);
      // A refused media request is counted by its kind alone: never its address, which names an image (C75).
      handleAppProtocol(rendererRoot, csp, mediaRoute, (kind) => { mediaRefusals.add(kind); });
      Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate({ platform: process.platform, isPackaged: app.isPackaged, zoom: (to) => zoom.change(to), showMain: () => windows.showMain() })));
      installLifecycle({ windows, prefs, shutdown, gate, conversations });
      removeProviderLifecycle = installProviderLifecycle(powerMonitor, usage);

      const targets = () => windows.broadcastTargets();
      sendAudio = (play) => {
        for (const target of targets()) {
          if (target.kind !== 'main' || !target.isAlive()) continue;
          try { target.send('audio:play', play); } catch { /* A closing page drops the cue. */ }
        }
      };
      startStateBroadcaster({ store, targets });
      startPrefsBroadcaster({ prefs, targets });
      // A message goes at once, to the Main window, for the session it shows (M15, C55).
      startChatPush({ chat, selected: () => store.getSnapshot().sessions?.selectedId ?? null, targets });
      // A plan's push goes to the Main window alone (M22b, C25): the Pet never receives a word of a plan.
      sendPlanPush = (push) => {
        for (const target of targets()) {
          if (target.kind !== 'main' || !target.isAlive()) continue;
          try { target.send('plans:changed', push); } catch { console.error('[push] could not send plans:changed to the main window'); }
        }
      };
      // And a plan's workflow's, ids alone, to the Main window alone (decision 0029).
      sendWorkflowPush = (push) => {
        for (const target of targets()) {
          if (target.kind !== 'main' || !target.isAlive()) continue;
          try { target.send('plans:workflowChanged', push); } catch { console.error('[push] could not send plans:workflowChanged to the main window'); }
        }
      };
      // And a review's, ids alone, to the Main window alone (M22e, C44): the Pet receives nothing of a review.
      sendReviewPush = (push) => {
        for (const target of targets()) {
          if (target.kind !== 'main' || !target.isAlive()) continue;
          try { target.send('reviews:changed', push); } catch { console.error('[push] could not send reviews:changed to the main window'); }
        }
      };
      discovery?.start();
      providers.start();

      const openingLayout = smoke && !isLiveSmokeRun ? currentDisplayLayout() : undefined;
      windows.showMain();
      // The avatars' first scan, once the first state is out: the window never waits for it (M102, C57).
      void avatars.scan();
      if (stream) {
        // The page counts its long tasks and frames in this form alone (M19, C63): the probe goes in at each load.
        const page = windows.get('main')?.webContents;
        const evaluate = (script: string): Promise<unknown> => (page === undefined || page.isDestroyed() ? Promise.reject(new Error('no page')) : page.executeJavaScript(script));
        page?.on('did-finish-load', () => { stream.watch(evaluate); });
        if (page !== undefined && !page.isLoading()) stream.watch(evaluate);
      }
      // A live launch (M15, M16) runs a Codex session and a Claude session on their fakes, with the demo source off; the other checks are the demo launch's.
      if (smoke && isLiveSmokeRun) smoke.live.runLiveSmoke({ windows, store, records, sessions, prefs, shutdown, removeChat: (id) => { removal.detached([id]); }, fileCounts: () => fileCounts.snapshot(), addressCounts: () => addressCounts.snapshot(), workerReads: () => workerReads.snapshot(), asideCounts: () => asideCounts.snapshot(), dialogs: smoke.dialogs });
      else if (smoke && openingLayout) smoke.check.runSmokeCheck({ windows, openingLayout, store, prefs, loaded, records, recordsAtStart, sessions, sessionsAtStart, demo: () => demo, expectedOrigin: origins.renderer, processes, shutdown, usage, avatars, avatarRoot: builtInAvatars });
    })
    .catch((error: unknown) => {
      void error;
      console.error('[main] startup failed');
      shutdown.emergency();
      app.exit(1);
    });
}
