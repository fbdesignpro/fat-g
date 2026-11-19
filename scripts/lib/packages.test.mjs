// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { licenseText, packageNoticeProblems, renderNotices } from './packages.mjs';

test('keeps every license and NOTICE, and does not mistake a directory or NOTICE alone for a license', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fatg-licenses-'));
  try {
    mkdirSync(path.join(directory, 'LICENSES'));
    writeFileSync(path.join(directory, 'NOTICE'), 'Upstream author credit\r\n');
    assert.equal(licenseText(directory), null);
    writeFileSync(path.join(directory, 'LICENSE'), 'First license\r\n');
    writeFileSync(path.join(directory, 'COPYING.extra'), 'Second license\n');
    const text = licenseText(directory);
    assert.equal(text, 'COPYING.extra\n\nSecond license\n\nLICENSE\n\nFirst license\n\nNOTICE\n\nUpstream author credit');
    const entries = [{ name: 'example', version: '1', license: 'MIT', text, how: 'bundled' }];
    const notices = renderNotices(entries);
    assert.deepEqual(packageNoticeProblems(entries, notices), []);
    assert.match(packageNoticeProblems(entries, notices.replace('Upstream author credit', ''))[0], /notice text missing/);
    writeFileSync(path.join(directory, 'NOTICE'), '');
    assert.throws(() => licenseText(directory), /Empty license or notice/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('names incomplete shipped packages without imposing a license allowlist', () => {
  assert.deepEqual(packageNoticeProblems([
    { name: 'missing', version: '1', license: null, text: null },
    { name: 'blank', version: '2', license: ' ', text: '\n' },
    { name: 'separate-terms', version: '3', license: 'SEE LICENSE IN LICENSE', text: 'Its own terms' },
  ]), ['missing@1: no declared license', 'missing@1: no license text', 'blank@2: no declared license', 'blank@2: no license text']);
});
