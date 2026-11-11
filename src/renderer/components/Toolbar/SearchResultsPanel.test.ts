// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchResultsPanel } from './SearchResultsPanel';
import { usePdfStore } from '../../store/pdf-store';
import { DEFAULT_SEARCH_OPTIONS, MAX_SEARCH_MATCHES } from '../../services/pdf-search';

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onSetOptions: ReturnType<typeof vi.fn>;
}

const renderPanel = (handlers: Partial<Handlers> = {}): Handlers => {
  const props: Handlers = {
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onSetOptions: vi.fn(),
    ...handlers,
  };
  render(
    React.createElement(SearchResultsPanel, {
      onSelect: props.onSelect,
      onClose: props.onClose,
      onSetOptions: props.onSetOptions,
    }),
  );
  return props;
};

const matches = [
  { page: 1, begin: 0, length: 5, preview: 'Hello World' },
  { page: 2, begin: 7, length: 5, preview: '…second hello…' },
  { page: 9, begin: 3, length: 5, preview: 'third hello' },
];

const panelCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/components/Toolbar/SearchResultsPanel.module.css'),
    'utf8',
  );

describe('SearchResultsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePdfStore.setState({
      searchOpen: true,
      searchQuery: 'hello',
      searchMatches: matches,
      currentMatchIndex: 1,
      searchIndexProgress: null,
      searchOptions: { ...DEFAULT_SEARCH_OPTIONS },
      searchResultsOpen: true,
      searchTruncated: false,
      searchError: null,
    });
  });

  afterEach(cleanup);

  it('lists every hit with its page and preview', () => {
    renderPanel();

    const rows = screen.getAllByRole('button', { name: /p\.\d/ });
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('p.1');
    expect(rows[0].textContent).toContain('Hello World');
    expect(rows[1].textContent).toContain('p.2');
    expect(rows[1].textContent).toContain('second hello');
    expect(rows[2].textContent).toContain('p.9');
  });

  it('marks only the current hit with aria-current', () => {
    renderPanel();

    const rows = screen.getAllByRole('button', { name: /p\.\d/ });
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true', null]);
  });

  it('falls back to the page offset when a hit has no preview', () => {
    usePdfStore.setState({ searchMatches: [{ page: 4, begin: 12, length: 3 }], currentMatchIndex: 0 });

    renderPanel();

    expect(screen.getByRole('button', { name: /p\.4/ }).textContent).toContain('Match at 13');
  });

  it('selects a hit and closes the list from a row click', () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getAllByRole('button', { name: /p\.\d/ })[2]);

    expect(handlers.onSelect).toHaveBeenCalledWith(2);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles Aa / W / .* through onSetOptions and reflects the store', () => {
    usePdfStore.setState({ searchOptions: { ...DEFAULT_SEARCH_OPTIONS, wholeWord: true } });
    const handlers = renderPanel();

    const matchCase = screen.getByRole('button', { name: 'Match case' });
    const wholeWord = screen.getByRole('button', { name: 'Whole word' });
    const regex = screen.getByRole('button', { name: 'Regular expression' });

    expect(matchCase.getAttribute('aria-pressed')).toBe('false');
    expect(wholeWord.getAttribute('aria-pressed')).toBe('true');
    expect(regex.getAttribute('aria-pressed')).toBe('false');
    // The visible glyphs match the plan: Aa / W / .*
    expect(matchCase.textContent).toBe('Aa');
    expect(wholeWord.textContent).toBe('W');
    expect(regex.textContent).toBe('.*');

    fireEvent.click(matchCase);
    expect(handlers.onSetOptions).toHaveBeenCalledWith({ caseSensitive: true });

    fireEvent.click(wholeWord);
    expect(handlers.onSetOptions).toHaveBeenCalledWith({ wholeWord: false });

    fireEvent.click(regex);
    expect(handlers.onSetOptions).toHaveBeenCalledWith({ regex: true });
    // Toggling never closes the panel: options re-run against the cached index.
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('closes from the header button', () => {
    const handlers = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Close results' }));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error instead of a hit list', () => {
    usePdfStore.setState({
      searchMatches: [],
      currentMatchIndex: -1,
      searchError: 'Invalid regular expression: ( (Unterminated group)',
    });

    renderPanel();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Invalid regular expression');
    expect(screen.queryByRole('button', { name: /p\.\d/ })).toBeNull();
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('shows "No matches" for an empty result set', () => {
    usePdfStore.setState({ searchMatches: [], currentMatchIndex: -1 });

    renderPanel();

    expect(screen.getByText('No matches')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports index progress while the text index builds', () => {
    usePdfStore.setState({
      searchMatches: [],
      currentMatchIndex: -1,
      searchIndexProgress: { done: 40, total: 120 },
    });

    renderPanel();

    expect(screen.getByText('Indexing 40/120…')).toBeTruthy();
    // Progress is not the same thing as "nothing matched".
    expect(screen.queryByText('No matches')).toBeNull();
  });

  it('explains a truncated hit list', () => {
    usePdfStore.setState({ searchTruncated: true });

    renderPanel();

    expect(screen.getByText(`Showing first ${MAX_SEARCH_MATCHES.toLocaleString('en-US')} matches`)).toBeTruthy();
  });

  it('moves the current hit with ArrowDown / ArrowUp, wrapping at the ends', () => {
    const handlers = renderPanel();
    const panel = screen.getByRole('dialog', { name: 'Search results' });

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith(2);

    act(() => {
      usePdfStore.setState({ currentMatchIndex: 2 });
    });
    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith(1);
  });

  it('starts from the first/last hit when none is current yet', () => {
    usePdfStore.setState({ currentMatchIndex: -1 });
    const handlers = renderPanel();
    const panel = screen.getByRole('dialog', { name: 'Search results' });

    fireEvent.keyDown(panel, { key: 'ArrowDown' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(panel, { key: 'ArrowUp' });
    expect(handlers.onSelect).toHaveBeenLastCalledWith(2);
  });

  it('does not swallow arrow keys when there is nothing to select', () => {
    usePdfStore.setState({ searchMatches: [], currentMatchIndex: -1 });
    const handlers = renderPanel();
    const panel = screen.getByRole('dialog', { name: 'Search results' });

    fireEvent.keyDown(panel, { key: 'ArrowDown' });

    expect(handlers.onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape and keeps the app-level handler out of it', () => {
    const handlers = renderPanel();
    const appEscape = vi.fn();
    window.addEventListener('keydown', appEscape);

    try {
      fireEvent.keyDown(screen.getByRole('dialog', { name: 'Search results' }), { key: 'Escape' });
    } finally {
      window.removeEventListener('keydown', appEscape);
    }

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onSelect).not.toHaveBeenCalled();
    // The panel stops propagation so Escape does not also clear the selection.
    expect(appEscape).not.toHaveBeenCalled();
  });

  it('scrolls the current hit into view and tolerates a missing scrollIntoView', () => {
    // jsdom does not implement scrollIntoView; the first pass proves the guard.
    expect(() => renderPanel()).not.toThrow();
    cleanup();

    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderPanel();
      expect(scrollIntoView).toHaveBeenCalled();

      scrollIntoView.mockClear();
      act(() => {
        usePdfStore.setState({ currentMatchIndex: 2 });
      });
      expect(scrollIntoView).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('is a capped, scrollable popover with content-visibility rows', () => {
    // jsdom has no layout, so the popover contract is asserted on the CSS.
    const css = panelCss();
    const rule = (selector: string): string =>
      css.match(new RegExp(`\\${selector} \\{[^}]*\\}`))?.[0] ?? '';

    expect(rule('.panel')).toContain('position: absolute');
    expect(rule('.panel')).toMatch(/max-height:\s*50vh/);
    expect(rule('.panel')).toMatch(/max-width:\s*calc\(100vw - 24px\)/);
    expect(rule('.panel')).toContain('z-index:');
    expect(rule('.body')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.row')).toContain('content-visibility: auto');
  });
});
