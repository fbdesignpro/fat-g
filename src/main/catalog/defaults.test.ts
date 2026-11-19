// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V28, V26 (docs/planning/_archive/M13.md; C21, C23, C24, C72, C75): every built-in provider brings its own
// defaults — its look (M11, C36, C54, C65) and its effort labels, but no model list: the models come
// from the user's own CLI — checked against the contract before anything reads them. The look is a
// bar colour and an original mark as path data, drawn inline by the renderer, and since M100 (C69) the
// module's logo, built into the bundle as an inline image: nothing here is markup or a file to load.
import { describe, expect, it } from 'vitest';
import type { CatalogDefaults, ProviderPresentation } from '@shared/contracts/catalog';
import { builtInProviders } from '../providers';
import { InvalidProviderDefaults, parseDefaults } from './defaults';

const definitions = builtInProviders('0.0.0');
const parsed = new Map(definitions.map((definition) => [definition.descriptor.id, parseDefaults(definition)] as const));
const each = [...parsed.entries()];
const defaultsOf = (id: string): CatalogDefaults => {
  const defaults = parsed.get(id);
  if (defaults === undefined) throw new Error(`no ${id}`);
  return defaults;
};

/** A presentation without its stream, whose tones are checked on their own, by shape. */
const withoutStream = ({ stream: _stream, ...rest }: ProviderPresentation): Omit<ProviderPresentation, 'stream'> => rest;

describe('the built-in defaults (V28)', () => {
  it('cover every built-in provider, and each passes the contract', () => {
    expect([...parsed.keys()]).toEqual(['claude', 'codex']);
  });

  it('ship no model list: the models come from the user’s own CLI (C75)', () => {
    for (const definition of definitions) expect(Object.keys(definition.catalogDefaults as object).sort()).toEqual(['canRequestSpeedTier', 'efforts', 'presentation']);
  });

  it('caution Codex’s ultra, give Claude no ultra, and let both ask for a speed tier (C23, C67; decision 0013)', () => {
    expect(defaultsOf('codex').efforts.find((effort) => effort.id === 'ultra')).toEqual({ id: 'ultra', label: 'Ultra', caution: true, warning: 'Automatically delegates tasks; can increase usage.' });
    expect(defaultsOf('codex').efforts.filter((effort) => effort.caution === true)).toHaveLength(1);
    expect(defaultsOf('claude').efforts.map((effort) => effort.id)).not.toContain('ultra');
    // fat-g asks for Claude's fast mode through flag settings (decision 0020), which lift its SDK block.
    expect(defaultsOf('claude').canRequestSpeedTier).toBe(true);
    expect(defaultsOf('codex').canRequestSpeedTier).toBe(true);
  });

  // Decision 0013: what choosing a level costs, where its provider's module says, apart from the
  // caution flag that keeps a level from being chosen for the user — Claude's Max warns and is no caution.
  it('warn of Claude’s Max and Codex’s Ultra alone, in the provider’s documented words', () => {
    const warned = (id: string) => defaultsOf(id).efforts.filter((effort) => effort.warning !== undefined).map((effort) => [effort.id, effort.warning, effort.caution ?? false]);
    expect(warned('claude')).toEqual([['max', 'Can use substantially more tokens and take longer.', false]]);
    expect(warned('codex')).toEqual([['ultra', 'Automatically delegates tasks; can increase usage.', true]]);
  });

  it('refuse a warning that is not a clean description', () => {
    const definition = definitions.find((candidate) => candidate.descriptor.id === 'codex');
    if (definition === undefined) throw new Error('no codex');
    const defaults = definition.catalogDefaults as CatalogDefaults;
    const broken = { ...definition, catalogDefaults: { ...defaults, efforts: [{ id: 'ultra', label: 'Ultra', warning: '' }] } };
    expect(() => parseDefaults(broken)).toThrow(InvalidProviderDefaults);
  });

  it('list the levels in ascending order, labelled', () => {
    expect(defaultsOf('codex').efforts.map((effort) => effort.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    expect(defaultsOf('claude').efforts.map((effort) => effort.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it.each(each)('%s has a #rrggbb bar colour', (_id, defaults) => {
    expect(defaults.presentation.barColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it.each(each)('%s has a mark made of path commands and numbers only', (_id, defaults) => {
    const { viewBox, path: data } = defaults.presentation.icon;
    expect(viewBox).toMatch(/^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/);
    // Drawn as an attribute, never parsed as markup — and still refused anything that is not path data.
    expect(data).toMatch(/^M[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/);
    expect(data).not.toMatch(/[<>"'&]/);
    expect(data.length).toBeLessThan(2000);
  });

  it('tells the providers apart by colour, and by the ground their status bar warms to', () => {
    const colors = each.map(([, defaults]) => defaults.presentation.barColor);
    expect(new Set(colors).size).toBe(colors.length);
    const grounds = each.map(([, defaults]) => defaults.presentation.stream?.ground);
    expect(new Set(grounds).size).toBe(grounds.length);
  });

  it('keep the look M11 settled: Claude orange, Codex blue, and both original marks (C21); each module adds its logo (M100, C69)', () => {
    const logo = expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/) as unknown as string;
    // The accent is the provider's identity and is pinned; its stream's seven tones are its module's to
    // tune by eye (decision 0013, as amended), so only their shape is held here.
    expect(withoutStream(defaultsOf('claude').presentation)).toEqual({
      barColor: '#ff9933',
      logo,
      icon: {
        viewBox: '0 0 24 24',
        path:
          'M5 3H19A3 3 0 0 1 22 6V14A3 3 0 0 1 19 17H12L6 22V17H5A3 3 0 0 1 2 14V6A3 3 0 0 1 5 3Z' +
          'M9.5 10A1.5 1.5 0 1 0 6.5 10A1.5 1.5 0 1 0 9.5 10Z' +
          'M13.5 10A1.5 1.5 0 1 0 10.5 10A1.5 1.5 0 1 0 13.5 10Z' +
          'M17.5 10A1.5 1.5 0 1 0 14.5 10A1.5 1.5 0 1 0 17.5 10Z',
      },
    });
    expect(withoutStream(defaultsOf('codex').presentation)).toEqual({
      barColor: '#1991e2',
      logo,
      icon: {
        viewBox: '0 0 24 24',
        path: 'M5 2H19A3 3 0 0 1 22 5V19A3 3 0 0 1 19 22H5A3 3 0 0 1 2 19V5A3 3 0 0 1 5 2Z' + 'M6.5 7.9L7.9 6.5L13.4 12L7.9 17.5L6.5 16.1L10.6 12Z' + 'M13 15.5H18V17.5H13Z',
      },
    });
  });

  it('give each built-in a stream of a ground and six tones (decision 0013, as amended)', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const [id, defaults] of each) {
      const stream = defaults.presentation.stream;
      expect(stream, id).toBeDefined();
      expect(stream?.ground, id).toMatch(hex);
      expect(stream?.image, id).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
      expect(stream?.lights, id).toHaveLength(6);
      for (const tone of stream?.lights ?? []) expect(tone, id).toMatch(hex);
    }
  });

  it('lead each built-in guide to an https: page', () => {
    expect(Object.fromEntries(definitions.map((definition) => [definition.descriptor.id, definition.installationGuide]))).toEqual({
      claude: 'https://code.claude.com/docs/en/setup',
      codex: 'https://developers.openai.com/codex/cli',
    });
  });
});

describe('defaults that fail (C24, C72, V26)', () => {
  const [claude] = definitions;
  if (claude === undefined) throw new Error('no built-in provider');
  // The module's file as it is, without the logo the parse adds to its presentation.
  const raw = claude.catalogDefaults as CatalogDefaults;

  it.each([
    ['no defaults at all', undefined],
    ['a colour that is not #rrggbb', { ...raw, presentation: { ...raw.presentation, barColor: 'orange' } }],
    ['a model list, which no longer ships (C75)', { ...raw, models: [] }],
    ['two labels for one level', { ...raw, efforts: [{ id: 'low', label: 'Low' }, { id: 'low', label: 'Lower' }] }],
    ['an unknown field', { ...raw, accent: '#000000' }],
    ['a stream of five tones', { ...raw, presentation: { ...raw.presentation, stream: { ground: '#000000', lights: ['#111111', '#222222', '#333333', '#444444', '#555555'] } } }],
    ['a stream tone that is not #rrggbb', { ...raw, presentation: { ...raw.presentation, stream: { ...raw.presentation.stream, lights: ['blue', '#222222', '#333333', '#444444', '#555555', '#666666'] } } }],
    ['an unknown field in the stream', { ...raw, presentation: { ...raw.presentation, stream: { ...raw.presentation.stream, glow: '#000000' } } }],
  ])('throw on %s', (_name, catalogDefaults) => {
    expect(() => parseDefaults({ ...claude, catalogDefaults })).toThrow(InvalidProviderDefaults);
  });

  it.each(['http://code.claude.com/docs', 'file:///C:/guide.html', 'javascript:alert(1)', 'not a link', ''])('throw on the guide %j (V26)', (installationGuide) => {
    expect(() => parseDefaults({ ...claude, installationGuide })).toThrow(/installation guide/);
  });

  // M100 (C69): a logo is an inline image of the kinds a page draws, and small.
  it.each([
    ['an address that is not inline', 'https://example.test/logo.png'],
    ['an SVG, which can hold markup', 'data:image/svg+xml;base64,PHN2Zz4='],
    ['an address with more than base64 in it', 'data:image/png;base64,iVBOR"><script>'],
    ['one too large', `data:image/png;base64,${'A'.repeat(256 * 1024)}`],
  ])('throw on a logo that is %s', (_name, logo) => {
    expect(() => parseDefaults({ ...claude, logo })).toThrow(/^provider claude: the logo is not an inline png, webp or jpeg image$/);
  });

  it.each([
    'https://example.test/glow.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,iVBOR"><script>',
    `data:image/png;base64,${'A'.repeat(256 * 1024)}`,
  ])('refuses an unsafe or oversized stream image', (streamImage) => {
    expect(() => parseDefaults({ ...claude, streamImage })).toThrow(/^provider claude: the stream image is not an inline png, webp or jpeg image$/);
  });

  it('name the provider, never a value of the file', () => {
    expect(() => parseDefaults({ ...claude, catalogDefaults: { ...raw, presentation: { barColor: 'C:\\Users\\someone' } } })).toThrow(/^provider claude: catalog defaults do not match the contract \(\w+ at [\w.]*\)$/);
  });
});
