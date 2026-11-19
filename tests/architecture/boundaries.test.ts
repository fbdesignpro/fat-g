// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Proves the architecture fence actually holds: each case lints an in-memory snippet as if it
// lived at the given path and asserts which rule fires. If someone loosens eslint.architecture.js,
// this fails — a lint rule nobody tests is a lint rule that silently stops working.
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { architecture } from '../../eslint.architecture.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: architecture });

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, filePath) });
  const messages = result?.messages ?? [];
  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) throw new Error(`snippet failed to parse: ${fatal.map((message) => message.message).join('; ')}`);
  return messages.map((message) => message.ruleId ?? 'unknown');
}

const IMPORTS = 'no-restricted-imports';
const TS_IMPORTS = '@typescript-eslint/no-restricted-imports';
const LAYERS = 'boundaries/dependencies';

describe('capability bans (what each layer may import from outside)', () => {
  it.each([
    ['renderer → electron', 'src/renderer/src/x.ts', `import { ipcRenderer } from 'electron';`],
    ['renderer → node:fs', 'src/renderer/src/x.ts', `import fs from 'node:fs';`],
    ['renderer → bare fs', 'src/renderer/src/x.ts', `import fs from 'fs';`],
    ['shared → react', 'src/shared/contracts/x.ts', `import { useState } from 'react';`],
    ['shared → electron', 'src/shared/contracts/x.ts', `import { app } from 'electron';`],
    ['shared → node:path', 'src/shared/contracts/x.ts', `import path from 'node:path';`],
    ['process layer → electron', 'src/main/process/x.ts', `import { app } from 'electron';`],
    ['shared storage → electron', 'src/main/storage/x.ts', `import { app } from 'electron';`],
    ['preferences store → electron', 'src/main/prefs/x.ts', `import { app } from 'electron';`],
    ['records store → electron', 'src/main/records/x.ts', `import { app } from 'electron';`],
    ['catalog → electron', 'src/main/catalog/x.ts', `import { app } from 'electron';`],
    ['session service → electron', 'src/main/sessions/x.ts', `import { app } from 'electron';`],
    // M102 (C21): the image header reader, the avatars' scanner and catalog, and the media route's sources.
    ['image reader → electron', 'src/main/images/x.ts', `import { app } from 'electron';`],
    ['avatars → electron', 'src/main/avatars/x.ts', `import { app } from 'electron';`],
    ['media route → electron', 'src/main/media/x.ts', `import { app } from 'electron';`],
    ['provider → electron', 'src/main/providers/example/x.ts', `import { app } from 'electron';`],
    ['provider → child_process', 'src/main/providers/example/x.ts', `import { spawn } from 'node:child_process';`],
    // M14b, S6: the code that deals with an account's folder cannot open, list or write one.
    ['account folders → electron', 'src/main/instances/x.ts', `import { app } from 'electron';`],
    ['account folders → node:fs', 'src/main/instances/x.ts', `import { readdirSync } from 'node:fs';`],
    ['account folders → node:fs/promises', 'src/main/instances/x.ts', `import { readFile } from 'node:fs/promises';`],
    ['account folders → bare fs', 'src/main/instances/x.ts', `import fs from 'fs';`],
    ['account folders → bare fs/promises', 'src/main/instances/x.ts', `import { stat } from 'fs/promises';`],
  ])('%s is rejected', async (_name, filePath, code) => {
    expect(await violations(filePath, code)).toContain(IMPORTS);
  });

  it('account folders still reach the lookups, the path rules and the network ban', async () => {
    const legal = `import path from 'node:path'; import type { Lookups } from '../records/lookup'; import { normalizeRoot } from '../records/paths'; export const x = [path, normalizeRoot]; export type L = Lookups;`;
    expect(await violations('src/main/instances/x.ts', legal)).toEqual([]);
    expect(await violations('src/main/instances/x.ts', `import https from 'node:https'; export const x = https;`)).toContain(IMPORTS);
  });
});

describe('no network from the app itself (decision 0004)', () => {
  it.each([
    ['node:https in main', 'src/main/x.ts', `import https from 'node:https';`],
    ['bare http in main', 'src/main/x.ts', `import http from 'http';`],
    ['node:net in the process layer', 'src/main/process/x.ts', `import net from 'node:net';`],
    ['electron.net', 'src/main/x.ts', `import { net } from 'electron';`],
    ['electron autoUpdater', 'src/main/x.ts', `import { autoUpdater } from 'electron';`],
    ['an HTTP client package', 'src/main/providers/example/x.ts', `import axios from 'axios';`],
  ])('%s is rejected', async (_name, filePath, code) => {
    expect(await violations(filePath, code)).toContain(IMPORTS);
  });

  it.each([
    ['fetch', `void fetch('https://example.com');`],
    ['WebSocket', `new WebSocket('wss://example.com');`],
    ['XMLHttpRequest', `new XMLHttpRequest();`],
  ])('global %s is rejected in the renderer and in main', async (_name, code) => {
    expect(await violations('src/renderer/src/x.ts', code)).toContain('no-restricted-globals');
    expect(await violations('src/main/x.ts', code)).toContain('no-restricted-globals');
  });

});

describe('no Anthropic package is imported anywhere (decision 0006)', () => {
  it.each([
    ['the Claude session', 'src/main/providers/claude/session.ts', `import { query } from '@anthropic-ai/claude-agent-sdk'; export const x = query;`],
    ['a type-only import', 'src/main/providers/claude/index.ts', `import type { Query } from '@anthropic-ai/claude-agent-sdk'; export type X = Query;`],
    ['a subpath', 'src/main/providers/claude/x.ts', `import { x } from '@anthropic-ai/claude-agent-sdk/bridge'; export const y = x;`],
    ['the API client', 'src/main/providers/claude/x.ts', `import Anthropic from '@anthropic-ai/sdk'; export const x = Anthropic;`],
    ['main', 'src/main/x.ts', `import { query } from '@anthropic-ai/claude-agent-sdk'; export const x = query;`],
    ['shared', 'src/shared/x.ts', `import type { Query } from '@anthropic-ai/claude-agent-sdk'; export type X = Query;`],
    ['the renderer', 'src/renderer/src/x.ts', `import { query } from '@anthropic-ai/claude-agent-sdk'; export const x = query;`],
  ])('%s is rejected', async (_name, filePath, code) => {
    expect(await violations(filePath, code)).toContain(IMPORTS);
  });

  it('the ban adds to, and does not replace, every provider ban', async () => {
    for (const code of [`import { app } from 'electron';`, `import { spawn } from 'node:child_process';`, `import https from 'node:https';`]) {
      expect(await violations('src/main/providers/claude/session.ts', code)).toContain(IMPORTS);
    }
  });
});

describe('the preload is a dumb pipe (validation lives in main)', () => {
  it.each([
    ['zod', `import { z } from 'zod'; export const x = z;`],
    ['the typed contract (it carries the zod schemas)', `import { INVOKE_SPECS } from '@shared/ipc/contract'; export const x = INVOKE_SPECS;`],
    ['the contract by relative path', `import { INVOKE_SPECS } from '../shared/ipc/contract'; export const x = INVOKE_SPECS;`],
    ['a shared contract module', `import { severityFromPercent } from '@shared/contracts/usage'; export const x = severityFromPercent;`],
  ])('a value import of %s is rejected', async (_name, code) => {
    expect(await violations('src/preload/x.ts', code)).toContain(TS_IMPORTS);
  });

  it('type imports from the contract and from zod are allowed', async () => {
    const code = `import type { InvokeMap } from '@shared/ipc/contract'; import type { AppStateSnapshot } from '@shared/contracts/app-state'; import type { z } from 'zod'; export type T = [InvokeMap, AppStateSnapshot, z.ZodType];`;
    expect(await violations('src/preload/x.ts', code)).toEqual([]);
  });

  it('the network ban still applies alongside it', async () => {
    expect(await violations('src/preload/x.ts', `import http from 'node:http'; export const x = http;`)).toContain(IMPORTS);
  });

  it('only the preload is restricted: main may use the contract at runtime', async () => {
    const code = `import { INVOKE_SPECS } from '@shared/ipc/contract'; export const x = INVOKE_SPECS;`;
    expect(await violations('src/main/x.ts', code)).toEqual([]);
  });
});

describe('layer boundaries (who may import whom)', () => {
  it.each([
    ['renderer → main', 'src/renderer/src/x.ts', `import '../../main/index';`],
    ['renderer → preload', 'src/renderer/src/x.ts', `import '../../preload/index';`],
    ['shared → main', 'src/shared/contracts/x.ts', `import '../../main/app/csp';`],
    ['the catalog contract → main', 'src/shared/contracts/catalog.ts', `import '../../main/catalog/merge';`],
    ['provider → the catalog', 'src/main/providers/example/x.ts', `import '../../catalog/merge';`],
    ['provider → another provider’s defaults', 'src/main/providers/claude/x.ts', `import defaults from '../codex/catalog-defaults.json'; export const x = defaults;`],
    ['shared → renderer', 'src/shared/contracts/x.ts', `import '../../renderer/src/App';`],
    ['preload → main', 'src/preload/x.ts', `import '../main/app/csp';`],
    ['provider → main internals', 'src/main/providers/example/x.ts', `import '../../app/csp';`],
    ['provider → process implementation', 'src/main/providers/example/x.ts', `import '../../process/spawn';`],
    ['provider → another provider', 'src/main/providers/example/x.ts', `import '../codex/index';`],
    ['shared contracts → runtime provider kit', 'src/shared/contracts/x.ts', `import '../provider-kit/process';`],
    ['renderer → runtime provider kit', 'src/renderer/src/x.ts', `import '../../shared/provider-kit/context';`],
  ])('%s is rejected', async (_name, filePath, code) => {
    expect(await violations(filePath, code)).toContain(LAYERS);
  });
});

describe('legal imports stay legal', () => {
  it.each([
    ['renderer → shared (alias)', 'src/renderer/src/x.ts', `import type { FatgBridge } from '@shared/ipc/bridge'; export type T = FatgBridge;`],
    ['renderer → react', 'src/renderer/src/x.tsx', `import { useState } from 'react'; export const useX = () => useState(0);`],
    ['preload → electron + shared', 'src/preload/x.ts', `import { contextBridge } from 'electron'; import { BRIDGE_KEY } from '@shared/ipc/bridge'; contextBridge.exposeInMainWorld(BRIDGE_KEY, {});`],
    ['preload → the channel allowlist', 'src/preload/x.ts', `import { isInvokeChannel } from '@shared/ipc/channels'; export const x = isInvokeChannel;`],
    ['main → electron, node and its own modules', 'src/main/x.ts', `import path from 'node:path'; import { app } from 'electron'; import { buildCsp } from './app/csp'; export const x = [path, app, buildCsp];`],
    ['main → shared', 'src/main/x.ts', `import { BRIDGE_KEY } from '@shared/ipc/bridge'; export const x = BRIDGE_KEY;`],
    ['process layer → node', 'src/main/process/x.ts', `import { spawn } from 'node:child_process'; export const x = spawn;`],
    ['process → provider kit', 'src/main/process/x.ts', `import { ProcessFailure } from '@shared/provider-kit/process'; export const x = ProcessFailure;`],
    ['provider → provider kit', 'src/main/providers/example/x.ts', `import type { ProviderContext } from '@shared/provider-kit/context'; export type X = ProviderContext;`],
    ['built-in index → provider', 'src/main/providers/index.ts', `import './codex/index';`],
    ['provider → its own defaults', 'src/main/providers/codex/x.ts', `import defaults from './catalog-defaults.json'; export const x = defaults;`],
    ['provider kit → shared contracts', 'src/shared/provider-kit/x.ts', `import type { ProviderId } from '../contracts/provider'; export type X = ProviderId;`],
  ])('%s', async (_name, filePath, code) => {
    expect(await violations(filePath, code)).toEqual([]);
  });
});
