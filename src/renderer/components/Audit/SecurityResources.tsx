import React from 'react';
import type {
  SecurityAction,
  SecurityAttachment,
  SecurityEncryption,
  SecurityJavaScript,
  SecurityPermissions,
  SecuritySignature,
} from '../../../shared/security-types';
import {
  translatePlural,
  useI18nStore,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import { useSecurityStore } from '../../store/security-store';
import styles from './SecurityResources.module.css';

/**
 * The Audit `Resources` view: a read-only inventory of document-level security
 * resources (attachments, JavaScript, actions, signatures, encryption).
 *
 * Nothing here executes, opens, downloads or verifies anything: scripts are
 * shown as inert text in a `<pre>`, attachments only expose metadata, and the
 * signature section states that no cryptographic verification was performed.
 * The data itself comes from `security-store`, which owns the request, the
 * per-file cache and the error state.
 */

export interface SecurityResourcesProps {
  /**
   * The document Audit is showing, or null when Audit has no document.
   *
   * Passed in rather than read from `security-store`: on the first switch to
   * Resources the store has not opened the file yet (`open()` runs in an
   * effect after this paint), so without the audit document the view could not
   * tell "no document" apart from "document not read yet".
   */
  filePath: string | null;
  /**
   * Switch the Audit workspace back to Findings with the category filter set
   * to `security` (see `AuditWorkspace`).
   */
  onViewInFindings: () => void;
}

const DASH = '—';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Byte count as a short, locale-independent size (`1.5 KB`).
 *
 * The engine reports a declared stream size; there is no locale-aware
 * formatting here so a resource list stays comparable between locales.
 */
export function formatByteSize(size: number | null): string {
  if (size === null || !Number.isFinite(size) || size < 0) return DASH;
  if (size < 1024) return `${Math.round(size)} B`;

  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** First 12 hex digits of a SHA-256 hash; the full value lives in `title`. */
export function shortSha256(hash: string | null): string {
  if (hash === null || hash === '') return DASH;
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`;
}

/**
 * `Page 7` for a page-bound resource, `Document` for a document-level one.
 *
 * A local twin of `auditPageLabel` in `AuditWorkspace`: importing it would
 * create an import cycle between the workspace and this view.
 */
const resourcePageLabel = (page: number | null, t: TranslateFn): string =>
  page === null ? t('audit.page.document') : t('audit.page.page', { page });

const RiskBadge: React.FC<{ risky: boolean }> = ({ risky }) => {
  const t = useT();
  if (!risky) return <span className={styles.muted}>{DASH}</span>;
  return (
    <span className={styles.riskBadge} data-risky="true">
      {t('audit.resources.risky')}
    </span>
  );
};

const AttachmentsSection: React.FC<{ attachments: SecurityAttachment[] }> = ({
  attachments,
}) => {
  const t = useT();

  return (
    <section className={styles.section} aria-label={t('audit.resources.attachmentsCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.attachments')}</h3>

      {attachments.length === 0 ? (
        <p className={styles.empty}>{t('audit.resources.attachmentsEmpty')}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} data-testid="security-attachments">
            <caption className={styles.visuallyHidden}>
              {t('audit.resources.attachmentsCaption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('audit.resources.column.name')}</th>
                <th scope="col">{t('audit.resources.column.description')}</th>
                <th scope="col">{t('audit.resources.column.size')}</th>
                <th scope="col">{t('audit.resources.column.mime')}</th>
                <th scope="col">{t('audit.resources.column.modified')}</th>
                <th scope="col">{t('audit.resources.column.sha256')}</th>
                <th scope="col">{t('audit.resources.column.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {attachments.map((attachment, index) => (
                <tr key={`${attachment.name}:${index}`}>
                  <td className={styles.nameCell} title={attachment.name}>
                    {attachment.name}
                  </td>
                  <td className={styles.wrapCell} title={attachment.description ?? undefined}>
                    {attachment.description ?? DASH}
                  </td>
                  <td className={styles.numericCell}>{formatByteSize(attachment.size)}</td>
                  <td>{attachment.mimeType ?? DASH}</td>
                  <td>{attachment.modified ?? DASH}</td>
                  <td
                    className={styles.hashCell}
                    title={attachment.sha256 ?? undefined}
                    data-testid={`security-attachment-hash-${index}`}
                  >
                    {shortSha256(attachment.sha256)}
                  </td>
                  <td>
                    <RiskBadge risky={attachment.risky} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>{t('audit.resources.attachmentsNote')}</p>
    </section>
  );
};

const JavaScriptSection: React.FC<{ entries: SecurityJavaScript[] }> = ({ entries }) => {
  const t = useT();

  return (
    <section className={styles.section} aria-label={t('audit.resources.javascriptCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.javascript')}</h3>

      {entries.length === 0 ? (
        <p className={styles.empty}>{t('audit.resources.javascriptEmpty')}</p>
      ) : (
        <ul className={styles.scriptList}>
          {entries.map((entry, index) => (
            <li key={`${entry.location}:${index}`} className={styles.scriptItem}>
              <div className={styles.scriptMeta}>
                <span className={styles.scriptName} title={entry.name ?? undefined}>
                  {entry.name ?? t('audit.resources.unnamed')}
                </span>
                <span className={styles.scriptLocation}>{entry.location}</span>
                <span className={styles.scriptPage}>{resourcePageLabel(entry.page, t)}</span>
              </div>

              {entry.truncated && (
                <p className={styles.note}>{t('audit.resources.scriptTruncated')}</p>
              )}

              {/* Inert text: the source is never evaluated, parsed or executed. */}
              <pre
                className={styles.script}
                tabIndex={0}
                aria-label={t('audit.resources.scriptAria', { index: index + 1 })}
                data-testid={`security-script-${index}`}
              >
                {entry.source}
              </pre>
            </li>
          ))}
        </ul>
      )}

      <p className={styles.note}>{t('audit.resources.previewOnly')}</p>
    </section>
  );
};

const ActionsSection: React.FC<{ actions: SecurityAction[] }> = ({ actions }) => {
  const t = useT();

  return (
    <section className={styles.section} aria-label={t('audit.resources.actionsCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.actions')}</h3>

      {actions.length === 0 ? (
        <p className={styles.empty}>{t('audit.resources.actionsEmpty')}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} data-testid="security-actions">
            <caption className={styles.visuallyHidden}>
              {t('audit.resources.actionsCaption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('audit.resources.column.location')}</th>
                <th scope="col">{t('audit.resources.column.page')}</th>
                <th scope="col">{t('audit.resources.column.subtype')}</th>
                <th scope="col">{t('audit.resources.column.target')}</th>
                <th scope="col">{t('audit.resources.column.risk')}</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action, index) => (
                <tr key={`${action.location}:${action.subtype}:${index}`}>
                  <td className={styles.wrapCell}>{action.location}</td>
                  <td className={styles.numericCell}>{resourcePageLabel(action.page, t)}</td>
                  {/* Schema values (`JavaScript`, `Launch`, …) stay as reported. */}
                  <td>{action.subtype}</td>
                  <td className={styles.wrapCell} title={action.target ?? undefined}>
                    {action.target ?? DASH}
                  </td>
                  <td>
                    <RiskBadge risky={action.risky} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={styles.note}>{t('audit.resources.actionsNote')}</p>
    </section>
  );
};

const byteRangeLabel = (valid: boolean | null, t: TranslateFn): string => {
  if (valid === null) return DASH;
  return valid
    ? t('audit.resources.byteRangeComplete')
    : t('audit.resources.byteRangeIncomplete');
};

const SignaturesSection: React.FC<{ signatures: SecuritySignature[] }> = ({ signatures }) => {
  const t = useT();

  return (
    <section className={styles.section} aria-label={t('audit.resources.signaturesCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.signatures')}</h3>

      {/* Fixed notice: the presence of a signature is not evidence of validity. */}
      <p className={styles.warningNote} data-testid="security-signature-not-verified">
        {t('audit.resources.signatureNotVerified')}
      </p>

      {signatures.length === 0 ? (
        <p className={styles.empty}>{t('audit.resources.signaturesEmpty')}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} data-testid="security-signatures">
            <caption className={styles.visuallyHidden}>
              {t('audit.resources.signaturesCaption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('audit.resources.column.field')}</th>
                <th scope="col">{t('audit.resources.column.page')}</th>
                <th scope="col">{t('audit.resources.column.signer')}</th>
                <th scope="col">{t('audit.resources.column.signedAt')}</th>
                <th scope="col">{t('audit.resources.column.subFilter')}</th>
                <th scope="col">{t('audit.resources.column.byteRange')}</th>
              </tr>
            </thead>
            <tbody>
              {signatures.map((signature, index) => (
                <tr key={`${signature.fieldName ?? DASH}:${index}`}>
                  <td className={styles.nameCell} title={signature.fieldName ?? undefined}>
                    {signature.fieldName ?? DASH}
                  </td>
                  <td className={styles.numericCell}>{resourcePageLabel(signature.page, t)}</td>
                  <td className={styles.wrapCell} title={signature.signer ?? undefined}>
                    {signature.signer ?? DASH}
                  </td>
                  <td>{signature.signedAt ?? DASH}</td>
                  <td>{signature.subFilter ?? DASH}</td>
                  <td>{byteRangeLabel(signature.byteRangeValid, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

type PermissionField = Exclude<keyof SecurityPermissions, 'raw'>;

/** Permission bits in PDF spec order; the labels are catalog keys, keys stay English. */
const PERMISSION_FIELDS: ReadonlyArray<{ field: PermissionField; labelKey: MessageKey }> = [
  { field: 'print', labelKey: 'audit.resources.permission.print' },
  { field: 'modify', labelKey: 'audit.resources.permission.modify' },
  { field: 'copy', labelKey: 'audit.resources.permission.copy' },
  { field: 'annotate', labelKey: 'audit.resources.permission.annotate' },
  { field: 'fillForms', labelKey: 'audit.resources.permission.fillForms' },
  { field: 'accessibility', labelKey: 'audit.resources.permission.accessibility' },
  { field: 'assemble', labelKey: 'audit.resources.permission.assemble' },
  { field: 'highQualityPrint', labelKey: 'audit.resources.permission.highQualityPrint' },
];

/** `null` means "the bit could not be read", not "allowed". */
const PERMISSION_STATE_KEYS: Record<'granted' | 'denied' | 'unknown', MessageKey> = {
  granted: 'audit.resources.permission.granted',
  denied: 'audit.resources.permission.denied',
  unknown: 'audit.resources.permission.unknown',
};

const permissionState = (value: boolean | null): keyof typeof PERMISSION_STATE_KEYS =>
  value === null ? 'unknown' : value ? 'granted' : 'denied';

const EncryptionSection: React.FC<{ encryption: SecurityEncryption | null }> = ({
  encryption,
}) => {
  const t = useT();

  return (
    <section className={styles.section} aria-label={t('audit.resources.encryptionCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.encryption')}</h3>

      {encryption === null ? (
        <p className={styles.empty}>{t('audit.resources.noEncryption')}</p>
      ) : (
        <>
          <dl className={styles.facts} data-testid="security-encryption">
            <div className={styles.fact}>
              <dt>{t('audit.resources.column.filter')}</dt>
              <dd>{encryption.filter ?? DASH}</dd>
            </div>
            <div className={styles.fact}>
              <dt>{t('audit.resources.column.version')}</dt>
              <dd>{encryption.version ?? DASH}</dd>
            </div>
            <div className={styles.fact}>
              <dt>{t('audit.resources.column.revision')}</dt>
              <dd>{encryption.revision ?? DASH}</dd>
            </div>
            <div className={styles.fact}>
              <dt>{t('audit.resources.keyLength')}</dt>
              <dd>
                {encryption.keyLength === null
                  ? DASH
                  : t('audit.resources.bits', { bits: encryption.keyLength })}
              </dd>
            </div>
          </dl>

          <ul
            className={styles.permissions}
            aria-label={t('audit.resources.permissionsLabel')}
            data-testid="security-permissions"
          >
            {PERMISSION_FIELDS.map(({ field, labelKey }) => {
              const state = permissionState(encryption.permissions[field]);
              return (
                <li
                  key={field}
                  className={styles.permissionBadge}
                  data-state={state}
                  data-permission={field}
                  title={`${t(labelKey)}: ${t(PERMISSION_STATE_KEYS[state])}`}
                >
                  {t(labelKey)}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
};

const FindingsSection: React.FC<{
  total: number;
  errors: number;
  warnings: number;
  info: number;
  onViewInFindings: () => void;
}> = ({ total, errors, warnings, info, onViewInFindings }) => {
  const t = useT();
  const locale = useI18nStore((s) => s.locale);

  return (
    <section className={styles.section} aria-label={t('audit.resources.findingsCaption')}>
      <h3 className={styles.sectionTitle}>{t('audit.resources.findingsCaption')}</h3>

      {total === 0 ? (
        <p className={styles.empty}>{t('audit.resources.findingsEmpty')}</p>
      ) : (
        <p className={styles.listCount}>{translatePlural(locale, 'audit.resources.findingCount', total)}</p>
      )}

      <dl
        className={styles.findingCounts}
        aria-label={t('audit.resources.findingsCountsLabel')}
        data-testid="security-findings-counts"
      >
        <div className={styles.fact}>
          <dt>{t('audit.summary.errors')}</dt>
          <dd data-severity="error">{errors}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('audit.summary.warnings')}</dt>
          <dd data-severity="warning">{warnings}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('audit.summary.info')}</dt>
          <dd data-severity="info">{info}</dd>
        </div>
      </dl>

      <button
        className={styles.button}
        type="button"
        onClick={onViewInFindings}
        // Nothing to show in Findings when the document is clean, so the jump
        // would only replace the list with "no findings match".
        disabled={total === 0}
        title={t('audit.resources.viewInFindingsTitle')}
      >
        {t('audit.resources.viewInFindings')}
      </button>
    </section>
  );
};

export const SecurityResources: React.FC<SecurityResourcesProps> = ({
  filePath,
  onViewInFindings,
}) => {
  const t = useT();
  const openedFilePath = useSecurityStore((s) => s.filePath);
  const report = useSecurityStore((s) => s.report);
  const loading = useSecurityStore((s) => s.loading);
  const error = useSecurityStore((s) => s.error);
  const load = useSecurityStore((s) => s.load);

  // Audit has no document at all: the genuine empty state.
  if (filePath === null) {
    return (
      <div className={styles.container} data-testid="security-resources">
        <p className={styles.empty} data-testid="security-empty">
          {t('audit.resources.noFile')}
        </p>
      </div>
    );
  }

  // Audit does have a document, but `security-store` has not opened it yet (or
  // still holds another file). `AuditWorkspace` calls `open()` right after this
  // paint, so the first frame must read as loading — and must never show the
  // resources of a document that is no longer on screen.
  const opened = openedFilePath === filePath;

  // A failed refresh keeps the inventory that is already on screen: only a
  // document that has no report at all turns into a pure error state.
  const errorBox = opened && error !== null && (
    <div className={styles.errorBox} role="alert">
      <p className={styles.errorText}>{t('audit.resources.failed', { error })}</p>
      <button
        className={styles.button}
        type="button"
        onClick={() => void load(true)}
        disabled={loading}
      >
        {t('common.retry')}
      </button>
    </div>
  );

  if (!opened || report === null) {
    return (
      <div className={styles.container} data-testid="security-resources">
        {errorBox || (
          <p className={styles.progress} role="status" aria-live="polite">
            {t('audit.resources.loading')}
          </p>
        )}
      </div>
    );
  }

  const cards: Array<{ key: string; labelKey: MessageKey; value: string }> = [
    {
      key: 'attachments',
      labelKey: 'audit.resources.attachments',
      value: String(report.attachments.length),
    },
    {
      key: 'javascript',
      labelKey: 'audit.resources.javascript',
      value: String(report.javascript.length),
    },
    { key: 'actions', labelKey: 'audit.resources.actions', value: String(report.actions.length) },
    {
      key: 'signatures',
      labelKey: 'audit.resources.signatures',
      value: String(report.signatures.length),
    },
    {
      key: 'encryption',
      labelKey: 'audit.resources.encryption',
      value: report.encryption
        ? t('audit.resources.encrypted')
        : t('audit.resources.notEncrypted'),
    },
    {
      key: 'xfa',
      labelKey: 'audit.resources.xfa',
      value: report.document.xfa
        ? t('audit.resources.xfaPresent')
        : t('audit.resources.xfaAbsent'),
    },
  ];

  return (
    <div className={styles.container} data-testid="security-resources">
      {errorBox}

      <dl
        className={styles.summary}
        aria-label={t('audit.resources.summaryLabel')}
        data-testid="security-summary"
      >
        {cards.map((card) => (
          <div key={card.key} className={styles.summaryCard} data-card={card.key}>
            <dt className={styles.summaryLabel}>{t(card.labelKey)}</dt>
            <dd className={styles.summaryValue}>{card.value}</dd>
          </div>
        ))}
      </dl>

      <AttachmentsSection attachments={report.attachments} />
      <JavaScriptSection entries={report.javascript} />
      <ActionsSection actions={report.actions} />
      <SignaturesSection signatures={report.signatures} />
      <EncryptionSection encryption={report.encryption} />
      <FindingsSection
        total={report.summary.total}
        errors={report.summary.errors}
        warnings={report.summary.warnings}
        info={report.summary.info}
        onViewInFindings={onViewInFindings}
      />
    </div>
  );
};
