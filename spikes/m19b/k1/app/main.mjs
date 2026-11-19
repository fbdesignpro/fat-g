// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1's main process: M19's K3 harness (spikes/m19/k3/app/main.mjs) with a page of M19b's own. A
// scratch app, never fat-g. It serves the page as fat-g serves its own — fat-g's own modules build
// the policy, register `app://fatg`, answer its requests and harden the session
// (src/main/app/csp.ts, origins.ts, protocol.ts, security.ts) — so the page runs under the
// Content-Security-Policy a development page and a packaged page get. It opens one window per
// case, so that no case is measured in a page another filled, waits for the page's report, writes
// the reports and exits.
//
// The window is shown, without taking the focus: a hidden window is not painted, and the frame
// times would mean nothing. Electron's own data stays in the scratch folder it is given.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';
import { buildCsp } from '../../../../src/main/app/csp';
import { APP_ORIGIN, resolveTrustedOrigins } from '../../../../src/main/app/origins';
import { handleAppProtocol, registerAppScheme } from '../../../../src/main/app/protocol';
import { hardenSession, hardenWebContents } from '../../../../src/main/app/security';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env['FATG_SPIKE_OUT'];
const dir = process.env['FATG_SPIKE_DIR'];
const cases = (process.env['FATG_SPIKE_CASES'] ?? '').split(',').filter(Boolean);
const query = process.env['FATG_SPIKE_QUERY'] ?? '';
const PAGE_MS = Number(process.env['FATG_SPIKE_PAGE_MS'] ?? 300_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HUNG = Symbol('no answer from the page');

async function runPage(origins, name) {
  const window = new BrowserWindow({
    width: 1280, height: 800, show: false, title: `fat-g M19b spike K1: ${name}`,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const consoleLines = [];
  window.webContents.on('console-message', (details) => {
    const message = String(details.message ?? '');
    if (details.level === 'error' || /Content Security Policy|Refused to/i.test(message)) consoleLines.push(message.slice(0, 300));
  });
  let gone = null;
  window.webContents.on('render-process-gone', (_event, details) => { gone = details.reason; });
  window.showInactive();
  const url = `${origins.devServer ?? APP_ORIGIN}/index.html?case=${name}${query ? `&${query}` : ''}`;
  const startedAt = Date.now();
  let result = null;
  try {
    await window.loadURL(url);
    while (Date.now() - startedAt < PAGE_MS) {
      await sleep(1_000);
      if (gone !== null) { result = { failed: `the page's process ended: ${gone}`, at: result?.at ?? null, partial: result?.partial ?? null }; break; }
      // A page busy with one long task answers when the task ends: asked with the time that is left, and no longer.
      const state = await Promise.race([window.webContents.executeJavaScript('window.__k1 ? JSON.stringify(window.__k1) : null'), sleep(Math.max(1_000, PAGE_MS - (Date.now() - startedAt))).then(() => HUNG)]);
      if (state === HUNG) { result = { unfinished: true, hung: true, at: result?.at ?? null, partial: result?.partial ?? null }; break; }
      const parsed = state ? JSON.parse(state) : null;
      if (parsed?.done) { result = parsed.report; break; }
      result = { unfinished: true, at: parsed?.at ?? null, partial: parsed?.partial ?? null };
    }
  } catch (error) {
    result = { failed: String(error?.message ?? error).slice(0, 500) };
  }
  // A page still in a task does not end with its window: its process is ended.
  if (result?.hung) { try { window.webContents.forcefullyCrashRenderer(); } catch { /* gone already */ } }
  window.destroy();
  return { url: url.replace(/^http:\/\/[^/]+/, '<dev server>'), seconds: Math.round((Date.now() - startedAt) / 1000), consoleLines, report: result };
}

if (!out || !dir || cases.length === 0) app.exit(2);
else {
  registerAppScheme();
  // Spike only: a window covered by another is still painted.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.setPath('userData', path.join(dir, 'user-data'));
  app.on('window-all-closed', () => { /* the next window follows */ });
  void app.whenReady().then(async () => {
    const origins = resolveTrustedOrigins({ isPackaged: app.isPackaged, devServerUrl: process.env['ELECTRON_RENDERER_URL'] });
    const csp = buildCsp(origins);
    hardenSession(session.defaultSession, origins, csp);
    hardenWebContents(origins);
    handleAppProtocol(path.join(here, '../renderer'), csp);
    const pages = {};
    for (const name of cases) pages[name] = await runPage(origins, name);
    writeFileSync(out, `${JSON.stringify({ at: new Date().toISOString(), packaged: app.isPackaged, page: origins.devServer !== undefined ? 'development server' : 'app://', csp, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, pages }, null, 2)}\n`);
    app.exit(0);
  });
}
