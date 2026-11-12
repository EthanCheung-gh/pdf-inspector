// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n';
import { useAnnotationStore } from '../../store/annotation-store';
import { usePdfStore } from '../../store/pdf-store';
import type { AnnotationForm, PdfAnnotation } from '../../types/annotations';

const { navigate, openExternalUrl } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openExternalUrl: vi.fn(),
}));

vi.mock('../../hooks/usePageNavigation', () => ({
  usePageNavigation: () => ({ navigate }),
}));

vi.mock('../../services/external-link', () => ({
  openExternalUrl,
}));

import { AnnotationDetails, UNSAFE_TARGET_WARNING } from './AnnotationDetails';

function makeAnnotation(overrides: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    id: '1:annotation',
    page: 1,
    subtype: 'Link',
    kind: 'link',
    rect: { x0: 0, y0: 0, x1: 10, y1: 20 },
    title: null,
    contents: null,
    modificationDate: null,
    color: null,
    opacity: null,
    hidden: false,
    link: null,
    form: null,
    ...overrides,
  };
}

function makeForm(overrides: Partial<AnnotationForm> = {}): AnnotationForm {
  return {
    fieldName: null,
    fieldType: null,
    value: null,
    defaultValue: null,
    readOnly: false,
    required: false,
    checkBox: false,
    radioButton: false,
    pushButton: false,
    multiLine: false,
    combo: false,
    options: [],
    ...overrides,
  };
}

const renderDetails = (annotation: PdfAnnotation): ReturnType<typeof render> =>
  render(React.createElement(AnnotationDetails, { annotation }));

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('AnnotationDetails', () => {
  afterEach(cleanup);

  beforeEach(() => {
    navigate.mockReset();
    openExternalUrl.mockReset();
    openExternalUrl.mockResolvedValue({ ok: true });
    useAnnotationStore.setState({ selected: null });
    usePdfStore.setState({ error: null });
  });

  it('shows the kind, subtype, page, rect and annotation content', () => {
    renderDetails(
      makeAnnotation({
        page: 2,
        subtype: 'FreeText',
        kind: 'note',
        rect: { x0: 1, y0: 2, x1: 3, y1: 4 },
        title: 'Pinned remark',
        contents: 'Remember this paragraph',
        modificationDate: '2024-01-02T03:04:05.000Z',
        color: '#ff0000',
        opacity: 0.5,
        hidden: true,
      }),
    );

    // The badge carries the broad kind label; the subtype keeps its raw name.
    expect(screen.getByText('Note')).toBeTruthy();
    expect(screen.getByText('Free Text')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('1, 2 → 3, 4')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();
    expect(screen.getByText('Pinned remark')).toBeTruthy();
    expect(screen.getByText('Remember this paragraph')).toBeTruthy();
    expect(screen.getByText('2024-01-02T03:04:05.000Z')).toBeTruthy();
    expect(screen.getByText('#ff0000')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('opens a safe external link only after an explicit click', async () => {
    renderDetails(
      makeAnnotation({
        link: {
          url: 'https://example.com/docs',
          unsafeUrl: 'https://example.com/docs',
          internalPage: null,
          newWindow: false,
        },
      }),
    );

    expect(screen.getByText('https://example.com/docs')).toBeTruthy();
    expect(openExternalUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));

    await waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/docs'),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an unsafe target display-only and disables the action', () => {
    renderDetails(
      makeAnnotation({
        link: {
          url: null,
          unsafeUrl: 'javascript:alert(1)',
          internalPage: null,
          newWindow: false,
        },
      }),
    );

    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();
    expect(screen.getByText(UNSAFE_TARGET_WARNING)).toBeTruthy();
    const openLink = screen.getByRole('button', { name: 'Open link' }) as HTMLButtonElement;
    expect(openLink.disabled).toBe(true);

    fireEvent.click(openLink);
    expect(openExternalUrl).not.toHaveBeenCalled();
    // Unsafe is not the same as unresolved: the raw target is still shown.
    expect(screen.queryByText('No resolvable link target.')).toBeNull();
  });

  it('navigates to a resolved internal destination with the guarded helper', () => {
    renderDetails(
      makeAnnotation({
        link: { url: null, unsafeUrl: null, internalPage: 3, newWindow: false },
      }),
    );

    expect(screen.queryByText('No resolvable link target.')).toBeNull();
    const openLink = screen.getByRole('button', { name: 'Open link' }) as HTMLButtonElement;
    expect(openLink.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Go to page 3' }));
    expect(navigate).toHaveBeenCalledWith(3);
  });

  it('reports an unresolved destination without offering an action', () => {
    renderDetails(
      makeAnnotation({
        link: { url: null, unsafeUrl: null, internalPage: null, newWindow: false },
      }),
    );

    expect(screen.getByText('No resolvable link target.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Go to page/ })).toBeNull();
  });

  it('shows a failed open locally instead of the document error banner', async () => {
    openExternalUrl.mockResolvedValue({ ok: false, error: 'The system opener refused it' });

    renderDetails(
      makeAnnotation({
        link: {
          url: 'https://example.com/docs',
          unsafeUrl: 'https://example.com/docs',
          internalPage: null,
          newWindow: true,
        },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The system opener refused it');
    // Link activation never writes to the global pdf-store error slot.
    expect(usePdfStore.getState().error).toBeNull();
  });

  it('renders form values, flags and options as read-only text', () => {
    const { container } = renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        form: makeForm({
          fieldName: 'country',
          fieldType: 'Ch',
          value: ['us', 'ca'],
          defaultValue: 'us',
          readOnly: true,
          required: true,
          combo: true,
          options: [
            { label: 'United States', value: 'us' },
            { label: 'Canada', value: 'ca' },
          ],
        }),
      }),
    );

    expect(screen.getByText('country')).toBeTruthy();
    expect(screen.getByText('Choice (Ch)')).toBeTruthy();
    expect(screen.getByText('us, ca')).toBeTruthy();
    expect(screen.getByText('us')).toBeTruthy();
    expect(screen.getByText('Read only, Required, Combo box')).toBeTruthy();
    expect(screen.getByText('United States (us)')).toBeTruthy();
    expect(screen.getByText('Canada (ca)')).toBeTruthy();

    // No editable control and no form element anywhere in the detail view.
    expect(container.querySelector('input, textarea, select, form')).toBeNull();
  });

  it('reports a form field without flags as unset', () => {
    renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        form: makeForm({ fieldName: 'comment', fieldType: 'Tx', value: 'Hi' }),
      }),
    );

    expect(screen.getByText('Text (Tx)')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('shows signature fields without claiming verification', () => {
    renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        form: makeForm({ fieldName: 'sig1', fieldType: 'Sig' }),
      }),
    );

    expect(screen.getByText('Signature (Sig)')).toBeTruthy();
    expect(screen.getByText('Signature not verified.')).toBeTruthy();
  });

  it('clears the shared annotation selection', () => {
    const annotation = makeAnnotation();
    useAnnotationStore.setState({ selected: annotation });
    renderDetails(annotation);

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    expect(useAnnotationStore.getState().selected).toBeNull();
  });
});

describe('AnnotationDetails localization', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useI18nStore.setState({ locale: 'zh-CN' });
    navigate.mockReset();
    openExternalUrl.mockReset();
    openExternalUrl.mockResolvedValue({ ok: true });
    useAnnotationStore.setState({ selected: null });
    usePdfStore.setState({ error: null });
  });

  it('translates the sections, row labels and form flags', () => {
    renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        page: 2,
        form: makeForm({
          fieldName: 'country',
          fieldType: 'Ch',
          value: ['us', 'ca'],
          defaultValue: 'us',
          readOnly: true,
          required: true,
          combo: true,
          options: [
            { label: 'United States', value: 'us' },
            { label: 'Canada', value: 'ca' },
          ],
        }),
      }),
    );

    expect(screen.getByText('注释')).toBeTruthy();
    // The section heading and the kind badge share the same copy; query the heading.
    expect(screen.getByRole('heading', { name: '表单字段' })).toBeTruthy();
    expect(screen.getByText('类别')).toBeTruthy();
    expect(screen.getByText('子类型')).toBeTruthy();
    expect(screen.getByText('页码')).toBeTruthy();
    expect(screen.getByText('矩形')).toBeTruthy();
    expect(screen.getByText('隐藏')).toBeTruthy();
    expect(screen.getByText('否')).toBeTruthy();
    expect(screen.getByText('字段名')).toBeTruthy();
    expect(screen.getByText('字段类型')).toBeTruthy();
    expect(screen.getByText('值')).toBeTruthy();
    expect(screen.getByText('默认值')).toBeTruthy();
    expect(screen.getByText('标志')).toBeTruthy();
    expect(screen.getByText('选项')).toBeTruthy();
    expect(screen.getByText('选择 (Ch)')).toBeTruthy();
    expect(screen.getByText('只读, 必填, 组合框')).toBeTruthy();
    expect(screen.getByText('United States (us)')).toBeTruthy();
    expect(screen.getByRole('button', { name: '清除选择' })).toBeTruthy();
  });

  it('translates flags that are unset and signature notes', () => {
    renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        form: makeForm({ fieldName: 'comment', fieldType: 'Tx', value: 'Hi' }),
      }),
    );

    expect(screen.getByText('文本 (Tx)')).toBeTruthy();
    expect(screen.getByText('无')).toBeTruthy();

    cleanup();

    renderDetails(
      makeAnnotation({
        subtype: 'Widget',
        kind: 'form',
        form: makeForm({ fieldName: 'sig1', fieldType: 'Sig' }),
      }),
    );

    expect(screen.getByText('签名 (Sig)')).toBeTruthy();
    expect(screen.getByText('签名未验证。')).toBeTruthy();
  });

  it('translates link warnings and actions, then switches back to English', () => {
    renderDetails(
      makeAnnotation({
        link: {
          url: null,
          unsafeUrl: 'javascript:alert(1)',
          internalPage: 3,
          newWindow: true,
        },
      }),
    );

    expect(screen.getByRole('heading', { name: '链接' })).toBeTruthy();
    expect(screen.getByText('目标')).toBeTruthy();
    expect(screen.getByText('警告')).toBeTruthy();
    expect(screen.getByText('窗口')).toBeTruthy();
    expect(screen.getByText('新窗口')).toBeTruthy();
    expect(
      screen.getByText('只能打开 http(s) 链接。此目标仅用于显示。'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '打开链接' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('button', { name: '跳转到第 3 页' })).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByText('Annotation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to page 3' })).toBeTruthy();
  });

  it('translates an unresolved link target', () => {
    renderDetails(
      makeAnnotation({
        link: { url: null, unsafeUrl: null, internalPage: null, newWindow: false },
      }),
    );

    expect(screen.getByText('没有可解析的链接目标。')).toBeTruthy();
  });
});
