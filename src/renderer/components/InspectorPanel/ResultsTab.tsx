import { useT } from "../../i18n";
import { objectsToCsv, objectsToJson, suggestFilename } from "../../services/export-data";
import { ipc } from "../../services/ipc-client";
import { filterByRegion } from "../../services/object-filter";
import { usePdfStore } from "../../store/pdf-store";
import { useWorkspaceStore } from "../../store/workspace-store";
import type { PdfObject, PdfObjectType } from "../../types/pdf-objects";
import { ExportTypeSelector } from "../ExportTypeSelector";
import styles from "./InspectorPanel.module.css";

interface ResultsTabProps {
  /** Export type selection lives in the tab shell so it survives tab switches. */
  exportTypes: PdfObjectType[];
  onExportTypesChange: (types: PdfObjectType[]) => void;
}

export const ResultsTab = ({ exportTypes, onExportTypesChange }: ResultsTabProps): JSX.Element => {
  const t = useT();
  const subset = usePdfStore((state) => state.subset);
  const setSubset = usePdfStore((state) => state.setSubset);
  const clearSubset = usePdfStore((state) => state.clearSubset);
  const setSelectedObject = usePdfStore((state) => state.setSelectedObject);
  const setInspectorTab = useWorkspaceStore((state) => state.setInspectorTab);

  const applyRegionMode = (mode: "intersect" | "contain"): void => {
    if (!subset || !subset.bbox) return;
    const allObjects = usePdfStore.getState().allObjects;
    setSubset({ ...subset, mode, objects: filterByRegion(allObjects, subset.bbox, mode) });
  };

  const handleExport = async (ext: "json" | "csv"): Promise<void> => {
    const state = usePdfStore.getState();
    if (!state.subset || !state.filePath) return;
    const content =
      ext === "json"
        ? objectsToJson(state.subset.objects, state.metadata, state.currentPage, exportTypes)
        : objectsToCsv(state.subset.objects, state.currentPage, exportTypes);
    try {
      const result = await ipc.saveFile({
        defaultPath: suggestFilename(state.filePath, "page", state.currentPage, ext, state.sourceUrl),
        content,
        filterName: ext.toUpperCase(),
        extensions: [ext],
      });
      if (!result.canceled && result.error) {
        usePdfStore.getState().setError(result.error);
      }
    } catch (error) {
      usePdfStore
        .getState()
        .setError(error instanceof Error ? error.message : t("results.exportFailed"));
    }
  };

  const selectResult = (item: PdfObject): void => {
    setSelectedObject(item);
    setInspectorTab("inspect");
  };

  return (
    <div className={styles.content}>
      {!subset && <div className={styles.emptyState}>{t("results.empty")}</div>}

      {subset && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            {t("results.heading", {
              count: subset.objects.length,
              source: t(
                subset.source === "region" ? "results.source.region" : "results.source.filter",
              ),
            })}
            <button type="button" className={styles.titleButton} onClick={clearSubset}>
              {t("results.clear")}
            </button>
          </h3>
          <div className={styles.sectionContent}>
            {subset.source === "region" && (
              <div className={styles.row} role="radiogroup" aria-label={t("results.regionMode")}>
                <label className={styles.checkLabel}>
                  <input
                    type="radio"
                    name="region-mode"
                    value="intersect"
                    checked={subset.mode === "intersect"}
                    onChange={() => applyRegionMode("intersect")}
                  />
                  {t("results.intersect")}
                </label>
                <label className={styles.checkLabel}>
                  <input
                    type="radio"
                    name="region-mode"
                    value="contain"
                    checked={subset.mode === "contain"}
                    onChange={() => applyRegionMode("contain")}
                  />
                  {t("results.contain")}
                </label>
              </div>
            )}
            <div className={styles.resultList}>
              {subset.objects.length === 0 && (
                <div className={styles.resultsEmpty}>{t("results.noObjects")}</div>
              )}
              {subset.objects.map((item, index) => (
                <button
                  key={index}
                  type="button"
                  className={styles.resultItem}
                  onClick={() => selectResult(item)}
                >
                  [{item.type}]{" "}
                  {"text" in item
                    ? item.text
                    : `${item.x0},${item.y0} → ${item.x1},${item.y1}`}
                </button>
              ))}
            </div>
            <div className={styles.exportTypes}>
              <ExportTypeSelector
                label={t("results.exportTypes")}
                compact
                selected={exportTypes}
                onChange={onExportTypesChange}
              />
            </div>
            <div className={styles.buttonRow}>
              <button
                type="button"
                className={styles.button}
                disabled={exportTypes.length === 0}
                onClick={() => void handleExport("json")}
              >
                {t("results.exportJson")}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={exportTypes.length === 0}
                onClick={() => void handleExport("csv")}
              >
                {t("results.exportCsv")}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
