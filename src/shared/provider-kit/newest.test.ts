// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { type Candidate, candidatesOf, compareCliVersions, newestCandidate } from './newest';
import { type Executable, ProcessFailure } from './process';

describe('CLI version order', () => {
  it.each([
    ['0.167.0-alpha.3.2', '0.165.0'],
    ['0.165.0', '0.130.0-alpha.5'],
    ['0.165.0', '0.165.0-alpha.9'],
    ['0.165.0-alpha.10', '0.165.0-alpha.9'],
    ['0.165.0-beta', '0.165.0-alpha.9'],
    ['0.165.0-alpha.1', '0.165.0-alpha'],
    ['0.165.0-alpha', '0.165.0-1'],
    ['2.1.317', '2.1.309'],
    ['10.0.0', '9.99.99'],
    ['1.0.0', 'not a version'],
  ])('puts %s above %s', (newer, older) => {
    expect(compareCliVersions(newer, older)).toBeGreaterThan(0);
    expect(compareCliVersions(older, newer)).toBeLessThan(0);
  });

  it('holds equal what differs only in build metadata or leading zeros', () => {
    expect(compareCliVersions('1.2.3+abc', '1.2.3')).toBe(0);
    expect(compareCliVersions('01.2.3', '1.2.3')).toBe(0);
  });
});

describe('the newest CLI found', () => {
  const at = (path: string, source: Candidate['source'] = 'known-dir'): Candidate => ({ executable: { path, kind: 'native' }, source });
  const parse = (stdout: string): string | null => /(\d+\.\d+\.\d+\S*)/.exec(stdout)?.[1] ?? null;
  const signal = new AbortController().signal;
  const answers = (table: Record<string, string | number | Error>) => (executable: Executable) => {
    const answer = table[executable.path];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(typeof answer === 'number' ? { code: answer, stdout: '' } : { code: 0, stdout: answer ?? '' });
  };

  it('keeps the highest version, the earlier of two equal, and an unread version only when none is read', async () => {
    const found = [at('path', 'path'), at('stale'), at('build'), at('same')];
    expect(await newestCandidate(found, answers({ path: 'codex-cli 0.164.0', stale: 'codex-cli 0.130.0', build: 'codex-cli 0.167.0-alpha.3.2', same: 'codex-cli 0.167.0-alpha.3.2' }), parse, signal))
      .toEqual({ kind: 'found', candidate: found[2], version: '0.167.0-alpha.3.2' });
    expect(await newestCandidate(found.slice(0, 2), answers({ path: 'odd', stale: 'codex-cli 0.130.0' }), parse, signal))
      .toEqual({ kind: 'found', candidate: found[1], version: '0.130.0' });
    expect(await newestCandidate(found.slice(0, 2), answers({ path: 'odd', stale: 'odder' }), parse, signal))
      .toEqual({ kind: 'found', candidate: found[0], version: null });
  });

  it('passes over a CLI whose check fails, and says the first failure when none answers', async () => {
    const found = [at('gone'), at('broken'), at('works')];
    const table = { gone: new ProcessFailure('spawn-failed'), broken: 2, works: '1.0.0' };
    expect(await newestCandidate(found, answers(table), parse, signal)).toEqual({ kind: 'found', candidate: found[2], version: '1.0.0' });
    expect(await newestCandidate(found.slice(0, 2), answers(table), parse, signal)).toEqual({ kind: 'error', reason: 'launch-failed' });
    expect(await newestCandidate(found.slice(1, 2), answers(table), parse, signal)).toEqual({ kind: 'error', reason: 'probe-failed' });
  });

  it('checks nothing more once detection is aborted', async () => {
    const controller = new AbortController();
    const checked: string[] = [];
    const check = (executable: Executable) => { checked.push(executable.path); controller.abort(); return Promise.resolve({ code: 0, stdout: '1.0.0' }); };
    expect(await newestCandidate([at('first'), at('second')], check, parse, controller.signal)).toMatchObject({ kind: 'found', candidate: { executable: { path: 'first' } } });
    expect(checked).toEqual(['first']);
  });

  it('lists a resolution’s CLIs in its order, the first first', () => {
    const first: Executable = { path: 'a', kind: 'native' };
    const second: Executable = { path: 'b', kind: 'cmd-shim' };
    expect(candidatesOf({ status: 'found', executable: first, source: 'path', others: [{ executable: second, source: 'known-dir' }] }))
      .toEqual([{ executable: first, source: 'path' }, { executable: second, source: 'known-dir' }]);
    expect(candidatesOf({ status: 'found', executable: first, source: 'override' })).toEqual([{ executable: first, source: 'override' }]);
  });
});
