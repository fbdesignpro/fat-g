// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0032: the overlay's two styles — the version's and the effort marks' — read field by field
// from a family's file, their layers merged in order — a preset replacing the version's look before
// it — the texts its parts ask for, and the marks each effort draws.
import { describe, expect, it } from 'vitest';
import {
  avatarLayers,
  boundedLabel,
  DEFAULT_EFFORT_LOOK,
  EffortStyleSchema,
  effortMarks,
  MARKED_EFFORTS,
  mergeEffortStyles,
  mergeVersionStyles,
  OVERLAY_POSITIONS,
  OverlayLayerSchema,
  overridesOf,
  PRESET_LOOKS,
  readModelLabel,
  readOverlayLayer,
  resolveOverlay,
  sameOverlay,
  SEEDED_OVERLAY,
  VersionStyleSchema,
} from './avatar-overlay';

describe('a layer as a file holds it', () => {
  it('keeps each field of its form, drops and names the others by their path, and skips fields it does not know', () => {
    expect(readOverlayLayer({
      version: { preset: 'glow', size: 18, textColor: '#FFF', effectColor: '#12345', position: 'centre', backdropStrength: 101, parts: { name: true, version: 1 }, mood: 'calm' },
      effort: { position: 'bottom-left', size: 2, spacing: 4, color: '#000', effect: 'chip', twinkle: true },
      font: 'serif',
    })).toEqual({
      layer: {
        version: { preset: 'glow', size: 18, textColor: '#FFF', parts: { name: true } },
        effort: { spacing: 4, color: '#000' },
      },
      dropped: ['version.effectColor', 'version.backdropStrength', 'version.position', 'version.parts.version', 'effort.position', 'effort.size', 'effort.effect'],
    });
  });

  it('names a layer or a part that is no object, and reads nothing of it', () => {
    expect(readOverlayLayer(undefined)).toEqual({ layer: {}, dropped: [] });
    expect(readOverlayLayer('glow')).toEqual({ layer: {}, dropped: [''] });
    expect(readOverlayLayer({ version: 'glow', effort: [1] })).toEqual({ layer: {}, dropped: ['version', 'effort'] });
    expect(readOverlayLayer({ version: { parts: 'both' } })).toEqual({ layer: { version: {} }, dropped: ['version.parts'] });
  });

  it('reads a glow’s strength within its bounds, fat-g’s own 100 and a preset resetting it', () => {
    expect(readOverlayLayer({ version: { glowStrength: 150 }, effort: { glowStrength: 201 } })).toEqual({ layer: { version: { glowStrength: 150 }, effort: {} }, dropped: ['effort.glowStrength'] });
    expect(VersionStyleSchema.safeParse({ glowStrength: 0 }).success).toBe(true);
    for (const bad of [-1, 201, 12.5, '50']) expect(EffortStyleSchema.safeParse({ glowStrength: bad }).success, String(bad)).toBe(false);
    expect([mergeVersionStyles([]).look.glowStrength, mergeEffortStyles([]).look.glowStrength]).toEqual([100, 100]);
    expect(mergeVersionStyles([{ glowStrength: 50 }, { preset: 'glow' }]).look.glowStrength).toBe(100);
    expect(mergeEffortStyles([{ glowStrength: 50 }, { size: 9 }]).look.glowStrength).toBe(50);
  });

  it('bounds effect opacity, defaults to opaque, and merges it without hiding the text or marks', () => {
    expect(readOverlayLayer({ version: { effectOpacity: 70 }, effort: { effectOpacity: 101 } })).toEqual({ layer: { version: { effectOpacity: 70 }, effort: {} }, dropped: ['effort.effectOpacity'] });
    for (const value of [0, 70, 100]) {
      expect(VersionStyleSchema.safeParse({ effectOpacity: value }).success).toBe(true);
      expect(EffortStyleSchema.safeParse({ effectOpacity: value }).success).toBe(true);
    }
    for (const value of [-1, 101, 12.5, '70']) {
      expect(VersionStyleSchema.safeParse({ effectOpacity: value }).success).toBe(false);
      expect(EffortStyleSchema.safeParse({ effectOpacity: value }).success).toBe(false);
    }
    expect([mergeVersionStyles([]).look.effectOpacity, mergeEffortStyles([]).look.effectOpacity]).toEqual([100, 100]);
    expect(mergeVersionStyles([{ effectOpacity: 70 }, { effectOpacity: 40 }]).look.effectOpacity).toBe(40);
    expect(mergeVersionStyles([{ effectOpacity: 70 }, { preset: 'chip' }]).look.effectOpacity).toBe(100);
    expect(overridesOf({ version: { effectOpacity: 70 } }, [{ version: { effectOpacity: 70 } }])).toEqual({});
    const transparent = resolveOverlay([{ version: { effectOpacity: 0 }, effort: { effectOpacity: 0 } }], { name: null, version: '5.1' });
    expect(transparent?.text).toMatchObject({ version: '5.1', look: { textColor: '#ffffff', effectOpacity: 0 } });
    expect(transparent?.effort).toMatchObject({ color: '#ffffff', effectOpacity: 0 });
  });

  it('reads the fast bolt’s place among the marks’ fields: one of the version’s eight, the top left where none is set', () => {
    expect([DEFAULT_EFFORT_LOOK.fastPosition, mergeEffortStyles([{ position: 'top' }]).look.fastPosition]).toEqual(['top-left', 'top-left']);
    for (const place of OVERLAY_POSITIONS) {
      expect(readOverlayLayer({ effort: { fastPosition: place } })).toEqual({ layer: { effort: { fastPosition: place } }, dropped: [] });
      expect(EffortStyleSchema.safeParse({ fastPosition: place }).success, place).toBe(true);
    }
    for (const bad of ['centre', 'Top-Left', 3, null]) {
      expect(readOverlayLayer({ effort: { fastPosition: bad, size: 9 } })).toEqual({ layer: { effort: { size: 9 } }, dropped: ['effort.fastPosition'] });
      expect(EffortStyleSchema.safeParse({ fastPosition: bad }).success, String(bad)).toBe(false);
    }
    // The version's style has no such field: a window sending one there is refused, a file's is skipped.
    expect(VersionStyleSchema.safeParse({ fastPosition: 'top' }).success).toBe(false);
    expect(readOverlayLayer({ version: { fastPosition: 'top' } })).toEqual({ layer: { version: {} }, dropped: [] });
    // Merged as any other field of the marks', moving neither their edge nor the version's place.
    expect(mergeEffortStyles([{ fastPosition: 'bottom' }, { size: 9 }]).look).toEqual({ ...DEFAULT_EFFORT_LOOK, fastPosition: 'bottom', size: 9 });
    expect(overridesOf({ effort: { fastPosition: 'top-left' } }, [{}])).toEqual({});
    expect(overridesOf({ effort: { fastPosition: 'right', size: 7 } }, [{ effort: { fastPosition: 'left' } }])).toEqual({ effort: { fastPosition: 'right' } });
    // Two overlays differ by it, the marks hidden or not.
    const texts = { name: null, version: '6' };
    expect(sameOverlay(resolveOverlay([], texts), resolveOverlay([{ effort: { fastPosition: 'top' } }], texts))).toBe(false);
    expect(sameOverlay(resolveOverlay([{ effort: { show: false } }], texts), resolveOverlay([{ effort: { show: false, fastPosition: 'top' } }], texts))).toBe(false);
  });

  it('refuses a colour that is not hex, so no CSS reaches the page', () => {
    for (const colour of ['red', 'rgb(0 0 0)', '#fff;background:url(x)', 'var(--x)', '#ggg']) {
      expect(readOverlayLayer({ version: { textColor: colour } }).dropped).toEqual(['version.textColor']);
      expect(readOverlayLayer({ effort: { color: colour } }).dropped).toEqual(['effort.color']);
    }
    expect(VersionStyleSchema.safeParse({ textColor: 'red' }).success).toBe(false);
    expect(EffortStyleSchema.safeParse({ color: 'red' }).success).toBe(false);
  });
});

describe('a style as a window sends one', () => {
  it('takes every field within its bounds and nothing else', () => {
    expect(VersionStyleSchema.safeParse({ size: 41 }).success).toBe(false);
    expect(VersionStyleSchema.safeParse({ size: 6, position: 'bottom-left' }).success).toBe(true);
    expect(VersionStyleSchema.safeParse({ size: 6, mood: 'calm' }).success).toBe(false);
    expect(VersionStyleSchema.safeParse({ show: false }).success).toBe(false);
    expect(EffortStyleSchema.safeParse({ position: 'left', size: 15, spacing: 0, effect: 'glow', backdrop: 'shade', backdropStrength: 100 }).success).toBe(true);
    for (const bad of [{ position: 'top-left' }, { size: 2 }, { size: 16 }, { spacing: 11 }, { effect: 'chip' }, { size: 7.5 }, { extra: true }]) {
      expect(EffortStyleSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(OverlayLayerSchema.safeParse({ version: { size: 20 }, effort: { position: 'top' } }).success).toBe(true);
    expect(OverlayLayerSchema.safeParse({ version: { size: 20 }, path: 'C:/x' }).success).toBe(false);
  });

  it('takes fat-g’s seeded defaults whole', () => {
    expect(OverlayLayerSchema.safeParse(SEEDED_OVERLAY).success).toBe(true);
    expect(SEEDED_OVERLAY.effort).toEqual({ show: true, ...DEFAULT_EFFORT_LOOK });
    expect(SEEDED_OVERLAY.version).toEqual({ parts: { version: true, name: false }, ...PRESET_LOOKS.badge });
  });
});

describe('the layers merged', () => {
  it('start the version from the badge and the version alone; a later field wins', () => {
    expect(mergeVersionStyles([])).toEqual({ look: PRESET_LOOKS.badge, parts: { version: true, name: false } });
    expect(mergeVersionStyles([{ size: 30 }, undefined, { size: 12, position: 'left' }]).look).toEqual({ ...PRESET_LOOKS.badge, size: 12, position: 'left' });
  });

  it('let a preset replace the version’s look before it, its own layer’s fields then adjusting it', () => {
    const { look } = mergeVersionStyles([{ effectColor: '#ff9a1f', size: 30 }, { preset: 'chip', size: 16 }]);
    expect(look).toEqual({ ...PRESET_LOOKS.chip, size: 16 });
    // A preset leaves the texts as they were, including when neither is selected.
    expect(mergeVersionStyles([{ parts: { name: false, version: false } }, { preset: 'glow' }])).toMatchObject({ parts: { name: false, version: false } });
  });

  it('start the marks from fat-g’s, shown; a later field wins', () => {
    expect(mergeEffortStyles([])).toEqual({ look: DEFAULT_EFFORT_LOOK, show: true });
    expect(mergeEffortStyles([{ position: 'top', size: 9 }, undefined, { size: 5, show: false }])).toEqual({ look: { ...DEFAULT_EFFORT_LOOK, position: 'top', size: 5 }, show: false });
  });
});

describe('a layer’s overrides', () => {
  const family = { version: { preset: 'band', size: 14, position: 'top', parts: { name: true, version: true } }, effort: { position: 'bottom', size: 7 } } as const;

  it('are the fields that differ from what the layers under it give, the others dropped', () => {
    expect(overridesOf({ version: { parts: { name: false, version: true }, size: 14, textColor: '#FFF' }, effort: { size: 9, position: 'bottom' } }, [family]))
      .toEqual({ version: { parts: { name: false } }, effort: { size: 9 } });
    // Nothing left of a part, or of the layer, is no part at all.
    expect(overridesOf({ version: { parts: { name: true } }, effort: { size: 7 } }, [family])).toEqual({});
    expect(overridesOf({}, [family])).toEqual({});
    // The same overrides over a layer that has since come to agree with them: the name taken away there too.
    expect(overridesOf({ version: { parts: { name: false } } }, [{ ...family, version: { ...family.version, parts: { name: false, version: true } } }])).toEqual({});
  });

  it('keep a preset that changes the look, and a field that differs from the preset’s', () => {
    // Band again resets the size and the place the layer under it set.
    expect(overridesOf({ version: { preset: 'band' } }, [family])).toEqual({ version: { preset: 'band' } });
    expect(overridesOf({ version: { preset: 'glow', effect: 'glow', size: 14 } }, [family])).toEqual({ version: { preset: 'glow', size: 14 } });
    // A preset the layers under it name already, with nothing after it there, changes nothing.
    expect(overridesOf({ version: { preset: 'chip', effect: 'chip' } }, [{ version: { preset: 'chip' } }])).toEqual({});
  });

  it('keep the look of a hidden text, which shows again with it', () => {
    expect(overridesOf({ version: { parts: { name: false, version: false }, size: 30 } }, [family])).toEqual({ version: { parts: { name: false, version: false }, size: 30 } });
  });

  it('draw as the whole layer does', () => {
    const layer = { version: { preset: 'glow', size: 24, position: 'top', parts: { name: false, version: true }, effectColor: '#7fc4ff' }, effort: { show: true, color: '#ffffff', spacing: 3 } } as const;
    const own = overridesOf(layer, [family]);
    expect(own).toEqual({ version: { preset: 'glow', position: 'top', parts: { name: false } }, effort: { spacing: 3 } });
    for (const texts of [{ name: 'Sol', version: '6' }, { name: null, version: '6' }]) {
      expect(sameOverlay(resolveOverlay([family, own], texts), resolveOverlay([family, layer], texts))).toBe(true);
    }
  });
});

describe('what an overlay draws', () => {
  it('draws the texts its parts ask for, and the marks’ look', () => {
    expect(resolveOverlay([], { name: 'Sol', version: '6.1' })).toEqual({ text: { name: null, version: '6.1', look: PRESET_LOOKS.badge }, effort: DEFAULT_EFFORT_LOOK, fast: DEFAULT_EFFORT_LOOK });
    expect(resolveOverlay([{ version: { parts: { name: true } } }], { name: 'Sol', version: '6.1' })?.text).toMatchObject({ name: 'Sol', version: '6.1' });
  });

  it('draws no text when neither part is selected or no text is left, and no marks when they are hidden', () => {
    expect(resolveOverlay([{ version: { parts: { name: false, version: false } } }], { name: 'Sol', version: '6.1' })).toEqual({ text: null, effort: DEFAULT_EFFORT_LOOK, fast: DEFAULT_EFFORT_LOOK });
    expect(resolveOverlay([{ version: { parts: { name: true, version: false } } }], { name: 'Sol', version: '6.1' })?.text).toMatchObject({ name: 'Sol', version: null });
    expect(resolveOverlay([], { name: 'Sol', version: null })).toEqual({ text: null, effort: DEFAULT_EFFORT_LOOK, fast: DEFAULT_EFFORT_LOOK });
    expect(resolveOverlay([{ effort: { show: false } }], { name: null, version: '6' })).toEqual({ text: { name: null, version: '6', look: PRESET_LOOKS.badge }, effort: null, fast: DEFAULT_EFFORT_LOOK });
  });

  it('keeps the fast bolt’s look, the marks’, where it draws neither the texts nor the marks', () => {
    expect(resolveOverlay([{ version: { parts: { name: false, version: false } }, effort: { show: false } }], { name: 'Sol', version: '6.1' })).toEqual({ text: null, effort: null, fast: DEFAULT_EFFORT_LOOK });
    const hidden = resolveOverlay([{ effort: { show: false, fastPosition: 'bottom-right', color: '#ffcc00' } }], { name: null, version: null });
    expect(hidden).toEqual({ text: null, effort: null, fast: { ...DEFAULT_EFFORT_LOOK, fastPosition: 'bottom-right', color: '#ffcc00' } });
  });

  it('gives the Family default the name and version whatever its family’s style, and no other avatar', () => {
    const family = { version: { parts: { name: false, version: true } } };
    const texts = { name: 'Mythos', version: '1' };
    expect(resolveOverlay(avatarLayers(family, undefined, true), texts)?.text).toMatchObject({ name: 'Mythos', version: '1' });
    expect(resolveOverlay(avatarLayers(family, {}, false), texts)?.text).toMatchObject({ name: null, version: '1' });
    expect(resolveOverlay(avatarLayers(family, { version: { parts: { name: true } } }, false), texts)?.text).toMatchObject({ name: 'Mythos', version: '1' });
    // Even when both texts are disabled for matching avatars, the fallback identifies its model.
    const hidden = { version: { parts: { name: false, version: false } } };
    expect(resolveOverlay(avatarLayers(hidden, undefined, true), texts)?.text).toMatchObject(texts);
    expect(resolveOverlay(avatarLayers(hidden, undefined, false), texts)?.text).toBeNull();
  });

  it('takes the avatar’s layer over the family’s, part by part', () => {
    const family = { version: { preset: 'glow' as const }, effort: { position: 'top' as const, color: '#ff0000' } };
    const avatar = { effort: { color: '#00ff00' } };
    const drawn = resolveOverlay([family, avatar], { name: null, version: '6' });
    expect(drawn?.text?.look).toEqual(PRESET_LOOKS.glow);
    expect(drawn?.effort).toEqual({ ...DEFAULT_EFFORT_LOOK, position: 'top', color: '#00ff00' });
  });

  it('compares two overlays by what they draw', () => {
    const a = resolveOverlay([], { name: null, version: '6' });
    expect(sameOverlay(a, resolveOverlay([], { name: null, version: '6' }))).toBe(true);
    expect(sameOverlay(a, resolveOverlay([{ version: { size: 10 } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([{ effort: { size: 10 } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([{ version: { effectOpacity: 70 } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([{ effort: { effectOpacity: 70 } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([{ effort: { show: false } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([], { name: null, version: '7' }))).toBe(false);
    expect(sameOverlay(a, resolveOverlay([{ version: { parts: { version: false } } }], { name: null, version: '6' }))).toBe(false);
    expect(sameOverlay(null, undefined)).toBe(true);
    expect(sameOverlay(a, null)).toBe(false);
  });
});

describe('the effort marks', () => {
  it('count one dot to five from Low to Max, and five starbursts for Ultra, by the effort’s id', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effortMarks)).toEqual([
      { count: 1, shape: 'dot' },
      { count: 2, shape: 'dot' },
      { count: 3, shape: 'dot' },
      { count: 4, shape: 'dot' },
      { count: 5, shape: 'dot' },
      { count: 5, shape: 'star' },
    ]);
  });

  it('are none for an effort they do not know, or none', () => {
    for (const effort of ['minimal', 'Medium', 'toString', '__proto__', '', null, undefined]) expect(effortMarks(effort), String(effort)).toBeNull();
  });

  it('list their efforts lightest first', () => {
    expect(MARKED_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
});

describe('the texts a provider reads', () => {
  it('are kept only when of the bounded form', () => {
    expect(boundedLabel({ version: '6.1', name: 'Sol' })).toEqual({ version: '6.1', name: 'Sol' });
    expect(boundedLabel({ version: '6 1', name: 'x'.repeat(17) })).toEqual({ version: null, name: null });
  });

  it('are the resolved id’s, else the key’s where the id says nothing', () => {
    const read = (id: string) => (id === 'claude-opus-5-5' ? { version: '5.5', name: 'Opus' } : id === 'gpt-6-sol' ? { version: '6', name: 'Sol' } : { version: null, name: null });
    expect(readModelLabel(read, { key: 'opus', resolvedId: 'claude-opus-5-5' })).toEqual({ version: '5.5', name: 'Opus' });
    expect(readModelLabel(read, { key: 'gpt-6-sol', resolvedId: 'something-else' })).toEqual({ version: '6', name: 'Sol' });
    expect(readModelLabel(read, { key: 'gpt-6-sol', resolvedId: null })).toEqual({ version: '6', name: 'Sol' });
  });
});
