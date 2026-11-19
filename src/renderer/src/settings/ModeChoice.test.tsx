// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15, V25 (docs/planning/_archive/M22.md, Design 10; C3, C40, C43, C63, C87): the choice among a provider's
// modes that Settings and the project dialog draw — the provider's own list with its descriptions,
// the one line under it, what no choice reads as in each place, and what a press says. Saving is
// the caller's: Settings' is in SettingsDialog.test.tsx, the project's in ProjectDialog.test.tsx.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODE_WORDS, type PermissionCapability } from '@shared/contracts/permissions';
import { MODES } from '../test/permissions';
import { ModeChoice, type ModeChoiceProps } from './ModeChoice';

afterEach(cleanup);

function show(props: Partial<ModeChoiceProps> = {}) {
  const onChange = vi.fn<(mode: string | null) => void>();
  render(<ModeChoice legend="Default mode" capability={MODES} value={null} none="fallback" disabled={false} onChange={onChange} {...props} />);
  return onChange;
}
const group = () => screen.getByRole('group', { name: 'Default mode' });
const radios = () => within(group()).getAllByRole<HTMLInputElement>('radio');
const rows = () => radios().map((radio) => (radio.closest('label') as HTMLElement).textContent);
const checked = () => radios().filter((radio) => radio.checked).map((radio) => radio.value);

it('offers descriptions as tooltips and accessible descriptions in compact Settings choices', () => {
  show({ tooltipsOnly: true });
  expect(group().title).toBe(MODES.inherited);
  expect(group().querySelector('[data-mode-inherited]')).toBeNull();
  for (const [index, radio] of radios().entries()) {
    expect(radio.getAttribute('aria-description')).toBe(MODES.modes[index]?.description);
    expect(radio.closest('label')?.title).toBe(MODES.modes[index]?.description);
    expect(radio.closest('label')?.textContent?.trim()).toBe(MODES.modes[index]?.label);
  }
});

describe('a choice among a provider’s modes (V15, V25; C40, C63, C87)', () => {
  it('lists the provider’s modes in its own words, each with what runs without asking, as native radios', () => {
    show();
    expect(radios().map((radio) => radio.value)).toEqual(MODES.modes.map((mode) => mode.id));
    expect(rows()).toEqual(MODES.modes.map((mode) => `${mode.label} ${mode.description}`));
    // One group: the arrow keys go through it, and one of them is chosen at most.
    expect(new Set(radios().map((radio) => radio.name)).size).toBe(1);
  });

  it('ends with the provider’s one line on the user’s own configuration, drawn once and said with the group (C3)', () => {
    show();
    const lines = group().querySelectorAll('[data-mode-inherited]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toBe(MODES.inherited);
    expect(group().lastElementChild).toBe(lines[0]);
    expect(group().getAttribute('aria-describedby')).toBe(lines[0]?.id);
  });

  it('shows another provider’s list for another provider, and holds no mode of its own', () => {
    const other: PermissionCapability = { ...MODES, modes: [{ id: 'careful', label: 'Careful', description: 'Asks about everything', asks: true, reading: false, transitionsFrom: [] }], fallback: 'careful', inherited: 'Another line' };
    show({ capability: other });
    expect(rows()).toEqual(['Careful Asks about everything']);
    expect(group().textContent).not.toContain('Ask first');
    expect(group().querySelector('[data-mode-inherited]')?.textContent).toBe('Another line');
  });

  it('says nothing of an account: no reason, no setup and no sandbox, whatever an account could use (C43)', () => {
    show();
    expect(group().querySelectorAll('button')).toHaveLength(0);
    expect(radios().some((radio) => radio.disabled)).toBe(false);
    expect(group().textContent).not.toMatch(/sandbox|not been shown|Set up|Restarts/);
  });

  it('marks the provider’s fallback where the user has chosen none, and the saved one where they have (C44)', () => {
    show();
    expect(checked()).toEqual(['ask-first']);
    cleanup();
    show({ value: 'edits-ok' });
    expect(checked()).toEqual(['edits-ok']);
    cleanup();
    // A saved id the provider no longer lists reads as none: the fallback is what a new chat would get.
    show({ value: 'a-retired-mode' });
    expect(checked()).toEqual(['ask-first']);
  });

  it('says the mode pressed, and saves nothing by itself', () => {
    const onChange = show();
    fireEvent.click(radios()[2] as HTMLElement);
    expect(onChange.mock.calls).toEqual([['edits-ok']]);
    // Controlled: it shows what it is given, which is what was saved.
    expect(checked()).toEqual(['ask-first']);
  });

  it('offers Use my default first where that is what no choice means, marked while the project has none (C40)', () => {
    const onChange = show({ none: 'use-default' });
    expect(rows()[0]).toBe(MODE_WORDS.useMyDefault);
    expect(radios()).toHaveLength(MODES.modes.length + 1);
    expect(checked()).toEqual(['']);
    fireEvent.click(radios()[3] as HTMLElement);
    expect(onChange.mock.calls).toEqual([['edits-ok']]);
    cleanup();
    const again = show({ none: 'use-default', value: 'berserk' });
    expect(checked()).toEqual(['berserk']);
    fireEvent.click(radios()[0] as HTMLElement);
    expect(again.mock.calls).toEqual([[null]]);
    cleanup();
    // A stored id the provider no longer lists is no choice: Use my default stands.
    show({ none: 'use-default', value: 'a-retired-mode' });
    expect(checked()).toEqual(['']);
  });

  it('takes no press while it is disabled, as every control of a read-only file is', () => {
    show({ disabled: true });
    expect((group() as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('has the focus on the chosen mode again once a choice that is saved at once has been saved, so the next arrow key goes on', () => {
    const props: ModeChoiceProps = { legend: 'Default mode', capability: MODES, value: 'ask-first', none: 'fallback', disabled: false, onChange: () => undefined };
    const { rerender } = render(<><ModeChoice {...props} /><button type="button">Elsewhere</button></>);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    /** What the browser does as a group is disabled, and jsdom does not: the control that had the focus gives it to nothing, and the page's body has it. */
    const taken = (radio: HTMLElement): void => {
      elsewhere.focus();
      elsewhere.blur();
      fireEvent.focusOut(radio, { relatedTarget: null });
    };
    // An arrow key moved to the next mode, and its save disables the group.
    (radios()[2] as HTMLElement).focus();
    rerender(<><ModeChoice {...props} disabled /><button type="button">Elsewhere</button></>);
    taken(radios()[2] as HTMLElement);
    expect(document.activeElement).toBe(document.body);
    // Saved: the group can be used again, and the chosen mode has the focus.
    rerender(<><ModeChoice {...props} value="edits-ok" /><button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(radios()[2]);
    expect(checked()).toEqual(['edits-ok']);

    // A focus that was not in the group is not taken: nothing of it was lost.
    elsewhere.focus();
    rerender(<><ModeChoice {...props} value="edits-ok" disabled /><button type="button">Elsewhere</button></>);
    rerender(<><ModeChoice {...props} value="edits-ok" /><button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(elsewhere);
    // One that left the group for another control while it could be used was not lost either.
    (radios()[2] as HTMLElement).focus();
    elsewhere.focus();
    elsewhere.blur();
    rerender(<><ModeChoice {...props} value="edits-ok" disabled /><button type="button">Elsewhere</button></>);
    rerender(<><ModeChoice {...props} value="edits-ok" /><button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(document.body);
    // And one that was lost, and has gone elsewhere before the save ended, is left there.
    (radios()[2] as HTMLElement).focus();
    rerender(<><ModeChoice {...props} value="edits-ok" disabled /><button type="button">Elsewhere</button></>);
    taken(radios()[2] as HTMLElement);
    elsewhere.focus();
    rerender(<><ModeChoice {...props} value="edits-ok" /><button type="button">Elsewhere</button></>);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('offers no mode for one prompt alone, and no control but its radios (S9)', () => {
    show({ none: 'use-default' });
    expect(group().querySelectorAll('button, select, input:not([type="radio"])')).toHaveLength(0);
  });
});
