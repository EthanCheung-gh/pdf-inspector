import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipc } from '../../services/ipc-client';
import { useRawStore } from '../../store/raw-store';
import type { RawObject, RawRef, RawRoot, RawValue } from '../../types/raw-pdf';
import { formatRawRef, rawScalarText, rawValueSummary, refKey } from './RawValueView';
import styles from './RawTree.module.css';

/**
 * Renderer-side tree caps.
 *
 * The tree is lazy by construction: expanding a `ref` fetches exactly that
 * object, and nothing walks the graph on its own. These two limits keep a
 * manually expanded graph (or a self-referencing one) from growing without
 * bound. Hitting one is always reported in the tree instead of silently
 * cutting rows off.
 */
export const RAW_TREE_MAX_DEPTH = 8;
export const RAW_TREE_MAX_ENTRIES = 100;

/** Load state of one expandable reference row, keyed by its tree path. */
interface RefNodeState {
  status: 'loading' | 'error' | 'loaded';
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The raw object tree: trailer roots expanded lazily, one object at a time.
 *
 * Two independent caches live here on purpose:
 * - `objectsRef` is keyed by reference (`3:0`) and holds what the sidecar
 *   returned; collapsing and re-expanding a row never re-asks for it, and it
 *   is cleared whenever the document (or file) changes.
 * - `expanded`/`refStates` are keyed by tree *path*, so the same reference at
 *   two places in the tree has two independent rows (and cannot be mistaken
 *   for a cycle).
 *
 * Selecting a reference and expanding it are separate actions: clicking the
 * `15 0 R` label asks the store for the object shown on the right, while the
 * chevron only reads the object into the tree.
 */
export const RawTree: React.FC = () => {
  const document = useRawStore((state) => state.document);
  const selected = useRawStore((state) => state.selected);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [refStates, setRefStates] = useState<Record<string, RefNodeState>>({});
  const objectsRef = useRef(new Map<string, RawObject>());
  /** Bumped when the document changes so late answers cannot land in a new tree. */
  const generationRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // The cache belongs to one document: a reload produces a new `RawDocument`
  // object and another file produces another reference, so both reset the tree
  // instead of showing objects that belong to the previous load.
  useEffect(() => {
    generationRef.current += 1;
    objectsRef.current.clear();
    setExpanded(new Set<string>());
    setRefStates({});
  }, [document]);

  const loadRef = useCallback(async (ref: RawRef, path: string): Promise<void> => {
    const key = refKey(ref);
    if (objectsRef.current.has(key)) {
      setRefStates((previous) => ({ ...previous, [path]: { status: 'loaded' } }));
      return;
    }

    const generation = generationRef.current;
    setRefStates((previous) => ({ ...previous, [path]: { status: 'loading' } }));

    try {
      const object = await ipc.rawObject(ref);
      if (!aliveRef.current || generation !== generationRef.current) return;
      objectsRef.current.set(key, object);
      setRefStates((previous) => ({ ...previous, [path]: { status: 'loaded' } }));
    } catch (error) {
      if (!aliveRef.current || generation !== generationRef.current) return;
      setRefStates((previous) => ({
        ...previous,
        [path]: { status: 'error', error: errorMessage(error) },
      }));
    }
  }, []);

  const toggle = useCallback(
    (ref: RawRef | null, path: string): void => {
      const isOpen = expanded.has(path);
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });

      if (!ref || isOpen) return;
      // A cached object (or a request already in flight) needs no new round
      // trip; only the first expansion of a reference asks the sidecar.
      if (objectsRef.current.has(refKey(ref))) return;
      if (refStates[path]?.status === 'loading') return;
      void loadRef(ref, path);
    },
    [expanded, loadRef, refStates],
  );

  const handleSelect = useCallback((ref: RawRef): void => {
    const store = useRawStore.getState();
    store.select(ref);
    store.setTab('object');
  }, []);

  if (!document) {
    return <p className={styles.message}>Loading the raw document…</p>;
  }

  const renderRef = (ref: RawRef, label: string, path: string, depth: number): JSX.Element => {
    const key = refKey(ref);
    const text = formatRawRef(ref);
    const isOpen = expanded.has(path);
    const canExpand = depth < RAW_TREE_MAX_DEPTH;
    const state = refStates[path];
    const object = objectsRef.current.get(key);
    const isSelected = selected !== null && refKey(selected) === key;

    let children: React.ReactNode = null;
    if (isOpen && canExpand) {
      if (object) {
        children = renderObjectRows(object.value, path, depth);
      } else if (state?.status === 'error') {
        children = (
          <li className={styles.messageRow} role="alert">
            <span className={styles.errorText}>
              Failed to read {text}: {state.error}
            </span>
            <button
              className={styles.retryButton}
              type="button"
              onClick={() => void loadRef(ref, path)}
            >
              Retry
            </button>
          </li>
        );
      } else {
        children = (
          <li className={styles.messageRow}>
            Loading {text}…
          </li>
        );
      }
    }

    return (
      <li className={styles.node} key={path}>
        <div className={`${styles.row} ${isSelected ? styles.selectedRow : ''}`}>
          {canExpand ? (
            <button
              className={styles.toggle}
              type="button"
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label}`}
              title={`${isOpen ? 'Collapse' : 'Expand'} ${text}`}
              onClick={() => toggle(ref, path)}
            >
              <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </button>
          ) : (
            <span className={styles.togglePlaceholder} aria-hidden="true" />
          )}
          <span className={styles.label}>{label}</span>
          <button
            className={`${styles.refButton} ${isSelected ? styles.refSelected : ''}`}
            type="button"
            aria-pressed={isSelected}
            title={`Select object ${text}`}
            onClick={() => handleSelect(ref)}
          >
            {text}
          </button>
          {object && <span className={styles.summary}>{object.summary}</span>}
        </div>
        {isOpen && canExpand && <ul className={styles.children}>{children}</ul>}
        {!canExpand && (
          <p className={styles.notice} data-testid="raw-tree-depth-notice">
            Depth limit {RAW_TREE_MAX_DEPTH} reached; deeper references stay collapsed.
          </p>
        )}
      </li>
    );
  };

  const renderChildren = (
    value: Extract<RawValue, { kind: 'dict' | 'array' | 'stream' }>,
    path: string,
    depth: number,
  ): React.ReactNode => {
    if (value.kind === 'dict') {
      const entries = value.entries.slice(0, RAW_TREE_MAX_ENTRIES);
      return (
        <>
          {entries.map((entry, index) =>
            renderValue(entry.value, entry.key, `${path}/${entry.key}:${index}`, depth + 1),
          )}
          {entries.length < value.entries.length && (
            <li className={styles.noticeRow} data-testid="raw-tree-truncated">
              Showing the first {entries.length} of {value.entries.length} entries.
            </li>
          )}
          {entries.length === value.entries.length && value.truncated && (
            <li className={styles.noticeRow} data-testid="raw-tree-truncated">
              The sidecar truncated this dictionary.
            </li>
          )}
        </>
      );
    }

    if (value.kind === 'array') {
      const items = value.items.slice(0, RAW_TREE_MAX_ENTRIES);
      return (
        <>
          {items.map((item, index) =>
            renderValue(item, `[${index}]`, `${path}/${index}`, depth + 1),
          )}
          {items.length < value.items.length && (
            <li className={styles.noticeRow} data-testid="raw-tree-truncated">
              Showing the first {items.length} of {value.items.length} items.
            </li>
          )}
          {items.length === value.items.length && value.truncated && (
            <li className={styles.noticeRow} data-testid="raw-tree-truncated">
              The sidecar truncated this array.
            </li>
          )}
        </>
      );
    }

    return (
      <>
        {renderValue(value.dict, 'Dictionary', `${path}/dict`, depth + 1)}
        {/* A stream has no readable body when the sidecar withholds a preview
            (binary filters); that is a different fact from a truncated preview
            and must not be reported as one. */}
        {value.preview === null && (
          <li className={styles.noticeRow} data-testid="raw-tree-stream-binary">
            Binary stream — metadata only.
          </li>
        )}
        {value.truncated && value.preview !== null && (
          <li className={styles.noticeRow} data-testid="raw-tree-truncated">
            The stream preview is truncated.
          </li>
        )}
      </>
    );
  };

  const renderValue = (value: RawValue, label: string, path: string, depth: number): JSX.Element => {
    if (value.kind === 'ref') return renderRef(value.ref, label, path, depth);

    if (value.kind === 'dict' || value.kind === 'array' || value.kind === 'stream') {
      const isOpen = expanded.has(path);
      const canExpand = depth < RAW_TREE_MAX_DEPTH;
      return (
        <li className={styles.node} key={path}>
          <div className={styles.row}>
            {canExpand ? (
              <button
                className={styles.toggle}
                type="button"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${label}`}
                onClick={() => toggle(null, path)}
              >
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span className={styles.togglePlaceholder} aria-hidden="true" />
            )}
            <span className={styles.label}>{label}</span>
            <span className={styles.summary} data-kind={value.kind}>
              {rawValueSummary(value)}
            </span>
          </div>
          {isOpen && canExpand && <ul className={styles.children}>{renderChildren(value, path, depth)}</ul>}
          {!canExpand && (
            <p className={styles.notice} data-testid="raw-tree-depth-notice">
              Depth limit {RAW_TREE_MAX_DEPTH} reached; deeper values are not shown.
            </p>
          )}
        </li>
      );
    }

    const text = rawScalarText(value) ?? '';
    return (
      <li className={styles.node} key={path}>
        <div className={styles.row}>
          <span className={styles.togglePlaceholder} aria-hidden="true" />
          <span className={styles.label}>{label}</span>
          <span className={styles.value} data-kind={value.kind} title={text}>
            {text}
          </span>
        </div>
      </li>
    );
  };

  /**
   * Rows of one loaded object.
   *
   * A reference shows the object's *contents* instead of wrapping them in
   * another node: expanding `1 0 R` for a dictionary lists its keys directly,
   * which is what makes the tree read like the object it shows.
   */
  const renderObjectRows = (value: RawValue, path: string, depth: number): React.ReactNode => {
    if (value.kind === 'dict' || value.kind === 'array' || value.kind === 'stream') {
      return renderChildren(value, `${path}/value`, depth);
    }
    if (value.kind === 'ref') return renderRef(value.ref, 'Value', `${path}/value`, depth + 1);

    const text = rawScalarText(value) ?? '';
    return (
      <li className={styles.node} key={`${path}/value`}>
        <div className={styles.row}>
          <span className={styles.togglePlaceholder} aria-hidden="true" />
          <span className={styles.label}>Value</span>
          <span className={styles.value} data-kind={value.kind} title={text}>
            {text}
          </span>
        </div>
      </li>
    );
  };

  const renderRoot = (root: RawRoot): JSX.Element => {
    const path = `root:${root.label}`;
    if (root.ref) return renderRef(root.ref, root.label, path, 0);
    if (root.value) return renderValue(root.value, root.label, path, 0);
    return (
      <li className={styles.node} key={path}>
        <div className={styles.row}>
          <span className={styles.togglePlaceholder} aria-hidden="true" />
          <span className={styles.label}>{root.label}</span>
          <span className={styles.summary}>not present</span>
        </div>
      </li>
    );
  };

  const version = document.version ?? 'unknown version';
  const pages = `${document.pages} ${document.pages === 1 ? 'page' : 'pages'}`;

  return (
    <nav className={styles.tree} aria-label="Raw PDF object tree">
      <p className={styles.meta} data-testid="raw-tree-meta">
        PDF {version} · {pages}
        {document.encrypted ? ' · encrypted' : ''}
      </p>
      <ul className={styles.roots}>{document.roots.map(renderRoot)}</ul>
    </nav>
  );
};
