// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtInProviders } from '../providers';
import { fixtureOnlyProviders, SMOKE_CLAUDE_TIMING, smokeProviderOptions } from './smoke-providers';

const root = path.resolve('/');
const node = path.join(root, 'tools', process.platform === 'win32' ? 'node.exe' : 'node');
const env = {
  FATG_SMOKE_NODE: node,
  FATG_SMOKE_CODEX_FIXTURE: path.join(root, 'repo', 'fake-codex-cli.mjs'),
  FATG_SMOKE_CLAUDE_FIXTURE: path.join(root, 'repo', 'fake-claude-cli.mjs'),
  FATG_SMOKE_CLAUDE_DIR: path.join(root, 'tmp', 'claude'),
};

describe('built-in providers', () => {
  it('registers Claude then Codex, with production names, timing and no fixture launch prefix', () => {
    const definitions = builtInProviders('1.2.3');
    expect(definitions.map((definition) => definition.descriptor.id)).toEqual(['claude', 'codex']);
    expect(definitions.map((definition) => definition.executableNames)).toEqual([['claude'], ['codex']]);
    expect(definitions.every((definition) => definition.descriptor.minPollIntervalSec === 60)).toBe(true);
    expect(fixtureOnlyProviders(definitions, env)).toBe(false);
  });
});

describe('smoke provider composition', () => {
  it('launches only the smoke Node with each fixture, under accelerated test-only timing', () => {
    const options = smokeProviderOptions(env);
    expect(options.claude).toEqual({
      argsPrefix: [env.FATG_SMOKE_CLAUDE_FIXTURE, '--fixture-dir', env.FATG_SMOKE_CLAUDE_DIR],
      executableNames: [path.basename(node)],
      ...SMOKE_CLAUDE_TIMING,
    });
    expect(options.codex).toMatchObject({ argsPrefix: [env.FATG_SMOKE_CODEX_FIXTURE], executableNames: [path.basename(node)] });
    const definitions = builtInProviders('1.2.3', options);
    expect(fixtureOnlyProviders(definitions, env)).toBe(true);
    expect(definitions.map((definition) => definition.descriptor.minPollIntervalSec)).toEqual([1, 1]);
  });

  it('fails closed without fixtures: nothing resolvable, never the installed CLIs', () => {
    const options = smokeProviderOptions({ FATG_SMOKE_NODE: node });
    expect(options.claude).toEqual({ executableNames: [] });
    expect(options.codex).toEqual({ executableNames: [] });
    expect(fixtureOnlyProviders(builtInProviders('1.2.3', options), env)).toBe(true);
    expect(smokeProviderOptions({ ...env, FATG_SMOKE_CLAUDE_DIR: 'relative/dir' }).claude).toEqual({ executableNames: [] });
  });

  it('detects a composition that could resolve an installed CLI', () => {
    const risky = builtInProviders('1.2.3', { ...smokeProviderOptions(env), claude: { executableNames: ['claude'] } });
    expect(fixtureOnlyProviders(risky, env)).toBe(false);
  });
});
