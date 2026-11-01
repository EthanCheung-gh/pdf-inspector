// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom under Node 22 can expose an undefined global localStorage; install a
// real Storage-shaped mock before the persisted store module is evaluated.
const localStorageMock = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => (values.has(key) ? (values.get(key) as string) : null),
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });

  return storage;
});

import {
  DEFAULT_WORKSPACE_LAYOUT,
  LEFT_PANEL_LIMITS,
  OVERLAY_OPACITY_LIMITS,
  RIGHT_PANEL_LIMITS,
  WORKSPACE_STORAGE_KEY,
  clampOverlayOpacity,
  clampPanelWidth,
  useWorkspaceStore,
} from '../workspace-store';

const resetWorkspace = (): void => {
  useWorkspaceStore.setState({ ...DEFAULT_WORKSPACE_LAYOUT });
};

describe('workspace-store', () => {
  beforeEach(() => {
    resetWorkspace();
    localStorageMock.clear();
  });

  it('starts with the documented layout defaults', () => {
    const state = useWorkspaceStore.getState();

    expect(state.leftWidth).toBe(240);
    expect(state.rightWidth).toBe(320);
    expect(state.leftCollapsed).toBe(false);
    expect(state.rightCollapsed).toBe(false);
    expect(state.focusMode).toBe(false);
    expect(state.leftTab).toBe('objects');
    expect(state.inspectorTab).toBe('inspect');
    expect(state.overlayOpacity).toBe(1);
  });

  it('clamps panel widths into the supported ranges', () => {
    expect(clampPanelWidth(100, LEFT_PANEL_LIMITS.min, LEFT_PANEL_LIMITS.max)).toBe(200);
    expect(clampPanelWidth(999, LEFT_PANEL_LIMITS.min, LEFT_PANEL_LIMITS.max)).toBe(400);
    expect(clampPanelWidth(321, LEFT_PANEL_LIMITS.min, LEFT_PANEL_LIMITS.max)).toBe(321);
    expect(clampPanelWidth(100, RIGHT_PANEL_LIMITS.min, RIGHT_PANEL_LIMITS.max)).toBe(280);
    expect(clampPanelWidth(999, RIGHT_PANEL_LIMITS.min, RIGHT_PANEL_LIMITS.max)).toBe(480);
  });

  it('clamps width setters and the opacity setter', () => {
    const store = useWorkspaceStore.getState();

    store.setLeftWidth(120);
    expect(useWorkspaceStore.getState().leftWidth).toBe(LEFT_PANEL_LIMITS.min);
    store.setLeftWidth(999);
    expect(useWorkspaceStore.getState().leftWidth).toBe(LEFT_PANEL_LIMITS.max);
    store.setLeftWidth(333);
    expect(useWorkspaceStore.getState().leftWidth).toBe(333);

    store.setRightWidth(120);
    expect(useWorkspaceStore.getState().rightWidth).toBe(RIGHT_PANEL_LIMITS.min);
    store.setRightWidth(999);
    expect(useWorkspaceStore.getState().rightWidth).toBe(RIGHT_PANEL_LIMITS.max);
    store.setRightWidth(401);
    expect(useWorkspaceStore.getState().rightWidth).toBe(401);

    store.setOverlayOpacity(0.01);
    expect(useWorkspaceStore.getState().overlayOpacity).toBe(OVERLAY_OPACITY_LIMITS.min);
    store.setOverlayOpacity(2);
    expect(useWorkspaceStore.getState().overlayOpacity).toBe(OVERLAY_OPACITY_LIMITS.max);
    expect(clampOverlayOpacity(0.5)).toBe(0.5);
  });

  it('toggles collapse and focus mode without losing widths', () => {
    const store = useWorkspaceStore.getState();
    store.setLeftWidth(280);

    store.toggleLeftCollapsed();
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(true);
    expect(useWorkspaceStore.getState().leftWidth).toBe(280);
    store.toggleLeftCollapsed();
    expect(useWorkspaceStore.getState().leftCollapsed).toBe(false);

    store.toggleRightCollapsed();
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(true);
    store.setRightCollapsed(false);
    expect(useWorkspaceStore.getState().rightCollapsed).toBe(false);

    store.toggleFocusMode();
    expect(useWorkspaceStore.getState().focusMode).toBe(true);
    store.toggleFocusMode();
    expect(useWorkspaceStore.getState().focusMode).toBe(false);
    store.setFocusMode(true);
    expect(useWorkspaceStore.getState().focusMode).toBe(true);
  });

  it('stores left and inspector tab selections', () => {
    const store = useWorkspaceStore.getState();

    store.setLeftTab('outline');
    store.setInspectorTab('results');

    expect(useWorkspaceStore.getState().leftTab).toBe('outline');
    expect(useWorkspaceStore.getState().inspectorTab).toBe('results');
  });

  it('persists only the layout fields under the workspace key', () => {
    const store = useWorkspaceStore.getState();
    store.setLeftWidth(333);
    store.setRightWidth(420);
    store.toggleRightCollapsed();
    store.setLeftTab('layers');
    store.setInspectorTab('filter');
    store.setOverlayOpacity(0.5);

    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    expect(raw).not.toBeNull();

    const persisted = JSON.parse(raw as string) as {
      state: Record<string, unknown>;
      version: number;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.state).toMatchObject({
      leftWidth: 333,
      rightWidth: 420,
      leftCollapsed: false,
      rightCollapsed: true,
      leftTab: 'layers',
      inspectorTab: 'filter',
      overlayOpacity: 0.5,
    });
    expect(persisted.state).not.toHaveProperty('setLeftWidth');
    expect(persisted.state).not.toHaveProperty('toggleLeftCollapsed');
  });

  it('rehydrates a valid persisted layout', async () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          leftWidth: 375,
          rightWidth: 440,
          leftCollapsed: true,
          rightCollapsed: true,
          focusMode: true,
          leftTab: 'fonts',
          inspectorTab: 'results',
          overlayOpacity: 0.35,
        },
      }),
    );

    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.leftWidth).toBe(375);
    expect(state.rightWidth).toBe(440);
    expect(state.leftCollapsed).toBe(true);
    expect(state.rightCollapsed).toBe(true);
    expect(state.focusMode).toBe(true);
    expect(state.leftTab).toBe('fonts');
    expect(state.inspectorTab).toBe('results');
    expect(state.overlayOpacity).toBe(0.35);
  });

  it('falls back to defaults for out-of-range or malformed persisted fields', async () => {
    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          leftWidth: 9999,
          rightWidth: 'wide',
          leftCollapsed: 'yes',
          rightCollapsed: null,
          focusMode: 1,
          leftTab: 'layers-typo',
          inspectorTab: 'unknown',
          overlayOpacity: 5,
        },
      }),
    );

    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.leftWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.leftWidth);
    expect(state.rightWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.rightWidth);
    expect(state.leftCollapsed).toBe(false);
    expect(state.rightCollapsed).toBe(false);
    expect(state.focusMode).toBe(false);
    expect(state.leftTab).toBe('objects');
    expect(state.inspectorTab).toBe('inspect');
    expect(state.overlayOpacity).toBe(1);
  });

  it('falls back to defaults when stored JSON is corrupt or from an older version', async () => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '{not valid json');
    await useWorkspaceStore.persist.rehydrate();
    expect(useWorkspaceStore.getState().leftWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.leftWidth);

    window.localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({ version: 0, state: { leftWidth: 390, leftTab: 'layers' } }),
    );
    await useWorkspaceStore.persist.rehydrate();

    const state = useWorkspaceStore.getState();
    expect(state.leftWidth).toBe(DEFAULT_WORKSPACE_LAYOUT.leftWidth);
    expect(state.leftTab).toBe('objects');
  });
});
