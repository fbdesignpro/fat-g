// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The compositor owns the rectangles. Playback rate changes preserve their cycles.
// Full-size bars join one window phase; every capsule owns its own phase and speed.
import { useEffect, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';

const RAMP_MS = 1000;
const FULL_SPEED = 1;
const WAIT_SPEED = 0.25;
// A compact mini-window status is about 200 CSS pixels wide. A wider selected bar must
// cover its longer path more slowly to keep the waiting lights at that same visible pace.
const WAIT_REFERENCE_WIDTH = 200;
const ENTRY_SPEED = 0.25;
const LEAVING_SPEED = 0.25;
const WAIT_WIDTH = 0.03;

interface StreamTimeline { at: number; phase: number; rate: number }
const windowTimeline: StreamTimeline = { at: 0, phase: 0, rate: FULL_SPEED };
interface Light { readonly travel: Animation; readonly all: readonly Animation[] }

function ease(part: number): number {
  return part < 0.5 ? 2 * part * part : 1 - ((-2 * part + 2) ** 2) / 2;
}
function delayOf(animation: Animation): number {
  const delay = animation.effect?.getTiming().delay;
  return typeof delay === 'number' ? delay : 0;
}
function durationOf(animation: Animation): number {
  const duration = animation.effect?.getTiming().duration;
  return typeof duration === 'number' ? duration : 0;
}
function timelineNow(): number {
  const now = document.timeline?.currentTime;
  return typeof now === 'number' ? now : performance.now();
}
function phaseAt(timeline: StreamTimeline): number {
  const now = timelineNow();
  // A document's clock never goes backwards; test documents can replace their timeline.
  return now < timeline.at ? now : timeline.phase + (now - timeline.at) * timeline.rate;
}
function lightsOf(field: HTMLElement): readonly Light[] {
  if (typeof field.getAnimations !== 'function') return [];
  return [...field.children].flatMap((child) => {
    const all = child.getAnimations();
    const travel = all.reduce<Animation | null>((latest, each) => (latest === null || delayOf(each) > delayOf(latest) ? each : latest), null);
    return travel === null ? [] : [{ travel, all }];
  });
}
/** Played first: play() can rewind a negative currentTime. Delays still belong to CSS. */
function join(animations: readonly Animation[], phase: number, rate: number): void {
  for (const animation of animations) {
    animation.playbackRate = rate;
    animation.play();
    animation.currentTime = phase;
  }
}
function enterFromLeft(lights: readonly Light[], phase: number, rate: number): void {
  join(lights.flatMap(({ all }) => [...all]), phase, rate);
  for (const { travel } of lights) {
    const cycle = durationOf(travel);
    if (cycle > 0) travel.currentTime = phase - Math.ceil((phase - delayOf(travel)) / cycle) * cycle;
  }
}
/** Live preference, visibility and full-size width changes cancel in-progress ramps too. */
function useMotionEnvironment(field: RefObject<HTMLElement | null>, independent: boolean): number {
  const [revision, changed] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    preference?.addEventListener('change', changed);
    document.addEventListener('visibilitychange', changed);
    const observer = !independent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(changed) : null;
    if (field.current !== null) observer?.observe(field.current);
    return () => {
      preference?.removeEventListener('change', changed);
      document.removeEventListener('visibilitychange', changed);
      observer?.disconnect();
    };
  }, [field, independent]);
  return revision;
}
/**
 * Capsule waits approach quarter speed; wider full-size waits keep that visible pace.
 * Other work retains full speed. Only a new turn enters from the left.
 * Remounts consume the current phase; interrupted ramps start at the actual current speed.
 */
export function useLightStream(field: RefObject<HTMLElement | null>, running: boolean, pauseImmediately = false, independent = false, waiting = false): void {
  const localTimeline = useRef<StreamTimeline>({ at: 0, phase: 0, rate: FULL_SPEED });
  const shown = useRef<boolean | null>(null);
  const speed = useRef(FULL_SPEED);
  const playing = useRef(false);
  const joined = useRef(false);
  const suspended = useRef(false);
  const environment = useMotionEnvironment(field, independent);

  useLayoutEffect(() => {
    const timeline = independent ? localTimeline.current : windowTimeline;
    const element = field.current;
    if (element === null) return undefined;
    const lights = lightsOf(element);
    const animations = lights.flatMap(({ all }) => [...all]);
    // A shift is never held off the left edge and supplies the common stream phase.
    const steady = lights.flatMap(({ travel, all }) => all.filter((each) => each !== travel))[0];
    let frame = 0;
    let live = true;
    const snapshot = (rate = speed.current): void => {
      // Shorten the painted beam, never its travel geometry: its leading edge stays on course.
      const width = WAIT_WIDTH + (1 - WAIT_WIDTH) * Math.max(0, Math.min(1, (speed.current - WAIT_SPEED) / (FULL_SPEED - WAIT_SPEED)));
      element.style.setProperty('--light-width', String(width));
      const phase = steady?.currentTime;
      timeline.phase = typeof phase === 'number' ? phase : phaseAt(timeline);
      timeline.at = timelineNow();
      timeline.rate = rate;
    };
    const pause = (): void => {
      if (joined.current) snapshot(0);
      for (const animation of animations) animation.pause();
      playing.current = false;
    };
    const hold = (rate: number): void => {
      speed.current = rate;
      for (const animation of animations) animation.playbackRate = rate;
      snapshot();
    };
    const rampTo = (rate: number, done: () => void = () => undefined): void => {
      snapshot();
      if (speed.current === rate) { done(); return; }
      const from = speed.current;
      const start = performance.now();
      const step = (now: number): void => {
        if (!live) return;
        const part = Math.min(1, (now - start) / RAMP_MS);
        speed.current = part < 1 ? from + (rate - from) * ease(part) : rate;
        for (const animation of animations) animation.updatePlaybackRate(speed.current);
        snapshot();
        if (part < 1) frame = requestAnimationFrame(step);
        else done();
      };
      frame = requestAnimationFrame(step);
    };
    const cleanup = (): void => {
      live = false;
      cancelAnimationFrame(frame);
      if (playing.current) snapshot();
    };

    const motionDisabled = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (document.visibilityState === 'hidden' || motionDisabled) {
      pause();
      suspended.current = true;
      return cleanup;
    }
    if (animations.length === 0) return cleanup;
    const before = shown.current;
    shown.current = running;
    if (pauseImmediately) {
      pause();
      return cleanup;
    }
    const waitSpeed = WAIT_SPEED * (independent ? 1 : Math.min(1, WAIT_REFERENCE_WIDTH / Math.max(WAIT_REFERENCE_WIDTH, element.clientWidth)));
    const target = waiting ? waitSpeed : FULL_SPEED;
    if (suspended.current) {
      // Returning surfaces draw their current target without replaying a departed ramp.
      suspended.current = false;
      join(animations, phaseAt(timeline), target);
      joined.current = true;
      playing.current = running;
      hold(target);
      if (!running) pause();
    } else if (before === null) {
      const rate = timeline.rate > 0 ? timeline.rate : target;
      join(animations, phaseAt(timeline), rate);
      joined.current = true;
      speed.current = rate;
      playing.current = running;
      if (running) rampTo(target);
      else pause();
    } else if (running) {
      if (!playing.current) {
        enterFromLeft(lights, phaseAt(timeline), ENTRY_SPEED);
        joined.current = true;
        speed.current = ENTRY_SPEED;
      }
      playing.current = true;
      rampTo(target);
    } else if (playing.current) {
      rampTo(LEAVING_SPEED, pause);
    } else {
      pause();
    }
    return cleanup;
  }, [field, running, pauseImmediately, independent, waiting, environment]);
}
