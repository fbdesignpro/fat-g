// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, round 6, V28 (C80, C81): the login terminal, for real, on the OS this runs on. A harmless
// command stands in for a CLI's login: it sets a variable to a path with a space and a quote, as the
// login command does, and prints it.
//
//   • The script: the same shell is run with the same script and its output is read, which proves
//     the quoting.
//   • The window, on Windows: the launch itself is started, as the button starts it, and the script
//     writes down whether it has a console window that can be seen. That window shows for about a
//     second. A test that opened none let a button ship that opened none.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loginCommand } from '@shared/contracts/instances';
import { openTerminal, terminalLaunches } from '../../src/main/process/terminal';
import { removeFolder } from './remove-folder';

const NOTE = "fat-g opened this window so you can sign in. It's yours.";
const lines = (text: string): string[] => text.split(/\r?\n/).filter((line, index, all) => index < all.length - 1 || line !== '');
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

describe('the login terminal’s script, in the real shell (C80)', () => {
  it.runIf(process.platform === 'win32')('says the note and the command, then runs it with the variable set, in Windows PowerShell', () => {
    const folder = "D:\\accounts\\100% it's my & work";
    const command = loginCommand('powershell', 'FATG_TERMINAL_CHECK', folder, 'Write-Output $env:FATG_TERMINAL_CHECK');
    const [launch] = terminalLaunches('win32', command, NOTE, process.env);
    if (launch === undefined) throw new Error('no launch');
    // The launch is cmd's `start`, then PowerShell and its arguments. The same PowerShell and the
    // same encoded script, without `start` and without -NoExit, so it ends and its output can be read.
    const shell = (launch.args[4] ?? '').replaceAll('"', '');
    const encoded = launch.args.at(-1) ?? '';
    expect(launch.args.slice(5)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand', encoded]);
    const result = spawnSync(shell, ['-NoLogo', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual([NOTE, '', `> ${command}`, folder]);
  }, 40_000);

  it.runIf(process.platform !== 'win32')('says the note and the command, then runs it with the variable set, in a POSIX shell', () => {
    const folder = "/tmp/accounts/it's my work";
    const command = loginCommand('posix', 'FATG_TERMINAL_CHECK', folder, 'sh -c \'printf "%s\\n" "$FATG_TERMINAL_CHECK"\'');
    // The Linux launch is a terminal's name and flag, then the shell and its script.
    const [, shell, flag, script] = terminalLaunches('linux', command, NOTE, process.env)[0]?.args ?? [];
    if (shell === undefined || flag === undefined || script === undefined) throw new Error('no launch');
    // The shell that keeps the window open reads no input here, so it ends at once.
    const result = spawnSync(shell, [flag, script], { encoding: 'utf8', input: '', env: { ...process.env, SHELL: '/bin/sh' }, timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual([NOTE, '', `> ${command}`, folder]);
  }, 40_000);
});

describe('the login terminal’s window, for real (C81)', () => {
  it.runIf(process.platform === 'win32')('opens a console window that can be seen, and runs the command in it', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fatg-terminal 100% it's & real-"));
    const marker = path.join(dir, 'seen.txt');
    try {
      // What a login would be: here, a command that writes down what window it runs in, then closes it.
      const command = [
        `$sig = '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);'`,
        '$t = Add-Type -MemberDefinition $sig -Name W -Namespace FatgTerminalCheck -PassThru',
        '$h = $t::GetConsoleWindow()',
        `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ("window=" + ($h -ne [IntPtr]::Zero) + " visible=" + $t::IsWindowVisible($h))`,
        'exit',
      ].join('; ');
      expect(await openTerminal(terminalLaunches('win32', command, NOTE, process.env), { env, cwd: os.homedir() })).toBe(true);
      const deadline = Date.now() + 30_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(marker) ? readFileSync(marker, 'utf8').trim() : 'the command did not run').toBe('window=True visible=True');
    } finally {
      await removeFolder(dir);
    }
  }, 60_000);
});
