// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { RecordsState } from '@shared/contracts/projects';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { SAMPLE_EMAIL, SAMPLE_ORGANIZATION, sampleAccount, sampleProvider, sampleSnapshot } from '../../../tests/support/app-state';
import { sessionEntry, sessionsState, SUMMARIES } from '../../../tests/support/sessions';
import { projectForWindow } from './projection';

describe('projectForWindow — main', () => {
  it('passes the snapshot through untouched', () => {
    const snapshot = sampleSnapshot();
    expect(projectForWindow('main', snapshot)).toBe(snapshot);
  });
});

describe('projectForWindow — pet (always on top, visible in screen shares)', () => {
  it('removes email and organization from every provider', () => {
    const pet = projectForWindow('pet', sampleSnapshot());
    const serialized = JSON.stringify(pet);

    expect(serialized).not.toContain(SAMPLE_EMAIL);
    expect(serialized).not.toContain(SAMPLE_ORGANIZATION);
    for (const provider of pet.providers) {
      expect(provider.account).not.toHaveProperty('email');
      expect(provider.account).not.toHaveProperty('organization');
    }
  });

  it('keeps what the Pet needs: sign-in kind, plan, status, usage and timing', () => {
    const snapshot = sampleSnapshot(7);
    const pet = projectForWindow('pet', snapshot);
    const [original] = snapshot.providers;
    const [projected] = pet.providers;

    expect(pet.seq).toBe(7);
    expect(projected).toEqual({
      id: original?.id,
      // What tells two snapshots of one provider apart, and nothing else of the instance (M14b, C67).
      instanceId: original?.instanceId,
      label: '',
      instanceVariable: null,
      startedWithout: [],
      displayName: original?.displayName,
      descriptor: original?.descriptor,
      installation: original?.installation,
      status: original?.status,
      account: { authKind: 'subscription', plan: 'max' },
      usage: original?.usage,
      asOf: original?.asOf,
      nextRefreshAt: original?.nextRefreshAt,
      refreshing: original?.refreshing,
    });
  });

  // M22, V7 (C26): which modes an account can use holds paths of the user's own configuration, and a
  // setup's state is the account's: neither reaches the Pet. The modes a provider declares are words
  // of its descriptor, and reach it as the other capabilities do.
  it('drops an account’s mode availability and its sandbox setup, and keeps the descriptor’s declared modes', () => {
    const permissions = { modes: [{ id: 'ask-first', label: 'Ask first', description: 'Each command asks.', asks: true, reading: false, transitionsFrom: [] }], fallback: 'ask-first', setup: { changes: 'It changes the machine.', approval: 'The system asks.', waiting: 'It may be asking.' }, inherited: 'Rules act.', rules: 'None listed.' };
    const base = sampleProvider({ id: 'codex' });
    const provider: ProviderSnapshot = {
      ...base,
      descriptor: { ...base.descriptor, capabilities: { ...base.descriptor.capabilities, permissions } },
      modes: [{ id: 'ask-first', available: true, reason: null, setup: false, records: true, unconfined: false, places: { temporary: true, roots: ['D:\\Private\\root'], network: false } }],
      sandboxSetup: { state: 'failed', error: 'PRIVATE-SETUP-ERROR', readiness: 'not-configured' },
    };
    const [projected] = projectForWindow('pet', sampleSnapshot(1, [provider])).providers;
    expect(projected).not.toHaveProperty('modes');
    expect(projected).not.toHaveProperty('sandboxSetup');
    expect(projected?.descriptor.capabilities.permissions).toEqual(permissions);
    expect(JSON.stringify(projected)).not.toMatch(/Private|PRIVATE/);
    // The Main window is shown all of it.
    expect(projectForWindow('main', sampleSnapshot(1, [provider])).providers[0]?.modes).toEqual(provider.modes);
  });

  // M14b, V7 and V23 (C24, C50, C67): two accounts of one provider reach the Pet as two snapshots it
  // can tell apart, with nothing of the user's own words or environment.
  it('keeps each instance’s id and drops its label, its variable and the names it was started without', () => {
    const added = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
    const pet = projectForWindow('pet', sampleSnapshot(1, [
      sampleProvider({ id: 'codex', label: 'Personal', instanceVariable: 'CODEX_HOME' }),
      sampleProvider({ id: 'codex', instanceId: added, label: 'Work', instanceVariable: 'CODEX_HOME', startedWithout: ['OPENAI_API_KEY'] }),
    ]));
    expect(pet.providers.map((provider) => [provider.id, provider.instanceId])).toEqual([['codex', 'default'], ['codex', added]]);
    for (const provider of pet.providers) expect(provider).toMatchObject({ label: '', instanceVariable: null, startedWithout: [] });
    expect(JSON.stringify(pet)).not.toMatch(/Personal|Work|CODEX_HOME|OPENAI_API_KEY/);
    // The Main window gets them all.
    expect(JSON.stringify(projectForWindow('main', sampleSnapshot(1, [sampleProvider({ label: 'Work', startedWithout: ['OPENAI_API_KEY'] })])))).toMatch(/Work.*OPENAI_API_KEY/s);
  });

  it('does not invent a plan, and keeps a missing account missing', () => {
    const pet = projectForWindow('pet', sampleSnapshot(1, [sampleProvider({ account: sampleAccount({ plan: undefined }) }), sampleProvider({ id: 'codex', account: null })]));
    expect(pet.providers[0]?.account).toEqual({ authKind: 'subscription' });
    expect(pet.providers[1]?.account).toBeNull();
  });

  it('drops fields it does not know about (allowlist, not denylist)', () => {
    // Simulates a field added to ProviderSnapshot later without updating the projection.
    const withExtra = { ...sampleProvider(), executablePath: 'C:\\Users\\someone\\bin\\claude.exe' } as ProviderSnapshot;
    const pet = projectForWindow('pet', sampleSnapshot(1, [withExtra]));
    expect(pet.providers[0]).not.toHaveProperty('executablePath');
  });

  // C9, C64: the Pet follows the theme without being allowed to read preferences.
  it.each(['light', 'dark'] as const)('carries the %s theme, as the Main window’s projection does', (theme) => {
    const snapshot = sampleSnapshot(3, undefined, theme);
    expect(projectForWindow('pet', snapshot).appearance).toEqual({ theme });
    expect(projectForWindow('main', snapshot).appearance).toEqual({ theme });
  });

  it('copies appearance by name, dropping anything else put beside the theme', () => {
    const snapshot = { ...sampleSnapshot(1), appearance: { theme: 'dark', accountHint: 'user@example.com' } } as ReturnType<typeof sampleSnapshot>;
    expect(projectForWindow('pet', snapshot).appearance).toEqual({ theme: 'dark' });
    expect(Object.keys(projectForWindow('pet', snapshot)).sort()).toEqual(['appearance', 'pet', 'providers', 'seq']);
  });

  // The maintainer: the Pet's capsules flash as the Main window's do, so it gets the setting, field by field.
  it('copies the attention flash by name, dropping anything else put beside it', () => {
    const flash = { enabled: false, speed: 'slow', seconds: 5, accountHint: 'user@example.com' };
    const snapshot = { ...sampleSnapshot(1), appearance: { theme: 'dark', flash } } as ReturnType<typeof sampleSnapshot>;
    expect(projectForWindow('pet', snapshot).appearance).toEqual({ theme: 'dark', flash: { enabled: false, speed: 'slow', seconds: 5 } });
    expect(projectForWindow('main', snapshot).appearance).toBe(snapshot.appearance);
  });

  it('gives the Main window its zoom and the Pet none, which keeps its own at 100%', () => {
    const snapshot = { ...sampleSnapshot(1), zoom: 125 };
    expect(projectForWindow('main', snapshot).zoom).toBe(125);
    expect('zoom' in projectForWindow('pet', snapshot)).toBe(false);
  });

  it('leaves the source snapshot untouched', () => {
    const snapshot = sampleSnapshot();
    const before = JSON.stringify(snapshot);
    projectForWindow('pet', snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });
});

// M12 (C52, V9): projects hold root paths, and root paths hold the user's name.
describe('projectForWindow — records', () => {
  const records: RecordsState = {
    status: { kind: 'ok', keptAs: 'C:\\Users\\someone\\AppData\\Roaming\\fat-g\\records.set-aside.x.json' },
    projects: [{
      kind: 'project', key: 'k', id: 'k', name: 'Secret project', color: 'teal', hidden: false, collapsed: false, providers: ['codex'], permissionModes: {},
      roots: [{ path: 'C:\\Users\\someone\\code', trust: 'trusted', missing: false }], sessions: 0,
    }],
  };

  it('reach the Main window whole', () => {
    const snapshot = { ...sampleSnapshot(3), records };
    expect(projectForWindow('main', snapshot).records).toBe(records);
  });

  it('never reach the Pet: its copy has no records key at all', () => {
    const pet = projectForWindow('pet', { ...sampleSnapshot(3), records });
    expect('records' in pet).toBe(false);
    expect(JSON.stringify(pet)).not.toMatch(/someone|Secret/);
  });
});

// M13 (C50, V14): the catalog holds the override's path, which holds the user's name. The Pet draws
// the colour and mark of the providers of the sessions it lists alone, from its own view (decision 0010).
describe('projectForWindow — catalog', () => {
  it('reaches the Main window whole', () => {
    const snapshot = sampleSnapshot(3);
    expect(snapshot.catalog).toBeDefined();
    expect(projectForWindow('main', snapshot).catalog).toBe(snapshot.catalog);
  });

  it('never reaches the Pet: no catalog key, no override status, no presentation of a provider it lists no session of', () => {
    const pet = projectForWindow('pet', sampleSnapshot(3));
    expect('catalog' in pet).toBe(false);
    expect(pet.pet?.presentation).toEqual({});
    const serialized = JSON.stringify(pet);
    expect(serialized).not.toMatch(/barColor|someone|catalog\.json|"override"/);
    for (const provider of pet.providers) expect(provider.descriptor).not.toHaveProperty('presentation');
  });
});

// M102 (C35, V6; decision 0010): the resolved avatar stands in the session entry and the catalog
// model, main's. The Pet draws the sessions it lists, by their files' ids alone: never the folders'
// names, the listing, a model's or a sub-agent's.
describe('projectForWindow — avatars', () => {
  const face = { ref: { origin: 'user' as const, family: 'Private family', avatar: 'Private avatar' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
  const entry = { ...sessionEntry('A session', SUMMARIES.questions), avatar: face };
  const base = sampleSnapshot(3);
  const catalog = base.catalog === undefined ? undefined : { ...base.catalog, providers: base.catalog.providers.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model, avatar: face })) })) };
  const snapshot = { ...base, sessions: sessionsState([entry], null, 0), ...(catalog === undefined ? {} : { catalog }) };

  it('reach the Main window in the entries and the models', () => {
    expect(projectForWindow('main', snapshot).sessions?.sessions[0]?.avatar).toBe(face);
  });

  it('reach the Pet as a listed session’s files alone: no reference, no listing, no path', () => {
    const pet = projectForWindow('pet', snapshot);
    expect(pet.pet?.projects).toEqual([]); // the fixture's session has no project in this snapshot's records
    const listed = projectForWindow('pet', { ...snapshot, records: { status: { kind: 'ok', keptAs: null }, projects: [{ kind: 'project', key: entry.record.projectId, id: entry.record.projectId, name: 'Alpha', color: null, hidden: false, collapsed: false, providers: [], roots: [], sessions: 1, permissionModes: {} }] } });
    expect(listed.pet?.projects[0]?.sessions[0]?.avatar).toEqual({ portrait: 'a'.repeat(32), small: 'b'.repeat(32) });
    expect(JSON.stringify(listed)).not.toMatch(/Private family|Private avatar|family|listing|app:\/\/media|"ref"/i);
  });

  // M103 (V3; C8): an assigned avatar stands where the default face stood, main's; the Pet reads no
  // preferences, so no assignment, no model key and no reference reaches it.
  it('never reach the Pet when assigned: no assignment, no reference, no model', () => {
    const assigned = { ref: { origin: 'built-in' as const, family: 'Assigned family', avatar: 'Assigned avatar' }, portrait: 'c'.repeat(32), small: null };
    const withAssigned = { ...snapshot, sessions: sessionsState([{ ...entry, avatar: assigned }], null, 0) };
    expect(projectForWindow('main', withAssigned).sessions?.sessions[0]?.avatar).toBe(assigned);
    const serialized = JSON.stringify(projectForWindow('pet', withAssigned));
    expect(serialized).not.toMatch(/assign|Assigned family|Assigned avatar|preferences|sample-1/i);
  });

  // M106 (V4; C17): each sub-agent's avatar, by its model, stands in the entry beside the session's;
  // the Pet holds none of it, nor any sub-agent's model.
  it('never reach the Pet for a sub-agent: no avatar, no model', () => {
    const own = { ref: { origin: 'user' as const, family: 'Worker family', avatar: 'Worker avatar' }, portrait: 'd'.repeat(32), small: null };
    const agent = { id: 'worker-private', number: 1, label: 'Reads the private notes', state: 'running' as const, action: null, startedAt: 5, finishedAt: null, model: 'claude-haiku-private', agentType: 'Explore', attention: null };
    const withAgent = { ...snapshot, sessions: sessionsState([{ ...entry, summary: { ...entry.summary, agents: [agent] }, agentAvatars: { [agent.id]: own } }], null, 0) };
    expect(projectForWindow('main', withAgent).sessions?.sessions[0]?.agentAvatars?.[agent.id]).toBe(own);
    const serialized = JSON.stringify(projectForWindow('pet', withAgent));
    expect(serialized).not.toMatch(/Worker family|Worker avatar|dddddddd|worker-private|haiku-private|Explore|Reads the private/i);
  });
});

// M14 (C65, C100, V7; decision 0010): a session's name and its project are the user's own, and the
// quit question is the Main page's to show.
describe('projectForWindow — sessions and the quit question', () => {
  const sessions = sessionsState([sessionEntry('A private plan', SUMMARIES.questions)], null, 2);
  const snapshot = { ...sampleSnapshot(3), sessions, quitQuestion: true };

  it('reach the Main window whole', () => {
    expect(projectForWindow('main', snapshot).sessions).toBe(sessions);
    expect(projectForWindow('main', snapshot).quitQuestion).toBe(true);
  });

  it('never reach the Pet whole: no sessions key, no quit question, no selection, only its own view', () => {
    const pet = projectForWindow('pet', snapshot);
    expect('sessions' in pet).toBe(false);
    expect('quitQuestion' in pet).toBe(false);
    expect(Object.keys(pet).sort()).toEqual(['appearance', 'pet', 'providers', 'seq']);
    expect(JSON.stringify(pet)).not.toMatch(/selectedId|orphans|quitQuestion/i);
  });

  // M20a, V7 (C30): what a session does is conversation content. The app state has no place for it:
  // a summary's fields are what they were, and an activity reaches the Main window by the chat's
  // channels alone, which the Pet is refused.
  it('hold nothing of an activity: a summary is its nine fields, and the app state names no item', () => {
    for (const summary of Object.values(SUMMARIES)) {
      expect(Object.keys(summary).sort()).toEqual(['action', 'activeWorkers', 'agents', 'attention', 'effort', 'mode', 'model', 'status', 'turnStartedAt']);
      // A sub-agent's model, agent definition and attention are labels, a key and a count (M106, C8, C13, C20): nothing of what it did or said.
      for (const agent of summary.agents) expect(Object.keys(agent).sort()).toEqual(['action', 'agentType', 'attention', 'finishedAt', 'id', 'label', 'model', 'number', 'startedAt', 'state']);
    }
    expect(Object.keys(projectForWindow('main', snapshot)).sort()).not.toEqual(expect.arrayContaining(['chat', 'activity', 'items']));
    expect(JSON.stringify(projectForWindow('main', snapshot))).not.toMatch(/"activity"|"output"|"exitCode"/);
  });

  // M20b, V7 (C4, C33): a question asked beside a session is conversation content too. Nothing of it
  // is in the app state — no list of asides, no title, no passage — and a summary has no field for
  // it: an aside changes no status, no action and no attention of its session.
  it('hold nothing of an aside: the app state has no key for one, in the Main window’s copy or the Pet’s', () => {
    for (const kind of ['main', 'pet'] as const) {
      const projected = projectForWindow(kind, snapshot);
      expect(Object.keys(projected), kind).not.toEqual(expect.arrayContaining(['asides']));
      // But for what a provider declares of itself — whether it answers asides at all (C24) — which is no session's content.
      const { providers: _providers, ...rest } = projected;
      // (`asking` is an action's kind, M14's: a session that asks the user a question. It is no aside's word.)
      expect(/"asides?"|"asideId"|"excerpt"/.exec(JSON.stringify(rest))?.[0] ?? null, kind).toBeNull();
    }
    for (const summary of Object.values(SUMMARIES)) expect(Object.keys(summary)).not.toEqual(expect.arrayContaining(['asides', 'aside']));
  });

  // M21, V8 (C34): a question the session asks, its options and its answer are conversation content.
  // The summary says that a question waits and how many do — a kind and a count — and fat-g's words
  // for the line; the Pet's view carries the kind and the count alone, not even those words.
  it('hold nothing of a question beyond the attention’s kind and count: no text, no option, no answer, no request id', () => {
    const asking = SUMMARIES.questions;
    expect(asking.attention).toEqual({ kind: 'question', count: 3, acknowledged: false });
    expect(asking.action).toEqual({ kind: 'asking', label: 'Asking a question', detail: null });
    for (const summary of Object.values(SUMMARIES)) {
      expect(Object.keys(summary).sort()).toEqual(['action', 'activeWorkers', 'agents', 'attention', 'effort', 'mode', 'model', 'status', 'turnStartedAt']);
      if (summary.attention !== null) expect(Object.keys(summary.attention).sort()).toEqual(['acknowledged', 'count', 'kind']);
    }
    const main = JSON.stringify(projectForWindow('main', snapshot).sessions);
    expect(/"interaction"|"questions"|"answers"|"requestId"|"options"/.exec(main)?.[0] ?? null).toBeNull();
    const pet = projectForWindow('pet', snapshot);
    expect(Object.keys(pet).sort()).toEqual(['appearance', 'pet', 'providers', 'seq']);
    expect(/Asking a question|"interaction"|"questions"|"answers"|"requestId"|"options"|"label"/.exec(JSON.stringify(pet.pet))?.[0] ?? null).toBeNull();
  });
});

it('keeps provider discovery history, notices and per-provider presence out of the mini window', () => {
  const snapshot = { ...sampleSnapshot(1, [sampleProvider({ presence: 'missing' })]), providerDiscovery: { checking: false, providers: [], notice: { revision: 1, initial: true, providers: [] }, historyIssue: null } } as const;
  const projected = projectForWindow('pet', snapshot);
  expect(projected).not.toHaveProperty('providerDiscovery');
  expect(projected.providers[0]).not.toHaveProperty('presence');
});
