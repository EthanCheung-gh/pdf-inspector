// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiffStore } from '../../store/diff-store';
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
      ignoreTypes: [],
      ignoreFonts: true,
      ignoreColors: true,
      ignoreImages: true,
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
