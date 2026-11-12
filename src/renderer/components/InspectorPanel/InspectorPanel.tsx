import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useT, type MessageKey } from "../../i18n";
import { EXPORT_OBJECT_TYPES } from "../../services/export-data";
import { describeFilterCriteria } from "../../services/filter-summary";
import { usePdfStore } from "../../store/pdf-store";
import {
  INSPECTOR_TABS,
  useWorkspaceStore,
  type InspectorTab,
} from "../../store/workspace-store";
import type { PdfObjectType } from "../../types/pdf-objects";
import { FilterTab } from "./FilterTab";
import { InspectTab } from "./InspectTab";
import { PageTab } from "./PageTab";
import { ResultsTab } from "./ResultsTab";
import styles from "./InspectorPanel.module.css";

const TAB_LABEL_KEYS: Record<InspectorTab, MessageKey> = {
  inspect: "inspector.tab.inspect",
  filter: "inspector.tab.filter",
  results: "inspector.tab.results",
  page: "inspector.tab.page",
};

export const InspectorPanel = (): JSX.Element => {
  const t = useT();
  const inspectorTab = useWorkspaceStore((state) => state.inspectorTab);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);
  const toggleRightCollapsed = useWorkspaceStore((state) => state.toggleRightCollapsed);
  const filterCriteria = usePdfStore((state) => state.filterCriteria);
  const subset = usePdfStore((state) => state.subset);
  // Which object types the Results export contains; every type until changed.
  // Kept in the shell so the value survives tab switches (the panels also stay
  // mounted, mirroring the Fonts keep-alive pattern in LeftPanel).
  const [exportTypes, setExportTypes] = useState<PdfObjectType[]>([...EXPORT_OBJECT_TYPES]);
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});

  const filterCount = describeFilterCriteria(filterCriteria, t).count;
  const resultsCount = subset ? subset.objects.length : null;
  const counts: Record<InspectorTab, number | null> = {
    inspect: null,
    filter: filterCount > 0 ? filterCount : null,
    results: resultsCount,
    page: null,
  };

  const tabId = (tab: InspectorTab): string => `${baseId}-${tab}-tab`;
  const panelId = (tab: InspectorTab): string => `${baseId}-${tab}-panel`;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % INSPECTOR_TABS.length;
        break;
      case "ArrowLeft":
        nextIndex = (index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = INSPECTOR_TABS.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = INSPECTOR_TABS[nextIndex];
    setInspectorTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <aside className={styles.panel} aria-label={t("inspector.aria")}>
      {/* The tablist keeps only tabs; the collapse control is its sibling so the
          keyed tab navigation stays a single, unambiguous group. */}
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label={t("inspector.tabsAria")}>
          {INSPECTOR_TABS.map((tab, index) => {
            const active = inspectorTab === tab;
            const count = counts[tab];
            const label = t(TAB_LABEL_KEYS[tab]);

            return (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node;
                }}
                className={`${styles.tab} ${active ? styles.activeTab : ""}`}
                type="button"
                role="tab"
                id={tabId(tab)}
                aria-selected={active}
                aria-controls={panelId(tab)}
                aria-label={
                  count === null ? label : t("inspector.tabAria", { label, count })
                }
                tabIndex={active ? 0 : -1}
                onClick={() => setInspectorTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span>{label}</span>
                {count !== null && (
                  <span className={styles.tabCount} aria-hidden="true">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <button
          className={styles.collapseButton}
          type="button"
          aria-label={t("inspector.hide")}
          title={t("inspector.hide")}
          onClick={toggleRightCollapsed}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div
        className={styles.tabPanel}
        role="tabpanel"
        id={panelId("inspect")}
        aria-labelledby={tabId("inspect")}
        hidden={inspectorTab !== "inspect"}
      >
        <InspectTab />
      </div>
      <div
        className={styles.tabPanel}
        role="tabpanel"
        id={panelId("filter")}
        aria-labelledby={tabId("filter")}
        hidden={inspectorTab !== "filter"}
      >
        <FilterTab />
      </div>
      <div
        className={styles.tabPanel}
        role="tabpanel"
        id={panelId("results")}
        aria-labelledby={tabId("results")}
        hidden={inspectorTab !== "results"}
      >
        <ResultsTab exportTypes={exportTypes} onExportTypesChange={setExportTypes} />
      </div>
      <div
        className={styles.tabPanel}
        role="tabpanel"
        id={panelId("page")}
        aria-labelledby={tabId("page")}
        hidden={inspectorTab !== "page"}
      >
        <PageTab />
      </div>
    </aside>
  );
};
