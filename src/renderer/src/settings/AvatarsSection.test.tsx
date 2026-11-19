// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Settings' Avatars tab (decisions 0031, 0032): the family assignment — a button a provider, opening its
// family assignment popup — and the families, a row a family, opening the family editor; on a fake
// bridge that answers `avatars:list`, `avatars:family`, `avatars:saveFamily` and `avatars:addAvatar`
// from what the test holds and records each call. The page's making of an added image is a stand-in:
// avatar-image.test.ts tests it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddAvatarAnswer, ChooseImageAnswer, CopyFamilyAnswer, CreateFamilyAnswer, FamilySource, ReplaceImageAnswer, SaveFamilyAnswer } from '@shared/contracts/avatar-family';
import { DEFAULT_EFFORT_LOOK, type OverlayLayer, resolveOverlay } from '@shared/contracts/avatar-overlay';
import { type ActiveFamilies, type Assignments, AVATAR_WORDS, type AvatarFileView, type AvatarListing, type AvatarRef, type AvatarView, type FamilyRef, type FamilyView, type ResolvedAvatar } from '@shared/contracts/avatars';
import type { CatalogState } from '@shared/contracts/catalog';
import { applyPatch, type PreferencesPatch, type PreferencesSnapshot } from '@shared/contracts/prefs';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { SAMPLE_CATALOG_PATH, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { usePrefs } from '../state/prefs-store';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { showState } from '../test/sessions';
import { ASSIGN_POPUP_WORDS } from './AssignAvatarPopup';
import { AVATARS_TAB_TEXT, AvatarsSection } from './AvatarsSection';
import { ASSIGNMENT_WORDS } from './avatar-assignment-words';
import { type PreparedImage, prepareAvatarImage, prepareSmallImage } from './avatar-image';
import { EDITOR_WORDS } from './FamilyEditorDialog';
import { CREATE_FAMILY_WORDS } from './CreateFamilyFromImage';
import { STYLE_WORDS } from './StyleControls';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let listing: AvatarListing;
let failing: Set<InvokeChannel>;
/** What main holds, and answers a patch from; `refusing` answers it unchanged, as a refused write does. */
let saved: PreferencesSnapshot;
let refusing: boolean;
/** Each family's file as main reads it, by `<origin>/<folder>`. */
let sources: Map<string, FamilySource>;
/** What main answers the next saves with; a save past them is saved. */
let saveAnswers: SaveFamilyAnswer[];
let copyAnswer: CopyFamilyAnswer;
let createAnswer: CreateFamilyAnswer;
let addAnswer: AddAvatarAnswer;
let replaceAnswer: ReplaceImageAnswer;
let chooseAnswer: ChooseImageAnswer;

vi.mock('./avatar-image', () => ({ prepareAvatarImage: vi.fn(), prepareSmallImage: vi.fn() }));

const id = (n: number): string => String(n).padStart(32, '0');
const file = (n: number, role: 'portrait' | 'small', format: 'png' | 'webp', side: number): AvatarFileView => ({ id: id(n), role, format, width: side, height: side, bytes: 1000 });
const avatar = (folder: string, extra: Partial<AvatarView> = {}): AvatarView => ({ folder, files: [], unused: [], matches: [], problems: [], fallback: false, ...extra });
const family = (folder: string, origin: 'built-in' | 'user', avatars: readonly AvatarView[], extra: Partial<FamilyView> = {}): FamilyView => ({ origin, folder, provider: 'any', author: null, licence: null, defaultFor: [], unknownProviders: [], problems: [], avatars, ...extra });

// Each family's default is its `Default` folder, listed first; a built-in family names the providers it starts.
const ORANGE = family('Orange', 'built-in', [
  avatar('Default', { files: [file(3, 'portrait', 'webp', 512)], fallback: true }),
  avatar('Op 5.5', { files: [file(1, 'portrait', 'webp', 512), file(2, 'small', 'webp', 64)], matches: [{ provider: null, key: 'claude-opus-*' }, { provider: 'claude', key: 'opus' }] }),
], { defaultFor: ['claude'] });
const BLUE = family('Blue', 'built-in', [avatar('Default', { files: [file(4, 'portrait', 'webp', 512)], fallback: true })], { author: 'Someone', licence: 'CC-BY-4.0', defaultFor: ['codex'] });
const MOONS = family('Moons', 'user', [
  avatar('Default', { files: [file(10, 'portrait', 'webp', 512)], fallback: true }),
  avatar('Luna', { files: [file(7, 'portrait', 'webp', 512)], matches: [{ provider: null, key: '*sonnet*' }] }),
  avatar('Night', { files: [file(8, 'portrait', 'webp', 512)] }),
]);
/** Moons as it stands without its `Default` folder: listed, never chosen. */
const BARE_MOONS = family('Moons', 'user', MOONS.avatars.filter((view) => view.folder !== 'Default'), { problems: [{ kind: 'no-default', path: 'Moons' }] });

const REVISION = 'a'.repeat(64);
const MOONS_REF: FamilyRef = { origin: 'user', family: 'Moons' };
/** Moons' file: the family default's style, Luna's match, an entry whose folder is gone, and Night; its `Default` folder no entry of it. */
const MOONS_SOURCE: FamilySource = {
  ref: MOONS_REF,
  lock: null,
  revision: REVISION,
  draft: {
    provider: 'any',
    overlay: { version: { preset: 'glow' } },
    avatars: [{ folder: 'Luna', matches: ['*sonnet*'], overlay: {} }, { folder: 'Gone', matches: ['old-*'], overlay: {} }, { folder: 'Night', matches: [], overlay: {} }],
  },
  missing: ['Gone'],
};

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  failing = new Set();
  listing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [], problems: [] }] };
  saved = prefsSnapshot();
  refusing = false;
  sources = new Map([['user/Moons', MOONS_SOURCE]]);
  saveAnswers = [];
  copyAnswer = { kind: 'failed' };
  createAnswer = { kind: 'failed' };
  addAnswer = { kind: 'failed' };
  replaceAnswer = { kind: 'failed' };
  chooseAnswer = { kind: 'cancelled' };
  usePrefs.setState({ snapshot: null, error: null, saving: false });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (failing.has(channel)) return Promise.resolve({ ok: false, error: 'internal' });
    if (channel === 'prefs:patch') {
      if (!refusing) saved = prefsSnapshot(applyPatch(saved.values, request as PreferencesPatch), saved.status, saved.rev + 1);
      return Promise.resolve({ ok: true, value: saved });
    }
    if (channel === 'avatars:family') {
      const ref = request as FamilyRef;
      return Promise.resolve({ ok: true, value: sources.get(`${ref.origin}/${ref.family}`) ?? null });
    }
    if (channel === 'avatars:saveFamily') return Promise.resolve({ ok: true, value: saveAnswers.shift() ?? { kind: 'saved' } });
    if (channel === 'avatars:copyFamily') {
      if (copyAnswer.kind === 'copied') listing = copyAnswer.listing;
      return Promise.resolve({ ok: true, value: copyAnswer });
    }
    if (channel === 'avatars:createFamily') {
      if (createAnswer.kind === 'created') listing = createAnswer.listing;
      return Promise.resolve({ ok: true, value: createAnswer });
    }
    if (channel === 'avatars:replaceImage') {
      if (replaceAnswer.kind === 'replaced') listing = replaceAnswer.listing;
      return Promise.resolve({ ok: true, value: replaceAnswer });
    }
    if (channel === 'avatars:chooseImage') return Promise.resolve({ ok: true, value: chooseAnswer });
    if (channel === 'avatars:addAvatar') {
      if (addAnswer.kind === 'added') listing = addAnswer.listing;
      return Promise.resolve({ ok: true, value: addAnswer });
    }
    return Promise.resolve({ ok: true, value: channel === 'avatars:list' ? listing : null });
  });
});
afterEach(cleanup);

const settle = () => act(async () => { for (let step = 0; step < 4; step += 1) await Promise.resolve(); });
const section = () => screen.getByRole('tabpanel');
const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const root = (origin: 'built-in' | 'user') => section().querySelector<HTMLElement>(`[data-avatar-root="${origin}"]`) as HTMLElement;
const familyButton = (folder: string, origin = 'built-in') => section().querySelector<HTMLButtonElement>(`[data-avatar-family="${folder}"][data-origin="${origin}"]`) as HTMLButtonElement;
const familyRow = (folder: string, origin = 'built-in') => (familyButton(folder, origin)?.closest<HTMLElement>('[data-family-card]') ?? null) as HTMLElement;
const providerButton = (providerId: string) => section().querySelector<HTMLButtonElement>(`[data-family-provider="${providerId}"]`) as HTMLButtonElement;
const providerCard = (providerId: string) => providerButton(providerId).closest<HTMLElement>('[data-family-card]') as HTMLElement;

async function open() {
  act(() => { showState({ providers: [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
  render(<AvatarsSection />);
  await settle();
}

describe('the tab', () => {
  it('shows the family assignment, then the families, each under its heading', async () => {
    await open();
    const order = [...section().querySelectorAll<HTMLElement>('[data-family-assignments], [data-avatar-families]')].map((element) => element.querySelector('h4')?.textContent);
    expect(order).toEqual([AVATARS_TAB_TEXT.assignment, AVATARS_TAB_TEXT.families]);
    expect(section().textContent).not.toContain(AVATAR_WORDS.layout);
    const families = within(section()).getByRole('region', { name: AVATARS_TAB_TEXT.families });
    expect(within(families).getByRole('button', { name: /Drag an image here to start a new family/ }).getAttribute('aria-haspopup')).toBe('dialog');
    expect(within(section()).getByRole('button', { name: 'Rescan' })).toBeTruthy();
    expect(within(section()).getByRole('button', { name: 'Show avatars folder' })).toBeTruthy();
  });

  it('asks for the listing when shown, and again after a Rescan has landed', async () => {
    await open();
    expect(asked('avatars:list')).toEqual([null]);
    listing = { roots: [listing.roots[0] ?? { origin: 'built-in', families: [], problems: [] }, { origin: 'user', families: [family('Mine', 'user', [avatar('Me')])], problems: [] }] };
    fireEvent.click(within(section()).getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(asked('avatars:rescan')).toEqual([null]);
    expect(asked('avatars:list')).toEqual([null, null]);
    expect(familyRow('Mine', 'user')).not.toBeNull();
  });

  it('says so when a Rescan fails, and keeps the listing it has', async () => {
    await open();
    failing.add('avatars:rescan');
    fireEvent.click(within(section()).getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(within(section()).getByRole('status').textContent).toBe(AVATARS_TAB_TEXT.rescanFailed);
    expect(familyRow('Orange')).not.toBeNull();
  });

  it('asks main to show the avatars folder by name, never a path', async () => {
    await open();
    fireEvent.click(within(section()).getByRole('button', { name: 'Show avatars folder' }));
    await settle();
    expect(asked('shell:showDataFolder')).toEqual([{ folder: 'avatars' }]);
    expect(within(section()).getByRole('status').textContent).toBe(AVATARS_TAB_TEXT.opened);
    failing.add('shell:showDataFolder');
    fireEvent.click(within(section()).getByRole('button', { name: 'Show avatars folder' }));
    await settle();
    expect(within(section()).getByRole('status').textContent).toBe(AVATARS_TAB_TEXT.notOpened);
  });

  it('says it could not list them when main does not answer', async () => {
    failing.add('avatars:list');
    await open();
    expect(section().textContent).toContain(AVATARS_TAB_TEXT.unread);
  });
});

// ── The family assignment's buttons ───────────────────────────────────────────────────────────
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const OP: AvatarRef = { origin: 'built-in', family: 'Orange', avatar: 'Op 5.5' };
const FACE: AvatarRef = { origin: 'built-in', family: 'Orange', avatar: 'Default' };
const MINE: AvatarRef = { origin: 'user', family: 'Orange', avatar: 'Mine' };
const SKETCH: AvatarRef = { origin: 'built-in', family: 'Orange', avatar: 'Sketch' };
const BLUE_FACE: AvatarRef = { origin: 'built-in', family: 'Blue', avatar: 'Default' };

/** Both roots hold an Orange family; the built-in one has an avatar with no usable portrait, the user's no `Default` folder. */
const ASSIGNING: AvatarListing = {
  roots: [
    { origin: 'built-in', families: [BLUE, { ...ORANGE, avatars: [...ORANGE.avatars, avatar('Sketch', { files: [file(5, 'small', 'png', 64)], problems: [{ kind: 'no-portrait', path: 'Orange/Sketch' }] })] }], problems: [] },
    { origin: 'user', families: [family('Orange', 'user', [avatar('Mine', { files: [file(9, 'portrait', 'png', 256)] })], { problems: [{ kind: 'no-default', path: 'Orange' }] })], problems: [] },
  ],
};

const model = (key: string, name: string, extra: Parameters<typeof sampleModel>[0] = {}) => sampleModel({ key, name, resolvedId: key, listedDefault: false, ...extra });
/** What main resolved for Opus: Orange's card, its version over it and Medium's look for the marks. */
const OPUS_DRAWN: ResolvedAvatar = { ref: OP, portrait: id(1), small: id(2), source: 'match', overlay: resolveOverlay([], { name: 'Opus', version: '5.5' }) };
/** Claude's first account lists its default and the row naming the same model, and a hidden one; its second, another. */
const CATALOG: CatalogState = {
  providers: [
    sampleCatalogProvider({ id: 'claude', models: [model('default', 'Default (Opus 5.5)', { resolvedId: 'claude-opus-5-5', listedDefault: true, label: { version: '5.5', name: 'Opus' } }), model('opus', 'Opus 5.5', { resolvedId: 'claude-opus-5-5', label: { version: '5.5', name: 'Opus' } }), model('sonnet', 'Sonnet 5', { label: { version: '5', name: 'Sonnet' } }), model('haiku', 'Haiku 5', { hidden: true })] }),
    sampleCatalogProvider({ id: 'claude', instanceId: WORK, models: [model('sonnet', 'Sonnet 5'), model('fable', 'Fable 5.1')] }),
    sampleCatalogProvider({ id: 'codex', models: [model('gpt-6-sol', 'GPT-6 Sol')] }),
  ],
  override: { kind: 'none', path: SAMPLE_CATALOG_PATH },
};
/** The same, with Opus as main resolved it with no override: Orange's card, by the family's search. */
const DRAWN_CATALOG: CatalogState = { ...CATALOG, providers: CATALOG.providers.map((entry, index) => (index === 0 ? { ...entry, models: entry.models.map((item) => (item.key === 'opus' ? { ...item, avatar: OPUS_DRAWN } : item)) } : entry)) };
const PROVIDERS = [sampleProvider(), sampleProvider({ instanceId: WORK, label: 'Work' }), sampleProvider({ id: 'codex', displayName: 'Codex' })];

async function openScreen(assignments: Assignments = {}, catalog: CatalogState = CATALOG, providers = PROVIDERS, active: ActiveFamilies = {}, shown: AvatarListing = ASSIGNING) {
  saved = prefsSnapshot({ avatars: { assignments, active } });
  usePrefs.setState({ snapshot: saved });
  listing = shown;
  act(() => { showState({ providers, catalog }); });
  render(<AvatarsSection />);
  await settle();
}

describe('the providers’ buttons', () => {
  it('draws each provider name beside its whole family, with capsules and Medium marks', async () => {
    await openScreen({}, DRAWN_CATALOG);
    const claude = providerCard('claude');
    expect(providerButton('claude').getAttribute('aria-label')).toBe(AVATARS_TAB_TEXT.chooseFamily('Claude', 'Orange'));
    expect(claude.querySelector('[data-family-name]')?.textContent).toBe('Orange');
    expect(claude.parentElement?.querySelector('h5')?.textContent).toBe('Claude');
    expect([...claude.querySelectorAll<HTMLElement>('[data-family-capsule]')].map((item) => item.dataset['familyCapsule'])).toEqual(['Op 5.5', 'Sketch', 'Default']);
    const drawn = claude.querySelector<HTMLElement>('[data-family-capsule="Op 5.5"] [data-avatar]') as HTMLElement;
    expect(drawn.dataset['size']).toBe('capsule');
    expect(drawn.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(1)}`);
    expect(drawn.querySelector('[data-overlay-version]')?.textContent).toBe('5.5');
    expect(drawn.querySelector('[data-effort-marks]')?.getAttribute('data-effort-marks')).toBe('2');
    // One a provider, its accounts aside.
    expect([...section().querySelectorAll<HTMLElement>('[data-family-provider]')].map((element) => element.dataset['familyProvider'])).toEqual(['claude', 'codex']);
  });

  it('draws the family default before the CLI has reported, and names the family the user chose', async () => {
    await openScreen({}, { providers: [], override: { kind: 'none', path: SAMPLE_CATALOG_PATH } }, PROVIDERS, { claude: { origin: 'user', family: 'Moons' } }, { roots: [ASSIGNING.roots[0] as never, { origin: 'user', families: [MOONS], problems: [] }] });
    const claude = providerCard('claude');
    expect(claude.querySelector('[data-family-name]')?.textContent).toBe('Moons');
    expect(claude.querySelector('[data-family-capsule="Default"] img')?.getAttribute('src')).toBe(`app://media/avatars/${id(10)}`);
    expect(claude.querySelector('[data-effort-marks]')?.getAttribute('data-effort-marks')).toBe('2');
    expect(providerCard('codex').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(4)}`);
    expect(providerCard('codex').querySelector('[data-family-name]')?.textContent).toBe('Blue');
  });

  it('says where no provider is registered', async () => {
    await openScreen({}, CATALOG, []);
    expect(section().textContent).toContain(AVATARS_TAB_TEXT.noProviders);
  });

  it('edits a provider’s active family directly without opening assignment or changing its selection', async () => {
    await openScreen();
    fireEvent.click(within(providerCard('claude')).getByRole('button', { name: 'Edit family Orange' }));
    await settle();
    expect(asked('avatars:family')).toEqual([{ origin: 'built-in', family: 'Orange' }]);
    expect(document.querySelector<HTMLDialogElement>('dialog[data-family-editor="Orange"]')?.open).toBe(true);
    expect(document.querySelector('dialog[data-family-assignment][open]')).toBeNull();
    expect(patches()).toEqual([]);
  });
});

// ── The families ──────────────────────────────────────────────────────────────────────────────
describe('the families', () => {
  it('lists the user’s families first under Custom, then the built-in ones under Built-in, each by name with its author and licence', async () => {
    const mine = (name: string) => family(name, 'user', [avatar('Mine', { files: [file(9, 'portrait', 'png', 256)] })]);
    listing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [mine('Apples'), mine('Orange')], problems: [] }] };
    await open();
    const order = [...section().querySelectorAll<HTMLElement>('[data-avatar-family]')].map((element) => `${element.dataset['origin'] ?? ''}:${element.dataset['avatarFamily'] ?? ''}`);
    expect(order).toEqual(['user:Apples', 'user:Orange', 'built-in:Blue', 'built-in:Orange']);
    expect([...section().querySelectorAll<HTMLElement>('[data-family-group]')].map((heading) => heading.textContent)).toEqual([AVATARS_TAB_TEXT.custom, AVATAR_WORDS.builtIn]);
    expect(root('user').getAttribute('aria-labelledby')).toBe(root('user').querySelector('[data-family-group]')?.id);
    // The origin is the group's: each row's line says its author and licence alone.
    expect(familyRow('Blue').textContent).toContain('Someone · CC-BY-4.0');
    expect(familyRow('Blue').textContent).not.toContain(AVATAR_WORDS.builtIn);
    expect(familyRow('Orange', 'user').textContent).not.toContain(AVATAR_WORDS.user);
    expect(familyButton('Blue').getAttribute('aria-label')).toBe(AVATARS_TAB_TEXT.openFamily('Blue'));
  });

  it('draws every avatar of a family as a capsule in its style, with the texts of a model it suits and Medium’s marks', async () => {
    const styled = { ...ORANGE, overlay: { version: { preset: 'glow' as const } } };
    await openScreen({}, CATALOG, PROVIDERS, {}, { roots: [{ origin: 'built-in', families: [BLUE, styled], problems: [] }, { origin: 'user', families: [], problems: [] }] });
    const capsules = [...familyRow('Orange').querySelectorAll<HTMLElement>('[data-family-capsule]')];
    expect(capsules.map((element) => element.dataset['familyCapsule'])).toEqual(['Op 5.5', 'Default']);
    const op = capsules[0] as HTMLElement;
    expect(op.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('capsule');
    expect(op.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(1)}`);
    // Opus is the model its entry `claude: opus` takes: its version, in the family's glow.
    expect(op.querySelector('[data-overlay-version]')?.textContent).toBe('5.5');
    expect(op.querySelector<HTMLElement>('[data-overlay]')?.dataset['effect']).toBe('glow');
    expect(op.querySelector('[data-effort-marks]')?.getAttribute('data-effort-marks')).toBe('2');
    // The family default: the first model nothing matches, Sonnet.
    expect(capsules[1]?.querySelector('[data-overlay-version]')?.textContent).toBe('5');
  });

  it('shows no Custom group where the user has no family, and shows it for a root problem alone', async () => {
    await open();
    expect(section().querySelector('[data-avatar-root="user"]')).toBeNull();
    expect([...section().querySelectorAll<HTMLElement>('[data-family-group]')].map((heading) => heading.textContent)).toEqual([AVATAR_WORDS.builtIn]);
    cleanup();
    listing = { roots: [{ origin: 'built-in', families: [BLUE], problems: [] }, { origin: 'user', families: [], problems: [{ kind: 'root-unreadable', path: '' }] }] };
    await open();
    expect(root('user').querySelector('[data-family-group]')?.textContent).toBe(AVATARS_TAB_TEXT.custom);
    expect(root('user').querySelector('[data-problem="root-unreadable"]')).not.toBeNull();
  });

  it('counts a family’s problems and says the first, and lists its root’s, each naming its file relative to its root', async () => {
    listing = {
      roots: [
        { origin: 'built-in', families: [ORANGE], problems: [] },
        {
          origin: 'user',
          families: [family('Broken', 'user', [avatar('Wide', { problems: [{ kind: 'not-square', path: 'Broken/Wide/portrait.png' }, { kind: 'no-portrait', path: 'Broken/Wide' }] })], { problems: [{ kind: 'manifest', path: 'Broken/family.json', cause: 'invalid', field: 'avatars.0.matches.0' }] })],
          problems: [{ kind: 'stopped', path: 'Photos' }],
        },
      ],
    };
    await open();
    expect([...root('user').querySelectorAll('[data-problem]')].map((item) => [item.getAttribute('data-problem'), item.textContent])).toEqual([
      ['stopped', 'The scan stopped at 2,000 entries, in Photos: what follows is not listed'],
    ]);
    expect(familyRow('Broken', 'user').textContent).toContain('3 problems: Broken/family.json holds a field of the wrong form (avatars.0.matches.0), so the family stands as its folders');
    // An avatar with no portrait is still a capsule: the placeholder alone.
    expect(familyRow('Broken', 'user').querySelector('[data-family-capsule="Wide"] img')).toBeNull();
    expect(root('user').textContent).not.toContain(AVATAR_WORDS.noneYet);
  });

  it('opens the family editor at a press, asking main for the family by its reference', async () => {
    await open();
    fireEvent.click(within(root('built-in')).getByRole('button', { name: 'Edit family Orange' }));
    await settle();
    expect(asked('avatars:family')).toEqual([{ origin: 'built-in', family: 'Orange' }]);
    expect(document.querySelector('dialog[data-family-editor="Orange"]')?.hasAttribute('open')).toBe(true);
  });
});

// ── The family assignment popup and Assign avatar ─────────────────────────────────────────────
const popupBox = () => document.querySelector<HTMLDialogElement>('dialog[data-family-assignment]');
const assignmentBox = () => (popupBox() as HTMLDialogElement).querySelector<HTMLElement>('[data-avatar-assignments]') as HTMLElement;
const modelRows = () => [...assignmentBox().querySelectorAll<HTMLElement>('[data-assignment-row]')];
const keys = () => modelRows().map((element) => element.dataset['assignmentRow']);
const modelRow = (key: string) => assignmentBox().querySelector<HTMLElement>(`[data-assignment-row="${key}"]`) as HTMLElement;
const label = (key: string) => modelRow(key).getAttribute('aria-label');
const control = (name: string) => within(assignmentBox()).getByRole<HTMLButtonElement>('button', { name });
const familyChoices = () => [...assignmentBox().querySelectorAll<HTMLButtonElement>('[data-family-choice]')];
const selectedFamily = () => familyChoices().find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset['familyChoice'];
const chooseFamily = (key: string) => fireEvent.click(familyChoices().find((button) => button.dataset['familyChoice'] === key) as HTMLButtonElement);
const strip = () => [...assignmentBox().querySelectorAll<HTMLElement>('[data-assigned-strip] [data-family-capsule]')].map((capsule) => capsule.dataset['familyCapsule']);
const patches = () => asked('prefs:patch');
const openFamilyPopup = (providerId = 'claude') => fireEvent.click(providerButton(providerId));
const overrideBox = () => document.querySelector<HTMLDialogElement>('dialog[data-avatar-overrides]') as HTMLDialogElement;
const openPopup = (providerId = 'claude') => {
  openFamilyPopup(providerId);
  fireEvent.click(control(ASSIGNMENT_WORDS.overrideTitle));
};
const closePopup = () => {
  if (overrideBox()?.open) fireEvent.click(overrideBox().querySelector('header button') as HTMLButtonElement);
  fireEvent.click(popupBox()?.querySelector('header button') as HTMLButtonElement);
};

describe('the family assignment popup (decision 0031)', () => {
  it('offers any-provider families and only the current provider’s scoped families, falling back from an incompatible selection', async () => {
    const scoped: AvatarListing = { roots: [
      { origin: 'built-in', families: [{ ...BLUE, provider: 'codex' }, { ...ORANGE, provider: 'claude' }], problems: [] },
      { origin: 'user', families: [MOONS], problems: [] },
    ] };
    await openScreen({}, CATALOG, PROVIDERS, { claude: { origin: 'built-in', family: BLUE.folder } }, scoped);
    openFamilyPopup();
    expect(familyChoices().map((button) => button.dataset['familyChoice'])).toEqual(['built-in/Orange', 'user/Moons']);
    expect(selectedFamily()).toBe('built-in/Orange');
    closePopup();
    openFamilyPopup('codex');
    expect(familyChoices().map((button) => button.dataset['familyChoice'])).toEqual(['built-in/Blue', 'user/Moons']);
  });

  it('opens for the pressed provider, titled by it, and closes with Settings left open', async () => {
    await openScreen();
    openFamilyPopup();
    expect(popupBox()?.hasAttribute('open')).toBe(true);
    expect(popupBox()?.dataset['familyAssignment']).toBe('claude');
    expect(within(popupBox() as HTMLDialogElement).getByRole('heading', { level: 2 }).textContent).toBe(ASSIGNMENT_WORDS.title('Claude'));
    expect(overrideBox()).toBeNull();
    expect(modelRows()).toEqual([]);
    expect(familyChoices().length).toBeGreaterThan(0);
    expect(selectedFamily()).toBe('built-in/Orange');
    expect(strip()).toEqual(['Op 5.5', 'Sketch', 'Default']);
    const trigger = control(ASSIGNMENT_WORDS.overrideTitle);
    trigger.focus();
    fireEvent.click(trigger);
    expect(overrideBox().open).toBe(true);
    expect(within(overrideBox()).getByRole('heading', { level: 2 }).textContent).toBe(ASSIGNMENT_WORDS.overrideDialogTitle('Claude'));
    const bar = overrideBox().querySelector('[data-models-title]')?.parentElement as HTMLElement;
    expect(within(bar).getAllByRole('button').map((button) => button.textContent)).toEqual([ASSIGNMENT_WORDS.assign, ASSIGNMENT_WORDS.clear]);
    expect(within(overrideBox()).getByRole('listbox', { name: ASSIGNMENT_WORDS.detectedModels('Claude') })).toBeTruthy();
    fireEvent.click(overrideBox().querySelector('header button') as HTMLButtonElement);
    expect(overrideBox()).toBeNull();
    expect(popupBox()?.open).toBe(true);
    expect(document.activeElement).toBe(trigger);
    closePopup();
    expect(popupBox()).toBeNull();
    expect(section().isConnected).toBe(true);
  });

  it('shows a model by its name alone, and lets a version assignment coexist with a key fallback', async () => {
    await openScreen({ claude: { opus: OP } });
    openPopup();
    // The name, then what it draws and why in the next column: no key or id line under it.
    expect(modelRow('opus').textContent).not.toContain('Key:');
    expect(modelRow('opus').querySelector('[title]')?.getAttribute('title')).toBe(modelRow('opus').querySelector('[title]')?.textContent);
    expect(modelRow('opus').hasAttribute('aria-describedby')).toBe(false);
    fireEvent.click(modelRow('opus'));
    fireEvent.change(within(assignmentBox()).getByRole('combobox', { name: ASSIGNMENT_WORDS.assignBy }), { target: { value: 'version' } });
    expect(modelRow('claude-opus-5-5')).not.toBeNull();
    expect(patches()).toEqual([]);
    fireEvent.click(control(ASSIGNMENT_WORDS.assign));
    const dialog = document.querySelector<HTMLDialogElement>('[data-assign-avatar]') as HTMLDialogElement;
    expect(dialog.textContent).toContain('Assign to: claude-opus-5-5');
    fireEvent.click(dialog.querySelector('[data-origin="user"] [data-assign-choice="Mine"]') as HTMLElement);
    await settle();
    expect(saved.values.avatars.assignments['claude']).toEqual({ opus: OP, 'claude-opus-5-5': MINE });
    expect(modelRow('claude-opus-5-5').textContent).toContain('Mine');
    // The popup's own close is stopped: the family assignment stays open behind it.
    expect(popupBox()?.hasAttribute('open')).toBe(true);
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(saved.values.avatars.assignments['claude']).toEqual({ opus: OP });
  });

  it('keeps a version binding visible after its alias moves and can clear it without changing the key fallback', async () => {
    await openScreen({ claude: { opus: OP, 'claude-opus-5-5': MINE } });
    openPopup();
    expect(label('claude-opus-5-5')).toContain(ASSIGNMENT_WORDS.byVersion);
    const newer: CatalogState = { ...CATALOG, providers: CATALOG.providers.map((entry) => ({ ...entry, models: entry.models.map((item) => item.key === 'opus' || item.key === 'default' ? { ...item, name: 'Opus 6', resolvedId: 'claude-opus-6' } : item) })) };
    act(() => { showState({ providers: PROVIDERS, catalog: newer }); });
    expect(label('claude-opus-5-5')).toContain(ASSIGNMENT_WORDS.notListed);
    fireEvent.click(modelRow('claude-opus-5-5'));
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(saved.values.avatars.assignments['claude']).toEqual({ opus: OP });
  });

  it('lists each model once in the first listing account’s order, the default folded, the hidden after them, then the assigned keys no row shows, greyed', async () => {
    await openScreen({ claude: { 'claude-gone-1': FACE, default: MINE } });
    openPopup();
    expect(keys()).toEqual(['opus', 'sonnet', 'fable', 'haiku', 'claude-gone-1', 'default']);
    expect(label('haiku')).toBe('Haiku 5, Hidden');
    expect(label('claude-gone-1')).toBe('claude-gone-1, Not listed now, Override: Orange (built-in) / Default');
    expect(label('default')).toBe('Default (Opus 5.5), Same model as Opus 5.5, Override: Orange (yours) / Mine');
    expect(modelRows().filter((element) => element.hasAttribute('data-greyed')).map((element) => element.dataset['assignmentRow'])).toEqual(['claude-gone-1', 'default']);
  });

  it('draws each row’s thumbnail at 30 px or an empty box, and says in words what keeps an avatar from being drawn', async () => {
    const plain: CatalogState = { ...CATALOG, providers: [sampleCatalogProvider({ id: 'claude', models: [model('opus', 'Opus 5.5', { resolvedId: 'claude-opus-5-5' }), model('sonnet', 'Sonnet 5'), model('haiku', 'Haiku 5', { hidden: true })] }), sampleCatalogProvider({ id: 'claude', instanceId: WORK, models: [model('fable', 'Fable 5.1'), model('mythos', 'Mythos 1')] })] };
    await openScreen({ claude: { fable: SKETCH, haiku: { origin: 'built-in', family: 'Gone', avatar: 'X' }, opus: OP, sonnet: MINE } }, plain);
    openPopup();
    // Assigned and listed: the small at this size, over the placeholder; the origin named, both roots holding an Orange.
    expect(modelRow('opus').querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('thin');
    expect(modelRow('opus').querySelector('[data-avatar] img')?.getAttribute('src')).toBe(`app://media/avatars/${id(2)}`);
    expect(label('opus')).toBe('Opus 5.5, Override: Orange (built-in) / Op 5.5');
    expect(label('sonnet')).toBe('Sonnet 5, Override: Orange (yours) / Mine');
    // No usable portrait: the placeholder alone, and the avatar's own problem.
    expect(modelRow('fable').querySelector('[data-avatar]')).not.toBeNull();
    expect(modelRow('fable').querySelector('img')).toBeNull();
    expect(label('fable')).toBe('Fable 5.1, Override: Orange (built-in) / Sketch, Orange/Sketch: no usable portrait, so it is drawn nowhere');
    // Not in the listing: the empty box, and Not found.
    expect(modelRow('haiku').querySelector('[data-assignment-empty]')).not.toBeNull();
    expect(label('haiku')).toBe('Haiku 5, Hidden, Override: Gone / X, Not found');
    expect(modelRow('mythos').querySelector('[data-assignment-empty]')).not.toBeNull();
    expect(label('mythos')).toBe('Mythos 1');
    // Its files failed in the page: said, and main is not told.
    const before = requests.length;
    fireEvent.error(modelRow('opus').querySelector('img') as HTMLImageElement);
    fireEvent.error(modelRow('opus').querySelector('img') as HTMLImageElement);
    expect(label('opus')).toBe('Opus 5.5, Override: Orange (built-in) / Op 5.5, Could not be drawn');
    expect(requests.length).toBe(before);
  });

  it('is one list: Up, Down, Home and End move and select from one tab stop, and the pointer selects', async () => {
    await openScreen({ claude: { opus: OP } });
    openPopup();
    const list = within(assignmentBox()).getByRole('listbox', { name: ASSIGNMENT_WORDS.detectedModels('Claude') });
    const selected = () => modelRows().filter((element) => element.getAttribute('aria-selected') === 'true').map((element) => element.dataset['assignmentRow']);
    const stops = () => modelRows().filter((element) => element.tabIndex === 0).map((element) => element.dataset['assignmentRow']);
    expect([selected(), stops()]).toEqual([['opus'], ['opus']]);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect([selected(), document.activeElement]).toEqual([['sonnet'], modelRow('sonnet')]);
    fireEvent.keyDown(list, { key: 'End' });
    expect(selected()).toEqual(['haiku']);
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect([selected(), stops()]).toEqual([['opus'], ['opus']]);
    fireEvent.click(modelRow('fable'));
    expect(selected()).toEqual(['fable']);
  });

  it('enables Assign avatar by a selection and Clear by an assignment, both off under read-only preferences and while a save is on its way', async () => {
    await openScreen({ claude: { opus: OP } });
    openPopup();
    expect([control(ASSIGNMENT_WORDS.assign).disabled, control(ASSIGNMENT_WORDS.clear).disabled]).toEqual([false, false]);
    fireEvent.click(modelRow('sonnet'));
    expect([control(ASSIGNMENT_WORDS.assign).disabled, control(ASSIGNMENT_WORDS.clear).disabled]).toEqual([false, true]);
    fireEvent.click(modelRow('opus'));
    act(() => { usePrefs.setState({ saving: true }); });
    expect([control(ASSIGNMENT_WORDS.assign).disabled, control(ASSIGNMENT_WORDS.clear).disabled]).toEqual([true, true]);
    act(() => { usePrefs.setState({ saving: false, snapshot: prefsSnapshot({ avatars: { assignments: { claude: { opus: OP } }, active: {} } }, { kind: 'read-only', reason: 'incompatible', fileVersion: 8, minReaderVersion: 8 }) }); });
    expect([control(ASSIGNMENT_WORDS.assign).disabled, control(ASSIGNMENT_WORDS.clear).disabled]).toEqual([true, true]);
  });

  it('clears the selected model’s avatar by one patch of one entry, and says when a save fails', async () => {
    await openScreen({ claude: { opus: OP, sonnet: MINE } });
    openPopup();
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(patches()).toEqual([{ avatars: { assignments: { claude: { opus: null } } } }]);
    expect(within(assignmentBox()).queryByRole('status')).toBeNull();
    // Clear is disabled now: the focus is on the row it cleared, not dropped to the page.
    expect(document.activeElement).toBe(modelRow('opus'));
    // Main's answer leaves the entry as it was.
    refusing = true;
    fireEvent.click(modelRow('sonnet'));
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(within(assignmentBox()).getByRole('status').textContent).toBe(ASSIGNMENT_WORDS.saveFailed);
    // And the call itself fails.
    refusing = false;
    failing.add('prefs:patch');
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(within(assignmentBox()).getByRole('status').textContent).toBe(ASSIGNMENT_WORDS.saveFailed);
  });

  it('puts the focus on Assign by inside the override dialog when a cleared row leaves', async () => {
    await openScreen({ claude: { 'claude-gone-1': FACE } });
    openPopup();
    fireEvent.click(modelRow('claude-gone-1'));
    fireEvent.click(control(ASSIGNMENT_WORDS.clear));
    await settle();
    expect(patches()).toEqual([{ avatars: { assignments: { claude: { 'claude-gone-1': null } } } }]);
    expect(keys()).not.toContain('claude-gone-1');
    expect(document.activeElement).toBe(within(overrideBox()).getByRole('combobox', { name: ASSIGNMENT_WORDS.assignBy }));
  });

  it('says why a provider has no rows, and shows its family’s avatars or none where it has no family', async () => {
    const providers = [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex', status: { kind: 'disabled' } })];
    await openScreen({}, { ...CATALOG, providers: [CATALOG.providers[0] as never, sampleCatalogProvider({ id: 'codex', source: { kind: 'none' }, models: [] })] }, providers);
    openPopup();
    expect(strip().at(-1)).toBe('Default');
    closePopup();
    openPopup('codex');
    expect(modelRows()).toEqual([]);
    expect(assignmentBox().querySelector('[data-assignment-unreported]')?.textContent).toBe('Listed once it is enabled and its CLI reports them.');
    expect(strip().at(-1)).toBe('Default');
    expect(assignmentBox().querySelector('[data-assigned-strip]')?.getAttribute('aria-label')).toBe(ASSIGNMENT_WORDS.strip('Blue'));
    listing = { roots: [{ origin: 'built-in', families: [ORANGE], problems: [] }, { origin: 'user', families: [], problems: [] }] };
    fireEvent.click(within(section()).getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(strip()).toEqual([]);
  });

  it('lists every family, those with no Default folder disabled, the built-in default marked and chosen until the user chooses another', async () => {
    const sketchy = family('Sketchy', 'user', [avatar('Only', { files: [file(12, 'small', 'png', 64)], problems: [{ kind: 'no-portrait', path: 'Sketchy/Only' }] })]);
    await openScreen({}, CATALOG, PROVIDERS, {}, { roots: [ASSIGNING.roots[0] as never, { origin: 'user', families: [...(ASSIGNING.roots[1]?.families ?? []), MOONS, sketchy], problems: [] }] });
    openFamilyPopup();
    // Any family with its Default folder may stand for any provider; one without may not.
    expect(familyChoices().map((button) => [button.getAttribute('aria-label'), button.disabled])).toEqual([
      ['Blue', false], ['Orange (built-in) (default)', false], ['Moons', false],
    ]);
    expect(selectedFamily()).toBe('built-in/Orange');
    chooseFamily('user/Moons');
    await settle();
    expect(patches()).toEqual([{ avatars: { active: { claude: { origin: 'user', family: 'Moons' } } } }]);
    expect(selectedFamily()).toBe('user/Moons');
    expect(strip().at(-1)).toBe('Default');
    expect(assignmentBox().querySelector('[data-assigned-strip]')?.getAttribute('aria-label')).toBe(ASSIGNMENT_WORDS.strip('Moons'));
    expect(providerCard('claude').querySelector('[data-family-name]')?.textContent).toBe('Moons');
    // The default again: none is kept, so the built-in family follows whatever fat-g ships.
    chooseFamily('built-in/Orange');
    await settle();
    expect(patches().at(-1)).toEqual({ avatars: { active: { claude: null } } });
    expect(saved.values.avatars.active).toEqual({});
  });

  it('says why a row draws what main resolved: its family’s match and the entry that won, its face or the built-in face', async () => {
    const drawn = (folder: string, source: 'match' | 'family-face' | 'built-in-face') => ({ ref: { origin: 'built-in', family: 'Orange', avatar: folder } as const, portrait: id(folder === 'Op 5.5' ? 1 : 3), small: null, source, overlay: null });
    const resolved: CatalogState = { ...CATALOG, providers: [sampleCatalogProvider({ id: 'claude', models: [model('opus', 'Opus 5.5', { avatar: drawn('Op 5.5', 'match') }), model('sonnet', 'Sonnet 5', { avatar: drawn('Default', 'family-face') }), model('fable', 'Fable 5.1', { avatar: drawn('Default', 'built-in-face') })] })] };
    await openScreen({}, resolved);
    openPopup();
    expect(label('opus')).toBe('Opus 5.5, Family match: Orange (built-in) / Op 5.5 (claude: opus)');
    expect(label('sonnet')).toBe('Sonnet 5, Family default: Orange (built-in) / Default');
    expect(label('fable')).toBe('Fable 5.1, Built-in default: Orange (built-in) / Default');
    expect(modelRow('opus').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(1)}`);
  });

  it('opens the active family’s editor over itself at Edit family', async () => {
    await openScreen();
    openFamilyPopup();
    fireEvent.click(control('Edit family Orange (built-in)'));
    await settle();
    expect(asked('avatars:family')).toEqual([{ origin: 'built-in', family: 'Orange' }]);
    expect(document.querySelector('dialog[data-family-editor="Orange"]')?.hasAttribute('open')).toBe(true);
    expect(popupBox()?.hasAttribute('open')).toBe(true);
  });

  it('edits an unselected family without changing the active family, then restores focus to its Edit button', async () => {
    await openScreen();
    openFamilyPopup();
    const edit = control('Edit family Blue');
    edit.focus();
    fireEvent.click(edit);
    await settle();
    expect(asked('avatars:family')).toEqual([{ origin: 'built-in', family: 'Blue' }]);
    expect(selectedFamily()).toBe('built-in/Orange');
    expect(patches()).toEqual([]);
    const editor = document.querySelector<HTMLDialogElement>('dialog[data-family-editor="Blue"]') as HTMLDialogElement;
    fireEvent.click(within(editor).getByRole('button', { name: EDITOR_WORDS.close }));
    expect(popupBox()?.open).toBe(true);
    expect(document.activeElement).toBe(edit);
  });

  it('keeps the saved family selected after a refused change and blocks family writes with read-only preferences', async () => {
    await openScreen();
    openFamilyPopup();
    refusing = true;
    chooseFamily('built-in/Blue');
    await settle();
    expect(selectedFamily()).toBe('built-in/Orange');
    expect(within(assignmentBox()).getByRole('status').textContent).toBe(ASSIGNMENT_WORDS.saveFailed);
    requests = [];
    act(() => { usePrefs.setState({ snapshot: { ...saved, status: { kind: 'read-only', reason: 'unreadable' } } }); });
    expect(familyChoices().every((button) => button.disabled)).toBe(true);
    chooseFamily('built-in/Blue');
    expect(patches()).toEqual([]);
  });
});

describe('Assign avatar (M103, V5; C25–C28)', () => {
  const popup = () => document.querySelector<HTMLDialogElement>('[data-assign-avatar]') as HTMLDialogElement;
  const choice = (familyFolder: string, folder: string, origin = 'built-in') => popup().querySelector<HTMLElement>(`[data-assign-family="${familyFolder}"][data-origin="${origin}"] [data-assign-choice="${folder}"]`) as HTMLElement;
  const choiceLabel = (familyFolder: string, folder: string, origin = 'built-in') => choice(familyFolder, folder, origin).getAttribute('aria-label');
  const openFor = (key: string) => {
    fireEvent.click(modelRow(key));
    fireEvent.click(control(ASSIGNMENT_WORDS.assign));
  };

  it('filters individual avatar choices by the family’s provider too', async () => {
    await openScreen({}, CATALOG, PROVIDERS, {}, { roots: [
      { origin: 'built-in', families: [{ ...BLUE, provider: 'codex' }, { ...ORANGE, provider: 'claude' }], problems: [] },
      { origin: 'user', families: [MOONS], problems: [] },
    ] });
    openPopup();
    openFor('opus');
    expect(popup().querySelector('[data-assign-family="Blue"]')).toBeNull();
    expect(popup().querySelector('[data-assign-family="Orange"]')).not.toBeNull();
    expect(popup().querySelector('[data-assign-family="Moons"]')).not.toBeNull();
  });

  it('lists every avatar, the built-in families first, each a group by its folder and origin, each row saying what a press does', async () => {
    await openScreen({ claude: { opus: OP, sonnet: FACE }, codex: { 'gpt-6-sol': MINE } });
    openPopup();
    openFor('opus');
    expect(popup().hasAttribute('open')).toBe(true);
    expect(within(popup()).getByRole('heading').textContent).toBe(ASSIGN_POPUP_WORDS.title('Opus 5.5'));
    expect(within(popup()).getAllByRole('group').map((element) => element.querySelector('p')?.textContent)).toEqual(['Blue · Built-in', 'Orange · Built-in', 'Orange · Yours']);
    expect(choiceLabel('Blue', 'Default')).toBe(`Default, ${AVATAR_WORDS.fallback}`);
    expect(choiceLabel('Orange', 'Op 5.5')).toBe('Op 5.5, Current');
    // Several models may share an avatar: another model's override is not named.
    expect(choiceLabel('Orange', 'Default')).toBe(`Default, ${AVATAR_WORDS.fallback}`);
    // A family without its Default folder is no one's family, and its avatars may still be assigned.
    expect(choiceLabel('Orange', 'Mine', 'user')).toBe('Mine');
    expect(choice('Orange', 'Sketch').getAttribute('aria-disabled')).toBe('true');
    expect(choiceLabel('Orange', 'Sketch')).toBe('Sketch, Orange/Sketch: no usable portrait, so it is drawn nowhere');
    expect(asked('avatars:list')).toEqual([null]);
  });

  it('assigns the pressed avatar by one patch of one entry and closes, another model holding it keeping it', async () => {
    await openScreen({ claude: { opus: OP }, codex: { 'gpt-6-sol': MINE } });
    openPopup();
    openFor('opus');
    fireEvent.click(choice('Orange', 'Mine', 'user'));
    expect(popup().hasAttribute('open')).toBe(false);
    await settle();
    expect(patches()).toEqual([{ avatars: { assignments: { claude: { opus: MINE } } } }]);
    expect(label('opus')).toBe('Opus 5.5, Override: Orange (yours) / Mine');
    closePopup();
    openPopup('codex');
    expect(label('gpt-6-sol')).toBe('GPT-6 Sol, Override: Orange (yours) / Mine');
  });

  it('sends nothing for a disabled avatar, for its close button or for Escape', async () => {
    await openScreen();
    openPopup();
    openFor('opus');
    fireEvent.click(choice('Orange', 'Sketch'));
    expect(popup().hasAttribute('open')).toBe(true);
    fireEvent.click(within(popup()).getByRole('button', { name: ASSIGN_POPUP_WORDS.close }));
    expect(popup().hasAttribute('open')).toBe(false);
    openFor('opus');
    // What Escape does to a modal dialog: it closes it, and its close event follows.
    act(() => { popup().close(); });
    expect(popup().hasAttribute('open')).toBe(false);
    await settle();
    expect(patches()).toEqual([]);
    expect(popupBox()?.hasAttribute('open')).toBe(true);
    expect(section().isConnected).toBe(true);
  });

  it('is one list across the groups by Up, Down, Home and End, from this model’s own row, and Enter assigns', async () => {
    await openScreen({ claude: { opus: OP } });
    openPopup();
    openFor('opus');
    const list = within(popup()).getByRole('listbox');
    const active = () => [...popup().querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')].map((element) => element.dataset['assignChoice']);
    expect([active(), document.activeElement]).toEqual([['Op 5.5'], choice('Orange', 'Op 5.5')]);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(active()).toEqual(['Sketch']);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect([active(), document.activeElement]).toEqual([['Default'], choice('Orange', 'Default')]);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect([active(), document.activeElement]).toEqual([['Default'], choice('Blue', 'Default')]);
    fireEvent.keyDown(list, { key: 'End' });
    expect(active()).toEqual(['Mine']);
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(popup().hasAttribute('open')).toBe(true);
    fireEvent.keyDown(list, { key: 'Home' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(popup().hasAttribute('open')).toBe(false);
    await settle();
    expect(patches()).toEqual([{ avatars: { assignments: { claude: { opus: BLUE_FACE } } } }]);
  });

  it('redraws from the new listing when a Rescan lands while it is open', async () => {
    await openScreen();
    openPopup();
    openFor('opus');
    listing = { roots: [ASSIGNING.roots[0] as never, { origin: 'user', families: [family('Fresh', 'user', [avatar('New', { files: [file(11, 'portrait', 'png', 512)] })])], problems: [] }] };
    fireEvent.click(within(section()).getByRole('button', { name: 'Rescan' }));
    await settle();
    expect(choice('Fresh', 'New', 'user')).not.toBeNull();
    expect(popup().querySelector('[data-origin="user"][data-assign-family="Orange"]')).toBeNull();
  });

  it('draws its thumbnails and the popup’s by the listing’s ids over the placeholder, and shows no path and no account label', async () => {
    await openScreen({ claude: { opus: OP, sonnet: MINE } });
    openPopup();
    openFor('opus');
    const ids = new Set(ASSIGNING.roots.flatMap((each) => each.families.flatMap((entry) => entry.avatars.flatMap((view) => view.files.map((item) => `app://media/avatars/${item.id}`)))));
    const images = [...assignmentBox().querySelectorAll('img'), ...popup().querySelectorAll('img')];
    expect(images.length).toBeGreaterThan(4);
    for (const image of images) {
      expect(ids.has(image.getAttribute('src') ?? '')).toBe(true);
      expect(image.parentElement?.hasAttribute('data-avatar')).toBe(true);
    }
    for (const text of [assignmentBox().textContent, popup().textContent]) expect(text).not.toMatch(/Work|\\|C:|user@example\.com/);
  });
});

// ── The family editor (decisions 0031, 0032) ──────────────────────────────────────────────────
const editor = () => document.querySelector<HTMLDialogElement>('dialog[data-family-editor]');
const inEditor = () => within(editor() as HTMLDialogElement);
const avatarRow = (folder: string) => (editor() as HTMLDialogElement).querySelector<HTMLElement>(`[data-family-avatar="${folder}"]`) as HTMLElement;
const defaultRow = () => (editor() as HTMLDialogElement).querySelector<HTMLElement>('[data-family-default]') as HTMLElement;
const detail = () => (editor() as HTMLDialogElement).querySelector<HTMLElement>('[data-avatar-detail]') as HTMLElement;
const defaultDetail = () => (editor() as HTMLDialogElement).querySelector<HTMLElement>('[data-default-detail]') as HTMLElement;
const stylePanel = () => (editor() as HTMLDialogElement).querySelector<HTMLElement>('[data-style-target]') as HTMLElement;
const saveButton = () => (editor() as HTMLDialogElement).querySelector<HTMLButtonElement>('[data-save-family]') as HTMLButtonElement;
const confirmation = (name: string) => screen.getByRole('dialog', { name });
const savedDrafts = () => asked('avatars:saveFamily');
const MOONS_LISTING: AvatarListing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [MOONS], problems: [] }] };

async function openEditor(source: FamilySource = MOONS_SOURCE) {
  sources.set('user/Moons', source);
  await openScreen({}, CATALOG, PROVIDERS, {}, MOONS_LISTING);
  fireEvent.click(familyButton('Moons', 'user'));
  await settle();
}

describe('the family editor (decisions 0031, 0032)', () => {
  it.each(['packaged', 'development'] as const)('makes a copy in %s and opens the editable copy immediately', async (build) => {
    const originalRef: FamilyRef = { origin: 'built-in', family: 'Orange' };
    const copiedRef: FamilyRef = { origin: 'user', family: 'Copy of Orange' };
    const draft = { provider: 'claude', overlay: MOONS_SOURCE.draft.overlay, avatars: [{ folder: 'Op 5.5', matches: ['opus'], overlay: {} }] };
    const original: FamilySource = { ref: originalRef, lock: build === 'packaged' ? { kind: 'packaged' } : null, revision: REVISION, draft, missing: [] };
    sources.set('built-in/Orange', original);
    sources.set('user/Copy of Orange', { ...original, ref: copiedRef, lock: null });
    const copied: FamilyView = { ...ORANGE, origin: 'user', folder: copiedRef.family };
    const copiedListing: AvatarListing = { roots: [{ origin: 'built-in', families: [ORANGE], problems: [] }, { origin: 'user', families: [copied], problems: [] }] };
    copyAnswer = { kind: 'copied', ref: copiedRef, listing: copiedListing };
    await openScreen({}, CATALOG, PROVIDERS);
    fireEvent.click(familyButton('Orange'));
    await settle();
    if (build === 'packaged') expect(editor()?.querySelector('[data-family-lock]')?.textContent).toBe('Built-in avatar families cannot be changed. But you can Make a copy and edit it.');
    else {
      expect(editor()?.querySelector('[data-family-lock]')).toBeNull();
      expect(inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider }).disabled).toBe(false);
    }
    const button = inEditor().getByRole('button', { name: EDITOR_WORDS.makeCopy });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(asked('avatars:copyFamily')).toEqual([originalRef]);
    await settle();
    expect(editor()?.dataset['familyEditor']).toBe(copiedRef.family);
    expect(inEditor().getByRole('heading', { name: 'Family: Copy of Orange' })).toBeTruthy();
    expect(inEditor().queryByRole('button', { name: EDITOR_WORDS.makeCopy })).toBeNull();
    expect(familyRow(copiedRef.family, 'user')).not.toBeNull();
    const provider = inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider });
    expect(provider.disabled).toBe(false);
    expect(provider.value).toBe('claude');
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(provider, { target: { value: 'any' } });
    fireEvent.click(saveButton());
    await settle();
    expect(savedDrafts()).toEqual([{ ref: copiedRef, revision: REVISION, draft: { ...draft, provider: 'any' } }]);
    expect(patches()).toEqual([]);
  });

  it('asks before discarding development edits to make a copy', async () => {
    const ref: FamilyRef = { origin: 'built-in', family: 'Orange' };
    sources.set('built-in/Orange', { ...MOONS_SOURCE, ref, lock: null });
    await openScreen({}, CATALOG, PROVIDERS);
    fireEvent.click(familyButton('Orange'));
    await settle();
    fireEvent.change(inEditor().getByRole('combobox', { name: EDITOR_WORDS.provider }), { target: { value: 'codex' } });
    fireEvent.click(inEditor().getByRole('button', { name: EDITOR_WORDS.makeCopy }));
    expect(asked('avatars:copyFamily')).toEqual([]);
    fireEvent.click(within(confirmation(EDITOR_WORDS.discardTitle)).getByRole('button', { name: 'Cancel' }));
    expect(inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider }).value).toBe('codex');
    fireEvent.click(inEditor().getByRole('button', { name: EDITOR_WORDS.makeCopy }));
    fireEvent.click(within(confirmation(EDITOR_WORDS.discardTitle)).getByRole('button', { name: EDITOR_WORDS.discard }));
    await settle();
    expect(asked('avatars:copyFamily')).toEqual([ref]);
    expect(savedDrafts()).toEqual([]);
  });

  it('keeps the built-in family read-only and allows retry when copying fails', async () => {
    await openEditor({ ...MOONS_SOURCE, lock: { kind: 'packaged' } });
    fireEvent.click(inEditor().getByRole('button', { name: EDITOR_WORDS.makeCopy }));
    expect(inEditor().getByRole<HTMLButtonElement>('button', { name: EDITOR_WORDS.copying }).disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(editor() as HTMLDialogElement, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    await settle();
    expect(inEditor().getByRole('status').textContent).toBe(EDITOR_WORDS.copyFailed);
    expect(inEditor().getByRole<HTMLButtonElement>('button', { name: EDITOR_WORDS.makeCopy }).disabled).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(savedDrafts()).toEqual([]);
  });

  it('edits the family provider above the avatar list and saves it with the draft', async () => {
    await openEditor();
    const select = inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider });
    expect(select.value).toBe('any');
    expect([...select.options].map((option) => option.value)).toEqual(['any', 'claude', 'codex']);
    expect(Boolean(select.compareDocumentPosition(defaultRow()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(select.compareDocumentPosition(avatarRow('Luna')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.change(select, { target: { value: 'codex' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await settle();
    expect(savedDrafts()).toEqual([{ ref: MOONS_REF, revision: REVISION, draft: { ...MOONS_SOURCE.draft, provider: 'codex' } }]);
  });

  it('opens the edited family’s content folder by reference and allows retry after failure without losing edits', async () => {
    await openEditor();
    const opener = inEditor().getByRole<HTMLButtonElement>('button', { name: EDITOR_WORDS.openFolder });
    expect(Boolean(opener.compareDocumentPosition(defaultRow()) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.change(inEditor().getByRole('combobox', { name: EDITOR_WORDS.provider }), { target: { value: 'codex' } });
    failing.add('avatars:openFamilyFolder');
    fireEvent.click(opener);
    expect(opener.disabled).toBe(true);
    await settle();
    expect(inEditor().getByRole('status').textContent).toBe(EDITOR_WORDS.folderFailed);
    expect(opener.disabled).toBe(false);
    failing.delete('avatars:openFamilyFolder');
    fireEvent.click(opener);
    await settle();
    expect(asked('avatars:openFamilyFolder')).toEqual([MOONS_REF, MOONS_REF]);
    expect(inEditor().queryByRole('status')).toBeNull();
    expect(inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider }).value).toBe('codex');
    expect(saveButton().disabled).toBe(false);
    expect(savedDrafts()).toEqual([]);
  });

  it('opens the editing guide above the editor and restores focus without dropping the draft', async () => {
    await openEditor();
    fireEvent.change(inEditor().getByRole('combobox', { name: EDITOR_WORDS.provider }), { target: { value: 'codex' } });
    const info = inEditor().getByRole('button', { name: 'Technical details' });
    for (const method of ['Got it', 'Close avatar family guide', 'native close']) {
      info.focus();
      fireEvent.click(info);
      const guide = screen.getByRole<HTMLDialogElement>('dialog', { name: 'Avatar families' });
      expect(guide.textContent).toContain('3. Updating images');
      if (method === 'native close') act(() => guide.close());
      else fireEvent.click(within(guide).getByRole('button', { name: method }));
      expect(editor()?.open).toBe(true);
      expect(document.activeElement).toBe(info);
      expect(inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider }).value).toBe('codex');
      expect(saveButton().disabled).toBe(false);
    }
    expect(savedDrafts()).toEqual([]);
  });

  it('opens an existing provider value read-only for a locked family', async () => {
    await openEditor({ ...MOONS_SOURCE, lock: { kind: 'packaged' }, draft: { ...MOONS_SOURCE.draft, provider: 'claude' } });
    const select = inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider });
    expect(select.value).toBe('claude');
    expect(select.disabled).toBe(true);
  });

  it('reads the family’s file from main by its reference, and lists the Family default, then its other avatars in its order, a folder gone greyed in its place', async () => {
    await openEditor();
    expect(asked('avatars:family')).toEqual([MOONS_REF]);
    expect(editor()?.hasAttribute('open')).toBe(true);
    expect(inEditor().getByRole('heading', { level: 2 }).textContent).toBe(EDITOR_WORDS.title('Moons'));
    expect(defaultRow().getAttribute('aria-label')).toBe(`${EDITOR_WORDS.familyDefault}, ${EDITOR_WORDS.familyDefaultWords}`);
    const list = inEditor().getByRole('listbox', { name: EDITOR_WORDS.avatars });
    expect(within(list).getAllByRole('option')).toEqual([defaultRow(), avatarRow('Luna'), avatarRow('Gone'), avatarRow('Night')]);
    const rows = [...(editor() as HTMLDialogElement).querySelectorAll<HTMLElement>('[data-family-avatar]')];
    expect(rows.map((element) => element.dataset['familyAvatar'])).toEqual(['Luna', 'Gone', 'Night']);
    // Its Default folder is no avatar of the list: it is the Family default.
    expect(rows.map((element) => element.getAttribute('aria-label'))).toEqual(['Luna, *sonnet*', 'Gone, old-*, Missing folder', 'Night, No matches']);
    // Its words are its name's alone: the rest is read to assistive technology, in its label.
    expect(defaultRow().textContent).toBe(EDITOR_WORDS.familyDefault);
    expect(avatarRow('Gone').hasAttribute('data-greyed')).toBe(true);
    expect(avatarRow('Gone').querySelector('[data-assignment-empty]')).not.toBeNull();
    // It opens on the Family default, its style the Default style; nothing has changed, so nothing can be saved.
    expect(defaultRow().getAttribute('aria-selected')).toBe('true');
    expect(avatarRow('Luna').getAttribute('aria-selected')).toBe('false');
    expect(stylePanel().dataset['styleTarget']).toBe('family');
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.defaultStyle);
    expect(stylePanel().querySelector('[data-customizations-note]')).toBeNull();
    expect(detail()).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect((editor() as HTMLDialogElement).querySelector('[data-unsaved]')).toBeNull();
  });

  it('is its Default folder, drawn in the Default style alone, and its row counts the avatars that override it', async () => {
    await openEditor({ ...MOONS_SOURCE, draft: { ...MOONS_SOURCE.draft, avatars: MOONS_SOURCE.draft.avatars.map((avatar) => (avatar.folder === 'Luna' ? { ...avatar, overlay: { version: { preset: 'chip' } } } : avatar)) } });
    expect(defaultRow().getAttribute('aria-label')).toBe(`${EDITOR_WORDS.familyDefault}, ${EDITOR_WORDS.familyDefaultWords}, ${EDITOR_WORDS.overriding(1)}`);
    // Its thumbnail and its preview are the Default folder's portrait.
    expect(defaultRow().querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(10)}`);
    expect(defaultDetail().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.avatarTitle(EDITOR_WORDS.familyDefault));
    expect(defaultDetail().textContent).toContain(EDITOR_WORDS.images.main(512));
    const column = defaultDetail().querySelector<HTMLElement>('[data-style-preview] [data-size="column"]') as HTMLElement;
    expect(column.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(10)}`);
    // In the family's glow: Luna's chip is Luna's own.
    expect(column.querySelector<HTMLElement>('[data-overlay]')?.dataset['effect']).toBe('glow');
    fireEvent.change(stylePanel().querySelector('[data-style-group="preset"] [data-style-preset]') as HTMLSelectElement, { target: { value: 'band' } });
    expect(column.querySelector<HTMLElement>('[data-overlay]')?.dataset['effect']).toBe('plain');
    // Selected, Luna draws as it is drawn, its chip over the family's style.
    fireEvent.click(avatarRow('Luna'));
    expect(detail().querySelector<HTMLElement>('[data-style-preview] [data-size="column"] [data-overlay]')?.dataset['effect']).toBe('chip');
  });

  it('says so where the family has no Default folder, which the Family select offers no provider', async () => {
    const bare: AvatarListing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [BARE_MOONS], problems: [] }] };
    await openScreen({}, CATALOG, PROVIDERS, {}, bare);
    expect(familyRow('Moons', 'user').textContent).toContain('Moons: no Default folder holding portrait.png or portrait.webp, so the family is not used');
    openFamilyPopup();
    expect(familyChoices().some((button) => button.dataset['familyChoice'] === 'user/Moons')).toBe(false);
    closePopup();
    fireEvent.click(familyButton('Moons', 'user'));
    await settle();
    expect(defaultRow().getAttribute('aria-label')).toBe(`${EDITOR_WORDS.familyDefault}, ${EDITOR_WORDS.noDefault}`);
    expect(defaultRow().querySelector('[data-assignment-empty]')).not.toBeNull();
    expect(defaultRow().querySelector('img')).toBeNull();
    expect(defaultDetail().hasAttribute('data-no-default')).toBe(true);
    expect(defaultDetail().textContent).toBe(EDITOR_WORDS.noDefault);
    expect(defaultDetail().querySelector('[data-style-preview]')).toBeNull();
    // Its Default style and its avatars may still be edited, for when the folder comes.
    expect((stylePanel().querySelector('[data-style-size]') as HTMLSelectElement).disabled).toBe(false);
    expect([...(editor() as HTMLDialogElement).querySelectorAll<HTMLElement>('[data-family-avatar]')].map((element) => element.dataset['familyAvatar'])).toEqual(['Luna', 'Gone', 'Night']);
  });

  it('moves between the default’s row and the avatars by Up and Down, choosing as it goes', async () => {
    await openEditor();
    fireEvent.keyDown(defaultRow(), { key: 'ArrowDown' });
    expect(avatarRow('Luna').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(avatarRow('Luna'));
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.styleOverrides);
    fireEvent.keyDown(avatarRow('Luna'), { key: 'ArrowUp' });
    expect(defaultRow().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(defaultRow());
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.defaultStyle);
    const list = inEditor().getByRole('listbox', { name: EDITOR_WORDS.avatars });
    expect(within(list).getAllByRole('option').filter((row) => row.tabIndex === 0)).toEqual([defaultRow()]);
    fireEvent.keyDown(defaultRow(), { key: 'End' });
    expect(document.activeElement).toBe(avatarRow('Night'));
    expect(within(list).getAllByRole('option').filter((row) => row.tabIndex === 0)).toEqual([avatarRow('Night')]);
    fireEvent.keyDown(avatarRow('Night'), { key: 'Home' });
    expect(document.activeElement).toBe(defaultRow());
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.defaultStyle);
  });

  it('previews the chosen avatar at both sizes in the draft’s style, with the texts of the model it takes and the effort chosen', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    const preview = (size: 'column' | 'capsule') => detail().querySelector<HTMLElement>(`[data-style-preview] [data-size="${size}"]`) as HTMLElement;
    expect(preview('column').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(7)}`);
    expect(preview('column').querySelector('[data-overlay-version]')?.textContent).toBe('5');
    expect(preview('capsule').querySelector<HTMLElement>('[data-overlay]')?.dataset['effect']).toBe('glow');
    expect(preview('column').querySelector('[data-effort-marks]')?.getAttribute('data-effort-marks')).toBe('2');
    expect(detail().querySelector('[data-takes]')?.textContent).toBe(EDITOR_WORDS.takes(['Sonnet 5 (Claude)']));
    fireEvent.change(detail().querySelector('[data-preview-effort]') as HTMLSelectElement, { target: { value: 'ultra' } });
    expect([...preview('column').querySelectorAll('[data-effort-mark]')].map((mark) => mark.getAttribute('data-effort-mark'))).toEqual(['star', 'star', 'star', 'star', 'star']);
    fireEvent.change(detail().querySelector('[data-preview-model]') as HTMLSelectElement, { target: { value: 'claude/opus' } });
    expect(preview('column').querySelector('[data-overlay-version]')?.textContent).toBe('5.5');
    fireEvent.change(detail().querySelector('[data-preview-effort]') as HTMLSelectElement, { target: { value: '' } });
    expect(preview('column').querySelector('[data-effort-marks]')).toBeNull();
    // The preview changes nothing of the file.
    expect(saveButton().disabled).toBe(true);
  });

  it('saves a change of the Default style as the draft, with the revision it was read at, then closes and lists the families again', async () => {
    await openEditor();
    const size = stylePanel().querySelector<HTMLSelectElement>('[data-style-group="version"] [data-style-size]') as HTMLSelectElement;
    expect(size.value).toBe('24');
    fireEvent.change(size, { target: { value: '14' } });
    expect((editor() as HTMLDialogElement).querySelector('[data-unsaved]')?.textContent).toBe(EDITOR_WORDS.unsaved);
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await settle();
    expect(savedDrafts()).toEqual([{
      ref: MOONS_REF,
      revision: REVISION,
      draft: { ...MOONS_SOURCE.draft, overlay: { version: { preset: 'glow', size: 14 } } },
    }]);
    expect(editor()).toBeNull();
    expect(asked('avatars:list')).toEqual([null, null]);
  });

  it('takes an entry whose folder is gone out of the file at Remove entry, and nothing else', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Gone'));
    expect(detail().hasAttribute('data-missing')).toBe(true);
    expect(detail().textContent).toContain(EDITOR_WORDS.missingHelp);
    expect(detail().textContent).toContain('Matches: old-*');
    // Its overrides are shown, and cannot be changed: it has no art left to style.
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.styleOverrides);
    expect((stylePanel().querySelector('[data-style-size]') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(detail().querySelector('[data-remove-entry]') as HTMLButtonElement);
    expect([...(editor() as HTMLDialogElement).querySelectorAll<HTMLElement>('[data-family-avatar]')].map((element) => element.dataset['familyAvatar'])).toEqual(['Luna', 'Night']);
    expect(defaultRow().getAttribute('aria-selected')).toBe('true');
    fireEvent.click(saveButton());
    await settle();
    expect(savedDrafts()).toEqual([{ ref: MOONS_REF, revision: REVISION, draft: { ...MOONS_SOURCE.draft, avatars: [MOONS_SOURCE.draft.avatars[0], MOONS_SOURCE.draft.avatars[2]] } }]);
  });

  it('keeps the draft open on a conflict, and Reload asks before reading the file again', async () => {
    saveAnswers = [{ kind: 'conflict' }];
    await openEditor();
    fireEvent.change(stylePanel().querySelector('[data-style-group="version"] [data-style-size]') as HTMLSelectElement, { target: { value: '14' } });
    fireEvent.click(saveButton());
    await settle();
    expect(editor()?.hasAttribute('open')).toBe(true);
    expect((editor() as HTMLDialogElement).querySelector('[data-save-answer="conflict"]')?.textContent).toBe(EDITOR_WORDS.answers.conflict);
    fireEvent.click((editor() as HTMLDialogElement).querySelector('[data-reload-family]') as HTMLButtonElement);
    const asking = confirmation(EDITOR_WORDS.reloadTitle);
    expect(asking.textContent).toContain(EDITOR_WORDS.reloadBody);
    fireEvent.click(within(asking).getByRole('button', { name: EDITOR_WORDS.reload }));
    await settle();
    expect(asked('avatars:family')).toEqual([MOONS_REF, MOONS_REF]);
    expect((stylePanel().querySelector('[data-style-group="version"] [data-style-size]') as HTMLSelectElement).value).toBe('24');
    expect((editor() as HTMLDialogElement).querySelector('[data-save-answer]')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('closes at Cancel with nothing changed, and asks first when the draft holds changes', async () => {
    await openEditor();
    fireEvent.click(inEditor().getByRole('button', { name: EDITOR_WORDS.cancel }));
    expect(editor()).toBeNull();
    fireEvent.click(familyButton('Moons', 'user'));
    await settle();
    fireEvent.click(avatarRow('Gone'));
    fireEvent.click(detail().querySelector('[data-remove-entry]') as HTMLButtonElement);
    fireEvent.click(inEditor().getByRole('button', { name: EDITOR_WORDS.close }));
    const asking = confirmation(EDITOR_WORDS.discardTitle);
    fireEvent.click(within(asking).getByRole('button', { name: 'Cancel' }));
    expect(editor()?.hasAttribute('open')).toBe(true);
    expect(avatarRow('Gone')).toBeNull();
    fireEvent.click(inEditor().getAllByRole('button', { name: EDITOR_WORDS.cancel })[0] as HTMLButtonElement);
    fireEvent.click(within(confirmation(EDITOR_WORDS.discardTitle)).getByRole('button', { name: EDITOR_WORDS.discard }));
    expect(editor()).toBeNull();
    expect(savedDrafts()).toEqual([]);
  });

  it('edits a chosen avatar’s Overrides over the Default style, each field it sets highlighted with its way back, and Reset customizations clears them', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    expect(stylePanel().dataset['styleTarget']).toBe('avatar');
    expect(stylePanel().querySelector('h3')?.textContent).toBe(EDITOR_WORDS.styleOverrides);
    expect(stylePanel().querySelector('[data-customizations-note]')?.textContent).toBe(EDITOR_WORDS.highlighted);
    const reset = () => stylePanel().querySelector<HTMLButtonElement>('[data-reset-style]') as HTMLButtonElement;
    expect(reset().disabled).toBe(true);
    const field = () => stylePanel().querySelector<HTMLElement>('[data-style-field="effort.size"]') as HTMLElement;
    const toDefault = () => within(field()).getByRole<HTMLButtonElement>('button', { name: `${STYLE_WORDS.markSize}: ${STYLE_WORDS.familyDefault}` });
    // The default's value shows, not highlighted, until the avatar sets its own.
    expect(within(field()).queryByRole("button")).toBeNull();
    expect(field().hasAttribute('data-style-own')).toBe(false);
    expect((field().querySelector('select') as HTMLSelectElement).value).toBe(String(DEFAULT_EFFORT_LOOK.size));
    fireEvent.change(field().querySelector('select') as HTMLSelectElement, { target: { value: '9' } });
    expect(field().hasAttribute('data-style-own')).toBe(true);
    expect(reset().disabled).toBe(false);
    expect(avatarRow('Luna').getAttribute('aria-label')).toBe(`Luna, *sonnet*, ${EDITOR_WORDS.customized}`);
    expect(avatarRow('Luna').querySelector('[data-customized]')?.textContent).toBe(EDITOR_WORDS.customized);
    // The tag comes after the row's words: the matching is read first.
    expect(avatarRow('Luna').lastElementChild?.hasAttribute('data-customized')).toBe(true);
    expect(detail().querySelector<HTMLElement>('[data-style-preview] [data-size="column"] [data-effort-marks]')?.style.getPropertyValue('--effort-size')).toBe('9');
    fireEvent.click(toDefault());
    expect(field().hasAttribute('data-style-own')).toBe(false);
    // Its button goes with the override, the focus to the row's own control before it.
    expect(within(field()).queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(field().querySelector('select'));
    expect(avatarRow('Luna').getAttribute('aria-label')).toBe('Luna, *sonnet*');
    expect(saveButton().disabled).toBe(true);
    // Set again, then cleared whole.
    fireEvent.click(stylePanel().querySelector('[data-effort-position="top"]') as HTMLElement);
    expect(detail().querySelector<HTMLElement>('[data-style-preview] [data-size="column"] [data-effort-marks]')?.dataset['position']).toBe('top');
    fireEvent.click(reset());
    expect(avatarRow('Luna').getAttribute('aria-label')).toBe('Luna, *sonnet*');
    expect(stylePanel().querySelector('[data-style-own]')).toBeNull();
    fireEvent.click(stylePanel().querySelector('[data-effort-position="left"]') as HTMLElement);
    // Back to the Family default: the Default style, with no highlight and no way back.
    fireEvent.click(defaultRow());
    expect(stylePanel().dataset['styleTarget']).toBe('family');
    expect(stylePanel().querySelector('[data-style-own]')).toBeNull();
    expect(stylePanel().querySelector('[data-reset-style]')).toBeNull();
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.avatars[0]).toEqual({ folder: 'Luna', matches: ['*sonnet*'], overlay: { effort: { position: 'left' } } });
    expect(draft.overlay).toEqual(MOONS_SOURCE.draft.overlay);
  });

  it('offers a glow’s strength where the effect is Glow alone, for the text and the marks, and saves it', async () => {
    await openEditor();
    // The family glows (MOONS_SOURCE's preset): the version's row is there, fat-g's own 100 % chosen.
    const glow = () => stylePanel().querySelector<HTMLSelectElement>('[data-style-glow]');
    expect(glow()?.value).toBe('100');
    expect([...(glow() as HTMLSelectElement).options].map((option) => option.value)).toEqual(['0', '25', '50', '75', '100', '125', '150', '175', '200']);
    fireEvent.change(glow() as HTMLSelectElement, { target: { value: '150' } });
    expect(defaultDetail().querySelector<HTMLElement>('[data-style-preview] [data-size="column"] [data-overlay]')?.style.getPropertyValue('--overlay-glow')).toBe('1.5');
    // The marks are outlined: no row, until they glow too.
    expect(stylePanel().querySelector('[data-effort-glow]')).toBeNull();
    fireEvent.change(stylePanel().querySelector('[data-effort-effect]') as HTMLSelectElement, { target: { value: 'glow' } });
    fireEvent.change(stylePanel().querySelector('[data-effort-glow]') as HTMLSelectElement, { target: { value: '50' } });
    // Plain text has no glow to set.
    fireEvent.change(stylePanel().querySelector('[data-style-effect]') as HTMLSelectElement, { target: { value: 'plain' } });
    expect(glow()).toBeNull();
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.overlay).toEqual({ version: { preset: 'glow', glowStrength: 150, effect: 'plain' }, effort: { effect: 'glow', glowStrength: 50 } });
  });

  it('previews, inherits, resets and saves effect opacity separately from the text and mark colours', async () => {
    await openEditor();
    const opacity = () => stylePanel().querySelector<HTMLSelectElement>('[data-style-opacity]') as HTMLSelectElement;
    expect(opacity().value).toBe('100');
    fireEvent.change(opacity(), { target: { value: '70' } });
    expect(defaultDetail().querySelector<HTMLElement>('[data-style-preview] [data-overlay]')?.style.getPropertyValue('--overlay-effect-opacity')).toBe('70%');
    fireEvent.click(avatarRow('Luna'));
    expect(opacity().value).toBe('70');
    fireEvent.change(opacity(), { target: { value: '40' } });
    const field = stylePanel().querySelector('[data-style-field="version.effectOpacity"]') as HTMLElement;
    expect(field.hasAttribute('data-style-own')).toBe(true);
    fireEvent.click(within(field).getByRole('button'));
    expect(opacity().value).toBe('70');
    expect(field.hasAttribute('data-style-own')).toBe(false);
    fireEvent.change(stylePanel().querySelector('[data-effort-opacity]') as HTMLSelectElement, { target: { value: '50' } });
    expect(detail().querySelector<HTMLElement>('[data-style-preview] [data-effort-marks]')?.style.getPropertyValue('--effort-effect-opacity')).toBe('50%');
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.overlay).toEqual({ version: { preset: 'glow', effectOpacity: 70 } });
    expect(draft.avatars[0]?.overlay).toEqual({ effort: { effectOpacity: 50 } });
  });

  // Decision 0032: the fast bolt, in the marks' look at a place of its own.
  it('places the fast bolt in one of eight places, previewed as a fast session whether or not the marks show, overridden per avatar and saved', async () => {
    await openEditor();
    const grid = () => stylePanel().querySelector<HTMLElement>('[data-style-field="effort.fastPosition"] [role="radiogroup"]') as HTMLElement;
    const place = (position: string) => grid().querySelector<HTMLButtonElement>(`[data-fast-position="${position}"]`) as HTMLButtonElement;
    const bolt = (shown: () => HTMLElement, size = 'column') => shown().querySelector<HTMLElement>(`[data-style-preview] [data-size="${size}"] [data-fast-mark]`);
    // In the marks' group, under its own name: the version's eight places, fat-g's top left chosen.
    expect(grid().closest('[data-style-group]')?.getAttribute('data-style-group')).toBe('effort');
    expect(grid().getAttribute('aria-label')).toBe(STYLE_WORDS.fastPosition);
    expect([...grid().querySelectorAll<HTMLElement>('[data-fast-position]')].map((cell) => cell.dataset['fastPosition'])).toEqual(['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right']);
    expect(place('top-left').getAttribute('aria-checked')).toBe('true');
    // The previews are drawn as a fast session, at both sizes: the bolt stands where the place puts it.
    expect([bolt(defaultDetail)?.dataset['position'], bolt(defaultDetail, 'capsule')?.dataset['position']]).toEqual(['top-left', 'top-left']);
    fireEvent.click(place('bottom-right'));
    expect(bolt(defaultDetail)?.dataset['position']).toBe('bottom-right');
    // The arrows move it on the grid.
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(place('right').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(place('right'));
    // Hiding the marks leaves the bolt.
    fireEvent.click(stylePanel().querySelector('[data-effort-show]') as HTMLInputElement);
    expect(defaultDetail().querySelector('[data-style-preview] [data-effort-marks]')).toBeNull();
    expect(bolt(defaultDetail)?.dataset['position']).toBe('right');
    // An avatar's own place is an override, highlighted with its way back to the Default style's.
    fireEvent.click(avatarRow('Luna'));
    expect(place('right').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(place('top'));
    const field = stylePanel().querySelector('[data-style-field="effort.fastPosition"]') as HTMLElement;
    expect(field.hasAttribute('data-style-own')).toBe(true);
    expect(bolt(detail)?.dataset['position']).toBe('top');
    fireEvent.click(within(field).getByRole('button', { name: `${STYLE_WORDS.fastPosition}: ${STYLE_WORDS.familyDefault}` }));
    expect(field.hasAttribute('data-style-own')).toBe(false);
    expect(bolt(detail)?.dataset['position']).toBe('right');
    fireEvent.click(place('bottom-left'));
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.overlay).toEqual({ ...MOONS_SOURCE.draft.overlay, effort: { fastPosition: 'right', show: false } });
    expect(draft.avatars[0]?.overlay).toEqual({ effort: { fastPosition: 'bottom-left' } });
  });

  it('draws the Family default with the name and version whatever the Default style says, which the other avatars draw', async () => {
    await openEditor();
    expect(stylePanel().querySelector('[data-style-field="version.show"]')).toBeNull();
    // The Default style leaves the name out, as fat-g's defaults do; its row says the Family default shows both.
    const parts = stylePanel().querySelector('[data-style-field="version.parts"]') as HTMLElement;
    expect((parts.querySelector('[data-style-part="name"]') as HTMLInputElement).checked).toBe(false);
    expect(parts.textContent).toContain(STYLE_WORDS.partsOnDefault);
    fireEvent.change(defaultDetail().querySelector('[data-preview-model]') as HTMLSelectElement, { target: { value: 'claude/opus' } });
    // The first column under the root: the preview's own, before the fallback's beside it.
    const texts = (root: Element | null) => ['name', 'version'].map((part) => root?.querySelector('[data-size="column"]')?.querySelector(`[data-overlay-${part}]`)?.textContent ?? null);
    const fallback = () => defaultDetail().querySelector('[data-fallback-preview]');
    // The preview is the style as the other avatars wear it; beside it, the Family default as a model no
    // avatar suits shows it, with both, and why.
    expect(texts(defaultDetail().querySelector('[data-style-preview]'))).toEqual([null, '5.5']);
    expect(texts(fallback())).toEqual(['Opus', '5.5']);
    expect(fallback()?.getAttribute('role')).toBe('group');
    expect(within(defaultDetail()).getByRole('group', { name: EDITOR_WORDS.fallbackTitle })).toBe(fallback());
    expect(fallback()?.textContent).toContain(EDITOR_WORDS.fallbackWhy);
    // Name and Version are the only text visibility controls; neither can hide the fallback.
    fireEvent.click(parts.querySelector('[data-style-part="version"]') as HTMLInputElement);
    expect(texts(defaultDetail().querySelector('[data-style-preview]'))).toEqual([null, null]);
    expect(texts(fallback())).toEqual(['Opus', '5.5']);
    fireEvent.click(parts.querySelector('[data-style-part="version"]') as HTMLInputElement);
    // With both on, the two would draw alike: one preview alone.
    fireEvent.click(parts.querySelector('[data-style-part="name"]') as HTMLInputElement);
    expect(fallback()).toBeNull();
    expect(texts(defaultDetail().querySelector('[data-style-preview]'))).toEqual(['Opus', '5.5']);
    fireEvent.click(parts.querySelector('[data-style-part="name"]') as HTMLInputElement);
    // A model with no name to say draws alike too.
    fireEvent.change(defaultDetail().querySelector('[data-preview-model]') as HTMLSelectElement, { target: { value: 'codex/gpt-6-sol' } });
    expect(fallback()).toBeNull();
    // An avatar, as the same model, says the version alone, with no second preview; its overrides carry no such note.
    fireEvent.change(defaultDetail().querySelector('[data-preview-model]') as HTMLSelectElement, { target: { value: 'claude/opus' } });
    fireEvent.click(avatarRow('Luna'));
    expect(texts(detail().querySelector('[data-style-preview]'))).toEqual([null, '5.5']);
    expect(detail().querySelector('[data-fallback-preview]')).toBeNull();
    expect(stylePanel().textContent).not.toContain(STYLE_WORDS.partsOnDefault);
    // Its line's room is kept, unseen, so the editor keeps its height between the rows.
    expect(stylePanel().querySelector('[data-style-field="version.parts"] [aria-hidden="true"]')).not.toBeNull();
  });

  it('ends an override the Default style comes to agree with, the avatar following the Default style there from then on', async () => {
    // Luna shows the name, which the Default style does not; Night names the Default style's own glow, which overrides nothing.
    const own: Readonly<Record<string, OverlayLayer>> = { Luna: { version: { parts: { name: true } } }, Night: { version: { preset: 'glow' } } };
    await openEditor({ ...MOONS_SOURCE, draft: { ...MOONS_SOURCE.draft, avatars: MOONS_SOURCE.draft.avatars.map((avatar) => ({ ...avatar, overlay: own[avatar.folder] ?? avatar.overlay })) } });
    const customized = (folder: string) => avatarRow(folder).querySelector('[data-customized]') !== null;
    const nameBox = () => stylePanel().querySelector('[data-style-part="name"]') as HTMLInputElement;
    expect([customized('Luna'), customized('Night')]).toEqual([true, false]);
    // What the file holds is no change.
    expect(saveButton().disabled).toBe(true);
    // The Default style shows the name too: Luna's override ends.
    fireEvent.click(nameBox());
    expect(customized('Luna')).toBe(false);
    fireEvent.click(avatarRow('Luna'));
    expect(nameBox().checked).toBe(true);
    expect(stylePanel().querySelector('[data-style-field="version.parts"]')?.hasAttribute('data-style-own')).toBe(false);
    // Luna now follows it: the name hidden again in the Default style is hidden for Luna.
    fireEvent.click(defaultRow());
    fireEvent.click(nameBox());
    fireEvent.click(avatarRow('Luna'));
    expect(nameBox().checked).toBe(false);
    expect(customized('Luna')).toBe(false);
    fireEvent.click(defaultRow());
    fireEvent.click(nameBox());
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.overlay).toEqual({ version: { preset: 'glow', parts: { name: true, version: true } } });
    expect(draft.avatars.map((avatar) => [avatar.folder, avatar.overlay])).toEqual([['Luna', {}], ['Gone', {}], ['Night', {}]]);
  });

  it('edits an avatar’s match entries, flagging a pattern of the wrong form and saving none while one stands', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    const rows = () => [...detail().querySelectorAll<HTMLElement>('[data-match-row]')];
    expect(rows().map((element) => (element.querySelector('[data-match-key]') as HTMLInputElement).value)).toEqual(['*sonnet*']);
    fireEvent.click(detail().querySelector('[data-add-match]') as HTMLButtonElement);
    const added = () => rows()[1] as HTMLElement;
    expect((added().querySelector('[data-match-key]') as HTMLInputElement).value).toBe('*');
    fireEvent.change(added().querySelector('[data-match-key]') as HTMLInputElement, { target: { value: 'gpt 6!' } });
    expect(added().querySelector('[data-match-key]')?.getAttribute('aria-invalid')).toBe('true');
    expect(added().textContent).toContain(EDITOR_WORDS.badPattern);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(added().querySelector('[data-match-key]') as HTMLInputElement, { target: { value: 'gpt-6-*' } });
    fireEvent.change(added().querySelector('[data-match-provider]') as HTMLSelectElement, { target: { value: 'codex' } });
    expect(added().querySelector('[data-match-key]')?.hasAttribute('aria-invalid')).toBe(false);
    expect(detail().querySelector('[data-takes]')?.textContent).toBe(EDITOR_WORDS.takes(['Sonnet 5 (Claude)', 'GPT-6 Sol (Codex)']));
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: EDITOR_WORDS.removeMatch }));
    expect(detail().querySelector('[data-takes]')?.textContent).toBe(EDITOR_WORDS.takes(['GPT-6 Sol (Codex)']));
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.avatars[0]).toEqual({ folder: 'Luna', matches: [{ provider: 'codex', key: 'gpt-6-*' }], overlay: {} });
  });

  it('lists no avatar as a fallback but the Family default, and saves its Default folder in no avatar of the draft', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Night'));
    expect(avatarRow('Default')).toBeNull();
    expect(detail().textContent).not.toContain(AVATAR_WORDS.fallback);
    fireEvent.change(stylePanel().querySelector('[data-style-group="version"] [data-style-size]') as HTMLSelectElement, { target: { value: '14' } });
    fireEvent.click(saveButton());
    await settle();
    const draft = (savedDrafts()[0] as { draft: FamilySource['draft'] }).draft;
    expect(draft.avatars.map((avatar) => avatar.folder)).toEqual(['Luna', 'Gone', 'Night']);
    expect(draft.avatars[2]).toEqual({ folder: 'Night', matches: [], overlay: { version: { size: 14 } } });
  });

  it.each([
    ['packaged', { kind: 'packaged' }, EDITOR_WORDS.locks.packaged],
    ['link', { kind: 'link' }, EDITOR_WORDS.locks.link],
    ['manifest', { kind: 'manifest', cause: 'older', field: null }, 'family.json was written for an earlier version of fat-g, so the family stands as its folders'],
  ] as const)('opens read-only, saying why, where the family is %s-locked', async (kind, lock, words) => {
    await openEditor({ ...MOONS_SOURCE, lock });
    expect((editor() as HTMLDialogElement).querySelector(`[data-family-lock="${kind}"]`)?.textContent).toBe(kind === 'packaged' ? `${words} But you can Make a copy and edit it.` : words);
    expect((stylePanel().querySelector('[data-style-size]') as HTMLSelectElement).disabled).toBe(true);
    // Its avatars may still be looked at, and nothing of them changed.
    fireEvent.click(avatarRow('Night'));
    expect(detail().dataset['avatarDetail']).toBe('Night');
    expect((detail().querySelector('[data-add-match]') as HTMLButtonElement).disabled).toBe(true);
    expect((stylePanel().querySelector('[data-style-size]') as HTMLSelectElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it('says so where the family is no longer listed', async () => {
    sources.delete('user/Moons');
    await openScreen({}, CATALOG, PROVIDERS, {}, MOONS_LISTING);
    fireEvent.click(familyButton('Moons', 'user'));
    await settle();
    expect(editor()?.textContent).toContain(EDITOR_WORDS.gone);
    expect(saveButton().disabled).toBe(true);
  });
});

describe('the family editor’s columns and Add avatar (decision 0036)', () => {
  const PORTRAIT = new Uint8Array([1, 2, 3]);
  const SMALL = new Uint8Array([4, 5]);
  const PREPARED: PreparedImage = { kind: 'prepared', portrait: PORTRAIT, small: SMALL, sourceSide: 2048, portraitSide: 512 };
  const NEW_REVISION = 'b'.repeat(64);
  const SOL_SOURCE: FamilySource = { ...MOONS_SOURCE, revision: NEW_REVISION, draft: { ...MOONS_SOURCE.draft, avatars: [...MOONS_SOURCE.draft.avatars, { folder: 'Sol', matches: ['sol'], overlay: {} }] } };
  const SOL_MOONS = family('Moons', 'user', [...MOONS.avatars, avatar('Sol', { files: [file(20, 'portrait', 'png', 512), file(21, 'small', 'png', 64)], matches: [{ provider: null, key: 'sol' }] })]);
  const SOL_LISTING: AvatarListing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [SOL_MOONS], problems: [] }] };
  const prepare = vi.mocked(prepareAvatarImage);
  const created = vi.fn(() => 'blob:fat-g/added');
  const revoked = vi.fn();
  const panels = () => [...(editor() as HTMLDialogElement).querySelectorAll<HTMLElement>('[data-family-columns] > section')];
  const dropZone = () => (editor() as HTMLDialogElement).querySelector<HTMLButtonElement>('[data-avatar-drop]') as HTMLButtonElement;
  const popup = () => document.querySelector<HTMLDialogElement>('dialog[data-add-avatar]') as HTMLDialogElement;
  const nameField = () => popup().querySelector<HTMLInputElement>('[data-added-name]') as HTMLInputElement;
  const addButton = () => popup().querySelector<HTMLButtonElement>('[data-confirm-add]') as HTMLButtonElement;
  const drop = async (dropped: File, folder = false) => {
    const item = { kind: 'file', getAsFile: () => dropped, webkitGetAsEntry: () => ({ isDirectory: folder, name: dropped.name }) };
    fireEvent.drop(dropZone().parentElement as HTMLElement, { dataTransfer: { types: ['Files'], items: [item], files: [dropped] } });
    await settle();
  };
  const sol = () => new File([new Uint8Array([9])], 'Sol.png', { type: 'image/png' });

  beforeEach(() => {
    prepare.mockReset();
    prepare.mockResolvedValue(PREPARED);
    created.mockClear();
    revoked.mockClear();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
  });

  it('lays the editor out as its avatars, the one chosen under its name, and its style', async () => {
    await openEditor();
    const [list, chosen, style] = panels();
    expect(panels()).toHaveLength(3);
    expect(list?.querySelector('[role="listbox"]')).not.toBeNull();
    // The drop zone is the list column's last.
    expect(list?.lastElementChild?.contains(dropZone())).toBe(true);
    expect(dropZone().textContent).toBe(`${EDITOR_WORDS.drop.label}${EDITOR_WORDS.drop.hint}${EDITOR_WORDS.drop.square}${EDITOR_WORDS.drop.sizes}`);
    expect(dropZone().querySelector('strong')?.textContent).toBe('square');
    expect(chosen?.querySelector('h3')?.textContent).toBe(EDITOR_WORDS.avatarTitle(EDITOR_WORDS.familyDefault));
    expect(style?.dataset['styleTarget']).toBe('family');
    fireEvent.click(avatarRow('Luna'));
    expect(chosen?.querySelector('h3')?.textContent).toBe('Avatar: Luna');
    // Its preview, then its model and effort, then its matches.
    const order = [...(chosen?.querySelectorAll('[data-style-preview], [data-match-editor]') ?? [])].map((element) => (element.hasAttribute('data-match-editor') ? 'matches' : 'preview'));
    expect(order).toEqual(['preview', 'matches']);
    fireEvent.click(avatarRow('Gone'));
    expect(chosen?.querySelector('h3')?.textContent).toBe('Avatar: Gone');
  });

  it('adds a dropped image at once, named from its file with its matches, and keeps the draft’s other changes', async () => {
    addAnswer = { kind: 'added', folder: 'Sol', source: SOL_SOURCE, listing: SOL_LISTING };
    await openEditor();
    // A change not yet saved, which the add leaves as it is.
    fireEvent.change(inEditor().getByRole('combobox', { name: EDITOR_WORDS.provider }), { target: { value: 'claude' } });
    const dropped = sol();
    await drop(dropped);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(dropped);
    // Its folder is told main through the preload, for the next Browse.
    expect(bridge.calls).toContain('noteDropped:Sol.png');
    expect(popup().hasAttribute('open')).toBe(true);
    expect(within(popup()).getByRole('heading', { level: 2 }).textContent).toBe(EDITOR_WORDS.add.title('Moons'));
    expect(popup().querySelector('[data-added-sizes]')?.textContent).toBe(EDITOR_WORDS.add.sizes('Sol.png', 2048, 512));
    expect(popup().querySelector('[data-added-portrait]')?.getAttribute('src')).toBe('blob:fat-g/added');
    expect(nameField().value).toBe('Sol');
    expect([...popup().querySelectorAll<HTMLInputElement>('[data-match-key]')].map((input) => input.value)).toEqual(['Sol']);
    fireEvent.change(popup().querySelector('[data-match-key]') as HTMLInputElement, { target: { value: 'sol' } });
    fireEvent.click(addButton());
    expect(asked('avatars:addAvatar')).toEqual([{ ref: MOONS_REF, revision: REVISION, name: 'Sol', matches: ['sol'], portrait: PORTRAIT, small: SMALL }]);
    await settle();
    expect(popup().hasAttribute('open')).toBe(false);
    expect(revoked).toHaveBeenCalledTimes(2);
    expect(avatarRow('Sol').getAttribute('aria-selected')).toBe('true');
    expect(detail().querySelector('h3')?.textContent).toBe('Avatar: Sol');
    expect(detail().querySelector('[data-style-preview] img')?.getAttribute('src')).toBe(`app://media/avatars/${id(20)}`);
    // The provider is still the draft's, unsaved; a save is made from the revision the add answered.
    expect(inEditor().getByRole<HTMLSelectElement>('combobox', { name: EDITOR_WORDS.provider }).value).toBe('claude');
    expect((editor() as HTMLDialogElement).querySelector('[data-unsaved]')).not.toBeNull();
    fireEvent.click(saveButton());
    expect(savedDrafts()).toEqual([{ ref: MOONS_REF, revision: NEW_REVISION, draft: { ...SOL_SOURCE.draft, provider: 'claude' } }]);
  });

  it('takes an image chosen at the zone’s press, in the chooser main opens, as one dropped on it', async () => {
    chooseAnswer = { kind: 'chosen', name: 'Sol.png', bytes: new Uint8Array([9]) };
    await openEditor();
    fireEvent.click(dropZone());
    await settle();
    expect(asked('avatars:chooseImage')).toEqual([null]);
    expect(prepare).toHaveBeenCalledOnce();
    const chosen = prepare.mock.calls[0]?.[0] as File;
    expect(chosen.name).toBe('Sol.png');
    expect(new Uint8Array(await chosen.arrayBuffer())).toEqual(new Uint8Array([9]));
    expect(popup().hasAttribute('open')).toBe(true);
  });

  it('says why main would not read an image chosen, and does nothing when the chooser is cancelled', async () => {
    await openEditor();
    fireEvent.click(dropZone());
    await settle();
    expect((editor() as HTMLDialogElement).querySelector('[data-drop-problem]')).toBeNull();
    chooseAnswer = { kind: 'refused', reason: 'too-large' };
    fireEvent.click(dropZone());
    await settle();
    expect((editor() as HTMLDialogElement).querySelector('[data-drop-problem]')?.textContent).toBe(EDITOR_WORDS.imageRefusals['too-large']);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('checks the name as it is typed, and says what main refused', async () => {
    addAnswer = { kind: 'taken' };
    await openEditor();
    await drop(sol());
    for (const [name, words] of [['luna', EDITOR_WORDS.add.takenName], ['GONE', EDITOR_WORDS.add.takenName], ['default', EDITOR_WORDS.add.badName], ['a/b', EDITOR_WORDS.add.badName]] as const) {
      fireEvent.change(nameField(), { target: { value: name } });
      expect(popup().querySelector('[data-name-problem]')?.textContent).toBe(words);
      expect(addButton().disabled).toBe(true);
    }
    fireEvent.change(nameField(), { target: { value: '' } });
    expect(addButton().disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: 'Sol' } });
    expect(popup().querySelector('[data-name-problem]')).toBeNull();
    fireEvent.change(popup().querySelector('[data-match-key]') as HTMLInputElement, { target: { value: 'gpt 6' } });
    expect(addButton().disabled).toBe(true);
    fireEvent.change(popup().querySelector('[data-match-key]') as HTMLInputElement, { target: { value: 'sol' } });
    fireEvent.click(addButton());
    await settle();
    expect(popup().querySelector('[data-add-answer]')?.textContent).toBe(EDITOR_WORDS.add.answers.taken);
    expect(popup().hasAttribute('open')).toBe(true);
    // Cancel closes it, adding nothing.
    fireEvent.click(within(popup()).getByRole('button', { name: EDITOR_WORDS.cancel }));
    expect(popup().hasAttribute('open')).toBe(false);
    expect(editor()?.hasAttribute('open')).toBe(true);
  });

  it('hands the editor a file changed outside, which offers Reload', async () => {
    addAnswer = { kind: 'conflict' };
    await openEditor();
    await drop(sol());
    fireEvent.click(addButton());
    await settle();
    expect(popup().hasAttribute('open')).toBe(false);
    expect((editor() as HTMLDialogElement).querySelector('[data-save-answer="conflict"]')?.textContent).toBe(EDITOR_WORDS.answers.conflict);
    expect((editor() as HTMLDialogElement).querySelector('[data-reload-family]')).not.toBeNull();
  });

  it('says why an image is refused, and refuses a folder unread', async () => {
    await openEditor();
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'not-square', width: 600, height: 500 });
    await drop(sol());
    expect((editor() as HTMLDialogElement).querySelector('[data-drop-problem]')?.textContent).toBe(EDITOR_WORDS.notSquare(600, 500));
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unsupported' });
    await drop(sol());
    expect((editor() as HTMLDialogElement).querySelector('[data-drop-problem]')?.textContent).toBe(EDITOR_WORDS.imageRefusals.unsupported);
    await drop(sol(), true);
    expect((editor() as HTMLDialogElement).querySelector('[data-drop-problem]')?.textContent).toBe(EDITOR_WORDS.drop.folder);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(popup().hasAttribute('open')).toBe(false);
  });

  it('takes no image while the family may not be written', async () => {
    await openEditor({ ...MOONS_SOURCE, lock: { kind: 'packaged' } });
    expect(dropZone().disabled).toBe(true);
    await drop(sol());
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('an avatar’s images in the family editor (decision 0036)', () => {
  const PORTRAIT = new Uint8Array([1, 2, 3]);
  const SMALL = new Uint8Array([4, 5]);
  const PREPARED: PreparedImage = { kind: 'prepared', portrait: PORTRAIT, small: SMALL, sourceSide: 1024, portraitSide: 512 };
  const NEW_LUNA = family('Moons', 'user', MOONS.avatars.map((view) => (view.folder === 'Luna' ? { ...view, files: [file(30, 'portrait', 'png', 512), file(31, 'small', 'png', 64)] } : view)));
  const NEW_LISTING: AvatarListing = { roots: [{ origin: 'built-in', families: [BLUE, ORANGE], problems: [] }, { origin: 'user', families: [NEW_LUNA], problems: [] }] };
  const prepare = vi.mocked(prepareAvatarImage);
  const prepareSmall = vi.mocked(prepareSmallImage);
  const slot = (role: 'portrait' | 'small') => (editor() as HTMLDialogElement).querySelector<HTMLElement>(`[data-style-preview] [data-image-slot="${role}"]`) as HTMLElement;
  const label = (role: 'portrait' | 'small') => (editor() as HTMLDialogElement).querySelector<HTMLElement>(`[data-style-preview] [data-image-label="${role}"]`) as HTMLElement;
  const browse = (role: 'portrait' | 'small') => (editor() as HTMLDialogElement).querySelector<HTMLButtonElement>(`[data-browse-image="${role}"]`);
  const problem = () => (editor() as HTMLDialogElement).querySelector('[data-image-problem]')?.textContent ?? null;
  const dropOn = async (role: 'portrait' | 'small', dropped: File) => {
    const item = { kind: 'file', getAsFile: () => dropped, webkitGetAsEntry: () => ({ isDirectory: false, name: dropped.name }) };
    fireEvent.drop(slot(role), { dataTransfer: { types: ['Files'], items: [item], files: [dropped] } });
    await settle();
  };
  const art = () => new File([new Uint8Array([7])], 'art.png', { type: 'image/png' });

  beforeEach(() => {
    prepare.mockReset();
    prepare.mockResolvedValue(PREPARED);
    prepareSmall.mockReset();
    prepareSmall.mockResolvedValue({ kind: 'prepared', small: SMALL, sourceSide: 1024 });
  });

  it('describes each image at its left, its size and how to replace it, with no files line under the name', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    expect(detail().textContent).not.toContain('portrait.webp');
    expect(label('portrait').textContent).toBe(`${EDITOR_WORDS.images.main(512)}${EDITOR_WORDS.images.replace}${EDITOR_WORDS.images.browse}`);
    // Luna has no small: its main image stands in its place.
    expect(label('small').textContent).toBe(`${EDITOR_WORDS.images.noSmall}${EDITOR_WORDS.images.addSmall}${EDITOR_WORDS.images.browse}`);
    expect(slot('portrait').querySelector('[data-size="column"]')).not.toBeNull();
    expect(slot('small').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(7)}`);
    expect(within(slot('portrait')).queryByRole('img')).toBeNull();
    expect(slot('portrait').getAttribute('aria-labelledby')).toBe(label('portrait').querySelector('span')?.id);
    // The small version says it is made again with the main image; the main image has no note.
    expect((editor() as HTMLDialogElement).querySelector('[data-image-note="small"]')?.textContent).toBe(EDITOR_WORDS.images.autogenerated);
    expect((editor() as HTMLDialogElement).querySelector('[data-image-note="portrait"]')).toBeNull();
    // Preview as and effort on one line, under the images.
    const choice = (editor() as HTMLDialogElement).querySelector('[data-preview-choice]') as HTMLElement;
    expect(choice.querySelector('[data-preview-model]')).not.toBeNull();
    expect(choice.querySelector('[data-preview-effort]')).not.toBeNull();
    expect(within(choice).getByRole('combobox', { name: EDITOR_WORDS.effort })).toBeTruthy();
    expect(slot('small').compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The Family default's too.
    fireEvent.click(defaultRow());
    expect(label('portrait').textContent).toContain(EDITOR_WORDS.images.main(512));
  });

  it('replaces the main image and its small version with an image dropped onto it, at once', async () => {
    replaceAnswer = { kind: 'replaced', listing: NEW_LISTING };
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    const dropped = art();
    await dropOn('portrait', dropped);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(dropped);
    expect(bridge.calls).toContain('noteDropped:art.png');
    expect(asked('avatars:replaceImage')).toEqual([{ ref: MOONS_REF, avatar: 'Luna', portrait: PORTRAIT, small: SMALL }]);
    // The listing that holds the new files is drawn: the small version now its own.
    expect(slot('portrait').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(30)}`);
    expect(slot('small').querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${id(31)}`);
    expect(label('small').textContent).toContain(EDITOR_WORDS.images.small(64));
    expect(problem()).toBeNull();
    // Nothing of the draft changed.
    expect(saveButton().disabled).toBe(true);
  });

  it('replaces the small version alone with an image dropped onto it, or chosen at its Browse', async () => {
    replaceAnswer = { kind: 'replaced', listing: NEW_LISTING };
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    await dropOn('small', art());
    expect(prepare).not.toHaveBeenCalled();
    expect(asked('avatars:replaceImage')).toEqual([{ ref: MOONS_REF, avatar: 'Luna', portrait: null, small: SMALL }]);
    chooseAnswer = { kind: 'chosen', name: 'other.png', bytes: new Uint8Array([8]) };
    fireEvent.click(browse('small') as HTMLButtonElement);
    await settle();
    expect(asked('avatars:chooseImage')).toEqual([null]);
    expect((prepareSmall.mock.calls[1]?.[0] as File).name).toBe('other.png');
    expect(asked('avatars:replaceImage')).toHaveLength(2);
  });

  it('says why an image was refused, or main could not replace it', async () => {
    await openEditor();
    fireEvent.click(avatarRow('Luna'));
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'not-square', width: 600, height: 500 });
    await dropOn('portrait', art());
    expect(problem()).toBe(EDITOR_WORDS.notSquare(600, 500));
    expect(asked('avatars:replaceImage')).toEqual([]);
    await dropOn('portrait', art());
    expect(problem()).toBe(EDITOR_WORDS.images.answers.failed);
    // Another avatar's detail does not show it.
    fireEvent.click(avatarRow('Night'));
    expect(problem()).toBeNull();
  });

  it('offers no replacing while the family may not be written', async () => {
    await openEditor({ ...MOONS_SOURCE, lock: { kind: 'packaged' } });
    fireEvent.click(avatarRow('Luna'));
    expect(browse('portrait')).toBeNull();
    expect(label('portrait').textContent).toBe(EDITOR_WORDS.images.main(512));
    expect((editor() as HTMLDialogElement).querySelector('[data-image-note]')).toBeNull();
    await dropOn('portrait', art());
    expect(prepare).not.toHaveBeenCalled();
    expect(asked('avatars:replaceImage')).toEqual([]);
  });
});


describe('starting a family from an image', () => {
  const PORTRAIT = new Uint8Array([1, 2, 3]);
  const SMALL = new Uint8Array([4, 5]);
  const PREPARED: PreparedImage = { kind: 'prepared', portrait: PORTRAIT, small: SMALL, sourceSide: 1024, portraitSide: 512 };
  const prepare = vi.mocked(prepareAvatarImage);
  const revoked = vi.fn();
  const zone = () => within(section()).getByRole<HTMLButtonElement>('button', { name: /Drag an image here to start a new family/ });
  const popup = () => screen.getByRole<HTMLDialogElement>('dialog', { name: CREATE_FAMILY_WORDS.title });
  const name = () => within(popup()).getByRole<HTMLInputElement>('textbox', { name: CREATE_FAMILY_WORDS.familyName });
  const confirm = () => within(popup()).getByRole<HTMLButtonElement>('button', { name: CREATE_FAMILY_WORDS.confirm });
  const drop = async (folder = false) => {
    const image = new File([new Uint8Array([9])], 'Sun.png', { type: 'image/png' });
    const item = { kind: 'file', getAsFile: () => image, webkitGetAsEntry: () => ({ isDirectory: folder }) };
    fireEvent.drop(zone().parentElement as HTMLElement, { dataTransfer: { types: ['Files'], items: [item], files: [image] } });
    await settle();
  };
  beforeEach(() => {
    prepare.mockReset();
    prepare.mockResolvedValue(PREPARED);
    revoked.mockClear();
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:prepared'), revokeObjectURL: revoked });
  });
  const created = () => {
    const ref: FamilyRef = { origin: 'user', family: 'Planets' };
    const view = family('Planets', 'user', [avatar('Default', { files: [file(90, 'portrait', 'png', 512), file(91, 'small', 'png', 64)], fallback: true })]);
    const updated: AvatarListing = { roots: [listing.roots[0] as AvatarListing['roots'][number], { origin: 'user', families: [view], problems: [] }] };
    sources.set('user/Planets', { ref, revision: REVISION, lock: null, missing: [], draft: { provider: 'any', overlay: {}, avatars: [] } });
    createAnswer = { kind: 'created', ref, listing: updated };
  };

  it('replaces the large guide with the drop area, and places compact Technical details after Show avatars folder', async () => {
    await open();
    const families = within(section()).getByRole('region', { name: AVATARS_TAB_TEXT.families });
    expect(within(families).queryByRole('button', { name: /Create your own avatar family/ })).toBeNull();
    const info = within(families).getByRole('button', { name: 'Technical details' });
    expect(info.previousElementSibling?.textContent).toBe('Show avatars folder');
    expect(zone().textContent).toContain('square');
    fireEvent.click(info);
    expect(screen.getByRole('dialog', { name: 'Avatar families' })).toBeTruthy();
  });

  it('previews the prepared images and creates just Default without matches, then opens the editable family', async () => {
    await open();
    await drop();
    expect(name().value).toBe('Sun');
    expect(document.activeElement).toBe(name());
    expect(popup().querySelectorAll('img')).toHaveLength(2);
    expect(within(popup()).queryByRole('textbox', { name: CREATE_FAMILY_WORDS.avatarName })).toBeNull();
    expect(popup().querySelector('[data-takes]')).toBeNull();
    fireEvent.change(name(), { target: { value: 'Planets' } });
    created();
    fireEvent.click(confirm());
    await settle();
    expect(asked('avatars:createFamily')).toEqual([{ name: 'Planets', avatar: null, portrait: PORTRAIT, small: SMALL }]);
    expect(screen.queryByRole('dialog', { name: CREATE_FAMILY_WORDS.title })).toBeNull();
    expect(editor()?.open).toBe(true);
    expect(familyRow('Planets', 'user')).not.toBeNull();
    expect(asked('prefs:patch')).toEqual([]);
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it('includes a named avatar with optional matches, validates its name and patterns', async () => {
    await open();
    await drop();
    fireEvent.change(name(), { target: { value: 'Planets' } });
    fireEvent.click(within(popup()).getByRole('button', { name: EDITOR_WORDS.addMatch }));
    const avatarName = within(popup()).getByRole<HTMLInputElement>('textbox', { name: CREATE_FAMILY_WORDS.avatarName });
    expect(avatarName.value).toBe('Sun');
    fireEvent.change(avatarName, { target: { value: 'Default' } });
    expect(confirm().disabled).toBe(true);
    fireEvent.change(avatarName, { target: { value: 'Sun' } });
    const pattern = within(popup()).getByRole('textbox', { name: `${EDITOR_WORDS.pattern} 1` });
    fireEvent.change(pattern, { target: { value: 'bad pattern' } });
    expect(confirm().disabled).toBe(true);
    fireEvent.change(pattern, { target: { value: '*sol*' } });
    fireEvent.click(confirm());
    await settle();
    expect(asked('avatars:createFamily')).toEqual([{ name: 'Planets', avatar: { name: 'Sun', matches: ['*sol*'] }, portrait: PORTRAIT, small: SMALL }]);
  });

  it.each(['', '../escape', 'NUL', 'Family.', 'x'.repeat(65)])('disables creation for an invalid family name %s', async (value) => {
    await open();
    await drop();
    fireEvent.change(name(), { target: { value } });
    expect(confirm().disabled).toBe(true);
    expect(asked('avatars:createFamily')).toEqual([]);
  });

  it('refuses a known user family name across case, but allows a built-in family name', async () => {
    listing = { ...listing, roots: [...listing.roots, { origin: 'user', families: [MOONS], problems: [] }] };
    await open();
    await drop();
    fireEvent.change(name(), { target: { value: 'moons' } });
    expect(confirm().disabled).toBe(true);
    fireEvent.change(name(), { target: { value: BLUE.folder } });
    expect(confirm().disabled).toBe(false);
  });

  it.each(['Cancel', 'native close'])('cancels with %s, writes nothing and restores focus to the drop area', async (method) => {
    await open();
    await drop();
    if (method === 'Cancel') fireEvent.click(within(popup()).getByRole('button', { name: 'Cancel' }));
    else act(() => popup().close());
    await settle();
    expect(screen.queryByRole('dialog', { name: CREATE_FAMILY_WORDS.title })).toBeNull();
    expect(asked('avatars:createFamily')).toEqual([]);
    expect(document.activeElement).toBe(zone());
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it.each(['taken', 'failed', 'unavailable'] as const)('keeps the dialog, name and image after a %s response and allows retry', async (kind) => {
    await open();
    await drop();
    createAnswer = { kind };
    fireEvent.click(confirm());
    await settle();
    expect(name().value).toBe('Sun');
    expect(popup().textContent).toContain(CREATE_FAMILY_WORDS.answers[kind]);
    expect(confirm().disabled).toBe(false);
    expect(popup().querySelectorAll('img')).toHaveLength(2);
  });

  it('holds Escape and disables edits while creating, sends once, and permits closing after a refusal', async () => {
    await open();
    await drop();
    let finish: ((reply: { ok: true; value: CreateFamilyAnswer }) => void) | undefined;
    let creates = 0;
    bridge.setInvoke(() => {
      creates += 1;
      return new Promise((resolve) => { finish = resolve; });
    });
    const button = confirm();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(creates).toBe(1);
    expect(name().disabled).toBe(true);
    expect(within(popup()).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
    const cancel = new Event('cancel', { cancelable: true, bubbles: true });
    fireEvent(popup(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(popup().open).toBe(true);
    await act(async () => { finish?.({ ok: true, value: { kind: 'failed' } }); await Promise.resolve(); });
    expect(confirm().disabled).toBe(false);
    fireEvent.click(within(popup()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(document.activeElement).toBe(zone());
  });

  it('supports browsing and refuses a folder before reading it, or a nonsquare image before creation', async () => {
    await open();
    await drop(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(asked('avatars:createFamily')).toEqual([]);
    prepare.mockResolvedValue({ kind: 'refused', reason: 'not-square', width: 100, height: 200 });
    await drop();
    expect(screen.queryByRole('dialog', { name: CREATE_FAMILY_WORDS.title })).toBeNull();
    expect(section().textContent).toContain(EDITOR_WORDS.notSquare(100, 200));
    prepare.mockResolvedValue(PREPARED);
    chooseAnswer = { kind: 'chosen', name: 'Sun.png', bytes: new Uint8Array([9]) };
    fireEvent.click(zone());
    await settle();
    expect(name().value).toBe('Sun');
    expect(asked('avatars:chooseImage')).toEqual([null]);
  });
});
