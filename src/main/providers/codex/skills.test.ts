// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, the Codex adapter's part (docs/planning/_archive/M23.md; C63, C64, C87; K1): `skills/list` on
// the instance's own connection alone; its reply as K1 had it, each enabled skill a row under Skills
// with an opaque selector from which no path reads back, two same-named skills two selectors; and a
// chosen skill sent as an input of its own beside the text, resolved against the last listing — or the
// start refused where it is no longer listed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { mayBeSent, SKILLS_METHOD } from './methods';
import { createCodexSession } from './session';
import { SESSION_TIMINGS } from './session-process';
import { scriptedContext, settle } from './session-test-support';
import { skillSelector, takeSkills } from './skills';

type Frame = { readonly frame: Record<string, unknown> };
const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m23-codex-skills.json'), 'utf8')) as { frames: Frame[] };
const reply = capture.frames.find((entry) => (entry.frame['result'] as { data?: unknown } | undefined)?.data !== undefined)?.frame['result'];

describe('Codex’s skills (V10; C63, C64)', () => {
  it('sends skills/list on the instance’s own connection alone', () => {
    expect(mayBeSent('existing', SKILLS_METHOD)).toBe(true);
    for (const kind of ['session', 'sandbox', 'secretary'] as const) expect(mayBeSent(kind, SKILLS_METHOD), kind).toBe(false);
  });

  it('lists each enabled skill under Skills with a selector, two of one name as two, and no path in any row', () => {
    const taken = takeSkills(reply);
    if (taken === null) throw new Error('no listing');
    const markers = taken.rows.filter((row) => row.name === 'm23-marker');
    expect(markers).toHaveLength(2);
    expect(new Set(markers.map((row) => row.selector)).size).toBe(2);
    expect(taken.rows.every((row) => row.group === 'skills' && /^[0-9a-f]{32}$/.test(row.selector ?? ''))).toBe(true);
    expect(JSON.stringify(taken.rows)).not.toMatch(/SKILL\.md|skills\\\\|<scratch>/);
    // The selector stands for the identity: the same name, scope and path give the same one.
    const first = markers[0]?.selector ?? '';
    expect(taken.bySelector.get(first)?.name).toBe('m23-marker');
    expect(skillSelector('a', 'repo', 'p')).toBe(skillSelector('a', 'repo', 'p'));
    expect(skillSelector('a', 'repo', 'p')).not.toBe(skillSelector('a', 'user', 'p'));
    expect(takeSkills({ nothing: true })).toBeNull();
  });
});

describe('a chosen skill at dispatch (V10; C64, C87)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(listed: { name: string; path: string } | null) {
    const script = scriptedContext();
    const session = createCodexSession({
      context: script.context, executable: () => ({ path: 'C:\\bin\\codex.exe', kind: 'native' }), argsPrefix: [], applicationVersion: '1.0.0', timings: SESSION_TIMINGS,
      start: { folder: 'C:\\work\\project', model: 'gpt-x', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }, reference: null,
      skillOf: () => listed,
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => { events.push(event); });
    return { script, session, events };
  }

  async function begin(h: ReturnType<typeof setup>) {
    h.session.send({ turnId: 'turn-1', prompt: 'Use it', effort: 'low', speed: null, messageId: 'message-1', skill: { name: 'm23-marker', selector: 'a'.repeat(32) } });
    await settle();
    h.script.latest().pending('initialize').resolve({});
    await settle();
    h.script.latest().pending('thread/start').resolve({ thread: { id: 'thread-1' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
    await settle();
  }

  it('sends the skill as an input of its own after the text, by its listed name and path', async () => {
    const h = setup({ name: 'm23-marker', path: 'C:\\work\\project\\.agents\\skills\\m23-marker\\SKILL.md' });
    await begin(h);
    expect((h.script.latest().pending('turn/start').params as { input: unknown }).input).toEqual([
      { type: 'text', text: 'Use it', text_elements: [] },
      { type: 'skill', name: 'm23-marker', path: 'C:\\work\\project\\.agents\\skills\\m23-marker\\SKILL.md' },
    ]);
  });

  it('sends nothing for a skill no longer listed, and fails the start', async () => {
    const h = setup(null);
    await begin(h);
    expect(h.script.latest().requests.map((request) => request.method)).not.toContain('turn/start');
    expect(h.events.at(-1)).toMatchObject({ type: 'turn-ended', outcome: 'failed' });
  });
});
