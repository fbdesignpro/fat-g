// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V15 (docs/planning/_archive/M22.md; C1, C40, C43, C44): the hierarchy as main resolves it — over the
// descriptors' declarations, the two defaults and what each account's facet says it can use.
import { describe, expect, it } from 'vitest';
import type { ModeAvailability, PermissionCapability } from '@shared/contracts/permissions';
import { createPermissions } from './permissions';

const mode = (id: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label: id.toUpperCase(), description: '', asks: true, reading: false, transitionsFrom: [] as string[], ...patch });
const capability = (ids: readonly string[]): PermissionCapability => ({ modes: ids.map((id) => mode(id, id === 'read-only' ? { reading: true, asks: false } : {})), fallback: 'ask-first', setup: null, inherited: '', rules: '' });
const CAPABILITIES: Record<string, PermissionCapability | null> = { codex: capability(['read-only', 'ask-first', 'sandbox-ok']), claude: capability(['read-only', 'ask-first', 'edits-ok']), plain: null };
const unavailable = (id: string): ModeAvailability => ({ id, available: false, reason: 'needs-setup', setup: true, records: false, unconfined: false, places: null });

function make(world: { user?: Record<string, string>; project?: Record<string, string>; availability?: Record<string, readonly ModeAvailability[]> } = {}) {
  return createPermissions({
    capability: (providerId) => CAPABILITIES[providerId] ?? null,
    userDefault: (providerId) => world.user?.[providerId] ?? null,
    projectDefault: (_projectId, providerId) => world.project?.[providerId] ?? null,
    availability: (ref) => world.availability?.[`${ref.providerId}:${ref.instanceId}`],
  });
}
const owner = (providerId: string, instanceId = 'default') => ({ providerId, instanceId, projectId: 'p1' });

describe('the hierarchy, in main (C1, C40, C43, C44)', () => {
  it('keeps a saved mode as it stands, with the source it was saved with', () => {
    const permissions = make({ user: { codex: 'sandbox-ok' }, project: { codex: 'read-only' } });
    expect(permissions.resolve(owner('codex'), { id: 'sandbox-ok', source: 'project' })).toEqual({ id: 'sandbox-ok', source: 'project' });
    // Even one its provider no longer lists: nothing is substituted, and its availability says it cannot be used.
    expect(permissions.resolve(owner('codex'), { id: 'edits-ok', source: 'chat' })).toEqual({ id: 'edits-ok', source: 'chat' });
    expect(permissions.availability({ providerId: 'codex', instanceId: 'default' }, 'edits-ok')).toMatchObject({ available: false, reason: 'unvalidated' });
  });

  it('gives a chat with none saved the project’s default for its provider, then the user’s, then the fallback', () => {
    expect(make({ user: { codex: 'sandbox-ok' }, project: { codex: 'read-only' } }).resolve(owner('codex'), null)).toEqual({ id: 'read-only', source: 'project' });
    expect(make({ user: { codex: 'sandbox-ok' } }).resolve(owner('codex'), null)).toEqual({ id: 'sandbox-ok', source: 'user' });
    expect(make().resolve(owner('codex'), null)).toEqual({ id: 'ask-first', source: 'fallback' });
  });

  it('reads each default for the chat’s own provider alone: one provider’s id is no choice for another', () => {
    const permissions = make({ user: { codex: 'sandbox-ok', claude: 'edits-ok' }, project: { claude: 'sandbox-ok' } });
    // The project's entry for Claude names a mode Claude does not list: no choice, so the user's stands.
    expect(permissions.resolve(owner('claude'), null)).toEqual({ id: 'edits-ok', source: 'user' });
    expect(permissions.resolve(owner('codex'), null)).toEqual({ id: 'sandbox-ok', source: 'user' });
  });

  it('falls back to the reading mode for an account that cannot use the fallback, and judges each account by itself', () => {
    const permissions = make({ availability: { 'codex:work': [unavailable('ask-first')] } });
    expect(permissions.resolve(owner('codex', 'work'), null)).toEqual({ id: 'read-only', source: 'fallback' });
    expect(permissions.resolve(owner('codex'), null)).toEqual({ id: 'ask-first', source: 'fallback' });
    expect(permissions.availability({ providerId: 'codex', instanceId: 'work' }, 'ask-first')).toMatchObject({ available: false, reason: 'needs-setup', setup: true });
    // An account whose facet has said nothing yet is taken to run every listed mode.
    expect(permissions.availability({ providerId: 'codex', instanceId: 'default' }, 'sandbox-ok')).toMatchObject({ available: true, reason: null });
  });

  it('has no mode for a provider that declares none', () => {
    const permissions = make({ user: { plain: 'ask-first' } });
    expect(permissions.capability('plain')).toBeNull();
    expect(permissions.resolve(owner('plain'), { id: 'ask-first', source: 'chat' })).toBeNull();
    expect(permissions.listed('plain', 'ask-first')).toBeUndefined();
    expect(permissions.listed('codex', 'sandbox-ok')?.label).toBe('SANDBOX-OK');
  });
});
