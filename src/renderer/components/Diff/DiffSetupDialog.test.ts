// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiffStore } from '../../store/diff-store';
import { useI18nStore } from '../../i18n';
import { makeSampleResult } from '../../services/__tests__/diff-fixtures';

const { pickDiffPdf, diffPdfs, saveFile } = vi.hoisted(() => ({
  pickDiffPdf: vi.fn(),
  diffPdfs: vi.fn(),
  saveFile: vi.fn(),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { pickDiffPdf, diffPdfs, saveFile },
}));

import { DiffSetupDialog } from './DiffSetupDialog';

const store = () => useDiffStore.getState();

function openDialog(): void {
  act(() => store().openSetup());
}

function compareButton(): HTMLElement {
  return within(screen.getByRole('dialog')).getByRole('button', { name: /Compare|Comparing/ });
}

beforeEach(() => {
  store().reset();
  // A Chinese test must not leak its locale into the English assertions.
  useI18nStore.setState({ locale: 'en' });
  pickDiffPdf.mockReset();
  diffPdfs.mockReset();
  saveFile.mockReset();
});

afterEach(cleanup);

describe('DiffSetupDialog picking', () => {
  it('stores each side from the picker and only then enables Compare', async () => {
    pickDiffPdf
      .mockResolvedValueOnce({ canceled: false, source: '/docs/old.pdf', name: 'old.pdf' })
      .mockResolvedValueOnce({ canceled: false, source: '/docs/new.pdf', name: 'new.pdf' });

    render(React.createElement(DiffSetupDialog));
    openDialog();
    expect(screen.getAllByText('No file selected')).toHaveLength(2);
    expect((compareButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Choose old PDF' }));
    await waitFor(() => expect(store().oldName).toBe('old.pdf'));
    expect(pickDiffPdf).toHaveBeenCalledWith('old');
    expect(screen.getByText('old.pdf')).toBeTruthy();
    expect((compareButton() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Choose new PDF' }));
    await waitFor(() => expect(store().newName).toBe('new.pdf'));
    expect(pickDiffPdf).toHaveBeenCalledWith('new');
    expect((compareButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('leaves the row untouched when the picker is cancelled', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    pickDiffPdf.mockResolvedValueOnce({ canceled: true });

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Choose old PDF' }));

    await waitFor(() => expect(pickDiffPdf).toHaveBeenCalled());
    expect(store().oldName).toBe('old.pdf');
    expect(screen.getByText('old.pdf')).toBeTruthy();
  });

  it('reports a picker failure and keeps the dialog usable', async () => {
    pickDiffPdf.mockRejectedValueOnce(new Error('No active window'));

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Choose old PDF' }));

    await waitFor(() =>
      expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toContain(
        'No active window',
      ),
    );
    expect((screen.getByRole('button', { name: 'Choose old PDF' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe('DiffSetupDialog character-level changes', () => {
  const characterToggle = (): HTMLInputElement =>
    screen.getByRole('checkbox', { name: 'Character-level changes' }) as HTMLInputElement;

  it('is unchecked by default and explains that word-level changes remain', () => {
    render(React.createElement(DiffSetupDialog));
    openDialog();

    expect(characterToggle().checked).toBe(false);
    expect(store().options.ignoreTypes).toEqual(['char']);
    expect(
      within(screen.getByRole('dialog')).getByText(/Word-level changes are always reported/),
    ).toBeTruthy();
  });

  it('removes only char from ignoreTypes when checked', () => {
    store().setOptions({ ignoreTypes: ['char', 'image'] });

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(characterToggle());

    expect(characterToggle().checked).toBe(true);
    expect(store().options.ignoreTypes).toEqual(['image']);
  });

  it('adds char back without dropping the other ignored types when unchecked', () => {
    store().setOptions({ ignoreTypes: ['char', 'table'] });

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(characterToggle()); // on
    expect(store().options.ignoreTypes).toEqual(['table']);

    fireEvent.click(characterToggle()); // off again
    expect(characterToggle().checked).toBe(false);
    expect(store().options.ignoreTypes).toEqual(['table', 'char']);
  });

  it('sends an explicit ignoreTypes: [] when character-level changes are on', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    diffPdfs.mockResolvedValueOnce(makeSampleResult());

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(characterToggle());
    fireEvent.click(compareButton());

    await waitFor(() => expect(store().active).toBe(true));
    expect(diffPdfs).toHaveBeenCalledWith(
      '/docs/old.pdf',
      '/docs/new.pdf',
      expect.objectContaining({ ignoreTypes: [] }),
    );
  });

  it('is disabled while a comparison is running', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    let resolveDiff: (value: unknown) => void = () => {};
    diffPdfs.mockReturnValueOnce(new Promise((resolve) => { resolveDiff = resolve; }));

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(compareButton());

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Comparing'));
    expect(characterToggle().disabled).toBe(true);

    resolveDiff(makeSampleResult());
    await waitFor(() => expect(store().active).toBe(true));
  });
});

describe('DiffSetupDialog compare', () => {
  it('diffs the chosen sources with the dialog options and opens the workspace', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    const result = makeSampleResult();
    diffPdfs.mockResolvedValueOnce(result);

    render(React.createElement(DiffSetupDialog));
    openDialog();

    fireEvent.change(screen.getByLabelText('Position tolerance'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore fonts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore colours' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ignore images' }));

    fireEvent.click(compareButton());

    await waitFor(() => expect(store().active).toBe(true));

    expect(diffPdfs).toHaveBeenCalledWith('/docs/old.pdf', '/docs/new.pdf', {
      positionTolerance: 2.5,
      textTolerance: 'normalized',
      // Character-level changes stay off: the dialog's checkbox was not toggled.
      ignoreTypes: ['char'],
      ignoreFonts: true,
      ignoreColors: true,
      ignoreImages: true,
      ignoreRegions: [],
    });
    expect(store().result).toBe(result);
    expect(store().setupOpen).toBe(false);
    expect(store().loading).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a failed comparison, clears the busy state and stays open', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    diffPdfs.mockRejectedValueOnce(new Error("Cannot read new PDF '/docs/new.pdf'"));

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(compareButton());

    await waitFor(() => expect(store().error).toContain('Cannot read new PDF'));
    expect(store().loading).toBe(false);
    expect(store().active).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Cannot read new PDF');
  });

  it('shows an indeterminate progress state while the diff runs', async () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');
    let resolveDiff: (value: unknown) => void = () => {};
    diffPdfs.mockReturnValueOnce(new Promise((resolve) => { resolveDiff = resolve; }));

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(compareButton());

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Comparing'));
    // The loading state also explains why a large pair takes a while; it stays
    // deliberately free of a fake percentage.
    expect(screen.getByRole('status').textContent).toContain(
      'Large PDFs can take several minutes; the comparison continues while pages make progress.',
    );

    resolveDiff(makeSampleResult());
    await waitFor(() => expect(store().active).toBe(true));
  });

  it('closes on Cancel and on Escape without running a diff', () => {
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');

    render(React.createElement(DiffSetupDialog));
    openDialog();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(store().setupOpen).toBe(false);

    openDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(store().setupOpen).toBe(false);
    expect(diffPdfs).not.toHaveBeenCalled();
  });
});

describe('DiffSetupDialog localization', () => {
  it('translates the title, pickers and engine options', () => {
    useI18nStore.setState({ locale: 'zh-CN' });

    render(React.createElement(DiffSetupDialog));
    openDialog();

    const dialog = screen.getByRole('dialog', { name: '比较 PDF' });
    expect(within(dialog).getAllByText('未选择文件')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: '选择旧 PDF' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '选择新 PDF' })).toBeTruthy();
    expect(within(dialog).getAllByText('选择…')).toHaveLength(2);
    expect(within(dialog).getByLabelText('位置容差')).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: '忽略字体' })).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: '忽略颜色' })).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: '忽略图片' })).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: '字符级变更' })).toBeTruthy();
    expect(within(dialog).getByText(/始终报告词级变更/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '比较' })).toBeTruthy();
  });

  it('switches back to English in place', () => {
    useI18nStore.setState({ locale: 'zh-CN' });

    render(React.createElement(DiffSetupDialog));
    openDialog();
    expect(screen.getByRole('dialog', { name: '比较 PDF' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('dialog', { name: 'Compare PDFs' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Compare' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Character-level changes' })).toBeTruthy();
  });
});

describe('DiffSetupDialog elapsed counter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows elapsed seconds beside the loading label and resets them', () => {
    vi.useFakeTimers();
    store().setSource('old', '/docs/old.pdf', 'old.pdf');
    store().setSource('new', '/docs/new.pdf', 'new.pdf');

    render(React.createElement(DiffSetupDialog));
    openDialog();

    act(() => store().setLoading(true));
    expect(screen.getByTestId('diff-elapsed').textContent).toBe('0s');

    act(() => {
      vi.advanceTimersByTime(42_000);
    });
    expect(screen.getByRole('status').textContent).toContain('Comparing documents… 42s');
    expect(screen.getByTestId('diff-elapsed').textContent).toBe('42s');
    // The large-file hint stays alongside the counter.
    expect(screen.getByRole('status').textContent).toContain(
      'Large PDFs can take several minutes',
    );

    // Leaving the loading state removes the counter...
    act(() => store().setLoading(false));
    expect(screen.queryByTestId('diff-elapsed')).toBeNull();

    // ...and the next run starts from zero instead of resuming.
    act(() => store().setLoading(true));
    expect(screen.getByTestId('diff-elapsed').textContent).toBe('0s');
  });
});
