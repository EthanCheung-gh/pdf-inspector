// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import type { FontStat } from '../../types/ipc-protocol';
import type { FontInfo, PdfMetadata } from '../../types/pdf-objects';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

vi.mock('../../services/ipc-client', () => ({
  ipc: { analyzeFonts: vi.fn(), extractPage: vi.fn() },
}));

import { ipc } from '../../services/ipc-client';
import { FontsTab } from './FontsTab';

const font: FontStat = {
  fontname: 'Helvetica',
  pages: [1],
  charCount: 42,
  sizeMin: 10,
  sizeMax: 14,
  colors: ['#000000'],
};

const otherFont: FontStat = {
  fontname: 'Times-Roman',
  pages: [1, 2],
  charCount: 7,
  sizeMin: 8,
  sizeMax: 9,
  colors: ['#111111'],
};

const embeddedStat: FontStat = {
  fontname: 'ABCDEF+Inter',
  pages: [1],
  charCount: 10,
  sizeMin: 9,
  sizeMax: 9,
  colors: ['#000000'],
};

const customStat: FontStat = {
  fontname: 'CustomSans',
  pages: [2],
  charCount: 5,
  sizeMin: 10,
  sizeMax: 10,
  colors: ['#000000'],
};

const baseMetadata: PdfMetadata = {
  pages: 10,
  version: '1.7',
  encrypted: false,
  page_w: 612,
  page_h: 792,
  title: '',
  author: '',
  producer: '',
  fonts: [],
};

/** Standard 14: no font file, so no descriptor-backed embedding. */
const helveticaInfo: FontInfo = {
  fontname: 'Helvetica',
  subtype: 'Type1',
  embedded: false,
  embedding: 'standard14',
  subset: false,
  encoding: 'WinAnsiEncoding',
  hasToUnicode: false,
  fontFileType: null,
};

/** Embedded Type0 subset with a CFF font program. */
const interInfo: FontInfo = {
  fontname: 'ABCDEF+Inter',
  subtype: 'Type0',
  embedded: true,
  embedding: 'embedded',
  subset: true,
  encoding: 'Identity-H',
  hasToUnicode: true,
  fontFileType: 'CFF',
};

const notEmbeddedInfo: FontInfo = {
  fontname: 'CustomSans',
  subtype: 'Type3',
  embedded: false,
  embedding: 'not-embedded',
  subset: false,
  encoding: null,
  hasToUnicode: false,
  fontFileType: null,
};

function metadataWithFontInfo(fontInfo: FontInfo[]): PdfMetadata {
  return { ...baseMetadata, fonts: fontInfo.map((info) => info.fontname), fontInfo };
}

type FontsResponse = { fonts: FontStat[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Drains the sequential batch chain (one microtask per await and merge). */
async function flush(runs = 12): Promise<void> {
  await act(async () => {
    for (let i = 0; i < runs; i += 1) await Promise.resolve();
  });
}

/** One stat per requested range, keyed to the range's first page. */
function statPerRange(charCount: number, fontname = 'Helvetica') {
  return async (startPage?: number, _endPage?: number): Promise<FontsResponse> => {
    const page = startPage ?? 1;
    return {
      fonts: [{ fontname, pages: [page], charCount, sizeMin: 10, sizeMax: 12, colors: ['#000000'] }],
    };
  };
}

beforeEach(() => {
  // reset (not just clear) so a mockImplementation from one test cannot leak
  // into the next one's later batches.
  vi.resetAllMocks();
  useI18nStore.setState({ locale: 'en' });
  usePdfStore.setState({
    filePath: '/tmp/test.pdf',
    metadata: null,
    pageCount: 25,
    fontStats: null,
    fontProgress: null,
    isLoading: false,
    error: null,
    filterCriteria: {},
  });
  useWorkspaceStore.setState({ inspectorTab: 'inspect' });
});

afterEach(cleanup);

describe('FontsTab', () => {

  it('analyzes the document in 10-page batches and merges the results', async () => {
    vi.mocked(ipc.analyzeFonts).mockImplementation(statPerRange(7));
    render(React.createElement(FontsTab));

    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [1, 11, 21], charCount: 21, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
    ]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
    expect(screen.getByText('Helvetica')).toBeTruthy();
  });

  it('shows progress between batches and the list once done', async () => {
    usePdfStore.setState({ pageCount: 20 });
    const batches: Array<ReturnType<typeof deferred<FontsResponse>>> = [];
    vi.mocked(ipc.analyzeFonts).mockImplementation(() => {
      const pending = deferred<FontsResponse>();
      batches.push(pending);
      return pending.promise;
    });

    render(React.createElement(FontsTab));

    expect(batches).toHaveLength(1);
    expect(screen.getByText('Analyzing fonts… 0/20 pages')).toBeTruthy();
    expect(screen.getByLabelText('Font analysis progress')).toBeTruthy();

    await act(async () => {
      batches[0].resolve({ fonts: [font] });
      await batches[0].promise;
    });
    await flush(2);

    expect(batches).toHaveLength(2);
    expect(screen.getByText('Analyzing fonts… 10/20 pages')).toBeTruthy();
    expect(usePdfStore.getState().fontProgress).toEqual({ done: 10, total: 20 });
    expect(usePdfStore.getState().fontStats).toBeNull();

    await act(async () => {
      batches[1].resolve({ fonts: [otherFont] });
      await batches[1].promise;
    });
    await flush(2);

    expect(usePdfStore.getState().fontStats).toEqual([font, otherFont]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
    expect(screen.getByText('Helvetica')).toBeTruthy();
    expect(screen.getByText('Times-Roman')).toBeTruthy();
    expect(screen.queryByText('Analyzing fonts… 20/20 pages')).toBeNull();
  });

  it('surfaces a failed batch and restarts from the first page on retry', async () => {
    vi.mocked(ipc.analyzeFonts)
      .mockRejectedValueOnce(new Error('sidecar exploded'))
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('sidecar exploded')).toBeTruthy();
    expect(usePdfStore.getState().error).toBe('Failed to analyze fonts. Please try again.');
    expect(usePdfStore.getState().fontStats).toBeNull();
    // The failed run released its progress and its request slot.
    expect(usePdfStore.getState().fontProgress).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.queryByText('sidecar exploded')).toBeNull();
    expect(usePdfStore.getState().error).toBeNull();

    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [1, 11, 21], charCount: 12, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
    ]);
  });

  it('discards a pending result when the document changes and analyzes the new one from page 1', async () => {
    const first = deferred<FontsResponse>();
    const second = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 10]]);

    act(() => { usePdfStore.setState({ filePath: '/tmp/other.pdf' }); });

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [1, 10],
    ]);

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });
    await flush(2);

    // The superseded document never publishes, and its progress is gone.
    expect(usePdfStore.getState().fontStats).toBeNull();
    expect(usePdfStore.getState().fontProgress).toEqual({ done: 0, total: 25 });

    await act(async () => {
      second.resolve({ fonts: [otherFont] });
      await second.promise;
    });
    await flush();

    // Only the new document's batches contribute: the old [font] (42 chars on
    // page 1) never lands.
    expect(usePdfStore.getState().fontStats).toEqual([
      { fontname: 'Helvetica', pages: [11, 21], charCount: 8, sizeMin: 10, sizeMax: 12, colors: ['#000000'] },
      { ...otherFont },
    ]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
  });

  it('keeps a single run in flight across navigation loading changes', async () => {
    const first = deferred<FontsResponse>();
    const second = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    // Navigation toggles isLoading while a batch is still pending.
    act(() => { usePdfStore.setState({ isLoading: true }); });
    act(() => { usePdfStore.setState({ isLoading: false }); });
    act(() => { usePdfStore.setState({ error: 'stale error' }); });

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });
    await flush(2);

    // The run continued into the next batch instead of restarting.
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ipc.analyzeFonts).mock.calls[1]).toEqual([11, 20]);

    act(() => { usePdfStore.setState({ isLoading: true }); });
    act(() => { usePdfStore.setState({ isLoading: false }); });
    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ fonts: [otherFont] });
      await second.promise;
    });
    await flush();

    expect(ipc.analyzeFonts).toHaveBeenCalledTimes(3);
    expect(vi.mocked(ipc.analyzeFonts).mock.calls[2]).toEqual([21, 25]);
    expect(usePdfStore.getState().fontStats).not.toBeNull();
    expect(usePdfStore.getState().error).toBeNull();
  });

  it('does not restart the analysis when metadata font info arrives in flight', async () => {
    const first = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts)
      .mockReturnValueOnce(first.promise)
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 10]]);

    // The resource-dictionary font info comes with the metadata, independently
    // of the batched char analysis, and may land while a batch is pending.
    act(() => { usePdfStore.setState({ metadata: metadataWithFontInfo([helveticaInfo, interInfo]) }); });
    act(() => { usePdfStore.setState({ metadata: metadataWithFontInfo([helveticaInfo]) }); });

    // Metadata is deliberately absent from the effect deps: no new request and
    // no restart at page 1 while the first batch is in flight.
    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 10]]);
    expect(usePdfStore.getState().fontProgress).toEqual({ done: 0, total: 25 });

    await act(async () => {
      first.resolve({ fonts: [font] });
      await first.promise;
    });
    await flush();

    // The same run continued with the remaining batches.
    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([
      [1, 10],
      [11, 20],
      [21, 25],
    ]);
    expect(usePdfStore.getState().fontStats).not.toBeNull();
    // The late font info is still applied to the finished rows.
    expect(screen.getByText('Standard 14')).toBeTruthy();
  });

  it('reports when the document has no text fonts', async () => {
    usePdfStore.setState({ pageCount: 5 });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [] });

    render(React.createElement(FontsTab));
    await flush();

    expect(vi.mocked(ipc.analyzeFonts).mock.calls).toEqual([[1, 5]]);
    expect(screen.getByText('No text fonts detected in this document.')).toBeTruthy();
    expect(usePdfStore.getState().fontStats).toEqual([]);
    expect(usePdfStore.getState().fontProgress).toBeNull();
  });

  it('navigates to the first page of a font and applies the font filter', async () => {
    usePdfStore.setState({ pageCount: 10 });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [{ ...font, pages: [3, 4] }] });

    render(React.createElement(FontsTab));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Helvetica/ }));
    await flush(2);

    expect(navigate).toHaveBeenCalledWith(3);
    expect(usePdfStore.getState().filterCriteria).toEqual({ fontname: 'Helvetica', types: ['char'] });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('filter');
  });

  it('joins the analyzed fonts with metadata font info and badges each row', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([helveticaInfo, interInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({
      fonts: [font, embeddedStat, customStat],
    });

    render(React.createElement(FontsTab));
    await flush();

    // Standard 14 + Type1 for Helvetica.
    expect(screen.getByText('Standard 14')).toBeTruthy();
    expect(screen.getByText('Type1')).toBeTruthy();
    // Embedded subset: the subset tag outranks the raw subtype in the row.
    expect(screen.getByText('Embedded')).toBeTruthy();
    expect(screen.getByText('Subset')).toBeTruthy();
    // No resource info for this font: fall back to Unknown instead of crashing.
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('summarizes the font count and warns about non-embedded fonts', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([helveticaInfo, interInfo, notEmbeddedInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({
      fonts: [font, embeddedStat, customStat],
    });

    render(React.createElement(FontsTab));
    await flush();

    // One Standard 14 font is named separately from the one that is missing.
    const summary = screen.getByText('3 fonts · 1 not embedded · 1 standard 14');
    expect(summary.parentElement?.className).toContain('summaryWarning');
    expect(screen.getByText('Not embedded')).toBeTruthy();
    expect(screen.getByText('Standard 14')).toBeTruthy();
  });

  it('counts Standard 14 fonts instead of reporting them as not embedded', async () => {
    const standardNames = [
      'Helvetica',
      'Helvetica-Bold',
      'Helvetica-Oblique',
      'Times-Roman',
      'Times-Bold',
      'Courier',
      'Symbol',
      'ZapfDingbats',
    ];
    const stats: FontStat[] = standardNames.map((fontname) => ({
      fontname,
      pages: [1],
      charCount: 3,
      sizeMin: 10,
      sizeMax: 10,
      colors: ['#000000'],
    }));
    const infos: FontInfo[] = standardNames.map((fontname) => ({
      ...helveticaInfo,
      fontname,
    }));

    usePdfStore.setState({ pageCount: 10, metadata: metadataWithFontInfo(infos) });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: stats });

    render(React.createElement(FontsTab));
    await flush();

    const summary = screen.getByText('8 fonts · 0 not embedded · 8 standard 14');
    // Standard 14 is not a warning: nothing is missing from the document.
    expect(summary.parentElement?.className).not.toContain('summaryWarning');
    expect(screen.getAllByText('Standard 14')).toHaveLength(8);
    expect(screen.queryByText('Not embedded')).toBeNull();
  });

  it('keeps the plain two-part summary when no font is Standard 14', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([interInfo, notEmbeddedInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [embeddedStat, customStat] });

    render(React.createElement(FontsTab));
    await flush();

    const summary = screen.getByText('2 fonts · 1 not embedded');
    expect(summary.parentElement?.className).toContain('summaryWarning');
    expect(screen.queryByText(/standard 14/)).toBeNull();
  });

  it('shows no summary when the metadata carries no font info', async () => {
    usePdfStore.setState({ pageCount: 10, metadata: null });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [font, otherFont] });

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.queryByText(/not embedded/)).toBeNull();
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });

  it('expands font details without navigating or filtering', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([helveticaInfo, interInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [font, embeddedStat] });

    render(React.createElement(FontsTab));
    await flush();

    const toggles = screen.getAllByRole('button', { name: 'Font details' });
    expect(toggles).toHaveLength(2);
    expect(toggles[1].getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggles[1]);
    await flush(2);

    expect(toggles[1].getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Identity-H')).toBeTruthy();
    expect(screen.getByText('Type0')).toBeTruthy();
    expect(screen.getByText('CFF')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(usePdfStore.getState().filterCriteria).toEqual({});
    expect(useWorkspaceStore.getState().inspectorTab).toBe('inspect');

    fireEvent.click(toggles[1]);
    await flush(2);

    expect(toggles[1].getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Identity-H')).toBeNull();
  });

  it('keeps the row click working while another font details are expanded', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([helveticaInfo, interInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({
      fonts: [{ ...font, pages: [3, 4] }, embeddedStat],
    });

    render(React.createElement(FontsTab));
    await flush();

    // Expand the second font: its details must not navigate or filter.
    fireEvent.click(screen.getAllByRole('button', { name: 'Font details' })[1]);
    await flush(2);
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Helvetica/ }));
    await flush(2);

    expect(navigate).toHaveBeenCalledWith(3);
    expect(usePdfStore.getState().filterCriteria).toEqual({ fontname: 'Helvetica', types: ['char'] });
    expect(useWorkspaceStore.getState().inspectorTab).toBe('filter');
  });
});

describe('FontsTab localization', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
  });

  it('translates the empty states and the progress line', async () => {
    usePdfStore.setState({ filePath: null });
    render(React.createElement(FontsTab));
    expect(screen.getByText('打开 PDF 以分析字体。')).toBeTruthy();

    cleanup();

    usePdfStore.setState({ filePath: '/tmp/test.pdf', pageCount: 20 });
    const pending = deferred<FontsResponse>();
    vi.mocked(ipc.analyzeFonts).mockReturnValue(pending.promise);

    render(React.createElement(FontsTab));

    expect(screen.getByText('正在分析字体… 0/20 页')).toBeTruthy();
    expect(screen.getByLabelText('字体分析进度')).toBeTruthy();
  });

  it('translates the no-fonts message', async () => {
    usePdfStore.setState({ pageCount: 5 });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [] });

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('此文档未检测到文本字体。')).toBeTruthy();
  });

  it('translates the analysis failure and the retry control', async () => {
    vi.mocked(ipc.analyzeFonts)
      .mockRejectedValueOnce(new Error('sidecar exploded'))
      .mockImplementation(statPerRange(4));

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('sidecar exploded')).toBeTruthy();
    expect(usePdfStore.getState().error).toBe('字体分析失败，请重试。');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(screen.queryByText('sidecar exploded')).toBeNull();
    await flush();

    expect(screen.getByText('Helvetica')).toBeTruthy();
  });

  it('translates badges, row counts, the summary and the details headings', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([helveticaInfo, interInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({
      fonts: [font, embeddedStat, customStat],
    });

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('标准 14')).toBeTruthy();
    expect(screen.getByText('Type1')).toBeTruthy();
    expect(screen.getByText('已嵌入')).toBeTruthy();
    expect(screen.getByText('子集')).toBeTruthy();
    // No resource info for this font: the badge falls back to Unknown.
    expect(screen.getByText('未知')).toBeTruthy();

    // Counts keep the same numbers, only the copy is localized.
    expect(screen.getByText('3 个字体 · 0 个未嵌入 · 1 个标准 14')).toBeTruthy();
    expect(screen.getByText('1 页 · 42 字符 · 10–14pt')).toBeTruthy();

    const toggles = screen.getAllByRole('button', { name: '字体详情' });
    expect(toggles).toHaveLength(3);
    expect(toggles[1].getAttribute('title')).toBe('展开字体详情');

    fireEvent.click(toggles[1]);
    await flush(2);

    expect(toggles[1].getAttribute('title')).toBe('收起字体详情');
    expect(screen.getByText('嵌入')).toBeTruthy();
    expect(screen.getByText('编码')).toBeTruthy();
    expect(screen.getByText('字体文件')).toBeTruthy();
    // Schema values stay as reported.
    expect(screen.getByText('Identity-H')).toBeTruthy();
    expect(screen.getByText('CFF')).toBeTruthy();
    // Subset and ToUnicode are both affirmative for this font.
    expect(screen.getAllByText('是')).toHaveLength(2);
  });

  it('translates the not-embedded summary and badge', async () => {
    usePdfStore.setState({
      pageCount: 10,
      metadata: metadataWithFontInfo([interInfo, notEmbeddedInfo]),
    });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [embeddedStat, customStat] });

    render(React.createElement(FontsTab));
    await flush();

    expect(screen.getByText('2 个字体 · 1 个未嵌入')).toBeTruthy();
    expect(screen.getByText('未嵌入')).toBeTruthy();
  });

  it('returns to English without a reload', async () => {
    usePdfStore.setState({ pageCount: 10, metadata: metadataWithFontInfo([helveticaInfo]) });
    vi.mocked(ipc.analyzeFonts).mockResolvedValue({ fonts: [font] });

    render(React.createElement(FontsTab));
    await flush();
    expect(screen.getByText('标准 14')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Standard 14')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Font details' })).toBeTruthy();
  });
});
