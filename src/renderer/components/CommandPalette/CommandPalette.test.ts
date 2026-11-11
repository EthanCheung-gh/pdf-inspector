// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listCommands,
  registerCommands,
  type CommandDefinition,
} from '../../services/command-registry';
import { usePdfStore } from '../../store/pdf-store';
import { useRegisterCommands } from '../../hooks/useRegisterCommands';

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn<(page: number) => Promise<void>>(),
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

import { CommandPalette } from './CommandPalette';

const cleanups: (() => void)[] = [];

const register = (owner: string, commands: CommandDefinition[]): void => {
  cleanups.push(registerCommands(owner, commands));
};

const makeCommand = (
  id: string,
  title: string,
  group: CommandDefinition['group'],
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title,
  group,
  run: vi.fn(),
  ...extra,
});

const openPalette = (): HTMLElement => {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  return screen.getByRole('dialog');
};

const searchBox = (): HTMLInputElement =>
  screen.getByRole('combobox', { name: 'Search commands' }) as HTMLInputElement;

beforeEach(() => {
  navigate.mockReset();
  navigate.mockResolvedValue(undefined);
  usePdfStore.setState({ pageCount: 5, currentPage: 3, isLoading: false });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  cleanup();
});

describe('CommandPalette', () => {
  it('opens with Ctrl/Cmd+K, focuses the search field and labels the dialog', () => {
    render(React.createElement(CommandPalette));

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(searchBox());
    expect(searchBox().getAttribute('aria-expanded')).toBe('true');
  });

  it('opens with Meta+K too', () => {
    render(React.createElement(CommandPalette));
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('opens even when an input has focus', () => {
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement('input', { 'aria-label': 'Other input' }),
        React.createElement(CommandPalette),
      ),
    );

    const other = screen.getByRole('textbox', { name: 'Other input' });
    other.focus();
    fireEvent.keyDown(other, { key: 'k', ctrlKey: true });

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    expect(document.activeElement).toBe(searchBox());
  });

  it('filters by title and keywords, case-insensitively', () => {
    register('palette-filter', [
      makeCommand('palette-filter.alpha', 'Alpha command', 'File', { keywords: ['first'] }),
      makeCommand('palette-filter.beta', 'Beta action', 'View', { keywords: ['second'] }),
    ]);
    render(React.createElement(CommandPalette));
    openPalette();

    fireEvent.change(searchBox(), { target: { value: 'GAMMA' } });
    expect(screen.queryByRole('option', { name: /Alpha command/ })).toBeNull();

    fireEvent.change(searchBox(), { target: { value: 'beta' } });
    expect(screen.getByRole('option', { name: /Beta action/ })).toBeTruthy();

    fireEvent.change(searchBox(), { target: { value: 'second' } });
    expect(screen.getByRole('option', { name: /Beta action/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Alpha command/ })).toBeNull();

    fireEvent.change(searchBox(), { target: { value: 'nothing-matches' } });
    expect(screen.getByText('No matching commands')).toBeTruthy();
  });

  it('moves with arrows past disabled rows and runs the active command with Enter', () => {
    const alphaRun = vi.fn();
    const betaRun = vi.fn();
    const gammaRun = vi.fn();
    register('palette-keys', [
      makeCommand('palette-keys.alpha', 'Alpha', 'File', { run: alphaRun, keywords: ['keysuite'] }),
      makeCommand('palette-keys.beta', 'Beta', 'View', {
        run: betaRun,
        keywords: ['keysuite'],
        isEnabled: () => false,
      }),
      makeCommand('palette-keys.gamma', 'Gamma', 'View', { run: gammaRun, keywords: ['keysuite'] }),
    ]);
    render(React.createElement(CommandPalette));
    openPalette();

    // Narrow to the three test commands so the built-in palette commands do
    // not sit between them in the sorted list.
    fireEvent.change(searchBox(), { target: { value: 'keysuite' } });

    const alpha = screen.getByRole('option', { name: 'Alpha' });
    const beta = screen.getByRole('option', { name: 'Beta' });
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(beta.getAttribute('aria-disabled')).toBe('true');

    fireEvent.keyDown(searchBox(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'Gamma' }).getAttribute('aria-selected')).toBe(
      'true',
    );

    fireEvent.keyDown(searchBox(), { key: 'Enter' });
    expect(gammaRun).toHaveBeenCalledTimes(1);
    expect(alphaRun).not.toHaveBeenCalled();
    expect(betaRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not run a disabled command on click', () => {
    const disabledRun = vi.fn();
    register('palette-disabled', [
      makeCommand('palette-disabled.off', 'Disabled action', 'View', {
        run: disabledRun,
        isEnabled: () => false,
      }),
    ]);
    render(React.createElement(CommandPalette));
    openPalette();

    const option = screen.getByRole('option', { name: 'Disabled action' });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(option);

    expect(disabledRun).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('runs on click and closes the palette', () => {
    const run = vi.fn();
    register('palette-click', [
      makeCommand('palette-click.run', 'Run me', 'File', { run }),
    ]);
    render(React.createElement(CommandPalette));
    openPalette();

    fireEvent.click(screen.getByRole('option', { name: 'Run me' }));

    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and on backdrop click', () => {
    render(React.createElement(CommandPalette));
    openPalette();

    fireEvent.keyDown(searchBox(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    openPalette();
    fireEvent.click(screen.getByTestId('command-palette-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the dropdown open when the backdrop itself was not clicked', () => {
    render(React.createElement(CommandPalette));
    const dialog = openPalette();

    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('reflects commands registered after the palette is open', () => {
    render(React.createElement(CommandPalette));
    openPalette();

    expect(screen.queryByRole('option', { name: 'Late command' })).toBeNull();
    act(() => {
      register('palette-late', [makeCommand('palette-late.cmd', 'Late command', 'File')]);
    });

    expect(screen.getByRole('option', { name: 'Late command' })).toBeTruthy();
  });

  it('enters page mode, clamps the number and navigates after closing', () => {
    render(React.createElement(CommandPalette));
    openPalette();

    fireEvent.click(screen.getByRole('option', { name: /Go to page/ }));

    const input = screen.getByRole('textbox', { name: 'Page number' }) as HTMLInputElement;
    expect(input.value).toBe('3');
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(navigate).toHaveBeenCalledWith(5);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clamps page numbers below one and ignores invalid input', () => {
    render(React.createElement(CommandPalette));
    openPalette();
    fireEvent.click(screen.getByRole('option', { name: /Go to page/ }));

    const input = screen.getByRole('textbox', { name: 'Page number' });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith(1);

    // Invalid input leaves the palette open and does not navigate.
    openPalette();
    fireEvent.click(screen.getByRole('option', { name: /Go to page/ }));
    const again = screen.getByRole('textbox', { name: 'Page number' });
    fireEvent.change(again, { target: { value: 'abc' } });
    fireEvent.keyDown(again, { key: 'Enter' });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('disables Go to page without a document and can go back to commands', () => {
    usePdfStore.setState({ pageCount: 0, currentPage: 1 });
    render(React.createElement(CommandPalette));
    openPalette();

    const option = screen.getByRole('option', { name: /Go to page/ });
    expect(option.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(option);
    expect(screen.getByRole('combobox')).toBeTruthy();

    act(() => {
      usePdfStore.setState({ pageCount: 5 });
    });
    expect(
      screen.getByRole('option', { name: /Go to page/ }).getAttribute('aria-disabled'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('option', { name: /Go to page/ }));
    fireEvent.click(screen.getByRole('button', { name: /Back to commands/ }));

    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('logs rejected command promises instead of failing the palette', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    register('palette-reject', [
      makeCommand('palette-reject.cmd', 'Rejecting command', 'File', {
        run: () => Promise.reject(new Error('boom')),
      }),
    ]);
    render(React.createElement(CommandPalette));
    openPalette();

    fireEvent.click(screen.getByRole('option', { name: 'Rejecting command' }));

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        'Command "palette-reject.cmd" failed:',
        expect.any(Error),
      ),
    );
    errorSpy.mockRestore();
  });

  it('unregisters hook commands on unmount', () => {
    const Host: React.FC = () => {
      useRegisterCommands('palette-host', [
        makeCommand('palette-host.cmd', 'Host command', 'File'),
      ]);
      return null;
    };

    const view = render(React.createElement(Host));
    expect(listCommands().some((entry) => entry.id === 'palette-host.cmd')).toBe(true);

    view.unmount();
    expect(listCommands().some((entry) => entry.id === 'palette-host.cmd')).toBe(false);
  });
});
