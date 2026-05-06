import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../src/components/SettingsPanel';
import type { UseExplorerConfig } from '../src/lib/client-config';

afterEach(() => {
  cleanup();
});

function makeCfg(overrides: Partial<UseExplorerConfig> = {}): UseExplorerConfig {
  return {
    mounted: true,
    config: {
      readerUrl: 'http://default-reader',
      posterUrl: 'http://default-poster',
      posterAuthToken: '',
      contentTags: [],
      pendingLimit: 50,
      submittedLimit: 50,
      batchesLimit: 50,
      messagesLimit: 50,
    },
    flags: {
      readerUrl: false,
      posterUrl: false,
      posterAuthToken: false,
      contentTags: false,
      limits: false,
    },
    rawOverrides: {},
    setOverride: vi.fn(),
    clearOverride: vi.fn(),
    resetAll: vi.fn(),
    ...overrides,
  };
}

describe('SettingsPanel', () => {
  it('renders a disabled placeholder when not mounted', () => {
    const cfg = makeCfg({ mounted: false });
    render(<SettingsPanel cfg={cfg} />);
    expect(screen.getByText('Settings').hasAttribute('disabled')).toBe(true);
  });

  it('opens and closes when toggle is clicked', () => {
    render(<SettingsPanel cfg={makeCfg()} />);
    expect(screen.queryByTestId('settings-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-toggle'));
    expect(screen.queryByTestId('settings-panel')).not.toBeNull();
    fireEvent.click(screen.getByTestId('settings-toggle'));
    expect(screen.queryByTestId('settings-panel')).toBeNull();
  });

  it('Apply with a value calls setOverride for each non-empty field', () => {
    const setOverride = vi.fn();
    const clearOverride = vi.fn();
    const cfg = makeCfg({ setOverride, clearOverride });
    render(<SettingsPanel cfg={cfg} />);

    fireEvent.click(screen.getByTestId('settings-toggle'));
    fireEvent.change(screen.getByTestId('settings-reader-url'), {
      target: { value: 'http://override-reader' },
    });
    fireEvent.click(screen.getByTestId('settings-apply'));

    expect(setOverride).toHaveBeenCalledWith('readerUrl', 'http://override-reader');
  });

  it('Apply with empty values calls clearOverride', () => {
    const setOverride = vi.fn();
    const clearOverride = vi.fn();
    const cfg = makeCfg({ setOverride, clearOverride });
    render(<SettingsPanel cfg={cfg} />);

    fireEvent.click(screen.getByTestId('settings-toggle'));
    fireEvent.click(screen.getByTestId('settings-apply'));

    expect(clearOverride).toHaveBeenCalledWith('readerUrl');
    expect(clearOverride).toHaveBeenCalledWith('posterUrl');
    expect(clearOverride).toHaveBeenCalledWith('posterAuthToken');
    expect(clearOverride).toHaveBeenCalledWith('contentTagsRaw');
    expect(setOverride).not.toHaveBeenCalled();
  });

  it('Reset calls resetAll', () => {
    const resetAll = vi.fn();
    const cfg = makeCfg({ resetAll });
    render(<SettingsPanel cfg={cfg} />);
    fireEvent.click(screen.getByTestId('settings-toggle'));
    fireEvent.click(screen.getByTestId('settings-reset'));
    expect(resetAll).toHaveBeenCalled();
  });

  it('shows an override flag next to each field whose flag is true', () => {
    const cfg = makeCfg({
      flags: {
        readerUrl: true,
        posterUrl: false,
        posterAuthToken: true,
        contentTags: false,
        limits: false,
      },
    });
    render(<SettingsPanel cfg={cfg} />);
    fireEvent.click(screen.getByTestId('settings-toggle'));
    const flags = screen.getAllByTestId('settings-override-flag');
    expect(flags.length).toBe(2);
  });

  it('seeds form fields from rawOverrides if present', () => {
    const cfg = makeCfg({
      rawOverrides: {
        readerUrl: 'http://stored-reader',
        posterAuthToken: 'stored-token',
      },
    });
    render(<SettingsPanel cfg={cfg} />);
    fireEvent.click(screen.getByTestId('settings-toggle'));
    expect((screen.getByTestId('settings-reader-url') as HTMLInputElement).value).toBe(
      'http://stored-reader'
    );
    expect((screen.getByTestId('settings-poster-token') as HTMLInputElement).value).toBe(
      'stored-token'
    );
  });

  it('shows the build-time default below each field', () => {
    const cfg = makeCfg({
      config: {
        ...makeCfg().config,
        readerUrl: 'http://baked-default',
      },
    });
    render(<SettingsPanel cfg={cfg} />);
    fireEvent.click(screen.getByTestId('settings-toggle'));
    expect(screen.getByText(/default: http:\/\/baked-default/)).toBeTruthy();
  });

  it('does not expose any "submit" or "flush" affordance', () => {
    render(<SettingsPanel cfg={makeCfg()} />);
    fireEvent.click(screen.getByTestId('settings-toggle'));
    const text = (screen.getByTestId('settings-panel').textContent ?? '').toLowerCase();
    expect(text).not.toContain('submit message');
    expect(text).not.toContain('flush');
  });
});
