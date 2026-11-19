// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { z } from 'zod';

export const AUDIO_FOLDER = 'audio';
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
export const ACTION_AUDIO_EVENTS = ['rollover', 'turnStart', 'done', 'shelve', 'restore', 'click', 'rightClick'] as const;
export const NOTIFICATION_AUDIO_EVENTS = ['turnFinished', 'question', 'approval', 'planReady', 'reviewReady', 'error'] as const;
export const AUDIO_EVENTS = [...ACTION_AUDIO_EVENTS, ...NOTIFICATION_AUDIO_EVENTS] as const;
export type AudioEvent = (typeof AUDIO_EVENTS)[number];
export type NotificationAudioEvent = (typeof NOTIFICATION_AUDIO_EVENTS)[number];
export const isNotificationAudio = (event: string): boolean => NOTIFICATION_AUDIO_EVENTS.some((one) => one === event);
export const UI_AUDIO_EVENTS = ['rollover', 'click', 'rightClick'] as const;
export type UiAudioEvent = (typeof UI_AUDIO_EVENTS)[number];
export const AUDIO_LABELS: Readonly<Record<AudioEvent, string>> = {
  rollover: 'Button rollover', turnStart: 'Reply starts', turnFinished: 'Ready', done: 'Mark Done',
  shelve: 'Shelve', restore: 'Restore', click: 'Click', rightClick: 'Right-click',
  question: 'Question', approval: 'Approval needed', planReady: 'Plan ready', reviewReady: 'Review ready', error: 'Error',
};
export const DEFAULT_SOUNDS: Readonly<Record<AudioEvent, string | null>> = {
  rollover: null, turnStart: 'Launch-1.mp3', turnFinished: 'notification-done.wav', done: 'done.wav',
  shelve: 'BagOpen.mp3', restore: 'BagClose.mp3', click: 'button.wav', rightClick: 'right-click.wav',
  question: 'question.wav', approval: 'approval.wav', planReady: 'plan-ready.wav', reviewReady: 'review-ready.wav', error: 'error.wav',
};

/** A single local filename, never a path. Windows special names cannot be selected either. */
export const AudioFilenameSchema = z.string().min(1).max(200).refine((name) =>
  !/[\\/:*?"<>|]/.test(name) && ![...name].some((character) => character.charCodeAt(0) < 32) && !name.startsWith('.') && !/[. ]$/.test(name)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) && /\.(wav|mp3|ogg)$/i.test(name));
export const AudioSoundsSchema = z.object({
  rollover: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.rollover),
  turnStart: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.turnStart),
  turnFinished: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.turnFinished),
  done: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.done),
  shelve: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.shelve),
  restore: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.restore),
  click: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.click),
  rightClick: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.rightClick),
  question: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.question),
  approval: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.approval),
  planReady: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.planReady),
  reviewReady: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.reviewReady),
  error: AudioFilenameSchema.nullable().catch(DEFAULT_SOUNDS.error),
}).catch(() => ({ ...DEFAULT_SOUNDS }));
export const AudioSoundsPatchSchema = z.partialRecord(z.enum(AUDIO_EVENTS), AudioFilenameSchema.nullable());
export const UiAudioRequestSchema = z.strictObject({ event: z.enum(UI_AUDIO_EVENTS) });

export interface AudioFile { readonly filename: string; readonly id: string }
export interface AudioListing {
  readonly files: readonly AudioFile[];
  readonly problems: number;
  readonly unavailable: boolean;
}
/** Main resolves the selection. The mini window receives none of these pushes. */
export interface AudioPlay { readonly event: AudioEvent; readonly id: string; readonly volume: number }
export const audioUrl = (id: string): string => `app://media/audio/${id}`;
