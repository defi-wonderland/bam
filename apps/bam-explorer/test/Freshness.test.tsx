import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Freshness } from '../src/components/Freshness';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Freshness', () => {
  it('renders the freshness data-testid and the fetchedAt as a data attribute', () => {
    const fetchedAt = Date.now();
    render(<Freshness fetchedAt={fetchedAt} />);
    const el = screen.getByTestId('freshness');
    expect(el.getAttribute('data-fetched-at')).toBe(String(fetchedAt));
  });

  it('starts at "just now" and ticks forward', () => {
    const fetchedAt = Date.now();
    render(<Freshness fetchedAt={fetchedAt} />);
    expect(screen.getByTestId('freshness').textContent).toContain('just now');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    const text = screen.getByTestId('freshness').textContent ?? '';
    expect(text).toMatch(/\d+s ago/);
  });

  it('renders a minute-bucket label after enough time elapses', () => {
    const fetchedAt = Date.now();
    render(<Freshness fetchedAt={fetchedAt} />);
    act(() => {
      vi.advanceTimersByTime(125_000);
    });
    const text = screen.getByTestId('freshness').textContent ?? '';
    expect(text).toMatch(/m( \d+s)? ago/);
  });
});
