import React, { useEffect, useState } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { StructureTree } from '../StructureTree/StructureTree';
import { BookmarkTree } from './BookmarkTree';
import { FontsTab } from './FontsTab';
import styles from './LeftPanel.module.css';

type Tab = 'structure' | 'bookmarks' | 'fonts';

export const LeftPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('structure');
  // FontsTab owns the batched font analysis, and unmounting it cancels the run.
  // Mount it on the first visit and then keep it mounted (hidden) so navigating
  // through Structure/Bookmarks does not throw the analysis away, while still
  // never analyzing a document the user has not asked about.
  const [fontsVisited, setFontsVisited] = useState(false);
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);

  useEffect(() => {
    if (activeTab === 'fonts') setFontsVisited(true);
  }, [activeTab]);

  const fontsMounted = fontsVisited || activeTab === 'fonts';

  return (
    <aside className={styles.panel} aria-label="Document navigation">
      <div className={styles.tabBar} role="tablist" aria-label="Document navigation tabs">
        <button
          className={`${styles.tabButton} ${activeTab === 'structure' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'structure'}
          onClick={() => setActiveTab('structure')}
        >
          Structure
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'bookmarks' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'bookmarks'}
          onClick={() => setActiveTab('bookmarks')}
        >
          Bookmarks
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'fonts' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'fonts'}
          onClick={() => {
            setFontsVisited(true);
            setActiveTab('fonts');
          }}
        >
          Fonts
        </button>
      </div>
      <div className={styles.tabContent} role="tabpanel">
        {activeTab === 'structure' && <StructureTree />}
        {activeTab === 'bookmarks' && <BookmarkTree pdfDoc={pdfDocRef} />}
        {fontsMounted && (
          <div className={styles.tabPanel} hidden={activeTab !== 'fonts'}>
            <FontsTab />
          </div>
        )}
      </div>
    </aside>
  );
};
