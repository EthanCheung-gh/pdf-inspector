// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useI18nStore } from '../../i18n/store';
import { PANEL_RAIL_ARROW, PanelRail, panelRailShowLabel } from './PanelRail';

const renderRail = (
  side: 'left' | 'right',
  label: string,
  onShow = vi.fn(),
): { button: HTMLElement; onShow: ReturnType<typeof vi.fn>; container: HTMLElement } => {
  const { container } = render(React.createElement(PanelRail, { side, label, onShow }));
  return { button: screen.getByRole('button'), onShow, container };
};

describe('PanelRail', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'en' });
  });

  afterEach(cleanup);

  it('exposes a button with the show label and the pane name', () => {
    const { button } = renderRail('left', 'Objects');

    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Show left panel');
    expect(button.getAttribute('title')).toBe('Show left panel');
    expect(button.textContent).toContain('Objects');
    expect(button.textContent).toContain(PANEL_RAIL_ARROW.left);
  });

  it('labels the right rail separately and points its arrow back at the canvas', () => {
    const { button } = renderRail('right', 'Inspector');

    expect(button.getAttribute('aria-label')).toBe('Show right panel');
    expect(button.getAttribute('title')).toBe('Show right panel');
    expect(button.textContent).toContain('Inspector');
    expect(button.textContent).toContain(PANEL_RAIL_ARROW.right);
    expect(PANEL_RAIL_ARROW.right).not.toBe(PANEL_RAIL_ARROW.left);
  });

  it('renders the arrow decoratively so the accessible name stays stable', () => {
    const { button } = renderRail('left', 'Objects');
    const arrow = button.querySelector('[aria-hidden="true"]');

    expect(arrow).not.toBeNull();
    expect(arrow?.textContent).toBe(PANEL_RAIL_ARROW.left);
  });

  it('calls the left rail show callback once per click', () => {
    const { button, onShow } = renderRail('left', 'Objects');

    fireEvent.click(button);

    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('calls the right rail show callback once per click', () => {
    const { button, onShow } = renderRail('right', 'Inspector');

    fireEvent.click(button);

    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('maps each side to its show label', () => {
    expect(panelRailShowLabel('left')).toBe('Show left panel');
    expect(panelRailShowLabel('right')).toBe('Show right panel');
  });

  it('translates the show label in Chinese', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    const { button } = renderRail('left', '对象');

    expect(button.getAttribute('aria-label')).toBe('显示左侧面板');
    expect(button.getAttribute('title')).toBe('显示左侧面板');
    expect(button.textContent).toContain('对象');
  });
});
