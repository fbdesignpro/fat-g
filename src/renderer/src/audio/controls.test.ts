// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { connectControlAudio } from './controls';

let stop: () => void;
const emit = vi.fn();
beforeEach(() => { emit.mockClear(); stop = connectControlAudio(emit); });
afterEach(() => { stop(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('delegated UI effects', () => {
  it('plays one click from a nested icon and keyboard activation', async () => {
    document.body.innerHTML = '<button><span>icon</span></button>';
    fireEvent.click(document.querySelector('span') as Element);
    await Promise.resolve(); expect(emit).toHaveBeenLastCalledWith('click');
    fireEvent.click(document.querySelector('button') as Element, { detail: 0 });
    await Promise.resolve(); expect(emit).toHaveBeenCalledTimes(2);
  });
  it('captures eligibility before an action disables its button and honours cancellation', async () => {
    const button = document.createElement('button'); document.body.append(button);
    button.onclick = () => { button.disabled = true; };
    fireEvent.click(button); await Promise.resolve(); expect(emit).toHaveBeenCalledOnce();
    button.disabled = false; button.onclick = (event) => event.preventDefault();
    fireEvent.click(button); await Promise.resolve(); expect(emit).toHaveBeenCalledOnce();
  });
  it('ignores disabled controls, dedicated actions, preview and text editing', async () => {
    document.body.innerHTML = '<button disabled>no</button><button data-audio="dedicated">Done</button><button data-audio="silent">Preview</button><input type="text"><div aria-disabled="true"><button>off</button></div>';
    for (const element of document.querySelectorAll('button,input')) fireEvent.click(element);
    await Promise.resolve(); expect(emit).not.toHaveBeenCalled();
  });
  it('does not repeat rollover between child nodes and throttles movement across buttons', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    document.body.innerHTML = '<button><span>one</span><b>two</b></button><button>other</button>';
    const first = document.querySelector('span') as Element;
    fireEvent.pointerOver(first);
    fireEvent.pointerOver(document.querySelector('b') as Element, { relatedTarget: first });
    fireEvent.pointerOver(document.querySelectorAll('button')[1] as Element);
    expect(emit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(101);
    fireEvent.pointerOver(document.querySelectorAll('button')[1] as Element);
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it('hears a right-click once even if a custom menu consumes it', () => {
    const button = document.createElement('button'); document.body.append(button);
    button.oncontextmenu = (event) => { event.preventDefault(); event.stopPropagation(); };
    fireEvent.contextMenu(button);
    expect(emit.mock.calls).toEqual([['rightClick']]);
  });
  it('removes every listener when disposed', async () => {
    stop();
    document.body.innerHTML = '<button>off</button>';
    fireEvent.click(document.querySelector('button') as Element);
    fireEvent.contextMenu(document.body); await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });
});
