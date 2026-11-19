// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V14 (docs/planning/_archive/M102.md, Design 4; C11, C13, C15, C16, C55, C56): a family's family.json, read on
// the recording stand-in — each refusal with its cause and the field at fault, unknown fields skipped,
// both match forms at their bounds, and the family a manifest makes of its folders. Since decision
// 0032 a manifest is at version 3, its overlay a version style and an effort style, and a family's
// name is its folder's.
import { describe, expect, it } from 'vitest';
import { isMatchKey, MANIFEST_MAX_BYTES, MANIFEST_VERSION } from '@shared/contracts/avatars';
import { familyShape, type ManifestReading, parseManifest, readManifest } from './manifest';
import { avatarStandIn } from './test-support';

const FILE = '/root/Orange/family.json';
const KNOWN = new Set(['claude', 'codex']);
const envelope = { schemaVersion: 1, minReaderVersion: 1 };
const BOM = String.fromCharCode(0xfeff);
const bytes = (content: string | object): Uint8Array => new TextEncoder().encode(typeof content === 'string' ? content : JSON.stringify(content));
const read = (content: string | object, reader = 1): Promise<ManifestReading> => readManifest(FILE, avatarStandIn({ [FILE]: bytes(content) }).fs, reader);

describe('a manifest refused whole (V14; C11, C55)', () => {
  it.each([
    ['too-large', `{"schemaVersion":1,"minReaderVersion":1,"pad":"${'x'.repeat(MANIFEST_MAX_BYTES)}"}`, 1, null],
    ['not-json', '{ "schemaVersion": 1, ', 1, null],
    ['damaged', { name: 'Orange' }, 1, null],
    ['damaged', { schemaVersion: 1, minReaderVersion: 2 }, 1, null],
    ['damaged', '[1, 2]', 1, null],
    ['newer', { schemaVersion: 2, minReaderVersion: 2 }, 1, null],
    ['older', { ...envelope }, 2, null],
    ['invalid', { ...envelope, author: 7 }, 1, 'author'],
    ['invalid', { ...envelope, provider: '' }, 1, 'provider'],
    ['invalid', { ...envelope, provider: 7 }, 1, 'provider'],
    ['invalid', { ...envelope, avatars: [{ folder: 'Op 5.5', matches: ['claude opus'] }] }, 1, 'avatars.0.matches.0'],
    ['invalid', { ...envelope, avatars: [{ folder: 'Op 5.5', matches: [{ provider: 'claude' }] }] }, 1, 'avatars.0.matches.0'],
    ['invalid', { ...envelope, avatars: [{ folder: 'Op 5.5', matches: ['x'.repeat(129)] }] }, 1, 'avatars.0.matches.0'],
    ['invalid', { ...envelope, avatars: [{ matches: [] }] }, 1, 'avatars.0.folder'],
    ['invalid', { ...envelope, avatars: { folder: 'Op 5.5' } }, 1, 'avatars'],
    ['invalid', { ...envelope, defaultFor: ['claude', 5] }, 1, 'defaultFor.1'],
    ['invalid', { ...envelope, defaultFor: Array.from({ length: 17 }, (_, index) => `p${index}`) }, 1, 'defaultFor'],
  ] as const)('as %s, with the field at fault', async (cause, content, reader, field) => {
    expect(await read(content, reader)).toEqual({ kind: 'refused', cause, field, code: null });
  });

  it('as unreadable when the system will not hand it over, with the error’s code and never its message', async () => {
    const standIn = avatarStandIn({ [FILE]: bytes(envelope) });
    standIn.failing.set(standIn.paths().find((candidate) => candidate.endsWith('family.json')) ?? '', 'EBUSY');
    expect(await readManifest(FILE, standIn.fs)).toEqual({ kind: 'refused', cause: 'unreadable', field: null, code: 'EBUSY' });
  });

  it('as unreadable when it is a link, which is never followed', async () => {
    const standIn = avatarStandIn({ [FILE]: { link: '/elsewhere/family.json' } });
    expect(await readManifest(FILE, standIn.fs)).toMatchObject({ kind: 'refused', cause: 'unreadable' });
    expect(standIn.calls.map((call) => call.op)).toEqual(['lstat']);
  });

  it('checks the size before reading a byte', async () => {
    const standIn = avatarStandIn({ [FILE]: new Uint8Array(MANIFEST_MAX_BYTES + 1) });
    expect(await readManifest(FILE, standIn.fs)).toMatchObject({ kind: 'refused', cause: 'too-large' });
    expect(standIn.calls.map((call) => call.op)).toEqual(['lstat']);
  });

  it('is none where there is no file', async () => {
    expect(await readManifest(FILE, avatarStandIn().fs)).toEqual({ kind: 'none' });
  });

  it('refuses a file of version 6 as older, and reads one of version 7, by this build’s own version', async () => {
    expect(MANIFEST_VERSION).toBe(7);
    expect(parseManifest(bytes({ schemaVersion: 6, minReaderVersion: 6 }))).toMatchObject({ kind: 'refused', cause: 'older' });
    expect(parseManifest(bytes({ schemaVersion: 7, minReaderVersion: 7 }))).toMatchObject({ kind: 'applied' });
    expect(await readManifest(FILE, avatarStandIn({ [FILE]: bytes({ schemaVersion: 6, minReaderVersion: 6 }) }).fs)).toMatchObject({ kind: 'refused', cause: 'older' });
  });
});

describe('a manifest applied (V14; C13, C15, C56)', () => {
  it.each(['any', 'claude', 'codex', 'future-provider'])('reads the family provider %s, with any as the default', async (provider) => {
    expect(await read({ ...envelope, provider })).toMatchObject({ kind: 'applied', manifest: { provider } });
    expect(await read(envelope)).toMatchObject({ kind: 'applied', manifest: { provider: 'any' } });
  });

  it('skips fields it does not know, at every level — a name an older file holds among them', async () => {
    const reading = await read({ ...envelope, name: 7, future: { x: 1 }, avatars: [{ folder: 'Op 5.5', mood: 'calm', matches: [{ provider: 'claude', key: 'claude-opus-*', weight: 2 }] }] });
    expect(reading).toMatchObject({ kind: 'applied', manifest: { avatars: [{ folder: 'Op 5.5' }] } });
  });

  it('takes both match forms, a key at its bound, and a manifest at its bound', async () => {
    const key = `${'a'.repeat(127)}*`;
    expect(isMatchKey(key)).toBe(true);
    expect(isMatchKey(`${key}x`)).toBe(false);
    const document = { ...envelope, avatars: [{ folder: 'Op 5.5', matches: ['claude-opus-4-*', key, { provider: 'codex', key: 'gpt-5.5' }] }] };
    const text = JSON.stringify(document);
    // Padded to the bound exactly with a field fat-g does not know.
    const padded = `${text.slice(0, -1)},"pad":"${'x'.repeat(MANIFEST_MAX_BYTES - text.length - 9)}"}`;
    expect(padded.length).toBe(MANIFEST_MAX_BYTES);
    expect(await read(padded)).toMatchObject({ kind: 'applied' });
  });

  // Decision 0032: an overlay is read field by field, never refusing the manifest.
  it('applies a manifest whose overlay holds fields of the wrong form', async () => {
    const reading = await read({ ...envelope, overlay: { size: 'big', color: 3 }, avatars: [{ folder: 'Op 5.5', overlay: 7 }] });
    expect(reading).toMatchObject({ kind: 'applied', manifest: { overlay: { size: 'big' }, avatars: [{ folder: 'Op 5.5', overlay: 7 }] } });
  });

  it('reads a manifest written with a byte-order mark', async () => {
    expect(await read(`${BOM}${JSON.stringify(envelope)}`)).toMatchObject({ kind: 'applied' });
  });
});

describe('the family a manifest makes (V14; C13, C15, C16)', () => {
  const FOLDERS = ['Default', 'Fa 5', 'Op 5.5', 'Zed'];
  const applied = (manifest: object): ManifestReading => ({ kind: 'applied', manifest: { provider: 'any', ...manifest } });

  it('without a manifest: its avatars by name, nothing more', () => {
    expect(familyShape({ kind: 'none' }, FOLDERS, KNOWN, 'Orange')).toMatchObject({ author: null, licence: null, order: FOLDERS, overlay: undefined, problems: [] });
  });

  it('with a refused manifest: the same, and the refusal named with its cause and field', () => {
    const shape = familyShape({ kind: 'refused', cause: 'invalid', field: 'author', code: null }, FOLDERS, KNOWN, 'Orange');
    expect(shape.order).toEqual(FOLDERS);
    expect(shape.problems).toEqual([{ kind: 'manifest', path: 'Orange/family.json', cause: 'invalid', field: 'author' }]);
  });

  it('its author and licence, its listed avatars first in the author’s order and the others after by name', () => {
    const shape = familyShape(applied({ name: '  The Orange family ', author: ' Someone ', licence: 'CC-BY-4.0', avatars: [{ folder: 'Op 5.5', matches: ['claude-opus-*'] }, { folder: 'Fa 5', matches: [{ provider: 'claude', key: 'claude-fable-5' }] }] }), FOLDERS, KNOWN, 'Orange');
    expect(shape).toMatchObject({ author: 'Someone', licence: 'CC-BY-4.0', order: ['Op 5.5', 'Fa 5', 'Default', 'Zed'], problems: [] });
    // A family's name is its folder's: a manifest's is no longer shown.
    expect(shape).not.toHaveProperty('name');
    // Structured, in the manifest's order (M104, C2).
    expect(Object.fromEntries(shape.matches)).toEqual({ 'Op 5.5': [{ provider: null, key: 'claude-opus-*' }], 'Fa 5': [{ provider: 'claude', key: 'claude-fable-5' }] });
  });

  it('reports an avatar listed with no folder, the rest applying', () => {
    const shape = familyShape(applied({ avatars: [{ folder: 'Gone' }, { folder: 'Op 5.5' }], defaultFor: ['claude'] }), FOLDERS, KNOWN, 'Orange');
    expect(shape.problems).toEqual([{ kind: 'listed-missing', path: 'Orange/Gone' }]);
    expect(shape.order).toEqual(['Op 5.5', 'Default', 'Fa 5', 'Zed']);
    expect(shape.defaultFor).toEqual(['claude']);
  });

  it('reads the providers whose starting family it is, in its order and once each; none without a manifest', () => {
    expect(familyShape(applied({ defaultFor: ['codex', 'claude', 'codex'] }), FOLDERS, KNOWN, 'Orange').defaultFor).toEqual(['codex', 'claude']);
    expect(familyShape(applied({}), FOLDERS, KNOWN, 'Orange').defaultFor).toEqual([]);
    expect(familyShape({ kind: 'none' }, FOLDERS, KNOWN, 'Orange').defaultFor).toEqual([]);
    // A `defaultFaces` an earlier draft of the format held is an unknown field: skipped, reported nowhere.
    const older = familyShape(applied({ defaultFaces: { claude: 'Missing' } }), FOLDERS, KNOWN, 'Orange');
    expect([older.defaultFor, older.problems]).toEqual([[], []]);
  });

  it('keeps the family’s and each avatar’s overlay fields of their form, and names the others by their path', () => {
    const shape = familyShape(applied({
      overlay: { version: { preset: 'glow', size: 99, textColor: 'red', parts: { name: true, version: 'yes' }, future: 1 }, effort: { position: 'top', size: 40 }, future: 2 },
      avatars: [
        { folder: 'Gone', overlay: { version: { size: 1 } } },
        { folder: 'Op 5.5', overlay: { version: { parts: { version: false } }, effort: { color: '#fff' } } },
        { folder: 'Fa 5', overlay: 'none' },
        { folder: 'Zed', overlay: { effort: 'dots' } },
      ],
    }), FOLDERS, KNOWN, 'Orange');
    expect(shape.overlay).toEqual({ version: { preset: 'glow', parts: { name: true } }, effort: { position: 'top' } });
    expect(Object.fromEntries(shape.overlays)).toEqual({ 'Op 5.5': { version: { parts: { version: false } }, effort: { color: '#fff' } }, 'Fa 5': {}, Zed: {} });
    expect(shape.problems).toEqual([
      { kind: 'listed-missing', path: 'Orange/Gone' },
      { kind: 'overlay-field', path: 'Orange/family.json', fields: ['overlay.version.size', 'overlay.version.textColor', 'overlay.version.parts.version', 'overlay.effort.size', 'avatars.2.overlay', 'avatars.3.overlay.effort'] },
    ]);
  });

  // Decision 0032: the fast bolt's place, a field of the marks' style read as any other.
  it('keeps the fast bolt’s place among the marks’ fields, names one of the wrong form, and reads a file without it as it was', () => {
    const shape = familyShape(applied({ overlay: { effort: { fastPosition: 'bottom-left', show: false } }, avatars: [{ folder: 'Zed', overlay: { effort: { fastPosition: 'centre', size: 9 } } }] }), FOLDERS, KNOWN, 'Orange');
    expect(shape.overlay).toEqual({ effort: { fastPosition: 'bottom-left', show: false } });
    expect(Object.fromEntries(shape.overlays)).toEqual({ Zed: { effort: { size: 9 } } });
    expect(shape.problems).toEqual([{ kind: 'overlay-field', path: 'Orange/family.json', fields: ['avatars.0.overlay.effort.fastPosition'] }]);
    // A file of this version written before the field came is applied, with nothing to name.
    expect(parseManifest(bytes({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, overlay: { effort: { position: 'top' } } }))).toMatchObject({ kind: 'applied' });
    expect(familyShape(applied({ overlay: { effort: { position: 'top' } } }), FOLDERS, KNOWN, 'Orange').problems).toEqual([]);
  });

  it('keeps a provider this build does not register, unused, and names it once', () => {
    const shape = familyShape(applied({ defaultFor: ['gemini', 'claude', 'gemini'] }), FOLDERS, KNOWN, 'Orange');
    expect(shape.unknownProviders).toEqual(['gemini']);
    expect(shape.defaultFor).toEqual(['claude']);
    expect(shape.problems).toEqual([]);
  });

  it('takes an avatar listed twice once, where it is first listed', () => {
    const shape = familyShape(applied({ avatars: [{ folder: 'Zed', matches: ['a'] }, { folder: 'Fa 5' }, { folder: 'Zed', matches: ['b'] }] }), FOLDERS, KNOWN, 'Orange');
    expect(shape.order).toEqual(['Zed', 'Fa 5', 'Default', 'Op 5.5']);
    expect(shape.matches.get('Zed')).toEqual([{ provider: null, key: 'a' }]);
  });
});
