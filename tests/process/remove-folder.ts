// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Removing a test's scratch folder after the processes that ran in it.
import { rmSync } from 'node:fs';

/**
 * Removes a scratch folder once nothing holds it. On Windows a process that was just ended can hold
 * its working folder, and the files it had open, a little longer than it reads as gone, and more so
 * on a loaded machine. `rmSync`'s own `maxRetries` does not wait for that: on the access-denied
 * error such a folder gives, Node 24 fails at once, whatever the count. So the wait is made here:
 * ten seconds by default, then the error is the test's.
 */
export async function removeFolder(dir: string, attempts = 50, pauseMs = 200): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}
