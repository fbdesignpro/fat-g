// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The image files the chat draws (decision 0022, item 15): an image an agent read, and one a finished
// message names. Each drawing and explicit opening asks main for its session and address: main
// reads it where it lies on this machine's own disks and names it by an id. The thumbnail draws it
// from the media route by that id. A refusal is asked again at the next drawing, as is one that failed to
// draw: the file may be there, or be another, by then. Nothing of a file is held here but its id,
// its real path and its size.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityBody } from '@shared/contracts/activity';
import { type FileImage, isImageName, lastPart, readTarget } from '@shared/contracts/files';
import { imageFileFailure, type ImageFileFailure } from '../images/file-failure';
import { invoke } from '../ipc/client';

/** What main answered: the image, or the reason it draws none. */
export type ImageFileState = FileImage | ImageFileFailure;

const asked = new Map<string, Promise<ImageFileState>>();
const keyOf = (sessionId: string, target: string): string => `${sessionId}\0${target}`;

/** The image an activity read (item 15): a finished read of one file, by an image's name; else null. */
export function imageRead(body: ActivityBody): string | null {
  if (body.type !== 'read' || body.status !== 'completed' || body.files.length !== 1) return null;
  const [file] = body.files;
  return file !== undefined && isImageName(lastPart(file.path)) ? file.path : null;
}

/** The name of the file an address names, as main tries it first: an image's name tells a thumbnail's address. */
export function targetName(address: string, platform: string): string | null {
  const first = readTarget(address, platform)?.tries[0];
  return first === undefined ? null : lastPart(first.path);
}

/** Coalesces concurrent lookups only: a later drawing or press must see edits at the same path. */
export function askImageFile(sessionId: string, target: string): Promise<ImageFileState> {
  const key = keyOf(sessionId, target);
  const held = asked.get(key);
  if (held !== undefined) return held;
  const answer = invoke('files:read', { sessionId, target }).then(
    (read): ImageFileState => (read.outcome === 'image' ? { path: read.path, id: read.id, width: read.width, height: read.height } : imageFileFailure(read)),
    (): ImageFileState => ({ why: 'read-failed' }),
  );
  asked.set(key, answer);
  void answer.then(() => {
    if (asked.get(key) === answer) asked.delete(key);
  });
  return answer;
}

/** Forgets every answer: a new main's run, whose ids are new (the tests' fake bridge). */
export function resetImageFiles(): void {
  asked.clear();
}

/** Forgets what main answered for a target: the next drawing of it asks again. */
export function forgetImageFile(sessionId: string, target: string): void {
  asked.delete(keyOf(sessionId, target));
}

/** A preview and its checked reread; a late result after leaving or a newer read opens nothing. */
export function useImageFile(sessionId: string, target: string, failedId: string | null = null): { readonly state: ImageFileState | null; readonly refresh: () => Promise<ImageFileState | null> } {
  const key = `${keyOf(sessionId, target)}\0${failedId ?? ''}`;
  const [state, setState] = useState<{ readonly key: string; readonly value: ImageFileState } | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async (): Promise<ImageFileState | null> => {
    const current = ++request.current;
    const value = await askImageFile(sessionId, target);
    if (current !== request.current) return null;
    // A good header alone does not prove that Chromium can decode the image. Do not retry in a loop.
    const checked = !('why' in value) && failedId === value.id ? { why: 'load-failed' } as const : value;
    setState({ key, value: checked });
    return checked;
  }, [key, sessionId, target, failedId]);
  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);
  return { state: state?.key === key ? state.value : failedId === null ? null : { why: 'load-failed' }, refresh };
}
