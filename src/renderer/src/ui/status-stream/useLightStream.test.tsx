// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The status bar's stream (useLightStream.ts): one stream for the window, which a bar opened on a running
// session joins where it stands, rather than starting it over at each switch of session. jsdom has no
// Web Animations API, so each rectangle's two animations here are a small model of one: a time that
// follows the clock at its rate unless paused, with the stylesheet's delays and durations.
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLightStream } from './useLightStream';

const CYCLE = 1200;
/** The first four rectangles of StatusStream.module.css: each one's travel delay and shift delay. */
const LIGHTS: readonly (readonly [number, number])[] = [[0, 0], [-100, -3700], [-200, -1400], [-300, -5100]];

class FakeAnimation {
  readonly ready = Promise.resolve();
  readonly effect: { readonly getTiming: () => { readonly delay: number; readonly duration: number } };
  private start = performance.now();
  private held: number | null = null;
  private rate = 1;

  constructor(delay: number, duration: number) {
    this.effect = { getTiming: () => ({ delay, duration }) };
  }

  get currentTime(): number {
    return this.held ?? (performance.now() - this.start) * this.rate;
  }

  set currentTime(time: number) {
    if (this.held === null) this.start = performance.now() - time / this.rate;
    else this.held = time;
  }

  get startTime(): number | null {
    return this.held === null ? this.start : null;
  }

  set startTime(time: number) {
    this.start = time;
    this.held = null;
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(rate: number) {
    const time = this.currentTime;
    this.rate = rate;
    this.currentTime = time;
  }

  updatePlaybackRate(rate: number): void {
    this.playbackRate = rate;
  }

  /** As the real one does, a time before the start is rewound to it. */
  play(): void {
    const time = this.currentTime;
    this.held = null;
    this.currentTime = Math.max(0, time);
  }

  pause(): void {
    this.held = this.currentTime;
  }
}

const made = new WeakMap<Element, FakeAnimation[]>();

function animationsOf(element: Element): FakeAnimation[] {
  const known = made.get(element);
  if (known !== undefined) return known;
  const place = element.parentElement === null ? -1 : [...element.parentElement.children].indexOf(element);
  const delays = LIGHTS[place];
  const animations = delays === undefined ? [] : [new FakeAnimation(delays[0], CYCLE), new FakeAnimation(delays[1], CYCLE * 5)];
  made.set(element, animations);
  return animations;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value(this: Element) { return animationsOf(this); } });
  Object.defineProperty(document, 'timeline', { configurable: true, value: { get currentTime() { return performance.now(); } } });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, 'getAnimations');
  Reflect.deleteProperty(document, 'timeline');
  vi.useRealTimers();
});

function Bar({ running, pauseImmediately = false, independent = false, waiting = false }: { readonly running: boolean; readonly pauseImmediately?: boolean; readonly independent?: boolean; readonly waiting?: boolean }) {
  const field = useRef<HTMLDivElement>(null);
  useLightStream(field, running, pauseImmediately, independent, waiting);
  return <div ref={field}>{LIGHTS.map((_, index) => <span key={index} />)}</div>;
}

/** Each rectangle's travel and shift, as the bar in `container` drew them. */
function lightsIn(container: HTMLElement): { readonly travel: FakeAnimation; readonly shift: FakeAnimation }[] {
  return [...container.querySelectorAll('span')].map((span) => {
    const [travel, shift] = animationsOf(span);
    if (travel === undefined || shift === undefined) throw new Error('A rectangle has no animations.');
    return { travel, shift };
  });
}

/** How far into its travels a rectangle is: below zero while it waits off the bar's left edge. */
const travelled = (travel: FakeAnimation): number => travel.currentTime - travel.effect.getTiming().delay;
/** Where it is in the cycle it is on, and the pass its shift has it on. */
const places = (lights: ReturnType<typeof lightsIn>): number[] =>
  lights.flatMap(({ travel, shift }) => [((travelled(travel) % CYCLE) + CYCLE) % CYCLE, Math.floor((shift.currentTime - shift.effect.getTiming().delay) / CYCLE) % 5]);

describe('the status bar stream', () => {
  it('does not let a missing stream retime the window phase', () => {
    const active = render(<Bar running />);
    vi.advanceTimersByTime(1500);
    const phase = places(lightsIn(active.container));
    active.unmount();
    const unavailable = render(<Bar running={false} pauseImmediately />);
    unavailable.unmount();
    const returned = render(<Bar running />);
    places(lightsIn(returned.container)).forEach((place, index) => expect(place).toBeCloseTo(phase[index] ?? Number.NaN, 6));
  });
  it('eases waits to quarter speed and interrupted ramps back to full without moving any rectangle', () => {
    const view = render(<Bar running independent />);
    const lights = lightsIn(view.container);
    const width = (): number => Number((view.container.firstElementChild as HTMLElement).style.getPropertyValue('--light-width'));
    vi.advanceTimersByTime(1500);
    expect(width()).toBe(1);
    const before = places(lights);
    view.rerender(<Bar running independent waiting />);
    expect(places(lights)).toEqual(before);
    vi.advanceTimersByTime(500);
    const rate = lights[0]?.travel.playbackRate ?? 0;
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(1);
    const interruptedWidth = width();
    expect(interruptedWidth).toBeGreaterThan(0.03);
    expect(interruptedWidth).toBeLessThan(1);
    const interrupted = places(lights);
    view.rerender(<Bar running independent />);
    expect(places(lights)).toEqual(interrupted);
    expect(lights[0]?.travel.playbackRate).toBe(rate);
    expect(width()).toBe(interruptedWidth);
    vi.advanceTimersByTime(1100);
    expect(lights.every(({ travel, shift }) => travel.playbackRate === 1 && shift.playbackRate === 1)).toBe(true);
    expect(width()).toBe(1);
    view.rerender(<Bar running independent waiting />);
    vi.advanceTimersByTime(1100);
    expect(lights.every(({ travel, shift }) => travel.playbackRate === 0.25 && shift.playbackRate === 0.25)).toBe(true);
    expect(width()).toBe(0.03);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves window phase across busy/waiting remounts while capsule speeds stay independent', () => {
    const capsule = render(<Bar running independent />);
    const first = render(<Bar running waiting />);
    vi.advanceTimersByTime(1500);
    const lights = lightsIn(first.container);
    const phase = places(lights);
    first.unmount();
    const second = render(<StrictMode><Bar running /></StrictMode>);
    const next = lightsIn(second.container);
    places(next).forEach((place, index) => expect(place).toBeCloseTo(phase[index] ?? Number.NaN, 6));
    expect(next[0]?.travel.playbackRate).toBe(0.25);
    vi.advanceTimersByTime(1100);
    expect(next[0]?.travel.playbackRate).toBe(1);
    expect(lightsIn(capsule.container)[0]?.travel.playbackRate).toBe(1);
  });

  it('keeps wide waiting bars at the compact visible pace through resizing without resetting their phase', () => {
    let width = 600;
    const measured = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    let resize = (): void => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(changed: () => void) { resize = changed; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const capsule = render(<Bar running independent waiting />);
      const view = render(<Bar running waiting />);
      const lights = lightsIn(view.container);
      const rate = (): number => lights[0]?.travel.playbackRate ?? Number.NaN;
      vi.advanceTimersByTime(1100);
      expect(rate() * width).toBeCloseTo(0.25 * 200);
      expect((view.container.firstElementChild as HTMLElement).style.getPropertyValue('--light-width')).toBe('0.03');
      expect(lightsIn(capsule.container)[0]?.travel.playbackRate).toBe(0.25);

      const before = places(lights);
      const previousRate = rate();
      width = 1000;
      act(resize);
      expect(places(lights)).toEqual(before);
      expect(rate()).toBe(previousRate);
      vi.advanceTimersByTime(1100);
      expect(rate() * width).toBeCloseTo(0.25 * 200);
      expect(lightsIn(capsule.container)[0]?.travel.playbackRate).toBe(0.25);

      view.rerender(<Bar running />);
      vi.advanceTimersByTime(1100);
      expect(rate()).toBe(1);
      view.rerender(<Bar running waiting />);
      vi.advanceTimersByTime(400);
      view.unmount();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      measured.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('cancels ramps when hidden or motion is reduced and returns directly to its current target', () => {
    let reduced = false;
    const preference = new EventTarget();
    Object.defineProperty(preference, 'matches', { get: () => reduced });
    vi.stubGlobal('matchMedia', () => preference);
    const view = render(<Bar running independent />);
    view.rerender(<Bar running independent waiting />);
    vi.advanceTimersByTime(300);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    const lights = lightsIn(view.container);
    const hidden = places(lights);
    vi.advanceTimersByTime(2000);
    expect(places(lights)).toEqual(hidden);
    expect(vi.getTimerCount()).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(lights[0]?.travel.playbackRate).toBe(0.25);
    reduced = true;
    act(() => { preference.dispatchEvent(new Event('change')); });
    const stopped = places(lights);
    vi.advanceTimersByTime(2000);
    expect(places(lights)).toEqual(stopped);
    expect(vi.getTimerCount()).toBe(0);
    reduced = false;
    act(() => { preference.dispatchEvent(new Event('change')); });
    expect(lights[0]?.travel.playbackRate).toBe(0.25);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    Reflect.deleteProperty(document, 'visibilityState');
    vi.unstubAllGlobals();
  });

  it('keeps capsule timelines independent of each other and a chat reopened after a capsule starts', async () => {
    vi.advanceTimersByTime(5000);
    const chat = render(<Bar running />);
    const chatLights = lightsIn(chat.container);
    const first = render(<Bar running={false} independent />);
    const second = render(<Bar running independent />);
    const secondLights = lightsIn(second.container);
    const secondStart = secondLights[0]?.travel.startTime;

    first.rerender(<Bar running independent />);
    vi.advanceTimersByTime(1200);
    await Promise.resolve();
    expect(secondLights[0]?.travel.startTime).toBe(secondStart);
    const before = places(chatLights);
    chat.unmount();
    const reopened = lightsIn(render(<Bar running />).container);
    places(reopened).forEach((place, index) => expect(place).toBeCloseTo(before[index] ?? Number.NaN, 6));

    first.rerender(<Bar running={false} independent pauseImmediately />);
    const stopped = lightsIn(first.container).map(({ travel }) => travel.currentTime);
    const moving = secondLights[0]?.travel.currentTime;
    vi.advanceTimersByTime(500);
    expect(lightsIn(first.container).map(({ travel }) => travel.currentTime)).toEqual(stopped);
    expect(secondLights[0]?.travel.currentTime).toBeGreaterThan(moving ?? Number.NaN);
  });

  it('pauses immediately for a pending decision, cancelling a running ramp, and resumes on resolution', () => {
    const { container, rerender } = render(<Bar running={false} />);
    rerender(<Bar running />);
    vi.advanceTimersByTime(200);
    const lights = lightsIn(container);
    rerender(<Bar running={false} pauseImmediately />);
    const paused = places(lights);
    vi.advanceTimersByTime(2000);
    expect(places(lights)).toEqual(paused);
    expect(vi.getTimerCount()).toBe(0);
    rerender(<Bar running />);
    vi.advanceTimersByTime(1500);
    expect(places(lights)).not.toEqual(paused);
  });

  it('joins the stream where it stands when a bar opens on a running session, so a switch leaves it in place', () => {
    vi.advanceTimersByTime(5000);
    const first = render(<Bar running />).container;
    const lights = lightsIn(first);
    expect(lights.every(({ travel, shift }) => travel.playbackRate === 1 && shift.playbackRate === 1)).toBe(true);
    expect(new Set(lights.flatMap(({ travel, shift }) => [travel.startTime, shift.startTime])).size).toBe(1);
    expect(lights.every(({ travel }) => travelled(travel) >= 0)).toBe(true);

    vi.advanceTimersByTime(2345);
    cleanup();
    const second = lightsIn(render(<Bar running />).container);
    const before = places(lights);
    places(second).forEach((place, index) => expect(place).toBeCloseTo(before[index] ?? Number.NaN, 6));
  });

  it('does not play the entry again when React runs the effect twice as the bar mounts', () => {
    vi.advanceTimersByTime(3000);
    const { container } = render(<StrictMode><Bar running /></StrictMode>);
    const lights = lightsIn(container);
    expect(lights.every(({ travel }) => travel.playbackRate === 1 && travelled(travel) >= 0)).toBe(true);
  });

  it('comes in from the left when a turn starts in the bar, and settles where the window stream then stands', async () => {
    vi.advanceTimersByTime(4321);
    const { container, rerender } = render(<Bar running={false} />);
    rerender(<Bar running />);
    const lights = lightsIn(container);
    expect(lights.every(({ travel }) => travel.playbackRate === 0.25)).toBe(true);
    // Every one waits off the bar, the next a twelfth of a cycle after the one before.
    const waits = lights.map(({ travel }) => -travelled(travel)).sort((a, b) => a - b);
    expect(waits.every((wait) => wait >= 0 && wait < CYCLE)).toBe(true);
    waits.slice(1).forEach((wait, index) => expect(wait - (waits[index] ?? 0)).toBeCloseTo(100, 6));

    vi.advanceTimersByTime(1100);
    // Where the stream settled is read once its last speed has taken effect: a microtask later, here.
    await Promise.resolve();
    vi.advanceTimersByTime(2000);
    expect(lights.every(({ travel }) => travel.playbackRate === 1 && travelled(travel) >= 0)).toBe(true);
    const settled = places(lights);
    cleanup();
    const next = lightsIn(render(<Bar running />).container);
    places(next).forEach((place, index) => expect(place).toBeCloseTo(settled[index] ?? Number.NaN, 6));
  });
});
