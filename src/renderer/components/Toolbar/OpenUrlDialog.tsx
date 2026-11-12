import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useT, type TranslateFn } from '../../i18n';
import { ipc } from '../../services/ipc-client';
import type { OpenPdfResult } from '../../types/ipc-protocol';
import styles from './OpenUrlDialog.module.css';

export type OpenedFromUrl = Extract<OpenPdfResult, { canceled: false }>;

export interface OpenUrlDialogProps {
  open: boolean;
  onClose: () => void;
  onOpened: (result: OpenedFromUrl) => void | Promise<void>;
}

type Validation = { url: string } | { error: string };

function validateUrl(raw: string, t: TranslateFn): Validation {
  const trimmed = raw.trim();
  if (!trimmed) return { error: t('openUrl.invalid') };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: t('openUrl.invalid') };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: t('openUrl.unsupported') };
  }

  return { url: trimmed };
}

export const OpenUrlDialog: React.FC<OpenUrlDialogProps> = ({ open, onClose, onOpened }) => {
  const t = useT();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();

  // Fresh dialog state and focus every time it is opened.
  useEffect(() => {
    if (!open) return;
    setValue('');
    setError(null);
    setBusy(false);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Capture phase so the app-level Escape handler (window, bubble phase)
    // never also clears the selection/subset.
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (busy) return;
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [busy, onClose, open]);

  const handleSubmit = useCallback(async () => {
    if (busy) return;

    const validation = validateUrl(value, t);
    if ('error' in validation) {
      setError(validation.error);
      return;
    }

    setError(null);
    setBusy(true);
    try {
      const result = await ipc.openPdfUrl(validation.url);
      if (result.canceled) return;
      await onOpened(result);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('openUrl.failed'));
    } finally {
      setBusy(false);
    }
  }, [busy, onClose, onOpened, t, value]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (busy) return;
      onClose();
    },
    [busy, onClose],
  );

  if (!open) return null;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>
          {t('openUrl.title')}
        </h2>

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label className={styles.label} htmlFor={inputId}>
            {t('openUrl.label')}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className={styles.input}
            type="text"
            value={value}
            placeholder="https://example.com/document.pdf"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />

          <div className={styles.errorArea} role="alert">
            {error}
          </div>

          <div className={styles.actions}>
            <button
              className={styles.button}
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              {t('common.cancel')}
            </button>
            <button
              className={`${styles.button} ${styles.primary}`}
              type="submit"
              disabled={busy || value.trim() === ''}
            >
              {busy ? t('common.opening') : t('common.open')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
