// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary's service (docs/planning/_archive/M26.md, Design 1 and 4): the model and the level a title
// is written with, the queue, the deadline, letting go, and nothing of a prompt or a title logged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import type { CatalogEffort, CatalogState } from '@shared/contracts/catalog';
import type { InstanceRef } from '@shared/contracts/instances';
import type { SessionEvent } from '@shared/contracts/sessions';
import { SESSION_TITLE_MODEL } from '@shared/contracts/title-model';
import type { SecretaryAnswer, SecretaryRequest, SessionFacet } from '@shared/provider-kit/sessions';
import { DRAFT_INSTRUCTIONS } from './draft';
import { createSecretary, SECRETARY_DEADLINE_MS, type Secretary, type TitleSettings } from './service';
import { TITLE_INSTRUCTIONS } from './title';

const level = (id: string, place: number, caution = false): CatalogEffort => ({ id, label: id, place, caution });
const model = (key: string, efforts: CatalogEffort[] = [level('low', 1), level('high', 2)]) => sampleModel({ key, resolvedId: key, name: key, efforts });
const PROMPT = 'Make the Submit button wait for both fields, and add a test';
const SESSION = { providerId: 'alpha', instanceId: 'default', model: 'big' };
const OTHER = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';

interface Call { readonly ref: InstanceRef; readonly request: SecretaryRequest; readonly signal: AbortSignal; resolve(answer: SecretaryAnswer): void }

let calls: Call[];
let events: SessionEvent[];
let warnings: string[];
let settings: TitleSettings;
let catalog: CatalogState;
let secretary: Secretary;
let hasSecretary: boolean;

function make(extra: { deadlineMs?: number; perInstance?: number } = {}): Secretary {
  const facet = (ref: InstanceRef): SessionFacet => ({
    start: () => { throw new Error('no session'); },
    resume: () => { throw new Error('no session'); },
    ...(hasSecretary ? {
      secretary: (request: SecretaryRequest, signal: AbortSignal) => new Promise<SecretaryAnswer>((resolve) => {
        const call: Call = { ref, request, signal, resolve };
        calls.push(call);
        signal.addEventListener('abort', () => resolve({ kind: 'failed', reason: 'aborted' }), { once: true });
      }),
    } : {}),
  });
  return createSecretary({ facet, catalog: () => catalog, settings: () => settings, apply: (event) => events.push(event), log: { warn: (line: string) => warnings.push(line) }, ...extra });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls = [];
  events = [];
  warnings = [];
  hasSecretary = true;
  settings = { generated: true, models: {} };
  catalog = {
    ...sampleCatalog([]),
    providers: [
      sampleCatalogProvider({ id: 'alpha', models: [model('big', [level('low', 1), level('medium', 2)]), model('small', [level('ultra', 1, true), level('minimal', 2), level('low', 3)]), model('plain', [])] }),
      sampleCatalogProvider({ id: 'alpha', instanceId: OTHER, models: [model('big')] }),
    ],
  };
  secretary = make();
});

afterEach(() => {
  secretary.dispose();
  vi.useRealTimers();
});

describe('the secretary (M26, Design 1 and 4)', () => {
  it('defaults to the account’s latest small model and follows catalog updates without saving a concrete choice', () => {
    const first = catalog.providers[0];
    if (first === undefined) throw new Error('no catalog entry');
    catalog = { ...catalog, providers: [{ ...first, smallModel: 'small' }, ...catalog.providers.slice(1)] };
    secretary.title('s1', SESSION, PROMPT);
    expect(calls[0]?.request).toMatchObject({ model: 'small', effort: 'minimal' });
    catalog = { ...catalog, providers: [{ ...first, smallModel: 'plain' }, ...catalog.providers.slice(1)] };
    expect(secretary.draft('s2', SESSION, PROMPT)).toBe(true);
    expect(calls[1]?.request).toMatchObject({ model: 'plain', effort: null });
    secretary.title('s3', { ...SESSION, instanceId: OTHER }, PROMPT);
    expect(calls[2]?.request.model).toBe('big');
    expect(settings.models).toEqual({});
  });

  it('respects an explicit session-model choice even when a small model is available', () => {
    catalog = { ...catalog, providers: catalog.providers.map((entry) => ({ ...entry, smallModel: 'small' })) };
    settings = { generated: true, models: { alpha: SESSION_TITLE_MODEL } };
    secretary.title('s1', SESSION, PROMPT);
    expect(calls[0]?.request.model).toBe('big');
  });

  it('asks the session’s instance with the title task, its own model at its lightest level, and reports a generated name', async () => {
    secretary.title('s1', SESSION, PROMPT);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ref).toEqual({ providerId: 'alpha', instanceId: 'default' });
    expect(calls[0]?.request).toEqual({ instructions: TITLE_INSTRUCTIONS, text: `The first message of the session:\n\n${PROMPT}`, model: 'big', effort: 'low' });
    calls[0]?.resolve({ kind: 'answered', text: '"Disable Submit Until Filled."' });
    await settle();
    expect(events).toEqual([{ type: 'name-reported', sessionId: 's1', name: 'Disable Submit Until Filled', source: 'generated' }]);
  });

  it('takes the model Settings chose for the provider where the instance lists it, at its lightest level without caution', () => {
    catalog = { ...catalog, providers: catalog.providers.map((entry) => ({ ...entry, smallModel: 'big' })) };
    settings = { generated: true, models: { alpha: 'small' } };
    secretary.title('s1', SESSION, PROMPT);
    expect(calls[0]?.request).toMatchObject({ model: 'small', effort: 'minimal' });
    // A model with no levels is named with none.
    settings = { generated: true, models: { alpha: 'plain' } };
    secretary.title('s2', SESSION, PROMPT);
    expect(calls[1]?.request).toMatchObject({ model: 'plain', effort: null });
    // An instance that does not list the choice writes with the session's own model.
    settings = { generated: true, models: { alpha: 'small' } };
    secretary.title('s3', { ...SESSION, instanceId: OTHER }, PROMPT);
    expect(calls[2]?.request).toMatchObject({ model: 'big', effort: 'low' });
  });

  it('names the session’s model with no level while its catalog lists nothing, and asks nothing for a model no longer listed', () => {
    catalog = { ...sampleCatalog([]), providers: [] };
    secretary.title('s1', SESSION, PROMPT);
    expect(calls[0]?.request).toMatchObject({ model: 'big', effort: null });
    catalog = { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'alpha', models: [model('other')] })] };
    secretary.title('s2', SESSION, PROMPT);
    expect(calls).toHaveLength(1);
  });

  it('asks nothing with the switch off, for a bare CLI command, or of an instance without a secretary', () => {
    settings = { generated: false, models: {} };
    secretary.title('s1', SESSION, PROMPT);
    settings = { generated: true, models: {} };
    secretary.title('s2', SESSION, '  /review  ');
    hasSecretary = false;
    secretary.dispose();
    secretary = make();
    secretary.title('s3', SESSION, PROMPT);
    expect(calls).toEqual([]);
  });

  it('names nothing for an empty reply or a failure, and logs only kinds and counts', async () => {
    secretary.title('s1', SESSION, PROMPT);
    secretary.title('s2', SESSION, PROMPT);
    calls[0]?.resolve({ kind: 'answered', text: ' \n "" ' });
    calls[1]?.resolve({ kind: 'failed', reason: 'unavailable' });
    await settle();
    expect(events).toEqual([]);
    expect(warnings).toEqual(['[secretary] a title was not given (empty; 1 so far)', '[secretary] a title was not given (failed; 1 so far)']);
    expect(warnings.join('\n')).not.toContain('Submit');
  });

  it('runs two at once for one instance and queues the rest, each instance on its own', async () => {
    for (const id of ['s1', 's2', 's3']) secretary.title(id, SESSION, PROMPT);
    secretary.title('s4', { ...SESSION, instanceId: OTHER }, PROMPT);
    expect(calls.map((call) => call.ref.instanceId)).toEqual(['default', 'default', OTHER]);
    calls[0]?.resolve({ kind: 'answered', text: 'First' });
    await settle();
    expect(calls).toHaveLength(4);
    expect(calls[3]?.ref.instanceId).toBe('default');
  });

  it('lets go of a request at its deadline, and names nothing with its late answer', async () => {
    vi.useFakeTimers();
    secretary.title('s1', SESSION, PROMPT);
    const call = calls[0];
    await vi.advanceTimersByTimeAsync(SECRETARY_DEADLINE_MS);
    expect(call?.signal.aborted).toBe(true);
    call?.resolve({ kind: 'answered', text: 'Too late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(warnings).toEqual(['[secretary] a title was not given (timeout; 1 so far)']);
  });

  it('lets go of a session’s request when it is forgotten, queued or running, and of all at dispose', async () => {
    for (const id of ['s1', 's2', 's3']) secretary.title(id, SESSION, PROMPT);
    secretary.forget('s3');
    secretary.forget('s1');
    expect(calls[0]?.signal.aborted).toBe(true);
    await settle();
    // s3 was let go of in the queue: nothing takes s1's place.
    expect(calls).toHaveLength(2);
    secretary.dispose();
    expect(calls[1]?.signal.aborted).toBe(true);
    calls[1]?.resolve({ kind: 'answered', text: 'After the end' });
    await settle();
    expect(events).toEqual([]);
    expect(warnings).toEqual([]);
    secretary.title('s4', SESSION, PROMPT);
    expect(calls).toHaveLength(2);
  });

  // M26 (round 2): the same request, on the draft task, for a session with no turn yet.
  it('asks the draft task of the same instance and model, and reports its answer as a generated name', async () => {
    expect(secretary.draft('s1', SESSION, 'Set up the login form and')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.ref).toEqual({ providerId: 'alpha', instanceId: 'default' });
    expect(calls[0]?.request).toEqual({ instructions: DRAFT_INSTRUCTIONS, text: 'The text the user has typed but not sent:\n\nSet up the login form and', model: 'big', effort: 'low' });
    calls[0]?.resolve({ kind: 'answered', text: 'setting things up' });
    await settle();
    expect(events).toEqual([{ type: 'name-reported', sessionId: 's1', name: 'setting things up', source: 'generated' }]);
  });

  it('asks nothing of a draft with the switch off, for a bare CLI command, or of an instance without a secretary', () => {
    settings = { generated: false, models: {} };
    expect(secretary.draft('s1', SESSION, 'Set up the login form')).toBe(false);
    settings = { generated: true, models: {} };
    expect(secretary.draft('s2', SESSION, '  /review  ')).toBe(false);
    hasSecretary = false;
    secretary.dispose();
    secretary = make();
    expect(secretary.draft('s3', SESSION, 'Set up the login form')).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each(['/review-merge', '  /review-merge \n\t', '/'])('skips the bare command %j for both tasks', (text) => {
    secretary.title('s1', SESSION, text);
    expect(secretary.draft('s2', SESSION, text)).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([' /review-merge I just merged another branch', '/review-merge\nCheck the changes'])('names a command or skill with descriptive text: %j', async (text) => {
    secretary.title('s1', SESSION, text);
    expect(secretary.draft('s2', SESSION, text)).toBe(true);
    expect(calls[0]?.request).toMatchObject({ instructions: TITLE_INSTRUCTIONS, text: `The first message of the session:\n\n${text.trim()}` });
    expect(calls[1]?.request).toMatchObject({ instructions: DRAFT_INSTRUCTIONS, text: `The text the user has typed but not sent:\n\n${text.trim()}` });
    calls[0]?.resolve({ kind: 'answered', text: 'Review merged branch' });
    calls[1]?.resolve({ kind: 'answered', text: 'reviewing a merge' });
    await settle();
    expect(events).toEqual([
      { type: 'name-reported', sessionId: 's1', name: 'Review merged branch', source: 'generated' },
      { type: 'name-reported', sessionId: 's2', name: 'reviewing a merge', source: 'generated' },
    ]);
  });

  // One request per session, whichever task: the title the first prompt asks for replaces the draft's.
  it('lets go of a draft’s request when the title is asked for the same session', async () => {
    secretary.draft('s1', SESSION, 'Set up the login form and');
    secretary.title('s1', SESSION, PROMPT);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.request.instructions).toBe(TITLE_INSTRUCTIONS);
    calls[0]?.resolve({ kind: 'answered', text: 'setting things up' });
    calls[1]?.resolve({ kind: 'answered', text: 'Wait for both fields' });
    await settle();
    expect(events).toEqual([{ type: 'name-reported', sessionId: 's1', name: 'Wait for both fields', source: 'generated' }]);
  });

  it('asks again for a session asked twice, the first request let go of', async () => {
    secretary.title('s1', SESSION, PROMPT);
    secretary.title('s1', SESSION, 'Another prompt');
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[1]?.resolve({ kind: 'answered', text: 'Second' });
    await settle();
    expect(events.map((event) => event.type === 'name-reported' && event.name)).toEqual(['Second']);
  });
});
