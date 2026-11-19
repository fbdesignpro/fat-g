// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 and V24 (docs/planning/_archive/M14b.md; C8, C9, C74, C75): each module's own declaration, taken through
// the process layer's functions. The first account's children get what the provider's get today;
// an added account's get the variable set to its folder and none of what would put another
// credential, backend or endpoint before that folder's login. The mechanics, on made-up names, are in
// src/main/process/env.test.ts.
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import { constrainEnvironment, instanceEnvironment, withheldPresent } from '../../src/main/process/env';
import { builtInProviders } from '../../src/main/providers';
import { protectedVariables } from '../../src/main/instances/variables';
import { exampleDefinition } from '../support/example-provider';

const definitions = [...builtInProviders('0.0.0'), exampleDefinition()];
const byId = (id: string): ProviderDefinition => {
  const definition = definitions.find((candidate) => candidate.descriptor.id === id);
  if (definition === undefined) throw new Error(`no provider ${id}`);
  return definition;
};
const FOLDER = 'D:\\accounts\\second';

/** What the two kinds of scope hand a child, from one inherited environment. */
function scopes(definition: ProviderDefinition, inherited: Record<string, string>, platform: string) {
  const support = definition.instances;
  if (support === undefined) throw new Error('no declaration');
  const first = constrainEnvironment(inherited, definition.environment, platform);
  const added = instanceEnvironment(first, { variable: support.variable, folder: FOLDER, withhold: support.withhold }, platform);
  return { first, added, present: withheldPresent(first, support.withhold, platform) };
}
const upper = (env: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]));
const mixedCase = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).map(([key, value], index) => [index % 2 === 0 ? key.toLowerCase() : key[0] + key.slice(1).toLowerCase(), value]));

// What passes to every account: a proxy, a certificate bundle, and the search path.
const PASSES = { HTTPS_PROXY: 'http://proxy.invalid:9', NO_PROXY: 'localhost', SSL_CERT_FILE: '/etc/ca.pem', PATH: '/usr/bin' };

describe('Claude’s accounts', () => {
  const claude = byId('claude');
  const passes = { ...PASSES, NODE_EXTRA_CA_CERTS: '/etc/extra.pem', CLAUDE_CODE_CLIENT_CERT: '/etc/client.pem', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' };
  // Everything Claude's documented authentication precedence puts above a folder's login, and the
  // endpoint a folder's login would otherwise be sent to.
  const withheld = {
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_AUTH_TOKEN: 'bearer', ANTHROPIC_API_KEY: 'key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_PROFILE: 'work', ANTHROPIC_FEDERATION_RULE_ID: 'rule', ANTHROPIC_ORGANIZATION_ID: 'org', ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/token',
    ANTHROPIC_BASE_URL: 'https://gateway.invalid',
  };
  const inherited = { CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-own', ...withheld, ...passes, CLAUDE_CODE_ENTRYPOINT: 'cli' };

  it.each(['linux', 'darwin', 'win32'])('on %s the first account inherits as today, and an added one gets its folder and no credential, backend or endpoint', (platform) => {
    const { first, added, present } = scopes(claude, inherited, platform);
    // The provider's policy drops the parent session's marker for every account; nothing else.
    expect(first).toEqual({ CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-own', ...withheld, ...passes });
    expect(added).toEqual({ CLAUDE_CONFIG_DIR: FOLDER, ...passes });
    expect(present).toEqual(Object.keys(withheld).sort());
  });

  it('matches every Windows spelling', () => {
    const { first, added } = scopes(claude, mixedCase(inherited), 'win32');
    expect(first).toEqual(upper({ CLAUDE_CONFIG_DIR: 'C:\\Users\\me\\.claude-own', ...withheld, ...passes }));
    expect(added).toEqual(upper({ CLAUDE_CONFIG_DIR: FOLDER, ...passes }));
  });
});

describe('Codex’s accounts', () => {
  const codex = byId('codex');
  // A certificate bundle, logging, and a key variable a home's own config.toml may name.
  const passes = { ...PASSES, CODEX_CA_CERTIFICATE: '/etc/codex-ca.pem', RUST_LOG: 'info', AZURE_OPENAI_API_KEY: 'azure' };
  // Codex's environment variables page: the credentials, the workload identity variables, the key
  // its documentation pipes to a login, and what moves a home's state out of the home (C74, C75).
  const withheld = {
    CODEX_API_KEY: 'key', CODEX_ACCESS_TOKEN: 'token', CODEX_SQLITE_HOME: 'C:\\Users\\me\\sqlite',
    OPENAI_API_KEY: 'key', OPENAI_BASE_URL: 'https://gateway.invalid',
    OPENAI_FEDERATION_RULE_ID: 'rule', OPENAI_IDENTITY_TOKEN_FILE: '/run/token', OPENAI_WORKLOAD_IDENTITY_CONTEXT: '{}',
  };
  const inherited = { CODEX_HOME: 'C:\\Users\\me\\.codex-own', ...withheld, ...passes };

  it.each(['linux', 'darwin', 'win32'])('on %s the first account inherits everything, and an added one gets its folder and none of the withheld', (platform) => {
    const { first, added, present } = scopes(codex, inherited, platform);
    expect(first).toEqual(inherited);
    expect(added).toEqual({ CODEX_HOME: FOLDER, ...passes });
    expect(present).toEqual(Object.keys(withheld).sort());
  });

  it('matches every Windows spelling', () => {
    const { first, added } = scopes(codex, mixedCase(inherited), 'win32');
    expect(first).toEqual(upper(inherited));
    expect(added).toEqual(upper({ CODEX_HOME: FOLDER, ...passes }));
  });
});

describe('every provider that declares instances', () => {
  const declaring = definitions.filter((definition) => definition.instances !== undefined);

  it('covers the built-ins and the example', () => {
    expect(declaring.map((definition) => definition.descriptor.id)).toEqual(['claude', 'codex', 'example']);
  });

  it.each(declaring.map((definition) => [definition.descriptor.id, definition] as const))('%s: an added account sets the variable once, and loses only what is withheld', (_id, definition) => {
    const support = definition.instances!;
    // A name under each withheld prefix that the provider's children really get: one its own policy
    // keeps by name where it keeps any (Claude's backends, M16, C81), else any name at all.
    const under = (prefix: string): string => (definition.environment?.keepNames ?? []).find((name) => name.startsWith(prefix)) ?? `${prefix}ANYTHING`;
    const inherited = {
      [support.variable]: '/inherited', ...PASSES,
      ...Object.fromEntries(support.withhold.names.map((name) => [name, 'x'])),
      ...Object.fromEntries(support.withhold.prefixes.map((prefix) => [under(prefix), 'x'])),
    };
    const { first, added, present } = scopes(definition, inherited, 'linux');
    expect(added[support.variable]).toBe(FOLDER);
    expect(Object.keys(added).sort()).toEqual([support.variable, ...Object.keys(PASSES)].sort());
    // Named for Settings by name alone, and each of them was really there for the first account.
    expect(present).toEqual([...support.withhold.names, ...support.withhold.prefixes.map(under)].sort());
    for (const name of present) expect(first).toHaveProperty(name);
  });

  it('names each declared variable as one no per-run override may set', () => {
    expect(protectedVariables(definitions)).toEqual(declaring.map((definition) => definition.instances!.variable));
    expect(protectedVariables(builtInProviders('0.0.0'))).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
  });
});
