import { useEffect, useState, type ReactNode } from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
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
const FORM_FLAGS: ReadonlyArray<[keyof AnnotationForm, string]> = [
  ['readOnly', 'Read only'],
  ['required', 'Required'],
  ['checkBox', 'Check box'],
  ['radioButton', 'Radio button'],
  ['pushButton', 'Push button'],
  ['multiLine', 'Multi-line'],
  ['combo', 'Combo box'],
];

/** Shown instead of an action when PDF.js only had an unsafe target. */
export const UNSAFE_TARGET_WARNING =
  'Only http(s) links can be opened. This target is display-only.';

/** Field-type labels; unknown values are shown raw so nothing is hidden. */
const FIELD_TYPE_LABELS: Record<string, string> = {
  Tx: 'Text (Tx)',
  Btn: 'Button (Btn)',
  Ch: 'Choice (Ch)',
  Sig: 'Signature (Sig)',
};

const formatNumber = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(2);

function formatRect(rect: PageBox | null): string {
  if (rect === null) return DASH;
  return `${formatNumber(rect.x0)}, ${formatNumber(rect.y0)} → ${formatNumber(rect.x1)}, ${formatNumber(rect.y1)}`;
}

function fieldTypeLabel(fieldType: string | null): string {
  if (fieldType === null) return DASH;
  return FIELD_TYPE_LABELS[fieldType] ?? fieldType;
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
  const setSelected = useAnnotationStore((state) => state.setSelected);
  const { navigate } = usePageNavigation();
  // Opening a link can fail (unsafe target, no handler); the message belongs to
  // this panel, not to the document-wide `pdf-store` error banner.
  const [linkError, setLinkError] = useState<string | null>(null);

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
    if (!result.ok) setLinkError(result.error ?? 'Could not open the link');
  };

  const handleGoToPage = (): void => {
    if (internalPage === null) return;
    void navigate(internalPage);
  };

  const flags = form === null ? [] : FORM_FLAGS.filter(([key]) => form[key] === true);
  const opacity = annotation.opacity;

  return (
    <div className={styles.details}>
      <Section title="Annotation">
        <Row label="Kind">
          <span className={`${styles.badge} ${KIND_BADGE_CLASSES[annotation.kind]}`}>
            {annotationKindLabel(annotation.kind)}
          </span>
        </Row>
        <Row label="Subtype">
          <span title={annotation.subtype}>{annotationSubtypeLabel(annotation.subtype)}</span>
        </Row>
        <Row label="Page">{annotation.page}</Row>
        <Row label="Rect">{formatRect(annotation.rect)}</Row>
        <Row label="Hidden">{annotation.hidden ? 'Yes' : 'No'}</Row>
      </Section>

      {(annotation.title !== null ||
        annotation.contents !== null ||
        annotation.modificationDate !== null ||
        annotation.color !== null ||
        opacity !== null) && (
        <Section title="Content">
          {annotation.title !== null && <Row label="Title">{annotation.title}</Row>}
          {annotation.contents !== null && (
            <Row label="Contents">
              <span className={styles.text}>{annotation.contents}</span>
            </Row>
          )}
          {annotation.modificationDate !== null && (
            <Row label="Modified">{annotation.modificationDate}</Row>
          )}
          {annotation.color !== null && (
            <Row label="Color">
              <span className={styles.colorValue}>
                <span className={styles.colorSwatch} style={{ backgroundColor: annotation.color }} />
                {annotation.color}
              </span>
            </Row>
          )}
          {opacity !== null && (
            <Row label="Opacity">{Math.round(opacity * 100)}%</Row>
          )}
        </Section>
      )}

      {link !== null && (
        <Section title="Link">
          {link.url !== null && (
            <Row label="Target">
              <span className={styles.url}>{link.url}</span>
            </Row>
          )}
          {unsafeTarget && (
            <>
              <Row label="Target">
                <span className={styles.unsafeUrl}>{link.unsafeUrl}</span>
              </Row>
              <Row label="Warning">
                <span className={styles.warning}>{UNSAFE_TARGET_WARNING}</span>
              </Row>
            </>
          )}
          {link.newWindow && <Row label="Window">New window</Row>}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.button}
              disabled={link.url === null}
              title={
                link.url === null
                  ? 'Only http(s) links can be opened'
                  : `Open ${link.url} in the default browser`
              }
              onClick={() => void handleOpenLink()}
            >
              Open link
            </button>
            {internalPage !== null && (
              <button type="button" className={styles.button} onClick={handleGoToPage}>
                Go to page {internalPage}
              </button>
            )}
          </div>

          {unresolvedTarget && (
            <div className={styles.note}>No resolvable link target.</div>
          )}
          {linkError !== null && (
            <div className={styles.error} role="alert">
              {linkError}
            </div>
          )}
        </Section>
      )}

      {form !== null && (
        <Section title="Form field">
          <Row label="Field name">{form.fieldName ?? DASH}</Row>
          <Row label="Field type">{fieldTypeLabel(form.fieldType)}</Row>
          <Row label="Value">
            <span className={styles.text}>
              {formatAnnotationValue(form.value) || DASH}
            </span>
          </Row>
          <Row label="Default">
            <span className={styles.text}>
              {formatAnnotationValue(form.defaultValue) || DASH}
            </span>
          </Row>
          <Row label="Flags">
            {flags.length === 0 ? 'None' : flags.map(([, label]) => label).join(', ')}
          </Row>
          {form.options.length > 0 && (
            <Row label="Options">
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
            <div className={styles.note}>Signature not verified.</div>
          )}
        </Section>
      )}

      <div className={styles.footer}>
        <button type="button" className={styles.button} onClick={() => setSelected(null)}>
          Clear selection
        </button>
      </div>
    </div>
  );
};
