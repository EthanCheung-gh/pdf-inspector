// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PageViewport } from 'pdfjs-dist';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useI18nStore } from '../../i18n';
import { DEFAULT_WORKSPACE_LAYOUT, useWorkspaceStore } from '../../store/workspace-store';

import { PageRuler, computeRulerTicks, labelFitsAt, selectRulerStep } from './PageRuler';

const labels = (ticks: ReturnType<typeof computeRulerTicks>): string[] =>
  ticks.map((tick) => tick.label).filter((label): label is string => label !== null);

beforeEach(() => {
  useI18nStore.setState({ locale: 'en' });
});

describe('selectRulerStep', () => {
  it('keeps labelled ticks at least 44px apart in points', () => {
    expect(selectRulerStep(1, 'pt')).toBe(50);
    expect(selectRulerStep(0.5, 'pt')).toBe(100);
    expect(selectRulerStep(2, 'pt')).toBe(25);
  });

  it('uses millimetre steps for the mm unit', () => {
    // 20 mm = 56.7px at 1px/pt; 10 mm would only be 28.3px.
    expect(selectRulerStep(1, 'mm')).toBe(20);
    expect(selectRulerStep(2, 'mm')).toBe(10);
  });

  it('falls back to the smallest step for an invalid scale', () => {
    expect(selectRulerStep(0, 'pt')).toBe(1);
    expect(selectRulerStep(Number.NaN, 'mm')).toBe(1);
  });
});

describe('computeRulerTicks', () => {
  it('labels majors and keeps minors unlabelled in points', () => {
    const ticks = computeRulerTicks({ length: 200, pxPerPt: 1, unit: 'pt' });

    // The trailing 200pt label would be clipped by the ruler edge (see below).
    expect(labels(ticks)).toEqual(['0', '50', '100', '150']);
    expect(ticks[0]).toEqual({ position: 0, value: 0, label: '0', major: true });
    // 50pt / 5 subdivisions = 10pt (10px) minor ticks.
    expect(ticks[1]).toEqual({ position: 10, value: 10, label: null, major: false });
    expect(ticks.every((tick) => tick.position <= 200)).toBe(true);
    // The far edge still gets its tick mark, just no label.
    expect(ticks.some((tick) => tick.major && tick.position === 200 && tick.label === null)).toBe(
      true,
    );
  });

  it('adapts to 50% and 200% zoom while staying readable', () => {
    // 400px at 0.5px/pt is 800pt, so 100pt majors are 50px apart.
    const zoomedOut = computeRulerTicks({ length: 400, pxPerPt: 0.5, unit: 'pt' });
    expect(labels(zoomedOut)).toEqual([
      '0',
      '100',
      '200',
      '300',
      '400',
      '500',
      '600',
      '700',
    ]);
    const zoomedOutMajors = zoomedOut.filter((tick) => tick.major);
    expect(zoomedOutMajors[1].position - zoomedOutMajors[0].position).toBeGreaterThanOrEqual(44);

    const zoomedIn = computeRulerTicks({ length: 400, pxPerPt: 2, unit: 'pt' });
    expect(labels(zoomedIn)[0]).toBe('0');
    expect(labels(zoomedIn)[1]).toBe('25');
    const zoomedInMajors = zoomedIn.filter((tick) => tick.major);
    expect(zoomedInMajors[1].position - zoomedInMajors[0].position).toBeGreaterThanOrEqual(44);
  });

  it('uses millimetre labels and round minor values in mm', () => {
    const ticks = computeRulerTicks({ length: 300, pxPerPt: 1, unit: 'mm' });
    // 100mm sits at 283.5px, too close to the 300px edge for a label.
    expect(labels(ticks)).toEqual(['0', '20', '40', '60', '80']);
    // 20 mm / 4 subdivisions = 5 mm minors.
    expect(ticks[1]).toMatchObject({ value: 5, label: null, major: false });
  });

  it('returns no ticks for missing dimensions or scale', () => {
    expect(computeRulerTicks({ length: 0, pxPerPt: 1, unit: 'pt' })).toEqual([]);
    expect(computeRulerTicks({ length: -10, pxPerPt: 1, unit: 'pt' })).toEqual([]);
    expect(computeRulerTicks({ length: Number.NaN, pxPerPt: 1, unit: 'pt' })).toEqual([]);
    expect(computeRulerTicks({ length: 200, pxPerPt: 0, unit: 'pt' })).toEqual([]);
    expect(computeRulerTicks({ length: 200, pxPerPt: Number.NaN, unit: 'pt' })).toEqual([]);
  });
});

describe('ruler edge labels', () => {
  it('keeps the tick but drops a label that would be clipped at the far edge', () => {
    // 600pt wide page at 1px/pt: the "600" label needs 18px past its tick.
    const ticks = computeRulerTicks({ length: 600, pxPerPt: 1, unit: 'pt', edge: 'top' });

    expect(labels(ticks).at(-1)).toBe('550');
    expect(labels(ticks)).not.toContain('600');
    expect(ticks.some((tick) => tick.major && tick.position === 600)).toBe(true);
    // Spacing is untouched: only the label is missing.
    expect(ticks.filter((tick) => tick.major).map((tick) => tick.position)).toEqual([
      0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600,
    ]);
  });

  it('uses the tighter inset for the left gutter', () => {
    // 25pt majors are 50px apart; the last one sits at 550 of 560px.
    const top = computeRulerTicks({ length: 560, pxPerPt: 2, unit: 'pt', edge: 'top' });
    const left = computeRulerTicks({ length: 560, pxPerPt: 2, unit: 'pt', edge: 'left' });

    // 560 - 18 = 542 < 550, so the horizontal label is clipped...
    expect(labels(top).at(-1)).toBe('250');
    // ...while 560 - 10 = 550 still fits the vertical one.
    expect(labels(left).at(-1)).toBe('275');
  });

  it('defaults to the top-edge inset', () => {
    const withoutEdge = computeRulerTicks({ length: 560, pxPerPt: 2, unit: 'pt' });
    const top = computeRulerTicks({ length: 560, pxPerPt: 2, unit: 'pt', edge: 'top' });
    expect(withoutEdge).toEqual(top);
  });

  it('reports whether a label fits at a given position', () => {
    expect(labelFitsAt(600, 600, 'top')).toBe(false);
    expect(labelFitsAt(582, 600, 'top')).toBe(true);
    expect(labelFitsAt(583, 600, 'top')).toBe(false);
    // The left gutter only needs 10px, so a label 8px from the edge still fits.
    expect(labelFitsAt(590, 600, 'left')).toBe(true);
    expect(labelFitsAt(591, 600, 'left')).toBe(false);
    expect(labelFitsAt(Number.NaN, 600, 'top')).toBe(false);
  });
});

describe('PageRuler', () => {
  afterEach(cleanup);

  beforeEach(() => {
    useWorkspaceStore.setState({ ...DEFAULT_WORKSPACE_LAYOUT });
  });

  it('renders the unit corner and tick labels for the active unit', () => {
    useWorkspaceStore.setState({ pageUnits: 'mm' });
    const viewport = {
      scale: 1,
      userUnit: 1,
      width: 200,
      height: 300,
    } as unknown as PageViewport;

    render(React.createElement(PageRuler, { width: 200, height: 300, viewport }));

    expect(screen.getByTestId('page-ruler')).toBeTruthy();
    expect(screen.getByText('mm')).toBeTruthy();
    expect(screen.getAllByText('20').length).toBeGreaterThan(0);
  });

  it('renders the far-edge tick without the label the ruler would clip', () => {
    useWorkspaceStore.setState({ pageUnits: 'pt' });
    const viewport = {
      scale: 1,
      userUnit: 1,
      width: 600,
      height: 600,
    } as unknown as PageViewport;

    render(React.createElement(PageRuler, { width: 600, height: 600, viewport }));

    // "600" used to render as "60" once the ruler clipped it.
    expect(screen.queryByText('600')).toBeNull();
    expect(screen.getAllByText('550').length).toBeGreaterThan(0);

    // The tick mark at the page edge is still drawn.
    const edgeTicks = Array.from(
      screen.getByTestId('page-ruler').querySelectorAll('span'),
    ).filter((element) => element.style.left === '600px');
    expect(edgeTicks).toHaveLength(1);
    expect(edgeTicks[0].textContent).toBe('');
  });

  it('renders nothing before the PDF.js viewport exists', () => {
    render(React.createElement(PageRuler, { width: 200, height: 300, viewport: null }));

    expect(screen.queryByTestId('page-ruler')).toBeNull();
  });

  it('labels the ruler in the active locale while keeping the unit symbol', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    useWorkspaceStore.setState({ pageUnits: 'mm' });
    const viewport = {
      scale: 1,
      userUnit: 1,
      width: 200,
      height: 300,
    } as unknown as PageViewport;

    render(React.createElement(PageRuler, { width: 200, height: 300, viewport }));

    expect(screen.getByRole('img', { name: '页面标尺（mm）' })).toBeTruthy();
    expect(screen.getByText('mm')).toBeTruthy();

    act(() => {
      useI18nStore.setState({ locale: 'en' });
    });

    expect(screen.getByRole('img', { name: 'Page rulers (mm)' })).toBeTruthy();
  });
});
