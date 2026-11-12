import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '../../i18n';
import { clampPanelWidth, type WorkspacePanelSide } from '../../store/workspace-store';
import styles from './PanelSplitter.module.css';

const KEYBOARD_STEP_PX = 8;

export interface PanelSplitterProps {
  side: WorkspacePanelSide;
  width: number;
  min: number;
  max: number;
  /** The parent owns the width and persists it; the splitter only reports the next value. */
  onResize: (nextWidth: number) => void;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
}

export const PanelSplitter = ({
  side,
  width,
  min,
  max,
  onResize,
}: PanelSplitterProps): JSX.Element => {
  const t = useT();
  const dragState = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  // While dragging we keep the candidate width locally and paint it straight onto
  // the controlled pane element. Committing to the store on every pointermove
  // re-renders the whole workspace (PDF included) and writes localStorage.
  const previewRef = useRef<number | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const label = side === 'left' ? t('panelSplitter.resizeLeft') : t('panelSplitter.resizeRight');
  const controls = side === 'left' ? 'workspace-left-pane' : 'workspace-right-pane';

  // Moving a left splitter right makes the left pane wider. A right splitter
  // sits on the pane's left edge, so moving it left makes the right pane wider.
  const direction = side === 'left' ? 1 : -1;

  const setPreview = (nextWidth: number | null): void => {
    previewRef.current = nextWidth;
    setPreviewWidth(nextWidth);
  };

  /** Paint the preview onto the pane DOM node so the divider follows the pointer. */
  const paintPane = (nextWidth: number): void => {
    if (typeof document === 'undefined') return;
    const pane = document.getElementById(controls);
    if (!pane) return;
    pane.style.width = `${nextWidth}px`;
    pane.style.flexBasis = `${nextWidth}px`;
  };

  // When the parent hands down a new width outside of a drag, drop any stale
  // preview so aria and the rendered width agree again.
  useEffect(() => {
    if (dragState.current) return;
    previewRef.current = null;
    setPreviewWidth(null);
  }, [width]);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextWidth = clampPanelWidth(
      drag.startWidth + direction * (event.clientX - drag.startX),
      min,
      max,
    );
    if (nextWidth === (previewRef.current ?? width)) return;
    setPreview(nextWidth);
    paintPane(nextWidth);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const committedWidth = previewRef.current;
    // Clear the drag first: releasing the capture below emits `lostpointercapture`,
    // which must not commit a second time.
    dragState.current = null;
    setPreview(null);
    setDragging(false);

    const target = event.currentTarget;
    if (event.type !== 'lostpointercapture' && target.hasPointerCapture?.(drag.pointerId)) {
      target.releasePointerCapture(drag.pointerId);
    }

    // A drag that never produced a preview (or landed back on the current width)
    // has nothing to persist.
    if (committedWidth !== null && committedWidth !== width) onResize(committedWidth);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let delta: number;
    if (event.key === 'ArrowLeft') {
      delta = -KEYBOARD_STEP_PX;
    } else if (event.key === 'ArrowRight') {
      delta = KEYBOARD_STEP_PX;
    } else {
      return;
    }

    event.preventDefault();
    const nextWidth = clampPanelWidth(width + direction * delta, min, max);
    if (nextWidth !== width) onResize(nextWidth);
  };

  return (
    <div
      className={`${styles.splitter} ${dragging ? styles.dragging : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(previewWidth ?? width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={handleKeyDown}
    />
  );
};
