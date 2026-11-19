// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15 (docs/planning/_archive/M19b.md, Design 10; C46): the files K2's answers name, in the one place the
// spike, the smoke run and the tests read them from. They are the files the captures were taken
// against, each with one marker sentence added at its end — which no captured frame holds, so the
// smoke run's scan can look for it everywhere, the conversation store included.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { viewOf } from '@shared/contracts/files';
import { FILE_MARKERS, FILES, FUNCTION_LINE, HEADINGS } from './project-files.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NAMES = ['m19b-line', 'm19b-readme', 'm19b-space'];
const captures = ['codex', 'claude'].flatMap((cli) => NAMES.map((name) => ({ cli, name, text: readFileSync(path.join(ROOT, 'tests/fixtures', cli, 'captures', `${name}.json`), 'utf8') })));
/** Every string a capture's frames hold, a reply's deltas joined as well. */
function strings(text: string): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk((JSON.parse(text) as { frames: unknown }).frames);
  return found;
}

describe('the files the answers name (C46)', () => {
  it('are a README, a source file, and a Markdown file in a folder whose name has a space', () => {
    expect(Object.keys(FILES)).toEqual(['README.md', 'src/tides.js', 'field notes/harbour-log.md']);
    expect(Object.keys(FILES).map((name) => viewOf(path.basename(name)))).toEqual(['markdown', 'plain', 'markdown']);
  });

  it('define nextHighTide on the line the captured answers give', () => {
    expect(FUNCTION_LINE).toBe(12);
    expect(FILES['src/tides.js'].split('\n')[FUNCTION_LINE - 1]).toContain('function nextHighTide');
    for (const { cli, name, text } of captures.filter((capture) => capture.name === 'm19b-line')) expect(strings(text).some((value) => value.includes('src/tides.js:12')), `${cli}/${name}`).toBe(true);
  });

  it('start each Markdown file with the heading its tab shows', () => {
    expect(HEADINGS).toEqual({ 'README.md': 'Tide tools', 'field notes/harbour-log.md': 'Harbour log' });
    for (const [name, heading] of Object.entries(HEADINGS)) expect(FILES[name as keyof typeof HEADINGS].startsWith(`# ${heading}\n`), name).toBe(true);
  });

  it('say nothing of where they are: no path is written in any of them', () => {
    for (const [name, text] of Object.entries(FILES)) expect(text, name).not.toMatch(/[A-Za-z]:[\\/]|\/(?:Users|home|tmp)\//);
  });

  it('end each in one marker, which no frame of any capture holds: no answer quotes it', () => {
    expect(FILE_MARKERS).toHaveLength(3);
    for (const [index, text] of Object.values(FILES).entries()) {
      const marker = FILE_MARKERS[index] ?? '';
      expect(marker).toMatch(/^marker-[a-z]+-[0-9a-f]{4}$/);
      expect(text.split(marker)).toHaveLength(2);
      // After everything the captures were taken against.
      expect(text.trimEnd().split('\n').at(-1)).toContain(marker);
    }
    for (const { cli, name, text } of captures) for (const marker of FILE_MARKERS) expect(text.includes(marker), `${cli}/${name}`).toBe(false);
  });

  it('are otherwise the files the captures were taken against: what a CLI read of one is in it still', () => {
    // Claude's Read tool answered with the README's own lines: each is a line of the file as it is now.
    const readme = captures.find((capture) => capture.cli === 'claude' && capture.name === 'm19b-readme');
    const read = strings(readme?.text ?? '').find((value) => value.includes('Small helpers the harbour office uses')) ?? '';
    expect(read).not.toBe('');
    const sentence = 'Small helpers the harbour office uses to read its tide table: they parse the times of the day\'s tides, find the next high tide and print a height in metres.';
    expect(read).toContain(sentence);
    expect(FILES['README.md']).toContain(sentence);
  });

  it('are in one place: the spike that traced them reads this copy', () => {
    const spike = readFileSync(path.join(ROOT, 'spikes/m19b/lib/common.mjs'), 'utf8');
    expect(spike).toMatch(/export \{ FILES, FUNCTION_LINE \} from '\.\.\/\.\.\/\.\.\/tests\/fixtures\/project-files\.mjs';/);
    expect(spike).not.toContain('harbour office');
    // And nothing under src/ holds a word of them: they reach the app only through a fake's answer and the live project's folder.
    const sources = (readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })).filter((name) => /\.(ts|tsx)$/.test(name));
    for (const name of sources) expect(readFileSync(path.join(ROOT, 'src', name), 'utf8').includes('marker-readme'), name).toBe(false);
  });
});
