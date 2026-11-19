// B8: the one Electron script of M10 (C1). Renders each comparison sheet, asks Chromium which fonts
// drew the glyphs of every cell (what DevTools shows as "Rendered Fonts"), tints any cell a system
// font helped draw, and saves a screenshot and a coverage table. Local files only: every request
// that is not file:, data: or devtools: is cancelled.
//
// Started by fonts/run.mjs, never directly:
//   electron main.cjs --sheets <sheets.json> --out <dir> --user-data <dir>
'use strict';
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sheetsFile = arg('sheets');
const outDir = arg('out');
app.setPath('userData', arg('user-data'));
app.disableHardwareAcceleration();
// One window per sheet, destroyed after its screenshot: closing the last one must not quit early.
app.on('window-all-closed', () => {});

async function renderedFonts(win) {
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  try {
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
    // Every element inside a cell names its cell, so each text node's fonts can be summed per cell.
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-cell]').forEach((cell, i) => {
        cell.setAttribute('data-owner', String(i));
        cell.querySelectorAll('*').forEach((el) => el.setAttribute('data-owner', String(i)));
      });
      return true;
    })()`);
    const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-owner]' });
    const cells = new Map();
    for (const nodeId of nodeIds) {
      const { attributes } = await dbg.sendCommand('DOM.getAttributes', { nodeId });
      const owner = attributes[attributes.indexOf('data-owner') + 1];
      const { fonts } = await dbg.sendCommand('CSS.getPlatformFontsForNode', { nodeId });
      const entry = cells.get(owner) ?? new Map();
      for (const font of fonts) {
        const key = `${font.familyName}|${font.isCustomFont}`;
        const known = entry.get(key) ?? { family: font.familyName, custom: font.isCustomFont, glyphs: 0 };
        known.glyphs += font.glyphCount;
        entry.set(key, known);
      }
      cells.set(owner, entry);
    }
    return [...cells].map(([owner, fonts]) => ({ owner: Number(owner), fonts: [...fonts.values()] }));
  } finally {
    dbg.detach();
  }
}

async function renderSheet(sheet) {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  try {
    await win.loadFile(sheet.file);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.size)');
    const cells = await renderedFonts(win);
    const marks = cells.map((cell) => {
      const system = cell.fonts.filter((f) => !f.custom);
      return { owner: cell.owner, fallback: system.length > 0, label: system.map((f) => `${f.family} (${f.glyphs})`).join(', '), fonts: cell.fonts };
    });
    const described = await win.webContents.executeJavaScript(`(() => {
      const marks = ${JSON.stringify(marks.map(({ owner, fallback, label }) => ({ owner, fallback, label })))};
      const cells = [...document.querySelectorAll('[data-cell]')];
      for (const m of marks) if (m.fallback) { const c = cells[m.owner]; c.classList.add('fallback'); c.setAttribute('data-fallback', 'system font: ' + m.label); }
      return cells.map((c, i) => ({ owner: i, candidate: c.dataset.candidate ?? null, script: c.dataset.script ?? null, style: c.getAttribute('style') ?? '' }));
    })()`);
    const height = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)');
    win.setContentSize(1400, Math.min(height, 16000));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `sheet-${sheet.id}-${sheet.theme}.png`), image.toPNG());
    return described.map((cell) => ({ sheet: sheet.id, theme: sheet.theme, ...cell, ...(marks.find((m) => m.owner === cell.owner) ?? { fallback: null, fonts: [] }) }));
  } finally {
    win.destroy();
  }
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data|devtools):/.test(details.url) });
  });
  const sheets = JSON.parse(fs.readFileSync(sheetsFile, 'utf8'));
  const rows = [];
  let code = 0;
  try {
    for (const sheet of sheets) rows.push(...(await renderSheet(sheet)));
    fs.writeFileSync(path.join(outDir, 'coverage.json'), `${JSON.stringify(rows, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`font page failed: ${error?.stack ?? error}\n`);
    code = 1;
  }
  app.exit(code);
});
