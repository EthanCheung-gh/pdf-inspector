import { beforeEach, describe, expect, it } from 'vitest';
import { usePageOverviewStore } from '../page-overview-store';

describe('usePageOverviewStore', () => {
  beforeEach(() => {
    usePageOverviewStore.setState({ open: false, filter: 'all' });
  });

  it('starts closed, on all pages, and opens/closes through its actions', () => {
    expect(usePageOverviewStore.getState().open).toBe(false);
    expect(usePageOverviewStore.getState().filter).toBe('all');

    usePageOverviewStore.getState().openOverview();
    expect(usePageOverviewStore.getState().open).toBe(true);

    usePageOverviewStore.getState().closeOverview();
    expect(usePageOverviewStore.getState().open).toBe(false);
  });

  it('opens on a requested filter and defaults to all pages', () => {
    usePageOverviewStore.getState().openOverview('problems');
    expect(usePageOverviewStore.getState().open).toBe(true);
    expect(usePageOverviewStore.getState().filter).toBe('problems');

    // A plain `openOverview()` (toolbar button, `P`) is always unfiltered.
    usePageOverviewStore.getState().openOverview();
    expect(usePageOverviewStore.getState().filter).toBe('all');
  });

  it('toggles between open and closed', () => {
    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().open).toBe(true);

    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().open).toBe(false);
  });

  it('resets the filter to all when the overview closes', () => {
    usePageOverviewStore.getState().openOverview('problems');
    usePageOverviewStore.getState().closeOverview();
    expect(usePageOverviewStore.getState().filter).toBe('all');

    // Closing through the toggle is a close too: reopening never restores a
    // filter chosen for a previous look.
    usePageOverviewStore.getState().openOverview('annotated');
    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().filter).toBe('all');

    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().open).toBe(true);
    expect(usePageOverviewStore.getState().filter).toBe('all');
  });

  it('changes the filter without touching visibility', () => {
    usePageOverviewStore.getState().openOverview();
    usePageOverviewStore.getState().setFilter('annotated');

    expect(usePageOverviewStore.getState().open).toBe(true);
    expect(usePageOverviewStore.getState().filter).toBe('annotated');

    usePageOverviewStore.getState().setFilter('problems');
    expect(usePageOverviewStore.getState().filter).toBe('problems');
  });
});
