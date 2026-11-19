// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The user's own terminal, opened with one command (docs/planning/_archive/M14b.md, round 6, V28; C80): what is
// started on each OS, on a table, and that it is started detached, with no pipe to fat-g.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ENCODED_SCRIPT, openTerminal, terminalLaunches } from './terminal';

const NOTE = 'fat-g opened this window so you can sign in.';
/** What keeps a POSIX terminal open after the command: the user's own shell. */
const STAY = 'exec "${SHELL:-/bin/sh}"';
/** The script a Windows launch hands to PowerShell: its last argument, in PowerShell's encoded form. */
const decoded = (launch: { readonly args: readonly string[] } | undefined): string => Buffer.from(launch?.args.at(-1) ?? '', 'base64').toString('utf16le');

describe('what is started (C80)', () => {
  it('is cmd’s start on Windows, opening Windows PowerShell in a window of its own, kept open, both by their full paths', () => {
    const command = String.raw`$env:VENDOR_HOME = 'D:\accounts\work'; vendor login`;
    const [launch, ...others] = terminalLaunches('win32', command, NOTE, { SystemRoot: 'C:\\Windows' });
    expect(others).toEqual([]);
    expect(launch?.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch?.args.slice(0, 8)).toEqual(['/d', '/c', 'start', '"fat-g"', '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"', '-NoLogo', '-NoExit', '-EncodedCommand']);
    expect(launch?.args).toHaveLength(9);
    // The arguments are one command line already, and cmd itself needs no window.
    expect([launch?.verbatim, launch?.hidden]).toEqual([true, true]);
    // The script: the note, a blank line, the command shown, then the command.
    expect(decoded(launch)).toBe(String.raw`Write-Host 'fat-g opened this window so you can sign in.'; Write-Host ''; Write-Host '> $env:VENDOR_HOME = ''D:\accounts\work''; vendor login'; $env:VENDOR_HOME = 'D:\accounts\work'; vendor login`);
  });

  it('hands cmd nothing of the command to read: the script is letters, digits, +, / and = only, whatever the folder’s path holds', () => {
    const command = String.raw`$env:VENDOR_HOME = 'D:\100% "mine" & ^yours^ (old) !x! %PATH%'; vendor login`;
    const [launch] = terminalLaunches('win32', command, NOTE, {});
    expect(launch?.args.at(-1)).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(launch?.args.join(' ')).not.toMatch(/[%&^!()<>|]/);
    expect(decoded(launch)).toContain(command);
  });

  it('finds the Windows folder under any spelling of its variable, and falls back to the usual one', () => {
    expect(terminalLaunches('win32', 'vendor login', NOTE, { SYSTEMROOT: 'D:\\WinNT' })[0]).toMatchObject({ file: 'D:\\WinNT\\System32\\cmd.exe', args: expect.arrayContaining(['"D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"']) as unknown });
    expect(terminalLaunches('win32', 'vendor login', NOTE, {})[0]?.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('shows on Windows a command whose path holds a quote exactly as it runs', () => {
    const command = String.raw`$env:VENDOR_HOME = 'D:\it''s mine'; vendor login`;
    const [launch] = terminalLaunches('win32', command, "it's a note", {});
    // The shown text is the command as a literal: each of its quotes doubled once more.
    expect(decoded(launch)).toBe(String.raw`Write-Host 'it''s a note'; Write-Host ''; Write-Host '> $env:VENDOR_HOME = ''D:\it''''s mine''; vendor login'; $env:VENDOR_HOME = 'D:\it''s mine'; vendor login`);
  });

  it('starts nothing on Windows for a command too long for cmd’s line: the caller then says to copy it', () => {
    const long = (length: number) => `$env:VENDOR_HOME = '${'x'.repeat(length)}'; vendor login`;
    expect(terminalLaunches('win32', long(200), NOTE, {})).toHaveLength(1);
    expect(terminalLaunches('win32', long(3000), NOTE, {})).toEqual([]);
    // Whatever is started fits.
    const [launch] = terminalLaunches('win32', long(1000), NOTE, {});
    expect((launch?.args.at(-1) ?? '').length).toBeLessThanOrEqual(MAX_ENCODED_SCRIPT);
  });

  it('is the distribution’s terminal on Linux, then the common ones, each running the same script', () => {
    const command = "VENDOR_HOME='/home/me/work' vendor login";
    const launches = terminalLaunches('linux', command, NOTE, {});
    expect(launches.map((launch) => [launch.file, launch.args[0]])).toEqual([['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'], ['xterm', '-e']]);
    // The note and the command are shown as literals, each `'` of the command closed, escaped and opened again.
    const shown = String.raw`'> VENDOR_HOME='\''/home/me/work'\'' vendor login'`;
    const script = String.raw`printf '%s\n\n%s\n' 'fat-g opened this window so you can sign in.' ` + `${shown}; ${command}; ${STAY}`;
    for (const launch of launches) expect(launch.args.slice(1)).toEqual(['sh', '-c', script]);
  });

  it('is Terminal on macOS, asked to run the same script in a new window, then brought forward', () => {
    const command = `VENDOR_HOME='/Users/me/my "work"' vendor login`;
    const [launch, ...others] = terminalLaunches('darwin', command, NOTE, {});
    expect(others).toEqual([]);
    expect(launch?.file).toBe('/usr/bin/osascript');
    expect(launch?.args.slice(2)).toEqual(['-e', 'tell application "Terminal" to activate']);
    expect(launch?.args[0]).toBe('-e');
    // The script Linux would run, as an AppleScript string: its backslashes and double quotes escaped, nothing else.
    const script = terminalLaunches('linux', command, NOTE, {})[0]?.args[3] ?? '';
    expect(script).toContain(command);
    expect(launch?.args[1]).toBe(`tell application "Terminal" to do script "${script.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`);
    // Escaped, so the string ends where it should: no bare double quote inside it.
    const inner = (launch?.args[1] ?? '').slice('tell application "Terminal" to do script "'.length, -1);
    expect(inner.replaceAll('\\\\', '').replaceAll('\\"', '')).not.toContain('"');
  });

  it.each(['win32', 'darwin', 'linux'])('runs the command as it is given on %s, once, after showing it', (platform) => {
    const [launch] = terminalLaunches(platform, 'vendor login --device', NOTE, {});
    const text = (platform === 'win32' ? decoded(launch) : platform === 'darwin' ? launch?.args[1] : launch?.args.at(-1)) ?? '';
    // Once shown, after "> ", and once run.
    expect(text.split('vendor login --device')).toHaveLength(3);
    expect(text).toContain('> vendor login --device');
    expect(text).toContain(NOTE);
  });
});

describe('how it is started (C80)', () => {
  /** A child that starts, or fails as a missing program does. */
  const child = (starts: boolean) => {
    const emitter = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => emitter.emit(starts ? 'spawn' : 'error', new Error('ENOENT')));
    return emitter;
  };
  const env = { PATH: '/usr/bin' };

  it('starts the first launch detached, with no pipe, in the given folder, and lets it go', async () => {
    const started = child(true);
    const spawn = vi.fn(() => started);
    expect(await openTerminal([{ file: 'terminal', args: ['-e', 'x'] }], { env, cwd: '/home/me', spawn: spawn as never })).toBe(true);
    expect(spawn.mock.calls).toEqual([['terminal', ['-e', 'x'], { detached: true, stdio: 'ignore', env, cwd: '/home/me', shell: false, windowsHide: false, windowsVerbatimArguments: false }]]);
    // Nothing of it is kept: fat-g does not wait for it, read it or end it.
    expect(started.unref).toHaveBeenCalledOnce();
  });

  it('passes a Windows launch’s line as it is, and gives cmd no window of its own', async () => {
    const spawn = vi.fn((_file: string, _args: readonly string[], _options: object) => child(true));
    const [launch] = terminalLaunches('win32', 'vendor login', NOTE, {});
    if (launch === undefined) throw new Error('no launch');
    expect(await openTerminal([launch], { env, cwd: 'C:\\Users\\me', spawn: spawn as never })).toBe(true);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, stdio: 'ignore', shell: false, windowsHide: true, windowsVerbatimArguments: true });
  });

  it('tries the next launch when one cannot be started, and stops at the first that can', async () => {
    const outcomes = [false, false, true, true];
    const spawn = vi.fn((_file: string) => child(outcomes.shift() ?? false));
    const launches = ['a', 'b', 'c', 'd'].map((file) => ({ file, args: [] }));
    expect(await openTerminal(launches, { env, cwd: '/home/me', spawn: spawn as never })).toBe(true);
    expect(spawn.mock.calls.map(([file]) => file)).toEqual(['a', 'b', 'c']);
  });

  it('answers false when none can be started, when starting throws, and with nothing to start', async () => {
    expect(await openTerminal([{ file: 'a', args: [] }, { file: 'b', args: [] }], { env, cwd: '/home/me', spawn: (() => child(false)) as never })).toBe(false);
    expect(await openTerminal([{ file: 'a', args: [] }], { env, cwd: '/home/me', spawn: (() => { throw new Error('EINVAL'); }) })).toBe(false);
    expect(await openTerminal([], { env, cwd: '/home/me', spawn: vi.fn() as never })).toBe(false);
  });
});
