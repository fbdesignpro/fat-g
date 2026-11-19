# 0008 — Main window shell: the title strip stays, Settings is a modal

> **Rule:** the layout starts below the 40px title strip, which is its own row in the page grid; the OS draws the window buttons. Settings is a `<dialog>` modal inside the Main window, not an OS window.

- **Status:** Accepted by the maintainer. Implemented in M11: the strip is the page grid's first row (`src/renderer/src/shell/`), Settings is a `<dialog>` (`src/renderer/src/settings/`), and the overlay's colours follow the theme (`src/main/windows/chrome.ts`). Since M100 (C19) the strip holds the menu and the gear after the app's name, outside its drag region and within the part of the row the window buttons leave free: the first kind of step 3, within the overlay; the strip stays its own row. Since M101 (C15) Settings is divided into tabs, one per section, and stays a modal: the tabs answer the "grows beyond what a modal holds comfortably" line.
- **Applies to:** `src/main/windows/chrome.ts`, the Main window's page layout, Settings.

## Context

The layout overview (private) puts a control bar at the top of the Main window and a project list that takes the full height of one side.

Since M4 the Main window hides the OS title bar. The page draws its own 40px title strip, and the OS draws the window buttons on top of it. If the new layout ran to the top edge of the window:
- on Windows, the minimize, maximize and close buttons would sit over the first project header and its `+` and `…` buttons;
- on macOS, the traffic lights would sit over the menu and gear buttons.

The overview also calls for a settings window. Settings is currently one of two full-window scenes.

## Decision

1. **The layout starts below the title strip.** "Top" in the layout overview means the top of the content, not the top edge of the window. The strip and its overlay stay as M4 built them.
2. **The title strip is its own row in the page grid.** Nothing else in the layout depends on what the strip contains, so the window chrome can change later without reshaping the layout.
3. **Restyling the chrome later is allowed, in two steps:**
   - First within the overlay: its colours and height, or merging the strip into the control bar to win back its 40px.
   - Fully custom window buttons (a frameless window with buttons drawn by the page) only if the OS-drawn buttons still clash with the finished design.
4. **Settings is a modal inside the Main window's page**, built on the HTML `<dialog>` element. It is not a separate OS window.
5. **About** is the last Settings tab. It shows the author, version, project address, full MIT license and third-party/provider notice. Its information is bundled at build time and stays readable with unavailable or read-only preferences; it saves nothing and invokes no IPC.

## Consequences

- The layout gives up 40px of height until step 3 merges the strip into the control bar.
- The theme has to drive the native colours too: the window background and the overlay's colours are set in `chrome.ts`, not in CSS.
- When Main loses focus, its title text and toolbar icons turn light grey, as do the Windows overlay's symbols; focus restores the theme's text colour. A theme change preserves that focus state. macOS and Linux keep their native inactive window controls.
- No third window kind is added, so the IPC sender policy (`from: ['main','pet']`), the single preload entry and the preferences channels stay as they are.
- The content of today's Settings and Usage scenes moves into the modal and the control bar.
- Custom window buttons would cost:
  - the Windows 11 snap-layouts menu shown when hovering the maximize button, which is tied to the OS-drawn button;
  - minimize, maximize/restore and close re-implemented over IPC;
  - per-OS conventions, since macOS users expect traffic lights on the left. macOS can stay native while Windows goes custom.

## Revisit when

- The visual design is final and the OS-drawn buttons still clash with it.
- Settings grows beyond what a modal holds comfortably.
