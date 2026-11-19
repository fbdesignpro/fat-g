// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The environment each side of the M14b spike hands its CLI (Design 1).
//
// The side that runs in the user's own configuration takes M10's clean environment as it is. M10's
// rule strips every inherited CLAUDE* and ANTHROPIC* name, CLAUDE_CONFIG_DIR among them, so Claude's
// own side runs in its default folder; an inherited CODEX_HOME is kept. The folder side takes the
// same environment and sets the one variable. Only names are ever reported, never values.
import { cleanEnvironment } from '../../m10/lib/env.mjs';

/** The documented variable that moves each CLI's configuration folder (research §2). */
export const VARIABLES = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });

/** Inherited names worth naming in the report: they could put a credential or an endpoint before a folder's login (C9). */
const NOTABLE = Object.freeze({
  claude: /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$)/i,
  codex: /^(OPENAI_|CODEX_)/i,
});

const sameName = (a, b) => a.toUpperCase() === b.toUpperCase();

function variableOf(cli) {
  const variable = VARIABLES[cli];
  if (!variable) throw new Error(`no configuration-folder variable is known for ${cli}`);
  return variable;
}

/** The clean environment as it is, with what the report says about it: names and booleans only. */
export function ownEnvironment(cli, source = process.env) {
  const variable = variableOf(cli);
  const { env } = cleanEnvironment(cli, { source });
  const inSource = (name) => Object.keys(source).some((key) => sameName(key, name) && source[key] !== undefined);
  const inChild = (name) => Object.keys(env).some((key) => sameName(key, name));
  const notable = Object.keys(source)
    .filter((name) => source[name] !== undefined && NOTABLE[cli].test(name) && !sameName(name, variable))
    .sort()
    .map((name) => ({ name, reachesChild: inChild(name) }));
  return { env, report: { variable, variableInherited: inSource(variable), variableReachesChild: inChild(variable), notable } };
}

/** The clean environment with the one variable set to `folder`, in place of any inherited spelling of it. */
export function instanceEnvironment(cli, folder, source = process.env) {
  const variable = variableOf(cli);
  if (typeof folder !== 'string' || folder.length === 0) throw new Error('an instance needs a folder');
  const { env, report } = ownEnvironment(cli, source);
  for (const key of Object.keys(env)) if (sameName(key, variable)) delete env[key];
  env[variable] = folder;
  if (Object.keys(env).filter((key) => sameName(key, variable)).length !== 1) throw new Error(`${variable} is set more than once`);
  return { env, report: { ...report, variableSet: true } };
}
