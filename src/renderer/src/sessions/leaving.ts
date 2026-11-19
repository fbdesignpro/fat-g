// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Done flash (the maintainer): a session marked done from the page is covered by a
// box growing from the centre over what still shows it — its capsule, and its chat
// window and artifact pane when it is the one shown. Once the box is full, main is asked; green
// optionally flickers with white and its check, then fades together with a white overlay.
// What the fade shows is what main left: the
// window empty, and the capsule's place an empty slot, which then closes, the rows below sliding up. In Clean up done
// mode the flash plays at each press, and the empty slots stay until the mode ends, when they close
// together. In memory only and never saved: it is what the screen is doing.
import type { CSSProperties } from 'react';
import { create } from 'zustand';
import type { SessionEntry, SessionRefusal, SessionSaved } from '@shared/contracts/sessions';
import { DEFAULT_DONE_ANIMATION, type DoneAnimation } from '@shared/contracts/appearance';
import { invoke } from '../ipc/client';
import { usePrefs } from '../state/prefs-store';

/** Milliseconds to optionally blink, fade the white overlay and fade the green. The slot closes over --duration-scene. */
export const DONE_FLASH = { white: 300, whiteFade: 750, fade: 1000 } as const;

/** The flash's timings for its stylesheet (Sessions.module.css), so the drawing and the timers agree. */
export const DONE_FLASH_STYLE = { '--done-white': `${DONE_FLASH.white}ms`, '--done-white-fade': `${DONE_FLASH.whiteFade}ms`, '--done-fade': `${DONE_FLASH.fade}ms` } as CSSProperties;

/** A box the flash covers, in the viewport's CSS pixels. */
export interface CoverRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A leaving capsule's viewport box and its place in the list. */
export interface LeavingSlot extends CoverRect {
  readonly list: 'active' | 'shelf';
  /** The id drawn just before it in its list when it left — a capsule's or another slot's — or null when it was first. */
  readonly after: string | null;
}

export interface Leaving {
  /** Its capsule's place, or null when its list did not draw it. */
  readonly slot: LeavingSlot | null;
  /** The chat window's and the artifact pane's boxes when it was the one shown; none otherwise. */
  readonly covers: readonly CoverRect[];
  /**
   * Flashing over its capsule and window, its capsule's place a slot;
   * the green gone, its slot empty until Clean up done ends; or its slot closing.
   */
  readonly phase: 'flash' | 'empty' | 'closing';
  readonly animation: Exclude<DoneAnimation, 'none'>;
  /** Pressed in Clean up done: once the green is gone its slot stays empty until the mode ends. */
  readonly untilModeEnds: boolean;
  /** Which press this is: a timer of an earlier one for the same session does nothing. */
  readonly serial: number;
}

export interface LeavingState {
  readonly leaving: Readonly<Record<string, Leaving>>;
}

export const useLeaving = create<LeavingState>()(() => ({ leaving: {} }));

/** Whether a sequence is playing: from a flash's start until the last slot has closed. An empty one waits on Clean up done. */
export const playing = (state: LeavingState): boolean => Object.values(state.leaving).some((entry) => entry.phase !== 'empty');

/** Whether the user asked for less motion; read at each press. jsdom has no `matchMedia`, so no flash. */
const motionAllowed = (): boolean => typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;

let motion = motionAllowed;
let serials = 0;
const timers = new Set<ReturnType<typeof setTimeout>>();

/** Tests say whether the flash plays; the page asks `matchMedia`. */
export function setLeavingMotion(next: () => boolean): void {
  motion = next;
}

/** No sequence and the page's own motion check: for tests. */
export function resetLeaving(): void {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  motion = motionAllowed;
  useLeaving.setState({ leaving: {} }, true);
}

function later(ms: number, run: () => void): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, Math.max(0, ms));
  timers.add(timer);
}

/** How long a slot takes to close: the scene's duration, 0 where the user asked for less motion. */
function closingMs(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--duration-scene').trim();
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return 0;
  return value.endsWith('ms') ? number : number * 1000;
}

/** Changes one press's entry, or drops it with null; a later press of the same session is left alone. */
function change(id: string, serial: number, next: (entry: Leaving) => Leaving | null): void {
  useLeaving.setState((state) => {
    const entry = state.leaving[id];
    if (entry?.serial !== serial) return state;
    const changed = next(entry);
    const others = { ...state.leaving };
    delete others[id];
    return { leaving: changed === null ? others : { ...state.leaving, [id]: changed } };
  });
}

/** The slot closes, then goes; with no slot, the entry goes at once. */
function close(id: string, serial: number): void {
  change(id, serial, (entry) => (entry.slot === null ? null : { ...entry, phase: 'closing', covers: [] }));
  later(closingMs(), () => change(id, serial, () => null));
}

/** The flash plays; once the green is gone the covers go, and the slot closes — or stays empty while Clean up done holds it. */
function play(id: string, serial: number, animation: Exclude<DoneAnimation, 'none'>): void {
  change(id, serial, (entry) => ({ ...entry, phase: 'flash' }));
  later((animation === 'animation-flash' ? DONE_FLASH.white : 0) + DONE_FLASH.fade, () => {
    const entry = useLeaving.getState().leaving[id];
    if (entry?.serial !== serial) return;
    if (entry.untilModeEnds && entry.slot !== null) change(id, serial, (current) => ({ ...current, phase: 'empty', covers: [] }));
    else close(id, serial);
  });
}

/** Clean up done has ended: its empty slots close together, and one still flashing closes once its green is gone. */
export function releaseHeld(): void {
  for (const [id, entry] of Object.entries(useLeaving.getState().leaving)) {
    if (!entry.untilModeEnds) continue;
    change(id, entry.serial, (current) => ({ ...current, untilModeEnds: false }));
    if (entry.phase === 'empty') close(id, entry.serial);
  }
}

// ── What the flash covers, measured at the press ──────────────────────────────────────────────

function rectOf(element: Element | null): CoverRect | null {
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  return box.width >= 1 && box.height >= 1 ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
}

/** The id of the capsule or slot its list draws just before it: where its slot stays once main has moved it. */
function drawnBefore(capsule: Element): string | null {
  for (let at = capsule.previousElementSibling; at !== null; at = at.previousElementSibling) {
    if (!(at instanceof HTMLElement)) continue;
    const id = at.dataset['sessionId'] ?? at.dataset['heldSlot'];
    if (id !== undefined && id !== '') return id;
  }
  return null;
}

function slotOf(entry: SessionEntry): LeavingSlot | null {
  const capsule = document.querySelector(`li[data-session-id="${entry.record.id}"]`);
  const rect = rectOf(capsule);
  if (capsule === null || rect === null) return null;
  return { ...rect, list: entry.record.shelvedAt !== null ? 'shelf' : 'active', after: drawnBefore(capsule) };
}

/** The chat window and the artifact pane — its tabs and its body — while they show this session. */
function coversOf(id: string): readonly CoverRect[] {
  const chat = document.querySelector<HTMLElement>('[data-chat-window]');
  if (chat?.dataset['shownSession'] !== id) return [];
  return [rectOf(chat), rectOf(document.querySelector(`[data-artifact-pane="${id}"]`))].filter((rect) => rect !== null);
}

// ── Done ──────────────────────────────────────────────────────────────────────────────────────

/** Whether the session is leaving: a press on it, in Clean up done, does nothing more. */
export const isLeaving = (id: string): boolean => useLeaving.getState().leaving[id] !== undefined;

/**
 * Marks the session done as `sessions:complete` does, and answers as main does, so each caller says
 * a refusal in its own words. With motion, the green box grows over its capsule and what shows it, and
 * only once it is full is main asked, the capsule's place a slot under the flash — left empty until
 * `releaseHeld` when `cleanUp` — so the chat goes under the box, and nothing jumps whichever comes
 * first of main's answer and its push. Refused or failed, everything shows again at once. Without
 * motion — less asked for, or nothing of the session drawn — it is a plain request at the press.
 */
export async function completeWithFlash(entry: SessionEntry, options: { readonly cleanUp?: boolean } = {}): Promise<SessionSaved | SessionRefusal> {
  const { id } = entry.record;
  const request = (): Promise<SessionSaved | SessionRefusal> => invoke('sessions:complete', { id });
  const animation = usePrefs.getState().snapshot?.values.appearance.doneAnimation ?? DEFAULT_DONE_ANIMATION;
  if (!motion() || animation === 'none') return request();
  const slot = slotOf(entry);
  const covers = coversOf(id);
  if (slot === null && covers.length === 0) return request();
  const serial = ++serials;
  useLeaving.setState((state) => ({ leaving: { ...state.leaving, [id]: { slot, covers, phase: 'flash', animation, untilModeEnds: options.cleanUp === true, serial } } }));
  play(id, serial, animation);
  const drop = (): void => change(id, serial, () => null);
  let answer: SessionSaved | SessionRefusal;
  try {
    answer = await request();
  } catch (error) {
    drop();
    throw error;
  }
  if (answer.status !== 'saved') drop();
  return answer;
}
