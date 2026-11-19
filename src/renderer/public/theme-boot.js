// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sets the page's theme before its first paint (docs/planning/_archive/M11.md, Design 2). Main puts the saved
// theme in the page URL (?theme=light|dark); this classic script runs in <head>, before the body is
// parsed and before any stylesheet applies. A file from the app's own origin rather than an inline
// script, so the Content-Security-Policy stays script-src 'self'. Anything but the two known values
// is ignored and the page stays light, which is what :root carries in tokens.css.
// From then on src/renderer/src/theme/ThemeRoot.tsx keeps the attribute equal to the app state.
(function () {
  'use strict';
  var theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
})();
