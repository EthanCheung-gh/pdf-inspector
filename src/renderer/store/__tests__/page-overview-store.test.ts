import { beforeEach, describe, expect, it } from 'vitest';
import { usePageOverviewStore } from '../page-overview-store';

describe('usePageOverviewStore', () => {
  beforeEach(() => {
    usePageOverviewStore.setState({ open: false });
  });

  it('starts closed and opens/closes through its actions', () => {
    expect(usePageOverviewStore.getState().open).toBe(false);

    usePageOverviewStore.getState().openOverview();
    expect(usePageOverviewStore.getState().open).toBe(true);

    usePageOverviewStore.getState().closeOverview();
    expect(usePageOverviewStore.getState().open).toBe(false);
  });

  it('toggles between open and closed', () => {
    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().open).toBe(true);

    usePageOverviewStore.getState().toggleOverview();
    expect(usePageOverviewStore.getState().open).toBe(false);
  });
});
