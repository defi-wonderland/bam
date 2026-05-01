import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StatusBadge } from '../src/components/StatusBadge';

afterEach(cleanup);

describe('StatusBadge', () => {
  const kinds = ['ok', 'not_configured', 'unreachable', 'error'] as const;

  for (const kind of kinds) {
    it(`renders a distinct label and aria-label for kind=${kind}`, () => {
      const { container } = render(<StatusBadge kind={kind} />);
      const el = container.querySelector('[role="status"]');
      expect(el).not.toBeNull();
      expect(el?.getAttribute('aria-label')).toMatch(/^status: /);
    });
  }

  it('produces four distinct visible labels across the four kinds', () => {
    const labels = new Set<string>();
    for (const kind of kinds) {
      const { container } = render(<StatusBadge kind={kind} />);
      const el = container.querySelector('[role="status"]');
      labels.add(el?.textContent ?? '');
      cleanup();
    }
    expect(labels.size).toBe(4);
  });

  it('produces four distinct aria-labels across the four kinds', () => {
    const ariaLabels = new Set<string>();
    for (const kind of kinds) {
      render(<StatusBadge kind={kind} />);
      const el = screen.getByRole('status');
      ariaLabels.add(el.getAttribute('aria-label') ?? '');
      cleanup();
    }
    expect(ariaLabels.size).toBe(4);
  });
});
