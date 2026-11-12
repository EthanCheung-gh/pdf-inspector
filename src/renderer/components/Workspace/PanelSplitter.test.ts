// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n/store';
import { LEFT_PANEL_LIMITS, RIGHT_PANEL_LIMITS } from '../../store/workspace-store';
import { PanelSplitter } from './PanelSplitter';

interface RenderOptions {
  /** Render a fake pane with this id next to the splitter so inline painting is observable. */
  paneId?: string;
}

const renderSplitter = (
  side: 'left' | 'right',
  width: number,
  onResize = vi.fn(),
  options: RenderOptions = {},
): { separator: HTMLElement; onResize: ReturnType<typeof vi.fn> } => {
  const limits = side === 'left' ? LEFT_PANEL_LIMITS : RIGHT_PANEL_LIMITS;
  render(
    React.createElement(
      'div',
      null,
      options.paneId ? React.createElement('div', { id: options.paneId }) : null,
      React.createElement(PanelSplitter, {
        side,
        width,
        min: limits.min,
        max: limits.max,
        onResize,
      }),
    ),
  );

  return { separator: screen.getByRole('separator'), onResize };
};

const startDrag = (separator: HTMLElement, clientX: number, pointerId = 1): void => {
  fireEvent.pointerDown(separator, { button: 0, pointerId, clientX });
};

const movePointer = (separator: HTMLElement, clientX: number, pointerId = 1): void => {
  fireEvent.pointerMove(separator, { pointerId, clientX });
};

const endPointer = (separator: HTMLElement, pointerId = 1): void => {
  fireEvent.pointerUp(separator, { pointerId, clientX: 0 });
};

describe('PanelSplitter', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'en' });
  });

  afterEach(cleanup);

  it('translates the separator label in Chinese', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    const { separator } = renderSplitter('right', 320);

    expect(separator.getAttribute('aria-label')).toBe('调整右侧面板宽度');
  });

  it('exposes vertical separator semantics and the current width', () => {
    const { separator } = renderSplitter('left', 240);

    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-valuenow')).toBe('240');
    expect(separator.getAttribute('aria-valuemin')).toBe('200');
    expect(separator.getAttribute('aria-valuemax')).toBe('400');
    expect(separator.getAttribute('aria-controls')).toBe('workspace-left-pane');
    expect(separator.tabIndex).toBe(0);
  });

  it('moves the left pane in the same direction as the arrow keys', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith(248);

    onResize.mockClear();
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(232);
  });

  it('inverts the direction for the right pane', () => {
    const { separator, onResize } = renderSplitter('right', 320);

    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(328);

    onResize.mockClear();
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(312);
  });

  it('clamps keyboard resizing at the panel limits', () => {
    const left = renderSplitter('left', 396);
    fireEvent.keyDown(left.separator, { key: 'ArrowRight' });
    expect(left.onResize).toHaveBeenLastCalledWith(400);
    cleanup();

    const leftAtMin = renderSplitter('left', 200);
    fireEvent.keyDown(leftAtMin.separator, { key: 'ArrowLeft' });
    expect(leftAtMin.onResize).not.toHaveBeenCalled();
    cleanup();

    const rightAtMin = renderSplitter('right', 280);
    fireEvent.keyDown(rightAtMin.separator, { key: 'ArrowRight' });
    expect(rightAtMin.onResize).not.toHaveBeenCalled();
    cleanup();

    const rightAtMax = renderSplitter('right', 476);
    fireEvent.keyDown(rightAtMax.separator, { key: 'ArrowLeft' });
    expect(rightAtMax.onResize).toHaveBeenLastCalledWith(480);
  });

  it('ignores unrelated keys', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    fireEvent.keyDown(separator, { key: 'Enter' });
    fireEvent.keyDown(separator, { key: 'ArrowUp' });

    expect(onResize).not.toHaveBeenCalled();
  });

  it('defers onResize until the pointer is released', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    startDrag(separator, 100);
    movePointer(separator, 120);
    movePointer(separator, 140);
    movePointer(separator, 160);
    expect(onResize).not.toHaveBeenCalled();
    expect(separator.getAttribute('aria-valuenow')).toBe('300');

    endPointer(separator);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('paints the preview pane width without a React commit', () => {
    const { separator, onResize } = renderSplitter('left', 240, vi.fn(), {
      paneId: 'workspace-left-pane',
    });
    const pane = document.getElementById('workspace-left-pane') as HTMLElement;

    startDrag(separator, 100);
    movePointer(separator, 150);

    expect(pane.style.width).toBe('290px');
    expect(pane.style.flexBasis).toBe('290px');
    expect(onResize).not.toHaveBeenCalled();

    endPointer(separator);
    expect(onResize).toHaveBeenCalledWith(290);
  });

  it('grows the left pane when dragged right', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    startDrag(separator, 100);
    movePointer(separator, 140);
    endPointer(separator);

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(280);
  });

  it('shrinks the right pane when dragged right', () => {
    const { separator, onResize } = renderSplitter('right', 320);

    startDrag(separator, 100);
    movePointer(separator, 120);
    endPointer(separator);

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('clamps the dragged width at the panel limits', () => {
    const left = renderSplitter('left', 396);
    startDrag(left.separator, 100);
    movePointer(left.separator, 500);
    expect(left.separator.getAttribute('aria-valuenow')).toBe('400');
    endPointer(left.separator);
    expect(left.onResize).toHaveBeenCalledTimes(1);
    expect(left.onResize).toHaveBeenCalledWith(400);
    cleanup();

    const right = renderSplitter('right', 280);
    startDrag(right.separator, 100);
    movePointer(right.separator, 400);
    expect(right.separator.getAttribute('aria-valuenow')).toBe('280');
    endPointer(right.separator);
    expect(right.onResize).not.toHaveBeenCalled();
  });

  it('ignores pointer events from another pointer id', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    startDrag(separator, 100, 1);
    movePointer(separator, 160, 2);
    expect(separator.getAttribute('aria-valuenow')).toBe('240');

    endPointer(separator, 2);
    expect(onResize).not.toHaveBeenCalled();

    movePointer(separator, 160, 1);
    endPointer(separator, 1);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(300);
  });

  it('commits once when the pointer capture is lost mid-drag', () => {
    const { separator, onResize } = renderSplitter('left', 240);

    startDrag(separator, 100);
    movePointer(separator, 130);
    fireEvent.lostPointerCapture(separator, { pointerId: 1, clientX: 130 });
    endPointer(separator);

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(270);
  });

  it('keeps the preview during a drag and defers to the width prop afterwards', () => {
    const onResize = vi.fn();
    const limits = LEFT_PANEL_LIMITS;
    const tree = (width: number): JSX.Element =>
      React.createElement(PanelSplitter, {
        side: 'left',
        width,
        min: limits.min,
        max: limits.max,
        onResize,
      });

    const { rerender } = render(tree(240));
    const separator = screen.getByRole('separator');

    startDrag(separator, 100);
    movePointer(separator, 160);
    expect(separator.getAttribute('aria-valuenow')).toBe('300');

    // A width handed down mid-drag does not clobber the in-progress preview.
    rerender(tree(260));
    expect(separator.getAttribute('aria-valuenow')).toBe('300');

    endPointer(separator);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(300);

    // Once the drag is over the prop is the only source of truth again.
    rerender(tree(340));
    expect(separator.getAttribute('aria-valuenow')).toBe('340');
  });
});
