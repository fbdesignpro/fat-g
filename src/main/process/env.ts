// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import type { EnvironmentConstraints, InstanceEnvironment, VariableSet } from '@shared/provider-kit/process';
export type Environment = Readonly<Record<string, string | undefined>>;
/** A provider's reviewed policy over its inherited environment; see EnvironmentConstraints. */
export function constrainEnvironment(env: Environment, constraints: EnvironmentConstraints | undefined, platform: string): Record<string, string> {
  const clean = sanitizeEnv(env, platform);
  if (constraints === undefined) return clean;
  const fold = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const removeNames = new Set((constraints.removeNames ?? []).map(fold));
  const keepNames = new Set((constraints.keepNames ?? []).map(fold));
  const starts = (name: string, prefixes: readonly string[] | undefined) => (prefixes ?? []).some((prefix) => name.startsWith(fold(prefix)));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(clean)) {
    const name = fold(key);
    if (removeNames.has(name)) continue;
    if (starts(name, constraints.removePrefixes) && !keepNames.has(name) && !starts(name, constraints.keepPrefixes)) continue;
    result[key] = value;
  }
  return result;
}
const folded = (platform: string) => (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
/** Whether a name is in the set, by name or by prefix. */
function inSet(set: VariableSet, platform: string): (name: string) => boolean {
  const fold = folded(platform);
  const names = new Set(set.names.map(fold));
  const prefixes = set.prefixes.map(fold);
  return (name) => names.has(fold(name)) || prefixes.some((prefix) => fold(name).startsWith(prefix));
}
/**
 * An added instance's scope (M14b, C8, C9), applied to what its provider's children get: the
 * withheld variables go, by name and by prefix, and the declared variable is set to the instance's
 * folder in place of any inherited spelling of it. Pure; the first instance never passes through it.
 */
export function instanceEnvironment(env: Environment, instance: InstanceEnvironment, platform: string): Record<string, string> {
  const fold = folded(platform);
  const variable = fold(instance.variable);
  const withheld = inSet(instance.withhold, platform);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(sanitizeEnv(env, platform))) {
    if (fold(key) === variable || withheld(key)) continue;
    result[key] = value;
  }
  result[variable] = instance.folder;
  return result;
}
/** The names in `env` that an added instance's children do not inherit (C64). Names only, sorted; never a value. */
export function withheldPresent(env: Environment, withhold: VariableSet, platform: string): string[] {
  const withheld = inSet(withhold, platform);
  return Object.keys(sanitizeEnv(env, platform)).filter(withheld).sort();
}
/**
 * Per-run overrides cannot restore Electron controls, nor set a protected name: the variable a
 * provider declares as its configuration folder (C8). Main gathers those from the definitions, so
 * the rule holds in every scope, the first instance's included, and no name is written here.
 */
export function mergeEnvironment(inherited: Environment, overrides: Environment, platform: string, protectedNames: readonly string[]): Record<string, string> {
  const additions = sanitizeEnv(overrides, platform);
  const fold = folded(platform);
  const guarded = new Set(protectedNames.map(fold));
  for (const key of Object.keys(additions)) if (guarded.has(fold(key))) delete additions[key];
  return sanitizeEnv({ ...sanitizeEnv(inherited, platform), ...additions }, platform);
}
export function sanitizeEnv(env: Environment, platform: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Stable precedence for duplicate Windows keys; the canonical uppercase spelling wins.
  for (const key of Object.keys(env).sort().reverse()) {
    const normalized = platform === 'win32' ? key.toUpperCase() : key;
    const value = env[key];
    if (/^(ELECTRON_.*|NODE_OPTIONS)$/i.test(key) || value === undefined) continue;
    result[normalized] = value;
  }
  return result;
}
export function absoluteDirs(values: readonly string[], platform: string): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set<string>();
  return values.map((v) => v.replace(/^"(.*)"$/, '$1')).filter((v) => {
    if (!p.isAbsolute(v) || v.includes('\0')) return false;
    const key = platform === 'win32' ? p.normalize(v).toLowerCase() : p.normalize(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export interface EnvironmentOptions {
  env: Environment;
  platform: string;
  homedir: string;
  isDirectory: (directory: string) => Promise<boolean>;
  probe: (shell: string, args: string[], env: Environment) => Promise<string>;
}
const START = '__FATG_PATH_BEGIN__';
const END = '__FATG_PATH_END__';
/** A single lazy, settled promise coalesces requests and caches probe failures too. */
export function createEnvironment(options: EnvironmentOptions): () => Promise<Record<string, string>> {
  let cached: Promise<Record<string, string>> | undefined;
  return () => cached ??= prepare(options);
}
async function prepare({ env, platform, homedir, isDirectory, probe }: EnvironmentOptions): Promise<Record<string, string>> {
  const clean = sanitizeEnv(env, platform);
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const delimiter = windows ? ';' : ':';
  const dirs = (clean['PATH'] ?? '').split(delimiter);
  const candidates: string[] = [];
  if (windows) {
    for (const [key, suffix] of [['USERPROFILE', '.local/bin'], ['APPDATA', 'npm'], ['LOCALAPPDATA', 'Microsoft/WinGet/Links']]) {
      const base = clean[key!];
      if (base && p.isAbsolute(base)) candidates.push(p.join(base, suffix!));
    }
  } else {
    const shell = clean['SHELL'];
    if (shell && p.isAbsolute(shell)) {
      const name = p.basename(shell);
      const command = name === 'fish' ? `printf '${START}%s${END}' (string join : $PATH)`
        : ['sh', 'bash', 'zsh'].includes(name) ? `printf '${START}%s${END}' "$PATH"` : undefined;
      if (command) {
        try {
          const output = await probe(shell, ['-l', '-c', command], clean);
          const match = output.length <= 65536 ? output.match(/__FATG_PATH_BEGIN__([^\r\n]*?)__FATG_PATH_END__/) : null;
          if (match?.[1]) dirs.push(...match[1].split(':'));
        } catch { /* Static fallback; never retain shell startup output or errors. */ }
      }
    }
    candidates.push(p.join(homedir, '.local/bin'), p.join(homedir, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  }
  for (const dir of absoluteDirs(candidates, platform)) if (await isDirectory(dir)) dirs.push(dir);
  clean['PATH'] = absoluteDirs(dirs, platform).join(delimiter);
  return clean;
}
