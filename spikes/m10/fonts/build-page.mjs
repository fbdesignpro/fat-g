// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B8: builds the font comparison page from the font files under spikes/output/fonts/files/<id>/
// (C40–C43, C70). Local files only. Each candidate gets a private family name ("M10 <id>"), so a
// copy installed on the system can never stand in for the file under test.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FONTS_OUTPUT_DIR } from '../lib/paths.mjs';

export const FILES_DIR = path.join(FONTS_OUTPUT_DIR, 'files');
export const PAGE_DIR = path.join(FONTS_OUTPUT_DIR, 'page');

/** C40, with the licence reading of C41 (official sources). */
export const CANDIDATES = Object.freeze([
  { id: 'inter', name: 'Inter', version: '4.1', licence: 'SIL Open Font License 1.1', source: 'https://github.com/rsms/inter', verdict: 'passes' },
  { id: 'tex-gyre-heros', name: 'TeX Gyre Heros', version: '2.609', licence: 'GUST Font License (LPPL 1.3c or later)', source: 'https://www.gust.org.pl/projects/e-foundry/tex-gyre/heros', verdict: 'passes for unmodified files; LPPL asks for the work to be distributed complete' },
  { id: 'liberation-sans', name: 'Liberation Sans', version: '2.1.5', licence: 'SIL Open Font License 1.1 (reserved name "Liberation")', source: 'https://github.com/liberationfonts/liberation-fonts', verdict: 'passes' },
  { id: 'nimbus-sans', name: 'Nimbus Sans', version: 'URW base35', licence: 'AGPL-3.0 with an exception for embedding in PostScript and PDF documents only', source: 'https://github.com/ArtifexSoftware/urw-base35-fonts', verdict: 'fails C41: shipping the files in an app installer is outside the exception', excluded: true },
]);

export const SIZES = Object.freeze([10, 11, 12, 13, 14, 15, 16, 18, 20, 24]);
const WEIGHT_NAMES = [['thin', 100], ['extralight', 200], ['light', 300], ['regular', 400], ['book', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['bold', 700], ['extrabold', 800], ['black', 900]];
const SAMPLE = 'The quick brown fox jumps over the lazy dog 0123456789 · Session 12 · 3 workers · 04:37';

export const SCRIPTS = Object.freeze([
  ['Latin Extended', 'Ça déjà vu à Łódź, Øresund, Ðakovo, Şişli, İzmir, Ærø, Straße ẞ, Việt Nam'],
  ['Greek', 'Γαζέες καὶ μυρτιὲς δὲν θὰ βρῶ πιὰ στὸ χρυσαφὶ ξέφωτο'],
  ['Cyrillic', 'Съешь же ещё этих мягких французских булок, да выпей чаю'],
  ['Hebrew', 'דג סקרן שט בים מאוכזב ולפתע מצא חברה'],
  ['Arabic', 'نص حكيم له سر قاطع وذو شأن عظيم مكتوب على ثوب أخضر'],
  ['Devanagari', 'ऋषियों को सताने वाले दुष्ट राक्षसों के राजा रावण का सर्वनाश'],
  ['Thai', 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า กว่าบรรดาฝูงสัตว์เดรัจฉาน'],
  ['Chinese', '我能吞下玻璃而不伤身体。会话已完成。'],
  ['Japanese', 'いろはにほへと ちりぬるを カタカナ 漢字の表示'],
  ['Korean', '다람쥐 헌 쳇바퀴에 타고파 세션이 완료되었습니다'],
  ['Symbols', '→ ← ↑ ↓ ✓ ✗ • … ‹ › « » € £ ¥ © ® ™ ± × ÷ ≤ ≥ ≠ ∞ ⌘ ⌥ ⇧ ⏎ ● ○ ■ □ ▲ ▼ ★ ☆'],
]);

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function weightOf(file) {
  const base = path.basename(file).toLowerCase().replace(/[-_ ]/g, '');
  if (/variable|\[wght\]|vf\b/.test(base)) return 'variable';
  for (const [name, weight] of WEIGHT_NAMES.slice().sort((a, b) => b[0].length - a[0].length)) if (base.includes(name)) return weight;
  return 400;
}

/** The files present for each candidate: upright styles only, with their weights. */
export function scanCandidates() {
  return CANDIDATES.map((candidate) => {
    const dir = path.join(FILES_DIR, candidate.id);
    const files = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(otf|ttf|woff2?)$/i.test(f) && !/italic|oblique|condensed|cn|narrow/i.test(path.basename(f))) : [];
    const faces = files.map((file) => ({ file: path.join(dir, file), weight: weightOf(file) }));
    // Prefer one format per weight: OTF, then TTF, then WOFF2; a variable file covers all weights.
    const rank = (f) => ['.otf', '.ttf', '.woff2', '.woff'].indexOf(path.extname(f.file).toLowerCase());
    const byWeight = new Map();
    for (const face of faces.sort((a, b) => rank(a) - rank(b))) if (!byWeight.has(face.weight)) byWeight.set(face.weight, face);
    const variable = byWeight.get('variable');
    const statics = [...byWeight.values()].filter((f) => f.weight !== 'variable');
    const available = variable ? [400, 500, 600, 700] : statics.map((f) => f.weight);
    // C70: regular and bold, plus the middle weights the candidate has.
    const weights = [...new Set(available)].filter((w) => w >= 400 && w <= 700).sort((a, b) => a - b);
    return { ...candidate, family: `M10 ${candidate.id}`, faces: variable ? [variable] : statics, weights, present: Boolean(variable || statics.length) };
  });
}

function fontFaces(candidates) {
  return candidates.filter((c) => c.present && !c.excluded).flatMap((c) => c.faces.map((face) => {
    const weight = face.weight === 'variable' ? '100 900' : face.weight;
    return `@font-face { font-family: "${c.family}"; src: url("${pathToFileURL(face.file).href}"); font-weight: ${weight}; font-style: normal; }`;
  })).join('\n');
}

const CSS = `
:root { --bg: #ffffff; --fg: #000000; --muted: #666666; --rule: #d0d0d0; --fallback: #ffe08a; }
body.dark { --bg: #000000; --fg: #ffffff; --muted: #9a9a9a; --rule: #333333; --fallback: #5a4500; }
html, body { margin: 0; background: var(--bg); color: var(--fg); }
body { padding: 24px; font: 13px/1.4 "Segoe UI", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
.meta { color: var(--muted); margin-bottom: 12px; }
table { border-collapse: collapse; width: 100%; }
td, th { border-bottom: 1px solid var(--rule); padding: 3px 8px; text-align: left; vertical-align: baseline; white-space: nowrap; }
th { color: var(--muted); font-weight: 400; width: 1%; }
[data-cell].fallback { background: var(--fallback); }
[data-cell].fallback::after { content: attr(data-fallback); font: 11px "Segoe UI", sans-serif; margin-left: 8px; color: var(--muted); }
.capsule { display: inline-flex; gap: 10px; align-items: center; border: 1px solid var(--fg); border-radius: 999px; padding: 4px 6px 4px 12px; margin: 6px 12px 6px 0; }
.capsule .status { text-transform: uppercase; letter-spacing: 0.06em; }
.capsule .attention { text-transform: uppercase; letter-spacing: 0.08em; border: 1px solid var(--fg); border-radius: 999px; padding: 2px 8px; background: var(--fg); color: var(--bg); }
.capsule .muted { color: var(--muted); }
.missing { color: var(--muted); font-style: italic; }
`;

function header(title, candidates, theme) {
  const listed = candidates.map((c) => `${escape(c.name)} ${escape(c.version)} (${escape(c.licence)}; ${c.excluded ? 'left off: ' + escape(c.verdict) : c.present ? `weights ${c.weights.join(', ')}` : 'file not fetched yet'})`).join('<br>');
  return `<h1>${escape(title)} · ${theme}</h1><div class="meta">${listed}</div>`;
}

function sizesSheet(candidates) {
  return candidates.filter((c) => !c.excluded).map((c) => {
    if (!c.present) return `<h2>${escape(c.name)}</h2><p class="missing">No font file yet under spikes/output/fonts/files/${c.id}/.</p>`;
    const rows = c.weights.flatMap((weight) => SIZES.map((size) => `<tr><th>${weight} · ${size}px</th><td data-cell data-candidate="${c.id}" style="font-family:'${c.family}';font-weight:${weight};font-size:${size}px">${escape(SAMPLE)}</td></tr>`));
    return `<h2>${escape(c.name)}</h2><table>${rows.join('')}</table>`;
  }).join('');
}

function capsuleSheet(candidates) {
  return candidates.filter((c) => !c.excluded).map((c) => {
    if (!c.present) return `<h2>${escape(c.name)}</h2><p class="missing">No font file yet.</p>`;
    const capsule = (size) => `<span class="capsule" data-cell data-candidate="${c.id}" style="font-family:'${c.family}';font-size:${size + 2}px">
      <span style="font-weight:600">Refactor the usage bars</span><span class="status muted" style="font-size:${size}px">Running</span>
      <span class="muted">12:04</span><span class="muted">3 workers</span>
      <span class="attention" style="font-size:${size}px;font-weight:700">3 questions</span></span>`;
    return `<h2>${escape(c.name)}</h2><div>${capsule(10)} <span class="muted">labels at 10 px</span></div><div>${capsule(11)} <span class="muted">labels at 11 px</span></div>`;
  }).join('');
}

function scriptsSheet(candidates) {
  const present = candidates.filter((c) => !c.excluded && c.present);
  if (!present.length) return '<p class="missing">No font file yet.</p>';
  const head = `<tr><th></th>${present.map((c) => `<th style="width:auto">${escape(c.name)}</th>`).join('')}</tr>`;
  const rows = SCRIPTS.map(([script, text]) => `<tr><th>${escape(script)}</th>${present.map((c) => `<td data-cell data-candidate="${c.id}" data-script="${escape(script)}" style="font-family:'${c.family}';font-size:14px;white-space:normal">${escape(text)}</td>`).join('')}</tr>`);
  return `<table>${head}${rows.join('')}</table>`;
}

export const SHEETS = Object.freeze([
  { id: 1, title: 'Sizes and weights', theme: 'light', body: sizesSheet },
  { id: 2, title: 'Sizes and weights', theme: 'dark', body: sizesSheet },
  { id: 3, title: 'Mock capsule', theme: 'light', body: capsuleSheet },
  { id: 4, title: 'Scripts and fallback', theme: 'light', body: scriptsSheet },
  { id: 5, title: 'Scripts and fallback', theme: 'dark', body: scriptsSheet },
]);

/** Writes one HTML file per sheet; returns the candidates and the files written. */
export function buildPages() {
  const candidates = scanCandidates();
  mkdirSync(PAGE_DIR, { recursive: true });
  const files = SHEETS.map((sheet) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src file:; style-src 'unsafe-inline'"><title>M10 fonts ${sheet.id}</title><style>${fontFaces(candidates)}\n${CSS}</style></head><body class="${sheet.theme}">${header(sheet.title, candidates, sheet.theme)}${sheet.body(candidates)}</body></html>`;
    const file = path.join(PAGE_DIR, `sheet-${sheet.id}.html`);
    writeFileSync(file, html);
    return { id: sheet.id, title: sheet.title, theme: sheet.theme, file };
  });
  return { candidates, files };
}
