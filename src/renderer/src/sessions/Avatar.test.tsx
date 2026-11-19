// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7 (docs/planning/_archive/M102.md, Design 7; C4, C9, C31–C34): the avatar — the file for the size, the chain
// of files over the placeholder, a failure remembered by id, and an image that is decorative,
// unselectable and undraggable, taking no pointer event.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EFFORT_LOOK, type EffortLook, type ResolvedOverlay } from '@shared/contracts/avatar-overlay';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import { showState } from '../test/sessions';
import { useAppState } from '../state/store';
import { Avatar, type AvatarSize } from './Avatar';

afterEach(cleanup);

const PORTRAIT = 'a'.repeat(32);
const SMALL = 'b'.repeat(32);
const face = (small: string | null = SMALL, portrait = PORTRAIT): ResolvedAvatar => ({ ref: { origin: 'built-in', family: 'Orange', avatar: 'Default' }, portrait, small });

function draw(size: AvatarSize, avatar: ResolvedAvatar | null = face(), providerId = 'claude', onFailed?: (failed: boolean) => void, effort?: string | null) {
  showState({});
  const view = render(<Avatar providerId={providerId} avatar={avatar} size={size} {...(onFailed === undefined ? {} : { onFailed })} {...(effort === undefined ? {} : { effort })} />);
  const span = () => view.container.querySelector('[data-avatar]') as HTMLElement;
  const image = () => span().querySelector('img');
  return { view, span, image };
}

describe('the file for the size (V7; C4)', () => {
  it.each([['tile', SMALL, 'small'], ['thin', SMALL, 'small'], ['capsule', PORTRAIT, 'portrait'], ['column', PORTRAIT, 'portrait']] as const)('draws at %s its %s', (size, id, role) => {
    const { image, span } = draw(size);
    expect(image()?.getAttribute('src')).toBe(`app://media/avatars/${id}`);
    expect(image()?.getAttribute('data-avatar-file')).toBe(role);
    expect(span().getAttribute('data-size')).toBe(size);
  });

  it('draws the portrait at 16 and 30 px for an avatar with no small', () => {
    expect(draw('tile', face(null)).image()?.getAttribute('src')).toBe(`app://media/avatars/${PORTRAIT}`);
  });
});

describe('the chain over the placeholder (V7; C9, C32)', () => {
  it('uses the provider logo as the placeholder', () => {
    showState({});
    const state = useAppState.getState().snapshot;
    if (state?.catalog === undefined) throw new Error('no catalog');
    const logo = 'data:image/png;base64,aW1hZ2U=';
    const catalog = { ...state.catalog, providers: state.catalog.providers.map((provider) => ({ ...provider, presentation: { ...provider.presentation, logo } })) };
    useAppState.setState({ snapshot: { ...state, catalog } });
    const { container } = render(<Avatar providerId="claude" avatar={null} size="capsule" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(logo);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('stands the placeholder under an image still loading: the provider’s colour and mark', () => {
    const { span, image } = draw('capsule');
    expect(span().querySelector('svg')).not.toBeNull();
    expect(span().hasAttribute('data-neutral')).toBe(false);
    expect(span().style.getPropertyValue('--bar-color')).not.toBe('');
    expect(image()).not.toBeNull();
  });

  it('falls from a failed small to the portrait, and from a failed portrait to the placeholder alone', () => {
    const onFailed = vi.fn();
    const { span, image } = draw('thin', face(), 'claude', onFailed);
    fireEvent.error(image() as HTMLImageElement);
    expect(image()?.getAttribute('src')).toBe(`app://media/avatars/${PORTRAIT}`);
    expect(onFailed).toHaveBeenLastCalledWith(false);
    fireEvent.error(image() as HTMLImageElement);
    expect(image()).toBeNull();
    expect(span().querySelector('svg')).not.toBeNull();
    expect(onFailed).toHaveBeenLastCalledWith(true);
  });

  it('tries a Rescan’s new id again, where the old one failed', () => {
    const { view, image } = draw('capsule');
    fireEvent.error(image() as HTMLImageElement);
    expect(image()).toBeNull();
    view.rerender(<Avatar providerId="claude" avatar={face(SMALL, 'c'.repeat(32))} size="capsule" />);
    expect(image()?.getAttribute('src')).toBe(`app://media/avatars/${'c'.repeat(32)}`);
  });

  it('draws the placeholder alone where none resolves, and the neutral square for a provider this build does not have', () => {
    expect(draw('capsule', null).image()).toBeNull();
    const unknown = draw('capsule', face(), 'gemini');
    expect(unknown.span().hasAttribute('data-neutral')).toBe(true);
    expect(unknown.span().querySelector('svg')).toBeNull();
    expect(unknown.image()).not.toBeNull();
  });
});

describe('decorative (V7; C34)', () => {
  it('has an empty alt, is hidden from assistive technology with its placeholder, and is not draggable', () => {
    const { span, image } = draw('column');
    expect(image()?.getAttribute('alt')).toBe('');
    expect(span().getAttribute('aria-hidden')).toBe('true');
    expect(image()?.getAttribute('draggable')).toBe('false');
  });

  // That it takes no pointer event and no selection is its style's (tests/architecture/styles.test.ts);
  // that a capsule is still dragged by a press on it, the session list's (SessionList.test.tsx).
});

// Decision 0032: the overlay, drawn over the art at the capsule and column sizes alone — the version as
// text, and the session's effort as marks.
const look = { effect: 'glow', size: 20, textColor: '#ffffff', effectColor: '#ff9a1f', effectOpacity: 70, glowStrength: 150, backdrop: 'shade', backdropColor: '#000000', backdropStrength: 60, position: 'top-right' } as const;
const lit = (name: string | null, version: string | null, effort: EffortLook | null = null, fast: EffortLook = effort ?? DEFAULT_EFFORT_LOOK): ResolvedAvatar => ({ ...face(), source: 'match', overlay: { text: name === null && version === null ? null : { name, version, look }, effort, fast } satisfies ResolvedOverlay });

describe('the version text', () => {
  it.each(['capsule', 'column'] as const)('draws the name and version as text at %s, its look in data and custom properties', (size) => {
    const { span } = draw(size, lit('Sol', '6.1'));
    const overlay = span().querySelector<HTMLElement>('[data-overlay]') as HTMLElement;
    expect([overlay.dataset['effect'], overlay.dataset['position'], overlay.dataset['backdrop']]).toEqual(['glow', 'top-right', 'shade']);
    expect(['--overlay-size', '--overlay-text', '--overlay-effect', '--overlay-effect-opacity', '--overlay-glow', '--overlay-backdrop', '--overlay-strength'].map((name) => overlay.style.getPropertyValue(name))).toEqual(['20', '#ffffff', '#ff9a1f', '70%', '1.5', '#000000', '60%']);
    expect(overlay.style.opacity).toBe('');
    expect([overlay.querySelector('[data-overlay-name]')?.textContent, overlay.querySelector('[data-overlay-version]')?.textContent]).toEqual(['Sol', '6.1']);
    // Decorative as the art is: the whole avatar is hidden from assistive technology.
    expect(span().getAttribute('aria-hidden')).toBe('true');
  });

  it.each(['tile', 'thin'] as const)('draws nothing over the art at %s, where it could not be read', (size) => {
    const { span } = draw(size, lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), 'claude', undefined, 'high');
    expect(span().querySelector('[data-overlay]')).toBeNull();
    expect(span().querySelector('[data-effort-marks]')).toBeNull();
  });

  it('draws only the texts it has, and nothing for an avatar with no overlay', () => {
    const { span } = draw('column', lit(null, '6'));
    expect(span().querySelector('[data-overlay-name]')).toBeNull();
    expect(span().querySelector('[data-overlay-version]')?.textContent).toBe('6');
    cleanup();
    expect(draw('column', { ...face(), overlay: null }).span().querySelector('[data-overlay]')).toBeNull();
  });
});

describe('the effort marks', () => {
  const marks = (span: () => HTMLElement) => span().querySelector<HTMLElement>('[data-effort-marks]');
  const shapes = (span: () => HTMLElement) => [...span().querySelectorAll<HTMLElement>('[data-effort-mark]')].map((mark) => mark.getAttribute('data-effort-mark'));

  it.each([['low', 1], ['medium', 2], ['high', 3], ['xhigh', 4], ['max', 5]] as const)('draws %s as %i dots, by its id and not its place', (effort, count) => {
    const { span } = draw('capsule', lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), 'claude', undefined, effort);
    expect(marks(span)?.getAttribute('data-effort-marks')).toBe(String(count));
    expect(shapes(span)).toEqual(Array.from({ length: count }, () => 'dot'));
  });

  it('draws Ultra as five starbursts of one fixed shape', () => {
    const { span } = draw('column', lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), 'codex', undefined, 'ultra');
    expect(shapes(span)).toEqual(['star', 'star', 'star', 'star', 'star']);
    expect(new Set([...span().querySelectorAll('[data-effort-mark="star"] path')].map((path) => path.getAttribute('d'))).size).toBe(1);
  });

  it.each([['an unknown effort', 'minimal'], ['no effort', null], ['an effort not given', undefined]] as const)('draws no marks for %s', (_, effort) => {
    const { span } = draw('capsule', lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), 'claude', undefined, effort);
    expect(marks(span)).toBeNull();
    // The text stands where it is, with no room kept for marks.
    expect(span().querySelector('[data-overlay]')?.hasAttribute('data-effort-edge')).toBe(false);
  });

  it('draws no marks where the style hides them, and marks alone where it hides the text', () => {
    expect(marks(draw('capsule', lit('Sol', '6.1', null), 'claude', undefined, 'high').span)).toBeNull();
    cleanup();
    const { span } = draw('capsule', lit(null, null, DEFAULT_EFFORT_LOOK), 'claude', undefined, 'high');
    expect(span().querySelector('[data-overlay]')).toBeNull();
    expect(marks(span)?.getAttribute('data-effort-marks')).toBe('3');
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('stands the marks on the %s edge, their look in data and custom properties', (position) => {
    const effort: EffortLook = { ...DEFAULT_EFFORT_LOOK, position, size: 9, spacing: 3, color: '#ffcc00', effect: 'glow', effectColor: '#ff0000', effectOpacity: 40, glowStrength: 50, backdrop: 'shade', backdropColor: '#101010', backdropStrength: 40 };
    const { span } = draw('column', lit('Sol', '6.1', effort), 'claude', undefined, 'medium');
    const element = marks(span) as HTMLElement;
    expect([element.dataset['position'], element.dataset['effect'], element.dataset['backdrop']]).toEqual([position, 'glow', 'shade']);
    expect(['--effort-size', '--effort-gap', '--effort-color', '--effort-effect', '--effort-effect-opacity', '--effort-glow', '--effort-backdrop', '--effort-strength'].map((name) => element.style.getPropertyValue(name))).toEqual(['9', '3', '#ffcc00', '#ff0000', '40%', '0.5', '#101010', '40%']);
    expect(element.style.opacity).toBe('');
    // The text knows the marks' edge and their room, so that it moves inward where they share it.
    const text = span().querySelector<HTMLElement>('[data-overlay]') as HTMLElement;
    expect([text.dataset['effortEdge'], text.style.getPropertyValue('--effort-room')]).toEqual([position, '12']);
  });

  it('makes more room on their edge for Ultra’s starbursts, drawn larger than the dots', () => {
    const effort: EffortLook = { ...DEFAULT_EFFORT_LOOK, position: 'bottom', size: 9 };
    const { span } = draw('column', lit('Sol', '6.1', effort), 'claude', undefined, 'ultra');
    // 9 × 2, and the margin of 3.
    expect(span().querySelector<HTMLElement>('[data-overlay]')?.style.getPropertyValue('--effort-room')).toBe('21');
  });

  it('draws two sessions on one model with the efforts each holds', () => {
    const avatar = lit('Sol', '6.1', DEFAULT_EFFORT_LOOK);
    showState({});
    const view = render(<><Avatar providerId="codex" avatar={avatar} size="capsule" effort="low" /><Avatar providerId="codex" avatar={avatar} size="capsule" effort="max" /></>);
    expect([...view.container.querySelectorAll('[data-effort-marks]')].map((element) => element.getAttribute('data-effort-marks'))).toEqual(['1', '5']);
  });
});

// Decision 0032: a fast session's lightning bolt, in the marks' look at a place of its own.
describe('the fast bolt', () => {
  function drawFast(size: AvatarSize, avatar: ResolvedAvatar | null, fast?: boolean, effort?: string | null) {
    showState({});
    const view = render(<Avatar providerId="claude" avatar={avatar} size={size} {...(fast === undefined ? {} : { fast })} {...(effort === undefined ? {} : { effort })} />);
    const span = () => view.container.querySelector('[data-avatar]') as HTMLElement;
    return { span, bolt: () => span().querySelector<HTMLElement>('[data-fast-mark]') };
  }

  it.each(['capsule', 'column'] as const)('draws one bolt at %s for a fast session alone, in the marks’ look, at its place', (size) => {
    const effort: EffortLook = { ...DEFAULT_EFFORT_LOOK, fastPosition: 'bottom-right', size: 9, color: '#ffcc00', effect: 'glow', effectColor: '#ff0000', effectOpacity: 40, glowStrength: 50, backdrop: 'shade', backdropColor: '#101010', backdropStrength: 40 };
    const { span, bolt } = drawFast(size, lit('Sol', '6.1', effort), true, 'high');
    const element = bolt() as HTMLElement;
    expect([element.dataset['position'], element.dataset['effect'], element.dataset['backdrop']]).toEqual(['bottom-right', 'glow', 'shade']);
    expect(['--effort-size', '--effort-color', '--effort-effect', '--effort-effect-opacity', '--effort-glow', '--effort-backdrop', '--effort-strength'].map((name) => element.style.getPropertyValue(name))).toEqual(['9', '#ffcc00', '#ff0000', '40%', '0.5', '#101010', '40%']);
    // One fixed shape, drawn by the page; decorative as the art is, the whole avatar hidden from assistive technology.
    expect(element.querySelectorAll('svg path')).toHaveLength(1);
    expect(element.querySelector('svg')?.getAttribute('focusable')).toBe('false');
    expect(span().getAttribute('aria-hidden')).toBe('true');
    // Beside the marks, which it does not replace.
    expect(span().querySelector('[data-effort-marks]')?.getAttribute('data-effort-marks')).toBe('3');
  });

  it('draws none for a session not fast, or where the fast flag is not given', () => {
    expect(drawFast('column', lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), false).bolt()).toBeNull();
    cleanup();
    const { span, bolt } = drawFast('column', lit('Sol', '6.1', DEFAULT_EFFORT_LOOK));
    expect(bolt()).toBeNull();
    expect(span().querySelector('[data-overlay]')?.hasAttribute('data-fast-at')).toBe(false);
  });

  it.each(['tile', 'thin'] as const)('draws none at %s, where the overlay is not drawn', (size) => {
    expect(drawFast(size, lit('Sol', '6.1', DEFAULT_EFFORT_LOOK), true).bolt()).toBeNull();
  });

  it('draws none for an avatar with no overlay, or none at all', () => {
    expect(drawFast('column', { ...face(), overlay: null }, true).bolt()).toBeNull();
    cleanup();
    expect(drawFast('capsule', null, true).bolt()).toBeNull();
  });

  it('draws it where the style hides the marks and the text, in the look they would have', () => {
    const hidden: EffortLook = { ...DEFAULT_EFFORT_LOOK, fastPosition: 'left', color: '#00ff00' };
    const { span, bolt } = drawFast('capsule', lit(null, null, null, hidden), true, 'high');
    expect(span().querySelector('[data-effort-marks]')).toBeNull();
    expect(span().querySelector('[data-overlay]')).toBeNull();
    expect([bolt()?.dataset['position'], bolt()?.style.getPropertyValue('--effort-color')]).toEqual(['left', '#00ff00']);
  });

  it('stands at fat-g’s top left by default, and tells the text its place and its room, a starburst’s', () => {
    const { span, bolt } = drawFast('column', lit('Sol', '6.1', { ...DEFAULT_EFFORT_LOOK, size: 9 }), true);
    expect(bolt()?.dataset['position']).toBe('top-left');
    const text = span().querySelector<HTMLElement>('[data-overlay]') as HTMLElement;
    // 9 × 2, and the margin of 3: the text moves aside by it where the bolt stands in its own place.
    expect([text.dataset['fastAt'], text.style.getPropertyValue('--fast-room')]).toEqual(['top-left', '21']);
  });
});
