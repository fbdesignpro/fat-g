// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { regularOwnedFile } from './owned-file';

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(path.join(tmpdir(), 'fatg-owned-file-')); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('revealing an owned file', () => {
  it('accepts existing regular files and refuses missing files, folders and paths outside the root', () => {
    const root = path.join(scratch, 'owned');
    mkdirSync(root);
    const file = path.join(root, 'v1.md');
    writeFileSync(file, 'plan');
    // The returned path is canonical; macOS's temporary root can start with the /var alias.
    expect(regularOwnedFile(root, file)).toBe(realpathSync(file));
    expect(regularOwnedFile(root, root)).toBeNull();
    expect(regularOwnedFile(root, path.join(root, 'missing.md'))).toBeNull();
    const outside = path.join(scratch, 'private.md');
    writeFileSync(outside, 'private');
    expect(regularOwnedFile(root, outside)).toBeNull();
  });

  it('refuses files below a redirected folder', () => {
    const root = path.join(scratch, 'owned');
    const outside = path.join(scratch, 'elsewhere');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'v1.md'), 'private');
    symlinkSync(outside, path.join(root, 'redirect'), 'junction');
    expect(regularOwnedFile(root, path.join(root, 'redirect', 'v1.md'))).toBeNull();
  });
});
