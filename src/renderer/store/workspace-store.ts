import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * Layout-only state for the workspace shell. Document data, selection and
 * filter state stay in `pdf-store`; this store only remembers how the panes are
 * arranged so it can be written to localStorage without serializing the PDF.
 */

export type LeftPanelTab = 'objects' | 'outline' | 'fonts' | 'layers' | 'annotations';
export type InspectorTab = 'inspect' | 'filter' | 'results' | 'page';
export type WorkspacePanelSide = 'left' | 'right';

/** Unit used by the Page tab and the page rulers. */
export type PageUnits = 'pt' | 'mm';
/** The five PDF page boxes, in the order the UI lists them. */
export type PageBoxKey = 'media' | 'crop' | 'trim' | 'bleed' | 'art';
export type PageBoxVisibility = Record<PageBoxKey, boolean>;

export const WORKSPACE_STORAGE_KEY = 'pdf-inspector:workspace:v1';

export const LEFT_PANEL_LIMITS = { min: 200, max: 400, default: 240 } as const;
export const RIGHT_PANEL_LIMITS = { min: 280, max: 480, default: 320 } as const;
export const OVERLAY_OPACITY_LIMITS = { min: 0.15, max: 1, default: 1 } as const;

export const PANEL_LIMITS = {
  left: LEFT_PANEL_LIMITS,
  right: RIGHT_PANEL_LIMITS,
} as const;

export const LEFT_PANEL_TABS: readonly LeftPanelTab[] = [
  'objects',
  'outline',
  'fonts',
  'layers',
  'annotations',
];
export const INSPECTOR_TABS: readonly InspectorTab[] = ['inspect', 'filter', 'results', 'page'];
export const PAGE_UNITS: readonly PageUnits[] = ['pt', 'mm'];
export const PAGE_BOX_KEYS: readonly PageBoxKey[] = ['media', 'crop', 'trim', 'bleed', 'art'];

/** MediaBox is mandatory and CropBox is the visible page for most documents. */
export const DEFAULT_PAGE_BOX_VISIBILITY: PageBoxVisibility = {
  media: true,
  crop: true,
  trim: false,
  bleed: false,
  art: false,
};

export interface WorkspaceLayout {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  focusMode: boolean;
  leftTab: LeftPanelTab;
  inspectorTab: InspectorTab;
  overlayOpacity: number;
  pageBoxVisibility: PageBoxVisibility;
  showRulers: boolean;
  pageUnits: PageUnits;
}

export interface WorkspaceState extends WorkspaceLayout {
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setLeftCollapsed: (collapsed: boolean) => void;
  setRightCollapsed: (collapsed: boolean) => void;
  toggleLeftCollapsed: () => void;
  toggleRightCollapsed: () => void;
  setFocusMode: (enabled: boolean) => void;
  toggleFocusMode: () => void;
  setLeftTab: (tab: LeftPanelTab) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setOverlayOpacity: (opacity: number) => void;
  setPageBoxVisible: (box: PageBoxKey, visible: boolean) => void;
  setShowRulers: (visible: boolean) => void;
  setPageUnits: (units: PageUnits) => void;
}

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  leftWidth: LEFT_PANEL_LIMITS.default,
  rightWidth: RIGHT_PANEL_LIMITS.default,
  leftCollapsed: false,
  rightCollapsed: false,
  focusMode: false,
  leftTab: 'objects',
  inspectorTab: 'inspect',
  overlayOpacity: OVERLAY_OPACITY_LIMITS.default,
  pageBoxVisibility: { ...DEFAULT_PAGE_BOX_VISIBILITY },
  showRulers: false,
  pageUnits: 'pt',
};

/** Clamp a panel width into its supported range. Pure so it is easy to test. */
export const clampPanelWidth = (width: number, min: number, max: number): number => {
  if (!Number.isFinite(width)) return min;
  return Math.min(max, Math.max(min, width));
};

export const clampOverlayOpacity = (opacity: number): number => {
  if (!Number.isFinite(opacity)) return OVERLAY_OPACITY_LIMITS.default;
  return Math.min(
    OVERLAY_OPACITY_LIMITS.max,
    Math.max(OVERLAY_OPACITY_LIMITS.min, opacity),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readPersistedWidth = (
  value: unknown,
  limits: { min: number; max: number; default: number },
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limits.default;
  if (value < limits.min || value > limits.max) return limits.default;
  return value;
};

const readPersistedBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readPersistedTab = <T extends string>(
  value: unknown,
  tabs: readonly T[],
  fallback: T,
): T => (typeof value === 'string' && (tabs as readonly string[]).includes(value) ? (value as T) : fallback);

const readPersistedOpacity = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return OVERLAY_OPACITY_LIMITS.default;
  if (value < OVERLAY_OPACITY_LIMITS.min || value > OVERLAY_OPACITY_LIMITS.max) {
    return OVERLAY_OPACITY_LIMITS.default;
  }
  return value;
};

/**
 * Page-box visibility is stored as a map. Missing or malformed keys fall back
 * per box instead of resetting the whole map, so one hand-edited entry cannot
 * hide the MediaBox outline.
 */
const readPersistedPageBoxVisibility = (value: unknown): PageBoxVisibility => {
  const source = isRecord(value) ? value : {};
  return PAGE_BOX_KEYS.reduce((visibility, key) => {
    visibility[key] = readPersistedBoolean(source[key], DEFAULT_PAGE_BOX_VISIBILITY[key]);
    return visibility;
  }, {} as PageBoxVisibility);
};

/**
 * Persisted data comes from localStorage and may be stale, truncated or edited
 * by hand. Rebuild a complete layout and use defaults for every invalid field
 * instead of trusting the stored object.
 */
const sanitizePersistedLayout = (persisted: unknown): WorkspaceLayout => {
  if (!isRecord(persisted)) {
    return { ...DEFAULT_WORKSPACE_LAYOUT, pageBoxVisibility: { ...DEFAULT_PAGE_BOX_VISIBILITY } };
  }

  return {
    leftWidth: readPersistedWidth(persisted.leftWidth, LEFT_PANEL_LIMITS),
    rightWidth: readPersistedWidth(persisted.rightWidth, RIGHT_PANEL_LIMITS),
    leftCollapsed: readPersistedBoolean(
      persisted.leftCollapsed,
      DEFAULT_WORKSPACE_LAYOUT.leftCollapsed,
    ),
    rightCollapsed: readPersistedBoolean(
      persisted.rightCollapsed,
      DEFAULT_WORKSPACE_LAYOUT.rightCollapsed,
    ),
    focusMode: readPersistedBoolean(persisted.focusMode, DEFAULT_WORKSPACE_LAYOUT.focusMode),
    leftTab: readPersistedTab(
      persisted.leftTab,
      LEFT_PANEL_TABS,
      DEFAULT_WORKSPACE_LAYOUT.leftTab,
    ),
    inspectorTab: readPersistedTab(
      persisted.inspectorTab,
      INSPECTOR_TABS,
      DEFAULT_WORKSPACE_LAYOUT.inspectorTab,
    ),
    overlayOpacity: readPersistedOpacity(persisted.overlayOpacity),
    pageBoxVisibility: readPersistedPageBoxVisibility(persisted.pageBoxVisibility),
    showRulers: readPersistedBoolean(persisted.showRulers, DEFAULT_WORKSPACE_LAYOUT.showRulers),
    pageUnits: readPersistedTab(
      persisted.pageUnits,
      PAGE_UNITS,
      DEFAULT_WORKSPACE_LAYOUT.pageUnits,
    ),
  };
};

const persistLayout = (state: WorkspaceState): WorkspaceLayout => ({
  leftWidth: state.leftWidth,
  rightWidth: state.rightWidth,
  leftCollapsed: state.leftCollapsed,
  rightCollapsed: state.rightCollapsed,
  focusMode: state.focusMode,
  leftTab: state.leftTab,
  inspectorTab: state.inspectorTab,
  overlayOpacity: state.overlayOpacity,
  pageBoxVisibility: state.pageBoxVisibility,
  showRulers: state.showRulers,
  pageUnits: state.pageUnits,
});

const createMemoryStorage = (): StateStorage => {
  const values = new Map<string, string>();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
};

const memoryStorage = createMemoryStorage();

/**
 * Electron and browsers expose localStorage, but jsdom/privacy modes can leave
 * it missing or throwing on access. Fall back to memory so layout state still
 * works for the session instead of breaking every store update.
 */
const getWorkspaceStorage = (): StateStorage => {
  try {
    const storage = window.localStorage;
    if (
      storage &&
      typeof storage.getItem === 'function' &&
      typeof storage.setItem === 'function' &&
      typeof storage.removeItem === 'function'
    ) {
      return storage;
    }
  } catch {
    // Access to localStorage can throw for opaque origins; use memory instead.
  }
  return memoryStorage;
};

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      ...DEFAULT_WORKSPACE_LAYOUT,

      setLeftWidth: (width) =>
        set({ leftWidth: clampPanelWidth(width, LEFT_PANEL_LIMITS.min, LEFT_PANEL_LIMITS.max) }),
      setRightWidth: (width) =>
        set({ rightWidth: clampPanelWidth(width, RIGHT_PANEL_LIMITS.min, RIGHT_PANEL_LIMITS.max) }),

      setLeftCollapsed: (collapsed) => set({ leftCollapsed: collapsed }),
      setRightCollapsed: (collapsed) => set({ rightCollapsed: collapsed }),
      toggleLeftCollapsed: () => set((state) => ({ leftCollapsed: !state.leftCollapsed })),
      toggleRightCollapsed: () => set((state) => ({ rightCollapsed: !state.rightCollapsed })),

      setFocusMode: (enabled) => set({ focusMode: enabled }),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),

      setLeftTab: (tab) => set({ leftTab: tab }),
      setInspectorTab: (tab) => set({ inspectorTab: tab }),
      setOverlayOpacity: (opacity) => set({ overlayOpacity: clampOverlayOpacity(opacity) }),

      setPageBoxVisible: (box, visible) =>
        set((state) => ({
          pageBoxVisibility: { ...state.pageBoxVisibility, [box]: visible },
        })),
      setShowRulers: (visible) => set({ showRulers: visible }),
      setPageUnits: (units) => set({ pageUnits: units }),
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(getWorkspaceStorage),
      partialize: persistLayout,
      // A version bump without a migration is treated as a reset: a stale
      // layout must never prevent the app from starting.
      migrate: () => ({ ...DEFAULT_WORKSPACE_LAYOUT }),
      merge: (persisted, current) => ({ ...current, ...sanitizePersistedLayout(persisted) }),
    },
  ),
);
