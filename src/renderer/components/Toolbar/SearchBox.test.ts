// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => ({
  setQuery: vi.fn(async () => {}),
  next: vi.fn(),
  prev: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('../../hooks/usePdfSearch', () => ({
  usePdfSearch: () => search,
}));

import { SearchBox } from './SearchBox';
import { usePdfStore } from '../../store/pdf-store';

const renderSearchBox = () => render(React.createElement(SearchBox));

const searchBoxCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/components/Toolbar/SearchBox.module.css'),
    'utf8',
  );

/** Declarations of the first rule whose selector starts with `selector`. */
const cssRule = (selector: string): string =>
  searchBoxCss().match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`))?.[0] ?? '';

describe('SearchBox', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    usePdfStore.setState({
      pageCount: 120,
      searchOpen: true,
      searchQuery: '',
      searchMatches: [],
      currentMatchIndex: -1,
      searchIndexProgress: null,
    });
  });

  it('shows index progress in the count slot while the index builds', () => {
    usePdfStore.setState({ searchIndexProgress: { done: 40, total: 120 } });

    renderSearchBox();

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Indexing 40/120…');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // The match counter is not shown while indexing.
    expect(screen.queryByText('0/0')).toBeNull();
    // The input stays usable so the user can keep typing.
    expect(screen.getByLabelText('Search document')).toBeTruthy();
  });

  it('replaces progress with the match count once the index is ready', () => {
    usePdfStore.setState({ searchIndexProgress: { done: 40, total: 120 } });
    const { rerender } = renderSearchBox();
    expect(screen.getByRole('status').textContent).toBe('Indexing 40/120…');

    act(() => {
      usePdfStore.setState({
        searchIndexProgress: null,
        searchMatches: [
          { page: 1, begin: 0, length: 5 },
          { page: 2, begin: 3, length: 5 },
          { page: 9, begin: 1, length: 5 },
        ],
        currentMatchIndex: 1,
      });
    });
    rerender(React.createElement(SearchBox));

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('2/3');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('formats the idle counter as 0/0 with no matches', () => {
    renderSearchBox();
    expect(screen.getByRole('status').textContent).toBe('0/0');
    expect(screen.getByRole('button', { name: 'Next match' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Previous match' })).toHaveProperty('disabled', true);
  });

  it('closes the search box and cancels through clear()', () => {
    renderSearchBox();

    fireEvent.click(screen.getByRole('button', { name: 'Close search' }));

    expect(search.clear).toHaveBeenCalledTimes(1);
    expect(usePdfStore.getState().searchOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
  });

  it('opens the search box from the collapsed button', () => {
    usePdfStore.setState({ searchOpen: false });
    renderSearchBox();

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(usePdfStore.getState().searchOpen).toBe(true);
  });

  it('debounces typing before asking for matches', async () => {
    vi.useFakeTimers();
    renderSearchBox();

    fireEvent.change(screen.getByLabelText('Search document'), { target: { value: 'alpha' } });
    expect(search.setQuery).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(search.setQuery).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(search.setQuery).toHaveBeenCalledWith('alpha');
  });

  it('navigates matches with the arrow buttons and Enter/Shift+Enter', () => {
    usePdfStore.setState({
      searchMatches: [{ page: 1, begin: 0, length: 5 }],
      currentMatchIndex: 0,
    });
    renderSearchBox();

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(search.next).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(search.prev).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText('Search document');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(search.next).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(search.prev).toHaveBeenCalledTimes(2);
  });

  it('keeps every control mounted so the toolbar only ever shrinks the box', () => {
    usePdfStore.setState({ searchIndexProgress: { done: 40, total: 120 } });

    renderSearchBox();

    // The 1280px toolbar fix is CSS-only: nothing is conditionally unmounted,
    // so no search control can disappear instead of being laid out.
    expect(screen.getByLabelText('Search document')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close search' })).toBeTruthy();
  });

  it('is laid out to shrink inside one toolbar row', () => {
    // jsdom has no layout engine, so the contract that keeps the open search
    // box from overflowing the toolbar is asserted on the CSS itself.
    const box = cssRule('.searchBox');
    expect(box).toContain('flex: 0 1 auto');
    expect(box).toContain('min-width: 0');

    // The input is the only part that gives up width, down to a still-usable
    // field rather than squeezing the buttons out of the row.
    const input = cssRule('.input');
    expect(input).toMatch(/min-width:\s*48px/);
    expect(input).toMatch(/flex:\s*1 1 160px/);

    // Compact, fixed-size count slot and buttons: they must never shrink.
    expect(cssRule('.count')).toContain('flex: 0 0 auto');
    expect(cssRule('.button')).toContain('flex: 0 0 auto');
  });
});
