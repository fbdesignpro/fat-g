// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAsides } from '../../chat/asides-store';
import { asideStage, type AsideStage, CODEX_ASIDES, marker, session } from '../../test/asides';
import { ASIDE_KIND, openAside } from '../opener';
import { closeTab, resetTabs, tabId } from '../tabs-store';
import { AsideWatcher } from './AsideWatcher';

const ONE = session('First');
const TWO = session('Second');
const ID = ONE.record.id;
let stage: AsideStage;
beforeEach(() => { stage = asideStage(); });
afterEach(cleanup);

describe('saved side questions as tabs', () => {
  it('restores free questions and explanations after restart without asking the provider', async () => {
    stage.chat(ONE).asides = [marker('a', 'Free question', null), marker('b', 'Explanation')];
    for (let launch = 0; launch < 2; launch += 1) {
      await stage.open([ONE, TWO], ONE, true);
      render(<AsideWatcher />);
      await stage.settle();
      expect(stage.tabs(ONE).map((tab) => [tab.reference, tab.title])).toEqual([['a', 'Free question'], ['b', 'Explanation']]);
      // Only the selected body reads content; restoration itself reads marker metadata alone.
      expect(stage.sent('chat:readAside')).toHaveLength(launch + 1);
      expect(stage.sent('chat:ask')).toEqual([]);
      expect(stage.sent('chat:removeAside')).toEqual([]);
      cleanup();
      resetTabs();
    }
  });

  it('keeps the selected tab and its draft, updates titles, and restores each session’s own questions', async () => {
    stage.chat(ONE).asking = CODEX_ASIDES;
    await stage.open([ONE, TWO], ONE, true);
    act(() => { openAside(ID, 'draft', null, true, 'Unsent text'); });
    render(<AsideWatcher />);
    stage.chat(ONE).asides = [marker('a', 'First title', null)];
    stage.changed(ONE);
    await stage.settle();
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['draft', 'a']);
    expect(document.activeElement).toHaveProperty('value', 'Unsent text');
    stage.chat(ONE).asides = [marker('a', 'Updated title', null)];
    stage.changed(ONE);
    await stage.settle();
    expect(stage.tabs(ONE)[1]?.title).toBe('Updated title');
    stage.chat(TWO).asides = [marker('b', 'Second session', null)];
    stage.show([ONE, TWO], TWO);
    await stage.settle();
    expect(stage.tabs(TWO).map((tab) => tab.reference)).toEqual(['b']);
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['draft', 'a']);
  });

  it('removes closed questions and their markers, then leaves them absent on the next read', async () => {
    stage.chat(ONE).asides = [marker('a', 'Explanation'), marker('b', 'Free question', null)];
    await stage.open([ONE], ONE, true);
    render(<AsideWatcher />);
    stage.remove = ({ asideId }) => {
      stage.chat(ONE).asides = stage.chat(ONE).asides.filter((entry) => entry.id !== asideId);
      stage.changed(ONE);
      return { status: 'removed' };
    };
    act(() => closeTab(ID, tabId(ASIDE_KIND, 'a')));
    await stage.settle();
    stage.changed(ONE);
    await stage.settle();
    expect(stage.tabs(ONE).map((tab) => tab.reference)).toEqual(['b']);
    expect(useAsides.getState().bySource).toEqual({});
  });
});
