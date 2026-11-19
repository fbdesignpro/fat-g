// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The compiler already refuses a channel without a spec (INVOKE_SPECS is a mapped type over
// InvokeChannel). These tests pin the same facts at runtime, plus the preload's allowlist guards.
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS, PUSH_CHANNELS, WINDOW_KINDS, isInvokeChannel, isPushChannel } from './channels';
import { INVOKE_SPECS } from './contract';

describe('channel map', () => {
  it('has a spec for exactly the channels named in channels.ts', () => {
    expect(Object.keys(INVOKE_SPECS).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it.each(INVOKE_CHANNELS)('%s names at least one known window kind, and only known ones', (channel) => {
    const { from } = INVOKE_SPECS[channel];
    expect(from.length).toBeGreaterThan(0);
    for (const kind of from) expect(WINDOW_KINDS).toContain(kind);
  });

  it('keeps invoke and push names apart', () => {
    const overlap = INVOKE_CHANNELS.filter((name) => (PUSH_CHANNELS as readonly string[]).includes(name));
    expect(overlap).toEqual([]);
  });

  it('takes null — not undefined or an object — for state:getSnapshot', () => {
    const { request } = INVOKE_SPECS['state:getSnapshot'];
    expect(request.safeParse(null).success).toBe(true);
    for (const bad of [undefined, {}, 0, 'x']) expect(request.safeParse(bad).success).toBe(false);
  });
});

// M12 (C53, C82): records are the Main window's only, and every request is a strict object or null.
describe('the records channels', () => {
  const RECORDS_CHANNELS = INVOKE_CHANNELS.filter((channel) => /^(projects|records):|^prefs:(startFresh|retry)$/.test(channel));

  it('include the M12 channels, the saved project fold and the project folder opener', () => {
    expect(RECORDS_CHANNELS).toHaveLength(13);
  });

  it('takes a project id and a boolean for its saved fold', () => {
    const { request } = INVOKE_SPECS['projects:setCollapsed'];
    const id = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
    for (const collapsed of [true, false]) expect(request.safeParse({ id, collapsed }).success).toBe(true);
    for (const bad of [{ id }, { id, collapsed: 'false' }, { id: 'bad', collapsed: true }]) expect(request.safeParse(bad).success).toBe(false);
  });

  it.each(RECORDS_CHANNELS)('%s is the Main window’s only', (channel) => {
    expect(INVOKE_SPECS[channel].from).toEqual(['main']);
  });

  it.each(RECORDS_CHANNELS)('%s refuses an extra field', (channel) => {
    const { request } = INVOKE_SPECS[channel];
    expect(request.safeParse({ extra: true }).success).toBe(false);
    if (request.safeParse(null).success) return;
    expect(request.safeParse(undefined).success).toBe(false);
  });
});

// M14 (C31, C101): sessions and the quit answer are the Main window's only, each request strict.
describe('the session channels and the quit answer', () => {
  const SESSION_CHANNELS = INVOKE_CHANNELS.filter((channel) => /^sessions:|^app:answerQuit$/.test(channel));

  it('lists the session actions, local search and the quit answer, with no model setter', () => {
    expect(SESSION_CHANNELS).toEqual([
      'sessions:create', 'sessions:setDraftPreset', 'sessions:select', 'sessions:search', 'sessions:closeSearch', 'sessions:acknowledge', 'sessions:setFlag', 'sessions:rename', 'sessions:describeDraft', 'sessions:complete', 'sessions:shelve', 'sessions:restore', 'sessions:doing',
      'sessions:move', 'sessions:setEffort', 'sessions:setSpeed', 'sessions:remove', 'sessions:removeOrphans', 'app:answerQuit',
    ]);
  });

  // M14b, V20: the preload refuses whatever this answers false for, as an unknown channel.
  it('hold no channel that sets a session’s model', () => {
    expect(isInvokeChannel('sessions:setModel')).toBe(false);
    expect(Object.keys(INVOKE_SPECS)).not.toContain('sessions:setModel');
    expect(INVOKE_CHANNELS.filter((channel) => /model/i.test(channel))).toEqual([]);
  });

  it.each(SESSION_CHANNELS)('%s is the Main window’s only', (channel) => {
    expect(INVOKE_SPECS[channel].from).toEqual(['main']);
  });

  it.each(SESSION_CHANNELS)('%s refuses an extra field, and anything but its own request', (channel) => {
    const { request } = INVOKE_SPECS[channel];
    expect(request.safeParse({ extra: true }).success).toBe(false);
    expect(request.safeParse({ id: '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10', starred: true, before: null, model: 'm', effort: 'e', quit: true, extra: 1 }).success).toBe(false);
    expect(request.safeParse(undefined).success).toBe(false);
    if (channel !== 'sessions:removeOrphans' && channel !== 'sessions:closeSearch') expect(request.safeParse(null).success).toBe(false);
  });

  it('leaves app:quit as it was: a null request that only starts a quit', () => {
    expect(INVOKE_SPECS['app:quit'].request.safeParse(null).success).toBe(true);
    expect(INVOKE_SPECS['app:quit'].request.safeParse({ quit: true }).success).toBe(false);
  });
});

// M19b (C25, C43, C44): a file's text and path, and an address a message wrote, are the Main window's only.
describe('the file channels and the address channel (M19b)', () => {
  const SESSION = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
  const CHANNELS = ['files:read', 'files:refresh', 'files:refreshImage', 'files:showInFolder', 'shell:openAddress'] as const;

  it('takes only an image tab’s exact path, session and run id for image refresh', () => {
    const { request } = INVOKE_SPECS['files:refreshImage'];
    const valid = { sessionId: SESSION, path: 'C:\\tmp\\preview.png', id: 'a'.repeat(32) };
    expect(request.safeParse(valid).success).toBe(true);
    for (const bad of [{ ...valid, id: 'bad' }, { ...valid, path: '' }, { ...valid, from: 'C:\\tmp' }, { ...valid, revision: null }]) expect(request.safeParse(bad).success).toBe(false);
  });

  it('takes an exact refresh path and a finite revision, with no extra fields', () => {
    const { request } = INVOKE_SPECS['files:refresh'];
    const valid = { sessionId: SESSION, path: 'C:\\project\\README.md', revision: { mtimeMs: 1, size: 20 } };
    expect(request.safeParse(valid).success).toBe(true);
    expect(request.safeParse({ ...valid, revision: null }).success).toBe(true);
    for (const revision of [{ mtimeMs: NaN, size: 1 }, { mtimeMs: Infinity, size: 1 }, { mtimeMs: 0, size: -1 }, { mtimeMs: 0, size: 0.5 }, { mtimeMs: 0, size: 1, extra: true }]) {
      expect(request.safeParse({ ...valid, revision }).success).toBe(false);
    }
    expect(request.safeParse({ ...valid, from: 'C:\\project' }).success).toBe(false);
  });

  it.each(CHANNELS)('%s is the Main window’s only, and refuses null, nothing and an extra field', (channel) => {
    const { request, from } = INVOKE_SPECS[channel];
    expect(from).toEqual(['main']);
    for (const bad of [null, undefined, {}, { extra: true }, 'x']) expect(request.safeParse(bad).success).toBe(false);
  });

  it('takes a session, a target and, for a reference inside a file, that file: no base folder', () => {
    const { request } = INVOKE_SPECS['files:read'];
    expect(request.safeParse({ sessionId: SESSION, target: 'src/tides.js:12' }).success).toBe(true);
    expect(request.safeParse({ sessionId: SESSION, target: 'a.md', from: 'C:\\project\\README.md' }).success).toBe(true);
    expect(request.safeParse({ sessionId: SESSION, target: 'a.md', base: 'C:\\' }).success).toBe(false);
    expect(request.safeParse({ sessionId: 'not-an-id', target: 'a.md' }).success).toBe(false);
    expect(request.safeParse({ sessionId: SESSION, target: '' }).success).toBe(false);
    expect(request.safeParse({ sessionId: SESSION, target: 'a'.repeat(4097) }).success).toBe(false);
    expect(request.safeParse({ sessionId: SESSION, target: 'a'.repeat(4096) }).success).toBe(true);
  });

  it('takes a session and a path for Show in folder', () => {
    const { request } = INVOKE_SPECS['files:showInFolder'];
    expect(request.safeParse({ sessionId: SESSION, path: 'C:\\project\\README.md' }).success).toBe(true);
    expect(request.safeParse({ path: 'C:\\project\\README.md' }).success).toBe(false);
  });

  it('takes an address wider than main hands over, so that one over main’s bound reaches the handler', () => {
    const { request } = INVOKE_SPECS['shell:openAddress'];
    expect(request.safeParse({ address: `https://example.com/${'a'.repeat(3000)}` }).success).toBe(true);
    expect(request.safeParse({ address: 'x'.repeat(8193) }).success).toBe(false);
    expect(request.safeParse({ address: '' }).success).toBe(false);
    expect(request.safeParse({ address: 'https://example.com', providerId: 'codex' }).success).toBe(false);
  });

  it('leaves shell:openLink the channel by which no address crosses (M13, C25)', () => {
    expect(INVOKE_SPECS['shell:openLink'].request.safeParse({ providerId: 'codex', address: 'https://example.com' }).success).toBe(false);
  });
});

describe('allowlist guards (used by the preload)', () => {
  it('accept the declared channels', () => {
    for (const channel of INVOKE_CHANNELS) expect(isInvokeChannel(channel)).toBe(true);
    for (const channel of PUSH_CHANNELS) expect(isPushChannel(channel)).toBe(true);
  });

  it('do not confuse invoke and push channels', () => {
    expect(isInvokeChannel('state:snapshot')).toBe(false);
    expect(isPushChannel('state:getSnapshot')).toBe(false);
  });

  it.each(['', 'state:', 'STATE:GETSNAPSHOT', 'constructor', '__proto__', 'toString', null, undefined, 42, {}, ['state:getSnapshot']])(
    'reject %j',
    (value) => {
      expect(isInvokeChannel(value)).toBe(false);
      expect(isPushChannel(value)).toBe(false);
    },
  );
});
