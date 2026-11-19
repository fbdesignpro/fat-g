// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The tooltip by itself: when it shows and when it does not, above all after a press of the pointer,
// whose focus would otherwise hold it open once the pointer has gone (the maintainer).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NameTip, type TipSide, Tooltip, useNameTip, useTooltip } from './Tooltip';

afterEach(cleanup);

function Target() {
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  return (
    <>
      <button ref={anchor} type="button" {...tooltip.targetProps}>
        Mark
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor}>
        Mark as to do
      </Tooltip>
    </>
  );
}

const button = () => screen.getByRole('button', { name: 'Mark' });
const shown = () => screen.getByRole('tooltip', { hidden: true }).hasAttribute('data-open');

/** A press of the pointer as the browser gives it: down, the focus, up, the click. */
function press(target: HTMLElement): void {
  fireEvent.pointerDown(target);
  act(() => target.focus());
  fireEvent.pointerUp(target);
  fireEvent.click(target);
}

describe('useTooltip', () => {
  it('shows under the pointer and while the focus comes by the keyboard, until Escape', () => {
    render(<Target />);
    expect(shown()).toBe(false);
    fireEvent.pointerEnter(button());
    expect(shown()).toBe(true);
    fireEvent.pointerLeave(button());
    expect(shown()).toBe(false);
    act(() => button().focus());
    expect(shown()).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shown()).toBe(false);
  });

  it('closes at a press, and the focus the press gives does not hold it open once the pointer has gone', () => {
    render(<Target />);
    fireEvent.pointerEnter(button());
    press(button());
    expect(document.activeElement).toBe(button());
    expect(shown()).toBe(false);
    fireEvent.pointerLeave(button());
    expect(shown()).toBe(false);
    // The pointer back: it shows, and goes with the pointer, the focus still on the button.
    fireEvent.pointerEnter(button());
    expect(shown()).toBe(true);
    fireEvent.pointerLeave(button());
    expect(shown()).toBe(false);
  });

  it('closes at a press on a target the keyboard had focused, and stays closed once the pointer has gone', () => {
    render(<Target />);
    act(() => button().focus());
    expect(shown()).toBe(true);
    fireEvent.pointerEnter(button());
    press(button());
    expect(shown()).toBe(false);
    fireEvent.pointerLeave(button());
    expect(shown()).toBe(false);
  });

  it('shows again when the focus leaves and comes back by the keyboard', () => {
    render(<Target />);
    fireEvent.pointerEnter(button());
    press(button());
    fireEvent.pointerLeave(button());
    act(() => button().blur());
    act(() => button().focus());
    expect(shown()).toBe(true);
  });
});

function Named() {
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  return (
    <>
      <button ref={anchor} type="button" aria-label="Explain this" {...tip.targetProps} />
      <NameTip open={tip.open} anchor={anchor}>Explain this</NameTip>
    </>
  );
}

const named = () => screen.getByRole('button', { name: 'Explain this' });
const nameTip = () => document.querySelector('[data-name-tip]');

describe('NameTip (the maintainer)', () => {
  it('shows a control’s name at once under the pointer and while the focus comes by the keyboard, and is in the page only while it shows', () => {
    render(<Named />);
    expect(nameTip()).toBeNull();
    fireEvent.pointerEnter(named());
    expect(nameTip()?.textContent).toBe('Explain this');
    fireEvent.pointerLeave(named());
    expect(nameTip()).toBeNull();
    act(() => named().focus());
    expect(nameTip()).not.toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(nameTip()).toBeNull();
  });

  it('repeats the label, so the control is described by nothing and the name is hidden from assistive technology', () => {
    render(<Named />);
    fireEvent.pointerEnter(named());
    expect(named().hasAttribute('aria-describedby')).toBe(false);
    expect(nameTip()?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes at a press, as the tooltip does', () => {
    render(<Named />);
    fireEvent.pointerEnter(named());
    press(named());
    expect(nameTip()).toBeNull();
  });
});

function Placed({ side }: { readonly side: TipSide }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  return (
    <>
      <button ref={anchor} type="button" aria-label="Explain this" {...tip.targetProps} />
      <NameTip open={tip.open} anchor={anchor} side={side}>Explain this</NameTip>
    </>
  );
}

/** Where a name shows for a 16 × 12 control at `left`, 200 from the top of jsdom's 1024 × 768 window, the name 100 × 30. */
function placedAt(side: TipSide, left: number): { readonly left: string; readonly top: string } {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: left, y: 200, left, top: 200, right: left + 16, bottom: 212, width: 16, height: 12, toJSON: () => ({}) });
  render(<Placed side={side} />);
  fireEvent.pointerEnter(named());
  const { style } = nameTip() as HTMLElement;
  return { left: style.left, top: style.top };
}

describe('Where a name stands (the maintainer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stands below its control, its right edge at the control’s', () => {
    expect(placedAt('below', 500)).toEqual({ left: '416px', top: '216px' });
  });

  it('stands to the right of a control in the margin, level with its middle, so it covers no control below it', () => {
    expect(placedAt('right', 500)).toEqual({ left: '520px', top: '191px' });
  });

  it('stands at the control’s left where the window has no room at its right', () => {
    expect(placedAt('right', 990)).toEqual({ left: '886px', top: '191px' });
  });
});
