// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The style rules M11 settles (docs/planning/_archive/M11.md: V1, V8, V18, V20), checked on the stylesheets
// themselves. jsdom computes no layout and the component tests load no CSS, so a rule that lives only
// in a stylesheet is proven here or nowhere.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_COLORS, THEMES } from '@shared/contracts/appearance';
import { PROJECT_COLORS } from '@shared/contracts/projects';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RENDERER = 'src/renderer/src';
const TOKENS = `${RENDERER}/styles/tokens.css`;

interface Rule {
  /** The selector list, or the at-rule for one without selectors (`@font-face`). */
  readonly selector: string;
  /** Enclosing block at-rules, outermost first, e.g. `@media (prefers-reduced-motion: reduce)`. */
  readonly context: readonly string[];
  readonly declarations: readonly (readonly [property: string, value: string])[];
}

/** Enough CSS for these stylesheets: rules, @media/@supports nesting, @font-face. No CSS nesting. */
function parse(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let at = 0;
  const block = (context: readonly string[]): void => {
    let prelude = '';
    while (at < text.length) {
      const char = text[at++];
      if (char === '}') return;
      if (char === ';') { prelude = ''; continue; }
      if (char !== '{') { prelude += char; continue; }
      const head = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      // A keyframes block nests its frames as a media block nests rules: read whole, its frames in its context.
      if (/^@(media|supports|layer|container|keyframes)\b/.test(head)) { block([...context, head]); continue; }
      const end = text.indexOf('}', at);
      const body = text.slice(at, end);
      at = end + 1;
      rules.push({
        selector: head,
        context,
        declarations: body.split(';').map((line) => line.trim()).filter(Boolean).map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim().replace(/\s+/g, ' ')] as const;
        }),
      });
    }
  };
  block([]);
  return rules;
}

const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');
const selectors = (rule: Rule): string[] => rule.selector.split(',').map((part) => part.trim().replace(/"/g, "'"));

function cssFiles(directory = RENDERER): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return cssFiles(relative);
    return entry.name.endsWith('.css') ? [relative] : [];
  });
}

const tokens = parse(read(TOKENS));
const themeRule = (theme: string): Rule => {
  const found = tokens.find((rule) => rule.context.length === 0 && selectors(rule).includes(`:root[data-theme='${theme}']`));
  if (found === undefined) throw new Error(`tokens.css has no rule for the ${theme} theme`);
  return found;
};
const colorTokens = (rule: Rule): Map<string, string> => new Map(rule.declarations.filter(([name]) => name.startsWith('--color-')));
const plainRoot = tokens.filter((rule) => rule.context.length === 0 && rule.selector === ':root');
/** A measure token on the plain root, in px. */
const tokenPx = (name: string): number => Number.parseInt(plainRoot.flatMap((rule) => rule.declarations).find(([token]) => token === name)?.[1] ?? 'NaN', 10);

// ── V1: the themes ──────────────────────────────────────────────────────────────────────────
describe('the two themes (V1)', () => {
  it('define the same colour tokens', () => {
    const light = [...colorTokens(themeRule('light')).keys()].sort();
    const dark = [...colorTokens(themeRule('dark')).keys()].sort();
    expect(light.length).toBeGreaterThan(0);
    expect(dark).toEqual(light);
  });

  it('are the only place colours are defined: the plain :root carries none', () => {
    for (const rule of plainRoot) expect([...colorTokens(rule).keys()]).toEqual([]);
  });

  it('make a page without the attribute light', () => {
    expect(selectors(themeRule('light'))).toContain(':root');
  });

  it.each(THEMES)('set color-scheme to %s in the %s theme', (theme) => {
    expect(themeRule(theme).declarations).toContainEqual(['color-scheme', theme]);
  });

  it.each(THEMES)('paint the page in the colours the OS paints around it (%s)', (theme) => {
    const colors = colorTokens(themeRule(theme));
    expect(colors.get('--color-chrome')).toBe(NATIVE_COLORS[theme].background);
    expect(colors.get('--color-text')).toBe(NATIVE_COLORS[theme].symbol);
  });

  // Every token the UI puts text in, on every background it puts text on (C4).
  const TEXT = ['--color-text', '--color-text-muted', '--color-focus', '--color-field-focus', '--color-ok', '--color-warn', '--color-critical'];
  // M100 (C1): the grey ground the Main window's body is, which some text stands on directly.
  const BACKGROUNDS = ['--color-bg', '--color-surface', '--color-ground', '--color-composer', '--color-popup', '--color-chrome'];
  // Text that has a background of its own: `--color-on-x` is only ever put on `--color-x` (M14, C53).
  // M100 (C2, C6): a project header's text on its bar, the hidden-projects row's on its quiet bar. Done's white word is below, by name (C72).
  // M100b (C10, C63): a question card's picked row holds the text colour. Its Decline's white word is below, by name, as Done's is (C53).
  // M22e (C7, C21, C28): a review's tier headers, and its rows under the pointer, accepted and refused, hold the text colour.
  // Decision 0029 (the maintainer): what a chat of a plan held elsewhere waits on, in the waiting pair.
  // A plan's decision panel (the maintainer): Execute's and Leave's words on their grounds, Discard's glyph on its red.
  const PAIRS = [['--color-on-attention', '--color-attention'], ['--color-on-waiting', '--color-waiting'], ['--color-on-bar', '--color-bar'], ['--color-text', '--color-bar-quiet'], ['--color-text', '--color-picked'], ['--color-on-submit-hover', '--color-submit-hover'], ['--color-text', '--color-field'],
    ['--color-on-tooltip', '--color-tooltip'], ['--color-tooltip-muted', '--color-tooltip'], ['--color-on-flag', '--color-flag'],
    ['--color-project-disclosure', '--color-ground'],
    ['--color-text', '--color-tier-1'], ['--color-text', '--color-tier-2'], ['--color-text', '--color-tier-3'], ['--color-text', '--color-tier-4'], ['--color-text', '--color-tier-5'], ['--color-text', '--color-review-hover'], ['--color-text', '--color-review-accepted'],
    ['--color-text-muted', '--color-review-hover'], ['--color-text-muted', '--color-review-accepted'], ['--color-text', '--color-review-refused'], ['--color-text-muted', '--color-review-refused'],
    ['--color-text', '--color-plan-execute'], ['--color-text', '--color-plan-leave'], ['--color-text', '--color-plan-leave-hover'], ['--color-on-plan-discard', '--color-plan-discard'], ['--color-on-plan-discard', '--color-plan-discard-hover']] as const;
  // The contrast test's one named exception (M14, C53; amends M11, C4): an acknowledged attention
  // should look switched off, and low contrast is how. Its words stay in the capsule's accessible name.
  const BELOW_ON_PURPOSE = [['--color-on-acknowledged', '--color-acknowledged']] as const;
  describe.each(THEMES)('contrast, %s theme', (theme) => {
    const colors = colorTokens(themeRule(theme));
    it.each(['--color-bg', '--color-surface', '--color-composer'])('control boundaries on %s reach 3:1', (background) => {
      expect(contrast(hex(colors.get('--color-rule')), hex(colors.get(background)))).toBeGreaterThanOrEqual(3);
    });
    it.each(TEXT.flatMap((text) => BACKGROUNDS.map((background) => [text, background] as const)))('%s on %s reaches 4.5:1', (text, background) => {
      expect(contrast(hex(colors.get(text)), hex(colors.get(background)))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(PAIRS)('%s on %s reaches 4.5:1', (text, background) => {
      expect(contrast(hex(colors.get(text)), hex(colors.get(background)))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(BELOW_ON_PURPOSE)('%s on %s stays below 4.5:1, on purpose', (text, background) => {
      const ratio = contrast(hex(colors.get(text)), hex(colors.get(background)));
      expect(ratio).toBeLessThan(4.5);
      // Dim, not gone: still told apart from its background.
      expect(ratio).toBeGreaterThan(1.5);
    });
  });

  it('puts black text on the attention colour, a bright yellow, in both themes (M14, C53)', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      expect(colors.get('--color-on-attention')).toBe('#000000');
      expect(colors.get('--color-attention')).toBe('#ffd60a');
    }
  });

  it('puts black text on the waiting colour, an orange apart from the attention yellow, in both themes (decision 0029)', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      expect(colors.get('--color-on-waiting')).toBe('#000000');
      expect(colors.get('--color-waiting')).not.toBe(colors.get('--color-attention'));
    }
  });

  // M100 (C1, C2, V1): the grid's line and a project header's pair, in both themes.
  // M100's review: the layout reference's colours — a grey ground with a faint grid and a stronger line
  // every fifth cell, the header's slate, the quiet bar, Done's mint with its green edge.
  it('define the ground, the grid’s lines, the bar pairs and Done’s colours in both themes, the light from the layout reference', () => {
    const NAMES = ['--color-ground', '--color-grid', '--color-grid-major', '--color-bar', '--color-on-bar', '--color-bar-quiet', '--color-done', '--color-on-done', '--color-done-rule'];
    for (const theme of THEMES) for (const name of NAMES) expect(colorTokens(themeRule(theme)).has(name), `${theme} ${name}`).toBe(true);
    const light = colorTokens(themeRule('light'));
    expect(NAMES.map((name) => light.get(name))).toEqual(['#ededed', '#dfdfdf', '#d0d0d0', '#303740', '#ffffff', '#ced4db', '#c3f7c8', '#ffffff', '#55c45f']);
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      // The ground is told from the panels; the grid is faint on the ground, its fifth line a little less.
      expect(contrast(hex(colors.get('--color-ground')), hex(colors.get('--color-bg'))), theme).toBeGreaterThan(1.1);
      expect(contrast(hex(colors.get('--color-grid')), hex(colors.get('--color-ground'))), theme).toBeLessThan(1.3);
      expect(contrast(hex(colors.get('--color-grid-major')), hex(colors.get('--color-ground'))), theme).toBeGreaterThan(contrast(hex(colors.get('--color-grid')), hex(colors.get('--color-ground'))));
    }
  });

  // M100 (C72): Done's word is white in both themes, as the reference draws it — below 4.5:1 on the light mint on purpose; the button's name is the word.
  it('write Done’s word in white, on purpose below 4.5:1 on the light theme’s mint and above it on the dark green', () => {
    for (const theme of THEMES) expect(colorTokens(themeRule(theme)).get('--color-on-done'), theme).toBe('#ffffff');
    const light = colorTokens(themeRule('light'));
    expect(contrast(hex(light.get('--color-on-done')), hex(light.get('--color-done')))).toBeLessThan(4.5);
    const dark = colorTokens(themeRule('dark'));
    expect(contrast(hex(dark.get('--color-on-done')), hex(dark.get('--color-done')))).toBeGreaterThanOrEqual(4.5);
  });

  // A corner toggle that is not set, under the pointer, on the gray Cancel had (M26, round 2), its word
  // in the text colour — which, unlike white, reads against that gray in both themes.
  it('gives an unset corner toggle a gray ground under the pointer in both themes, with the text colour readable on it', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      expect(colors.has('--color-shelve'), theme).toBe(true);
      expect(contrast(hex(colors.get('--color-text')), hex(colors.get('--color-shelve'))), theme).toBeGreaterThanOrEqual(4.5);
      // Told from Done's ground, and from the box it stands on.
      expect(colors.get('--color-shelve')).not.toBe(colors.get('--color-done'));
      expect(contrast(hex(colors.get('--color-shelve')), hex(colors.get('--color-bg'))), theme).toBeGreaterThan(1.1);
    }
  });

  // M100b (C10, C53, C57, C58, C62, C63, V7): the question card's seven, in both themes; the picked row from Done's mint and its edge.
  it('define a question card’s picked row and its Decline in both themes, the picked row from Done’s colours', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      for (const name of ['--color-picked', '--color-picked-rule', '--color-decline-soft', '--color-on-decline-soft', '--color-decline-rule', '--color-decline', '--color-on-decline', '--color-disabled', '--color-on-disabled', '--color-disabled-rule']) expect(colors.has(name), `${theme} ${name}`).toBe(true);
      expect([colors.get('--color-picked'), colors.get('--color-picked-rule')], theme).toEqual([colors.get('--color-done'), colors.get('--color-done-rule')]);
      // Told from the box it stands on.
      expect(contrast(hex(colors.get('--color-picked')), hex(colors.get('--color-bg'))), theme).toBeGreaterThan(1.1);
      // Decline at rest is lighter than under the pointer, where it has Submit's weight.
      expect(contrast(hex(colors.get('--color-decline-soft')), hex(colors.get('--color-bg'))), theme).toBeLessThan(contrast(hex(colors.get('--color-decline')), hex(colors.get('--color-bg'))));
    }
  });

  // M100b (C53): Decline's word is white in both themes, at rest and under the pointer, as Done's is — below 4.5:1 on the light theme on purpose.
  it('write Decline’s word in white, as Done’s, at rest and under the pointer: below 4.5:1 on the light theme on purpose, above it on the dark', () => {
    for (const theme of THEMES) for (const name of ['--color-on-decline', '--color-on-decline-soft']) expect(colorTokens(themeRule(theme)).get(name), `${theme} ${name}`).toBe('#ffffff');
    const light = colorTokens(themeRule('light'));
    const dark = colorTokens(themeRule('dark'));
    for (const [text, ground] of [['--color-on-decline-soft', '--color-decline-soft'], ['--color-on-decline', '--color-decline']] as const) {
      expect(contrast(hex(light.get(text)), hex(light.get(ground))), text).toBeLessThan(4.5);
      expect(contrast(hex(dark.get(text)), hex(dark.get(ground))), text).toBeGreaterThanOrEqual(4.5);
    }
    // The word still shows at rest, and plainly more under the pointer.
    expect(contrast(hex(light.get('--color-on-decline-soft')), hex(light.get('--color-decline-soft')))).toBeGreaterThan(1.3);
    expect(contrast(hex(light.get('--color-on-decline')), hex(light.get('--color-decline')))).toBeGreaterThan(contrast(hex(light.get('--color-on-decline-soft')), hex(light.get('--color-decline-soft'))) + 0.8);
  });

  // M100b (C58): an unavailable Submit is lighter than Shelve's grey, its word dim on purpose, as a control that takes no press may be.
  it('draw an unavailable Submit lighter than Shelve’s grey, in both themes', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      expect(contrast(hex(colors.get('--color-disabled')), hex(colors.get('--color-bg'))), theme).toBeLessThan(contrast(hex(colors.get('--color-shelve')), hex(colors.get('--color-bg'))));
      expect(contrast(hex(colors.get('--color-on-disabled')), hex(colors.get('--color-disabled'))), theme).toBeLessThan(4.5);
      expect(contrast(hex(colors.get('--color-on-disabled')), hex(colors.get('--color-disabled'))), theme).toBeGreaterThan(1.3);
    }
  });

  it('mirrors the acknowledged pair: white on light grey in the light theme, black on dark grey in the dark', () => {
    expect(colorTokens(themeRule('light')).get('--color-on-acknowledged')).toBe('#ffffff');
    expect(colorTokens(themeRule('dark')).get('--color-on-acknowledged')).toBe('#000000');
  });

  it('has exactly one exception: every other `--color-on-` token is checked on its own background', () => {
    const paired = new Set([...PAIRS, ...BELOW_ON_PURPOSE].map(([text]) => text as string));
    // White on the project colours is V7's, below; the mark on a provider's bar colour is decoration,
    // drawn on a colour the provider's module supplies.
    // Done's word is white on purpose, checked above by name (M100, C72), and so are Decline's (M100b, C53); an unavailable Submit's is dim on purpose (C58).
    const elsewhere = new Set(['--color-on-project', '--color-on-avatar', '--color-on-done', '--color-on-decline', '--color-on-decline-soft', '--color-on-disabled']);
    for (const [text] of PAIRS) paired.add(text);
    for (const theme of THEMES) {
      const on = [...colorTokens(themeRule(theme)).keys()].filter((name) => name.startsWith('--color-on-'));
      expect(on.filter((name) => !paired.has(name) && !elsewhere.has(name))).toEqual([]);
    }
    expect(BELOW_ON_PURPOSE).toHaveLength(1);
  });
});

function hex(value: string | undefined): string {
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`not a #rrggbb colour: ${String(value)}`);
  return value;
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (color: string): number => {
    const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((index) => {
      const channel = parseInt(color.slice(index, index + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter = 0, darker = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── V7: the project colours (M12, C18, C19) ─────────────────────────────────────────────────
describe('the project colours (V7)', () => {
  // `--project-<id>`, each id one word: the layout's `--project-column-width` is not a colour.
  const COLOR_TOKEN = /^--project-[a-z]+$/;
  const declared = plainRoot.flatMap((rule) => rule.declarations).filter(([name]) => COLOR_TOKEN.test(name));

  it('are exactly the eight PROJECT_COLORS, declared once on the plain :root', () => {
    expect(declared.map(([name]) => name)).toEqual(PROJECT_COLORS.map((color) => `--project-${color}`));
    for (const theme of THEMES) expect(themeRule(theme).declarations.filter(([name]) => name.startsWith('--project-'))).toEqual([]);
  });

  it('put white text on them in both themes', () => {
    for (const theme of THEMES) expect(colorTokens(themeRule(theme)).get('--color-on-project')).toBe('#ffffff');
  });

  it.each(PROJECT_COLORS)('%s reaches 4.5:1 under that text', (color) => {
    const value = declared.find(([name]) => name === `--project-${color}`)?.[1];
    expect(contrast(hex(value), '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the contrast function', () => {
  it('knows black on white is 21:1 and a colour on itself 1:1', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#595959', '#595959')).toBe(1);
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

// ── V8: colours, sizes and fonts come from the tokens ────────────────────────────────────────
/**
 * Custom properties a component sets inline rather than a stylesheet (grep for them before adding one):
 * a provider's bar colour and its status-bar stream — the lit ground and the six tones, both from its
 * module's descriptor (StatusBar.tsx) — and the shares of the session window's two boxes, which the gap
 * between them writes (M100, round 8; C80).
 */
const STREAM_PROPERTIES = ['--stream-ground', '--stream-1', '--stream-2', '--stream-3', '--stream-4', '--stream-5', '--stream-6', '--stream-glow', '--stream-fill'];
/** The avatar overlay's look, which main resolved and checked: its size, three colours, a shade's strength and a glow's (decision 0032). */
const OVERLAY_PROPERTIES = ['--overlay-size', '--overlay-text', '--overlay-effect', '--overlay-effect-opacity', '--overlay-backdrop', '--overlay-strength', '--overlay-glow'];
/**
 * The effort marks' look, which main resolved and checked: a mark's size, the gap between two, three colours,
 * a shade's strength and a glow's; and on the version text, the room the marks take on the edge they share,
 * and the fast bolt's in the place they share (decision 0032).
 */
const EFFORT_PROPERTIES = ['--effort-size', '--effort-gap', '--effort-color', '--effort-effect', '--effort-effect-opacity', '--effort-glow', '--effort-backdrop', '--effort-strength', '--effort-room', '--fast-room'];
/** The context tooltip's bars (decision 0033): each row's share of its section's largest, from 0 to 1. */
const CONTEXT_PROPERTIES = ['--context-share'];
/** The Pet's rows (decision 0010): the heights main sizes its window by, from one shared geometry (src/shared/contracts/pet.ts). */
const PET_PROPERTIES = ['--pet-bar', '--pet-project', '--pet-row', '--pet-avatar', '--pet-empty'];
/** The attention flash's timing, set on the root from Settings → Appearance (ThemeRoot.tsx): one flash, how many, and the whole. */
const FLASH_PROPERTIES = ['--attention-flash-cycle', '--attention-flash-count', '--attention-flash-duration'];
/** The Done flash's timing, set on its covers and slots from DONE_FLASH (leaving.ts): the box's growth, its flicker, then the fade. */
const DONE_FLASH_PROPERTIES = ['--done-grow', '--done-white', '--done-white-fade', '--done-fade'];
// ModelCapsule.tsx and ModelChooser.tsx take the selection frame's colour from the provider's bar.
const INLINE_PROPERTIES = ['--bar-color', '--selection-color', ...STREAM_PROPERTIES, '--chat-share', '--pane-share', '--usage-account-count', '--usage-arrow-space', '--flag-count', ...OVERLAY_PROPERTIES, ...EFFORT_PROPERTIES, ...CONTEXT_PROPERTIES, ...PET_PROPERTIES, ...FLASH_PROPERTIES, ...DONE_FLASH_PROPERTIES];

/** A component may alias a type token, but every definition and fallback must stay on the scale. */
function usesTypeScale(value: string, scale: ReadonlySet<string>, aliases: ReadonlyMap<string, readonly string[]>, seen: ReadonlySet<string> = new Set()): boolean {
  const reference = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/.exec(value);
  const name = reference?.[1];
  if (name === undefined || seen.has(name)) return false;
  const fallback = reference?.[2];
  if (fallback !== undefined && !usesTypeScale(fallback, scale, aliases, seen)) return false;
  if (scale.has(name)) return true;
  const definitions = aliases.get(name);
  const next = new Set([...seen, name]);
  return definitions !== undefined && definitions.length > 0 && definitions.every((setting) => usesTypeScale(setting, scale, aliases, next));
}

const NAMED_COLORS = ['black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver', 'maroon', 'navy', 'teal',
  'olive', 'lime', 'aqua', 'fuchsia', 'cyan', 'magenta', 'brown', 'gold', 'indigo', 'violet', 'crimson', 'coral', 'salmon', 'khaki', 'beige', 'ivory', 'tan',
  'orchid', 'plum', 'turquoise', 'tomato', 'chocolate', 'lavender', 'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'dimgray', 'dimgrey', 'whitesmoke', 'gainsboro'];
const COLOR_LITERAL = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\(|(?<![\\w-])(?:${NAMED_COLORS.join('|')})(?![\\w-])`, 'i');

describe('stylesheets outside tokens.css (V8)', () => {
  const others = cssFiles().filter((file) => file !== TOKENS);
  const declarations = others.flatMap((file) => parse(read(file)).flatMap((rule) => rule.declarations.map(([property, value]) => ({ file, selector: rule.selector, property, value }))));

  it('exist, and are all checked', () => {
    expect(others).toEqual(expect.arrayContaining([`${RENDERER}/styles/global.css`, `${RENDERER}/styles/fonts.css`]));
    expect(declarations.length).toBeGreaterThan(50);
  });

  it('write no colour', () => {
    expect(declarations.filter(({ value }) => COLOR_LITERAL.test(value)).map(({ file, selector, property, value }) => `${file} ${selector} { ${property}: ${value} }`)).toEqual([]);
  });

  it('size text only from the type scale', () => {
    const scale = new Set(tokens.flatMap((rule) => rule.declarations.map(([name]) => name)).filter((name) => /^--text-\d+$/.test(name)));
    const aliases = new Map<string, string[]>();
    for (const { property, value } of declarations) {
      if (!property.startsWith('--')) continue;
      const definitions = aliases.get(property) ?? [];
      definitions.push(value);
      aliases.set(property, definitions);
    }
    // Two named exceptions. The avatar overlay's text is a percentage of its square, set from the size
    // main resolved, so that one rule fits the 60, 152 and 176 px squares (decision 0032). The new-chat
    // heading's subtitle, stacked under a title too long for one line, keeps its proportion to the
    // title's own fitted size (the maintainer).
    const EXCEPTIONS = [
      [`${RENDERER}/sessions/Sessions.module.css`, '.overlayText', 'calc(var(--overlay-size) * 1cqw)'],
      [`${RENDERER}/new-session/NewChat.module.css`, '.heading[data-stacked] .subtitle', 'calc(var(--text-120) * 0.65)'],
    ];
    const excepted = (file: string, selector: string, value: string): boolean => EXCEPTIONS.some(([at, rule, setting]) => file === at && selector === rule && value === setting);
    const bad = declarations.filter(({ file, selector, property, value }) => {
      if (property === 'font') return value !== 'inherit';
      if (property !== 'font-size' || excepted(file, selector, value)) return false;
      return value !== 'inherit' && !usesTypeScale(value, scale, aliases);
    });
    expect(bad.map(({ file, selector, property, value }) => `${file} ${selector} { ${property}: ${value} }`)).toEqual([]);
  });

  it('checks every font size alias definition and fallback, refusing missing tokens and cycles', () => {
    const scale = new Set(['--text-14', '--text-16']);
    const aliases = new Map([
      ['--name-size', ['var(--text-14)', 'var(--text-16)']],
      ['--heading-size', ['var(--name-size, var(--text-14))']],
      ['--raw-size', ['15px']],
      ['--mixed-size', ['var(--text-14)', '15px']],
      ['--cycle-a', ['var(--cycle-b)']],
      ['--cycle-b', ['var(--cycle-a)']],
    ]);
    for (const value of ['var(--text-14)', 'var(--name-size)', 'var(--heading-size, var(--text-16))']) expect(usesTypeScale(value, scale, aliases), value).toBe(true);
    for (const value of ['15px', 'var(--text-15)', 'var(--missing, var(--text-14))', 'var(--name-size, 15px)', 'var(--raw-size)', 'var(--mixed-size)', 'var(--cycle-a)']) expect(usesTypeScale(value, scale, aliases), value).toBe(false);
  });

  it('use only tokens that exist', () => {
    const defined = new Set([...tokens, ...others.flatMap((file) => parse(read(file)))].flatMap((rule) => rule.declarations.map(([name]) => name)).filter((name) => name.startsWith('--')));
    // Set from a component's inline style, from data main supplies (a provider's bar colour).
    for (const inline of INLINE_PROPERTIES) defined.add(inline);
    const used = declarations.flatMap(({ file, value }) => [...value.matchAll(/var\((--[\w-]+)/g)].map((match) => ({ file, name: match[1] ?? '' })));
    expect(used.filter(({ name }) => !defined.has(name)).map(({ file, name }) => `${file}: ${name}`)).toEqual([]);
  });

  it('the colour check catches what it should, and only that', () => {
    for (const value of ['#fff', '#A1B2C3', 'rgb(0 0 0)', 'rgba(0,0,0,.5)', 'hsl(0 0% 0%)', '1px solid black', 'White']) expect(COLOR_LITERAL.test(value)).toBe(true);
    for (const value of ['var(--color-text)', 'transparent', 'currentColor', 'nowrap', 'var(--color-bg-white)', 'inherit', "url('/fonts/x.woff2')"]) expect(COLOR_LITERAL.test(value)).toBe(false);
  });
});

describe('the type scale (C21)', () => {
  it('keeps body text at 14, question numerals at 36 and the new-chat heading pair at 120/60', () => {
    const scale = plainRoot.flatMap((rule) => rule.declarations).filter(([name]) => /^--text-\d+$/.test(name));
    expect(scale.map(([name, value]) => `${name}: ${value}`)).toEqual(['10', '11', '12', '13', '14', '16', '20', '24', '28', '32', '36', '60', '120'].map((size) => `--text-${size}: ${size}px`));
    expect(parse(read(`${RENDERER}/styles/global.css`)).find((rule) => rule.selector === 'body')?.declarations).toContainEqual(['font-size', 'var(--text-14)']);
  });
});

describe('the fonts (C17, C18)', () => {
  const token = (name: string): string => plainRoot.flatMap((rule) => rule.declarations).find(([property]) => property === name)?.[1] ?? '';

  it('put Inter first in the UI stack, ending in the OS sans-serif', () => {
    expect(token('--font-ui')).toMatch(/^'Inter', /);
    expect(token('--font-ui')).toMatch(/sans-serif$/);
  });

  it('keep the system monospace stack, naming no packaged font', () => {
    expect(token('--font-mono')).not.toMatch(/inter/i);
    expect(token('--font-mono')).toMatch(/monospace$/);
  });

  it('declare four weights of Inter, from local files only', () => {
    const faces = parse(read(`${RENDERER}/styles/fonts.css`)).filter((rule) => rule.selector === '@font-face');
    const value = (face: Rule, name: string) => face.declarations.find(([property]) => property === name)?.[1];
    expect(faces.map((face) => value(face, 'font-weight'))).toEqual(['400', '500', '600', '700']);
    for (const face of faces) {
      expect(value(face, 'font-family')).toBe("'Inter'");
      expect(value(face, 'font-display')).toBe('block');
      expect(value(face, 'src')).toMatch(/^url\('\/fonts\/inter\/Inter-(Regular|Medium|SemiBold|Bold)\.woff2'\) format\('woff2'\)$/);
    }
  });
});

// The scrollbars (the maintainer): thin, and shown only where the pointer is. They are
// global.css's alone — jsdom draws no scrollbar — so they are proven here or nowhere. What a run in
// the app's own Chromium measured, and why the standard pair rather than the `-webkit-` parts, is
// written where the rules are.
describe('the scrollbars', () => {
  const globalStyles = parse(read(`${RENDERER}/styles/global.css`));
  const rule = (selector: string): Rule => {
    const found = globalStyles.find((candidate) => selectors(candidate).includes(selector) && candidate.declarations.some(([name]) => name.startsWith('scrollbar-')));
    if (found === undefined) throw new Error(`global.css has no scrollbar rule for ${selector}`);
    return found;
  };

  it('are thin, with nothing drawn at rest, on every element rather than inherited from the root', () => {
    expect(rule('*').declarations).toEqual([['scrollbar-width', 'thin'], ['scrollbar-color', 'transparent transparent']]);
  });

  it('show the thumb in the dim token, over no track, while the pointer is over what scrolls', () => {
    const hover = rule('*:hover');
    expect(hover.declarations).toEqual([['scrollbar-color', 'var(--color-scrollbar) transparent']]);
    // The two tie on nothing: the resting rule comes first, so the hovered one wins where it applies.
    expect(globalStyles.indexOf(hover)).toBeGreaterThan(globalStyles.indexOf(rule('*')));
  });

  // The fade is the scrolling rules' own, never `*`'s: a transition there starts one on every element
  // the pointer crosses (measured in the real page: 2,499 transitions and 657 ms of style recalc over
  // 80 moves, against 48 ms scoped and 12 ms with no fade). V18: it names --duration-scene, which
  // reduced motion zeroes, so the thumb switches instead; --duration-fast going in was taken for a
  // switch by eye (the maintainer).
  const FADE = 'scrollbar-color var(--duration-scene) linear';
  it('fade the thumb in and out wherever a region scrolls, and only there', () => {
    const scrolling = cssFiles().flatMap((file) => parse(read(file)).map((candidate) => ({ file, ...candidate })))
      // Visible overflow (such as the first-run arrow's SVG) creates no scrolling region.
      .filter((candidate) => candidate.declarations.some(([name, setting]) => /^overflow(-[xy])?$/.test(name) && /^(auto|scroll|overlay)$/.test(setting)));
    // The V20 list below names them one by one; here every one of them carries the fade.
    expect(scrolling.length).toBeGreaterThanOrEqual(16);
    const without = scrolling.filter((candidate) => !candidate.declarations.some(([name, setting]) => name === 'transition' && setting === FADE));
    expect(without.map((candidate) => `${candidate.file} ${candidate.selector}`)).toEqual([]);
    // Nothing that does not scroll fades a scrollbar, and `*` least of all.
    const fading = cssFiles().flatMap((file) => parse(read(file)).map((candidate) => ({ file, ...candidate })))
      .filter((candidate) => candidate.declarations.some(([, setting]) => setting.includes('scrollbar-color') && setting.includes('--duration')));
    expect(fading.length).toBe(scrolling.length);
    expect(globalStyles.filter((candidate) => candidate.declarations.some(([name]) => name === 'transition'))).toEqual([]);
  });

  it('set a faint thumb colour, no louder than a soft rule, in both themes', () => {
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      const faint = contrast(hex(colors.get('--color-scrollbar')), hex(colors.get('--color-bg')));
      // Told from the box it scrolls in, and no louder than that box's soft rule (the maintainer: less visible).
      expect(faint, theme).toBeGreaterThan(1.1);
      expect(faint, theme).toBeLessThanOrEqual(contrast(hex(colors.get('--color-rule-soft')), hex(colors.get('--color-bg'))));
    }
    // Chromium derives the shade under the pointer and in a drag from this one: there is no second token.
    for (const theme of THEMES) expect([...colorTokens(themeRule(theme)).keys()].filter((name) => name.startsWith('--color-scrollbar'))).toEqual(['--color-scrollbar']);
  });

  it('are styled in global.css alone, and never through the -webkit- parts, which the standard pair switches off', () => {
    const every = cssFiles().flatMap((file) => parse(read(file)).map((candidate) => ({ file, ...candidate })));
    const standard = every.filter((candidate) => candidate.declarations.some(([name]) => name === 'scrollbar-width' || name === 'scrollbar-color'));
    expect(standard.map((candidate) => `${candidate.file} ${candidate.selector}`)).toEqual([`${RENDERER}/styles/global.css *`, `${RENDERER}/styles/global.css *:hover`]);
    expect(every.filter((candidate) => candidate.selector.includes('-webkit-scrollbar')).map((candidate) => candidate.selector)).toEqual([]);
  });
});

// ── V20: scrolling, selection and order in the shell ────────────────────────────────────────
describe('the shell’s styles (V20)', () => {
  const SHELL = `${RENDERER}/shell/Shell.module.css`;
  const SESSIONS = `${RENDERER}/sessions/Sessions.module.css`;
  const SESSION_AREA = `${RENDERER}/session-area/SessionArea.module.css`;
  const MODEL_PICKER = `${RENDERER}/new-session/ModelPicker.module.css`;
  // The model chooser and its capsules, shared by the new-chat screen and the picker.
  const CHOOSER = `${RENDERER}/model-chooser/ModelChooser.module.css`;
  const CAPSULES = `${RENDERER}/model-chooser/Capsules.module.css`;
  const NEW_CHAT = `${RENDERER}/new-session/NewChat.module.css`;
  const CHAT = `${RENDERER}/chat/Chat.module.css`;
  // The composer's parts (M23): its command menu over the input scrolls past its height (C58, C65).
  const COMPOSER = `${RENDERER}/chat/composer/Composer.module.css`;
  // The artifact pane and its one kind's tab (M19b, C13): named one by one, so their order is the same on every system.
  const ARTIFACTS = `${RENDERER}/artifacts/ArtifactPane.module.css`;
  const FILE = `${RENDERER}/artifacts/file/File.module.css`;
  // A worker's tab of its own retired with M106 (C4): its thread is the Sub-agents tab's.
  const ASIDE = `${RENDERER}/artifacts/aside/Aside.module.css`;
  const AGENTS = `${RENDERER}/artifacts/agents/Agents.module.css`;
  const PLAN = `${RENDERER}/artifacts/plan/Plan.module.css`;
  // An image's tab (M23, C27): at its actual size, the tab scrolls.
  const IMAGE = `${RENDERER}/artifacts/image/Image.module.css`;
  // The recent sessions switcher (M100, C93), portalled over the window: its rows scroll past the window's height.
  const SWITCHER = `${RENDERER}/sessions/SessionSwitcher.module.css`;
  // The project list lives in the column (M12, C51); its dialog's frame is ui/Dialog.module.css. The
  // session list, the session area and the model picker joined the scans with M14 (C56, C64, V34),
  // with the popups and tooltips that are portalled out of the shell.
  const STREAM = `${RENDERER}/ui/status-stream/StatusStream.module.css`;
  const shellStyles = [
    ...cssFiles(`${RENDERER}/shell`), ...cssFiles(`${RENDERER}/control-bar`), ...cssFiles(`${RENDERER}/projects`),
    ...cssFiles(`${RENDERER}/sessions`), ...cssFiles(`${RENDERER}/session-area`), ...cssFiles(`${RENDERER}/new-session`), ...cssFiles(`${RENDERER}/model-chooser`), ...cssFiles(`${RENDERER}/chat`),
    ARTIFACTS, FILE, ASIDE, AGENTS, PLAN, IMAGE, STREAM,
    `${RENDERER}/ui/Popup.module.css`, `${RENDERER}/ui/Tooltip.module.css`,
  ];
  const rulesOf = (file: string) => parse(read(file)).map((rule) => ({ file, ...rule }));
  const shellRules = shellStyles.flatMap(rulesOf);
  const value = (rules: readonly Rule[], selector: string, property: string) =>
    rules.find((rule) => rule.selector === selector)?.declarations.find(([name]) => name === property)?.[1];

  it('cover the shell, the control bar, the project list, the session list, the session area and the model picker', () => {
    expect(shellStyles).toEqual(expect.arrayContaining([
      SHELL, `${RENDERER}/control-bar/UsageStrip.module.css`, `${RENDERER}/control-bar/UsagePanel.module.css`, `${RENDERER}/projects/Projects.module.css`,
      SESSIONS, SESSION_AREA, MODEL_PICKER, CHOOSER, CAPSULES, CHAT, ARTIFACTS, FILE, ASIDE, AGENTS, PLAN,
    ]));
  });

  // M14 (C93, V11; amends M11, C27): the agent list scrolls inside the avatar column, which does not.
  // M15 (C61, V20): the chat's message list is the third.
  // M19b (C13, V14; amends M11, C27): the artifact pane's rows of tabs, past three, and a file's text.
  // M20a (C37, C50, V13): an activity's group and a worker's tab add none. A worker's items scroll in the
  // chat's own list, drawn in its tab, and an input or an output scrolls sideways as a code block does,
  // by the Markdown stylesheet's rule.
  // M20b (C43, C53, C74; V13): an aside's tab adds none — its conversation scrolls in the chat's own
  // list, its passage is cut to its lines, and its field is the chat's input. One is added, in the
  // chat: a list of asides by title, which a session may keep many of, scrolls within its menu.
  // M100 (round 8; C76, C78): the agent list leaves the model column for the pane's Sub-agents tab,
  // which scrolls as a whole, the grants under its sub-agents. M106 (C40): a sub-agent's thread unfolds
  // in it, its items scrolling in the chat's own list, drawn in it, within the thread's bound.
  // M100 (round 12, C93): the recent sessions switcher's rows, past the window's height.
  // M22b (C60, C67): a project's list of plans, as a list of asides does, and a plan's text in its tab, as a file's.
  it('let only the project column, the switcher’s rows, the chat’s message list, a list of asides or of plans, the pane’s rows, a file’s or a plan’s text and the Sub-agents tab scroll (C27, C58; M14, C93; M15, C61; M19b, C13; M20b, C53; M100, C78, C93; M22b, C60, C67)', () => {
    const scrolling = shellRules.flatMap((rule) => rule.declarations.filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden')
      .map(([name, setting]) => `${rule.file} ${rule.selector} { ${name}: ${setting} }`));
    expect(scrolling).toEqual([
      `${SHELL} .projectColumn { overflow-y: auto }`, `${SWITCHER} .list { overflow-y: auto }`, `${NEW_CHAT} .screen { overflow: auto }`, `${CHAT} .list { overflow-y: auto }`, `${CHAT} .toolbar { overflow-x: auto }`,
      `${CHAT} .asideMenu { overflow-y: auto }`, `${CHAT} .planList { overflow-y: auto }`,
      // M23 (C47): the queue's rows, past three — ten at the smallest window would push the messages out.
      `${COMPOSER} .queueRows { overflow-y: auto }`,
      // M23 (C58, C65): the command menu's rows, a CLI listing dozens.
      `${COMPOSER} .menu { overflow-y: auto }`,
      `${ARTIFACTS} .rows { overflow-y: auto }`, `${FILE} .text { overflow: auto }`, `${AGENTS} .tab { overflow-y: auto }`, `${PLAN} .text { overflow: auto }`,
      // M23 (C27): an image at its actual size scrolls in its tab, as a file's text does.
      `${IMAGE} .content { overflow: auto }`,
    ]);
    // M100 (C12): the session window, the chat and the pane do not scroll; the message list and the pane's parts inside them do.
    for (const part of ['.sessionWindow', '.chat', '.artifacts']) expect(value(rulesOf(SHELL), part, 'overflow'), part).toBe('hidden');
    expect(rulesOf(SHELL).filter((rule) => rule.selector.includes('modelColumn'))).toEqual([]);
    expect(rulesOf(ASIDE).flatMap((rule) => rule.declarations).filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden')).toEqual([]);
  });

  // M14 (C119, V34): the picker never scrolls — it resizes to fit.
  it('let no part of the model picker or its chooser scroll, and make the picker unselectable', () => {
    const picker = [MODEL_PICKER, CHOOSER, CAPSULES].flatMap(rulesOf);
    expect(picker.flatMap((rule) => rule.declarations.filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden').map(([name]) => `${rule.selector} { ${name} }`))).toEqual([]);
    expect(value(picker, '.popup', 'user-select')).toBe('none');
    // A long name ends in an ellipsis rather than making its column wider (C86); a description wraps to two lines, then ends in one.
    expect(value(picker, '.tile .capsuleText strong', 'text-overflow')).toBe('ellipsis');
    expect(value(picker, '.tile .capsuleText small', '-webkit-line-clamp')).toBe('2');
    expect(value(picker, '.accountName', 'text-overflow')).toBe('ellipsis');
  });

  // The compact footer's status, worker count and timer share the 11 px step of the type scale.
  // Names retain two lines; the compact footer now carries a sentence-case worker count inline.
  it('size a capsule’s status and worker count at 11 px in sentence case, under a name of 14 px on two lines', () => {
    const list = rulesOf(SESSIONS);
    expect(value(list, '.status', 'font-size')).toBe('var(--text-11)');
    expect(value(list, '.workers', 'font-size')).toBe('inherit');
    expect(value(list, '.workers', 'text-transform')).toBeUndefined();
    expect(value(list, '.name', 'font-size')).toBe('var(--text-14)');
    expect(list.find((rule) => rule.selector === '.name')?.declarations).toEqual(expect.arrayContaining([['-webkit-line-clamp', '2'], ['overflow', 'hidden'], ['white-space', 'normal']]));
    // The avatar at the capsule's height, and the body as tall; a completed capsule at half.
    expect(value(list, '.select', 'grid-template-columns')).toBe('var(--capsule-height) minmax(0, 1fr)');
    expect(value(list, '.body', 'height')).toBe('var(--capsule-height)');
    expect(value(list, ".avatar[data-size='capsule']", 'height')).toBe('var(--capsule-height)');
    expect(value(list, ".avatar[data-size='thin']", 'height')).toBe('calc(var(--capsule-height) / 2)');
    expect(value(list, '.thinSelect', 'height')).toBe('calc(var(--capsule-height) / 2)');
    expect(value(list, ".avatar[data-size='column']", 'width')).toBe('var(--avatar-column-width)');
    // M102 (C32, C34): the art over the whole square of the placeholder, clipped to it, taking no
    // pointer event and no selection, so a press and a drag are the capsule's.
    expect(value(list, '.avatar', 'position')).toBe('relative');
    expect(value(list, '.avatar', 'overflow')).toBe('hidden');
    expect(value(list, '.avatarImage', 'position')).toBe('absolute');
    expect(value(list, '.avatarImage', 'inset')).toBe('0');
    expect(value(list, '.avatarImage', 'object-fit')).toBe('cover');
    expect(value(list, '.avatarImage', 'pointer-events')).toBe('none');
    expect(value(list, '.avatarImage', 'user-select')).toBe('none');
    // The version overlay and the effort marks over the art are as decorative (decision 0032).
    expect(value(list, '.avatarOverlay', 'pointer-events')).toBe('none');
    expect(value(list, '.avatarOverlay', 'user-select')).toBe('none');
    expect(value(list, '.effortMarks', 'pointer-events')).toBe('none');
    expect(value(list, '.effortMarks', 'user-select')).toBe('none');
    // Capsules touch with dark-gray dividers, without a background on their list.
    expect(value(list, '.capsule', 'background')).toBe('var(--color-bg)');
    expect(value(list, '.capsule', 'border-bottom')).toBe('1px solid var(--color-capsule-divider)');
    expect(value(list, '.group', 'row-gap')).toBe('0');
    expect(value(list, '.sessions', 'background')).toBeUndefined();
    // The rows are dim text centred on the grid, with no background and no rule (C27).
    for (const property of ['background', 'border-bottom', 'border-top']) expect(value(list, '.toggleRow, .moreRow, .orphans', property), property).toBeUndefined();
    expect(value(list, '.toggleRow, .moreRow, .orphans', 'justify-content')).toBe('center');
  });

  // The maintainer: a bar that has just turned to an attention flashes the pair inverted,
  // yellow on black — in the Main window's capsules and the Pet's — at the speed and for the time
  // Settings → Appearance sets, six times a second for five seconds unless changed, and holds it still
  // under reduced motion; a seen one never flashes (CapsuleStatus.tsx).
  it('flash a bar that turns to an attention: the pair inverted at the set speed and time, held still under reduced motion', () => {
    const list = rulesOf(SESSIONS);
    const flashing = ".status[data-flash][data-attention]:not([data-acknowledged])";
    const animations = list.filter((rule) => rule.selector === flashing).map((rule) => [rule.context.join(' '), rule.declarations]);
    expect(animations).toEqual([
      ['', [['animation', 'attention-flash var(--attention-flash-cycle, 167ms) step-end var(--attention-flash-count, 18)']]],
      ['@media (prefers-reduced-motion: reduce)', [['animation', 'attention-hold var(--attention-flash-duration, 3s) step-end 1']]],
    ]);
    const frame = (name: string, at: string) => list.find((rule) => rule.context.includes(`@keyframes ${name}`) && rule.selector === at)?.declarations;
    const inverted = [['background', 'var(--color-on-attention)'], ['color', 'var(--color-attention)']];
    expect(frame('attention-flash', '0%')).toEqual(inverted);
    expect(frame('attention-flash', '50%')).toEqual([['background', 'var(--color-attention)'], ['color', 'var(--color-on-attention)']]);
    expect(frame('attention-hold', '0%')).toEqual(inverted);
  });

  it('draw the attention block in the attention pair, and the acknowledged one in the dim pair (M14, C41, C42)', () => {
    const list = rulesOf(SESSIONS);
    expect([value(list, '.status[data-attention]', 'background'), value(list, '.status[data-attention]', 'color')]).toEqual(['var(--color-attention)', 'var(--color-on-attention)']);
    expect([value(list, '.status[data-acknowledged]', 'background'), value(list, '.status[data-acknowledged]', 'color')]).toEqual(['var(--color-acknowledged)', 'var(--color-on-acknowledged)']);
    // Only an acknowledged capsule uses the dim pair during the status-bar display experiment — and a
    // question card's header once nothing waits on it (M100b, C22).
    const users = shellRules.filter((rule) => rule.declarations.some(([, setting]) => /--color-(on-)?acknowledged/.test(setting))).flatMap(selectors);
    expect([...users].sort()).toEqual(['.qHeader', '.status[data-acknowledged]']);
    expect([value(rulesOf(CHAT), '.qHeader', 'background'), value(rulesOf(CHAT), '.qHeader', 'color')]).toEqual(['var(--color-acknowledged)', 'var(--color-on-acknowledged)']);
  });

  // Round 4 (C124, V37): the mark on a provider's bar colour. M100 (C33, C53): a running capsule's
  // block joins it; the effort bar, inverted, leaves it.
  it('draw on a provider’s bar colour in --color-on-avatar, black in both themes, and nowhere else', () => {
    for (const theme of THEMES) expect(colorTokens(themeRule(theme)).get('--color-on-avatar')).toBe('#000000');
    const users = shellRules.filter((rule) => rule.declarations.some(([, setting]) => setting.includes('--color-on-avatar'))).map((rule) => `${rule.file} ${rule.selector}`);
    // A sub-agent's row draws a capsule's footer by composing it (M106, C6), so it adds no rule of its own.
    expect(users).toEqual([`${SESSIONS} .status[data-state='running']`, `${SESSIONS} .avatar`, `${SESSION_AREA} .modelId`]);
    // Each is drawn on the bar colour itself.
    expect(value(rulesOf(SESSIONS), '.avatar', 'background')).toBe('var(--bar-color)');
    expect(value(rulesOf(SESSIONS), ".status[data-state='running']", 'background')).toBe('var(--bar-color)');
    expect(value(rulesOf(SESSION_AREA), '.modelId', 'background')).toBe('var(--bar-color, var(--color-text-muted))');
    // The effort bar stays dark in both themes, beneath the provider-coloured model id.
    expect([value(rulesOf(SESSION_AREA), '.effort', 'background'), value(rulesOf(SESSION_AREA), '.effort', 'color')]).toEqual(['var(--color-status-black)', 'var(--color-status-white)']);
    expect(value(rulesOf(SESSION_AREA), '.modelId, .effort', 'text-align')).toBe('center');
    expect(value(rulesOf(SESSION_AREA), '.modelId', 'height')).toBe('18px');
    // No top edge: the column portrait's mortar above is the joint, one 2 px line as on its other sides (the maintainer).
    expect(value(rulesOf(SESSION_AREA), '.modelId', 'box-shadow')).toBe('inset 2px 0 0 var(--color-status-black), inset -2px 0 0 var(--color-status-black), inset 0 -2px 0 var(--color-status-black)');
    expect(value(rulesOf(SESSIONS), ".avatar[data-size='column']::after", 'box-shadow')).toBe('inset 0 0 0 2px var(--color-status-black)');
    expect(value(rulesOf(SESSION_AREA), '.effort .chevron', 'position')).toBe('absolute');
  });

  // M100 (C51, V1): the status bar never changes its height, so the prompt under it never moves.
  it('give the status bar the token’s height, and no state of it another', () => {
    const area = rulesOf(SESSION_AREA);
    expect(value(area, '.statusBar', 'height')).toBe('var(--status-bar-height)');
    expect(value(rulesOf(CHAT), '.area', '--status-bar-height')).toBe('36px');
    // Its lines are drawn over it, out of its flow: a plan ready draws them two pixels (the maintainer) and moves nothing.
    const states = area.filter((rule) => rule.selector.includes('.statusBar[') && !rule.selector.endsWith('::after'));
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states.flatMap((rule) => rule.declarations).filter(([name]) => /height|padding|margin|border|font-size/.test(name))).toEqual([]);
    expect([value(area, '.statusBar::after', 'position'), value(area, ".statusBar[data-attention='plan']::after", 'border-block-width')]).toEqual(['absolute', '2px']);
    // Notifications use black and white; running keeps the black ground under the provider's stream,
    // its word turned black (the maintainer); pending decisions use yellow.
    expect([value(area, '.statusBar', 'background'), value(area, '.statusBar', 'color')]).toEqual(['var(--color-status-black)', 'var(--color-status-white)']);
    expect([value(area, ".statusBar[data-state='running'][data-stream]", 'background'), value(area, ".statusBar[data-state='running'][data-stream]", 'color')]).toEqual([undefined, 'var(--color-status-black)']);
    for (const [file, host] of [[SESSION_AREA, '.statusBar'], [SESSIONS, '.status']] as const) {
      expect(value(rulesOf(file), `${host}[data-state='running'][data-stream]:has([data-status-stream][data-waiting])`, 'color')).toBe('var(--color-status-white)');
      expect(value(rulesOf(file), `${host}[data-state='running'][data-stream]`, 'transition')).toContain('color 1000ms ease-in-out');
    }
    expect([value(rulesOf(STREAM), '.field', 'opacity'), value(rulesOf(STREAM), '.field[data-active]', 'opacity')]).toEqual(['0', '1']);
    expect(value(rulesOf(STREAM), '.surface', 'overflow')).toBe('hidden');
    expect(value(rulesOf(STREAM), '.light', 'mix-blend-mode')).toBe('plus-lighter');
    // Ready, running status and timer share a size and bold weight, on a single line.
    expect(value(area, '.statusText, .statusTime, .statusOne', 'font-size')).toBe('var(--text-24)');
    expect(value(area, '.statusText, .statusTime, .statusOne', 'font-weight')).toBe('var(--weight-bold)');
    expect(value(area, '.statusDetail', 'font-size')).toBeUndefined();
  });

  it('keep pending decisions yellow locally, hiding a departing provider stream immediately', () => {
    const area = rulesOf(SESSION_AREA);
    const selector = ".statusBar:is([data-attention='question'], [data-attention='approval'], [data-attention='plan'], [data-attention='review'])";
    expect([value(area, selector, 'background'), value(area, selector, 'color')]).toEqual(['var(--color-attention)', 'var(--color-on-attention)']);
    expect(value(area, selector, 'transition')).toBe('none');
    expect([value(rulesOf(STREAM), '.field[data-immediate]', 'opacity'), value(rulesOf(STREAM), '.field[data-immediate]', 'transition')]).toEqual(['0', 'none']);
  });

  // Platform colours (decision 0013, amended): each provider's stream is its module's, set
  // inline on the bar, so the tokens keep only the bar's two neutral ends and no stylesheet holds a ramp.
  it('leave provider streams to their modules, sharing neutral stream tokens between chat and capsules', () => {
    for (const theme of THEMES) {
      const names = [...colorTokens(themeRule(theme)).keys()].filter((name) => name.startsWith('--color-status-'));
      expect(names.sort(), theme).toEqual(['--color-status-black', '--color-status-white']);
    }
    const users = shellRules.filter((rule) => rule.declarations.some(([, setting]) => setting.includes('--color-status-'))).map((rule) => `${rule.file} ${rule.selector}`);
    expect(users).toEqual([`${SESSIONS} .status[data-state='running'][data-stream]`, `${SESSIONS} .status[data-state='running'][data-stream]:has([data-status-stream][data-waiting])`, `${SESSIONS} .avatar[data-size='column']::after`, `${SESSION_AREA} .modelId`, `${SESSION_AREA} .effort`, `${SESSION_AREA} .statusBar`, `${SESSION_AREA} .statusBar::after`, `${SESSION_AREA} .statusBar[data-state='running'][data-stream]`, `${SESSION_AREA} .statusBar[data-state='running'][data-stream]:has([data-status-stream][data-waiting])`, `${CAPSULES} .capsule[aria-pressed='true'], .capsule[aria-checked='true']`, `${CHOOSER} .level[aria-checked='true']`, `${CHAT} :global(:root:not([data-theme='dark'])) .area[data-start-screen] .composer`, `${STREAM} .field`]);
    // Every rectangle is drawn in one of the provider's six tones, and all six are used.
    const area = rulesOf(SESSION_AREA);
    // The reduced-motion block repeats the same selectors to still them, and draws no colour there.
    const lights = rulesOf(STREAM).filter((rule) => /^\.light(:nth-child\(\d+\))?$/.test(rule.selector) && rule.declarations.some(([name]) => name === '--light-tone'));
    expect(lights).toHaveLength(12);
    const tones = lights.map((rule) => rule.declarations.find(([name]) => name === '--light-tone')?.[1]);
    expect(tones.filter((tone) => !/^var\(--stream-[1-6]\)$/.test(tone ?? ''))).toEqual([]);
    expect(new Set(tones).size).toBe(6);
    expect(value(rulesOf(STREAM), '.beam', 'background')).toBe('var(--stream-fill, var(--light-tone))');
    expect(value(rulesOf(STREAM), '.beam::before', 'background')).toBe('var(--stream-glow, none) center / 100% 100% no-repeat');
    // A bar whose provider has no stream is never lit: nothing answers to the running state alone.
    expect(area.filter((rule) => rule.selector.includes("[data-state='running']") && !rule.selector.includes('[data-stream]'))).toEqual([]);
    // The stream properties are set inline and nowhere declared, so they are registered as such.
    const declared = new Set(tokens.flatMap((rule) => rule.declarations.map(([name]) => name)));
    for (const name of STREAM_PROPERTIES) {
      expect(declared.has(name), name).toBe(false);
      expect(INLINE_PROPERTIES, name).toContain(name);
    }
  });

  // M100 (C2, C22, C23, V1): the bar pair is a project header's alone, and no project colour is drawn.
  it('use --color-bar for project headers, hovered buttons and lifted copies, with a readable fold arrow on the grid', () => {
    const PROJECTS = `${RENDERER}/projects/Projects.module.css`;
    const users = shellRules.filter((rule) => rule.declarations.some(([, setting]) => /--color-bar(?![\w-])/.test(setting))).map((rule) => `${rule.file} ${rule.selector}`);
    // The arrow sits on the ground, so its ink is independent of the header's fill.
    expect(users).toEqual([`${PROJECTS} .header`, `${PROJECTS} .actions:hover, .actions[aria-expanded='true']`, `${PROJECTS} .lifted`]);
    expect(value(rulesOf(PROJECTS), '.chevron', 'color')).toBe('var(--color-project-disclosure)');
    expect([value(rulesOf(PROJECTS), '.header', 'background'), value(rulesOf(PROJECTS), '.header', 'color')]).toEqual(['var(--color-bar)', 'var(--color-on-bar)']);
    // Project colour tokens have a one-word suffix; --project-column-width is a layout token.
    expect(rulesOf(PROJECTS).filter((rule) => rule.selector.includes('data-color') || rule.declarations.some(([, setting]) => /--project-[a-z]+(?![\w-])/.test(setting)))).toEqual([]);
    // A gap between projects, in place of a rule (C21).
    expect(value(rulesOf(PROJECTS), '.entry + .entry, .group + .hiddenRow, .hiddenRow + .group', 'margin-top')).toBe('var(--gap-grid)');
  });

  // M14b, V11 (C40, C43): an account's label in the control bar.
  it('size an account’s label at 10 px on one line cut with an ellipsis, in no colour of its own (M14b, C40, C43)', () => {
    const BLOCK = `${RENDERER}/control-bar/UsageBlock.module.css`;
    const label = rulesOf(BLOCK).find((rule) => rule.selector === '.accountLabel');
    expect(label?.declarations).toEqual(expect.arrayContaining([
      ['font-size', 'var(--text-10)'],
      ['white-space', 'nowrap'],
      ['overflow', 'hidden'],
      ['text-overflow', 'ellipsis'],
      ['line-height', 'var(--usage-label-height)'],
    ]));
    expect(label?.declarations.some(([name]) => name === 'color' || name === 'background')).toBe(false);
    // Every size and colour of the block's file comes from a token: the checks above cover the file.
    expect(parse(read(BLOCK)).flatMap((rule) => rule.declarations).filter(([name]) => name === 'font-size').every(([, size]) => /^var\(--text-\d+\)$/.test(size))).toBe(true);
  });

  // M100 (C10, C54, V17; replaces M14b's second height): the band is as tall as the usage box, which keeps one height with an account's label or without.
  it('keep the usage box at the token’s height whether or not a block shows a label, and the band row as tall as it', () => {
    expect(value(rulesOf(SHELL), '.usage', 'height')).toBe('var(--usage-box-height)');
    const heights = shellRules.filter((rule) => rule.declarations.some(([name]) => /^(min-|max-)?height$/.test(name)) && /usage/i.test(rule.selector)).map((rule) => rule.selector);
    expect(heights).toEqual(['.usage']);
    expect(value(rulesOf(SHELL), '.body', 'grid-template-rows')).toBe('auto minmax(0, 1fr)');
    expect(shellRules.filter((rule) => rule.selector.includes('data-account-labels'))).toEqual([]);
    const root = plainRoot.flatMap((rule) => rule.declarations).map(([name]) => name);
    for (const gone of ['--control-bar-height', '--control-bar-label-height', '--session-header-height']) expect(root).not.toContain(gone);
    // "Usage remaining" stands outside the box, above its top-right corner, in the body's margin (C17, C73), in bold.
    expect([value(rulesOf(SHELL), '.usageNote', 'position'), value(rulesOf(SHELL), '.usageNote', 'bottom'), value(rulesOf(SHELL), '.usageNote', 'right')]).toEqual(['absolute', 'calc(100% + 2px)', '0']);
    expect([value(rulesOf(SHELL), '.usageNote', 'font-size'), value(rulesOf(SHELL), '.usageNote', 'font-weight')]).toEqual(['var(--text-10)', 'var(--weight-bold)']);
    expect(value(rulesOf(SHELL), '.band', 'padding-top')).toBeUndefined();
    expect(tokenPx('--usage-label-height')).toBeLessThanOrEqual(2 * tokenPx('--grid-cell'));
  });

  // M100 (C3, C51, C54, V1): the measure tokens, on the plain root, at their starting values (C7).
  it('declare the layout’s measure tokens on the plain root, with their starting values', () => {
    const root = plainRoot.flatMap((rule) => rule.declarations);
    expect(root).toEqual(expect.arrayContaining([
      ['--grid-cell', '10px'], ['--gap-grid', '8px'], ['--rule-thick', '4px'], ['--capsule-height', '60px'], ['--chat-content-width', '820px'],
      // The usage box at four fifths (the maintainer), its height the nearest on the grid.
      ['--status-bar-height', '44px'], ['--usage-box-height', '62px'], ['--usage-label-height', '11px'],
      ['--project-column-width', '345px'], ['--avatar-column-width', '176px'],
      // Round 8 (C80): each box's least width beside the other.
      ['--split-chat-min', '400px'], ['--split-pane-min', '300px'],
    ]));
    const marking = new Set(['--capsule-selection-outset', '--capsule-hover-outset']);
    for (const theme of THEMES) expect(themeRule(theme).declarations.filter(([name]) => /^--(grid|gap|rule|capsule|chat|status|usage|split)-/.test(name) && !marking.has(name))).toEqual([]);
  });

  // M100 (C1, V1): the body's grid is gradients from the tokens on the grey ground, no image; the page's own colour and the strip stay plain.
  it('draw the grid on the grey ground of the body under the title strip from gradients of tokens — every cell, and stronger every fifth — and no image', () => {
    const shell = rulesOf(SHELL);
    const image = value(shell, '.body', 'background-image') ?? '';
    expect(image.match(/linear-gradient\(/g)).toHaveLength(4);
    expect(image.match(/var\(--color-grid\)/g)).toHaveLength(2);
    expect(image.match(/var\(--color-grid-major\)/g)).toHaveLength(2);
    expect(image).toContain('transparent');
    expect(value(shell, '.body', 'background-size')).toBe('calc(5 * var(--grid-cell)) calc(5 * var(--grid-cell)), calc(5 * var(--grid-cell)) calc(5 * var(--grid-cell)), var(--grid-cell) var(--grid-cell), var(--grid-cell) var(--grid-cell)');
    expect(value(shell, '.body', 'background-color')).toBe('var(--color-ground)');
    // No stylesheet names an image (S6): the grid is no file.
    const urls = [...shellRules, ...rulesOf(`${RENDERER}/styles/global.css`)].flatMap((rule) => rule.declarations).filter(([, setting]) => setting.includes('url('));
    expect(urls).toEqual([]);
    expect(value(shell, '.titleStrip', 'background-image')).toBeUndefined();
    expect(value(parse(read(`${RENDERER}/styles/global.css`)), 'body', 'background')).toBe('var(--color-chrome)');
    // Only the artifact body is a box: the tabs stand on the grid above it.
    expect([value(shell, '.chatWindow', 'border'), value(shell, '.chatWindow', 'background')]).toEqual(['1px solid var(--color-rule-mid)', 'var(--color-bg)']);
    expect([value(shell, '.artifacts', 'border'), value(shell, '.artifacts', 'background')]).toEqual([undefined, undefined]);
    const artifact = rulesOf(`${RENDERER}/artifacts/ArtifactPane.module.css`);
    expect([value(artifact, '.body', 'border'), value(artifact, '.body', 'background')]).toEqual(['1px solid var(--color-rule-mid)', 'var(--color-bg)']);
    expect([value(artifact, '.body[data-frameless]', 'border'), value(artifact, '.body[data-frameless]', 'background')]).toEqual(['0', 'transparent']);
    const imageTab = rulesOf(`${RENDERER}/artifacts/image/Image.module.css`);
    expect([value(imageTab, '.tab', 'height'), value(imageTab, '.tab', 'padding')]).toEqual(['100%', '0']);
    expect([value(shell, '.addProject', 'border'), value(shell, '.addProject', 'background')]).toEqual(['var(--rule)', 'var(--color-bg)']);
    // With nothing shown the chat window is no box: the grid alone in the cell (the maintainer).
    expect([value(shell, '.chatWindow[data-empty]', 'border-color'), value(shell, '.chatWindow[data-empty]', 'background')]).toEqual(['transparent', 'none']);
    // The usage box's rule is 2 px in the mid rule colour, a token of its own between the soft rule and the muted text (M100 round 10, the maintainer).
    expect([value(shell, '.usage', 'border'), value(shell, '.usage', 'background')]).toEqual(['1px solid var(--color-rule-mid)', 'var(--color-bg)']);
    // The session window holding the two is no box: the grid shows between them.
    expect([value(shell, '.sessionWindow', 'border'), value(shell, '.sessionWindow', 'background')]).toEqual([undefined, undefined]);
    // The elements stand --gap-grid apart, two cells from the outer edges and one from the bottom;
    // the session window's top is on a grid line (C73).
    expect([value(shell, '.body', 'gap'), value(shell, '.body', 'padding')]).toEqual(['var(--gap-grid)', 'calc(2 * var(--grid-cell)) calc(2 * var(--grid-cell)) var(--grid-cell)']);
    expect((2 * tokenPx('--grid-cell') + tokenPx('--usage-box-height') + tokenPx('--gap-grid')) % tokenPx('--grid-cell')).toBe(0);
  });

  it('centre the chat content, with a smaller avatar separated from the prompt and clearance at the bottom', () => {
    const shell = rulesOf(SHELL);
    const chat = rulesOf(CHAT);
    expect(value(shell, '.content', 'width')).toBe('min(100%, var(--chat-content-width))');
    expect(value(shell, '.content', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    // Centred in the room the session's buttons leave at the window's left.
    expect([value(shell, '.chatWindow', 'display'), value(shell, '.chatWindow', 'justify-content'), value(shell, '.content', 'margin-inline')]).toEqual(['flex', 'center', 'auto']);
    // No subgrid and no model area: the list is the content's whole width, over the prompt area.
    expect(shellRules.flatMap((rule) => rule.declarations).filter(([, setting]) => setting === 'subgrid')).toEqual([]);
    expect(value(chat, '.area', 'grid-template-rows')).toBe('minmax(0, 1fr) auto');
    expect([value(chat, '.listCell', 'grid-row'), value(chat, '.promptArea', 'grid-row')]).toEqual(['1', '2']);
    // The smaller avatar width is local to this prompt, with an 8px gap and bottom/right clearance.
    expect(value(chat, '.promptArea', 'grid-template-columns')).toBe('var(--avatar-column-width) minmax(0, 1fr)');
    expect(value(chat, '.promptArea', '--avatar-column-width')).toBe('152px');
    expect(value(chat, '.promptArea', 'column-gap')).toBe('var(--space-2)');
    expect(value(chat, '.promptArea', 'padding')).toBe('0 var(--space-2) var(--space-2) 0');
    expect(value(chat, '.listCell', 'padding-right')).toBe('var(--space-2)');
    expect(value(chat, '.listCell > .listFrame > .list', 'padding-left')).toBe('0');
    expect(value(chat, '.listCell > .listFrame > .list', 'padding-right')).toBe('var(--space-2)');
    expect(value(chat, '.promptArea', 'border-top')).toBeUndefined();
    expect(value(chat, '.promptMain', 'border-top')).toBeUndefined();
    expect(value(chat, '.promptArea', 'border-right')).toBeUndefined();
    // The model block has no ground of its own: the grey column is gone (the maintainer).
    const block = rulesOf(SESSION_AREA).filter((rule) => rule.selector.startsWith('.modelBlock'));
    expect(block.map((rule) => rule.selector)).toEqual(['.modelBlock']);
    expect(block.flatMap((rule) => rule.declarations).filter(([name]) => /^(background|border)/.test(name))).toEqual([]);
    expect(rulesOf(SESSION_AREA).filter((rule) => /\.(panel|avatarBlock|agents?|fold|grants?)\b/.test(rule.selector))).toEqual([]);
  });

  // M100 (round 8; C79, C80): the pane a box of its own beside the chat's, the gap between them the
  // handle that shares the width out, neither box under its least width; chat 60%, pane 40% until moved.
  it('lay the chat window and the pane out as two boxes a gap apart, the gap a handle, each box at its least width or more', () => {
    const shell = rulesOf(SHELL);
    expect(value(shell, '.sessionWindow[data-split]', 'grid-template-columns')).toBe('minmax(var(--split-chat-min), var(--chat-share, 0.6fr)) var(--gap-grid) minmax(var(--split-pane-min), var(--pane-share, 0.4fr))');
    expect(value(shell, '.artifacts', 'border-left')).toBeUndefined();
    expect([value(shell, '.splitHandle', 'cursor'), value(shell, '.splitHandle', 'touch-action')]).toEqual(['col-resize', 'none']);
    expect(value(shell, '.splitHandle:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    // A faint line shows it under the pointer and while it is dragged, and not otherwise.
    expect(value(shell, '.splitHandle::after', 'opacity')).toBe('0');
    expect(shell.find((rule) => rule.selector === '.splitHandle:hover::after, .splitHandle[data-dragging]::after')?.declarations).toEqual([['opacity', '1']]);
  });

  // The maintainer: Done is back inside the chat window, at its top-left corner, in one
  // rule and with no container query — the band's left column holds the names alone, at its top and
  // level with the usage box, so the band no longer grows with Done and the window's top stays put
  // when a session goes. The mode control is a small box (C75).
  // The maintainer: the session's buttons are a column of square icons at the chat window's
  // top left, the window's first child, beside the chat and never over it.
  it('stand Done in a column at the chat window’s left, beside the chat, and the names alone at the band’s top, and keep the mode control small, with no arrow', () => {
    const area = parse(read(SESSION_AREA));
    const done = area.filter((rule) => rule.selector === '.done');
    expect(done.map((rule) => rule.context.join(' '))).toEqual(['']);
    // In the window's row, never over the chat: no absolute place of its own, and it does not shrink.
    expect([value(area, '.done', 'position'), value(area, '.done', 'flex')]).toEqual(['relative', 'none']);
    const shell = rulesOf(SHELL);
    // The band's left column holds the names alone, at its top, never shorter than the usage box.
    expect(value(shell, '.chatWindow', 'display')).toBe('flex');
    expect([value(shell, '.band', 'align-items'), value(shell, '.bandStart', 'justify-content'), value(shell, '.bandStart', 'min-height')]).toEqual(['end', 'flex-start', 'var(--usage-box-height)']);
    // The names are a row of three, the session's name the one that wraps, in its own box after the // (the maintainer),
    // on one baseline and no taller than the usage box, the session's name fitted inside it (the maintainer).
    expect([value(shell, '.names', 'display'), value(shell, '.names', 'align-items'), value(shell, '.names', 'max-height')]).toEqual(['flex', 'baseline', 'var(--usage-box-height)']);
    expect(shell.find((rule) => rule.selector === '.sessionName')?.declarations).toEqual(expect.arrayContaining([['-webkit-line-clamp', '2'], ['overflow', 'hidden'], ['overflow-wrap', 'anywhere']]));
    expect([value(shell, '.projectName', 'white-space'), value(shell, '.projectName', 'text-overflow')]).toEqual(['nowrap', 'ellipsis']);
    expect([value(area, '.railButton', 'width'), value(area, '.railButton', 'height')]).toEqual(['32px', '32px']);
    expect([value(area, '.modeButton', 'min-height'), value(area, '.modeButton', 'padding'), value(area, '.modeButton', 'font-size')]).toEqual(['22px', '0 var(--space-1)', 'var(--text-12)']);
  });

  // The session's buttons (the maintainer): square boxes in a column; Done on the layout
  // reference's mint and Cancel in a question card's Decline colours; a toggle's icon and edge light
  // gray while not set, and once set the whole button inverted, on black, its icon's lines lighter.
  it('draw the session’s buttons as a column of square boxes: Done on mint, Cancel in Decline’s colours, a toggle light gray until it is set, then inverted', () => {
    const area = parse(read(SESSION_AREA));
    const pair = (selector: string) => [value(area, selector, 'background'), value(area, selector, 'color')];
    expect([value(area, '.rail, .railFlags', 'display'), value(area, '.rail, .railFlags', 'flex-direction'), value(area, '.railButton', 'border')]).toEqual(['flex', 'column', 'var(--rule)']);
    expect([value(area, ".railButton[data-done='']", 'background'), value(area, ".railButton[data-done='cancel']", 'background')]).toEqual(['var(--color-done)', 'var(--color-decline-soft)']);
    expect(pair(".railButton[data-done='cancel']:hover")).toEqual(['var(--color-decline)', 'var(--color-on-decline)']);
    // A toggle not set: its icon and edge light gray, the gray ground under the pointer. Set: inverted on black, and so under the pointer too.
    expect([value(area, ".railButton[aria-pressed='false']", 'border-color'), value(area, ".railButton[aria-pressed='false']", 'color')]).toEqual(['var(--color-rule-mid)', 'var(--color-flag-unset)']);
    expect(pair(".railButton[aria-pressed='false']:hover")).toEqual(['var(--color-shelve)', 'var(--color-text-muted)']);
    expect(pair(".railButton[aria-pressed='true'], .railButton[aria-pressed='true']:hover")).toEqual(['var(--color-flag)', 'var(--color-on-flag)']);
    // Smaller than the buttons above them, centred under them, their lines lighter.
    expect([value(area, '.railButton[aria-pressed]', 'width'), value(area, '.railButton[aria-pressed]', 'height'), value(area, '.railFlags', 'align-items'), value(area, '.railButton[aria-pressed] path', 'stroke-width')]).toEqual(['26px', '26px', 'center', '1.75']);
    // A capsule's and its menu's mark: the icon in the ground's colour on a square of the text's.
    const sessions = parse(read(SESSIONS));
    expect([value(sessions, '.flag', 'background'), value(sessions, '.flag', 'color')]).toEqual(['var(--color-flag)', 'var(--color-on-flag)']);
    // In the capsule's menu the check has a column of its own, and the popup's own check is not drawn.
    expect([value(sessions, '.flagCheck', 'width'), value(sessions, "[role='menuitemcheckbox'][data-flag][aria-checked='true']::before", 'content')]).toEqual(['1em', 'none']);
  });

  it('marks selection and rollover on both sides with theme-specific extents', () => {
    const rules = rulesOf(SESSIONS);
    const marking = '.capsule:hover';
    expect(value(rules, marking, 'box-shadow')).toBe('calc(-1 * var(--capsule-hover-outset)) 0 0 0 var(--bar-color, var(--color-text-muted)), var(--capsule-hover-outset) 0 0 0 var(--bar-color, var(--color-text-muted))');
    expect(value(rulesOf(SHELL), '.sessionWindow', 'z-index')).toBe('1');
    expect(value(rules, '.capsule[data-selected]', 'box-shadow')).toBe('calc(-1 * var(--capsule-selection-outset)) 0 0 0 var(--bar-color, var(--color-text-muted)), var(--capsule-selection-outset) 0 0 0 var(--bar-color, var(--color-text-muted))');
    expect(value(rulesOf(SHELL), '.projectColumn', 'padding')).toBe('0 calc(2 * var(--grid-cell))');
    expect(rules.filter((rule) => /\.capsule.*::(before|after)/.test(rule.selector))).toEqual([]);
  });

  it('never let the page itself scroll', () => {
    const root = parse(read(`${RENDERER}/styles/global.css`)).find((rule) => selectors(rule).includes('body'));
    expect(selectors(root ?? { selector: '', context: [], declarations: [] })).toEqual(['html', 'body', '#root']);
    expect(root?.declarations).toContainEqual(['overflow', 'hidden']);
    expect(value(rulesOf(SHELL), '.shell', 'overflow')).toBe('hidden');
  });

  it('make the shell and its usage panel unselectable, and the Settings dialog selectable (C30)', () => {
    expect(value(rulesOf(SHELL), '.shell', 'user-select')).toBe('none');
    // Portaled to the body, outside the shell, so each says so itself — the usage panel, the menus'
    // popup (a project's, a capsule's, the effort and model menus') and the tooltip (M14, C56, C64).
    expect(value(rulesOf(`${RENDERER}/control-bar/UsagePanel.module.css`), '.panel', 'user-select')).toBe('none');
    expect(value(rulesOf(`${RENDERER}/ui/Popup.module.css`), '.popup', 'user-select')).toBe('none');
    expect(value(rulesOf(`${RENDERER}/ui/Tooltip.module.css`), '.tooltip', 'user-select')).toBe('none');
    expect(value(rulesOf(`${RENDERER}/settings/Settings.module.css`), '.dialog', 'user-select')).toBe('text');
    // The project dialog and the confirmations (M12, C37).
    expect(value(rulesOf(`${RENDERER}/ui/Dialog.module.css`), '.dialog', 'user-select')).toBe('text');
    // The Pet relies on the default staying selectable.
    expect(value(parse(read(`${RENDERER}/styles/global.css`)), 'body', 'user-select')).toBe('text');
    // M15 (C60, V20): the chat's messages are selectable; its input row's button is not.
    // M19b (C13, C36, V14; amends M11, C30): so are a shown file's text and the path above it; the pane's buttons are not.
    // M20a (C50): a worker's tab adds none — its items are selectable as the chat's list is, being drawn in it.
    // M20b (C43, V13): an aside's passage is; its conversation is selectable as the chat's list is, being drawn in it.
    // M22b (C26, C60): a plan's text in its tab is, as a file's is; the tab's buttons are not.
    expect(shellRules.filter((rule) => rule.declarations.some(([name, setting]) => name === 'user-select' && setting !== 'none')).map((rule) => `${rule.file} ${rule.selector}`)).toEqual([`${CHAT} .list`, `${FILE} .text`, `${ASIDE} .excerpt`, `${PLAN} .text`]);
    expect(value(rulesOf(CHAT), '.list', 'user-select')).toBe('text');
  });

  // M15 (C59, V20): a message's text is text, its breaks and spaces kept and long words wrapped.
  // Commentary is set apart by nothing (the maintainer's review): what a session reports of
  // its own work reads at the size and in the colour of its answers, since that is what it is. M100
  // round 11 had it a step smaller; the muted colour is still left to what is not the conversation's
  // own words.
  it('keep a message’s breaks and spaces and wrap its long words, and set commentary apart by nothing', () => {
    const chat = rulesOf(CHAT);
    const text = chat.find((rule) => selectors(rule).includes('.text'));
    expect(text?.declarations).toEqual(expect.arrayContaining([['white-space', 'pre-wrap'], ['overflow-wrap', 'anywhere']]));
    // No rule of its own at all, for its text or for its Markdown body: it takes the message's.
    expect(chat.filter((rule) => selectors(rule).some((selector) => selector.includes("data-phase='commentary'")))).toEqual([]);
    // M100 (round 9, C82): who speaks is said once a run — in a message's head, or in a line above a group or a card
    // that begins it — and a head with nothing to show takes no room: its Copy button stands in the message's margin.
    expect(value(chat, '.message', 'position')).toBe('relative');
    expect(value(chat, '.head', 'display')).toBe('flex');
    expect([value(chat, '.head [data-copy]', 'position'), value(chat, '.head [data-copy]', 'top'), value(chat, '.head [data-copy]', 'right')]).toEqual(['absolute', 'calc((var(--space-4) - var(--space-3)) / 2)', '0']);
  });

  // M19 (C34, C35, V12; amends M15, C61): a text drawn as Markdown is in the chat's list, and may be
  // elsewhere (M19b). Of it, a code block and a table scroll, sideways and within themselves; nothing
  // else of a message scrolls, and nothing of it scrolls down.
  it('let only a code block and a table scroll inside a text drawn as Markdown, sideways, and wrap long words elsewhere (M19, C35)', () => {
    const MARKDOWN = `${RENDERER}/markdown/Markdown.module.css`;
    const markdown = rulesOf(MARKDOWN);
    const scrolling = markdown.flatMap((rule) => rule.declarations.filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden').map(([name, setting]) => `${rule.selector} { ${name}: ${setting} }`));
    expect(scrolling).toEqual(['.pre { overflow-x: auto }', '.tableScroll { overflow-x: auto }']);
    expect(value(markdown, '.markdown', 'overflow-wrap')).toBe('anywhere');
    // A code block's own lines are never wrapped: that is what scrolls.
    expect(value(markdown, '.pre', 'white-space')).toBe('pre');
    // A text that could not be read as Markdown is drawn as text was before M19 (C37).
    expect(markdown.find((rule) => rule.selector === '.plain')?.declarations).toEqual(expect.arrayContaining([['white-space', 'pre-wrap'], ['overflow-wrap', 'anywhere']]));
  });

  it('draw code in the monospace font, coloured by nothing it holds, and every part of a Markdown text from the tokens (M19, C34)', () => {
    const markdown = rulesOf(`${RENDERER}/markdown/Markdown.module.css`);
    const mono = markdown.filter((rule) => rule.declarations.some(([name, setting]) => name === 'font-family' && setting === 'var(--font-mono)')).flatMap(selectors);
    expect(mono).toEqual(expect.arrayContaining(['.inlineCode', '.pre', '.language']));
    // Every font is the body's or the monospace token; every size is the type scale's (checked for every stylesheet above).
    expect(markdown.flatMap((rule) => rule.declarations).filter(([name]) => name === 'font-family').every(([, setting]) => setting === 'var(--font-mono)')).toBe(true);
    expect(markdown.flatMap((rule) => rule.declarations).filter(([name]) => name === 'font-size').every(([, size]) => /^var\(--text-\d+\)$/.test(size))).toBe(true);
    // No selector reaches for a language: there is no syntax colouring (S4).
    expect(markdown.map((rule) => rule.selector).filter((selector) => /token|keyword|hljs|prism|language-/.test(selector))).toEqual([]);
  });

  it('keep a Copy button and the control at the list’s foot out of what is selected, and make no other part of the chat selectable (M19, C39)', () => {
    expect(value(rulesOf(`${RENDERER}/ui/CopyButton.module.css`), '.copy', 'user-select')).toBe('none');
    expect(value(rulesOf(CHAT), '.toEnd', 'user-select')).toBe('none');
    // A Markdown text says nothing of selection: it is selectable where it stands, in the chat's list.
    expect(rulesOf(`${RENDERER}/markdown/Markdown.module.css`).flatMap((rule) => rule.declarations).filter(([name]) => name === 'user-select')).toEqual([]);
  });

  it('shares reveal states with timestamp sources, reserving no space and intercepting no input', () => {
    const chat = rulesOf(CHAT);
    const hover = rulesOf(`${RENDERER}/chat/hover-time/HoverTime.module.css`);
    expect(value(chat, '[data-time-source]', 'width')).toBe('0');
    expect(value(chat, '[data-time-source]', 'height')).toBe('0');
    expect(value(chat, '[data-time-source]', '--hover-time-visible')).toBe('0');
    expect(value(chat, '[data-time-source]', 'pointer-events')).toBe('none');
    expect(value(chat, "[data-time-source='message']", 'position')).toBe('absolute');
    const copyReveal = chat.find((rule) => selectors(rule).includes('.message:hover .head [data-copy]'))!;
    const blockReveal = chat.find((rule) => selectors(rule).includes('[data-md-control]:has(+ :hover) .explain[data-explain]'))!;
    expect(selectors(copyReveal)).toContain(".message:not(:has([data-time-source='block'])):hover [data-time-source='message']");
    expect(selectors(blockReveal)).toContain("[data-md-control]:has(+ :hover) [data-time-source='block']");
    expect(value([copyReveal], copyReveal.selector, '--hover-time-visible')).toBe('1');
    expect(value([blockReveal], blockReveal.selector, '--hover-time-visible')).toBe('1');
    expect(value(hover, '.layer', 'position')).toBe('absolute');
    expect(value(hover, '.layer', 'overflow')).toBe('hidden');
    expect(value(hover, '.layer', 'pointer-events')).toBe('none');
    expect(value(hover, '.layer', 'user-select')).toBe('none');
    expect(value(hover, '.label', 'composes')).toBe("time from '../Chat.module.css'");
    expect(value(hover, '.row', 'position')).toBe('absolute');
    expect(value(hover, '.row', 'display')).toBe('flex');
    expect(value(hover, '.row', 'align-items')).toBe('baseline');
    expect(value(hover, '.baseline', 'width')).toBe('0');
    expect(value(hover, '.baseline', 'visibility')).toBe('hidden');
    // A timestamp-only first block cannot drop Copy or introduce its extra top margin.
    expect(chat.filter((rule) => rule.declarations.some(([key]) => key === '--md-first-control-drop')).every((rule) => rule.selector.includes(':has(> :not([data-time-source]))'))).toBe(true);
  });

  // M21 (C37, C39, C47, V11): a question's card is drawn from the tokens as everything is — the scans
  // above read its rules with the rest of the chat's — and it fits the list at any width: nothing of
  // it sets a width, its long words wrap, and its outcome is told by a word and by no colour.
  it('draw a question’s card from the tokens, in no fixed width, its outcome by words and no colour (M21, C47)', () => {
    const chat = rulesOf(CHAT);
    const card = chat.filter((rule) => selectors(rule).some((selector) => /^\.card[A-Z]?/.test(selector) || selector.startsWith('.card ')));
    expect(card.flatMap(selectors)).toEqual(expect.arrayContaining(['.card', '.cardQuestion', '.cardDescription', '.cardField', '.cardSecret', '.cardActions', '.cardOutcome']));
    // No width but the ones that keep it inside its list.
    expect(card.flatMap((rule) => rule.declarations).filter(([name]) => /^(min-|max-)?width$/.test(name)).map(([name, setting]) => `${name}: ${setting}`).sort()).toEqual(['min-width: 0', 'min-width: 0', 'min-width: 0']);
    expect(value(chat, '.card', 'min-width')).toBe('0');
    expect(value(chat, '.qOption', 'overflow-wrap')).toBe('anywhere');
    // A group as a fieldset draws none of its own frame: the card's rule is the one border.
    expect([value(chat, '.cardQuestion', 'border'), value(chat, '.cardQuestion', 'padding')]).toEqual(['0', '0']);
    // An outcome is a word in the text's own colour, set apart by its weight (M11; M14, C52).
    expect(value(chat, '.cardOutcome', 'color')).toBeUndefined();
    expect(value(chat, '.cardOutcome', 'font-weight')).toBe('var(--weight-semibold)');
    expect(chat.filter((rule) => /data-outcome/.test(rule.selector))).toEqual([]);
    // Its buttons are no part of what is selected; its text is the list's, which is selectable.
    expect(value(chat, '.cardActions', 'user-select')).toBe('none');
    expect(card.flatMap((rule) => rule.declarations).filter(([name, setting]) => name === 'user-select' && setting !== 'none')).toEqual([]);
    // A secret's field and the field for something else are the input row's own colours.
    expect([value(chat, '.cardSecret', 'background'), value(chat, '.cardSecret', 'color'), value(chat, '.cardSecret', 'border')]).toEqual(['var(--color-bg)', 'var(--color-text)', 'var(--rule)']);
  });

  // M100b, V7, V14 (C3, C9–C11, C43, C50–C53, C56–C59, C62, C63): the panel's pairs, each from its tokens.
  it('draw a question’s panel in its pairs: the header, a picked row, the fields, the stepper’s buttons, Decline at rest and under the pointer, and Submit before and at the last question', () => {
    const chat = rulesOf(CHAT);
    const pair = (selector: string) => [value(chat, selector, 'background'), value(chat, selector, 'color')];
    expect(pair('.qHeader[data-waiting]')).toEqual(['var(--color-attention)', 'var(--color-on-attention)']);
    expect([value(chat, '.qRow[data-picked]', 'background'), value(chat, '.qRow[data-picked]', 'border-color')]).toEqual(['var(--color-picked)', 'var(--color-picked-rule)']);
    expect(pair('.qDecline')).toEqual(['var(--color-decline-soft)', 'var(--color-question-decline-text)']);
    expect(pair('.qDecline:hover')).toEqual(['var(--color-decline)', 'var(--color-question-decline-text)']);
    expect(pair('.qSubmit')).toEqual(['var(--color-done)', 'var(--color-done-rule)']);
    // Lighter than Shelve's grey until every question has been shown (C58).
    expect([...pair('.qSubmit:disabled'), value(chat, '.qSubmit:disabled', 'border-color')]).toEqual(['var(--color-disabled)', 'var(--color-on-disabled)', 'var(--color-disabled-rule)']);
    expect([pair('.qStep'), pair('.qStep:hover')]).toEqual([['var(--color-bg)', 'var(--color-text)'], ['var(--color-text)', 'var(--color-bg)']]);
    // The stepper draws no bar of its own: it stands in the foot's row (C51).
    // Previous, Next and the places they leave are one width: the boxes never move (C55).
    expect([value(chat, '.qStep, .qStepGap', 'width'), value(chat, '.qStep, .qStepGap', 'padding')]).toEqual(['96px', '0']);
    // Room above the foot's row; "Choose one or more" close over the rows' rule (C56).
    expect([value(chat, '.qStack', 'margin-bottom'), value(chat, '.qLegend', 'margin-bottom'), value(chat, '.qLegend:has(.qHint)', 'margin-bottom')]).toEqual(['var(--space-3)', 'var(--space-2)', 'var(--space-1)']);
    // An available Submit under the pointer: green words on a deeper mint, never a disabled one (C57).
    expect([...pair('.qSubmit:not(:disabled):hover'), value(chat, '.qSubmit:not(:disabled):hover', 'border-color')]).toEqual(['var(--color-submit-hover)', 'var(--color-on-submit-hover)', 'var(--color-submit-hover-rule)']);
    expect(chat.filter((rule) => rule.selector.includes('.qSubmit:hover') || rule.selector.includes('.qSubmit:disabled:hover'))).toEqual([]);
    expect([value(chat, '.qStepper', 'background'), value(chat, '.qStepper', 'color')]).toEqual([undefined, undefined]);
    // The numeral at the largest size there is; the rows between two heavy rules, a soft one between each, and a field alone with none (C43).
    expect(value(chat, '.qNumber', 'font-size')).toBe('var(--text-36)');
    // Something else's field: no edge, and the field's ground (C62); its focus edge is every text field's.
    expect([value(chat, '.qElse .input', 'border'), value(chat, '.qElse .input', 'background')]).toEqual(['0', 'var(--color-field)']);
    // The step is the numerals' alone.
    expect(cssFiles().flatMap((file) => parse(read(file))).filter((rule) => rule.declarations.some(([, setting]) => setting.includes('--text-36'))).flatMap(selectors)).toEqual(['.qNumber']);
    expect([value(chat, '.qRows', 'border-top'), value(chat, '.qRow', 'border-bottom-color')]).toEqual(['2px solid var(--color-rule)', 'var(--color-rule-soft)']);
    expect(chat.filter((rule) => selectors(rule).some((selector) => selector.startsWith('.qFields')) && rule.declarations.some(([name]) => name.startsWith('border')))).toEqual([]);
    // A row's focus ring is the focus colour, its input out of sight and not out of reach. A text field's is the app's own (C50), below.
    expect(value(chat, '.qRow:has(.qInput:focus-visible)', 'outline')).toBe('2px solid var(--color-focus)');
    expect(chat.filter((rule) => /textarea|cardSecret/.test(rule.selector) && rule.selector.includes('focus'))).toEqual([]);
    // The stepper's boxes (C51): dotted and lighter while unseen, a plain edge once seen, thicker on the shown one, a check mark once answered.
    expect([value(chat, '.qBox', 'border'), value(chat, ".qBox[data-box='unseen']", 'border-style'), value(chat, ".qBox[data-box='unseen']", 'border-color'), value(chat, '.qBox[data-current]', 'border-width')]).toEqual(['1px solid var(--color-rule)', 'dotted', 'var(--color-rule-mid)', '2px']);
    expect(value(chat, ".qBox[data-box='answered']::after", 'border')).toBe('solid var(--color-text)');
    expect([value(chat, '.qInput', 'opacity'), value(chat, '.qInput', 'display')]).toEqual(['0', undefined]);
    // Its buttons and its stepper are no part of what is selected.
    expect(value(chat, '.qFoot', 'user-select')).toBe('none');
  });

  // Found by the stream form's first run (M19, C67): the frame was a grid, whose track is sized from
  // what the list holds, so every update of a message that was being written measured the whole list
  // again — over 100 ms for a row added to a 1,500-row table, against 4 in a column.
  it('size the message list from its frame and never from what it holds: the frame is a column, not a grid (M19, C67)', () => {
    const chat = rulesOf(CHAT);
    expect(value(chat, '.listFrame', 'display')).toBe('flex');
    expect(value(chat, '.listFrame', 'flex-direction')).toBe('column');
    expect(value(chat, '.listFrame', 'min-width')).toBe('0');
    expect(value(chat, '.listFrame', 'min-height')).toBe('0');
    expect(value(chat, '.list', 'flex')).toBe('1 1 0');
    expect(value(chat, '.list', 'min-height')).toBe('0');
    // The control at its foot is out of the column's flow.
    expect(value(chat, '.toEnd', 'position')).toBe('absolute');
  });

  // M100 (C9, C91, V1): two rows of two columns; each row's project cell is first or last in the DOM by its side, the left by default (round 11).
  it('draw the regions in DOM order: the project column’s cells are first or last in their row by its side, and nothing reorders (C26)', () => {
    const shell = rulesOf(SHELL);
    expect(value(shell, '.body', 'grid-template-columns')).toBe('var(--project-column-width) minmax(0, 1fr)');
    expect(value(shell, ".body[data-project-column='right']", 'grid-template-columns')).toBe('minmax(0, 1fr) var(--project-column-width)');
    const reordering = shell.flatMap((rule) => rule.declarations.filter(([name, setting]) => name === 'order' || name === 'direction' || name === 'grid-column' ||
      (name === 'flex-direction' && setting.includes('reverse'))).map(([name]) => `${rule.selector} { ${name} }`));
    expect(reordering).toEqual([]);
    // Shell.tsx renders Add project, the band, the list and the window on the left, and the band, Add project, the window and the list on the right.
    expect(value(shell, '.body', 'grid-template-areas')).toBe("'projectBand band' 'projects work'");
    expect(value(shell, ".body[data-project-column='right']", 'grid-template-areas')).toBe("'band projectBand' 'work projects'");
    expect(['.band', '.addProjectCell', '.sessionWindow', '.projectColumn'].map((part) => value(shell, part, 'grid-area'))).toEqual(['band', 'projectBand', 'work', 'projects']);
    // The actions fill the project column together in the same order on either side.
    expect(value(shell, '.addProjectCell', 'justify-content')).toBe('flex-start');
    expect(value(shell, ".body[data-project-column='right'] .addProjectCell", 'justify-content')).toBeUndefined();
  });

  // M100 (C19, V3): the menu and the gear in the strip, outside its drag region.
  it('take the title strip’s buttons out of its drag region', () => {
    const shell = rulesOf(SHELL);
    expect([value(shell, '.controls', '-webkit-app-region'), value(shell, '.controls', 'app-region')]).toEqual(['no-drag', 'no-drag']);
    expect(value(shell, '.titleStrip', 'app-region')).toBe('drag');
  });

  // Both found in the visual review, at 150 % display scaling. The OS rounds the window buttons' area
  // up to whole pixels and covered the rule drawn at its edge, so the strip clears it; and no
  // backdrop can dim what the OS draws, so the backdrop starts below the strip.
  it('draw the title strip taller than the window buttons, its text centred on them', () => {
    const shell = rulesOf(SHELL);
    expect(value(shell, '.titleStrip', 'height')).toBe('calc(env(titlebar-area-height, var(--title-bar-height)) + var(--title-strip-clearance))');
    expect(value(shell, '.titleArea', 'height')).toBe('env(titlebar-area-height, var(--title-bar-height))');
    const clearance = plainRoot.flatMap((rule) => rule.declarations).find(([name]) => name === '--title-strip-clearance')?.[1];
    expect(Number.parseFloat(clearance ?? '0')).toBeGreaterThanOrEqual(2);
  });

  it('dim the page under the Settings dialog, not the window chrome above it', () => {
    const strip = value(rulesOf(SHELL), '.titleStrip', 'height');
    const settings = rulesOf(`${RENDERER}/settings/Settings.module.css`);
    expect(value(settings, '.dialog::backdrop', 'top')).toBe(strip);
    expect(value(settings, '.dialog', 'top')).toBe(strip);
  });

  it('frame the project dialog and the confirmations by Settings’ rules (M12, C37)', () => {
    const strip = value(rulesOf(SHELL), '.titleStrip', 'height');
    const settings = rulesOf(`${RENDERER}/settings/Settings.module.css`);
    const frame = rulesOf(`${RENDERER}/ui/Dialog.module.css`);
    expect(value(frame, '.dialog::backdrop', 'top')).toBe(strip);
    expect(value(frame, '.dialog', 'top')).toBe(strip);
    for (const property of ['width', 'max-height']) expect(value(frame, '.dialog', property)).toBe(value(settings, '.dialog', property));
    expect(value(frame, '.body', 'overflow-y')).toBe('auto');
  });

  it('let a project header be dragged by a pointer without the browser scrolling or panning (C69, C70)', () => {
    const list = rulesOf(`${RENDERER}/projects/Projects.module.css`);
    expect(value(list, '.header', 'touch-action')).toBe('none');
    // Only headers: the rest of the column scrolls by touch as usual.
    expect(list.filter((rule) => rule.declarations.some(([name, setting]) => name === 'touch-action' && setting === 'none')).map((rule) => rule.selector)).toEqual(['.header']);
  });

  // M14 (C55): an active capsule's select button is the second drag surface; thin capsules are not dragged.
  it('let an active capsule be dragged the same way, and nothing else in the session list', () => {
    const list = rulesOf(SESSIONS);
    expect(list.filter((rule) => rule.declarations.some(([name, setting]) => name === 'touch-action' && setting === 'none')).map((rule) => rule.selector)).toEqual(['.select']);
    const dragSurfaces = shellRules.filter((rule) => rule.declarations.some(([name, setting]) => name === 'touch-action' && setting === 'none')).map((rule) => rule.selector);
    // And the gap between the chat and the pane, which resizes them (M100, round 8; C80).
    expect(dragSurfaces.sort()).toEqual(['.header', '.select', '.splitHandle']);
  });

  // M100 (C55, V1): the marks in the provider's colour and as tall as the fill, which covers the 0 % mark and meets the 100 % one at full.
  it('put a usage bar’s marks at both ends in the provider’s colour, as tall as the fill, which runs from the 0 % mark to the 100 % one (C61; M100, C55, C69)', () => {
    const block = rulesOf(`${RENDERER}/control-bar/UsageBlock.module.css`);
    expect(value(block, '.track::before', 'left')).toBe('0');
    expect(value(block, '.track::after', 'right')).toBe('0');
    const marks = block.find((rule) => rule.selector === '.track::before, .track::after');
    expect(marks?.declarations).toEqual(expect.arrayContaining([['top', '0'], ['bottom', '0'], ['width', '3px'], ['background', 'var(--bar-color)']]));
    expect(value(block, '.fillArea', 'z-index')).toBe('1');
    expect(value(block, '.fillArea', 'inset')).toBe('0');
    expect(value(block, '.fill[data-hollow]', 'background')).toBe('transparent');
    // The logo's 76 px column 2 px from the bars' 41 px labels (C84), bars of 10 px 3 px apart with a 116 px track and a 32 px countdown after it (C85), and no percentage column (C55, C69):
    // four fifths of what they were, in whole pixels (the maintainer), the text columns sized for the box's own 9.3 px.
    expect([value(block, '.block', 'grid-template-columns'), value(block, '.block', 'column-gap')]).toEqual(['76px 201px', '2px']);
    expect([value(block, '.markButton', 'width'), value(block, '.markButton', 'height')]).toEqual(['76px', '36px']);
    // Small words in bold (C72).
    for (const small of ['.label, .countdown', '.accountLabel', '.message', '.statusTrack .message']) expect(value(block, small, 'font-weight'), small).toBe('var(--weight-bold)');
    expect([value(block, '.bar', 'height'), value(block, '.track', 'height'), value(block, '.bars', 'gap')]).toEqual(['10px', '10px', '3px']);
    // The label column holds the longest word a window is given, "Monthly" at 40.4 px (measured in Inter Bold 10 px); the track gives up what it takes, so the box's width holds.
    expect(value(block, '.bar', 'grid-template-columns')).toBe('41px 116px 32px');
    // The block's words in the muted colour (C86): the labels, the countdowns, the status and the account's label all inherit it.
    expect(value(block, '.block', 'color')).toBe('var(--color-text-muted)');
    expect(value(block, '.statusTrack .message', 'color')).toBe('inherit');
    expect(block.filter((rule) => rule.selector.includes('.percent'))).toEqual([]);
    expect(value(block, '.label, .countdown', 'font-size')).toBe('var(--text-10)');
    // The box's words at sizes of their own, square at 100 % scale (the maintainer), and the session's names at 36 px
    // (the maintainer): the type scale redeclared there alone.
    const shell = rulesOf(SHELL);
    expect([value(shell, '.usage', '--text-10'), value(shell, '.usage', '--text-11'), value(shell, '.names', '--text-28')]).toEqual(['9.3px', '9.3px', '36px']);
    expect(value(shell, '.names', 'font-size')).toBe('var(--text-28)');
  });
});

// ── V18: reduced motion, in both themes ──────────────────────────────────────────────────────
describe('reduced motion (V18)', () => {
  const reduced = tokens.filter((rule) => rule.context.some((context) => /prefers-reduced-motion:\s*reduce/.test(context)));

  it('zeroes both duration tokens on the plain root, outside the theme selectors', () => {
    expect(reduced.map((rule) => rule.selector)).toEqual([':root']);
    expect(reduced[0]?.declarations).toEqual([['--duration-fast', '0ms'], ['--duration-scene', '0ms']]);
  });

  it('cannot be outweighed by a theme: no theme rule defines a duration', () => {
    for (const theme of THEMES) expect(themeRule(theme).declarations.filter(([name]) => name.startsWith('--duration'))).toEqual([]);
  });
});

// ── V36 (M13, C86, C87): the Settings dialog's size and spacing ─────────────────────────────────
describe('the Settings dialog’s size and spacing (V36)', () => {
  const settings = parse(read(`${RENDERER}/settings/Settings.module.css`));
  const frame = parse(read(`${RENDERER}/ui/Dialog.module.css`));
  const value = (rules: readonly Rule[], selector: string, property: string) =>
    rules.find((rule) => rule.selector === selector)?.declarations.find(([name]) => name === property)?.[1] ?? '';
  const token = (name: string) => Number.parseFloat(plainRoot.flatMap((rule) => rule.declarations).find(([property]) => property === name)?.[1] ?? 'NaN');
  /** A width or height rule, worked out in px for a window of `vw` × `vh`: tokens, calc(), min() and + - * only. */
  const px = (expression: string, vw: number, vh: number): number => {
    const tokens = expression
      .replace(/var\((--[\w-]+)\)/g, (_match, name: string) => String(token(name)))
      .replace(/100vw/g, String(vw)).replace(/100vh/g, String(vh)).replace(/px/g, '')
      .match(/min|calc|\d+(?:\.\d+)?|[()+\-*,]/g) ?? [];
    let at = 0;
    const next = (): string => tokens[at++] ?? '';
    const primary = (): number => {
      const word = next();
      if (word === 'min' || word === 'calc') {
        next(); // (
        const values = [sum()];
        while (tokens[at] === ',') { next(); values.push(sum()); }
        next(); // )
        return word === 'min' ? Math.min(...values) : values[0] ?? Number.NaN;
      }
      if (word === '(') { const inner = sum(); next(); return inner; }
      return Number(word);
    };
    const product = (): number => { let result = primary(); while (tokens[at] === '*') { next(); result *= primary(); } return result; };
    const sum = (): number => {
      let result = product();
      while (tokens[at] === '+' || tokens[at] === '-') result = next() === '+' ? result + product() : result - product();
      return result;
    };
    const result = sum();
    expect(at).toBe(tokens.length);
    return result;
  };
  const width = value(settings, '.dialog', 'width');
  const height = value(settings, '.dialog', 'max-height');

  // Restated at M100's minimum (C57): 1280 × 640.
  it('gives up only a small margin at the minimum window size, 1280 × 640', () => {
    expect(px(width, 1280, 640)).toBe(1200);
    expect(px(height, 1280, 640)).toBe(582);
    // What M11 settled, for comparison: 960 × 560.
    expect(px(width, 1280, 640)).toBeGreaterThan(960);
    expect(px(height, 1280, 640)).toBeGreaterThan(560);
  });

  it('stops at 1200 × 880 on a large window, and fills a middling one less its margin', () => {
    expect(px(width, 2560, 1440)).toBe(1200);
    expect(px(height, 2560, 1440)).toBe(880);
    expect(px(height, 1440, 900)).toBe(842);
  });

  it('frames the project dialog the same way (M12, C37)', () => {
    expect(value(frame, '.dialog', 'width')).toBe(width);
    expect(value(frame, '.dialog', 'max-height')).toBe(height);
  });

  // M101 (C6): the sections' headings went with the tabs, and their spacing with them.
  it('is compact: tighter lines, parts and controls than M11’s', () => {
    expect(Number(value(settings, '.dialog', 'line-height'))).toBeLessThan(1.5);
    expect(settings.filter((rule) => /\.section\b|\.sectionTitle/.test(rule.selector))).toEqual([]);
    expect(value(settings, '.instance', 'padding')).toBe('var(--space-3)');
    expect(value(settings, '.providerList', 'gap')).toBe('var(--space-6)');
    expect(value(settings, '.actions, .command', 'margin-top')).toBe('var(--space-2)');
    expect(value(settings, '.modelTable td', 'padding')).toBe('2px var(--space-2) 2px 0');
  });

  // M101 (V5; C10, C12): the row of tabs and the one panel under it.
  it('holds its most height on every tab, so the row of tabs stays where it is (M101, C12)', () => {
    expect(value(settings, '.dialog', 'height')).toBe(height);
  });

  it('lets the panel alone scroll, under a row of tabs that never scrolls or wraps and has a rule under it as the header has (M101, C1, C10, C12)', () => {
    const scrolling = settings.flatMap((rule) => rule.declarations.filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden').map(([name, setting]) => `${rule.selector} { ${name}: ${setting} }`));
    expect(scrolling).toEqual(['.panel { overflow-y: auto }', '.models { overflow-x: auto }']);
    expect([value(settings, '.panel', 'flex'), value(settings, '.panel', 'min-height')]).toEqual(['1 1 auto', '0']);
    expect([value(settings, '.content', 'display'), value(settings, '.content', 'flex-direction'), value(settings, '.content', 'min-height')]).toEqual(['flex', 'column', '0']);
    expect([value(settings, '.tabs', 'display'), value(settings, '.tabs', 'flex')]).toEqual(['flex', 'none']);
    expect(settings.filter((rule) => rule.selector.startsWith('.tab')).flatMap((rule) => rule.declarations).filter(([name, setting]) => name === 'flex-wrap' && setting !== 'nowrap')).toEqual([]);
    expect(value(settings, '.tab', 'white-space')).toBe('nowrap');
    expect(value(settings, '.tabs', 'border-bottom')).toBe(value(settings, '.header', 'border-bottom'));
  });

  it('keeps Settings tabs boxed, with a filled selected tab and a focus ring, independently of artifact tabs (M101, C10)', () => {
    expect([value(settings, '.tab', 'border'), value(settings, '.tab', 'color'), value(settings, '.tab', 'font-size')]).toEqual(['1px solid var(--color-rule-soft)', 'var(--color-text-muted)', 'var(--text-13)']);
    expect([value(settings, ".tab[aria-selected='true']", 'border-color'), value(settings, ".tab[aria-selected='true']", 'background'), value(settings, ".tab[aria-selected='true']", 'color')]).toEqual(['var(--color-rule)', 'var(--color-surface)', 'var(--color-text)']);
    expect(value(settings, '.tab:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    // Every colour a token, which both themes define (V1).
    const colours = settings.filter((rule) => rule.selector.startsWith('.tab')).flatMap((rule) => rule.declarations).filter(([name]) => /^(color|background|border(-[\w]+)?|outline)$/.test(name)).map(([, setting]) => setting);
    for (const setting of colours) expect(setting, setting).toMatch(/^(transparent|0|(\d+px solid )?var\(--[\w-]+\))$/);
  });
});

// ── M19b, V14 (C9, C13, C14, C53, C54): the artifact pane and a file's tab ───────────────────────
describe('the artifact pane’s styles (M19b: V14)', () => {
  const PANE = `${RENDERER}/artifacts/ArtifactPane.module.css`;
  const FILE = `${RENDERER}/artifacts/file/File.module.css`;
  const SHELL = `${RENDERER}/shell/Shell.module.css`;
  const pane = parse(read(PANE));
  const file = parse(read(FILE));
  const value = (rules: readonly Rule[], selector: string, property: string) =>
    rules.find((rule) => selectors(rule).includes(selector))?.declarations.find(([name]) => name === property)?.[1];
  const root = plainRoot.flatMap((rule) => rule.declarations);
  /** A length in px: a number of them, or a token that is one. */
  const px = (length: string | undefined): number => {
    const token = /^var\((--[\w-]+)\)$/.exec(length ?? '')?.[1];
    const resolved = token === undefined ? length : [...root, ...pane.flatMap((rule) => rule.declarations)].find(([name]) => name === token)?.[1];
    // A multiple of a token, as the body's margin is of the grid's cell (round 9, C81).
    const multiple = /^calc\((\d+) \* (var\(--[\w-]+\))\)$/.exec(length ?? '');
    if (multiple !== null) return Number.parseInt(multiple[1] ?? '', 10) * px(multiple[2] ?? '');
    if (resolved === undefined || !/^\d+px$/.test(resolved)) throw new Error(`not a length in px: ${String(length)}`);
    return Number.parseInt(resolved, 10);
  };

  const ASIDE = `${RENDERER}/artifacts/aside/Aside.module.css`;
  const aside = parse(read(ASIDE));
  const CHAT = `${RENDERER}/chat/Chat.module.css`;
  const chat = parse(read(CHAT));
  const AGENTS = `${RENDERER}/artifacts/agents/Agents.module.css`;
  const PLAN = `${RENDERER}/artifacts/plan/Plan.module.css`;
  const agents = parse(read(AGENTS));

  it('are every stylesheet under the pane’s folder', () => {
    expect(cssFiles(`${RENDERER}/artifacts`).sort()).toEqual([`${RENDERER}/artifacts/ArtifactBar.module.css`, PANE, AGENTS, ASIDE, FILE, `${RENDERER}/artifacts/image/Image.module.css`, PLAN]);
  });

  // M100 (round 8; C78): the Sub-agents tab scrolls as a whole, and its text is the shell's. M106 (V6;
  // C6, C9, C10, C40, C44): its sub-agents stacked as capsules — a running one at a capsule's height, a
  // finished one at half — rows that touch with a soft rule under each, the open one and its thread
  // framed as one box inside its edges, and the thread bounded to the tab's height less a row and a
  // fold line, the chat's list scrolling within it.
  it('let the Sub-agents tab scroll as a whole and select nothing, its rows touching as capsules, the open one framed inside, its thread bounded (M100, C78; M106, C6, C9, C10, C40, C44)', () => {
    const declared = agents.flatMap((rule) => rule.declarations.map(([name, setting]) => [rule.selector, name, setting] as const));
    expect(declared.filter(([, name]) => name === 'user-select')).toEqual([]);
    expect(declared.filter(([, name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden')).toEqual([['.tab', 'overflow-y', 'auto']]);
    expect([value(agents, '.tab', 'height'), value(agents, '.tab', 'min-height'), value(agents, '.tab', 'container-type')]).toEqual(['100%', '0', 'size']);
    // A running row as a capsule's select button: the avatar at its full height, a body as tall.
    expect(value(agents, '.row', 'grid-template-columns')).toBe('var(--capsule-height) minmax(0, 1fr)');
    expect(value(agents, '.body', 'height')).toBe('var(--capsule-height)');
    expect(agents.find((rule) => rule.selector === '.name')?.declarations).toEqual(expect.arrayContaining([['-webkit-line-clamp', '2'], ['overflow', 'hidden'], ['font-size', 'var(--text-14)']]));
    // The status row is a session capsule's own 16px footer, its words and time composed from it.
    expect([value(agents, '.status', 'composes'), value(agents, '.statusText', 'composes'), value(agents, '.time', 'composes')]).toEqual(["status from '../../sessions/Sessions.module.css'", "statusText from '../../sessions/Sessions.module.css'", "time from '../../sessions/Sessions.module.css'"]);
    // A finished one at half the height, on one line.
    expect(value(agents, '.thinRow', 'height')).toBe('calc(var(--capsule-height) / 2)');
    expect(agents.find((rule) => rule.selector === '.thinName')?.declarations).toEqual(expect.arrayContaining([['min-width', '0'], ['overflow', 'hidden'], ['white-space', 'nowrap'], ['text-overflow', 'ellipsis']]));
    // Rows touch, a soft rule under each; the open box framed inside its edges, its rule gone.
    expect(value(agents, '.box', 'border-bottom')).toBe('1px solid var(--color-rule-soft)');
    expect(declared.filter(([selector, name]) => selector === '.box' && /^(margin|gap|background)/.test(name))).toEqual([]);
    expect([value(agents, '.open', 'box-shadow'), value(agents, '.open', 'border-bottom-color')]).toEqual(['inset 0 0 0 2px var(--color-text)', 'transparent']);
    // Its text at the chat's own scale, which the chat area composes too (M106's walk): one class, one place to go back from.
    expect([value(chat, '.area', 'composes'), value(agents, '.thread', 'composes')]).toEqual(['scale', "scale from '../../chat/Chat.module.css'"]);
    expect(value(chat, '.scale', 'font-size')).toBe('var(--text-14)');
    // The thread: as tall as it holds, up to its row in view above it and a fold line below; framed at
    // that bound once its list fills it, the list then sized from its frame (M19, C67).
    expect(value(agents, '.thread', '--thread-bound')).toBe('max(120px, calc(100cqh - var(--capsule-height) - 24px))');
    expect([value(agents, '.thread', 'height'), value(agents, '.thread', 'max-height')]).toEqual([undefined, 'var(--thread-bound)']);
    expect([value(agents, '.items', 'flex'), value(agents, '.items', 'min-height')]).toEqual(['0 1 auto', '0']);
    expect(value(chat, '.fitList', 'flex')).toBe('0 1 auto');
    expect(value(agents, '.full', 'height')).toBe('var(--thread-bound)');
    expect([value(agents, '.full .items', 'display'), value(agents, '.full .items', 'flex'), value(agents, '.full .items', 'grid-template-rows')]).toEqual(['grid', '1 1 0', 'minmax(0, 1fr)']);
    // A grant's words on two lines at most, as they were in the model column (M22, C57).
    expect(agents.find((rule) => rule.selector === '.grantCovers')?.declarations).toEqual(expect.arrayContaining([['-webkit-line-clamp', '2'], ['overflow', 'hidden']]));
  });

  // The excerpt card and the conversation share the chat's scroll area.
  it('lay an aside’s tab out as a column that fits the width the minimum window leaves the pane, with no scrolling rule of its own (M20b, C43)', () => {
    expect([value(aside, '.aside', 'display'), value(aside, '.aside', 'flex-direction'), value(aside, '.aside', 'min-width'), value(aside, '.aside', 'min-height')]).toEqual(['flex', 'column', '0', '0']);
    // The list fills what the rest leaves; nothing else grows.
    expect(value(aside, '.items', 'min-height')).toBe('0');
    expect(value(aside, '.composer', 'flex')).toBe('none');
    // Its conversation and its follow-up's field at the chat's own scale (M106's walk), the field's by a
    // wrapper that draws no box.
    for (const part of ['.items', '.field']) expect(value(aside, part, 'composes'), part).toBe("scale from '../../chat/Chat.module.css'");
    expect(value(aside, '.field', 'display')).toBe('contents');
    for (const part of ['.aside', '.composer', '.inputRow']) expect(value(aside, part, 'composes'), part).toBeUndefined();
    expect(value(aside, '.passage', 'composes')).toBeUndefined();
    expect(value(aside, '.passage .excerptHeader[data-foldable]', 'border')).toBe('var(--rule)');
    // The source link is cut with an ellipsis: nothing in it has a width of its own.
    expect(aside.find((rule) => rule.selector === '.source')?.declarations).toEqual(expect.arrayContaining([['min-width', '0'], ['overflow', 'hidden'], ['white-space', 'nowrap'], ['text-overflow', 'ellipsis']]));
    expect(aside.flatMap((rule) => rule.declarations).filter(([name]) => /^(min-)?width$/.test(name) && name !== 'min-width')).toEqual([]);
    expect(aside.flatMap((rule) => rule.declarations).filter(([name, setting]) => name === 'min-width' && setting !== '0')).toEqual([]);
    // The field shrinks to its place, beside one button.
    expect(value(aside, '.inputRow', 'display')).toBe('flex');
    expect(aside.flatMap((rule) => rule.declarations).filter(([name, setting]) => /^overflow(-[xy])?$/.test(name) && setting !== 'hidden')).toEqual([]);
  });

  it('show the full unfolded passage, selectable, its long words wrapped', () => {
    expect(aside.find((rule) => rule.selector === '.excerpt')?.declarations).toEqual(expect.arrayContaining([
      ['white-space', 'pre-wrap'], ['overflow-wrap', 'anywhere'], ['user-select', 'text'], ['font-size', 'var(--text-13)'],
    ]));
    expect(value(aside, '.excerpt', '-webkit-line-clamp')).toBeUndefined();
    expect(aside.filter((rule) => rule.declarations.some(([name]) => name === 'user-select')).map((rule) => rule.selector)).toEqual(['.excerpt']);
  });

  // M20b (C68, V12): the rule alone can be proven here — jsdom lays nothing out.
  it('size the composer’s input by what it holds, two lines at its smallest and eight at its tallest (M20b, C68)', () => {
    expect(chat.find((rule) => rule.selector === '.input')?.declarations).toEqual(expect.arrayContaining([['field-sizing', 'content'], ['min-height', '2lh'], ['max-height', '8lh'], ['resize', 'none']]));
    // A text area scrolls past its tallest by itself: no rule of the chat's says so.
    expect(chat.find((rule) => rule.selector === '.input')?.declarations.filter(([name]) => name.startsWith('overflow'))).toEqual([]);
  });

  // M20b (C67, C44, C46, C74; V13).
  it('keep the actions and mode on one row, and the Explain this control invisible until pointed at, focused or current', () => {
    expect([value(chat, '.toolbar', 'display'), value(chat, '.toolbar', 'flex-wrap'), value(chat, '.toolbar', 'justify-content')]).toEqual(['flex', 'nowrap', 'flex-start']);
    expect(value(chat, '.toolbar', 'overflow-x')).toBe('auto');
    expect(value(chat, '.promptControls', 'display')).toBe('flex');
    expect(value(chat, '.promptControls', 'align-items')).toBe('center');
    expect(value(chat, '.promptControls', 'padding-bottom')).toBeUndefined();
    // The mode control is a whole box wherever it stands, beside the prompt actions or above the status bar.
    expect([value(parse(read(`${RENDERER}/session-area/SessionArea.module.css`)), '.modeButton', 'border'), value(parse(read(`${RENDERER}/session-area/SessionArea.module.css`)), '.modeButton', 'border-bottom')]).toEqual(['var(--rule)', undefined]);
    expect(chat.filter((rule) => rule.selector.includes('[data-session-mode]'))).toEqual([]);
    expect(value(chat, '.promptToolButton', 'white-space')).toBe('nowrap');
    expect(value(chat, '.promptTypes', 'user-select')).toBe('none');
    // Borderless text actions; the Review by model button keeps the separate toolButton style.
    expect(value(chat, '.promptToolButton', 'font-size')).toBe('var(--text-16)');
    expect(value(chat, '.promptToolButton', 'border')).toBe('0');
    expect(value(chat, '.promptToolButton:hover', 'text-decoration-thickness')).toBe('2px');
    const selectedPlan = ".promptToolButton[data-tool='plan'][aria-pressed='true']";
    expect([value(chat, selectedPlan, 'background'), value(chat, selectedPlan, 'color'), value(chat, selectedPlan, 'text-decoration')]).toEqual(['var(--color-attention)', 'var(--color-on-attention)', 'none']);
    expect(value(chat, `${selectedPlan}:hover`, 'text-decoration')).toBe('underline');
    expect(value(chat, `${selectedPlan}:hover`, 'text-decoration-thickness')).toBe('2px');
    expect([value(chat, '.toolGroup > .toolButton', 'border-right'), value(chat, '.toolGroupEnd > .toolButton', 'border-left')]).toEqual([undefined, undefined]);
    expect([value(chat, '.promptTypes', 'border-top'), value(chat, '.promptTypes', 'border-bottom')]).toEqual([undefined, undefined]);
    expect(value(chat, '.toolButton', 'font-size')).toBe('var(--text-16)');
    // The frame is the normal composer's alone. Shared feedback/input rules remain unframed.
    expect(value(chat, '.composer', 'border')).toBe('var(--rule)');
    expect(value(chat, '.composer', 'padding')).toBe('var(--space-1) var(--space-3)');
    expect(value(chat, '.composer .inputFoot', 'padding-top')).toBe('0');
    expect(value(chat, '.inputFoot', 'padding-top')).toBe('var(--space-1)');
    expect(value(chat, '.promptControls > .modeRow', 'padding-top')).toBe('0');
    // At the list's foot the mode row stands a pixel above the status bar; beside the prompt actions it takes none.
    expect([value(chat, '.modeRow', 'padding-bottom'), value(chat, '.promptControls > .modeRow', 'padding-bottom')]).toEqual(['1px', '0']);
    expect([value(chat, '.inputBox .input', 'border'), value(chat, '.inputBox', 'border')]).toEqual(['0', undefined]);
    // The prompt's caret alone indicates focus; neither its field nor its section adds an outline.
    expect(value(chat, '.inputBox .input:focus-visible', 'outline')).toBe('none');
    expect(value(chat, ":global(:root[data-theme='dark']) .composer:has(.input:focus-visible)", 'outline')).toBe('2px solid var(--color-field-focus)');
    expect(value(chat, '.inputBox', 'flex')).toBe('1 1 auto');
    // Its height follows the width alone: no rule of the bar's reads the session's state.
    expect(chat.filter((rule) => /\.(promptTypes|toolbar|toolGroup)/.test(rule.selector) && /data-(state|running)/.test(rule.selector))).toEqual([]);
    expect(value(chat, '.explain', 'user-select')).toBe('none');
    expect(value(chat, '.explain[data-explain]', 'opacity')).toBe('0');
    const shown = chat.find((rule) => value([rule], rule.selector.split(',')[0]?.trim() ?? '', 'opacity') === '1' && rule.selector.includes('.explain[data-explain]'));
    // The pointer lights one block's control, never a whole turn's (the maintainer): the
    // block is the element after the control's own, and the control itself keeps it lit while it is
    // reached for. The focus rules are the keyboard's, where a message's controls are one stop — by
    // `:focus-visible`, since a control the pointer pressed keeps the focus, and `:focus-within`
    // lit the whole turn after a press.
    expect(selectors(shown as Rule)).toEqual([
      '[data-md-control]:has(+ :hover) .explain[data-explain]', '[data-md-control]:hover .explain[data-explain]',
      '.message:has(:focus-visible) .explain[data-explain]',
      '.list:focus-visible .message[data-current] .explain[data-explain]',
      "[data-md-control]:has(+ :hover) [data-time-source='block']", "[data-md-control]:hover [data-time-source='block']",
      ".message:has(:focus-visible) [data-time-source='block']", ".list:focus-visible .message[data-current] [data-time-source='block']",
      '.explain[data-explain]:focus-visible',
    ]);
    expect(chat.filter((rule) => /\.message:(hover|focus-within)/.test(rule.selector) && rule.selector.includes('.explain'))).toEqual([]);
    // It fades in and out over --duration-scene, which reduced motion zeroes (V18): the quick token
    // reads as a switch going in, and a slow way out keeps it there while it is reached for.
    expect(value(chat, '.explain[data-explain]', 'transition')).toBe('opacity var(--duration-scene) linear');
    expect(new Map((shown as Rule).declarations).get('transition')).toBe('opacity var(--duration-scene) linear');
    // Never `display: none` or `visibility`: it stays a control for the keyboard and for assistive technology.
    expect(chat.filter((rule) => rule.selector.includes('.explain')).flatMap((rule) => rule.declarations).filter(([name, setting]) => name === 'visibility' || (name === 'display' && setting === 'none'))).toEqual([]);
    // A marker is there at all times, filled with the highlight's colour, its glyph in the text's own.
    expect([value(chat, '.explain[data-aside-marker]', 'background'), value(chat, '.explain[data-aside-marker]', 'color')]).toEqual(['var(--color-highlight)', 'var(--color-text)']);
    // The glyph is the style sheet's: a question mark the button's own text never holds, in a ring of the text's colour.
    expect(value(chat, '.explain::before', 'content')).toBe("'?'");
    expect([value(chat, '.explain', 'border'), value(chat, '.explain', 'border-radius'), value(chat, '.explain', 'font-size')]).toEqual(['1px solid currentColor', '50%', 'var(--text-11)']);
    expect(value(chat, '.explain:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    expect(value(chat, '[data-aside-over]', 'cursor')).toBe('pointer');
  });

  it('paint an aside’s passage by a background from the highlight token and nothing else, the token set in both themes and legible under the text (M20b, C74)', () => {
    const global = parse(read(`${RENDERER}/styles/global.css`));
    expect(global.find((rule) => rule.selector === '::highlight(aside)')?.declarations).toEqual([['background-color', 'var(--color-highlight)']]);
    for (const theme of THEMES) {
      const colors = colorTokens(themeRule(theme));
      expect(colors.has('--color-highlight'), theme).toBe(true);
      // The text keeps its own colour over it, a link's and a muted one's included.
      for (const text of ['--color-text', '--color-text-muted', '--color-focus']) expect(contrast(hex(colors.get(text)), hex(colors.get('--color-highlight'))), `${theme} ${text}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // M100b (C50, V16): a text field's focus, everywhere, is a thicker edge in the rule's colour, and every other control keeps the ring.
  it('give every text field a 2 px edge in the rule’s colour at focus in place of the focus ring, and leave the ring to every other control (M100b, C50)', () => {
    const global = parse(read(`${RENDERER}/styles/global.css`));
    expect(value(global, ':focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    const field = global.find((rule) => selectors(rule).includes('textarea:focus-visible'));
    expect(field?.declarations).toEqual([['outline', '2px solid var(--color-field-focus)'], ['outline-offset', '-1px']]);
    const input = field === undefined ? undefined : selectors(field).find((selector) => selector.startsWith('input'));
    // Every input that takes text: none of the kinds that hold no text is left out of the exceptions.
    for (const kind of ['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset']) expect(input, kind).toContain(`:not([type='${kind}'])`);
    expect(input).not.toMatch(/'(text|password|search)'/);
    // No module draws a field's focus in the focus colour again.
    const every = cssFiles().flatMap((file) => parse(read(file)));
    expect(every.filter((rule) => /\b(textarea|input)\b[^,]*:focus/.test(rule.selector) && rule.declarations.some(([, setting]) => setting.includes('--color-focus')))).toEqual([]);
  });

  it('never let the pane or a tab’s body scroll: the rows do, and what a kind draws in the body', () => {
    expect(value(parse(read(SHELL)), '.artifacts', 'overflow')).toBe('hidden');
    expect(value(pane, '.body', 'overflow')).toBe('hidden');
    expect(pane.find((rule) => rule.selector === '.pane')?.declarations.some(([name]) => name.startsWith('overflow'))).toBe(false);
  });

  it('fill a row with buttons and go on to the next, three rows at most, then scroll within the rows (C9)', () => {
    expect(value(pane, '.rows', 'flex-wrap')).toBe('wrap');
    expect(value(pane, '.rows', 'overflow-y')).toBe('auto');
    // Three buttons high, with the two gaps between the rows and the gutter above and below.
    expect(value(pane, '.rows', 'max-height')).toBe('calc(3 * var(--tab-height) + 2 * var(--tab-row-gap) + 2 * var(--space-2))');
    expect(value(pane, '.rows', 'gap')).toBe('var(--tab-row-gap) var(--space-1)');
    expect(value(pane, '.rows', '--tab-row-gap')).toBe('2px');
    expect(value(pane, '.rows', 'padding')).toBe('var(--space-2)');
    expect(value(pane, '.tab', 'height')).toBe('var(--tab-height)');
    // The selected button is brought into view by the list's own scroll position: its place is measured in the list.
    expect(value(pane, '.rows', 'position')).toBe('relative');
  });

  it('cut a title past its button’s most width with an ellipsis, on one line (C9)', () => {
    expect(value(pane, '.tab', 'max-width')).toBe('min(var(--tab-max-width), 100%)');
    expect(value(pane, '.tab', 'flex')).toBe('none');
    expect(pane.find((rule) => rule.selector === '.tabTitle')?.declarations).toEqual(expect.arrayContaining([['overflow', 'hidden'], ['white-space', 'nowrap'], ['text-overflow', 'ellipsis'], ['min-width', '0']]));
  });

  it('gives a title up to 280 px while still fitting the pane at its minimum width', () => {
    const most = px(value(pane, '.rows', '--tab-max-width'));
    expect(most).toBe(280);
    expect(most + 2 * px(value(pane, '.rows', 'padding'))).toBeLessThanOrEqual(tokenPx('--split-pane-min'));
  });

  it('draws transparent tabs in the solid text colour, with continuous selected and hover underlines and a focus ring', () => {
    expect(value(pane, '.tab', 'font-size')).toBe('var(--text-13)');
    expect(value(pane, '.rows', '--text-13')).toBe('13.5px');
    expect(value(pane, '.tab', 'color')).toBe('var(--color-text)');
    expect([value(pane, '.tab', 'border'), value(pane, '.tab', 'background')]).toEqual(['1px solid transparent', 'transparent']);
    expect(value(pane, ".tab[aria-selected='true']", 'color')).toBeUndefined();
    expect([value(pane, ".tab[aria-selected='true']", 'border-color'), value(pane, ".tab[aria-selected='true']", 'background')]).toEqual([undefined, undefined]);
    expect(value(pane, '.rows', 'border-bottom')).toBeUndefined();
    for (const title of ['.tab:hover .tabTitle', ".tab[aria-selected='true'] .tabTitle"]) {
      expect([value(pane, title, 'text-decoration'), value(pane, title, 'text-decoration-thickness')], title).toEqual(['underline', '2px']);
      expect(value(pane, title, 'text-decoration-skip-ink'), title).toBe('none');
    }
    expect(value(pane, '.close', 'opacity')).toBe('0');
    expect(value(pane, '.tab:hover .close', 'opacity')).toBe('1');
    expect(value(pane, '.tab:focus-within .close', 'opacity')).toBe('1');
    expect(value(pane, '.tab:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    expect(value(file, '.text:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
  });

  it('make a file’s text and its path selectable, and no button: nothing of the pane’s own says a thing of selection (C13, C36)', () => {
    expect(pane.flatMap((rule) => rule.declarations).filter(([name]) => name === 'user-select')).toEqual([]);
    expect(file.filter((rule) => rule.declarations.some(([name]) => name === 'user-select')).map((rule) => [rule.selector, value(file, rule.selector, 'user-select')])).toEqual([['.text', 'text']]);
  });

  it('draw plain text in the monospace font, uncoloured, a line unwrapped up to 2,000 px and wrapped at that width past it (C53, C54)', () => {
    expect(value(file, '.plain', 'font-family')).toBe('var(--font-mono)');
    expect(value(file, '.plain', 'font-size')).toBe('var(--text-13)');
    // The text is as wide as its longest line, and at least as wide as its place.
    expect(value(file, '.plain', 'width')).toBe('max-content');
    expect(value(file, '.plain', 'min-width')).toBe('100%');
    expect(file.find((rule) => rule.selector === '.line')?.declarations).toEqual(expect.arrayContaining([['max-width', '2000px'], ['white-space', 'pre-wrap'], ['overflow-wrap', 'anywhere']]));
    // Nothing is coloured by what a line holds: no selector reaches for a token of a language.
    expect(file.map((rule) => rule.selector).filter((selector) => /token|keyword|hljs|prism|language-/.test(selector))).toEqual([]);
    // The text scrolls both ways within itself.
    expect(value(file, '.text', 'overflow')).toBe('auto');
  });

  it('mark the line a reference named from the tokens, and cut a path that does not fit with an ellipsis (C36, C40)', () => {
    expect(value(file, '.text [data-line-mark]', 'background')).toBe('var(--color-highlight)');
    // A line's text starts at its left edge: no inset decoration may cover its first letters.
    expect(value(file, '.text [data-line-mark]', 'box-shadow')).toBeUndefined();
    expect(file.find((rule) => rule.selector === '.tooltipPath')?.declarations).toContainEqual(['overflow-wrap', 'anywhere']);
  });
});

// The margin beside a block is the block's to the pointer (the maintainer): going right
// from a block toward its Explain control, the pointer stays over the block, so the control stays lit.
describe('the margin beside a block', () => {
  const markdown = parse(read(`${RENDERER}/markdown/Markdown.module.css`));
  const chat = parse(read(`${RENDERER}/chat/Chat.module.css`));
  const value = (rules: readonly Rule[], selector: string, property: string) => rules.find((rule) => selectors(rule).includes(selector))?.declarations.find(([name]) => name === property)?.[1];
  const BLOCK = '.markdown > .blockControl + :not(.tableScroll)';

  it('is a strip of the block that draws nothing, as wide as the margin the control stands in', () => {
    expect(value(markdown, BLOCK, 'position')).toBe('relative');
    const strip = markdown.find((rule) => rule.selector === `${BLOCK}::after`);
    expect(strip?.declarations).toEqual([
      ['content', "''"], ['position', 'absolute'], ['top', 'var(--space-4)'], ['bottom', '0'], ['left', '100%'], ['width', 'var(--space-6)'],
    ]);
    // The message reserves one margin for both Copy and Explain; Markdown must not reserve it again.
    expect(value(chat, ".message:not([data-role='notice'])", 'padding-right')).toBe('var(--space-6)');
    expect(value(markdown, '.markdown:has(> .blockControl)', 'padding-right')).toBeUndefined();
    expect(value(markdown, '.blockControl > *', 'right')).toBe('calc(-1 * var(--space-6))');
  });

  it('never lies over the control and takes its press: beside the control’s row it stops where the control starts', () => {
    // Beside the control's own row: from the text's edge to the control's, as tall as the control.
    const row = markdown.find((rule) => rule.selector === `${BLOCK}::before`);
    expect(row?.declarations).toEqual([
      ['content', "''"], ['position', 'absolute'], ['top', '0'], ['left', '100%'], ['width', 'calc(var(--space-6) - var(--space-4))'], ['height', 'var(--space-4)'],
    ]);
    // The control is that size, standing at the margin's far edge: the two strips and it tile the margin.
    expect([value(chat, '.explain', 'width'), value(chat, '.explain', 'height')]).toEqual(['var(--space-4)', 'var(--space-4)']);
  });

  // The first block's control may stand lower, where its owner has something of its own just above it
  // (the maintainer): a message's Copy button. Its row of the strip then reaches as low.
  const FIRST = '.markdown > .blockControl:first-child + :not(.tableScroll)';

  it('stands as low as the first block’s control, which a message’s Copy button above it sets a step lower', () => {
    expect(value(markdown, '.blockControl:first-child > *', 'top')).toBe('var(--md-first-control-drop, 0)');
    expect(value(markdown, `${FIRST}::before`, 'height')).toBe('calc(var(--space-4) + var(--md-first-control-drop, 0px))');
    expect(value(markdown, `${FIRST}::after`, 'top')).toBe('calc(var(--space-4) + var(--md-first-control-drop, 0px))');
    expect(value(chat, ".message:has(> .head[data-head='bare'] [data-copy]):has([data-md-control]:first-child:has(> :not([data-time-source])))", '--md-first-control-drop')).toBe('var(--space-1)');
  });

  it('leaves a table out: it scrolls sideways within itself, and a strip would be overflow it scrolled to', () => {
    const strips = markdown.filter((rule) => /::(before|after)$/.test(rule.selector));
    expect(strips.map((rule) => rule.selector)).toEqual([`${BLOCK}::before`, `${BLOCK}::after`, `${FIRST}::before`, `${FIRST}::after`]);
    expect([BLOCK, FIRST].every((selector) => selector.includes(':not(.tableScroll)'))).toBe(true);
    expect(markdown.find((rule) => rule.selector === '.tableScroll')?.declarations).toContainEqual(['overflow-x', 'auto']);
  });
});

describe('a reference’s control (M19b: V10; C17, C18)', () => {
  const markdown = parse(read(`${RENDERER}/markdown/Markdown.module.css`));
  const value = (selector: string, property: string) => markdown.find((rule) => selectors(rule).includes(selector))?.declarations.find(([name]) => name === property)?.[1];

  it('reads as the text it holds: the text’s own font and colour, with no box of its own', () => {
    expect([value('.control', 'font'), value('.control', 'color'), value('.control', 'background'), value('.control', 'border'), value('.control', 'padding')]).toEqual(['inherit', 'inherit', 'none', '0', '0']);
    expect(value('.control', 'display')).toBe('inline');
  });

  it('is underlined so that it reads as something to press, and takes the focus ring', () => {
    expect(value('.control .link', 'text-decoration')).toBe('underline');
    expect(value('.control .inlineCode', 'text-decoration')).toBe('underline');
    // A file's name in bold or in italics, where it is a control (C64).
    expect(value('.control .name', 'text-decoration')).toBe('underline');
    expect(value('.control:focus-visible', 'outline')).toBe('2px solid var(--color-focus)');
    expect(value('.said', 'color')).toBe('var(--color-text-muted)');
  });
});
