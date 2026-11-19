// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7 (docs/planning/_archive/M16.md; C20): the one rule on what a launch through a `.cmd` shim cannot carry.
// tests/process/integration.test.ts holds the process layer to the same rule, against a real shim.
import { describe, expect, it } from 'vitest';
import { shimRefuses } from './process';

describe('what a shim launch refuses (C20)', () => {
  it('refuses a value that holds a character cmd expands or a batch file parses again', () => {
    for (const character of ['%', '!', '"', '&', '|', '<', '>', '^', '(', ')', '\r', '\n']) {
      expect(shimRefuses(character), JSON.stringify(character)).toBe(true);
      expect(shimRefuses(`C:\\work\\a${character}b`), JSON.stringify(character)).toBe(true);
    }
  });

  it('passes an ordinary path, with spaces, other scripts, a model key and an empty value', () => {
    for (const value of ['C:\\Users\\someone\\My Projects\\app', '/home/someone/été 🐈', 'D:\\a\\b-c_d.e', 'opus[1m]', 'Read,Glob,Grep,Agent', 'user,project,local', 'trailing\\', '', "it's", 'a;b', 'a$b', 'a~b', 'a#b', 'a@b', 'a=b', 'a+b', 'a{b}', 'a`b']) {
      expect(shimRefuses(value), value).toBe(false);
    }
  });
});
