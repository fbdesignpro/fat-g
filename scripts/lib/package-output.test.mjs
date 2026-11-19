// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPackageDirectories, packageOptions } from './package-output.mjs';

test('builder and audit agree on defaults and a separate output without changing the flavor', () => {
  const root = path.resolve('checkout with spaces');
  assert.equal(packageOptions(root, ['release'], ['--dir']).output, path.join(root, 'release', 'release'));
  assert.equal(packageOptions(root, ['smoke'], ['--dir']).output, path.join(root, 'release', 'smoke'));
  const build = packageOptions(root, ['release', '--dir', '--output', 'candidate-0.9.0'], ['--dir']);
  const audit = packageOptions(root, ['release', '--output', 'candidate-0.9.0', '--tamper'], ['--tamper']);
  assert.equal(build.output, path.join(root, 'release', 'candidate-0.9.0'));
  assert.equal(audit.output, build.output);
  assert.equal(build.flavor, 'release');
  assert.equal(audit.flavor, 'release');
  assert.deepEqual([...build.flags], ['--dir']);
  assert.deepEqual([...audit.flags], ['--tamper']);
});

test('rejects traversal, absolute paths, staging, Windows aliases and malformed options', () => {
  for (const name of ['', '.', '..', '.staging', '../release', 'release/child', 'release\\child', '/tmp/build', 'C:\\build', '\\\\server\\share', 'candidate.', 'candidate ', 'NUL', 'con.txt', 'COM1', 'LPT9.txt', '--dir']) {
    assert.throws(() => packageOptions('.', ['release', '--output', name], ['--dir']), /--output needs/);
  }
  assert.throws(() => packageOptions('.', ['release', '--output'], []), /--output needs/);
  assert.throws(() => packageOptions('.', ['release', '--output', 'one', '--output', 'two'], []), /only once/);
  assert.throws(() => packageOptions('.', ['release', '--tamper'], ['--dir']), /Unknown option/);
  assert.throws(() => packageOptions('.', ['release', '--dir'], ['--tamper']), /Unknown option/);
  assert.throws(() => packageOptions('.', ['candidate'], []), /Expected release or smoke/);
});

test('cleanup of a selected candidate leaves the ordinary package intact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fatg-package-output-'));
  try {
    const running = path.join(root, 'release', 'release');
    const candidate = packageOptions(root, ['release', '--output', 'candidate'], []).output;
    mkdirSync(running, { recursive: true });
    mkdirSync(candidate);
    writeFileSync(path.join(running, 'running.txt'), 'keep');
    writeFileSync(path.join(candidate, 'old.txt'), 'replace');
    checkPackageDirectories(root, [candidate, path.join(root, 'release', '.staging'), path.join(root, 'out')]);
    rmSync(candidate, { recursive: true });
    assert.equal(readFileSync(path.join(running, 'running.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(candidate), false);
    assert.throws(() => checkPackageDirectories(root, [root]), /inside the checkout/);
    assert.throws(() => checkPackageDirectories(root, [path.join(root, '..', 'outside')]), /inside the checkout/);
    writeFileSync(path.join(root, 'out'), 'not a directory');
    assert.throws(() => checkPackageDirectories(root, [path.join(root, 'out')]), /ordinary folder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses an output junction and a junction in its parent before cleanup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fatg-package-links-'));
  try {
    const checkout = path.join(root, 'checkout');
    const outside = path.join(root, 'outside');
    mkdirSync(path.join(checkout, 'release'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    const candidate = packageOptions(checkout, ['release', '--output', 'candidate'], []).output;
    symlinkSync(outside, candidate, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => checkPackageDirectories(checkout, [candidate]), /ordinary folder/);
    rmSync(path.join(checkout, 'release'), { recursive: true });
    symlinkSync(outside, path.join(checkout, 'release'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => checkPackageDirectories(checkout, [candidate]), /ordinary folder/);
    assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
