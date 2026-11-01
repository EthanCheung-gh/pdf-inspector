import React, { useEffect, useState } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import {
  LEFT_PANEL_TABS,
  useWorkspaceStore,
  type LeftPanelTab,
} from '../../store/workspace-store';
import { StructureTree } from '../StructureTree/StructureTree';
import { BookmarkTree } from './BookmarkTree';
import { FontsTab } from './FontsTab';
import { LayersPanel } from './LayersPanel';
import styles from './LeftPanel.module.css';

const TAB_LABELS: Record<LeftPanelTab, string> = {
  objects: 'Objects',
  outline: 'Outline',
  fonts: 'Fonts',
  layers: 'Layers',
};

export const LeftPanel: React.FC = () => {
  const leftTab = useWorkspaceStore((state) => state.leftTab);
  const setLeftTab = useWorkspaceStore((state) => state.setLeftTab);
  const toggleLeftCollapsed = useWorkspaceStore((state) => state.toggleLeftCollapsed);
  // FontsTab owns the batched font analysis, and unmounting it cancels the run.
  // Mount it on the first visit and then keep it mounted (hidden) so navigating
  // through the other tabs does not throw the analysis away, while still never
  // analyzing a document the user has not asked about.
  const [fontsVisited, setFontsVisited] = useState(false);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);

  useEffect(() => {
    if (leftTab === 'fonts') setFontsVisited(true);
  }, [leftTab]);

  const fontsMounted = fontsVisited || leftTab === 'fonts';

  return (
    <aside className={styles.panel} aria-label="Document navigation">
      {/* The tablist must contain only tabs, so the collapse control lives in
          this wrapper row rather than inside the `role="tablist"` element. */}
      <div className={styles.tabHeader}>
        <div className={styles.tabBar} role="tablist" aria-label="Document navigation tabs">
          {LEFT_PANEL_TABS.map((tab) => (
            <button
              className={`${styles.tabButton} ${leftTab === tab ? styles.activeTab : ''}`}
              key={tab}
              type="button"
              role="tab"
              aria-selected={leftTab === tab}
              title={TAB_LABELS[tab]}
              onClick={() => {
                if (tab === 'fonts') setFontsVisited(true);
                setLeftTab(tab);
              }}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        <button
          className={styles.collapseButton}
          type="button"
          aria-label="Hide left panel"
          title="Hide left panel"
          onClick={toggleLeftCollapsed}
        >
          <span aria-hidden="true">‹</span>
        </button>
      </div>
      <div className={styles.tabContent} role="tabpanel">
        {leftTab === 'objects' && <StructureTree />}
        {leftTab === 'outline' && <BookmarkTree pdfDoc={pdfDocRef} />}
        {fontsMounted && (
          <div className={styles.tabPanel} hidden={leftTab !== 'fonts'}>
            <FontsTab />
          </div>
        )}
        {/* Solo state is component-local, so keeping the panel mounted (like
            Fonts) is what lets a Solo selection survive a tab switch. */}
        <div className={styles.tabPanel} hidden={leftTab !== 'layers'}>
          <LayersPanel />
        </div>
      </div>
    </aside>
  );
};
