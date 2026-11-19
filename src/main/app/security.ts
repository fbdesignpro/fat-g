// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Session- and webContents-level hardening. Applied once at startup; covers every window,
// including ones created later (Pet window, M4).
import { app, type Session } from 'electron';
import { isAllowedRequestUrl, isMediaUrl, isTrustedPageUrl, type TrustedOrigins } from './origins';

/** The only web permission the UI needs: "copy" buttons via navigator.clipboard.writeText. */
const GRANTABLE_PERMISSION = 'clipboard-sanitized-write';

export function hardenSession(session: Session, origins: TrustedOrigins, csp: string): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permission === GRANTABLE_PERMISSION && isTrustedPageUrl(details.requestingUrl, origins));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return permission === GRANTABLE_PERMISSION && isTrustedPageUrl(requestingOrigin, origins);
  });

  // The app performs no network I/O of its own (docs/decisions/0004). Anything that is not one
  // of our pages, the local dev server, or DevTools internals is cancelled — so a stray remote
  // font/image/script reference fails loudly instead of silently phoning out.
  // The log says the request's kind and scheme, never its address: a media address names an image of
  // a chat, and any other may name a path or a query of the user's (M23, C75).
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedRequestUrl(details.url, origins, details.resourceType);
    if (!allowed) console.warn(`[security] blocked request: ${details.resourceType} (${requestKind(details.url)})`);
    callback({ cancel: !allowed });
  });

  // Packaged pages get their CSP from the app:// protocol handler. The Vite dev server doesn't
  // send one, so inject it here to keep development under (almost) the same policy.
  if (origins.devServer !== undefined) {
    session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
}

/** What a log may say of a blocked address: the media route, or a scheme. */
function requestKind(url: string): string {
  if (isMediaUrl(url)) return 'media';
  try {
    return new URL(url).protocol.replace(/:$/, '');
  } catch {
    return 'unparsed';
  }
}

export function hardenWebContents(origins: TrustedOrigins): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedPageUrl(url, origins)) {
        console.warn(`[security] blocked navigation (${requestKind(url)})`);
        event.preventDefault();
      }
    });
    // External links are opened deliberately via an allowlisted IPC call (M2), never window.open.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
