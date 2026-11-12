import { useEffect, useState, type ReactNode } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import {
  DEFAULT_LOCALE,
  translate,
  useT,
  type MessageKey,
  type TranslateFn,
} from '../../i18n';
import {
  annotationKindLabel,
  annotationSubtypeLabel,
  formatAnnotationValue,
} from '../../services/annotations';
import { openExternalUrl } from '../../services/external-link';
import { useAnnotationStore } from '../../store/annotation-store';
import type { AnnotationForm, AnnotationKind, PdfAnnotation } from '../../types/annotations';
import type { PageBox } from '../../types/pdf-objects';
import styles from './AnnotationDetails.module.css';

const DASH = '—';

/** Badge colour per kind; mirrors the Annots list and the canvas boxes. */
const KIND_BADGE_CLASSES: Record<AnnotationKind, string> = {
  link: styles.badgeLink,
  form: styles.badgeForm,
  markup: styles.badgeMarkup,
  note: styles.badgeNote,
  stamp: styles.badgeStamp,
  other: styles.badgeOther,
};

/** Form flags worth surfacing, in a stable order. */
const FORM_FLAGS: ReadonlyArray<[keyof AnnotationForm, MessageKey]> = [
  ['readOnly', 'annotation.flag.readOnly'],
  ['required', 'annotation.flag.required'],
  ['checkBox', 'annotation.flag.checkBox'],
  ['radioButton', 'annotation.flag.radioButton'],
  ['pushButton', 'annotation.flag.pushButton'],
  ['multiLine', 'annotation.flag.multiLine'],
  ['combo', 'annotation.flag.combo'],
];

/**
 * English wording of the unsafe-target warning, kept as an export because
 * existing callers/tests compare against it. The UI renders the catalog key so
 * a locale switch still translates the sentence.
 */
export const UNSAFE_TARGET_WARNING: string = translate(
  DEFAULT_LOCALE,
  'annotation.unsafeTarget',
);

/** Field-type labels; unknown values are shown raw so nothing is hidden. */
const FIELD_TYPE_MESSAGE_KEYS: Record<string, MessageKey> = {
  Tx: 'annotation.fieldType.Tx',
  Btn: 'annotation.fieldType.Btn',
  Ch: 'annotation.fieldType.Ch',
  Sig: 'annotation.fieldType.Sig',
};

type LinkError = { kind: 'raw'; message: string } | { kind: 'key'; key: MessageKey };

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(2);

function formatRect(rect: PageBox | null): string {
  if (rect === null) return DASH;
  return `${formatNumber(rect.x0)}, ${formatNumber(rect.y0)} → ${formatNumber(rect.x1)}, ${formatNumber(rect.y1)}`;
}

function fieldTypeLabel(fieldType: string | null, t: TranslateFn): string {
  if (fieldType === null) return DASH;
  const key = FIELD_TYPE_MESSAGE_KEYS[fieldType];
  // Unknown values stay raw so nothing is hidden.
  return key ? t(key) : fieldType;
}

interface SectionProps {
  title: string;
  children: ReactNode;
}

const Section = ({ title, children }: SectionProps): JSX.Element => (
  <section className={styles.section}>
    <h3 className={styles.sectionTitle}>{title}</h3>
    <div className={styles.sectionContent}>{children}</div>
  </section>
);

interface RowProps {
  label: string;
  children: ReactNode;
}

const Row = ({ label, children }: RowProps): JSX.Element => (
  <div className={styles.row}>
    <span className={styles.label}>{label}</span>
    <span className={styles.value}>{children}</span>
  </div>
);

interface AnnotationDetailsProps {
  annotation: PdfAnnotation;
}

/**
 * Read-only details for the annotation selected on the canvas or in the Annots
 * list.
 *
 * Nothing here can modify the document: links only open after an explicit
 * click (and only `http(s)` targets survive the shared URL policy), internal
 * destinations use the guarded page navigation, and form fields are printed as
 * text — there is no input, no form element and no write-back path.
 */
export const AnnotationDetails: React.FC<AnnotationDetailsProps> = ({ annotation }) => {
  const t = useT();
  const setSelected = useAnnotationStore((state) => state.setSelected);
  const { navigate } = usePageNavigation();
  // Opening a link can fail (unsafe target, no handler); the message belongs to
  // this panel, not to the document-wide `pdf-store` error banner. Our own
  // fallback is stored as a key so it follows a locale switch.
  const [linkError, setLinkError] = useState<LinkError | null>(null);

  // A different selection starts clean; an old failure must not describe it.
  useEffect(() => {
    setLinkError(null);
  }, [annotation.id]);

  const link = annotation.link;
  const form = annotation.form;
  const internalPage = link?.internalPage ?? null;
  const unsafeTarget = link !== null && link.url === null && link.unsafeUrl !== null;
  const unresolvedTarget =
    link !== null && link.url === null && link.unsafeUrl === null && internalPage === null;

  const handleOpenLink = async (): Promise<void> => {
    if (link === null || link.url === null) return;
    setLinkError(null);
    const result = await openExternalUrl(link.url);
    if (!result.ok) {
      setLinkError(
        result.error
          ? { kind: 'raw', message: result.error }
          : { kind: 'key', key: 'annotation.openFailed' },
      );
    }
  };

  const handleGoToPage = (): void => {
    if (internalPage === null) return;
    void navigate(internalPage);
  };

  const flags = form === null ? [] : FORM_FLAGS.filter(([key]) => form[key] === true);
  const opacity = annotation.opacity;

  return (
    <div className={styles.details}>
      <Section title={t('annotation.section.annotation')}>
        <Row label={t('annotation.row.kind')}>
          <span className={`${styles.badge} ${KIND_BADGE_CLASSES[annotation.kind]}`}>
            {annotationKindLabel(annotation.kind, t)}
          </span>
        </Row>
        <Row label={t('annotation.row.subtype')}>
          <span title={annotation.subtype}>{annotationSubtypeLabel(annotation.subtype)}</span>
        </Row>
        <Row label={t('annotation.row.page')}>{annotation.page}</Row>
        <Row label={t('annotation.row.rect')}>{formatRect(annotation.rect)}</Row>
        <Row label={t('annotation.row.hidden')}>
          {annotation.hidden ? t('annotation.yes') : t('annotation.no')}
        </Row>
      </Section>

      {(annotation.title !== null ||
        annotation.contents !== null ||
        annotation.modificationDate !== null ||
        annotation.color !== null ||
        opacity !== null) && (
        <Section title={t('annotation.section.content')}>
          {annotation.title !== null && (
            <Row label={t('annotation.row.title')}>{annotation.title}</Row>
          )}
          {annotation.contents !== null && (
            <Row label={t('annotation.row.contents')}>
              <span className={styles.text}>{annotation.contents}</span>
            </Row>
          )}
          {annotation.modificationDate !== null && (
            <Row label={t('annotation.row.modified')}>{annotation.modificationDate}</Row>
          )}
          {annotation.color !== null && (
            <Row label={t('annotation.row.color')}>
              <span className={styles.colorValue}>
                <span className={styles.colorSwatch} style={{ backgroundColor: annotation.color }} />
                {annotation.color}
              </span>
            </Row>
          )}
          {opacity !== null && (
            <Row label={t('annotation.row.opacity')}>{Math.round(opacity * 100)}%</Row>
          )}
        </Section>
      )}

      {link !== null && (
        <Section title={t('annotation.section.link')}>
          {link.url !== null && (
            <Row label={t('annotation.row.target')}>
              <span className={styles.url}>{link.url}</span>
            </Row>
          )}
          {unsafeTarget && (
            <>
              <Row label={t('annotation.row.target')}>
                <span className={styles.unsafeUrl}>{link.unsafeUrl}</span>
              </Row>
              <Row label={t('annotation.row.warning')}>
                <span className={styles.warning}>{t('annotation.unsafeTarget')}</span>
              </Row>
            </>
          )}
          {link.newWindow && (
            <Row label={t('annotation.row.window')}>{t('annotation.newWindow')}</Row>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={link.url === null}
              title={
                link.url === null
                  ? t('annotation.openOnlySafe')
                  : t('annotation.openTitle', { url: link.url })
              }
              onClick={() => void handleOpenLink()}
            >
              {t('annotation.openLink')}
            </button>
            {internalPage !== null && (
              <button type="button" className={styles.button} onClick={handleGoToPage}>
                {t('annotation.goToPage', { page: internalPage })}
              </button>
            )}
          </div>

          {unresolvedTarget && (
            <div className={styles.note}>{t('annotation.noTarget')}</div>
          )}
          {linkError !== null && (
            <div className={styles.error} role="alert">
              {linkError.kind === 'raw' ? linkError.message : t(linkError.key)}
            </div>
          )}
        </Section>
      )}

      {form !== null && (
        <Section title={t('annotation.section.form')}>
          <Row label={t('annotation.row.fieldName')}>{form.fieldName ?? DASH}</Row>
          <Row label={t('annotation.row.fieldType')}>{fieldTypeLabel(form.fieldType, t)}</Row>
          <Row label={t('annotation.row.value')}>
            <span className={styles.text}>
              {formatAnnotationValue(form.value) || DASH}
            </span>
          </Row>
          <Row label={t('annotation.row.default')}>
            <span className={styles.text}>
              {formatAnnotationValue(form.defaultValue) || DASH}
            </span>
          </Row>
          <Row label={t('annotation.row.flags')}>
            {flags.length === 0 ? t('annotation.none') : flags.map(([, key]) => t(key)).join(', ')}
          </Row>
          {form.options.length > 0 && (
            <Row label={t('annotation.row.options')}>
              <ul className={styles.options}>
                {form.options.map((option, index) => (
                  <li className={styles.option} key={`${index}:${option.value}`}>
                    {`${option.label} (${option.value})`}
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {/* A signature field is shown as a field only; nothing is verified. */}
          {form.fieldType === 'Sig' && (
            <div className={styles.note}>{t('annotation.signatureNotVerified')}</div>
          )}
        </Section>
      )}

      <div className={styles.footer}>
        <button type="button" className={styles.button} onClick={() => setSelected(null)}>
          {t('annotation.clearSelection')}
        </button>
      </div>
    </div>
  );
};
