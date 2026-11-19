// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The app's windows: where they open, where they went, and how they live and die together.
//
// Electron glue on purpose. Every decision it leans on is a pure module with its own tests —
// placement (bounds.ts), remembering it (bounds-tracker.ts), chrome (chrome.ts) — and the whole is
// exercised end to end by smoke mode (src/main/app/smoke.ts).
//
// The Pet is ONE long-lived window, hidden and shown rather than destroyed and recreated. Whether
// it is wanted is a preference (`windows.pet.visible`): its × (the `pet:hide` channel) and a user
// close hide it and remember that; Settings shows it again through the preference, which this
// manager follows. Destroying it on every toggle would run the destroy inside the Pet's own
// `pet:hide` call or `close` handler (the preferences store notifies synchronously), and would
// leave a dying window in the map for a quick re-show to trip over.
import { type BrowserWindow, screen } from 'electron';
import { petContentSize } from '@shared/contracts/pet';
import type { WindowKind } from '@shared/ipc/channels';
import type { TrustedOrigins } from '../app/origins';
import type { PageWatch } from '../app/quit-gate';
import type { PreferencesStore } from '../prefs/store';
import type { BroadcastTarget } from '../state/push';
import { type DisplayLayout, type Rect, type Size } from './bounds';
import { type Placement, type PlacementTracker, trackPlacement } from './bounds-tracker';
import { overlayFor, petWindowLevel, windowBackground } from './chrome';
import { createMainWindow } from './main-window';
import { fitPetBounds, openingPetBounds, petAnchor, type PetAnchor } from './pet-fit';
import { createPetWindow } from './pet-window';
import { mainStartupPlacement, parseWindowSize } from './startup-size';
import { whenReadyToShow } from './ready';
import type { ZoomControl } from './zoom';

export interface WindowManager {
  /** Brings the Main window forward (restoring it if minimized), or opens it — with the Pet, if wanted. */
  showMain(): void;
  /** Enables and shows the Pet without taking focus, even while Main has focus, until its next focus. */
  showPet(): void;
  /** Hides the Pet and remembers that it is not wanted. */
  hidePet(): void;
  /** Sizes the Pet to its list (src/shared/contracts/pet.ts), now if it is open, else when it opens. */
  fitPet(size: Size): void;
  get(kind: WindowKind): BrowserWindow | undefined;
  /** Where pushes go: every open window, hidden ones included, each tagged with its kind. */
  broadcastTargets(): BroadcastTarget[];
  /** From `before-quit`: from now on a close really closes, instead of hiding the Pet. */
  beginQuit(): void;
  /** Hands every window's latest position to the preferences now. Writing them is the caller's job. */
  flushPlacements(): void;
}

export interface WindowManagerOptions {
  readonly origins: TrustedOrigins;
  readonly preloadPath: string;
  readonly prefs: PreferencesStore;
  /** Gives a new window its IPC handlers (src/main/ipc/router.ts). */
  readonly attachIpc: (window: BrowserWindow, kind: WindowKind) => void;
  readonly emergencyCleanup?: () => void;
  /**
   * The Main window's `close` (×, Alt+F4, the system menu), before anything closes: the quit gate
   * prevents it while a session runs and the quit is not confirmed (M14, C99).
   */
  readonly onMainClose?: (event: { preventDefault(): void }) => void;
  /** Told what becomes of the Main window's page, so the gate knows whether it can ask there (M14, C103). */
  readonly mainPage?: PageWatch;
  /** Follows the Main window's page for its zoom (src/main/windows/zoom.ts). */
  readonly zoom?: Pick<ZoomControl, 'follow'>;
  /** Gives a new Main window the current application icon and follows session attention. */
  readonly mainIcon?: (window: BrowserWindow) => void;
  /** The Main window took the focus: what waited on the user's return there is seen (decision 0010). */
  readonly onMainFocus?: () => void;
}

export function createWindowManager({ origins, preloadPath, prefs, attachIpc, emergencyCleanup, onMainClose, mainPage, zoom, mainIcon, onMainFocus }: WindowManagerOptions): WindowManager {
  const startupSize = parseWindowSize(process.argv);
  const windows = new Map<WindowKind, BrowserWindow>();
  const trackers = new Map<WindowKind, PlacementTracker>();
  let quitting = false;
  // What the user wants; the window follows. Kept here as well as in the preferences, so the Pet
  // still hides for this session when a read-only preferences file refuses the change.
  let petWanted = prefs.getSnapshot().values.windows.pet.visible;
  let petAutoHide = prefs.getSnapshot().values.windows.pet.autoHideOnMainFocus;
  // Enabling is an explicit request to see it now. The next Main focus resumes automatic hiding.
  // Kept through loading and unrelated preference/list changes; never saved as a preference.
  let petShownOnEnable = false;
  let petReady = false;
  // The size its list asks for: an empty one until main says otherwise (fitPet).
  let petSize: Size = petContentSize({ size: prefs.getSnapshot().values.windows.pet.size, projects: [] });
  // Where main last put it. At a half-pixel place Electron reads a window back a DIP wider than it is,
  // so the edges kept when it resizes are measured from the size set, never the one read back.
  let petPlaced: Rect | null = null;
  // Resizing across the display's midpoint must not change the edges the user placed it by.
  let petEdges: PetAnchor | undefined;
  // Whether the Pet follows the screens' scales yet: `screen` answers only once the app is ready, so
  // it is asked when the Pet first opens.
  let followingDisplays = false;
  // New windows are created in it; a change repaints the open ones. The page's own colours follow
  // the app state instead (src/main/state/appearance.ts), which also reaches the Pet.
  let theme = prefs.getSnapshot().values.appearance.theme;

  function register(kind: WindowKind, window: BrowserWindow, maximized: boolean, save: (placement: Placement) => void): void {
    windows.set(kind, window);
    attachIpc(window, kind);
    trackers.set(kind, trackPlacement(window, { maximized, save }));
    // Windows logoff and shutdown skip before-quit and will-quit (src/main/app/lifecycle.ts), so
    // this is the last chance to save.
    window.on('session-end', () => {
      emergencyCleanup?.();
      flushPlacements();
      prefs.flushSync();
    });
    window.on('closed', () => {
      if (windows.get(kind) !== window) return;
      windows.delete(kind);
      trackers.delete(kind);
    });
  }

  function openMain(): void {
    const saved = prefs.getSnapshot().values.windows.main;
    const placement = mainStartupPlacement(saved, currentDisplayLayout(), startupSize);
    const window = createMainWindow({
      origins,
      preloadPath,
      ...placement,
      theme,
    });
    register('main', window, placement.maximized, (placement) => prefs.patch({ windows: { main: placement } }));
    mainIcon?.(window);
    const updateOverlay = (): void => {
      if (window.isDestroyed()) return;
      const overlay = overlayFor(process.platform, theme, window.isFocused());
      if (overlay !== null) window.setTitleBarOverlay(overlay);
    };
    window.on('focus', updateOverlay);
    window.on('blur', updateOverlay);
    updateOverlay();
    window.on('focus', () => {
      petShownOnEnable = false;
      syncPetVisibility();
    });
    window.on('blur', syncPetVisibility);
    window.on('minimize', syncPetVisibility);
    window.on('restore', syncPetVisibility);
    window.on('hide', syncPetVisibility);
    window.on('show', syncPetVisibility);
    window.on('focus', () => onMainFocus?.());
    mainPage?.opened();
    window.webContents.on('did-start-loading', () => mainPage?.loading());
    window.webContents.on('did-finish-load', () => mainPage?.loaded());
    window.webContents.on('render-process-gone', () => mainPage?.gone());
    zoom?.follow(window.webContents);
    window.on('unresponsive', () => mainPage?.unresponsive());
    window.on('responsive', () => mainPage?.responsive());
    window.on('closed', () => mainPage?.closed());
    // Electron emits `close` before the page's `beforeunload`, so main hears a × even when the page
    // is frozen. The gate decides: a close it prevents closes nothing.
    window.on('close', (event) => onMainClose?.(event));
    // Until the tray exists (M8) the app lives as long as the Main window. A Pet left behind — even
    // a hidden one — would keep it running with nothing on screen.
    window.on('closed', destroyPet);
  }

  function openPet(): void {
    const saved = prefs.getSnapshot().values.windows.pet;
    const layout = currentDisplayLayout();
    // Whole device pixels on the display it lands on, which is known once it has a place.
    petPlaced = openingPetBounds(saved.bounds, petSize, layout, scaleAt(openingPetBounds(saved.bounds, petSize, layout)));
    petEdges = petAnchor(petPlaced, layout);
    const window = createPetWindow({ origins, preloadPath, bounds: petPlaced, theme });
    petReady = false;
    // At its first paint, or failing that once its page has loaded (ready.ts).
    whenReadyToShow(window, () => {
      if (window.isDestroyed()) return;
      petReady = true;
      // Use the latest preference and focus, including changes while the page was loading.
      syncPetVisibility();
    });
    // A close the user asks for (Alt+F4, the system menu) hides the Pet and remembers it, like
    // the ×. Only quitting really closes it; teardown from here uses destroy(), which skips this.
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      hidePet();
    });
    register('pet', window, false, ({ bounds }) => prefs.patch({ windows: { pet: { bounds } } }));
    // A drag across screens of different scales leaves the window at the size Windows scaled it to,
    // which can be device pixels off the size its page is laid out at — the page then wider than the
    // window, its right border cut (seen at 150%: 455 pixels for 450). So at the end of every drag,
    // at any change of size main did not make, and at any change of a screen's scale, main puts it
    // back at its list's size in DIPs, which Chromium turns into whole pixels its page matches. A
    // drag also chooses which edges stay fixed as the list grows and shrinks.
    let dragging = false;
    window.on('will-move', () => { dragging = true; });
    window.on('moved', () => {
      if (dragging) petEdges = undefined;
      dragging = false;
      placePet(window, true);
    });
    window.on('resize', () => {
      if (!dragging) placePet(window);
    });
    if (!followingDisplays) {
      followingDisplays = true;
      screen.on('display-metrics-changed', () => {
        const pet = windows.get('pet');
        petEdges = undefined;
        if (pet !== undefined) placePet(pet, true);
      });
    }
  }

  /**
   * Puts the Pet at its list's size from where it is, unless `force` is false and it is there already
   * — within the DIP a read-back may be off by. Plain setBounds: see createPetWindow for why it is
   * never "settled". The edges kept are measured from the size main set, never the one read back.
   */
  function placePet(window: BrowserWindow, force = false): void {
    if (window.isDestroyed()) return;
    const read = window.getBounds();
    const current = { ...read, width: petPlaced?.width ?? read.width, height: petPlaced?.height ?? read.height };
    const layout = currentDisplayLayout();
    const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1;
    // Also detect a move on platforms without the end-of-drag event, when the list next changes.
    if (petPlaced !== null && (!near(read.x, petPlaced.x) || !near(read.y, petPlaced.y))) petEdges = undefined;
    petEdges ??= petAnchor(current, layout);
    const next = fitPetBounds(current, petSize, layout, scaleAt(read), petEdges);
    if (!force && near(next.x, read.x) && near(next.y, read.y) && near(next.width, read.width) && near(next.height, read.height)) return;
    petPlaced = next;
    window.setBounds(next);
  }

  function fitPet(size: Size): void {
    if (size.width === petSize.width && size.height === petSize.height) return;
    petSize = size;
    const pet = windows.get('pet');
    if (pet !== undefined) placePet(pet);
  }

  function destroyPet(): void {
    const pet = windows.get('pet');
    if (pet === undefined || pet.isDestroyed()) return;
    trackers.get('pet')?.flush(); // destroy() skips `close`, where the tracker would have saved
    pet.destroy();
  }

  function showPet(): void {
    if (quitting) return;
    petShownOnEnable = true;
    petWanted = true;
    prefs.patch({ windows: { pet: { visible: true } } });
    const pet = windows.get('pet');
    if (pet === undefined) openPet();
    else syncPetVisibility(); // still loading: `ready-to-show` settles visibility
  }

  function hidePet(): void {
    petShownOnEnable = false;
    petWanted = false;
    syncPetVisibility();
    prefs.patch({ windows: { pet: { visible: false } } });
  }

  /** Automatic hiding never changes whether the user wants the Pet enabled. */
  function syncPetVisibility(): void {
    const pet = windows.get('pet');
    if (pet === undefined || pet.isDestroyed() || quitting) return;
    const main = windows.get('main');
    const mainFocused = main !== undefined && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused();
    const show = petWanted && petReady && (petShownOnEnable || !(petAutoHide && mainFocused));
    if (show && !pet.isVisible()) {
      pet.showInactive();
      // Re-establish the native topmost state after showing, rather than relying on the state
      // set at creation surviving every hide/show. Raising the window must not take focus.
      pet.setAlwaysOnTop(true, petWindowLevel(process.platform));
      pet.moveTop();
    } else if (!show && pet.isVisible()) pet.hide();
  }

  function flushPlacements(): void {
    for (const tracker of trackers.values()) tracker.flush();
  }

  // Follow enabled and auto-hide changes from Settings; unrelated placement writes do nothing.
  // showPet/hidePet's own patches arrive here already matching `petWanted`.
  prefs.subscribe((snapshot) => {
    const { visible, autoHideOnMainFocus } = snapshot.values.windows.pet;
    const autoHideChanged = autoHideOnMainFocus !== petAutoHide;
    petAutoHide = autoHideOnMainFocus;
    if (autoHideChanged) petShownOnEnable = false;
    if (visible !== petWanted) {
      if (visible) showPet();
      else hidePet();
    } else if (autoHideChanged) syncPetVisibility();
  });

  // What the OS paints follows the theme at once, without a reload: the window background (seen
  // while resizing, and behind the page) and, on Windows, the window buttons over the title strip.
  prefs.subscribe((snapshot) => {
    const next = snapshot.values.appearance.theme;
    if (next === theme) return;
    theme = next;
    for (const [kind, window] of windows) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(windowBackground(theme));
      const overlay = kind === 'main' ? overlayFor(process.platform, theme, window.isFocused()) : null;
      if (overlay !== null) window.setTitleBarOverlay(overlay);
    }
  });

  return {
    showMain() {
      if (quitting) return;
      const main = windows.get('main');
      if (main === undefined) {
        openMain();
        if (petWanted && !windows.has('pet')) openPet();
        return;
      }
      if (main.isMinimized()) main.restore();
      // A window still waiting to be shown is shown now: someone asked for it.
      if (!main.isVisible()) main.show();
      main.focus();
    },

    showPet,
    hidePet,
    fitPet,
    get: (kind) => windows.get(kind),

    broadcastTargets: () =>
      [...windows].map(([kind, window]) => ({
        kind,
        isAlive: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
        send: (channel, payload) => window.webContents.send(channel, payload),
      })),

    beginQuit() {
      quitting = true;
    },

    flushPlacements,
  };
}

/** The scale of the display a rectangle is mostly on. Only valid once the app is ready. */
function scaleAt(rect: Rect): number {
  return screen.getDisplayMatching(rect).scaleFactor;
}

/** Every display's work area, as of now. Only valid once the app is ready. */
export function currentDisplayLayout(): DisplayLayout {
  return {
    workAreas: screen.getAllDisplays().map((display) => display.workArea),
    primary: screen.getPrimaryDisplay().workArea,
  };
}
