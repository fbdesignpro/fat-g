// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V24 (docs/planning/_archive/M16.md; C19, C20, C61, C72): a project's other roots, from the project's
// record to Claude's command line — through the app's own gate and runtime, the real adapter and
// process layer, against the replay fake. The roots that are trusted and present go to `--add-dir`;
// they are read again at each launch; one that stops being eligible leaves a running session at the
// next Send; and, on Windows, one a shim launch would refuse is left out, with its notice.
//
// That a read in a root so supplied runs without a request, and one outside every root is asked for,
// is the CLI's own behaviour, traced in K8 and K23: the fake replays, and cannot show it.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { noticeWords } from '@shared/contracts/chat';
import { itemText } from '@shared/contracts/conversation';
import { type App, type AppOptions, launchApp, placeRecords, type PlacedRoot, S, sessionEntry, until } from '../../sessions/app';
import { claudeHarness, type Harness, type HarnessOptions } from './harness';

let harness: Harness | undefined;
let apps: App[] = [];
afterEach(async () => {
  for (const app of apps) await app.quit();
  apps = [];
  await harness?.dispose();
  harness = undefined;
});

const dataDir = (h: Harness): string => path.join(h.dir, 'records');
const place = (h: Harness, otherRoots: readonly PlacedRoot[]): void => placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })], { otherRoots });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
function launch(h: Harness, options: Partial<AppOptions> = {}): App {
  const app = launchApp({ dir: dataDir(h), descriptor: h.provider.descriptor, facet: () => h.facet, ...options });
  apps.push(app);
  return app;
}
async function turn(app: App, prompt: string): Promise<void> {
  expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
  await until(() => !app.service.isRunning(S(1)), 'the session coming to rest', 20_000);
  await app.service.settled();
}
const addDirs = (h: Harness): (readonly string[])[] => h.only().entry.launches.map((entry) => entry.addDirs);

describe('the other roots a Claude session is given (V7, V24; C19, C61)', () => {
  it('passes each root that is trusted and present as `--add-dir`, one flag each, after the working folder’s own launch arguments', async () => {
    const h = await open();
    const third = path.join(h.dir, 'third');
    const fourth = path.join(h.dir, 'fourth');
    place(h, [{ path: h.second }, { path: third, answer: 'not-trusted' }, { path: fourth }]);
    const app = launch(h, { isMissing: (root) => root === fourth });
    await turn(app, h.prompts.t1);
    const [first] = h.only().entry.launches;
    // The second root alone: the third is not trusted, and the fourth cannot be found.
    expect(first?.addDirs).toEqual([h.second]);
    expect(first?.args.slice(-2)).toEqual(['--add-dir', h.second]);
    // The working folder is where the process runs, and no argument.
    expect(first?.cwd).toBe(h.project);
    expect(first?.args).not.toContain(h.project);
  });

  it('passes none for a project with one root', async () => {
    const h = await open();
    place(h, []);
    await turn(launch(h), h.prompts.t1);
    expect(addDirs(h)).toEqual([[]]);
    expect(h.only().entry.launches[0]?.args).not.toContain('--add-dir');
  });

  it('reads them again at a resume: the list is each launch’s own', async () => {
    const h = await open();
    const third = path.join(h.dir, 'third');
    place(h, [{ path: h.second }, { path: third }]);
    const missing = new Set<string>([third]);
    const first = launch(h, { isMissing: (root) => missing.has(root) });
    await turn(first, h.prompts.t1);
    apps = [];
    await first.quit();
    await h.provider.dispose();
    await until(() => h.running('chat').length === 0, 'the first process ending', 15_000);

    // In the next run the third folder is back, and the second is gone.
    missing.clear();
    missing.add(h.second);
    const adapter = await h.adapter();
    const second = launch(h, { facet: () => adapter.facet, isMissing: (root) => missing.has(root) });
    await turn(second, h.prompts.t1);
    expect(addDirs(h)).toEqual([[h.second], [third]]);
    expect(h.only().entry.launches[1]).toMatchObject({ resume: h.only().id });
  });
});

describe('a root that stops being eligible while its session’s process is up (V24; C72)', () => {
  it('closes that process at the next Send, and the prompt resumes the session without it', async () => {
    const h = await open();
    place(h, [{ path: h.second }]);
    const missing = new Set<string>();
    const app = launch(h, { isMissing: (root) => missing.has(root) });
    await turn(app, h.prompts.t1);
    const [firstPid] = h.running('chat');
    expect(addDirs(h)).toEqual([[h.second]]);

    // Its trust is withdrawn, or it goes missing: nothing happens until a prompt is sent.
    missing.add(h.second);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.running('chat')).toEqual([firstPid]);

    await turn(app, h.prompts.t1);
    const { id, entry } = h.only();
    expect(entry.launches).toHaveLength(2);
    expect(entry.launches[1]).toMatchObject({ resume: id, addDirs: [] });
    expect(entry.launches[1]?.args).not.toContain('--add-dir');
    // The first process is gone, and the conversation went on: two turns, one session, both recorded.
    expect(h.running('chat')).not.toContain(firstPid);
    expect(entry.turns).toHaveLength(2);
    expect(app.read(1).items.filter((item) => item.role === 'user')).toHaveLength(2);
  });

  it('changes nothing for a root that becomes eligible, until the next launch', async () => {
    const h = await open();
    place(h, [{ path: h.second }]);
    const missing = new Set<string>([h.second]);
    const app = launch(h, { isMissing: (root) => missing.has(root) });
    await turn(app, h.prompts.t1);
    missing.clear();
    await turn(app, h.prompts.t1);
    expect(addDirs(h)).toEqual([[]]);
    expect(h.only().entry.turns).toHaveLength(2);
  });
});

describe.skipIf(process.platform !== 'win32')('a root a shim launch would refuse (V7; C20)', () => {
  it('is left out of the launch through a `.cmd` shim, by the kit’s rule, and the chat says so once, with no path', async () => {
    const h = await open({ shim: true });
    const awkward = path.join(h.dir, 'work (old)');
    const ampersand = path.join(h.dir, 'R&D');
    place(h, [{ path: h.second }, { path: awkward }, { path: ampersand }]);
    // The process is closed soon after each turn, so the run launches twice.
    const app = launch(h, { idleMs: 150 });
    await turn(app, h.prompts.t1);
    // The launch went through the shim, and carried the one folder it could carry safely.
    const [first] = h.only().entry.launches;
    expect(first?.addDirs).toEqual([h.second]);
    expect(first?.args.join(' ')).not.toMatch(/work \(old\)|R&D/);
    // The turn ran: the folder left out stopped nothing.
    expect(app.read(1).items.at(-1)).toMatchObject({ role: 'assistant', phase: 'final' });

    const notices = () => app.read(1).items.filter((item) => item.notice === 'folder-not-passed');
    expect(notices()).toHaveLength(1);
    expect(itemText(notices()[0] as never)).toBe(noticeWords('folder-not-passed', 'Claude'));
    expect(itemText(notices()[0] as never)).not.toMatch(/work \(old\)|R&D|[A-Za-z]:\\/);

    // The next launch of the same run leaves them out again, and the notice is not shown twice.
    await until(() => h.running('chat').length === 0, 'the idle process closing', 15_000);
    await turn(app, h.prompts.t1);
    expect(h.only().entry.launches).toHaveLength(2);
    expect(h.only().entry.launches[1]).toMatchObject({ addDirs: [h.second], resume: h.only().id });
    expect(notices()).toHaveLength(1);
  });

  it('passes every argument of a chat session’s launch through the shim unchanged: the tool list with its commas, a model key with a bracket, a folder with a space', async () => {
    const h = await open({ shim: true });
    const spaced = path.join(h.dir, 'a folder with spaces');
    place(h, [{ path: spaced }]);
    placeRecords(dataDir(h), h.project, 'claude', [sessionEntry(1, 'claude', { model: 'opus[1m]', effort: 'xhigh' })], { otherRoots: [{ path: spaced }] });
    const app = launch(h);
    await turn(app, h.prompts.t1);
    const [first] = h.only().entry.launches;
    expect(first).toMatchObject({ model: 'opus[1m]', effort: 'xhigh', addDirs: [spaced] });
    // A chat nobody chose a mode for runs under the fallback, Auto reviewed (decision 0027, item 7), Claude's `auto`,
    // whose launch offers eleven tools (M22b, C8): the list passes with its ten commas.
    expect(first?.args.slice(first.args.indexOf('--tools'), first.args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,WebFetch,WebSearch,ExitPlanMode']);
    expect([first?.mode, first?.tools]).toEqual(['auto', ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'ExitPlanMode']]);
    expect(first?.args[first.args.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    expect(h.markers()).toEqual([]);
  });
});
