import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { analyzeFontsInBatches, formatFontSize } from '../../services/font-stats';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useT, type MessageKey, type TranslateFn } from '../../i18n';
import { usePdfStore } from '../../store/pdf-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import type { FontStat } from '../../types/ipc-protocol';
import type { FontInfo } from '../../types/pdf-objects';
import styles from './FontsTab.module.css';

type FontRequest = { filePath: string };
type Embedding = FontInfo['embedding'];

const DASH = '—';

/**
 * Embedding state is the primary signal, so it is always the first badge. The
 * words carry the meaning on their own: the colour is a secondary cue for
 * users who can see it, never the only one.
 */
const EMBEDDING_LABEL_KEYS: Record<Embedding, MessageKey> = {
  embedded: 'fonts.embedding.embedded',
  standard14: 'fonts.embedding.standard14',
  'not-embedded': 'fonts.embedding.notEmbedded',
  unknown: 'fonts.embedding.unknown',
};

const EMBEDDING_BADGE_CLASSES: Record<Embedding, string> = {
  embedded: styles.badgeSuccess,
  standard14: styles.badgeMuted,
  'not-embedded': styles.badgeDanger,
  unknown: styles.badgeWarning,
};

interface FontBadge {
  text: string;
  className: string;
  title: string;
}

/**
 * One/other form of a count through a `TranslateFn`. Both catalogs define the
 * two suffixes (Chinese repeats the same text), so the exact comparison is
 * enough for the shipped locales.
 */
const countLabel = (t: TranslateFn, count: number, one: MessageKey, other: MessageKey): string =>
  t(count === 1 ? one : other, { count });

const embeddingLabel = (t: TranslateFn, embedding: Embedding): string =>
  t(EMBEDDING_LABEL_KEYS[embedding]);

/**
 * Two badges at most: the panel is 200–400px wide, so the embedding state and
 * the single most informative secondary fact (subset tag before raw subtype)
 * are shown inline. Everything else lives in the expanded details.
 */
function buildBadges(info: FontInfo | null, t: TranslateFn): FontBadge[] {
  const embedding: Embedding = info?.embedding ?? 'unknown';
  const badges: FontBadge[] = [
    {
      text: embeddingLabel(t, embedding),
      className: EMBEDDING_BADGE_CLASSES[embedding],
      // The value is a schema identifier (embedded/standard14/…) and stays raw.
      title: t('fonts.badge.embeddingTitle', { embedding }),
    },
  ];

  if (info?.subset) {
    badges.push({
      text: t('fonts.badge.subset'),
      className: styles.badgeInfo,
      title: t('fonts.badge.subsetTitle'),
    });
  } else if (info?.subtype) {
    badges.push({
      text: info.subtype,
      className: styles.badgeMuted,
      title: t('fonts.badge.subtypeTitle', { subtype: info.subtype }),
    });
  }

  return badges;
}

function detailValue(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? DASH : value;
}

export const FontsTab: React.FC = () => {
  const t = useT();
  const filePath = usePdfStore((s) => s.filePath);
  const metadata = usePdfStore((s) => s.metadata);
  const pageCount = usePdfStore((s) => s.pageCount);
  const fontStats = usePdfStore((s) => s.fontStats);
  const fontProgress = usePdfStore((s) => s.fontProgress);
  const setFontStats = usePdfStore((s) => s.setFontStats);
  const setFontProgress = usePdfStore((s) => s.setFontProgress);
  const setError = usePdfStore((s) => s.setError);
  const setFilterCriteria = usePdfStore((s) => s.setFilterCriteria);
  const { navigate } = usePageNavigation();
  const [localError, setLocalError] = useState<string | null>(null);
  // Details are expanded per font name and are independent of the row click:
  // toggling them must never navigate or apply a filter.
  const [expandedFonts, setExpandedFonts] = useState<ReadonlySet<string>>(() => new Set());
  // Identifies the request that is allowed to update state. Re-renders caused by
  // progress, fontStats or navigation (isLoading) changes must not start a
  // duplicate run or cancel a multi-batch one, but the in-flight request must
  // still be able to publish its result.
  const inFlightRef = useRef<FontRequest | null>(null);
  // The analysis effect must not depend on the translator (a locale change
  // would restart the run from page 1), so the error copy reads the latest one
  // through a ref instead.
  const tRef = useRef(t);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Resource-dictionary font info arrives with the metadata, i.e. before (and
  // independently of) the batched char analysis. Reading it here must not
  // restart that analysis, so it is deliberately absent from the effect deps.
  const fontInfoByName = useMemo(() => {
    const byName = new Map<string, FontInfo>();
    for (const info of metadata?.fontInfo ?? []) {
      if (!byName.has(info.fontname)) byName.set(info.fontname, info);
    }
    return byName;
  }, [metadata]);

  // A new document starts collapsed; reusing the same source returns the same
  // set instance so this never loops.
  useEffect(() => {
    setExpandedFonts((previous) => (previous.size === 0 ? previous : new Set()));
  }, [filePath]);

  useEffect(() => {
    if (!filePath || fontStats !== null || localError !== null) return;
    // A request for the same document is already running.
    if (inFlightRef.current?.filePath === filePath) return;

    const request: FontRequest = { filePath };
    inFlightRef.current = request;
    const isCurrent = (): boolean => inFlightRef.current === request;

    void (async () => {
      try {
        // Batches are sequential so queued extract_page requests can run in
        // between them instead of waiting for the whole document.
        const result = await analyzeFontsInBatches({
          totalPages: usePdfStore.getState().pageCount,
          fetchBatch: async (startPage, endPage) => (await ipc.analyzeFonts(startPage, endPage)).fonts,
          onProgress: (progress) => {
            if (isCurrent()) setFontProgress(progress);
          },
          isCancelled: () => !isCurrent(),
        });
        // Ignore results that were superseded (e.g. another document was opened)
        // or cancelled: partial results must never be published.
        if (!isCurrent() || result === null) return;
        setFontStats(result);
        setError(null);
      } catch (error) {
        if (!isCurrent()) return;
        // Sidecar messages stay as reported; only the local fallback and the
        // status-bar error are copy.
        setLocalError(
          error instanceof Error ? error.message : tRef.current('fonts.analyzeFailed'),
        );
        setError(tRef.current('fonts.analyzeFailedRetry'));
      } finally {
        if (isCurrent()) {
          inFlightRef.current = null;
          setFontProgress(null);
        }
      }
    })();

    return () => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        setFontProgress(null);
      }
    };
  }, [filePath, fontStats, localError, setError, setFontStats, setFontProgress]);

  const handleRetry = (): void => {
    setLocalError(null);
    setError(null);
  };

  const handleClick = async (font: FontStat): Promise<void> => {
    if (font.pages.length === 0) return;
    // Wait for the page's objects to load before filtering, otherwise the
    // subset is computed from the previous page's allObjects.
    await navigate(font.pages[0]);
    // Words now carry font attributes too; keep the font drill-down focused on
    // character boxes so clicking a font does not double the overlay boxes.
    setFilterCriteria({ fontname: font.fontname, types: ['char'] });
    // The filter is applied immediately; show it instead of leaving the
    // Inspector on Inspect/Results where the user cannot see or clear it.
    useWorkspaceStore.getState().setInspectorTab('filter');
  };

  const toggleDetails = (fontname: string): void => {
    setExpandedFonts((previous) => {
      const next = new Set(previous);
      if (next.has(fontname)) next.delete(fontname);
      else next.add(fontname);
      return next;
    });
  };

  if (!filePath) {
    return <div className={styles.hint}>{t('fonts.noDocument')}</div>;
  }
  if (localError) {
    return (
      <div className={styles.stateBox}>
        <div>{localError}</div>
        <button type="button" className={styles.retry} onClick={handleRetry}>
          {t('common.retry')}
        </button>
      </div>
    );
  }
  if (fontStats === null) {
    const done = fontProgress?.done ?? 0;
    const total = fontProgress?.total ?? pageCount;
    return (
      <div className={styles.stateBox}>
        <div>{t('fonts.analyzing', { done, total })}</div>
        <progress
          className={styles.progress}
          value={done}
          max={Math.max(total, 1)}
          aria-label={t('fonts.progressAria')}
        />
      </div>
    );
  }
  if (fontStats.length === 0) {
    return <div className={styles.stateBox}>{t('fonts.empty')}</div>;
  }

  const hasFontInfo = (metadata?.fontInfo?.length ?? 0) > 0;
  const embeddingOf = (fontname: string): Embedding | undefined =>
    fontInfoByName.get(fontname)?.embedding;
  // Missing/custom fonts are a real problem worth a warning; the Standard 14
  // fonts are fine without a font program, so they get their own count instead
  // of being lumped in with "not embedded".
  const notEmbeddedCount = fontStats.filter(
    (font) => embeddingOf(font.fontname) === 'not-embedded',
  ).length;
  const standard14Count = fontStats.filter(
    (font) => embeddingOf(font.fontname) === 'standard14',
  ).length;
  const summaryParts = [
    countLabel(t, fontStats.length, 'fonts.summary.fonts.one', 'fonts.summary.fonts.other'),
    countLabel(
      t,
      notEmbeddedCount,
      'fonts.summary.notEmbedded.one',
      'fonts.summary.notEmbedded.other',
    ),
  ];
  // A document that only uses Standard 14 would otherwise read
  // "8 fonts · 0 not embedded", which looks like a defect count that is stuck.
  if (standard14Count > 0) {
    summaryParts.push(
      countLabel(
        t,
        standard14Count,
        'fonts.summary.standard14.one',
        'fonts.summary.standard14.other',
      ),
    );
  }

  return (
    <div className={styles.panel}>
      {hasFontInfo && (
        <div
          className={`${styles.summary} ${notEmbeddedCount > 0 ? styles.summaryWarning : ''}`}
        >
          {notEmbeddedCount > 0 && (
            <span className={styles.summaryIcon} aria-hidden="true">⚠</span>
          )}
          <span className={styles.summaryText}>{summaryParts.join(' · ')}</span>
        </div>
      )}
      <ul className={styles.list}>
        {fontStats.map((font, index) => {
          const info = fontInfoByName.get(font.fontname) ?? null;
          const badges = buildBadges(info, t);
          const detailsId = `font-details-${index}`;
          const nameId = `font-name-${index}`;
          const expanded = expandedFonts.has(font.fontname);

          return (
            <li key={font.fontname} className={styles.item}>
              <div className={styles.row}>
                <button
                  type="button"
                  className={styles.rowButton}
                  onClick={() => void handleClick(font)}
                >
                  <span className={styles.name} id={nameId}>{font.fontname}</span>
                  <span className={styles.badges}>
                    {badges.map((badge) => (
                      <span
                        key={`${badge.title}:${badge.text}`}
                        className={`${styles.badge} ${badge.className}`}
                        title={badge.title}
                      >
                        {badge.text}
                      </span>
                    ))}
                  </span>
                  <span className={styles.meta}>
                    {t('fonts.row.meta', {
                      pages: countLabel(
                        t,
                        font.pages.length,
                        'fonts.row.pages.one',
                        'fonts.row.pages.other',
                      ),
                      chars: countLabel(
                        t,
                        font.charCount,
                        'fonts.row.chars.one',
                        'fonts.row.chars.other',
                      ),
                      sizes: `${formatFontSize(font.sizeMin)}–${formatFontSize(font.sizeMax)}`,
                    })}
                  </span>
                  <span className={styles.swatches}>
                    {font.colors.slice(0, 4).map((color) => (
                      <span key={color} className={styles.swatch} style={{ backgroundColor: color }} title={color} />
                    ))}
                  </span>
                </button>
                {/* Sibling, not a child, of the row button: expanding the
                    details must not trigger the row's navigate/filter click. */}
                <button
                  type="button"
                  className={styles.detailsToggle}
                  aria-expanded={expanded}
                  aria-controls={detailsId}
                  aria-label={t('fonts.detailsAria')}
                  aria-describedby={nameId}
                  title={expanded ? t('fonts.detailsHide') : t('fonts.detailsShow')}
                  onClick={() => toggleDetails(font.fontname)}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                </button>
              </div>
              {expanded && (
                <dl className={styles.details} id={detailsId}>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.embedding')}</dt>
                    <dd>{embeddingLabel(t, info?.embedding ?? 'unknown')}</dd>
                  </div>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.subtype')}</dt>
                    <dd>{detailValue(info?.subtype)}</dd>
                  </div>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.subset')}</dt>
                    <dd>{info ? (info.subset ? t('fonts.yes') : t('fonts.no')) : DASH}</dd>
                  </div>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.encoding')}</dt>
                    <dd>{detailValue(info?.encoding)}</dd>
                  </div>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.toUnicode')}</dt>
                    <dd>{info ? (info.hasToUnicode ? t('fonts.yes') : t('fonts.no')) : DASH}</dd>
                  </div>
                  <div className={styles.detailRow}>
                    <dt>{t('fonts.detail.fontFile')}</dt>
                    <dd>{detailValue(info?.fontFileType)}</dd>
                  </div>
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
