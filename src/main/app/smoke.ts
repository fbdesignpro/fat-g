// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { checkDataReset } from './smoke-data-reset';
import { checkProviderDiscovery } from './smoke-provider-discovery';
import { AUDIO_EVENTS, DEFAULT_SOUNDS } from '@shared/contracts/audio';
import { smokeScenario } from './flavor';
import { checkCreateFamily } from './smoke-avatar-family';
import { checkSessionSearch } from './smoke-session-search';
import { AUDIO_DECODE_PROBE, type AudioDecodeResult } from './smoke-audio';
// Smoke mode (`FATG_SMOKE=1`): launch, let every window load, drive the app a little, report what
// each page and window sees, exit 0/1. It verifies what unit tests cannot:
//   • the real Electron shell starts, and each window loads ITS OWN page (Vite would quietly serve
//     index.html for a missing pet.html) from the expected origin, with the preload bridge in place;
//   • nothing trips the Content-Security-Policy or the request allowlist;
//   • state pushed from main reaches every window, and account identity never reaches the Pet —
//     checked on the data it received by push AND by invoke, not just on what it renders (the Pet
//     UI never renders account fields, so a DOM-only check would pass with main's projection broken);
//   • preferences: the Pet may not read them, the clamp holds, and a change reaches the disk;
//   • the records (M12): the project the previous run left is back as left, a change made through
//     the Main page is on disk once answered, and the Pet sees and changes none of it;
//   • the theme (M11): both windows start in the saved one, page and window alike, and follow a
//     change at once, without a reload;
//   • the windows (M4): the Main title-bar overlay is there, the Pet stays on top without taking
//     focus, both reopen where they were left, their new positions reach the disk, the Pet's × and
//     the Settings toggle work, and a second launch brings the first instance forward;
//   • the package (M9, when packaged): main loaded from app.asar, pages from app:// even with a
//     dev-server URL in the environment, no reload or DevTools menu entries, userData and app name;
//   • the providers (M6, M7, M7b): the production Codex and Claude adapters (Claude through fat-g's
//     own control client) against deterministic CLI fixtures — never an installed CLI — through the
//     same IPC and preference paths as the UI, ending with a hung Claude session in flight at quit;
//   • the catalog (M13): both fixtures' model lists reach the Main window, the catalog.json the
//     script placed is applied or ignored as it says, and the Pet gets none of it;
//   • the sessions (M14): seeded and driven by the demo source, the ones the previous run left are
//     back as left — a turn it left running shows STOPPED — one is selected, starred and completed
//     through the Main page, the Pet gets none of it, and the run ends by choosing Quit in the page
//     and confirming main's question there, never in the native box.
//
// It changes preferences and moves windows, which is why `userData` points at a throwaway
// directory in smoke mode (src/main/index.ts). That directory survives between runs, on purpose:
// the restore check compares where the windows opened with where the PREVIOUS run left them, and
// every value a run writes differs from the last run's, so a leftover file cannot make it pass.
//
// Success uses the normal quit path, begun from the Main page as the menu's Exit begins it, including
// the quit question, process cleanup and the final placement and preferences saves.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, Menu, type NativeImage, screen, type WebContents } from 'electron';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { Theme } from '@shared/contracts/appearance';
import { FIRST_INSTANCE_ID } from '@shared/contracts/instances';
import { petContentSize, type PetSize } from '@shared/contracts/pet';
import { quitActivity, quitWords } from '@shared/contracts/quit';
import { POLL_INTERVAL_SEC, type Preferences } from '@shared/contracts/prefs';
import { defaultPreset, presetTiles } from '@shared/contracts/presets';
import { isActive, type SessionsState } from '@shared/contracts/sessions';
import type { WindowKind } from '@shared/ipc/channels';
import { PREFERENCES_FILE, type PreferencesStore } from '../prefs/store';
import { RECORDS_FILE } from '../records/format';
import { normalizeRoot } from '../records/paths';
import type { RecordsStore, RecordsView, StoredEntry, StoredProject } from '../records/store';
import type { AppStateStore } from '../state/app-state-store';
import { petView } from '../state/pet-view';
import { fitBoundsToDisplays, type DisplayLayout, type Rect, roundRect } from '../windows/bounds';
import { windowBackground } from '../windows/chrome';
import { fitPetBounds, openingPetBounds } from '../windows/pet-fit';
import { MAIN_PLACEMENT } from '../windows/placement';
import { currentDisplayLayout, type WindowManager } from '../windows/window-manager';
import type { ProcessServices } from '../process';
import { pidAlive } from '../process/tree-kill';
import type { UsageService } from '../services/usage-service';
import type { DemoSource } from '../sessions/demo-source';
import type { SessionService } from '../sessions/service';
import type { AvatarService } from '../avatars/service';
import type { createShutdown } from './shutdown';
import { checkProcessSmoke } from './process-smoke';
import { checkNewChat } from './smoke-new-chat';
import { checkStateStreams } from './smoke-states';
import { pngBytes } from '../images/test-support';
import { MAX_STAGE_BYTES } from '@shared/ipc/channels';
import { dataFolderRequests, quitBoxRequests, terminalRequests } from './smoke-dialogs';
import { PRODUCT_NAME } from './identity';
import { APP_ORIGIN } from './origins';

/** The keys the fixtures report: tests/fixtures/claude/models.json and codex/model-list.json (M13); Claude's by the exact versions its rows name (decision 0016). */
const CLAUDE_FIXTURE_MODELS = ['claude-opus-5[1m]', 'claude-fable-5-1[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];
const CODEX_FIXTURE_MODELS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-reserve', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'codex-auto-review'];

/** Changes made after every window has loaded — the windows can only reach the final seq through pushes. */
const TICKS = 3;
const TICK_GAP_MS = 150;
/** After the last change: broadcast coalescing + IPC + a React render, with a wide margin. */
const SETTLE_MS = 1500;
/** How long one awaited thing may take: a page load, a debounced save reaching the disk, a launch. */
const WAIT_MS = 10_000;
const POLL_MS = 50;
// Includes the initial-screen IPC/persistence checks and optional responsive visual captures.
const TIMEOUT_MS = 120_000;

export interface SmokeContext {
  readonly windows: WindowManager;
  readonly openingLayout: DisplayLayout;
  readonly store: AppStateStore;
  readonly prefs: PreferencesStore;
  /** The preferences as read from disk at start-up, before any window could save over them. */
  readonly loaded: Preferences;
  readonly records: RecordsStore;
  /** The records as read from disk at start-up: what the previous run left (M12). */
  readonly recordsAtStart: RecordsView;
  readonly sessions: SessionService;
  /** The sessions as built from the records at start-up, before any source sent an event (M14). */
  readonly sessionsAtStart: SessionsState;
  /** The demo source, once its module has loaded (M14): the run is seeded by it, and holds it still to compare. */
  readonly demo: () => DemoSource | undefined;
  readonly expectedOrigin: string;
  readonly processes: ProcessServices;
  readonly shutdown: ReturnType<typeof createShutdown>;
  readonly usage: UsageService;
  /** The avatars (M102): the service, and the built-in art's folder its faces must be read from. */
  readonly avatars: Pick<AvatarService, 'idle' | 'file' | 'listing'>;
  readonly avatarRoot: string;
}

interface PageReport {
  platform: string | null;
  origin: string;
  page: string | null;
  seq: string | null;
  cspViolations: string | null;
  /** The last snapshot the page received (by push, after the ticks) carries an email or organization. */
  pushedIdentity: boolean;
  /** Same question for a fresh `state:getSnapshot` through the real bridge; null if the call failed. */
  fetchedIdentity: boolean | null;
  /** The page's visible text contains an email address. Checked for the Pet only (C63). */
  showsEmail: boolean;
  /** The root element's `data-theme`. */
  theme: string | null;
  /** `ok` when this window may read preferences, otherwise the code main answered with. */
  prefsRead: string;
  /** What main answers to a malformed payload — must be the `bad-request` code. */
  badPayload: string;
  /** What the preload does with a channel that is not on its allowlist — must be `rejected`. */
  unknownInvoke: string;
  unknownPush: string;
  /** Whether the OS draws the window buttons over this page (a title-bar overlay); null if no API. */
  overlay: boolean | null;
}

// Runs in each page's main world. Markers come from src/renderer/src/diagnostics/SmokeProbe.tsx.
const PROBE = `(async () => {
  const probe = document.querySelector('[data-smoke-page]');
  const hasIdentity = (snapshot) => snapshot.providers.some((provider) =>
    provider.account !== null && ('email' in provider.account || 'organization' in provider.account));
  const fetched = await window.fatg?.invoke('state:getSnapshot', null).catch(() => null);
  const overlay = navigator.windowControlsOverlay;
  // The overlay can report itself visible only some time after the page has loaded.
  if (overlay && !overlay.visible) {
    await new Promise((resolve) => { overlay.addEventListener('geometrychange', resolve, { once: true }); setTimeout(resolve, 2000); });
  }
  return {
    platform: window.fatg?.platform ?? null,
    origin: window.location.origin,
    page: probe?.getAttribute('data-smoke-page') ?? null,
    seq: probe?.getAttribute('data-smoke-seq') ?? null,
    cspViolations: probe?.getAttribute('data-smoke-csp') ?? null,
    pushedIdentity: probe?.getAttribute('data-smoke-identity') === 'yes',
    fetchedIdentity: fetched?.ok === true ? hasIdentity(fetched.value) : null,
    showsEmail: (document.body.textContent ?? '').includes('@'),
    theme: document.documentElement.getAttribute('data-theme'),
    badPayload: await window.fatg.invoke('state:getSnapshot', 42).then((r) => r.ok ? 'accepted' : r.error, () => 'rejected'),
    unknownInvoke: await window.fatg.invoke('smoke:nope', null).then(() => 'resolved', () => 'rejected'),
    unknownPush: (() => { try { window.fatg.on('smoke:nope', () => {}); return 'accepted'; } catch { return 'rejected'; } })(),
    prefsRead: await window.fatg.invoke('prefs:get', null).then((r) => r.ok ? 'ok' : r.error, () => 'failed'),
    overlay: overlay ? overlay.visible : null,
  };
})()`;

/** An invoke from inside a page, answering `ok`, the refusal code, or `failed`. */
const invokeFrom = (channel: string, request: string): string =>
  `window.fatg.invoke(${JSON.stringify(channel)}, ${request}).then((r) => (r.ok ? 'ok' : r.error), () => 'failed')`;

/** Changes a preference from inside the page and reports what main says it saved. */
const patchProbe = (seconds: number): string => `window.fatg
  .invoke('prefs:patch', { usage: { pollIntervalSec: ${seconds} } })
  .then((r) => (r.ok ? r.value.values.usage.pollIntervalSec : 'refused:' + r.error), (e) => 'failed:' + String(e))`;

/** The parts of preferences.json the checks read back. Loose on purpose: it is whatever is on disk. */
interface OnDisk {
  appearance?: { theme?: unknown };
  usage?: { pollIntervalSec?: unknown };
  windows?: { main?: { bounds?: unknown }; pet?: { visible?: unknown; autoHideOnMainFocus?: unknown; bounds?: unknown; size?: unknown } };
}

function readPreferencesFile(): OnDisk {
  try {
    return JSON.parse(readFileSync(path.join(app.getPath('userData'), PREFERENCES_FILE), 'utf8')) as OnDisk;
  } catch {
    return {}; // missing, or caught mid-rename: the next poll will see it
  }
}

/** The project each run leaves in the records, and the note of how it left it (M12). */
const SMOKE_PROJECT = 'Smoke project';
const SMOKE_RECORDS_MARKER = 'smoke-records.json';

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sameRect = (saved: unknown, rect: Rect): boolean =>
  typeof saved === 'object' && saved !== null && JSON.stringify(roundRect(saved as Rect)) === JSON.stringify(rect);

/**
 * Where a window may land when restored to `saved`. Fractional display scaling cannot hit every
 * DIP, so a window may settle a DIP off — but never LARGER than saved: that is how a window starts
 * growing on every launch (src/main/windows/bounds.ts, settleBounds).
 */
const restoredAt = (actual: Rect, saved: Rect): boolean =>
  Math.abs(actual.x - saved.x) <= 1 &&
  Math.abs(actual.y - saved.y) <= 1 &&
  actual.width <= saved.width &&
  actual.width >= saved.width - 1 &&
  actual.height <= saved.height &&
  actual.height >= saved.height - 1;

/**
 * Where the Pet may land: within a DIP of its place, its page exactly the size its list asks for. Its
 * size is its list's, never the saved one's, so `restoredAt`'s guard against growth does not apply;
 * and the window's read-back, a DIP over at a half-pixel place, is not what the user sees.
 */
const petRestoredAt = (actual: Rect, page: readonly [number, number], wanted: Rect): boolean =>
  Math.abs(actual.x - wanted.x) <= 1 && Math.abs(actual.y - wanted.y) <= 1 && page[0] === wanted.width && page[1] === wanted.height;

export function runSmokeCheck({ windows, openingLayout, store, prefs, loaded, records, recordsAtStart, sessions, sessionsAtStart, demo, expectedOrigin, processes, shutdown, usage, avatars, avatarRoot }: SmokeContext): void {
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  let finished = false;
  /** Set once main's quit question is open in the Main page: pressing its Quit ends the run (M14, C68). */
  let confirmQuit: (() => Promise<unknown>) | null = null;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    // Leave the Pet preference shown for the next restore test.
    prefs.patch({ windows: { pet: { visible: true, autoHideOnMainFocus: true } } });
    prefs.flushSync();
    console.log(`[smoke] ${JSON.stringify({ ok: problems.length === 0, ...report, problems })}`);
    // A seeded run always has a session in a turn, so app.quit() from here would only be questioned:
    // the run ends as a user ends it, by the question's own Quit button.
    if (problems.length === 0 && confirmQuit !== null) void confirmQuit().catch(() => shutdown.cleanup().then(() => app.exit(1)));
    else void shutdown.cleanup().then(() => app.exit(1));
  };

  /** Polls until `condition` holds; records a problem and answers false if it never does. */
  async function waitFor(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await condition()) return true;
      } catch {
        // not yet: a page still loading, a window mid-creation
      }
      if (Date.now() > deadline) {
        problems.push(`timed out waiting for ${what}`);
        return false;
      }
      await delay(POLL_MS);
    }
  }

  const pageReady = (kind: WindowKind, window: BrowserWindow): Promise<boolean> =>
    waitFor(
      `the ${kind} page to load`,
      async () =>
        !window.isDestroyed() &&
        !window.webContents.isLoading() &&
        (await window.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]') !== null`)) === true,
    );

  // Every page's console errors and failed loads — including a Pet created later in the run.
  const watched = new WeakSet<WebContents>();
  const watch = (contents: WebContents): void => {
    if (watched.has(contents)) return;
    watched.add(contents);
    const kind = (): string => (contents.getURL().includes('pet.html') ? 'pet' : 'main');
    contents.on('console-message', (event) => {
      if (event.level === 'error') problems.push(`${kind()}: console error: ${event.message}`);
    });
    contents.on('did-fail-load', (_event, code, description, url) => {
      problems.push(`${kind()}: failed to load ${url}: ${description} (${code})`);
      finish();
    });
  };
  for (const kind of ['main', 'pet'] as const) {
    const window = windows.get(kind);
    if (window) watch(window.webContents);
  }
  app.on('web-contents-created', (_event, contents) => watch(contents));

  const checkPetWindow = (pet: BrowserWindow, when: string): void => {
    if (!pet.isAlwaysOnTop()) problems.push(`pet ${when}: not always on top`);
    if (!pet.isVisible()) problems.push(`pet ${when}: not visible`);
    if (pet.isFocused()) problems.push(`pet ${when}: took the focus`);
  };

  async function checkPages(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    // Every page connected to the state before rendering (src/renderer/src/boot.tsx).
    for (let tick = 0; tick < TICKS; tick += 1) {
      await delay(TICK_GAP_MS);
      store.updateProviders((providers) => [...providers]);
    }
    await delay(SETTLE_MS);

    const state = store.getSnapshot();
    const stateHasIdentity = state.providers.some((provider) => provider.account?.email !== undefined || provider.account?.organization !== undefined);
    const pages: Partial<Record<WindowKind, PageReport>> = {};

    for (const [kind, window] of [['main', main], ['pet', pet]] as const) {
      const page = (await window.webContents.executeJavaScript(PROBE)) as PageReport;
      pages[kind] = page;
      const problem = (message: string) => problems.push(`${kind}: ${message}`);

      if (page.platform !== process.platform) problem(`bridge platform was ${String(page.platform)}`);
      if (page.origin !== expectedOrigin) problem(`origin was ${page.origin}, expected ${expectedOrigin}`);
      if (page.page !== kind) problem(`loaded the ${String(page.page)} page`);
      if (page.cspViolations !== '0') problem(`CSP violations: ${String(page.cspViolations)}`);
      if (page.seq !== String(state.seq)) problem(`shows seq ${String(page.seq)}, main is at ${state.seq}`);
      if (page.theme !== state.appearance.theme) problem(`page theme is ${String(page.theme)}, the app state says ${state.appearance.theme}`);
      if (page.fetchedIdentity === null) problem('state:getSnapshot did not succeed');
      if (page.badPayload !== 'bad-request') problem(`a malformed payload was answered with ${page.badPayload}, expected bad-request`);
      if (page.unknownInvoke !== 'rejected' || page.unknownPush !== 'rejected') problem('the preload let an unlisted channel through');
      // Preferences are the Main window's business, and only its business.
      const expectedPrefsRead = kind === 'main' ? 'ok' : 'forbidden';
      if (page.prefsRead !== expectedPrefsRead) problem(`prefs:get answered ${page.prefsRead}, expected ${expectedPrefsRead}`);
      if (kind === 'pet') {
        if (page.pushedIdentity) problem('received account identity in a pushed snapshot');
        if (page.fetchedIdentity === true) problem('received account identity from state:getSnapshot');
        if (page.showsEmail) problem('displays an email address');
      }
      if (kind === 'main') {
        // The same checks must SEE identity where it is allowed, or the Pet checks above prove nothing.
        // What the page received, by push and by fetch: since M11 the email is on screen only in the
        // usage panel, which exists only while the pointer is over a block (C63).
        if (stateHasIdentity && !(page.pushedIdentity && page.fetchedIdentity === true)) {
          problem('does not receive the account identity the state holds — the Pet privacy checks would be vacuous');
        }
        // The OS draws the window buttons over the page's own title bar (src/main/windows/chrome.ts).
        const overlayExpected = process.platform === 'win32' || process.platform === 'darwin';
        if ((page.overlay === true) !== overlayExpected) problem(`title-bar overlay visible: ${String(page.overlay)}, expected ${overlayExpected}`);
      }
    }
    report['pages'] = pages;
  }

  const invokeStatus = (window: BrowserWindow, channel: string, request: unknown): Promise<unknown> =>
    window.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)})
      .then((r) => r.ok ? r.value?.status ?? 'ok' : r.error, () => 'failed')`);
  const patchProviderFrom = (main: BrowserWindow, id: string, value: { enabled?: boolean; executablePath?: string | null }): Promise<unknown> =>
    main.webContents.executeJavaScript(invokeFrom('prefs:patch', JSON.stringify({ providers: { [id]: value } })));

  /**
   * Drives the production Claude adapter — its control client and the real process layer — through the
   * CLI fixture (tests/fixtures/fake-claude-cli.mjs), by the same IPC and preference paths as the UI.
   */
  async function checkClaudeProvider(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const directory = process.env['FATG_SMOKE_CLAUDE_DIR'];
    if (!directory || !path.isAbsolute(directory)) {
      problems.push('Claude fixture controls are missing');
      return;
    }
    const fixture = (name: string) => path.join(directory, name);
    const claude = () => store.getSnapshot().providers.find((provider) => provider.id === 'claude');
    const control = (values: Record<string, number>) => writeFileSync(fixture('control.json'), JSON.stringify(values));
    const ledger = () => {
      try {
        return readFileSync(fixture('pids'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => {
          const [pid, role] = line.split(' ');
          return { pid: Number(pid), role: role ?? '' };
        });
      } catch { return []; }
    };
    const sessions = () => ledger().filter(({ role }) => role.startsWith('session')).length;
    const marker = (prefix: string) => readdirSync(directory).filter((name) => name.startsWith(prefix)).map((name) => Number(name.slice(prefix.length)));
    const gone = (pid: number) => !pidAlive(pid);
    const settled = (after: number) => (claude()?.asOf ?? 0) > after && claude()?.status.kind === 'ok';

    const ready = await waitFor('Claude fixture usage through the control client', () => {
      const provider = claude();
      const windows = provider?.usage?.windows ?? [];
      return provider?.status.kind === 'ok' &&
        provider.installation?.version === '2.1.268-fixture.1' &&
        provider.account?.email === 'claude-smoke@example.test' && provider.account.plan === 'max' &&
        windows.map((window) => window.id).join() === 'five-hour,weekly,weekly-model:fable' &&
        windows[1]?.severity === 'warning' && windows[1].isBinding === true && windows[2]?.scope === 'Fable';
    });
    if (!ready) return;

    for (const [channel, request] of [
      ['providers:refresh', { providerId: 'claude', instanceId: 'default' }],
      ['providers:redetect', { providerId: 'claude', instanceId: 'default' }],
      ['providers:pickExecutable', { providerId: 'claude' }],
      ['shell:openLink', { providerId: 'claude' }],
    ] as const) {
      const answer = await invokeStatus(pet, channel, request);
      if (answer !== 'forbidden') problems.push(`pet: ${channel} for Claude answered ${String(answer)}, expected forbidden`);
    }

    // A Refresh reads at once, one arriving during a read joins it, and two session children never
    // overlap (M13, C97).
    const beforeRefresh = claude()?.asOf ?? 0;
    const refreshes = [];
    for (let attempt = 0; attempt < 3; attempt += 1) refreshes.push(await invokeStatus(main, 'providers:refresh', { providerId: 'claude', instanceId: 'default' }));
    if (refreshes.some((answer) => answer !== 'accepted')) problems.push(`Claude refreshes answered ${refreshes.join(', ')}`);
    await waitFor('a Claude refresh', () => settled(beforeRefresh));

    // The CLI asks fat-g for something (a tool permission): refused, and the read still completes.
    const beforeRequest = claude()?.asOf ?? 0;
    control({ cliRequest: 1 });
    const refused = await waitFor('the Claude fixture request to be refused', () => marker('cli-request-refused-').length > 0 && settled(beforeRequest));
    if (refused && existsSync(fixture('cli-request-accepted'))) problems.push('fat-g accepted a request from the Claude CLI');

    // Outcome C: the CLI rejects get_usage, leaving an account-only panel, then recovers.
    control({ unsupportedUsage: 1 });
    await waitFor('the Claude account-only outcome', () => {
      const provider = claude();
      return provider?.status.kind === 'not-applicable' && provider.status.reason === 'unsupported-cli-version' &&
        provider.account?.email === 'claude-smoke@example.test' && provider.usage === null && provider.asOf === null;
    });
    await waitFor('Claude to leave the account-only outcome', () => claude()?.status.kind === 'ok');

    // Disabling closes the in-flight session child and starts none while disabled.
    control({ hangUsage: 1 });
    await waitFor('a hung Claude usage request', () => marker('hung-').length > 0);
    const [hung] = marker('hung-');
    if (await patchProviderFrom(main, 'claude', { enabled: false }) !== 'ok') problems.push('Claude disable preference was refused');
    await waitFor('Claude to disable', () => claude()?.status.kind === 'disabled');
    await waitFor('the disabled Claude session tree to be gone', () => hung !== undefined && gone(hung));
    const whileDisabled = ledger().length;
    await delay(2500);
    if (ledger().length !== whileDisabled) problems.push('Claude launched a child while disabled');
    rmSync(fixture(`hung-${hung}`), { force: true });
    if (await patchProviderFrom(main, 'claude', { enabled: true }) !== 'ok') problems.push('Claude enable preference was refused');
    await waitFor('Claude to re-enable', () => claude()?.status.kind === 'ok');

    const missing = path.join(app.getPath('temp'), `fatg-smoke-missing-${process.pid}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (await patchProviderFrom(main, 'claude', { executablePath: missing }) !== 'ok') problems.push('Claude override preference was refused');
    await waitFor('the invalid Claude override to be refused without fallback', () => {
      const status = claude()?.status;
      return status?.kind === 'not-installed' && status.overrideInvalid;
    });
    if (await patchProviderFrom(main, 'claude', { executablePath: null }) !== 'ok') problems.push('clearing the Claude override was refused');
    await waitFor('Claude automatic detection to recover', () => claude()?.status.kind === 'ok');

    // Each short test-only deadline ends its session (only fat-g's teardown ends these fixture
    // sessions), the tree is confirmed gone, and a later scheduled read recovers without overlap.
    for (const [kind, prefix, controls] of [['withheld initialization', 'withheld-', { withholdInit: 1 }], ['hung usage request', 'hung-', { hangUsage: 1 }]] as const) {
      const before = claude()?.asOf ?? 0;
      control(controls);
      await waitFor(`the Claude ${kind}`, () => marker(prefix).length > 0);
      const pids = marker(prefix);
      await waitFor(`the Claude ${kind} to hit its deadline and its tree to be gone`, () => pids.every(gone));
      await waitFor(`Claude recovery after a ${kind}`, () => settled(before));
      for (const pid of pids) rmSync(fixture(`${prefix}${pid}`), { force: true });
    }

    if (existsSync(fixture('overlaps'))) problems.push('two Claude sessions overlapped');
    if (existsSync(fixture('prompts'))) problems.push('a Claude session received a prompt');
    if (existsSync(fixture('sdk-markers'))) problems.push('a Claude session was told it was talking to the Agent SDK');
    if (existsSync(fixture('unexpected-args'))) problems.push('a Claude session was launched with unexpected arguments');
    report['claudeProvider'] = {
      version: claude()?.installation?.version,
      windows: claude()?.usage?.windows.map((window) => window.id),
      refreshes, cliRequestRefused: refused, accountOnlyOutcome: true, disabledMidSession: true, invalidOverrideRefused: true,
      deadlinesRecovered: true, sessions: sessions(),
    };
  }

  /**
   * Leaves a deliberately hung Claude session — a stuck root with a descendant — in flight for
   * app quit. scripts/smoke.mjs then checks every recorded Claude PID, this tree included, is gone.
   */
  async function beginQuitWithHungClaudeSession(): Promise<void> {
    const directory = process.env['FATG_SMOKE_CLAUDE_DIR'];
    if (!directory || !path.isAbsolute(directory)) return;
    const hung = () => readdirSync(directory).filter((name) => name.startsWith('hung-'));
    const before = new Set(hung());
    writeFileSync(path.join(directory, 'control.json'), JSON.stringify({ hangUsage: 1, stuck: 1 }));
    usage.resume();
    const live = await waitFor('a hung Claude session to be in flight at quit', () => hung().some((name) => !before.has(name)));
    report['quitWithHungClaudeSession'] = live;
  }

  /**
   * Whether the Codex fixture's pushed usage has reached the app state: its first account signed in,
   * its version read, and its primary window at 42. The fixture answers every usage read with 41 and
   * pushes 42 once per process, a moment after the first read; a smoke run reads usage every second,
   * so the next read answers 41 again and the state holds 42 for under a second. The pages can take
   * longer than that to load (from the dev server they sometimes do), so a look at the state once
   * they have loaded may come after the push has come and gone. The state is watched instead, from
   * this turn: the one that started the providers (src/main/index.ts), before any of them answered.
   */
  const codexPushIn = (snapshot: AppStateSnapshot): boolean => {
    const provider = snapshot.providers.find((candidate) => candidate.id === 'codex');
    return provider?.status.kind === 'ok' &&
      provider.account?.email === 'smoke@example.test' &&
      provider.installation?.version === '0.155.1' &&
      provider.usage?.windows.some((window) => window.id === 'codex:primary' && window.usedPercent === 42) === true;
  };
  let codexPushReached = codexPushIn(store.getSnapshot());
  store.subscribe((snapshot) => { codexPushReached ||= codexPushIn(snapshot); });

  /** Drives the real Codex adapter fixture through the same IPC and preferences paths as the UI. */
  async function checkCodexProvider(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const accountStateFile = process.env['FATG_SMOKE_CODEX_ACCOUNT_STATE'];
    const controlFile = process.env['FATG_SMOKE_CODEX_CONTROL'];
    const pidFile = process.env['FATG_SMOKE_PIDS'];
    if (!accountStateFile || !controlFile || !pidFile || ![accountStateFile, controlFile, pidFile].every((value) => path.isAbsolute(value))) {
      problems.push('Codex fixture controls are missing');
      return;
    }
    const codex = () => store.getSnapshot().providers.find((provider) => provider.id === 'codex');
    // The push itself, whenever it came (above), and a first account that has settled since.
    const ready = await waitFor('Codex fixture usage and push', () => codexPushReached && codex()?.status.kind === 'ok');
    if (!ready) return;

    const patchProvider = (value: { enabled?: boolean; executablePath?: string | null }): Promise<unknown> => patchProviderFrom(main, 'codex', value);
    const countFixturePids = (): number => {
      try { return readFileSync(pidFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length; } catch { return 0; }
    };

    for (const [channel, request] of [
      ['providers:refresh', { providerId: 'codex', instanceId: 'default' }],
      ['providers:redetect', { providerId: 'codex', instanceId: 'default' }],
      ['providers:pickExecutable', { providerId: 'codex' }],
      ['shell:openLink', { providerId: 'codex' }],
    ] as const) {
      const answer = await invokeStatus(pet, channel, request);
      if (answer !== 'forbidden') problems.push(`pet: ${channel} answered ${String(answer)}, expected forbidden`);
    }

    const refresh = await invokeStatus(main, 'providers:refresh', { providerId: 'codex', instanceId: 'default' });
    if (refresh !== 'accepted') problems.push(`Codex refresh answered ${String(refresh)}`);

    if (await patchProvider({ enabled: false }) !== 'ok') problems.push('Codex disable preference was refused');
    await waitFor('Codex to disable', () => codex()?.status.kind === 'disabled');
    // Disabled: its report goes, and with nothing to adjust, the user's catalog.json lists nothing (C94, C95).
    const listed = store.getSnapshot().catalog?.providers.find((provider) => provider.id === 'codex');
    if (listed?.source.kind !== 'none' || listed.models.length !== 0) problems.push(`catalog: disabled Codex lists ${listed?.models.length ?? 'no entry'} model(s) from ${listed?.source.kind ?? 'nothing'}`);
    if (await patchProvider({ enabled: true }) !== 'ok') problems.push('Codex enable preference was refused');
    await waitFor('Codex to re-enable', () => codex()?.status.kind === 'ok');

    const missing = path.join(app.getPath('temp'), `fatg-smoke-missing-${process.pid}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (await patchProvider({ executablePath: missing }) !== 'ok') problems.push('Codex override preference was refused');
    await waitFor('the invalid Codex override to be refused without fallback', () => {
      const status = codex()?.status;
      return status?.kind === 'not-installed' && status.overrideInvalid;
    });
    if (await patchProvider({ executablePath: null }) !== 'ok') problems.push('clearing the Codex override was refused');
    await waitFor('Codex automatic detection to recover', () => codex()?.status.kind === 'ok');

    // The fixture caches this at process start. Ordinary refresh must stay signed in; redetection
    // must replace only fat-g's process and observe the new synthetic state.
    writeFileSync(accountStateFile, 'logged-out');
    const beforeCachedRead = codex()?.asOf ?? 0;
    await invokeStatus(main, 'providers:refresh', { providerId: 'codex', instanceId: 'default' });
    await waitFor('a cached-account full refresh', () => (codex()?.asOf ?? 0) > beforeCachedRead && codex()?.status.kind === 'ok');
    await invokeStatus(main, 'providers:redetect', { providerId: 'codex', instanceId: 'default' });
    await waitFor('after-login reconnect to observe logged-out fixture state', () => codex()?.status.kind === 'not-logged-in');
    writeFileSync(accountStateFile, 'subscription');
    await invokeStatus(main, 'providers:redetect', { providerId: 'codex', instanceId: 'default' });
    await waitFor('Codex sign-in fixture recovery', () => codex()?.status.kind === 'ok');

    const beforeCrashPids = countFixturePids();
    const beforeCrashRefresh = codex()?.asOf ?? 0;
    writeFileSync(controlFile, JSON.stringify({ crashUsage: 1 }));
    await waitFor('Codex recovery after a fixture crash', () =>
      countFixturePids() > beforeCrashPids && (codex()?.asOf ?? 0) > beforeCrashRefresh && codex()?.status.kind === 'ok');

    const beforeHangPids = countFixturePids();
    const beforeHangRefresh = codex()?.asOf ?? 0;
    writeFileSync(controlFile, JSON.stringify({ hangAccount: 2 }));
    await waitFor('Codex recovery after two live request timeouts', () =>
      countFixturePids() > beforeHangPids && (codex()?.asOf ?? 0) > beforeHangRefresh && codex()?.status.kind === 'ok');

    report['codexProvider'] = {
      version: codex()?.installation?.version,
      pushedUsageVerified: 42,
      refresh,
      disabledAndEnabled: true,
      invalidOverrideRefused: true,
      cachedAccountReconnect: true,
      crashRecovered: true,
      liveHangRecovered: true,
    };
  }

  /**
   * The catalog (M13, V18, V25). scripts/smoke.mjs placed a catalog.json in the smoke data folder —
   * a valid one hiding GPT-5.5, or a broken one — and says which in FATG_SMOKE_CATALOG. Both fixtures'
   * model lists must reach the Main window's catalog, the file must be applied or ignored as placed,
   * Reload must answer the same, the data folder request must reach the stand-in and open nothing,
   * and the Pet may have none of it. Runs while providers poll: nothing here compares `seq`.
   */
  async function checkCatalog(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const placed = process.env['FATG_SMOKE_CATALOG'];
    if (placed !== 'valid' && placed !== 'broken') {
      problems.push('catalog: the smoke catalog.json was not placed');
      return;
    }
    // Each provider's first account: a later run also has the second Codex account checkInstances adds (M14b).
    const entry = (id: string) => store.getSnapshot().catalog?.providers.find((provider) => provider.id === id && provider.instanceId === FIRST_INSTANCE_ID);
    const keys = (id: string) => entry(id)?.models.map((model) => model.key) ?? [];
    // Every account's report: the user's catalog.json is applied to each one's own list (M14b, C20).
    const codexEntries = () => store.getSnapshot().catalog?.providers.filter((provider) => provider.id === 'codex') ?? [];
    const reported = await waitFor('both fixtures to report their models', () => entry('claude')?.source.kind === 'report' && codexEntries().length > 0 && codexEntries().every((listed) => listed.source.kind === 'report'));
    if (!reported) return;
    if (keys('claude').join() !== CLAUDE_FIXTURE_MODELS.join()) problems.push(`catalog: Claude lists ${keys('claude').join(', ')}`);
    if (keys('codex').join() !== CODEX_FIXTURE_MODELS.join()) problems.push(`catalog: Codex lists ${keys('codex').join(', ')}`);

    const status = store.getSnapshot().catalog?.override;
    const retired = entry('codex')?.models.find((model) => model.key === 'gpt-5.5');
    if (placed === 'valid') {
      // GPT-5.5 hidden once for each Codex account that lists it: the fixture's second account does too.
      if (status?.kind !== 'applied' || status.hidden !== codexEntries().length || status.added !== 0) problems.push(`catalog: the valid catalog.json is ${JSON.stringify(status)}`);
      if (retired?.hidden !== true || !retired.hiddenByOverride) problems.push('catalog: the valid catalog.json did not hide GPT-5.5');
    } else {
      if (status?.kind !== 'ignored' || status.cause !== 'invalid') problems.push(`catalog: the broken catalog.json is ${JSON.stringify(status)}`);
      if (retired === undefined || retired.hidden) problems.push('catalog: with the broken catalog.json ignored, GPT-5.5 is not listed as reported');
    }

    // What the Main page receives, and what Reload answers there.
    const onPage = (await main.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null)
      .then((r) => r.ok ? { providers: r.value.catalog?.providers.filter((p) => p.instanceId === 'default').map((p) => p.models.length), override: r.value.catalog?.override.kind } : null, () => null)`)) as { providers?: number[]; override?: string } | null;
    if (onPage?.providers?.join() !== `${CLAUDE_FIXTURE_MODELS.length},${CODEX_FIXTURE_MODELS.length}` || onPage.override !== status?.kind) problems.push(`main: its catalog is ${JSON.stringify(onPage)}`);
    const reload = await invokeStatus(main, 'catalog:reload', null);
    const reloaded = (await main.webContents.executeJavaScript(`window.fatg.invoke('catalog:reload', null).then((r) => r.ok ? r.value.kind : r.error, () => 'failed')`)) as unknown;
    if (reload !== 'ok' || reloaded !== status?.kind) problems.push(`main: catalog:reload answered ${String(reloaded)}, expected ${String(status?.kind)}`);

    // The data folder: the stand-in answers, and nothing opens (C71).
    const before = dataFolderRequests.count;
    const shown = await invokeStatus(main, 'shell:showDataFolder', null);
    if (shown !== 'ok' || dataFolderRequests.count !== before + 1) problems.push(`main: shell:showDataFolder answered ${String(shown)}, and reached the stand-in ${dataFolderRequests.count - before} time(s)`);

    // The Pet: no catalog in its state, and neither channel (S8, C50).
    for (const channel of ['catalog:reload', 'shell:showDataFolder']) {
      const answer = await invokeStatus(pet, channel, null);
      if (answer !== 'forbidden') problems.push(`pet: ${channel} answered ${String(answer)}, expected forbidden`);
    }
    if (dataFolderRequests.count !== before + 1) problems.push('pet: its shell:showDataFolder reached the stand-in');
    const petHasCatalog = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => r.ok ? 'catalog' in r.value || r.value.providers.some((provider) => 'presentation' in provider) : 'failed')`)) as unknown;
    if (petHasCatalog !== false) problems.push(`pet: its snapshot ${petHasCatalog === true ? 'holds the catalog or a presentation' : `could not be read (${String(petHasCatalog)})`}`);

    report['catalog'] = {
      placed, override: status?.kind, claude: keys('claude').length, codex: keys('codex').length,
      gpt55Hidden: retired?.hidden, reload: reloaded, dataFolderStandIn: dataFolderRequests.count - before, petHasCatalog,
    };
  }

  /** Both windows opened where the preferences read at start-up say — as fitted to today's displays. */
  async function checkRestore(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const layout = currentDisplayLayout();
    // The mini window cannot maximize. Measure the current rectangle, as fitPet does;
    // retain the normal-bounds reading to diagnose native restore/read-back differences.
    const petNow = () => {
      const bounds = pet.getBounds();
      // At the size its list asks for now: the Pet follows its list from the moment it opens.
      return { actual: roundRect(bounds), expected: openingPetBounds(loaded.windows.pet.bounds, petContentSize(petView(store.getSnapshot())), layout, screen.getDisplayMatching(bounds).scaleFactor) };
    };
    let petRead = petNow();
    let page: readonly [number, number] = [0, 0];
    // Its page is measured, not its window: at a half-pixel place a read-back is a DIP over. Waited
    // for, as a session the demo source moves can change its list between two readings.
    const petPlaced = await waitFor('the Pet to open at its list’s size', async () => {
      page = (await pet.webContents.executeJavaScript('[innerWidth, innerHeight]')) as [number, number];
      petRead = petNow();
      return petRestoredAt(petRead.actual, page, petRead.expected);
    });
    // The Dock can change the work area after launch. Use the layout the Main window opened on.
    const expected = { main: fitBoundsToDisplays(loaded.windows.main.bounds, openingLayout, MAIN_PLACEMENT), pet: petRead.expected };
    const actual = { main: roundRect(main.getNormalBounds()), pet: petRead.actual };
    report['restore'] = {
      from: loaded.windows.main.bounds === null ? 'defaults (first run in this directory — run again to check a restore)' : 'the previous run',
      expected,
      actual,
      petPage: { width: page[0], height: page[1] },
      petNormal: roundRect(pet.getNormalBounds()),
    };
    if (!restoredAt(actual.main, expected.main)) problems.push(`main: opened at ${JSON.stringify(actual.main)}, expected ${JSON.stringify(expected.main)}`);
    if (!petPlaced) problems.push(`pet: opened at ${JSON.stringify(actual.pet)}, its page ${page[0]} × ${page[1]}, expected ${JSON.stringify(expected.pet)}`);
    if (main.isMaximized() !== loaded.windows.main.maximized) problems.push(`main: maximized is ${main.isMaximized()}, the preferences say ${loaded.windows.main.maximized}`);
    // A window that is created and never shown leaves the app running with nothing to reach it by:
    // seen with the Main window saved on a second display of another scaling (src/main/windows/ready.ts).
    if (!main.isVisible()) problems.push('main: the window was created and never shown');
  }

  const pageTheme = (window: BrowserWindow): Promise<unknown> => window.webContents.executeJavaScript(`document.documentElement.getAttribute('data-theme')`);
  const windowPaints = (window: BrowserWindow, theme: Theme): boolean => window.getBackgroundColor().toLowerCase() === windowBackground(theme);

  /**
   * The theme (C52): both windows carry the one read from disk at start-up — on the page and in the
   * window's own background — and a change made through the bridge reaches both windows, both
   * backgrounds and the disk. The run leaves it flipped, so the next one starts from the other theme.
   */
  async function checkTheme(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const start = loaded.appearance.theme;
    for (const [kind, window] of [['main', main], ['pet', pet]] as const) {
      const onPage = await pageTheme(window);
      if (onPage !== start) problems.push(`${kind}: the page's theme at start was ${String(onPage)}, the preferences say ${start}`);
      if (!windowPaints(window, start)) problems.push(`${kind}: the window background at start was ${window.getBackgroundColor()}, expected ${windowBackground(start)}`);
    }
    const other: Theme = start === 'light' ? 'dark' : 'light';
    const answer = (await main.webContents.executeJavaScript(invokeFrom('prefs:patch', JSON.stringify({ appearance: { theme: other } })))) as unknown;
    if (answer !== 'ok') problems.push(`main: changing the theme answered ${String(answer)}`);
    await waitFor(`both windows to follow the ${other} theme`, async () =>
      (await pageTheme(main)) === other && (await pageTheme(pet)) === other && windowPaints(main, other) && windowPaints(pet, other));
    await waitFor(`the ${other} theme to reach preferences.json`, () => readPreferencesFile().appearance?.theme === other);
    report['theme'] = { atStart: start, changedTo: other, onDisk: readPreferencesFile().appearance?.theme, background: { main: main.getBackgroundColor(), pet: pet.getBackgroundColor() } };
  }

  /**
   * Optional captures for the maintainer's visual review (M11, V17); never enabled by the normal smoke
   * scripts. FATG_SMOKE_VISUAL_DIR names an absolute folder: the Main window in both themes, at the
   * default and the minimum size, with the projects on each side, with Settings open, with a usage
   * panel shown, and narrowed until the overflow arrows show. Everything it changes is put back.
   */
  async function captureVisuals(main: BrowserWindow): Promise<void> {
    const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
    if (directory === undefined) return;
    if (!path.isAbsolute(directory)) {
      problems.push('the visual capture folder must be an absolute path');
      return;
    }
    mkdirSync(directory, { recursive: true });
    // Review-only fixture shape: a long model label, a critical binding window with no reset time.
    const claudeDirectory = process.env['FATG_SMOKE_CLAUDE_DIR'];
    if (claudeDirectory && path.isAbsolute(claudeDirectory)) {
      writeFileSync(path.join(claudeDirectory, 'usage-shape'), 'visual');
      usage.resume();
      await waitFor('the Claude visual-review shape', () => store.getSnapshot().providers
        .find((provider) => provider.id === 'claude')?.usage?.windows.some((window) => window.scope?.startsWith('Fable 5 Extended') === true) === true);
      usage.suspend();
      await delay(SETTLE_MS);
    }
    // capturePage can return the last painted frame of an occluded window; a resize forces a
    // fresh one, so every capture follows one.
    const original = main.getBounds();
    const before = prefs.getSnapshot().values;
    const saved: string[] = [];
    const resize = async (size: { width: number; height: number }): Promise<void> => {
      // One pixel wider, not narrower: at the minimum size a narrower window is clamped, nothing
      // repaints, and the capture would show the frame before.
      main.setBounds({ ...original, width: size.width + 1, height: size.height });
      await delay(50);
      main.setBounds({ ...original, ...size });
      await delay(250);
    };
    const shoot = async (name: string): Promise<void> => {
      writeFileSync(path.join(directory, `${name}.png`), (await main.webContents.capturePage()).toPNG());
      saved.push(name);
    };
    const capture = async (name: string, size: { width: number; height: number } = original): Promise<void> => {
      await resize(size);
      await shoot(name);
    };
    // capturePage sees only the page. The window buttons the OS draws over the title strip are seen
    // only in a capture of the window itself — this window's, and no other's — whole, and its
    // top-right corner at full size. Skipped where the platform cannot capture a window.
    const shootWindow = async (name: string): Promise<void> => {
      const bounds = main.getBounds();
      const scale = screen.getDisplayMatching(bounds).scaleFactor;
      let image: NativeImage | undefined;
      try {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) },
        });
        image = sources.find((source) => source.id === main.getMediaSourceId())?.thumbnail;
      } catch {
        return;
      }
      if (image === undefined || image.isEmpty()) return;
      const { width, height } = image.getSize();
      writeFileSync(path.join(directory, `${name}.png`), image.toPNG());
      const corner = { width: Math.min(width, 640), height: Math.min(height, 200) };
      writeFileSync(path.join(directory, `${name}-corner.png`), image.crop({ x: width - corner.width, y: 0, ...corner }).toPNG());
      saved.push(name, `${name}-corner`);
    };
    const set = async (patch: Record<string, unknown>): Promise<void> => {
      await main.webContents.executeJavaScript(invokeFrom('prefs:patch', JSON.stringify(patch)));
      await delay(300);
    };
    const page = (script: string): Promise<unknown> => main.webContents.executeJavaScript(script);

    for (const theme of ['light', 'dark'] as const) {
      await set({ appearance: { theme }, layout: { projectColumn: 'left' } });
      await capture(`${theme}-default`);
      await shootWindow(`${theme}-window`);
      await capture(`${theme}-minimum`, MAIN_PLACEMENT.minSize);
      await set({ layout: { projectColumn: 'right' } });
      await capture(`${theme}-projects-right`);
      await set({ layout: { projectColumn: 'left' } });

      // Settings, opened the way a user would, from the gear. It opens at the tab it last showed
      // (M101, C7), so each capture names its tab: General, the first, here.
      const openSettingsAt = async (tab: string): Promise<void> => {
        await page(`document.querySelector('[role="toolbar"] button[aria-label="Settings"]').click()`);
        await page(`document.getElementById('settings-tab-${tab}')?.click()`);
        await delay(300);
      };
      await resize(original);
      await openSettingsAt('general');
      await shoot(`${theme}-settings`);
      await shootWindow(`${theme}-settings-window`);
      // The Accounts tab, where each provider's models are (M13, C83–C87; M101, C3), at both sizes.
      // Each capture follows a resize, for a fresh frame.
      const showProviders = async (name: string, size: { width: number; height: number }): Promise<void> => {
        await page(`document.getElementById('settings-tab-accounts')?.click()`);
        await delay(200);
        await capture(name, size);
      };
      await showProviders(`${theme}-settings-providers`, original);
      await page(`document.querySelector('dialog[open]')?.close()`);
      await resize(MAIN_PLACEMENT.minSize);
      await openSettingsAt('general');
      await capture(`${theme}-settings-minimum`, MAIN_PLACEMENT.minSize);
      await showProviders(`${theme}-settings-providers-minimum`, MAIN_PLACEMENT.minSize);
      await page(`document.querySelector('dialog[open]')?.close()`);
      await resize(original);

      // The project column (M12, V16): the hidden list open, and the project dialog at both sizes.
      if ((await page(`(() => { const row = document.querySelector('[data-hidden-row]'); row?.click(); return row !== null; })()`)) === true) {
        await delay(200);
        await capture(`${theme}-hidden-open`);
        await page(`document.querySelector('[data-hidden-row]')?.click()`);
      }
      // A drag in progress (C86): the first project pulled below the third, then cancelled with
      // Escape, so nothing is saved. Real mouse input, so the page sees real pointer events.
      const heads = (await page(`[...document.querySelectorAll('aside [data-entry-key] > div')].slice(0, 3).map((head) => {
        const rect = head.getBoundingClientRect();
        return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2), height: rect.height };
      })`)) as { x: number; y: number; height: number }[];
      const [first, , third] = heads;
      if (first !== undefined && third !== undefined) {
        const input = main.webContents;
        // A window in the background runs no transitions: show where the headers settle.
        await page(`document.documentElement.style.setProperty('--duration-fast', '0ms')`);
        input.sendInputEvent({ type: 'mouseDown', x: first.x, y: first.y, button: 'left', clickCount: 1 });
        for (const y of [first.y + 6, first.y + 20, third.y + third.height / 2 - 4]) {
          input.sendInputEvent({ type: 'mouseMove', x: first.x, y: Math.round(y), modifiers: ['leftbuttondown'] });
          await delay(60);
        }
        await delay(400);
        input.invalidate();
        await delay(100);
        await shoot(`${theme}-drag`);
        input.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        input.sendInputEvent({ type: 'mouseUp', x: first.x, y: first.y, button: 'left', clickCount: 1 });
        await page(`document.documentElement.style.removeProperty('--duration-fast')`);
        await delay(100);
      }
      await page(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Add project')?.click()`);
      await delay(300);
      await capture(`${theme}-project-dialog`);
      await capture(`${theme}-project-dialog-minimum`, MAIN_PLACEMENT.minSize);
      await page(`document.querySelector('dialog[open]')?.close()`);
      await resize(original);

      // The rightmost block's panel: the one most likely to meet the window's edge.
      const point = (await page(`(() => {
        const blocks = document.querySelectorAll('[data-usage-block]');
        const rect = blocks[blocks.length - 1]?.getBoundingClientRect();
        return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
      })()`)) as { x: number; y: number } | null;
      if (point !== null) {
        main.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        await delay(300);
        await shoot(`${theme}-usage-panel`);
        main.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: original.height - 5 });
        await delay(100);
      }

      // Narrower than the Main window may be, until the blocks no longer fit.
      main.setMinimumSize(600, MAIN_PLACEMENT.minSize.height);
      await capture(`${theme}-overflow-arrows`, { width: 900, height: MAIN_PLACEMENT.minSize.height });
      main.setMinimumSize(MAIN_PLACEMENT.minSize.width, MAIN_PLACEMENT.minSize.height);
    }

    await set({ appearance: { theme: before.appearance.theme }, layout: { projectColumn: before.layout.projectColumn } });
    main.setBounds(original);
    await delay(100);
    report['visualCapture'] = saved;
  }

  /**
   * Changes a preference from inside the Main window, then reads the file back. The value differs
   * from whatever the file already holds, so a leftover from an earlier run cannot pass for it.
   */
  async function checkPreferencesRoundTrip(main: BrowserWindow): Promise<void> {
    const clamped = (await main.webContents.executeJavaScript(patchProbe(1))) as unknown;
    if (clamped !== POLL_INTERVAL_SEC.min) {
      problems.push(`main: a poll interval of 1 was saved as ${String(clamped)}, expected it clamped to ${POLL_INTERVAL_SEC.min}`);
    }

    const before = readPreferencesFile().usage?.pollIntervalSec;
    let wanted = POLL_INTERVAL_SEC.min + 1 + (Date.now() % (POLL_INTERVAL_SEC.max - POLL_INTERVAL_SEC.min - 1));
    if (wanted === before) wanted = wanted + 1 > POLL_INTERVAL_SEC.max ? POLL_INTERVAL_SEC.min + 1 : wanted + 1;
    const saved = (await main.webContents.executeJavaScript(patchProbe(wanted))) as unknown;
    if (saved !== wanted) problems.push(`main: a patched preference came back as ${String(saved)}, expected ${wanted}`);

    await waitFor('the poll interval to reach preferences.json', () => readPreferencesFile().usage?.pollIntervalSec === wanted);
    report['prefs'] = { clamped, wanted, saved, onDisk: readPreferencesFile().usage?.pollIntervalSec };
  }

  /**
   * The records (M12, V15). The previous run left a project named "Smoke project" and noted what it
   * left beside it (smoke-records.json, in this throwaway data folder): it must be back, as left. Then
   * this run changes it through the Main page, as the UI would — a first run adds it, trusted and
   * visible; a later one flips its trust answer and its hidden flag, so a leftover file can never make
   * a check pass — and every answered change must already be on disk (C9). The Pet sees none of it,
   * and may change none of it (C52).
   */
  async function checkRecords(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const folder = process.env['FATG_SMOKE_PICK_FOLDER'];
    if (folder === undefined || !path.isAbsolute(folder)) {
      problems.push('the smoke project folder is missing');
      return;
    }
    const root = normalizeRoot(folder, process.platform);
    const marker = path.join(app.getPath('userData'), SMOKE_RECORDS_MARKER);
    const expected = readJson(marker) as { trust?: unknown; hidden?: unknown } | null;
    const smokeProject = (projects: readonly StoredEntry[]) => projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    if (recordsAtStart.status.kind !== 'ok') problems.push(`records: the file was refused at start (${recordsAtStart.status.cause})`);
    const previous = smokeProject(recordsAtStart.projects);
    if (previous === undefined) {
      if (expected !== null) problems.push('records: the previous run’s project is not back');
    } else {
      const [first] = previous.roots;
      if (previous.roots.length !== 1 || first?.path !== root) problems.push('records: the smoke project’s root is not the one it was given');
      if (expected !== null && (first?.trust !== expected.trust || previous.hidden !== expected.hidden)) {
        problems.push(`records: the smoke project came back ${String(first?.trust)}/${previous.hidden ? 'hidden' : 'shown'}, the previous run left ${String(expected.trust)}/${expected.hidden === true ? 'hidden' : 'shown'}`);
      }
    }

    const ask = async (channel: string, request: unknown): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: string }> =>
      (await main.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).catch(() => ({ ok: false, error: 'failed' }))`)) as never;
    const pick = await ask('projects:pickFolder', { projectId: previous?.id ?? null, roots: [] });
    if (pick.value?.['status'] !== 'picked' || pick.value['path'] !== root) {
      problems.push(`records: the stand-in picker answered ${JSON.stringify(pick.value ?? pick.error)}`);
      return;
    }

    const trust = previous === undefined || previous.roots[0]?.trust !== 'trusted' ? 'trusted' : 'not-trusted';
    const hidden = previous === undefined ? false : !previous.hidden;
    let id = previous?.id;
    if (previous === undefined) {
      const added = await ask('projects:add', { name: SMOKE_PROJECT, color: 'teal', roots: [{ path: root, trust }], providers: ['codex'] });
      id = typeof added.value?.['id'] === 'string' ? added.value['id'] : undefined;
      if (added.value?.['status'] !== 'saved' || id === undefined) problems.push(`records: adding the smoke project answered ${JSON.stringify(added.value ?? added.error)}`);
    } else {
      const updated = await ask('projects:update', { id: previous.id, name: SMOKE_PROJECT, roots: [{ path: root, trust }], providers: previous.providers.length > 0 ? previous.providers : ['codex'] });
      if (updated.value?.['status'] !== 'saved') problems.push(`records: changing its trust answer answered ${JSON.stringify(updated.value ?? updated.error)}`);
      const flipped = await ask('projects:setHidden', { id: previous.id, hidden });
      if (flipped.value?.['status'] !== 'saved') problems.push(`records: changing its hidden flag answered ${JSON.stringify(flipped.value ?? flipped.error)}`);
    }

    // Answered, so on disk already (C9): no waiting here.
    const onDisk = (readJson(path.join(app.getPath('userData'), RECORDS_FILE)) as { projects?: Record<string, unknown>[] } | null)?.projects?.find((entry) => entry['id'] === id);
    const diskTrust = (onDisk?.['roots'] as { trust?: { answer?: unknown } }[] | undefined)?.[0]?.trust?.answer;
    if (onDisk === undefined || diskTrust !== trust || onDisk['hidden'] !== hidden) problems.push(`records: records.json holds ${JSON.stringify({ trust: diskTrust, hidden: onDisk?.['hidden'] })}, expected ${JSON.stringify({ trust, hidden })}`);
    const shown = smokeProject(records.getView().projects);
    if (shown?.roots[0]?.trust !== trust || shown.hidden !== hidden) problems.push('records: the view does not match what was saved');

    // The Main page shows it — by name, or counted in the hidden row — with no CSP violation.
    await waitFor('the smoke project to show in the project column', async () => (await main.webContents.executeJavaScript(`(() => {
      const column = document.querySelector('aside[aria-label="Projects"]');
      const text = column?.textContent ?? '';
      return ${hidden ? String.raw`/\d+ hidden projects?/.test(text)` : `text.includes(${JSON.stringify(SMOKE_PROJECT)})`};
    })()`)) === true);
    const csp = (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null`)) as unknown;
    if (csp !== '0') problems.push(`main: CSP violations after the records changes: ${String(csp)}`);

    // The Pet: no records in its state, and no records channel (C52, C82).
    const petSnapshot = await invokeStatus(pet, 'state:getSnapshot', null);
    const petHasRecords = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => r.ok ? 'records' in r.value : 'failed')`)) as unknown;
    if (petSnapshot !== 'ok' || petHasRecords !== false) problems.push(`pet: its snapshot ${petHasRecords === true ? 'holds records' : `could not be read (${String(petHasRecords)})`}`);
    const petAdd = await invokeStatus(pet, 'projects:add', { name: 'x', color: 'red', roots: [{ path: root, trust: 'trusted' }], providers: ['codex'] });
    if (petAdd !== 'forbidden') problems.push(`pet: projects:add answered ${String(petAdd)}, expected forbidden`);
    const openRoot = { projectId: id ?? null, path: root };
    const openedRoot = await invokeStatus(main, 'projects:openFolder', openRoot);
    if (openedRoot !== 'ok') problems.push(`records: opening the saved project folder answered ${String(openedRoot)}`);
    const petOpenRoot = await invokeStatus(pet, 'projects:openFolder', openRoot);
    if (petOpenRoot !== 'forbidden') problems.push(`pet: projects:openFolder answered ${String(petOpenRoot)}, expected forbidden`);

    // What the previous run noted of its sessions is the next check's to read (M14).
    writeFileSync(marker, JSON.stringify({ ...(readJson(marker) as Record<string, unknown> | null), trust, hidden }));
    report['records'] = { from: previous === undefined ? 'nothing (first run in this directory — run again to check a restore)' : 'the previous run', trust, hidden, onDisk: true };
  }

  /**
   * The sessions (M14, C65, C68, V17). The demo source seeds the smoke project with three sessions and
   * drives them. The previous run noted, beside its project, which session it starred, which it
   * shelved, which it completed and which were in a turn when it quit: they must be back so, the last
   * showing STOPPED before any event. Then this run removes the completed one, takes the shelved one
   * off the shelf, creates one from the Main page with the default preset, selects one, flips a star,
   * shelves one, and flags one To verify and completes it — Done clearing To verify and keeping the
   * star — shelving and completing each once its session is between turns, asking again if a turn
   * began first. Every answered change is on disk already. The Pet gets none of it.
   */
  async function checkSessions(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const source = demo();
    if (source === undefined) {
      problems.push('sessions: the demo source did not load');
      return;
    }
    const project = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    if (project === undefined) {
      problems.push('sessions: the smoke project is missing');
      return;
    }
    const marker = path.join(app.getPath('userData'), SMOKE_RECORDS_MARKER);
    const noted = (readJson(marker) as { sessions?: { starred?: { id?: string; starred?: boolean }; shelved?: string; completed?: string; running?: string[] } } | null)?.sessions;
    const ask = async (channel: string, request: unknown): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: string }> =>
      (await main.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).catch(() => ({ ok: false, error: 'failed' }))`)) as never;
    const onDisk = (id: string) => (readJson(path.join(app.getPath('userData'), RECORDS_FILE)) as { sessions?: Record<string, unknown>[] } | null)?.sessions?.find((entry) => entry['id'] === id);
    // The project's sessions on its provider's first account: the one on the second account is checkInstances' (M14b).
    const mine = () => sessions.snapshot().sessions.filter((entry) => entry.record.projectId === project.id && entry.record.instanceId === FIRST_INSTANCE_ID);

    // 1 and 2: what the previous run left, as the records gave it back before any event.
    if (noted !== undefined) {
      const atStart = (id: string | undefined) => sessionsAtStart.sessions.find((entry) => entry.record.id === id);
      for (const id of noted.running ?? []) {
        const entry = atStart(id);
        if (entry?.summary.attention?.kind !== 'stopped' || entry.summary.status === 'running') problems.push('sessions: a turn the previous run left running does not show STOPPED at start');
      }
      if (atStart(noted.starred?.id)?.record.starred !== noted.starred?.starred) problems.push('sessions: the star the previous run set is not back');
      if (noted.shelved !== undefined) {
        const shelved = atStart(noted.shelved);
        if (shelved === undefined || shelved.record.shelvedAt === null) problems.push('sessions: the session the previous run shelved is not back on the shelf');
        else {
          // Back to the active list, so the demo source drives it again and this run can shelve one.
          const unshelved = await ask('sessions:restore', { id: shelved.record.id });
          if (unshelved.value?.['status'] !== 'saved' || onDisk(shelved.record.id)?.['shelvedAt'] !== null) problems.push(`sessions: unshelving answered ${JSON.stringify(unshelved.value ?? unshelved.error)}`);
        }
      }
      const completed = atStart(noted.completed);
      if (completed === undefined || completed.record.completedAt === null) problems.push('sessions: the session the previous run completed is not back completed');
      else {
        // It makes room for a new one, created from the Main page as Start session creates it.
        const removed = await ask('sessions:remove', { id: completed.record.id });
        if (removed.value?.['status'] !== 'saved') problems.push(`sessions: removing the completed session answered ${JSON.stringify(removed.value ?? removed.error)}`);
        if (onDisk(completed.record.id) !== undefined) problems.push('sessions: the removed session is still in records.json');
        const preset = defaultPreset(presetTiles(store.getSnapshot().catalog, project.providers.map((providerId) => ({ providerId, instanceId: FIRST_INSTANCE_ID }))));
        const created = await ask('sessions:create', { projectId: project.id, preset });
        const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
        if (created.value?.['status'] !== 'saved' || onDisk(id)?.['model'] !== preset?.model) problems.push(`sessions: creating a session answered ${JSON.stringify(created.value ?? created.error)}`);
        if (sessions.snapshot().selectedId !== id) problems.push('sessions: the created session is not the selected one');
        // A name of the lowest rank, as a source would report one: M14 has no rename, and the captures read better.
        sessions.apply({ type: 'name-reported', sessionId: id, name: 'Created by the smoke run', source: 'first-message' });
        await sessions.settled();
        if (onDisk(id)?.['name'] !== 'Created by the smoke run') problems.push('sessions: the reported name is not in records.json');
      }
    }

    // 3: three sessions under the project — seeded on the first run, kept at three on the later ones.
    if (!(await waitFor('three sessions under the smoke project', () => mine().length === 3))) return;
    const [first, second, third] = mine();
    if (first === undefined || second === undefined || third === undefined) return;
    if (mine().some((entry) => onDisk(entry.record.id) === undefined)) problems.push('sessions: a session the Main window shows is not in records.json');

    const selected = await ask('sessions:select', { id: first.record.id });
    if (selected.value?.['status'] !== 'saved' || sessions.snapshot().selectedId !== first.record.id) problems.push(`sessions: selecting one answered ${JSON.stringify(selected.value ?? selected.error)}`);

    const starred = !second.record.starred;
    const flipped = await ask('sessions:setFlag', { id: second.record.id, flag: 'starred', on: starred });
    if (flipped.value?.['status'] !== 'saved' || onDisk(second.record.id)?.['starred'] !== starred) problems.push(`sessions: flipping a star answered ${JSON.stringify(flipped.value ?? flipped.error)}`);

    // Shelve is refused while the session runs, as Done is, and writes nothing before a first turn: asked again until it is on disk.
    let shelveRefusals = 0;
    let shelveUnexpected: string | null = null;
    const shelvedNow = await waitFor('a session to be shelved between its turns', async () => {
      if (sessions.isRunning(second.record.id)) return false;
      const answer = await ask('sessions:shelve', { id: second.record.id });
      if (answer.value?.['status'] === 'saved') return typeof onDisk(second.record.id)?.['shelvedAt'] === 'number';
      if (answer.value?.['reason'] !== 'running') shelveUnexpected = JSON.stringify(answer.value ?? answer.error);
      else shelveRefusals += 1;
      return shelveUnexpected !== null;
    }, 30_000);
    if (shelveUnexpected !== null) problems.push(`sessions: shelving one answered ${String(shelveUnexpected)}`);
    const shelved = shelvedNow && shelveUnexpected === null;

    // Done keeps the star and clears the other flags.
    for (const [flag, on] of [['starred', true], ['toVerify', true]] as const) {
      const set = await ask('sessions:setFlag', { id: third.record.id, flag, on });
      if (set.value?.['status'] !== 'saved' || onDisk(third.record.id)?.[flag] !== on) problems.push(`sessions: setting ${flag} answered ${JSON.stringify(set.value ?? set.error)}`);
    }

    // Complete is refused while the session runs (C35, C114): asked again once it is between turns.
    let refusals = 0;
    let unexpected: string | null = null;
    const answered = await waitFor('a session to be completed between its turns', async () => {
      if (sessions.isRunning(third.record.id)) return false;
      const answer = await ask('sessions:complete', { id: third.record.id });
      if (answer.value?.['status'] === 'saved') return true;
      if (answer.value?.['reason'] !== 'running') unexpected = JSON.stringify(answer.value ?? answer.error);
      else refusals += 1;
      return unexpected !== null;
    }, 30_000);
    if (unexpected !== null) problems.push(`sessions: completing one answered ${String(unexpected)}`);
    const completed = answered && unexpected === null;
    if (completed && typeof onDisk(third.record.id)?.['completedAt'] !== 'number') problems.push('sessions: the completion is not in records.json');
    if (completed && onDisk(third.record.id)?.['reference'] !== null) problems.push('sessions: a demo session was given a provider reference');
    if (completed && (onDisk(third.record.id)?.['toVerify'] !== false || onDisk(third.record.id)?.['starred'] !== true)) problems.push('sessions: Done did not clear To verify and keep the star');

    // The Main page shows them — unless this run left the project hidden — with no CSP violation: each
    // active one as its capsule. The shelved and the completed ones are in folds that start closed.
    if (!project.hidden) {
      const shown = JSON.stringify(mine().filter((entry) => isActive(entry.record)).map((entry) => entry.record.id));
      await waitFor('the sessions to show under the smoke project', async () =>
        (await main.webContents.executeJavaScript(`${shown}.every((id) => document.querySelector('aside[aria-label="Projects"] [data-session-id="' + id + '"]') !== null)`)) as boolean);
    }
    const csp = (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null`)) as unknown;
    if (csp !== '0') problems.push(`main: CSP violations after the session changes: ${String(csp)}`);

    // 4: the Pet has no session in its state, and no session channel (C65; decision 0010).
    const petKeys = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => r.ok ? Object.keys(r.value).filter((key) => key === 'sessions' || key === 'quitQuestion') : ['failed'])`)) as string[];
    if (petKeys.length > 0) problems.push(`pet: its snapshot holds ${petKeys.join(', ')}`);
    const petCreate = await invokeStatus(pet, 'sessions:create', { projectId: project.id, preset: { providerId: 'codex', instanceId: FIRST_INSTANCE_ID, model: 'gpt-6-sol', effort: 'high', speed: null } });
    const petAnswer = await invokeStatus(pet, 'app:answerQuit', { quit: true });
    if (petCreate !== 'forbidden' || petAnswer !== 'forbidden') problems.push(`pet: sessions:create answered ${String(petCreate)} and app:answerQuit ${String(petAnswer)}, expected forbidden`);

    const previous = readJson(marker) as Record<string, unknown> | null;
    writeFileSync(marker, JSON.stringify({ ...previous, sessions: { starred: { id: second.record.id, starred }, ...(shelved ? { shelved: second.record.id } : {}), completed: third.record.id, running: [] } }));
    report['sessions'] = {
      from: noted === undefined ? 'the seed (first run with this project — run again to check a restore)' : 'the previous run',
      stoppedAtStart: noted?.running?.length ?? 0, underProject: mine().length, selected: true, starred, shelved, shelveRefusedWhileRunning: shelveRefusals, completed, completeRefusedWhileRunning: refusals,
    };
  }

  /**
   * An image (M23, V12; C10, C14, C79): a synthetic PNG staged from the Main page over
   * `attachments:stage` into a smoke session's draft, then drawn in that page from the confined media
   * route — which takes the preload's bound, the contract, main's checks, the images' folder, the
   * route's own checks, the request policy and the page's CSP all at once, in the build under test.
   * A view past the bound is refused by the preload, a hash no store names draws nothing, and the Pet
   * may stage nothing. The image is taken out of the draft again, so a later run starts as this one did.
   */
  async function checkAttachments(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const project = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    const sessionId = sessions.snapshot().sessions.find((entry) => entry.record.projectId === project?.id && isActive(entry.record))?.record.id;
    if (sessionId === undefined) { problems.push('attachments: no smoke session to stage into'); return; }
    const bytes = [...pngBytes(12, 8, [0, 160, 0], [255, 220, 0])];
    const staged = (await main.webContents.executeJavaScript(`window.fatg.invoke('attachments:stage', { sessionId: ${JSON.stringify(sessionId)}, bytes: new Uint8Array(${JSON.stringify(bytes)}), name: 'smoke.png' })
      .then((r) => (r.ok ? r.value : { status: r.error }), () => ({ status: 'failed' }))`)) as { status?: string; attachment?: { id?: string; hash?: string; width?: number; height?: number } };
    const hash = staged.attachment?.hash;
    if (staged.status !== 'staged' || typeof hash !== 'string' || staged.attachment?.width !== 12) { problems.push(`attachments: staging answered ${JSON.stringify(staged)}`); return; }
    // Drawn in the page from the route, as a thumbnail is: decoded at its size.
    const drawn = (await main.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'app://media/attachments/${hash}';
      try { await image.decode(); return [image.naturalWidth, image.naturalHeight]; } catch { return 'not drawn'; }
    })()`)) as unknown;
    if (JSON.stringify(drawn) !== '[12,8]') problems.push(`attachments: the staged image drew as ${JSON.stringify(drawn)} from the media route`);
    // Copy's private read crosses the real preload and IPC, then Chromium converts it at natural size.
    // Do not overwrite the maintainer's clipboard during an automated run.
    const copySource = await main.webContents.executeJavaScript(`(async () => {
      const answer = await window.fatg.invoke('attachments:readForCopy', { hash: '${hash}' });
      if (!answer.ok || answer.value === null) return 'unavailable';
      const bitmap = await createImageBitmap(new Blob([answer.value.bytes], { type: answer.value.mediaType }));
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        const item = new ClipboardItem({ 'image/png': Promise.resolve(png) });
        return [bitmap.width, bitmap.height, (await item.getType('image/png')).type];
      } finally { bitmap.close(); }
    })()`) as unknown;
    if (JSON.stringify(copySource) !== '[12,8,"image/png"]') problems.push('attachments: Copy could not prepare a PNG at natural size');
    if (await invokeStatus(main, 'attachments:showInFolder', { hash }) !== 'ok') problems.push('attachments: Show in folder did not reach its stand-in');
    for (const channel of ['attachments:readForCopy', 'attachments:showInFolder'] as const) {
      if (await invokeStatus(pet, channel, { hash }) !== 'forbidden') problems.push(`pet: ${channel} was not refused`);
    }
    const unknown = (await main.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'app://media/attachments/${'0'.repeat(64)}';
      try { await image.decode(); return 'drawn'; } catch { return 'refused'; }
    })()`)) as unknown;
    if (unknown !== 'refused') problems.push(`attachments: a hash no store names ${String(unknown)}`);
    const csp = (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null`)) as unknown;
    if (csp !== '0') problems.push(`main: CSP violations after an image was drawn: ${String(csp)}`);
    // A view past the bound goes no further than the preload (C79).
    const outsized = (await main.webContents.executeJavaScript(`window.fatg.invoke('attachments:stage', { sessionId: ${JSON.stringify(sessionId)}, bytes: new Uint8Array(${MAX_STAGE_BYTES + 1}) }).then(() => 'forwarded', () => 'refused')`)) as unknown;
    if (outsized !== 'refused') problems.push(`attachments: an outsized view was ${String(outsized)}`);
    const petStaged = await invokeStatus(pet, 'attachments:stage', { sessionId, bytes: [] });
    if (petStaged !== 'forbidden' && petStaged !== 'failed') problems.push(`pet: attachments:stage answered ${String(petStaged)}, expected forbidden`);
    const removed = await invokeStatus(main, 'chat:draft', { sessionId, op: 'remove', attachmentId: staged.attachment?.id ?? '' });
    if (removed !== 'saved') problems.push(`attachments: removing the staged image answered ${String(removed)}`);
    report['attachments'] = { staged: 'png 12 × 8', drawnFromRoute: JSON.stringify(drawn) === '[12,8]', unknownRefused: unknown === 'refused', outsizedRefused: outsized === 'refused' };
  }

  /**
   * Avatars (M102, V24, V25; C29, C33, C35, C59–C62): the built-in art scanned at start — in a package
   * from `resources/avatars/` beside the archive — each provider's default face resolved into its
   * sessions' entries, and the page drawing a portrait from the media route at its natural size, in
   * the build under test. An id no scan minted draws nothing, and the Pet may not list the avatars nor
   * holds any in its state.
   */
  async function checkAvatars(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    await avatars.idle();
    const families = avatars.listing().roots[0]?.families.map((family) => `${family.folder}:${family.avatars.length}`) ?? [];
    if (families.join(',') !== 'Claude Anime:5,Claude Gradient:5,Claude Lightning:5,Claude MTX:5,Codex Anime:5,Codex Gradient:5,Codex Lightning:5,Codex MTX:5') problems.push(`avatars: the built-in families read ${families.join(', ') || 'nothing'}`);
    const entry = sessions.snapshot().sessions.find((candidate) => candidate.avatar !== null);
    const portrait = entry?.avatar?.portrait;
    if (portrait === undefined) { problems.push('avatars: no session entry resolved to its provider’s default face'); return; }
    const file = avatars.file(portrait);
    const relative = file === undefined ? '..' : path.relative(avatarRoot, file.path);
    const fromArt = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!fromArt) problems.push('avatars: the default face is not read from the built-in art’s folder');
    // Drawn in the page, as the avatar is: an element of the page holds it, and it decodes at its natural size.
    const inPage = await waitFor('the page to draw a default face', async () => (await main.webContents.executeJavaScript(`document.querySelector('[data-avatar] img[src="app://media/avatars/${portrait}"]') !== null`)) === true);
    const drawn = (await main.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'app://media/avatars/${portrait}';
      try { await image.decode(); return [image.naturalWidth, image.naturalHeight]; } catch { return 'not drawn'; }
    })()`)) as unknown;
    if (JSON.stringify(drawn) !== '[512,512]') problems.push(`avatars: the default face drew as ${JSON.stringify(drawn)} from the media route`);
    const unknown = (await main.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = 'app://media/avatars/${'0'.repeat(32)}';
      try { await image.decode(); return 'drawn'; } catch { return 'refused'; }
    })()`)) as unknown;
    if (unknown !== 'refused') problems.push(`avatars: an id no scan minted ${String(unknown)}`);
    const petList = await invokeStatus(pet, 'avatars:list', null);
    if (petList !== 'forbidden') problems.push(`pet: avatars:list answered ${String(petList)}, expected forbidden`);
    // The family editor's two channels are the Main window's alone too (decision 0031).
    const family = { origin: 'built-in', family: 'Codex Gradient' };
    const petFamily = await invokeStatus(pet, 'avatars:family', family);
    if (petFamily !== 'forbidden') problems.push(`pet: avatars:family answered ${String(petFamily)}, expected forbidden`);
    const petSave = await invokeStatus(pet, 'avatars:saveFamily', { ref: family, revision: null, draft: { provider: 'any', overlay: {}, avatars: [] } });
    if (petSave !== 'forbidden') problems.push(`pet: avatars:saveFamily answered ${String(petSave)}, expected forbidden`);
    const petCopy = await invokeStatus(pet, 'avatars:copyFamily', family);
    if (petCopy !== 'forbidden') problems.push(`pet: avatars:copyFamily answered ${String(petCopy)}, expected forbidden`);
    const copied = (await main.webContents.executeJavaScript(`window.fatg.invoke('avatars:copyFamily', ${JSON.stringify(family)}).then(async (r) => {
      if (!r.ok || r.value.kind !== 'copied') return false;
      const copy = r.value;
      const opened = await window.fatg.invoke('avatars:family', copy.ref);
      const listed = copy.listing.roots.find((root) => root.origin === 'user')?.families.find((entry) => entry.folder === copy.ref.family);
      return copy.ref.family.startsWith('Copy of Codex Gradient') && opened.ok && opened.value?.lock === null && listed?.provider === 'codex' && listed.avatars.length === 5 ? copy.ref.family : false;
    })`)) as unknown;
    if (typeof copied !== 'string') problems.push('avatars: Make a copy did not produce an editable user family');
    else {
      // Add avatar (decision 0036): two PNGs the page encodes, through the preload's byte bound, written
      // into the copy at once from its revision, and listed by the scan after it; an outsized image is
      // refused before it leaves the page, and the mini window may not add one.
      const ref = { origin: 'user', family: copied };
      const petAdd = await invokeStatus(pet, 'avatars:addAvatar', { ref, revision: null, name: 'Smoke', matches: [] });
      if (petAdd !== 'failed' && petAdd !== 'forbidden') problems.push(`pet: avatars:addAvatar answered ${String(petAdd)}, expected a refusal`);
      const added = (await main.webContents.executeJavaScript(`(async () => {
        const png = async (side) => {
          const canvas = new OffscreenCanvas(side, side);
          const context = canvas.getContext('2d');
          context.fillStyle = '#c04020';
          context.fillRect(0, 0, side, side);
          return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        };
        const ref = ${JSON.stringify(ref)};
        const opened = await window.fatg.invoke('avatars:family', ref);
        if (!opened.ok || opened.value === null) return 'not opened';
        const request = { ref, revision: opened.value.revision, name: 'Smoke Sun', matches: ['smoke-*'], portrait: await png(512), small: await png(64) };
        const outsized = await window.fatg.invoke('avatars:addAvatar', { ...request, portrait: new Uint8Array(${MAX_STAGE_BYTES + 1}) }).then(() => 'forwarded', () => 'refused');
        if (outsized !== 'refused') return 'outsized ' + outsized;
        const r = await window.fatg.invoke('avatars:addAvatar', request);
        if (!r.ok || r.value.kind !== 'added') return JSON.stringify(r.ok ? r.value.kind : r.error);
        const listed = r.value.listing.roots.find((root) => root.origin === 'user')?.families.find((entry) => entry.folder === ref.family)?.avatars.find((avatar) => avatar.folder === 'Smoke Sun');
        const sides = listed?.files.map((file) => file.role + ' ' + file.width).join(', ');
        const entry = r.value.source.draft.avatars.find((avatar) => avatar.folder === 'Smoke Sun');
        if (sides !== 'portrait 512, small 64' || JSON.stringify(entry?.matches) !== '["smoke-*"]' || r.value.source.revision === opened.value.revision) return 'listed as ' + String(sides);
        // Its main image replaced by a smaller one, with its small: the old files go (to the trash, out of a smoke run).
        const replaced = await window.fatg.invoke('avatars:replaceImage', { ref, avatar: 'Smoke Sun', portrait: await png(256), small: await png(64) });
        if (!replaced.ok || replaced.value.kind !== 'replaced') return 'replace ' + JSON.stringify(replaced.ok ? replaced.value.kind : replaced.error);
        const after = replaced.value.listing.roots.find((root) => root.origin === 'user')?.families.find((entry) => entry.folder === ref.family)?.avatars.find((avatar) => avatar.folder === 'Smoke Sun');
        const sidesAfter = after?.files.map((file) => file.role + ' ' + file.width).join(', ');
        if (sidesAfter !== 'portrait 256, small 64') return 'replaced as ' + String(sidesAfter);
        // Browse answers from the smoke's stand-in, which cancels; a page may not name a dropped file's path.
        const chosen = await window.fatg.invoke('avatars:chooseImage', null);
        if (!chosen.ok || chosen.value.kind !== 'cancelled') return 'browse ' + JSON.stringify(chosen);
        const named = await window.fatg.invoke('avatars:noteDropped', { path: 'C:/elsewhere/sun.png' }).then(() => 'forwarded', () => 'refused');
        return named === 'refused' ? true : 'a dropped path from the page ' + named;
      })()`)) as unknown;
      if (added !== true) problems.push(`avatars: Add avatar did not add a listed avatar, or its image was not replaced (${String(added)})`);
    }
    // The Pet draws the avatars of the sessions it lists, by their files' ids alone: never the
    // folders' names they were found by, the listing or the catalog (decisions 0010, 0031).
    const petHolds = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => {
      if (!r.ok) return 'failed';
      // Installation.source is public CLI detection metadata; bundled provider logos are also
      // allowed for placeholders (decision 0010). Avatar folder names and the catalog stay out.
      const drawing = { avatars: r.value.pet.projects.flatMap((project) => project.sessions.map((session) => session.avatar)), presentation: r.value.pet.presentation };
      return 'catalog' in r.value || 'avatars' in r.value || /"ref"|"source"|famil|listing|Gradient|Lightning|"catalog"/i.test(JSON.stringify(drawing));
    })`)) as unknown;
    if (petHolds !== false) problems.push(`pet: its snapshot holds an avatar's names or the listing (${String(petHolds)})`);
    report['avatars'] = { families, fromBuiltInArt: fromArt, inPage, drawn, unknownRefused: unknown === 'refused' };
  }

  /**
   * A second account (M14b, V16; C19, C39, C40, C50, C54). scripts/smoke.mjs names a folder for the
   * account picker's stand-in and a label, and its Codex fixture answers for that folder with an
   * account of its own: another plan, other readings, fewer models and fewer levels.
   *
   *   1. First run: the folder is picked and the account added from the Main page. Picking stores and
   *      starts nothing; adding starts it at once.
   *   2. A second Codex block shows; both blocks carry their labels, and the two accounts their own
   *      readings and their own models.
   *   3. A session is created and named on the second account from the Main page.
   *   4. Later runs: the account and its session are back as they were left.
   *   5. The Pet's snapshot holds two Codex entries and no label, and it may not add an account.
   *
   * Neither the label nor the folder is put in the report: scripts/smoke.mjs scans the output for both.
   */
  async function checkInstances(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const folder = process.env['FATG_SMOKE_PICK_ACCOUNT_FOLDER'];
    const label = process.env['FATG_SMOKE_ACCOUNT_LABEL'];
    const stored = folder === undefined ? null : normalizeRoot(folder, process.platform);
    if (stored === null || label === undefined || label === '') {
      problems.push('instances: the smoke account’s folder or label is missing');
      return;
    }
    const project = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    if (project === undefined) {
      problems.push('instances: the smoke project is missing');
      return;
    }
    const ask = async (channel: string, request: unknown): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: string }> =>
      (await main.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).catch(() => ({ ok: false, error: 'failed' }))`)) as never;
    /** An answer's status and reason, in words only: never a value a request carried. */
    const word = (value: unknown): string => (typeof value === 'string' ? value : '');
    const answeredAs = (result: { value?: Record<string, unknown>; error?: string }): string =>
      [word(result.value?.['status']) || (result.error ?? 'nothing'), word(result.value?.['reason'])].filter((part) => part !== '').join(' ');
    const added = () => prefs.getSnapshot().instances['codex']?.added ?? [];
    const codexSnapshots = () => store.getSnapshot().providers.filter((provider) => provider.id === 'codex');
    const codexEntries = () => store.getSnapshot().catalog?.providers.filter((provider) => provider.id === 'codex') ?? [];
    const primary = (instanceId: string): number | null =>
      codexSnapshots().find((provider) => provider.instanceId === instanceId)?.usage?.windows.find((window) => window.id === 'codex:primary')?.usedPercent ?? null;

    // Usage is held still for the checks around this one; a new account's first read needs it running.
    usage.resume();
    try {
      const previous = added().find((entry) => entry.folder === stored);
      let id = previous?.id ?? null;
      if (previous === undefined) {
        const pick = await ask('instances:pickFolder', { providerId: 'codex' });
        if (pick.value?.['status'] !== 'picked' || pick.value['path'] !== stored || pick.value['refusal'] !== null) {
          problems.push(`instances: the stand-in picker answered ${answeredAs(pick)}${pick.value?.['refusal'] == null ? '' : ' with a refusal'}`);
          return;
        }
        // Picking stores nothing and starts nothing (C21, C33).
        if (added().length !== 0 || codexSnapshots().length !== 1) problems.push('instances: picking a folder stored or started something');
        const saved = await ask('instances:add', { providerId: 'codex', label, folder: stored });
        id = typeof saved.value?.['id'] === 'string' ? saved.value['id'] : null;
        if (saved.value?.['status'] !== 'saved' || id === null) {
          problems.push(`instances: adding the account answered ${answeredAs(saved)}`);
          return;
        }
      } else if (previous.label !== label || !previous.enabled || previous.issue !== null || id === null) {
        problems.push('instances: the previous run’s account is not back as it was left');
        return;
      }
      const accountId = id ?? '';

      // Its label and its folder reach preferences.json, which is written a moment after a change.
      await waitFor('the account to reach preferences.json', () => {
        const onDisk = ((readJson(path.join(app.getPath('userData'), PREFERENCES_FILE)) as { providers?: Record<string, { instances?: Record<string, unknown>[] }> } | null)?.providers?.['codex']?.instances ?? [])
          .find((entry) => entry['id'] === accountId);
        return onDisk?.['label'] === label && onDisk['folder'] === stored;
      });

      // Both accounts read, each for itself: the fixture gives the second another plan and other readings.
      const second = () => codexSnapshots().find((provider) => provider.instanceId === accountId);
      const read = await waitFor('the second Codex account’s own account and usage', () => {
        const mine = primary(accountId);
        return second()?.status.kind === 'ok' && second()?.account?.plan === 'team' && mine !== null && mine >= 63 && mine <= 64;
      });
      if (!read) return;
      const firstReading = primary(FIRST_INSTANCE_ID);
      if (codexSnapshots().length !== 2 || codexSnapshots()[0]?.instanceId !== FIRST_INSTANCE_ID) problems.push('instances: the app state does not hold the first Codex account, then the second');
      if (firstReading === null || firstReading === primary(accountId)) problems.push('instances: the two accounts show one reading');
      if (second()?.label !== label || second()?.instanceVariable === null) problems.push('instances: the second account’s snapshot lacks its label or its variable');

      // Each lists its own models: the fixture's second account has three of the nine, one with two levels.
      await waitFor('the second Codex account’s own models', () => codexEntries().find((entry) => entry.instanceId === accountId)?.source.kind === 'report');
      const [firstModels, secondModels] = [FIRST_INSTANCE_ID, accountId].map((instanceId) => codexEntries().find((entry) => entry.instanceId === instanceId)?.models ?? []);
      const levels = (models: typeof firstModels) => models?.find((model) => model.key === 'gpt-6-sol')?.efforts.length ?? 0;
      if (firstModels?.length !== 9 || secondModels?.length !== 3) problems.push(`instances: the accounts list ${firstModels?.length ?? 0} and ${secondModels?.length ?? 0} models, expected 9 and 3`);
      if (levels(secondModels) !== 2 || levels(firstModels) <= 2) problems.push('instances: the two accounts list one model with the same levels');

      // The Main page: two Codex blocks in the usage box, each with its label; the box keeps its height (M100, C54).
      const shown = await waitFor('two labelled Codex blocks in the usage box', async () => (await main.webContents.executeJavaScript(`(() => {
        const blocks = [...document.querySelectorAll('[data-usage-block="codex"]')];
        const labels = blocks.map((block) => block.querySelector('[data-account-label]')?.textContent ?? null);
        return blocks.length === 2 && labels[0] === 'Default' && labels[1] === ${JSON.stringify(label)};
      })()`)) === true);
      if (!shown) return;

      // A session on the second account, created from the Main page as Start session creates it.
      const selectedBefore = sessions.snapshot().selectedId;
      const onIt = () => sessions.snapshot().sessions.filter((entry) => entry.record.projectId === project.id && entry.record.providerId === 'codex' && entry.record.instanceId === accountId);
      let session: 'created' | 'back' = 'back';
      if (onIt().length === 0) {
        if (previous !== undefined) problems.push('instances: the session the previous run started on the second account is not back');
        const preset = defaultPreset(presetTiles(store.getSnapshot().catalog, [{ providerId: 'codex', instanceId: accountId }]));
        const created = await ask('sessions:create', { projectId: project.id, preset });
        const created_id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
        const disk = (readJson(path.join(app.getPath('userData'), RECORDS_FILE)) as { sessions?: Record<string, unknown>[] } | null)?.sessions?.find((entry) => entry['id'] === created_id);
        if (created.value?.['status'] !== 'saved' || disk?.['instanceId'] !== accountId || disk['configFolder'] !== null || disk['reference'] !== null) {
          problems.push(`instances: creating a session on the second account answered ${answeredAs(created)}`);
          return;
        }
        // An empty unnamed session is provisional and removed on leaving (M26, round 2).
        // Give the fixture a user's name so it has something to restore on the next run.
        const named = await ask('sessions:rename', { id: created_id, name: 'Second account session' });
        if (named.value?.['status'] !== 'saved' || sessions.record(created_id)?.nameSource !== 'user') {
          problems.push(`instances: naming the second account's session answered ${answeredAs(named)}`);
          return;
        }
        session = 'created';
        // The selection goes back where the session check left it.
        if (selectedBefore !== null) await ask('sessions:select', { id: selectedBefore });
      }
      if (onIt().length !== 1) problems.push(`instances: the second account has ${onIt().length} sessions under the smoke project, expected 1`);
      if (onIt().some((entry) => entry.hold !== null)) problems.push('instances: the second account’s session is held');

      // The Pet: two Codex entries, with no label, variable or withheld name, and no account channel (C24, C50).
      const petCodex = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => r.ok
        ? { entries: r.value.providers.filter((p) => p.id === 'codex').map((p) => [p.label, p.instanceVariable, p.startedWithout.length]), hasLabel: JSON.stringify(r.value).includes(${JSON.stringify(label)}) }
        : 'failed')`)) as { entries: [string, string | null, number][]; hasLabel: boolean } | 'failed';
      if (petCodex === 'failed' || petCodex.entries.length !== 2 || petCodex.hasLabel || petCodex.entries.some(([shownLabel, variable, without]) => shownLabel !== '' || variable !== null || without !== 0)) {
        problems.push('pet: its snapshot does not hold two Codex entries with no label, variable or withheld name');
      }
      for (const [channel, request] of [
        ['instances:pickFolder', { providerId: 'codex' }],
        ['instances:add', { providerId: 'codex', label: 'x', folder: stored }],
        ['instances:remove', { providerId: 'codex', key: accountId }],
        ['instances:openLoginTerminal', { providerId: 'codex', instanceId: accountId }],
        // M22 (C28, C60): nor Codex's own sandbox setup for an account, which is asked for at the Main window's press alone.
        ['instances:setupSandbox', { providerId: 'codex', instanceId: accountId, action: 'start' }],
      ] as const) {
        const answer = await invokeStatus(pet, channel, request);
        if (answer !== 'forbidden') problems.push(`pet: ${channel} answered ${String(answer)}, expected forbidden`);
      }
      // The login terminal (C80): the Main page's request reaches the stand-in once, and nothing opens.
      const terminalsBefore = terminalRequests.count;
      const terminal = await ask('instances:openLoginTerminal', { providerId: 'codex', instanceId: accountId });
      if (terminal.value?.['status'] !== 'opened' || terminalRequests.count !== terminalsBefore + 1) problems.push(`instances: the login terminal request answered ${answeredAs(terminal)}`);

      const csp = (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null`)) as unknown;
      if (csp !== '0') problems.push(`main: CSP violations after the account changes: ${String(csp)}`);

      report['instances'] = {
        from: previous === undefined ? 'added in this run (run again to check a restore)' : 'the previous run',
        codexBlocks: 2, labelsShown: true, models: [firstModels?.length ?? 0, secondModels?.length ?? 0], readingsDiffer: firstReading !== primary(accountId), session, petLabels: 0,
      };
    } finally {
      usage.suspend();
    }
  }

  /**
   * The captures of the session list and the session area for the maintainer's visual review (M14,
   * V18); only with FATG_SMOKE_VISUAL_DIR. The list at each frame of the demo's script, the session
   * area with a selected session, and the New session popup, in both themes.
   */
  async function captureSessionVisuals(main: BrowserWindow): Promise<void> {
    const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
    const source = demo();
    if (directory === undefined || !path.isAbsolute(directory) || source === undefined) return;
    const before = prefs.getSnapshot().values.appearance.theme;
    const page = (script: string): Promise<unknown> => main.webContents.executeJavaScript(script);
    const saved: string[] = [];
    const shoot = async (name: string): Promise<void> => {
      // A resize forces a fresh frame, as in the other captures.
      const bounds = main.getBounds();
      main.setBounds({ ...bounds, width: bounds.width + 1 });
      await delay(50);
      main.setBounds(bounds);
      await delay(200);
      writeFileSync(path.join(directory, `${name}.png`), (await main.webContents.capturePage()).toPNG());
      saved.push(name);
    };
    source.pause();
    // A hidden project's sessions show in the hidden list.
    await page(`(() => { const row = document.querySelector('[data-hidden-row][aria-expanded="false"]'); row?.click(); })()`);
    for (const theme of ['light', 'dark'] as const) {
      await page(invokeFrom('prefs:patch', JSON.stringify({ appearance: { theme } })));
      await delay(300);
      for (let frame = 0; frame < 14; frame += 1) {
        source.tick();
        await delay(120);
        await shoot(`${theme}-sessions-frame-${String(frame + 1).padStart(2, '0')}`);
      }
      // A real keyboard activation folds the whole session list; the name opens it again.
      const project = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project');
      if (project !== undefined) {
        await records.setCollapsed(project.id, false);
        const selector = JSON.stringify(`[data-entry-key="${project.id}"] [data-project-disclosure]`);
        await waitFor('the project disclosure to be expanded', async () => await page(`document.querySelector(${selector})?.getAttribute('aria-expanded') === 'true'`) === true);
        await page(`document.querySelector(${selector})?.focus()`);
        main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
        main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        await waitFor('Space to fold the project', () => records.getProject(project.id)?.collapsed === true);
        await shoot(`${theme}-project-folded`);
        await page(`document.querySelector(${selector})?.querySelector('span')?.click()`);
        await waitFor('the project name to unfold its sessions', () => records.getProject(project.id)?.collapsed === false);
        await shoot(`${theme}-project-expanded`);
        await page(`document.querySelector(${selector})?.focus()`);
        main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        main.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await waitFor('Enter to fold the project', () => records.getProject(project.id)?.collapsed === true);
        await records.setCollapsed(project.id, false);
      }
      await page(`document.querySelector('aside[aria-label="Projects"] [aria-label^="New session in"]:not([aria-disabled])')?.click()`);
      await delay(250);
      await shoot(`${theme}-new-session`);
      await page(`document.querySelector('[data-new-session]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }
    await page(invokeFrom('prefs:patch', JSON.stringify({ appearance: { theme: before } })));
    await page(`document.querySelector('[data-hidden-row][aria-expanded="true"]')?.click()`);
    source.resume();
    report['sessionCapture'] = saved;
  }

  /**
   * The quit question (M14, C76, C99–C101, V17). With a session in a turn, Exit from the Main page
   * must be questioned in that page, before anything closes and before anything of the shutdown
   * starts; Cancel must leave everything as it was; and the question asked again is left open, for
   * `finish` to confirm. The native box's stand-in must never be asked.
   */
  async function beginQuitThroughThePage(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const source = demo();
    if (source === undefined) return;
    source.resume();
    if (!(await waitFor('a session to be in a turn at quit', () => sessions.runningCount() > 0, 30_000))) return;
    // Held still from here: the count the question names must be the count the records end with.
    source.pause();
    await sessions.settled();
    const running = sessions.snapshot().sessions.filter((entry) => entry.summary.status === 'running').map((entry) => entry.record.id);
    const marker = path.join(app.getPath('userData'), SMOKE_RECORDS_MARKER);
    const previous = readJson(marker) as { sessions?: Record<string, unknown> } | null;
    // The next run checks its own project's: the live launches' session (M15), which the demo drives
    // once a live run has resumed it, is removed by the next live run before this check could read it.
    const own = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    const noted = running.filter((id) => sessions.record(id)?.projectId === own?.id);
    writeFileSync(marker, JSON.stringify({ ...previous, sessions: { ...previous?.sessions, running: noted } }));

    const question = `(() => {
      const dialog = [...document.querySelectorAll('dialog[open]')].find((element) => element.querySelector('h2')?.textContent === 'Quit fat-g?');
      return dialog ? dialog.textContent : null;
    })()`;
    const press = (label: string): string => `(() => {
      const dialog = [...document.querySelectorAll('dialog[open]')].find((element) => element.querySelector('h2')?.textContent === 'Quit fat-g?');
      const button = [...(dialog?.querySelectorAll('button') ?? [])].find((element) => element.textContent === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`;
    const asked = async (): Promise<boolean> => {
      const answer = (await main.webContents.executeJavaScript(invokeFrom('app:quit', 'null'))) as unknown;
      if (answer !== 'ok') problems.push(`quit: app:quit from the Main page answered ${String(answer)}`);
      return waitFor('the quit question to show in the Main page', async () => store.getSnapshot().quitQuestion === true && typeof (await main.webContents.executeJavaScript(question)) === 'string');
    };

    if (!(await asked())) return;
    const text = (await main.webContents.executeJavaScript(question)) as string;
    const expected = quitWords(quitActivity(sessions.snapshot().sessions));
    if (!expected.body.split('\n\n').every((paragraph) => text.includes(paragraph))) problems.push('quit: the question does not describe its active replies and ready plans');
    if (shutdown.quitting || main.isDestroyed() || pet.isDestroyed()) problems.push('quit: something closed, or the shutdown started, before the question was answered');
    const petQuestion = (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => r.ok ? 'quitQuestion' in r.value : 'failed')`)) as unknown;
    if (petQuestion !== false) problems.push('pet: its snapshot holds the quit question');

    // A no: every window, source and record as it was, and the next attempt asks again (C102).
    if ((await main.webContents.executeJavaScript(press('Cancel'))) !== true) problems.push('quit: the question has no Cancel button');
    await waitFor('the quit question to close after Cancel', () => store.getSnapshot().quitQuestion !== true);
    if (shutdown.quitting || main.isDestroyed() || pet.isDestroyed() || sessions.runningCount() !== running.length) problems.push('quit: Cancel did not leave everything as it was');
    if (!(await asked())) return;
    if (quitBoxRequests.count !== 0) problems.push(`quit: the native message box was asked ${quitBoxRequests.count} time(s)`);

    confirmQuit = async () => {
      if ((await main.webContents.executeJavaScript(press('Quit'))) !== true) throw new Error('no Quit button');
    };
    report['quit'] = { askedInThePage: true, running: running.length, cancelKeptEverything: true, nativeBox: quitBoxRequests.count };
  }

  /** Moves both windows somewhere new for this run; the file must end up saying exactly where. */
  async function checkPlacementRoundTrip(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const area = currentDisplayLayout().primary;
    const seed = Date.now();
    const target: Rect = {
      x: area.x + 40 + (seed % 120),
      y: area.y + 40 + (Math.floor(seed / 1000) % 60),
      width: Math.min(area.width - 200, MAIN_PLACEMENT.minSize.width + 100 + (seed % 97)),
      height: Math.min(area.height - 120, MAIN_PLACEMENT.minSize.height + 40 + (seed % 53)),
    };
    main.setBounds(target);
    pet.setPosition(area.x + area.width - pet.getBounds().width - 60 - (seed % 90), area.y + 60 + (seed % 70));

    // What Electron reports back is what must be saved: fractional scaling can move a value a DIP.
    const settled = () => ({ main: roundRect(main.getNormalBounds()), pet: roundRect(pet.getNormalBounds()) });
    await waitFor('the new window positions to reach preferences.json', () => {
      const onDisk = readPreferencesFile().windows;
      const now = settled();
      return sameRect(onDisk?.main?.bounds, now.main) && sameRect(onDisk?.pet?.bounds, now.pet);
    });
    const onDisk = readPreferencesFile().windows;
    report['placement'] = { target, settled: settled(), onDisk: { main: onDisk?.main?.bounds, pet: onDisk?.pet?.bounds } };
  }

  /** Focus hides the enabled Pet temporarily; preference changes apply through the real bridge. */
  async function checkPetAutoHide(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    // Give Windows a real destination for focus: blur() alone can activate the always-on-top Pet.
    const focusTarget = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await checkPetAutoHideWithTarget(main, pet, focusTarget);
    } finally {
      focusTarget.destroy();
    }
  }

  async function checkPetAutoHideWithTarget(main: BrowserWindow, pet: BrowserWindow, focusTarget: BrowserWindow): Promise<void> {
    const patch = async (change: { visible?: boolean; autoHideOnMainFocus?: boolean }): Promise<void> => {
      const status = await main.webContents.executeJavaScript(invokeFrom('prefs:patch', JSON.stringify({ windows: { pet: change } }))) as unknown;
      if (status !== 'ok') problems.push('pet auto-hide: preference patch failed');
    };
    main.show();
    focusTarget.show();
    focusTarget.focus();
    await waitFor('Main to lose focus before checking auto-hide', () => !main.isFocused());
    await patch({ visible: true, autoHideOnMainFocus: true });
    main.focus();
    await waitFor('Main focus to hide the Pet', () => main.isFocused() && !pet.isVisible());
    if (!prefs.getSnapshot().values.windows.pet.visible) problems.push('pet auto-hide: Main focus disabled the Pet');
    await waitFor('auto-hide to reach preferences.json without disabling the Pet', () => {
      const saved = readPreferencesFile().windows?.pet;
      return saved?.autoHideOnMainFocus === true && saved.visible === true;
    });

    // Model the native topmost state being lost while hidden. Returning must repair it, not
    // merely report a visible window that can remain behind Main or another application.
    pet.setAlwaysOnTop(false);
    focusTarget.focus();
    await waitFor('leaving Main to show the Pet without taking focus', () => !main.isFocused() && pet.isVisible() && !pet.isFocused());
    checkPetWindow(pet, 'after Main loses focus');
    main.focus();
    await waitFor('returning to Main to hide the same Pet', () => main.isFocused() && !pet.isVisible());
    if (windows.get('pet') !== pet) problems.push('pet auto-hide: recreated the Pet');
    main.minimize();
    await waitFor('minimizing Main to show the Pet', () => main.isMinimized() && pet.isVisible());
    checkPetWindow(pet, 'after Main minimizes');
    main.restore();
    main.focus();
    await waitFor('restoring Main focus to hide the Pet', () => main.isFocused() && !pet.isVisible());

    await patch({ autoHideOnMainFocus: false });
    await waitFor('disabling auto-hide to show the Pet while Main keeps focus', () => main.isFocused() && pet.isVisible() && !pet.isFocused());
    checkPetWindow(pet, 'after disabling auto-hide');
    await patch({ autoHideOnMainFocus: true });
    await waitFor('enabling auto-hide while Main has focus', () => !pet.isVisible());
    await patch({ visible: false });
    focusTarget.focus();
    await delay(100);
    if (pet.isVisible()) problems.push('pet auto-hide: leaving Main showed a disabled Pet');

    main.focus();
    await waitFor('Main focus before enabling the Pet', () => main.isFocused());
    const enabled = await main.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-pet-button]');
      if (button?.getAttribute('aria-pressed') !== 'false') return false;
      button.click();
      return true;
    })()`) as unknown;
    if (enabled !== true) problems.push('pet auto-hide: the title toggle was not off before enabling');
    await waitFor('enabling the Pet to show it while Main keeps focus', () => main.isFocused() && pet.isVisible() && !pet.isFocused());
    checkPetWindow(pet, 'after enabling from the title toggle');
    // An unchanged option must not consume the one-time show, nor should a placement write.
    await patch({ autoHideOnMainFocus: true });
    prefs.patch({ windows: { pet: { bounds: pet.getBounds() } } });
    if (!pet.isVisible()) problems.push('pet auto-hide: an unrelated preference write hid the newly enabled Pet');
    main.minimize();
    await waitFor('Main to minimize after enabling the Pet', () => main.isMinimized());
    main.restore();
    main.focus();
    await waitFor('the next Main focus to resume automatic hiding', () => main.isFocused() && !pet.isVisible());
    // The remaining checks exercise the always-visible choice. finish restores the default.
    await patch({ visible: true, autoHideOnMainFocus: false });
    main.focus();
    await waitFor('the Pet with auto-hide off', () => pet.isVisible() && main.isFocused());
    const selected = store.getSnapshot().sessions?.selectedId;
    main.minimize();
    await waitFor('Main to minimize before opening it without a session', () => main.isMinimized());
    const shown = await invokeStatus(pet, 'pet:showMain', null);
    if (shown !== 'ok') problems.push(`pet: pet:showMain answered ${String(shown)}`);
    await waitFor('the Pet to restore and focus Main without selecting a session', () => main.isVisible() && !main.isMinimized() && main.isFocused());
    if (store.getSnapshot().sessions?.selectedId !== selected) problems.push('pet: opening Main without a session changed its selection');
    report['petAutoHide'] = { focused: 'hidden', away: 'shown without focus', minimized: 'shown', disabled: 'stays hidden', enabled: 'shown until next Main focus', openedMain: 'selection preserved', sameWindow: windows.get('pet') === pet };
  }

  /** The Pet's ×, then the Settings checkbox bringing it back — both through the real bridge. */
  async function checkPetToggle(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const fromMain = (await main.webContents.executeJavaScript(invokeFrom('pet:hide', 'null'))) as unknown;
    if (fromMain !== 'forbidden') problems.push(`main: pet:hide answered ${String(fromMain)}, expected forbidden`);

    const hidden = (await pet.webContents.executeJavaScript(invokeFrom('pet:hide', 'null'))) as unknown;
    if (hidden !== 'ok') problems.push(`pet: pet:hide answered ${String(hidden)}`);
    await waitFor('the Pet to hide', () => !pet.isVisible());
    await waitFor('visible: false to reach preferences.json', () => readPreferencesFile().windows?.pet?.visible === false);

    const shown = (await main.webContents.executeJavaScript(invokeFrom('prefs:patch', '{ windows: { pet: { visible: true } } }'))) as unknown;
    if (shown !== 'ok') problems.push(`main: showing the Pet from Settings answered ${String(shown)}`);
    const back = await waitFor('the Pet to come back', () => windows.get('pet')?.isVisible() === true);
    const again = windows.get('pet');
    if (back && again) checkPetWindow(again, 'shown again');
    report['petToggle'] = { fromMain, hidden, shown, sameWindow: again === pet };
  }

  /**
   * The Pet's list (decision 0010): the sessions running or waiting on the user, drawn by its page and
   * held by its window; its size toggle reaching the preferences; a press opening its session in the
   * Main window. Neither ask is the Main window's.
   */
  async function checkPetSessions(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    for (const [channel, request] of [['pet:setSize', { size: 'compact' }], ['pet:open', { id: 'none' }], ['pet:showMain', null]] as const) {
      const answer = await invokeStatus(main, channel, request);
      if (answer !== 'forbidden') problems.push(`main: ${channel} answered ${String(answer)}, expected forbidden`);
    }
    const listed = (): number => petView(store.getSnapshot()).projects.reduce((sum, project) => sum + project.sessions.length, 0);
    const drawn = async (): Promise<number> => (await pet.webContents.executeJavaScript(`document.querySelectorAll('[data-pet-session]').length`)) as number;
    if (!(await waitFor('the Pet to draw the sessions its view lists', async () => (await drawn()) === listed()))) problems.push(`pet: draws ${await drawn()} sessions, its view lists ${listed()}`);
    // Its window holds its list: as wide as its capsules, as tall as its rows, but no lower than the screen.
    const holds = (size: PetSize): boolean => {
      const actual = pet.getBounds();
      const wanted = fitPetBounds(actual, petContentSize({ ...petView(store.getSnapshot()), size }), currentDisplayLayout(), screen.getDisplayMatching(actual).scaleFactor);
      return Math.abs(actual.width - wanted.width) <= 1 && Math.abs(actual.height - wanted.height) <= 1;
    };
    if (!(await waitFor('the Pet to hold its list', () => holds(petView(store.getSnapshot()).size)))) problems.push(`pet: at ${JSON.stringify(pet.getBounds())}, which does not hold its list`);
    const sizes: Record<string, unknown> = {};
    for (const size of ['compact', 'capsule'] as const) {
      const answer = await invokeStatus(pet, 'pet:setSize', { size });
      if (answer !== 'ok') problems.push(`pet: pet:setSize ${size} answered ${String(answer)}`);
      if (!(await waitFor(`the Pet at its ${size} size`, () => holds(size)))) problems.push(`pet: at ${JSON.stringify(pet.getBounds())} after pet:setSize ${size}`);
      await waitFor(`size: ${size} to reach preferences.json`, () => readPreferencesFile().windows?.pet?.size === size);
      const page = (await pet.webContents.executeJavaScript(`document.querySelector('[data-pet-size]')?.getAttribute('data-pet-size') ?? null`)) as unknown;
      if (page !== size) problems.push(`pet: its page draws ${String(page)} capsules after pet:setSize ${size}`);
      sizes[size] = pet.getBounds();
    }
    const first = petView(store.getSnapshot()).projects[0]?.sessions[0]?.record.id;
    if (first !== undefined) {
      const opened = await invokeStatus(pet, 'pet:open', { id: first });
      if (opened !== 'ok') problems.push(`pet: pet:open answered ${String(opened)}`);
      if (!(await waitFor('a press on the Pet to open its session in the Main window', () => store.getSnapshot().sessions?.selectedId === first))) problems.push('pet: pet:open selected nothing in the Main window');
    }
    report['petSessions'] = { listed: listed(), sizes, opened: first === undefined ? 'no session listed' : 'selected in the Main window' };
  }

  /** A second launch must quit on its own and bring this instance's Main window back. */
  async function checkSecondLaunch(main: BrowserWindow): Promise<void> {
    main.minimize();
    if (!(await waitFor('the Main window to minimize', () => main.isMinimized()))) return;

    // Same executable, arguments, directory and environment — so the same smoke directory, whose
    // single-instance lock this process holds.
    const second = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: process.env, stdio: 'ignore', windowsHide: true });
    let exitCode: number | null | undefined;
    second.on('exit', (code) => {
      exitCode = code;
    });
    second.on('error', (error) => problems.push(`second launch: ${String(error)}`));

    if (!(await waitFor('the second launch to quit on its own', () => exitCode !== undefined, 30_000))) second.kill();
    await waitFor('the second launch to bring the Main window back', () => !main.isMinimized() && main.isVisible());
    report['secondLaunch'] = { exitCode, restored: !main.isMinimized() };
  }

  async function checkMacReopen(main: BrowserWindow): Promise<boolean> {
    main.close();
    if (!(await waitFor('both windows to close on macOS', () => windows.get('main') === undefined && windows.get('pet') === undefined))) return false;
    const windowMenu = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Window');
    const show = windowMenu?.submenu?.items.find((item) => item.label === 'Show Main Window');
    if (show?.enabled !== true || shutdown.quitting) throw new Error('macOS: Show Main Window is unavailable after closing the windows');
    (show.click as (event: object) => void)({});
    const reopened = windows.get('main');
    if (reopened === undefined || reopened === main) throw new Error('macOS: Show Main Window did not open a new window');
    if (!(await pageReady('main', reopened)) || !(await waitFor('the reopened Main window to show', () => reopened.isVisible()))) return false;
    report['macReopen'] = 'opened from the Window menu after both windows closed';
    return true;
  }

  /**
   * What only a package can get wrong (M9). Runs whenever the app is packaged; `scripts/smoke.mjs
   * packaged` fails a packaged run that did not report it, so it cannot be skipped silently.
   */
  function checkPackaged(): void {
    if (!app.isPackaged) return;
    const roles = new Set<string>();
    const visit = (menu: Menu | null | undefined): void => {
      for (const item of menu?.items ?? []) {
        if (item.role) roles.add(item.role.toLowerCase());
        visit(item.submenu);
      }
    };
    visit(Menu.getApplicationMenu());
    const devMenu = ['reload', 'forcereload', 'toggledevtools'].filter((role) => roles.has(role));
    const facts = {
      mainFromArchive: import.meta.dirname.split(/[\\/]/).includes('app.asar'),
      origin: expectedOrigin,
      devMenu,
      userData: path.basename(app.getPath('userData')),
      name: app.getName(),
    };
    report['packaged'] = facts;
    if (!facts.mainFromArchive) problems.push('packaged: the main process did not load from app.asar');
    // scripts/smoke.mjs sets a loopback ELECTRON_RENDERER_URL; a packaged app must ignore it.
    if (expectedOrigin !== APP_ORIGIN) problems.push(`packaged: pages load from ${expectedOrigin}, not ${APP_ORIGIN}`);
    if (devMenu.length > 0) problems.push(`packaged: the menu offers ${devMenu.join(', ')}`);
    if (facts.userData !== 'fatg-smoke') problems.push(`packaged: userData is ${facts.userData}, not the smoke directory`);
    if (facts.name !== PRODUCT_NAME) problems.push(`packaged: the app is named ${facts.name}, not ${PRODUCT_NAME}`);
  }

  /** Real Chromium decoding and background playback through the confined media route. */
  async function checkAudio(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const decoded = await main.webContents.executeJavaScript(AUDIO_DECODE_PROBE) as AudioDecodeResult;
    if (!decoded.decoded) problems.push(`audio: default effects did not all decode through the local route (${JSON.stringify({ missing: decoded.missing, failed: decoded.failed })})`);
    const refused = await pet.webContents.executeJavaScript(`Promise.all([
      window.fatg.invoke('audio:list', null), window.fatg.invoke('audio:ui', { event: 'done' })
    ]).then((answers) => answers.every((answer) => !answer.ok))`) as boolean;
    if (!refused) problems.push('audio: the mini window could access more than UI cue requests');
    await main.webContents.executeJavaScript(`(async () => {
      const saved = await window.fatg.invoke('prefs:get', null);
      window.__audioSmoke = { saved: saved.value.values.audio, calls: 0, succeeded: 0, original: HTMLMediaElement.prototype.play };
      HTMLMediaElement.prototype.play = function () {
        if (this.src.startsWith('app://media/audio/')) window.__audioSmoke.calls++;
        return window.__audioSmoke.original.call(this).then((value) => { window.__audioSmoke.succeeded++; return value; });
      };
      await window.fatg.invoke('prefs:patch', { audio: { muted: false, volume: 0.05, sounds: { click: '${DEFAULT_SOUNDS.click}' } } });
    })()`);
    await delay(100);
    main.minimize();
    await waitFor('audio: the Main window to minimize', () => main.isMinimized());
    await pet.webContents.executeJavaScript(`window.fatg.invoke('audio:ui', { event: 'click' })`);
    const background = await waitFor('audio: exactly one background playback from the mini window', async () => await main.webContents.executeJavaScript('window.__audioSmoke.calls === 1 && window.__audioSmoke.succeeded === 1') as boolean);
    main.restore();
    await main.webContents.executeJavaScript(`(async () => {
      HTMLMediaElement.prototype.play = window.__audioSmoke.original;
      await window.fatg.invoke('prefs:patch', { audio: window.__audioSmoke.saved });
      delete window.__audioSmoke;
    })()`);
    await main.webContents.executeJavaScript(`document.querySelector('[role="toolbar"] button[aria-label="Settings"]').click()`);
    await main.webContents.executeJavaScript(`document.getElementById('settings-tab-audio')?.click()`);
    const pane = await waitFor('audio: all action and notification selectors in Settings', async () => await main.webContents.executeJavaScript(`document.querySelectorAll('[id^="audio-"]').length === ${AUDIO_EVENTS.length}`) as boolean);
    const capture = process.env['FATG_SMOKE_AUDIO_VISUAL_DIR'];
    if (capture !== undefined && path.isAbsolute(capture)) {
      mkdirSync(capture, { recursive: true });
      await delay(200);
      writeFileSync(path.join(capture, 'audio-settings.png'), (await main.webContents.capturePage()).toPNG());
    }
    await main.webContents.executeJavaScript(`document.querySelector('dialog[open]')?.close()`);
    report['audio'] = { defaults: decoded.count, decoded: decoded.decoded, miniRestricted: refused, background, pane };
  }

  async function checkNewChatInProject(main: BrowserWindow, pet: BrowserWindow, project: StoredProject): Promise<void> {
    // checkRecords alternates visibility between launches. Restore it even if the probe fails.
    if (project.hidden && (await records.setHidden(project.id, false)).status !== 'saved') throw new Error('new-chat: could not show the fixture project');
    try {
      await checkNewChat({ main, pet, prefs, snapshot: () => store.getSnapshot(), projectId: project.id });
    } finally {
      if (project.hidden && (await records.setHidden(project.id, true)).status !== 'saved') problems.push('new-chat: could not restore the fixture project’s visibility');
    }
  }

  async function run(): Promise<void> {
    checkPackaged();
    const main = windows.get('main');
    if (main === undefined) {
      problems.push('the Main window did not open');
      return;
    }
    if (!(await pageReady('main', main))) return;

    // The Pet opens exactly when the preferences read at start-up say so.
    const petAtStart = windows.get('pet') !== undefined;
    if (petAtStart !== loaded.windows.pet.visible) {
      problems.push(`the Pet window is ${petAtStart ? 'open' : 'not open'}, but the preferences say visible: ${loaded.windows.pet.visible}`);
    }
    if (!petAtStart) {
      // An earlier run stopped with the Pet hidden: bring it back the way a user would, from Settings.
      const answer = (await main.webContents.executeJavaScript(invokeFrom('prefs:patch', '{ windows: { pet: { visible: true } } }'))) as unknown;
      if (answer !== 'ok') problems.push(`main: showing the Pet from Settings answered ${String(answer)}`);
      await waitFor('the Pet window to open', () => windows.get('pet') !== undefined);
    }
    report['petAtStart'] = petAtStart ? 'open' : 'hidden — shown from the Main page';
    const pet = windows.get('pet');
    if (pet === undefined || !(await pageReady('pet', pet))) return;
    // The second reset launch must still show first detection; it is the evidence of fresh state.
    if (smokeScenario === 'data-reset' && process.env['FATG_SMOKE_RESET_STAGE'] === 'next') { await checkDataReset(main, pet, store, prefs, shutdown); finished = true; return; }
    await checkProviderDiscovery(main, pet);
    report['providerDiscovery'] = 'verified';
    if (smokeScenario === 'data-reset') { await checkDataReset(main, pet, store, prefs, shutdown); return; }
    if (smokeScenario !== undefined) {
      if (smokeScenario !== 'new-chat' && smokeScenario !== 'session-search' && smokeScenario !== 'avatar-family') throw new Error('unknown smoke scenario');
      // The UI scenarios need an initial catalog, not the providers' crash/recovery probes.
      if (!(await waitFor('the fixture catalog', () => store.getSnapshot().catalog?.providers.some((provider) => provider.id === 'codex' && provider.models.length > 0) === true))) return;
      await checkRecords(main, pet);
      const project = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
      if (project === undefined) throw new Error('scenario project missing');
      demo()?.pause();
      await sessions.settled();
      if (smokeScenario === 'new-chat') await checkNewChatInProject(main, pet, project);
      else if (smokeScenario === 'avatar-family') await checkCreateFamily(main, pet, prefs);
      else {
        demo()?.resume();
        await checkSessions(main, pet);
        demo()?.pause();
        await checkSessionSearch(main, pet);
      }
      if (problems.length) throw new Error('scenario setup failed');
      // Shutdown is exercised; full provider recovery, restart and hung-child checks remain in full smoke.
      const cleanup = await shutdown.cleanup();
      finished = true;
      console.log(`[smoke-scenario] ${JSON.stringify({ scenario: smokeScenario, ok: cleanup.ok })}`);
      app.exit(cleanup.ok ? 0 : 1);
      return;
    }
    await checkPetAutoHide(main, pet);
    await waitFor('the Pet to be shown', () => pet.isVisible());

    await checkCodexProvider(main, pet);
    await checkClaudeProvider(main, pet);
    await checkCatalog(main, pet);
    // Provider polling is intentionally accelerated in smoke mode. Pause it while comparing page
    // sequence markers so a legitimate one-second refresh cannot land between the two probes. The
    // demo source is held still for the same reason, once the writes its events asked for have landed.
    usage.suspend();
    demo()?.pause();
    await sessions.settled();
    await checkPages(main, pet);
    await checkAudio(main, pet);
    demo()?.resume();
    checkPetWindow(pet, 'at start');
    await checkTheme(main, pet);
    await checkRestore(main, pet);
    await captureVisuals(main);
    await checkPreferencesRoundTrip(main);
    await checkRecords(main, pet);
    await checkSessions(main, pet);
    await checkSessionSearch(main, pet);
    report['sessionSearch'] = 'Main-only service, index readiness, dialog filters and focus restoration';
    await checkAttachments(main, pet);
    demo()?.pause();
    const startProject = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    if (startProject !== undefined) {
      await checkNewChatInProject(main, pet, startProject);
      report['newChat'] = 'initial screen, guarded selection IPC, draft/images/Plan, exact preset recency and deletion';
    }
    demo()?.resume();
    await checkAvatars(main, pet);
    await checkCreateFamily(main, pet, prefs);
    await checkInstances(main, pet);
    await captureSessionVisuals(main);
    await checkPlacementRoundTrip(main, pet);
    await checkPetToggle(main, pet);
    await checkPetSessions(main, pet);
    demo()?.pause();
    const stateProject = records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === SMOKE_PROJECT);
    const statePreset = stateProject === undefined ? null : defaultPreset(presetTiles(store.getSnapshot().catalog, stateProject.providers.map((providerId) => ({ providerId, instanceId: FIRST_INSTANCE_ID }))));
    if (stateProject !== undefined && statePreset !== null) report['stateStreams'] = await checkStateStreams(main, pet, sessions, stateProject.id, statePreset);
    demo()?.resume();
    await checkSecondLaunch(main);
    await checkProcessSmoke(processes);
    report['processFixture'] = 'RPC, notification, recovery; live trees handed to normal quit';
    if (process.platform === 'darwin' && !(await checkMacReopen(main))) return;
    const quitMain = windows.get('main');
    const quitPet = windows.get('pet');
    if (quitMain === undefined || quitPet === undefined || !(await pageReady('pet', quitPet))) throw new Error('the windows were not ready for the quit check');
    await beginQuitThroughThePage(quitMain, quitPet);
    await beginQuitWithHungClaudeSession();
  }

  run()
    .catch((error: unknown) => {
      problems.push(`probe failed: ${String(error)}`);
    })
    .finally(finish);

  setTimeout(() => {
    problems.push(`timed out after ${TIMEOUT_MS}ms`);
    finish();
  }, TIMEOUT_MS).unref();
}
