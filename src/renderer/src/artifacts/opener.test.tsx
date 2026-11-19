// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V11, V24 (docs/planning/_archive/M19b.md; C20, C23, C24, C65): the page's one opener, on a fake bridge. An external
// address goes to main's channel for the browser, a local one to main's reader and then opens or
// selects a file's tab, or has main open the folder it names; each cause of a reference not opening
// comes back as its kind, and makes none. A reference's menu shows it in the file manager and copies
// its path by where main placed it.
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileReadAnswer, FileRefusal } from '@shared/contracts/files';
import type { InvokeChannel } from '@shared/ipc/channels';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { BUILT_IN_KINDS } from './kinds';
import { copyReferencePath, createOpener, FILE_KIND, openReference, showReference } from './opener';
import { registerKinds, resetTabs, tabId, useTabs } from './tabs-store';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const README = 'C:\\proj\\README.md';
const text = (path: string, overrides: Partial<Extract<FileReadAnswer, { outcome: 'text' }>> = {}): FileReadAnswer => ({ outcome: 'text', path, root: 'C:\\proj', view: 'markdown', text: '# Tide tools\n', revision: null, line: null, column: null, ...overrides });

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answers: Partial<Record<InvokeChannel, unknown>>;
beforeEach(() => {
  bridge = installFakeBridge('win32');
  requests = [];
  answers = {};
  resetTabs();
  registerKinds(BUILT_IN_KINDS);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    const answer = answers[channel];
    return Promise.resolve(answer === 'bad-request' ? { ok: false, error: 'bad-request' } : { ok: true, value: answer ?? null });
  });
});

const tabs = () => useTabs.getState().sessions[SESSION];

describe('an external address (C20, C23)', () => {
  it('goes to main’s channel at once, as it was written, and opens no tab', async () => {
    expect(await openReference(SESSION, 'https://example.com/docs?a=1#b')).toBeNull();
    expect(requests).toEqual([['shell:openAddress', { address: 'https://example.com/docs?a=1#b' }]]);
    expect(tabs()).toBeUndefined();
  });

  it('answers that it could not be opened when main refuses it', async () => {
    answers['shell:openAddress'] = 'bad-request';
    expect(await openReference(SESSION, 'https://user:secret@example.com/')).toBe('failed');
    expect(tabs()).toBeUndefined();
  });
});

describe('a local address (C20, C24)', () => {
  it('asks main to read it, naming the session and the address as written, and opens the file’s tab with what main answered', async () => {
    answers['files:read'] = text(README);
    expect(await openReference(SESSION, 'README.md')).toBeNull();
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'README.md' }]]);
    expect(tabs()?.tabs).toHaveLength(1);
    // The tab's reference is the file's real path, and the answer goes with it so that the opening reads once.
    expect(tabs()?.tabs[0]).toMatchObject({ id: tabId(FILE_KIND, README), kind: 'file', reference: README, title: 'README.md', handed: text(README), viewState: null });
    expect(tabs()?.selected).toBe(tabId(FILE_KIND, README));
  });

  it('names the page no base folder: only a reference inside a shown file names that file', async () => {
    answers['files:read'] = text('C:\\proj\\docs\\more.md');
    await openReference(SESSION, 'more.md', { from: 'C:\\proj\\docs\\guide.md' });
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'more.md', from: 'C:\\proj\\docs\\guide.md' }]]);
  });

  it('opens a tab for a file that shows no text, whose body says why', async () => {
    answers['files:read'] = { outcome: 'unshown', why: 'other-kind', path: 'C:\\proj\\photo.png', root: 'C:\\proj', line: null, column: null };
    expect(await openReference(SESSION, 'photo.png')).toBeNull();
    expect(tabs()?.tabs.map((tab) => tab.title)).toEqual(['photo.png']);
  });

  it('has main open a folder the reader refused to read, by the same claim, and makes no tab (decision 0022)', async () => {
    answers['files:read'] = { outcome: 'refused', why: 'folder' };
    expect(await openReference(SESSION, 'notes', { from: 'C:\\proj\\docs\\guide.md' })).toBeNull();
    const claim = { sessionId: SESSION, target: 'notes', from: 'C:\\proj\\docs\\guide.md' };
    expect(requests).toEqual([['files:read', claim], ['files:openFolder', claim]]);
    expect(tabs()).toBeUndefined();
    answers['files:openFolder'] = 'bad-request';
    expect(await openReference(SESSION, 'notes')).toBe('failed');
  });

  it.each(['outside', 'not-found', 'several', 'not-regular', 'no-answer'] satisfies FileRefusal[])('answers “%s” for a reference main refused, and makes no tab', async (why) => {
    answers['files:read'] = { outcome: 'refused', why };
    expect(await openReference(SESSION, '../elsewhere/secret.md')).toBe(why);
    expect(tabs()).toBeUndefined();
  });

  it('answers that it could not be opened when main could not be asked', async () => {
    answers['files:read'] = 'bad-request';
    expect(await openReference(SESSION, 'README.md')).toBe('failed');
    bridge.setInvoke(() => Promise.reject(new Error('window closing')));
    expect(await openReference(SESSION, 'README.md')).toBe('failed');
    expect(tabs()).toBeUndefined();
  });

  it('selects the tab of a file that is open, and moves its line', async () => {
    answers['files:read'] = text('C:\\proj\\src\\tides.js', { view: 'plain', line: 12 });
    await openReference(SESSION, 'src/tides.js:12');
    answers['files:read'] = text(README);
    await openReference(SESSION, 'README.md');
    expect(tabs()?.selected).toBe(tabId(FILE_KIND, README));
    const first = (tabs()?.tabs[0]?.viewState ?? {}) as { line?: number; serial?: number };
    expect(first.line).toBe(12);

    answers['files:read'] = text('C:\\proj\\src\\tides.js', { view: 'plain', line: 20, column: 4 });
    await openReference(SESSION, 'src/tides.js:20:4');
    expect(tabs()?.tabs.map((tab) => tab.title)).toEqual(['tides.js', 'README.md']);
    expect(tabs()?.selected).toBe(tabId(FILE_KIND, 'C:\\proj\\src\\tides.js'));
    const moved = (tabs()?.tabs[0]?.viewState ?? {}) as { line?: number; column?: number; serial?: number };
    expect([moved.line, moved.column]).toEqual([20, 4]);
    // Each naming is a new one to come to, the same line included.
    expect(moved.serial).toBeGreaterThan(first.serial ?? 0);
    await openReference(SESSION, 'src/tides.js:20:4');
    expect(((tabs()?.tabs[0]?.viewState ?? {}) as { serial?: number }).serial).toBeGreaterThan(moved.serial ?? 0);
  });

  it('rereads an image reference and refreshes its existing tab at every press', async () => {
    const path = 'C:\\proj\\updated.png';
    const image = { outcome: 'image', path, id: 'a'.repeat(32), width: 512, height: 700 };
    answers['files:read'] = image;
    await openReference(SESSION, path);
    const first = tabs()?.tabs[0]?.viewState as { serial: number };
    answers['files:read'] = { ...image, id: 'b'.repeat(32) };
    await openReference(SESSION, path);
    expect(requests).toEqual([
      ['files:read', { sessionId: SESSION, target: path }],
      ['files:read', { sessionId: SESSION, target: path }],
    ]);
    expect(tabs()?.tabs).toHaveLength(1);
    expect(tabs()?.tabs[0]?.viewState).toMatchObject({ display: { file: 'b'.repeat(32) } });
    const updated = tabs()?.tabs[0]?.viewState as { serial: number };
    expect(updated.serial).toBeGreaterThan(first.serial);
    // An unchanged result is also a fresh opening, so an earlier failed decode can retry.
    await openReference(SESSION, path);
    expect((tabs()?.tabs[0]?.viewState as { serial: number }).serial).toBeGreaterThan(updated.serial);
  });

  it('leaves an open file’s line where it is when a later reference names none', async () => {
    answers['files:read'] = text(README, { line: 7 });
    await openReference(SESSION, 'README.md:7');
    answers['files:read'] = text(README);
    await openReference(SESSION, 'README.md');
    expect((tabs()?.tabs[0]?.viewState as { line?: number }).line).toBe(7);
  });
});

describe('a line said in words beside a reference (V24; C65)', () => {
  const line = () => (tabs()?.tabs[0]?.viewState ?? {}) as { line?: number; column?: number | null; serial?: number };

  it('is come to where the address names none: main is asked for the address as it was written', async () => {
    answers['files:read'] = text('C:\\proj\\src\\tides.js', { view: 'plain' });
    expect(await openReference(SESSION, 'src/tides.js', { local: true, line: 12 })).toBeNull();
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'src/tides.js' }]]);
    expect([line().line, line().column]).toEqual([12, null]);
  });

  it('gives way to the line the address names, which main read', async () => {
    answers['files:read'] = text('C:\\proj\\src\\tides.js', { view: 'plain', line: 3, column: 2 });
    await openReference(SESSION, 'src/tides.js:3:2', { line: 12 });
    expect([line().line, line().column]).toEqual([3, 2]);
  });

  it('moves an open file’s line as a named one does, and comes from a control through the opener it was drawn with', async () => {
    answers['files:read'] = text(README);
    await createOpener(SESSION).open('README.md', 'local', 7);
    const first = line();
    expect(first.line).toBe(7);
    await createOpener(SESSION).open('README.md', 'local', 9);
    expect(line().line).toBe(9);
    expect(line().serial).toBeGreaterThan(first.serial ?? 0);
    // With none said, and none named, the line stays where it was.
    await createOpener(SESSION).open('README.md', 'local');
    expect(line().line).toBe(9);
  });

  it('is nothing to an address that opens in the browser', async () => {
    expect(await createOpener(SESSION).open('https://example.com/', 'external', 12)).toBeNull();
    expect(requests).toEqual([['shell:openAddress', { address: 'https://example.com/' }]]);
  });
});

describe('what an address is (C15, C19, C49)', () => {
  it('reads it with the host’s platform, as main does', async () => {
    answers['files:read'] = text(README);
    await openReference(SESSION, 'C:/proj/README.md');
    expect(requests[0]?.[0]).toBe('files:read');
  });

  it('asks nothing for an address that reads as neither: no control is made for one', async () => {
    for (const address of ['javascript:alert(1)', 'mailto:a@example.com', '#usage', '', 'data:text/html,x']) expect(await openReference(SESSION, address)).toBe('failed');
    expect(requests).toEqual([]);
  });

  it('takes a code span that reads as a path as a file, whatever its text reads as an address', async () => {
    // On a system that is not Windows a drive path is a one-letter scheme; a code span reads the same everywhere.
    bridge = installFakeBridge('linux');
    bridge.setInvoke((channel, request) => { requests.push([channel, request]); return Promise.resolve({ ok: true, value: { outcome: 'refused', why: 'not-found' } }); });
    expect(await openReference(SESSION, 'C:\\p\\a.md')).toBe('failed');
    expect(requests).toEqual([]);
    expect(await openReference(SESSION, 'C:\\p\\a.md', { local: true })).toBe('not-found');
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'C:\\p\\a.md' }]]);
  });

  it('opens a bare name with a line, which a URL’s syntax would call a scheme', async () => {
    answers['files:read'] = text('C:\\proj\\main.py', { view: 'plain', line: 10 });
    expect(await openReference(SESSION, 'main.py:10')).toBeNull();
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'main.py:10' }]]);
  });
});

describe('the opener a text is drawn with (C16)', () => {
  it('carries the platform and its session, and hands each press to the one opener', async () => {
    const opener = createOpener(SESSION);
    expect(opener.platform).toBe('win32');
    answers['files:read'] = text(README);
    expect(await opener.open('README.md', 'local')).toBeNull();
    expect(await opener.open('https://example.com/', 'external')).toBeNull();
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'README.md' }], ['shell:openAddress', { address: 'https://example.com/' }]]);
  });

  it('binds a shown file’s opener to that file', async () => {
    answers['files:read'] = text('C:\\proj\\docs\\more.md');
    await createOpener(SESSION, 'C:\\proj\\docs\\guide.md').open('more.md', 'local');
    expect(requests).toEqual([['files:read', { sessionId: SESSION, target: 'more.md', from: 'C:\\proj\\docs\\guide.md' }]]);
  });
});

describe('a reference’s menu (decision 0022)', () => {
  let written: string[];
  beforeEach(() => {
    written = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value: string) => { written.push(value); return Promise.resolve(); } } });
  });

  it('shows the file or folder main placed in the file manager, by the real path main answered', async () => {
    answers['files:locate'] = { outcome: 'folder', path: 'C:\\proj\\docs' };
    expect(await showReference(SESSION, './docs/', 'C:\\proj\\README.md')).toBeNull();
    expect(requests).toEqual([
      ['files:locate', { sessionId: SESSION, target: './docs/', from: 'C:\\proj\\README.md' }],
      ['files:showInFolder', { sessionId: SESSION, path: 'C:\\proj\\docs' }],
    ]);
  });

  it('copies the full path main placed, and nothing where main placed none', async () => {
    answers['files:locate'] = { outcome: 'file', path: README };
    expect(await copyReferencePath(SESSION, 'README.md')).toBeNull();
    expect(written).toEqual([README]);
    answers['files:locate'] = { outcome: 'refused', why: 'outside' };
    expect(await copyReferencePath(SESSION, '../elsewhere')).toBe('outside');
    expect(await showReference(SESSION, '../elsewhere')).toBe('outside');
    expect(written).toEqual([README]);
    expect(requests.filter(([channel]) => channel === 'files:showInFolder')).toEqual([]);
  });

  it('answers that it could not be done when main could not be asked or refused to show it', async () => {
    answers['files:locate'] = 'bad-request';
    expect(await copyReferencePath(SESSION, 'README.md')).toBe('failed');
    answers['files:locate'] = { outcome: 'file', path: README };
    answers['files:showInFolder'] = 'bad-request';
    expect(await showReference(SESSION, 'README.md')).toBe('failed');
  });
});
