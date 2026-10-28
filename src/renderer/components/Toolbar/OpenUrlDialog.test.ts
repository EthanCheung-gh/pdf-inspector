// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfMetadata } from '../../types/pdf-objects';

const { openPdfUrl } = vi.hoisted(() => ({ openPdfUrl: vi.fn() }));

vi.mock('../../services/ipc-client', () => ({
  ipc: { openPdfUrl },
}));

import { OpenUrlDialog } from './OpenUrlDialog';
import type { OpenedFromUrl } from './OpenUrlDialog';

const metadata: PdfMetadata = {
  pages: 3,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

const opened: OpenedFromUrl = {
  canceled: false,
  path: '/tmp/download.pdf',
  metadata,
  sourceUrl: 'https://example.com/a.pdf',
};

type Props = {
  open: boolean;
  onClose: () => void;
  onOpened: (result: OpenedFromUrl) => void | Promise<void>;
};

function renderDialog(overrides: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onClose: vi.fn(),
    onOpened: vi.fn(),
    ...overrides,
  };
  render(React.createElement(OpenUrlDialog, props));
  return props;
}

function typeUrl(value: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
}

describe('OpenUrlDialog', () => {
  beforeEach(() => {
    openPdfUrl.mockReset();
  });

  afterEach(cleanup);

  it('renders nothing when closed', () => {
    renderDialog({ open: false });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps submit disabled while the input is empty', () => {
    renderDialog();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces errors through a single alert region without a redundant aria-live', () => {
    renderDialog();
    typeUrl('ftp://example.com/a.pdf');
    submit();

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('aria-live')).toBeNull();
    expect(alert.textContent).toBe('Only http(s) URLs are supported');

    // Editing clears the message so the next failure is a fresh announcement.
    typeUrl('https://example.com/a.pdf');
    expect(screen.getByRole('alert').textContent).toBe('');
  });

  it('focuses the URL input when opened', () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it.each(['ftp://example.com/a.pdf', 'file:///tmp/a.pdf'])(
    'rejects the unsupported URL %s without calling IPC',
    (url) => {
      renderDialog();
      typeUrl(url);
      submit();

      expect(screen.getByText('Only http(s) URLs are supported')).toBeTruthy();
      expect(openPdfUrl).not.toHaveBeenCalled();
    },
  );

  it.each(['not a url', 'example.com/a.pdf', '//example.com/a.pdf'])(
    'rejects the unparseable URL %s without calling IPC',
    (url) => {
      renderDialog();
      typeUrl(url);
      submit();

      expect(screen.getByText('Enter a valid http(s) URL')).toBeTruthy();
      expect(openPdfUrl).not.toHaveBeenCalled();
    },
  );

  it('submits the trimmed URL, awaits onOpened, then closes', async () => {
    const calls: string[] = [];
    const onOpened = vi.fn(async () => {
      calls.push('opened');
    });
    renderDialog({
      onOpened,
      onClose: () => {
        calls.push('closed');
      },
    });

    typeUrl('  https://example.com/a.pdf  ');

    openPdfUrl.mockImplementation(async () => {
      calls.push('ipc');
      return opened;
    });

    submit();

    await waitFor(() => expect(calls).toEqual(['ipc', 'opened', 'closed']));
    expect(openPdfUrl).toHaveBeenCalledTimes(1);
    expect(openPdfUrl).toHaveBeenCalledWith('https://example.com/a.pdf');
    expect(onOpened).toHaveBeenCalledWith(opened);
  });

  it('shows the IPC rejection message and stays open', async () => {
    renderDialog();
    typeUrl('https://example.com/missing.pdf');
    openPdfUrl.mockRejectedValue(new Error('Download failed: 404 Not Found'));

    submit();

    await waitFor(() => expect(screen.getByText('Download failed: 404 Not Found')).toBeTruthy());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('shows an onOpened failure message and stays open', async () => {
    const onClose = vi.fn();
    renderDialog({
      onClose,
      onOpened: () => {
        throw new Error('Could not display the document');
      },
    });
    typeUrl('https://example.com/a.pdf');
    openPdfUrl.mockResolvedValue(opened);

    submit();

    await waitFor(() => expect(screen.getByText('Could not display the document')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes on Escape while idle', () => {
    const props = renderDialog();

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape while busy, and disables the input', async () => {
    const props = renderDialog();
    typeUrl('https://example.com/a.pdf');

    let resolveOpen: (value: OpenedFromUrl) => void = () => {};
    openPdfUrl.mockImplementation(
      () => new Promise<OpenedFromUrl>((resolve) => {
        resolveOpen = resolve;
      }),
    );

    submit();

    await waitFor(() => expect(screen.getByText('Opening…')).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();

    resolveOpen(opened);
    await waitFor(() => expect(props.onOpened).toHaveBeenCalledWith(opened));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click but not on a click inside the card', () => {
    const props = renderDialog();
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement as HTMLElement;

    fireEvent.click(dialog);
    expect(props.onClose).not.toHaveBeenCalled();

    fireEvent.click(backdrop);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via Cancel', () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
