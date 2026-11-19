// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactAction, ArtifactBar, ArtifactInformation } from './ArtifactBar';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('artifact controls', () => {
  it('announces copy success and failure, and clears feedback after two seconds', async () => {
    vi.useFakeTimers();
    const copy = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private failure'));
    render(<ArtifactBar label="Text file"><ArtifactAction kind="copy" label="Copy entire text" action={copy} /></ArtifactBar>);
    const button = screen.getByRole('button', { name: 'Copy entire text' });
    await act(async () => { fireEvent.click(button); await Promise.resolve(); });
    expect(screen.getByRole('status').textContent).toBe('Copied.');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => { fireEvent.click(button); await Promise.resolve(); });
    expect(screen.getByRole('status').textContent).toBe('Could not copy.');
    expect(document.body.textContent).not.toContain('private failure');
  });

  it('keeps unavailable actions disabled and reports a failed folder action', async () => {
    const copy = vi.fn();
    render(<ArtifactBar label="Image"><ArtifactAction kind="copy" label="Copy image" disabled action={copy} /><ArtifactAction kind="folder" label="Show in folder" action={() => Promise.reject(new Error('private path'))} /></ArtifactBar>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }));
    expect(copy).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show in folder' })); await Promise.resolve(); });
    expect(screen.getAllByRole('status').map((status) => status.textContent)).toContain('Could not show in folder.');
  });

  it('describes the information icon on hover or keyboard focus and dismisses with Escape', () => {
    render(<ArtifactInformation label="Plan information">Created yesterday by a model.</ArtifactInformation>);
    const button = screen.getByRole('button', { name: 'Plan information' });
    const tip = screen.getByRole('tooltip');
    expect(button.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.pointerEnter(button);
    expect(tip.getAttribute('data-open')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tip.hasAttribute('data-open')).toBe(false);
    fireEvent.pointerLeave(button);
    fireEvent.focus(button);
    expect(tip.getAttribute('data-open')).toBe('true');
  });
});
