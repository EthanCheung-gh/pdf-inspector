import React, { useState } from 'react';
import { usePdfStore } from '../../store/pdf-store';
import { StructureTree } from '../StructureTree/StructureTree';
import { BookmarkTree } from './BookmarkTree';
import { FontsTab } from './FontsTab';
import styles from './LeftPanel.module.css';

type Tab = 'structure' | 'bookmarks' | 'fonts';

export const LeftPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('structure');
  const pdfDocRef = usePdfStore((s) => s.pdfDocRef);

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
          onClick={() => setActiveTab('fonts')}
        >
          Fonts
        </button>
      </div>
      <div className={styles.tabContent} role="tabpanel">
        {activeTab === 'structure' ? <StructureTree /> : activeTab === 'bookmarks' ? <BookmarkTree pdfDoc={pdfDocRef} /> : <FontsTab />}
      </div>
    </aside>
  );
};
