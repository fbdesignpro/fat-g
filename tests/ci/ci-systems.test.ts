// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The tiers of .github/workflows/ci.yml (scripts/lib/ci-systems.mjs): Windows and Linux by default;
// macOS only when explicitly requested through a push's tag or a manual run's input.
import { describe, expect, it } from 'vitest';
import { chooseRunners } from '../../scripts/lib/ci-systems.mjs';

const ALL = ['windows-latest', 'macos-latest', 'ubuntu-latest'];
const DEFAULT = ['windows-latest', 'ubuntu-latest'];
const push = (message: string): string[] => chooseRunners({ event: 'push', message });
const byHand = (requested: string): string[] => chooseRunners({ event: 'workflow_dispatch', requested });

describe('a push', () => {
  it('runs on Windows and Linux when its message names none, including a milestone', () => {
    expect(push('M22: tick it')).toEqual(DEFAULT);
    expect(push('')).toEqual(DEFAULT);
    expect(push('Improve macOS packaging')).toEqual(DEFAULT);
  });

  it('runs on the systems its tag names, on any line of the message, in any case', () => {
    expect(push('Fix a test that failed in CI on macOS [ci macos]')).toEqual(['macos-latest']);
    expect(push('Fix two tests\n\nThey raced their deadlines.\n\n[ci linux, windows]')).toEqual(['windows-latest', 'ubuntu-latest']);
    expect(push('[CI Linux Windows]')).toEqual(['windows-latest', 'ubuntu-latest']);
    expect(push('[ci macos, macos]')).toEqual(['macos-latest']);
    expect(push('[ci windows, macos, linux]')).toEqual(ALL);
    expect(push('[ci all]')).toEqual(ALL);
  });

  it('takes GitHub’s own skip markers and a bare [ci] for no tag', () => {
    expect(push('Docs [skip ci]')).toEqual(DEFAULT);
    expect(push('[ci]')).toEqual(DEFAULT);
  });

  it('fails on a name it does not know, rather than narrowing the run', () => {
    expect(() => push('[ci mac]')).toThrow('The tag [ci mac] names "mac", not a system: use windows, macos, linux or all.');
    expect(() => push('[ci linux, toString]')).toThrow('names "tostring", not a system');
    expect(() => push('[ci , ]')).toThrow('The tag [ci , ] names no system');
  });

  it('fails on two tags, rather than choosing one', () => {
    expect(() => push('[ci macos] and [ci linux]')).toThrow('The commit message has 2 [ci …] tags: name every system in one.');
  });
});

describe('a run started by hand', () => {
  it('runs on Windows and Linux when its input is omitted or blank', () => {
    expect(chooseRunners({ event: 'workflow_dispatch' })).toEqual(DEFAULT);
    expect(byHand('')).toEqual(DEFAULT);
    expect(byHand('  ')).toEqual(DEFAULT);
    expect(byHand('windows, linux')).toEqual(DEFAULT);
  });

  it('runs on the systems its input names', () => {
    expect(byHand('macos')).toEqual(['macos-latest']);
    expect(byHand('macos, linux')).toEqual(['macos-latest', 'ubuntu-latest']);
    expect(byHand('all')).toEqual(ALL);
  });

  it('fails on a name it does not know', () => {
    expect(() => byHand('osx')).toThrow('The systems input names "osx", not a system');
  });
});

it.each(['pull_request', 'schedule', ''])('runs other events (%s) on Windows and Linux whatever their message or input says', (event) => {
  expect(chooseRunners({ event, message: '[ci macos]', requested: 'all' })).toEqual(DEFAULT);
});
