// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The user's own terminal, opened with one command in it (docs/planning/_archive/M14b.md, round 6; C80): how an
// account is signed in without typing the command. The window is the user's, not fat-g's:
//
//   • It is started detached, with no pipe to fat-g. fat-g reads nothing from it and writes nothing
//     to it, so whatever a CLI's login prints or asks for stays between the user and the CLI.
//   • It is not a managed child: it is not recorded, not bounded and not ended at quit. The user
//     closes it.
//   • The command is shown before it runs, and the window stays open afterwards.
//
// Pure where it can be: `terminalLaunches` says what would be started on each OS, and is tested as a
// table. The Windows launch is also run for real, window included (tests/process/terminal-script.test.ts);
// the macOS and Linux launches are written and not run, and are a release gate there (M14b, C82).
import { spawn as nativeSpawn } from 'node:child_process';
import path from 'node:path';

export interface TerminalLaunch {
  readonly file: string;
  readonly args: readonly string[];
  /**
   * Windows only: the arguments are already one command line, to be passed as they are. `cmd` does
   * not read a command line the way other programs do, so Node's own quoting must stay out of it.
   */
  readonly verbatim?: boolean;
  /** Windows only: the started program needs no window of its own; the one it opens is the terminal. */
  readonly hidden?: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The longest command line `cmd.exe` takes is 8191 characters; this leaves room for the rest of the line. */
export const MAX_ENCODED_SCRIPT = 7000;

/** A PowerShell literal: inside single quotes only `'` is special, and it is doubled. */
const powershellLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;
/** A POSIX shell literal: a `'` ends the quotes, is written escaped, and begins them again. */
const shellLiteral = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * What to start so that a terminal opens, says `note`, shows `command` and runs it, and then stays
 * open as an ordinary shell. Several candidates where an OS has no one terminal: the first that
 * starts is used. None when the command cannot be handed over safely: the caller then says to copy it.
 *
 * `command` is run as written, in PowerShell on Windows and in a POSIX shell elsewhere: the caller
 * builds it for that shell (`loginCommand`, in the contract).
 */
export function terminalLaunches(platform: string, command: string, note: string, env: Env): TerminalLaunch[] {
  if (platform === 'win32') {
    // Windows' own programs by their full paths: never whatever `cmd` or `powershell` a PATH names.
    const rootName = Object.keys(env).find((name) => name.toLowerCase() === 'systemroot');
    const system = path.win32.join((rootName === undefined ? undefined : env[rootName]) ?? 'C:\\Windows', 'System32');
    const shell = path.win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `Write-Host ${powershellLiteral(note)}; Write-Host ''; Write-Host ${powershellLiteral(`> ${command}`)}; ${command}`;
    // A console program started detached by Node has no console at all, and PowerShell then ends at
    // once without running anything (seen on Windows 11, Node 24). `start` is what gives a program a
    // console window of its own, whatever console fat-g itself has or lacks. It is cmd's, and cmd
    // reads `%`, `&`, `^` and quotes its own way, so the script goes through as PowerShell's encoded
    // form, which is letters, digits, `+`, `/` and `=` only: nothing of a folder's path is cmd's to read.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length > MAX_ENCODED_SCRIPT) return [];
    return [{
      file: path.win32.join(system, 'cmd.exe'),
      // `/d`: no AutoRun commands. The first quoted argument of `start` is the window's title.
      args: ['/d', '/c', 'start', '"fat-g"', `"${shell}"`, '-NoLogo', '-NoExit', '-EncodedCommand', encoded],
      verbatim: true,
      hidden: true,
    }];
  }
  const script = `printf '%s\\n\\n%s\\n' ${shellLiteral(note)} ${shellLiteral(`> ${command}`)}; ${command}; exec "\${SHELL:-/bin/sh}"`;
  if (platform === 'darwin') {
    // Terminal.app, asked to run the script in a new window. An AppleScript string escapes `\` and `"`.
    const text = script.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    return [{ file: '/usr/bin/osascript', args: ['-e', `tell application "Terminal" to do script "${text}"`, '-e', 'tell application "Terminal" to activate'] }];
  }
  // Linux has no one terminal: the distribution's choice first, then the common ones.
  const terminals: readonly (readonly [string, string])[] = [['x-terminal-emulator', '-e'], ['gnome-terminal', '--'], ['konsole', '-e'], ['xfce4-terminal', '-x'], ['xterm', '-e']];
  return terminals.map(([file, flag]) => ({ file, args: [flag, 'sh', '-c', script] }));
}

export interface OpenTerminalOptions {
  readonly env: Record<string, string>;
  /** Where the shell starts: the user's home folder, never fat-g's own. */
  readonly cwd: string;
  readonly spawn?: typeof nativeSpawn;
}

/**
 * Starts the first launch that can be started, and answers whether one was. The child is detached
 * and unreferenced, with no pipe: fat-g keeps nothing of it.
 */
export async function openTerminal(launches: readonly TerminalLaunch[], { env, cwd, spawn = nativeSpawn }: OpenTerminalOptions): Promise<boolean> {
  for (const launch of launches) {
    const started = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(launch.file, [...launch.args], {
          detached: true,
          stdio: 'ignore',
          env,
          cwd,
          shell: false,
          windowsHide: launch.hidden === true,
          windowsVerbatimArguments: launch.verbatim === true,
        });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
    if (started) return true;
  }
  return false;
}
