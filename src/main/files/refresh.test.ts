// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILE_BYTES_BOUND, type FileRevision } from '@shared/contracts/files';
import { REFRESH_SETTLE_MS } from './reader';
import { harness, SESSION } from './test-support';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(['win32', 'darwin', 'linux'])('visible-file refresh on %s', (platform) => {
  const root = platform === 'win32' ? 'C:\\proj' : '/proj';
  const file = `${root}/notes.md`.replaceAll('/', platform === 'win32' ? '\\' : '/');
  const make = () => harness({ platform, tree: { [file]: '# A\n' }, roots: [root] });
  const refresh = async (h: ReturnType<typeof make>, revision: FileRevision | null = { mtimeMs: 0, size: 4 }, path = file) => {
    const answer = h.reader.refresh({ sessionId: SESSION, path, revision });
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_MS);
    return answer;
  };

  it('checks unchanged paths again without reading bytes or listing folders', async () => {
    const h = make();
    expect(await refresh(h)).toEqual({ outcome: 'unchanged' });
    expect(h.calls.some((call) => call.op === 'realpath')).toBe(true);
    expect(h.calls.some((call) => call.op === 'stat')).toBe(true);
    expect(h.calls.filter((call) => call.op === 'read' || call.op === 'list')).toEqual([]);
  });

  it('detects timestamp-only and size-only changes, including an unknown opening revision', async () => {
    const h = make();
    h.mtimes.set(file, 1);
    expect(await refresh(h)).toMatchObject({ outcome: 'text', text: '# A\n', revision: { mtimeMs: 1, size: 4 } });
    h.set(file, '# Longer\n');
    expect(await refresh(h, { mtimeMs: 1, size: 4 })).toMatchObject({ outcome: 'text', text: '# Longer\n', revision: { mtimeMs: 1, size: 9 } });
    expect(await refresh(h, null)).toMatchObject({ outcome: 'text', text: '# Longer\n' });
  });

  it('groups rapid saves without reading an unsettled file', async () => {
    const h = make();
    const pending = h.reader.refresh({ sessionId: SESSION, path: file, revision: null });
    await vi.advanceTimersByTimeAsync(0);
    h.set(file, '# Still writing\n');
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_MS);
    expect(await pending).toEqual({ outcome: 'retry' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
    expect(await refresh(h)).toMatchObject({ outcome: 'text', text: '# Still writing\n' });
  });

  it('rejects a save that changes while its bytes are read', async () => {
    const h = make();
    const original = h.fs.read.bind(h.fs);
    vi.spyOn(h.fs, 'read').mockImplementation(async (path, bound) => {
      const bytes = await original(path, bound);
      h.mtimes.set(file, 99);
      return bytes;
    });
    expect(await h.reader.read({ sessionId: SESSION, target: file })).toMatchObject({ outcome: 'text', revision: null });
    h.mtimes.set(file, 0);
    expect(await refresh(h, null)).toEqual({ outcome: 'retry' });
  });

  it.each(['EACCES', 'EPERM', 'EBUSY'])('recovers from a read lock or access error (%s)', async (code) => {
    const h = make();
    vi.spyOn(h.fs, 'read').mockRejectedValueOnce(Object.assign(new Error('private path'), { code }));
    expect(await refresh(h, null)).toEqual({ outcome: 'refused', why: 'no-answer' });
    expect(await refresh(h, null)).toMatchObject({ outcome: 'text', text: '# A\n' });
  });

  it('recovers when the same path is deleted and recreated or replaced', async () => {
    const h = make();
    h.remove(file);
    expect(await refresh(h)).toMatchObject({ outcome: 'refused' });
    h.set(file, '# Replacement\n');
    expect(await refresh(h)).toMatchObject({ outcome: 'text', text: '# Replacement\n' });
  });

  it('enforces current trust and refused folders even with a matching revision', async () => {
    const h = make();
    h.roots[0]!.answer = 'not-trusted';
    expect(await refresh(h)).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.calls).toEqual([]);
    h.roots[0]!.answer = 'trusted';
    h.refused.push(root);
    expect(await refresh(h)).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.calls).toEqual([]);
  });

  it('refuses a retargeted link without reading its target', async () => {
    const h = make();
    const outside = platform === 'win32' ? 'C:\\private\\secret.md' : '/private/secret.md';
    h.set(outside, '# Secret\n');
    h.set(file, { link: outside });
    expect(await refresh(h)).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });

  it('does not search for a relative name or admit an image outside the project', async () => {
    const h = make();
    expect(await refresh(h, null, 'notes.md')).toEqual({ outcome: 'refused', why: 'outside' });
    const image = platform === 'win32' ? 'C:\\private\\image.png' : '/private/image.png';
    expect(await refresh(h, null, image)).toEqual({ outcome: 'refused', why: 'outside' });
    expect(await refresh(h, null, '//host/share/notes.md')).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.calls).toEqual([]);
  });

  it('enforces size and encoding limits and later recovers', async () => {
    const h = make();
    h.set(file, { size: FILE_BYTES_BOUND + 1 });
    expect(await refresh(h)).toMatchObject({ outcome: 'unshown', why: 'too-large' });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
    h.set(file, new Uint8Array([0xff]));
    expect(await refresh(h)).toMatchObject({ outcome: 'unshown', why: 'not-text' });
    h.set(file, '# Good again\n');
    expect(await refresh(h)).toMatchObject({ outcome: 'text', text: '# Good again\n' });
  });

  it('treats punctuation in the open path literally', async () => {
    const h = make();
    const literal = file.replace('notes.md', 'notes%20#L2.md');
    h.set(literal, '# Literal\n');
    expect(await refresh(h, null, literal)).toMatchObject({ outcome: 'text', path: literal, text: '# Literal\n' });
  });

  it('respects the read deadline when metadata stops answering', async () => {
    const h = make();
    vi.spyOn(h.fs, 'stat').mockImplementation(() => new Promise(() => undefined));
    const answer = h.reader.refresh({ sessionId: SESSION, path: file, revision: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await answer).toEqual({ outcome: 'refused', why: 'no-answer' });
  });
});
