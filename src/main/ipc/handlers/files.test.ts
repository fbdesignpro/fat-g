// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V13 (docs/planning/_archive/M19b.md; C25, C33, C35, C43): the two file channels, through the real
// dispatcher driven as a packaged build, on the reader and its recording stand-in. What the logs,
// the counts, the app state and the Pet hold of a read is its channel and its outcome's kind —
// never a path, a target or a file's text.
import { describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { harness, SESSION } from '../../files/test-support';
import { pngBytes } from '../../images/test-support';
import { createAppStateStore } from '../../state/app-state-store';
import { projectForWindow } from '../../state/projection';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { createKindCounts } from './counts';
import { fileHandlers, shownNotOpened } from './files';

const SECRET = 'the-file-text-7f3a';
/** An image an agent read outside the project's folders (decision 0022, item 15). */
const SHOT = 'C:\\Users\\someone\\AppData\\Local\\Temp\\fable-crop.png';
const tree = {
  [SHOT]: pngBytes(10, 10),
  'C:\\Users\\someone\\proj\\README.md': `# Tide tools\n\n${SECRET}\n`,
  'C:\\Users\\someone\\proj\\photo.png': new Uint8Array([0x89, 0x50]),
  'C:\\Users\\someone\\elsewhere\\private-notes.md': `# Private\n\n${SECRET}\n`,
  'C:\\Users\\someone\\proj\\out.md': { link: 'C:\\Users\\someone\\elsewhere\\private-notes.md' },
  'C:\\Users\\someone\\proj\\docs\\guide.md': '# Guide\n',
  'C:\\Users\\someone\\proj\\Tides.app\\Contents\\Info.plist': '<plist/>',
  'C:\\Users\\someone\\proj\\gone-out': { link: 'C:\\Users\\someone\\elsewhere' },
};
type From = { readonly windowKind: 'main' | 'pet'; readonly sender: { readonly frameUrl: string; readonly isTopFrame: boolean } };
const MAIN: From = { windowKind: 'main', sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true } };
const PET: From = { windowKind: 'pet', sender: { frameUrl: 'app://fatg/pet.html', isTopFrame: true } };

function setup(platform = 'win32', opened = '') {
  const made = harness({ platform: 'win32', tree, roots: ['C:\\Users\\someone\\proj'] });
  const logger = { warn: vi.fn(), error: vi.fn() };
  const counts = createKindCounts();
  const showInFolder = vi.fn();
  const openFolder = vi.fn((_path: string) => Promise.resolve(opened));
  const handlers = fileHandlers({ reader: made.reader, images: made.images, showInFolder, openFolder, counts, log: logger, platform });
  // As a packaged build: the dispatcher logs kinds alone.
  const dispatch: DispatchDeps = { origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: logger, detail: 'kinds' };
  const call = (channel: 'files:read' | 'files:refresh' | 'files:refreshImage' | 'files:showInFolder' | 'files:locate' | 'files:openFolder' | 'files:readImageForCopy', request: unknown, from = MAIN) =>
    dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as Handler<unknown, unknown>, { ...from, request }, dispatch);
  /** Everything the handlers said, anywhere but in their answer. */
  const said = () => JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, counts.snapshot()]);
  return { ...made, logger, counts, showInFolder, openFolder, call, said };
}
const PRIVATE = ['someone', 'README', 'private-notes', 'elsewhere', 'proj', SECRET, 'Tide tools', 'C:\\'];

describe('files:refresh', () => {
  const path = 'C:\\Users\\someone\\proj\\README.md';
  const request = { sessionId: SESSION, path, revision: { mtimeMs: 0, size: `# Tide tools\n\n${SECRET}\n`.length } };
  it('is Main-only and answers unchanged without bytes', async () => {
    const h = setup();
    expect(await h.call('files:refresh', request, PET)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(h.calls).toEqual([]);
    expect(await h.call('files:refresh', request)).toEqual({ ok: true, value: { outcome: 'unchanged' } });
    expect(h.calls.filter((call) => call.op === 'read')).toEqual([]);
  });
  it('keeps repeated failures quiet and counts kinds alone', async () => {
    const h = setup();
    for (let i = 0; i < 3; i += 1) expect(await h.call('files:refresh', { ...request, path: 'C:\\Users\\someone\\elsewhere\\private-notes.md' })).toMatchObject({ ok: true, value: { outcome: 'refused', why: 'outside' } });
    expect(h.logger.warn).not.toHaveBeenCalled();
    expect(h.counts.snapshot()).toEqual({ 'refresh:refused:outside': 3 });
    for (const secret of PRIVATE) expect(h.said()).not.toContain(secret);
  });
});

describe('files:refreshImage', () => {
  it('is Main-only, checks metadata without bytes, and keeps repeated failures quiet', async () => {
    const h = setup();
    const opened = await h.images.admit(SESSION, SHOT);
    if (!opened.ok) throw new Error('not admitted');
    const request = { sessionId: SESSION, path: SHOT, id: opened.image.id };
    h.calls.length = 0;
    expect(await h.call('files:refreshImage', request, PET)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(h.calls).toEqual([]);
    h.logger.warn.mockClear();
    expect(await h.call('files:refreshImage', request)).toEqual({ ok: true, value: { outcome: 'unchanged' } });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
    h.remove(SHOT);
    for (let n = 0; n < 3; n += 1) expect(await h.call('files:refreshImage', request)).toMatchObject({ ok: true, value: { outcome: 'refused', why: 'not-found' } });
    expect(h.logger.warn).not.toHaveBeenCalled();
    for (const secret of PRIVATE) expect(h.said()).not.toContain(secret);
    expect(await h.call('files:refreshImage', { ...request, path: `${SHOT}.png` })).toMatchObject({ ok: false, error: 'bad-request' });
  });
});

describe('files:read (V6; C25, C33, C35)', () => {
  it('answers the reader’s answer, and counts it by its outcome’s kind', async () => {
    const h = setup();
    expect(await h.call('files:read', { sessionId: SESSION, target: 'README.md:3' })).toEqual({
      ok: true,
      value: { outcome: 'text', path: 'C:\\Users\\someone\\proj\\README.md', root: 'C:\\Users\\someone\\proj', view: 'markdown', text: `# Tide tools\n\n${SECRET}\n`, revision: { mtimeMs: 0, size: `# Tide tools\n\n${SECRET}\n`.length }, line: 3, column: null },
    });
    expect((await h.call('files:read', { sessionId: SESSION, target: 'photo.png' })).ok).toBe(true);
    expect(h.counts.snapshot()).toEqual({ 'read:text': 1, 'read:unshown:other-kind': 1 });
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it('says of a refused read one line with its kind alone, and counts it', async () => {
    const h = setup();
    expect(await h.call('files:read', { sessionId: SESSION, target: 'C:\\Users\\someone\\elsewhere\\private-notes.md' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'outside' } });
    expect(await h.call('files:read', { sessionId: SESSION, target: 'out.md' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'outside' } });
    expect(await h.call('files:read', { sessionId: SESSION, target: 'private-notes.md' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'not-found' } });
    expect(h.logger.warn.mock.calls).toEqual([['[files] read refused (outside)'], ['[files] read refused (outside)'], ['[files] read refused (not-found)']]);
    expect(h.counts.snapshot()).toEqual({ 'read:refused:outside': 2, 'read:refused:not-found': 1 });
  });

  it('leaves in the logs and the counts nothing of a path, a target or a file’s text, whatever was read or refused', async () => {
    const h = setup();
    const requests = [
      { sessionId: SESSION, target: 'README.md' },
      { sessionId: SESSION, target: 'C:\\Users\\someone\\elsewhere\\private-notes.md' },
      { sessionId: SESSION, target: 'out.md' },
      { sessionId: SESSION, target: 'photo.png' },
      { sessionId: '11111111-1111-4111-8111-111111111111', target: 'README.md' },
      { sessionId: SESSION, target: 'README.md', from: 'not-absolute/README.md' },
      { sessionId: SESSION, target: '' },
      { sessionId: SESSION, target: 'README.md', base: 'C:\\Users\\someone' },
    ];
    for (const request of requests) await h.call('files:read', request);
    await h.call('files:showInFolder', { sessionId: SESSION, path: 'C:\\Users\\someone\\elsewhere\\private-notes.md' });
    await h.call('files:showInFolder', { sessionId: SESSION, path: 'C:\\Users\\someone\\proj\\README.md' });
    for (const target of ['docs', 'README.md', 'C:\\Users\\someone\\elsewhere', 'gone-out']) {
      await h.call('files:locate', { sessionId: SESSION, target });
      await h.call('files:openFolder', { sessionId: SESSION, target });
    }
    const said = h.said();
    for (const needle of PRIVATE) expect(said, needle).not.toContain(needle);
    // What they do hold: the channel, the window and kinds.
    expect(said).toContain('[ipc] bad request on files:read from the main window');
    expect(said).toContain('[files] read refused (outside)');
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('answers a bad request for a session that is not listed, and for a request the contract refuses', async () => {
    const h = setup();
    expect(await h.call('files:read', { sessionId: '11111111-1111-4111-8111-111111111111', target: 'README.md' })).toEqual({ ok: false, error: 'bad-request' });
    expect(await h.call('files:read', { sessionId: SESSION })).toEqual({ ok: false, error: 'bad-request' });
    expect(await h.call('files:read', { sessionId: SESSION, target: 'a'.repeat(4097) })).toEqual({ ok: false, error: 'bad-request' });
    expect(await h.call('files:read', null)).toEqual({ ok: false, error: 'bad-request' });
    // Only the first reached the handler.
    expect(h.counts.snapshot()).toEqual({ 'read:bad-request': 1 });
    expect(h.asked()).toEqual([]);
  });

  it('keeps nothing of a file once it has answered: the next read asks again, and gives what is there then', async () => {
    const h = setup();
    await h.call('files:read', { sessionId: SESSION, target: 'README.md' });
    h.set('C:\\Users\\someone\\proj\\README.md', '# Rewritten\n');
    h.asked();
    expect(await h.call('files:read', { sessionId: SESSION, target: 'README.md' })).toMatchObject({ value: { text: '# Rewritten\n' } });
    expect(h.asked()).toContain('read C:\\Users\\someone\\proj\\README.md');
  });

  it('puts nothing of a file in the app state, nor in what the Pet receives', async () => {
    const h = setup();
    const store = createAppStateStore();
    const changes = vi.fn();
    store.subscribe(changes);
    const before = JSON.stringify(store.getSnapshot());
    await h.call('files:read', { sessionId: SESSION, target: 'README.md' });
    expect(changes).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getSnapshot())).toBe(before);
    for (const kind of ['main', 'pet'] as const) expect(JSON.stringify(projectForWindow(kind, store.getSnapshot()))).not.toContain(SECRET);
    // The handlers are given no store, no chat and no records to write to: a reader, the file manager, counts and a log.
    expect(fileHandlers.length).toBe(1);
  });
});

describe('files:showInFolder (V13; C43)', () => {
  it('has the file manager show a file the confinements let through, by its real path', async () => {
    const h = setup();
    expect(await h.call('files:showInFolder', { sessionId: SESSION, path: 'c:/users/someone/proj/readme.md' })).toEqual({ ok: true, value: null });
    expect(h.showInFolder).toHaveBeenCalledExactlyOnceWith('C:\\Users\\someone\\proj\\README.md');
    expect(h.counts.snapshot()).toEqual({ 'show:shown': 1 });
    // Nothing was opened or read for it: its real path was asked, and its root's.
    expect(h.calls.filter((call) => call.op !== 'realpath')).toEqual([]);
  });

  it.each([
    ['a path outside the project', 'C:\\Users\\someone\\elsewhere\\private-notes.md', 'outside'],
    ['a link that leads out', 'C:\\Users\\someone\\proj\\out.md', 'outside'],
    ['a share', '\\\\host\\share\\a.md', 'outside'],
    ['a relative path', 'README.md', 'outside'],
    ['a file that is not there', 'C:\\Users\\someone\\proj\\gone.md', 'no-answer'],
  ])('refuses %s as a bad request, counted, and reaches no file manager', async (_name, path, why) => {
    const h = setup();
    expect(await h.call('files:showInFolder', { sessionId: SESSION, path })).toEqual({ ok: false, error: 'bad-request' });
    expect(h.showInFolder).not.toHaveBeenCalled();
    expect(h.counts.snapshot()).toEqual({ [`show:refused:${why}`]: 1 });
    expect(h.logger.warn.mock.calls[0]).toEqual([`[files] show in folder refused (${why})`]);
  });

  it('refuses a session that is not listed', async () => {
    const h = setup();
    expect(await h.call('files:showInFolder', { sessionId: '11111111-1111-4111-8111-111111111111', path: 'C:\\Users\\someone\\proj\\README.md' })).toEqual({ ok: false, error: 'bad-request' });
    expect(h.showInFolder).not.toHaveBeenCalled();
  });
});

describe('files:locate (decision 0022)', () => {
  it('answers the real path of the file or the folder a reference leads to, resolved as a read is, and reads no file', async () => {
    const h = setup();
    expect(await h.call('files:locate', { sessionId: SESSION, target: 'readme.md:3' })).toEqual({ ok: true, value: { outcome: 'file', path: 'C:\\Users\\someone\\proj\\README.md' } });
    expect(await h.call('files:locate', { sessionId: SESSION, target: 'guide.md', from: 'C:\\Users\\someone\\proj\\docs\\guide.md' })).toEqual({ ok: true, value: { outcome: 'file', path: 'C:\\Users\\someone\\proj\\docs\\guide.md' } });
    expect(await h.call('files:locate', { sessionId: SESSION, target: './docs/' })).toEqual({ ok: true, value: { outcome: 'folder', path: 'C:\\Users\\someone\\proj\\docs' } });
    expect(h.calls.filter((call) => call.op === 'read' || call.op === 'list')).toEqual([]);
    expect(h.counts.snapshot()).toEqual({ 'locate:file': 2, 'locate:folder': 1 });
  });

  it('answers why a reference leads nowhere, as a read is refused', async () => {
    const h = setup();
    expect(await h.call('files:locate', { sessionId: SESSION, target: 'C:\\Users\\someone\\elsewhere\\private-notes.md' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'outside' } });
    // A folder inside the project that leads out of it, on its real path.
    expect(await h.call('files:locate', { sessionId: SESSION, target: 'gone-out' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'outside' } });
    expect(await h.call('files:locate', { sessionId: SESSION, target: 'nothing-here.md' })).toEqual({ ok: true, value: { outcome: 'refused', why: 'not-found' } });
    expect(await h.call('files:locate', { sessionId: '11111111-1111-4111-8111-111111111111', target: 'README.md' })).toEqual({ ok: false, error: 'bad-request' });
    expect(h.counts.snapshot()).toEqual({ 'locate:refused:outside': 2, 'locate:refused:not-found': 1, 'locate:bad-request': 1 });
  });
});

describe('files:openFolder (decision 0022)', () => {
  it('has the file manager open a folder the confinements let through, by its real path, and reads nothing in it', async () => {
    const h = setup();
    expect(await h.call('files:openFolder', { sessionId: SESSION, target: 'C:\\users\\someone\\proj\\DOCS' })).toEqual({ ok: true, value: null });
    expect(await h.call('files:openFolder', { sessionId: SESSION, target: '.' })).toEqual({ ok: true, value: null });
    expect(h.openFolder.mock.calls).toEqual([['C:\\Users\\someone\\proj\\docs'], ['C:\\Users\\someone\\proj']]);
    expect(h.showInFolder).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.op === 'read' || call.op === 'list')).toEqual([]);
    expect(h.counts.snapshot()).toEqual({ 'open:opened': 2 });
  });

  it.each([
    ['a file', 'README.md', 'not-folder'],
    ['a folder outside the project', 'C:\\Users\\someone\\elsewhere', 'outside'],
    ['a folder that leads out of it', 'gone-out', 'outside'],
    ['a share', '\\\\host\\share', 'outside'],
    ['a folder that is not there', 'C:\\Users\\someone\\proj\\gone', 'not-found'],
  ])('refuses %s as a bad request, counted, and opens nothing', async (_name, target, why) => {
    const h = setup();
    expect(await h.call('files:openFolder', { sessionId: SESSION, target })).toEqual({ ok: false, error: 'bad-request' });
    expect(h.openFolder).not.toHaveBeenCalled();
    expect(h.showInFolder).not.toHaveBeenCalled();
    expect(h.counts.snapshot()).toEqual({ [`open:refused:${why}`]: 1 });
    expect(h.logger.warn.mock.calls[0]).toEqual([`[files] open folder refused (${why})`]);
  });

  it('shows a folder whose name has an extension in its own folder on macOS, where the system would run a bundle, and opens it elsewhere', async () => {
    const mac = setup('darwin');
    expect(await mac.call('files:openFolder', { sessionId: SESSION, target: 'Tides.app' })).toEqual({ ok: true, value: null });
    expect(await mac.call('files:openFolder', { sessionId: SESSION, target: 'docs' })).toEqual({ ok: true, value: null });
    expect(mac.showInFolder.mock.calls).toEqual([['C:\\Users\\someone\\proj\\Tides.app']]);
    expect(mac.openFolder.mock.calls).toEqual([['C:\\Users\\someone\\proj\\docs']]);
    expect(mac.counts.snapshot()).toEqual({ 'open:shown': 1, 'open:opened': 1 });
    const windows = setup('win32');
    await windows.call('files:openFolder', { sessionId: SESSION, target: 'Tides.app' });
    expect(windows.openFolder.mock.calls).toEqual([['C:\\Users\\someone\\proj\\Tides.app']]);
    expect(windows.showInFolder).not.toHaveBeenCalled();
  });

  it('answers a failure the file manager reported with its kind alone', async () => {
    const h = setup('win32', 'Failed to open C:\\Users\\someone\\proj\\docs');
    expect(await h.call('files:openFolder', { sessionId: SESSION, target: 'docs' })).toEqual({ ok: false, error: 'internal' });
    for (const needle of PRIVATE) expect(h.said(), needle).not.toContain(needle);
  });
});

describe('shownNotOpened', () => {
  it.each([
    ['/Users/someone/proj/Tides.app', 'darwin', true],
    ['/Users/someone/proj/Install.pkg', 'darwin', true],
    ['/Users/someone/proj/src', 'darwin', false],
    ['/Users/someone/proj/.github', 'darwin', false],
    ['C:\\proj\\Tides.app', 'win32', false],
    ['/home/someone/proj/Tides.app', 'linux', false],
  ])('%s on %s: %s', (path, platform, shown) => {
    expect(shownNotOpened(path, platform)).toBe(shown);
  });
});

describe('an image file (decision 0022, item 15)', () => {
  const ID = '1'.padStart(32, '0');

  it('answers a read with its id and size, and gives its bytes for Copy to its own session alone, counting each by its kind', async () => {
    const h = setup();
    expect(await h.call('files:read', { sessionId: SESSION, target: SHOT })).toEqual({ ok: true, value: { outcome: 'image', path: SHOT, id: ID, width: 10, height: 10 } });
    const copied = await h.call('files:readImageForCopy', { sessionId: SESSION, id: ID });
    expect(copied.ok && copied.value !== null && typeof copied.value === 'object' && 'mediaType' in copied.value ? copied.value.mediaType : null).toBe('image/png');
    expect(await h.call('files:readImageForCopy', { sessionId: SESSION, id: 'f'.repeat(32) })).toEqual({ ok: true, value: null });
    expect(h.counts.snapshot()).toEqual({ 'read:image': 1, 'copy:image': 1, 'copy:refused:id': 1 });
    for (const part of ['someone', 'fable-crop', 'Temp', ID]) expect(h.said()).not.toContain(part);
  });

  it('refuses Copy for an id of another shape before the handler runs', async () => {
    const h = setup();
    for (const id of ['F'.repeat(32), '1'.repeat(31), SHOT]) expect(await h.call('files:readImageForCopy', { sessionId: SESSION, id })).toEqual({ ok: false, error: 'bad-request' });
    expect(h.counts.snapshot()).toEqual({});
  });
});

describe('the Pet (V6; C25, C43)', () => {
  it.each([
    ['files:read', { sessionId: SESSION, target: 'README.md' }],
    ['files:showInFolder', { sessionId: SESSION, path: 'C:\\Users\\someone\\proj\\README.md' }],
    ['files:locate', { sessionId: SESSION, target: 'README.md' }],
    ['files:openFolder', { sessionId: SESSION, target: 'docs' }],
    ['files:readImageForCopy', { sessionId: SESSION, id: '1'.padStart(32, '0') }],
  ] as const)('is refused %s before the handler runs, and nothing is asked of the file system', async (channel, request) => {
    const h = setup();
    expect(await h.call(channel, request, PET)).toEqual({ ok: false, error: 'forbidden' });
    expect(h.asked()).toEqual([]);
    expect(h.showInFolder).not.toHaveBeenCalled();
    expect(h.openFolder).not.toHaveBeenCalled();
    expect(h.counts.snapshot()).toEqual({});
  });
});
