import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { usePageNavigation } from '../../hooks/usePageNavigation';
import { useT, type MessageKey } from '../../i18n';
import {
  listCommands,
  sortCommands,
  subscribeCommands,
  type CommandDefinition,
  type CommandGroup,
} from '../../services/command-registry';
import { usePdfStore } from '../../store/pdf-store';
import styles from './CommandPalette.module.css';

export const GO_TO_PAGE_COMMAND_ID = 'navigate.go-to-page';
export const CLOSE_PALETTE_COMMAND_ID = 'palette.close';

type PaletteMode = 'commands' | 'page';

interface CommandGroupView {
  group: CommandGroup;
  items: { command: CommandDefinition; index: number }[];
}

/**
 * Group ids stay stable English keys (they also drive sorting); only the
 * displayed label follows the active locale.
 */
const GROUP_LABEL_KEYS = {
  File: 'command.group.file',
  Navigate: 'command.group.navigate',
  View: 'command.group.view',
  Analyze: 'command.group.analyze',
  Export: 'command.group.export',
} as const satisfies Record<CommandGroup, MessageKey>;

const groupLabelKey = (group: CommandGroup): MessageKey => GROUP_LABEL_KEYS[group];

const isCommandEnabled = (command: CommandDefinition): boolean => {
  if (!command.isEnabled) return true;
  try {
    return command.isEnabled() !== false;
  } catch (error) {
    console.error(`Command "${command.id}" isEnabled failed:`, error);
    return false;
  }
};

const matchesQuery = (command: CommandDefinition, query: string): boolean => {
  if (!query) return true;
  return [command.title, ...(command.keywords ?? [])].join(' ').toLowerCase().includes(query);
};

/**
 * Global command palette (Ctrl/Cmd+K).
 *
 * Registered commands come from `command-registry`; the palette itself owns
 * only navigation-only built-ins (`Go to page…`, `Close palette`). Running a
 * command closes the palette first so a following dialog is the only modal on
 * screen. The page subview is the single exception: it stays open to collect
 * the page number, then closes before navigating.
 */
export const CommandPalette: React.FC = () => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<PaletteMode>('commands');
  const [pageInput, setPageInput] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);

  const pageCount = usePdfStore((state) => state.pageCount);
  const { navigate } = usePageNavigation();

  const searchRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  const pageInputId = useId();

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery('');
    setMode('commands');
    setPageInput('');
    setActiveIndex(-1);
  }, []);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setMode('commands');
    setPageInput('');
  }, []);

  const registeredCommands = useSyncExternalStore(
    subscribeCommands,
    listCommands,
    listCommands,
  );

  const builtInCommands = useMemo<CommandDefinition[]>(
    () => [
      {
        id: GO_TO_PAGE_COMMAND_ID,
        title: t('palette.goToPageCommand'),
        group: 'Navigate',
        keywords: ['page', 'goto', 'jump', 'navigate'],
        isEnabled: () => pageCount > 0,
        // The palette intercepts this id and shows the page subview instead of
        // closing immediately; `run` exists only to satisfy the contract.
        run: () => undefined,
      },
      {
        id: CLOSE_PALETTE_COMMAND_ID,
        title: t('palette.closeCommand'),
        group: 'View',
        keywords: ['dismiss', 'close', 'escape'],
        shortcut: 'Esc',
        run: () => undefined,
      },
    ],
    [pageCount, t],
  );

  const commands = useMemo(() => {
    // A registered command with a built-in id wins, so an owner can override
    // the built-in description without duplicating the row.
    const registeredIds = new Set(registeredCommands.map((command) => command.id));
    return sortCommands([
      ...registeredCommands,
      ...builtInCommands.filter((command) => !registeredIds.has(command.id)),
    ]);
  }, [builtInCommands, registeredCommands]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return commands.filter((command) => matchesQuery(command, needle));
  }, [commands, query]);

  const grouped = useMemo<CommandGroupView[]>(() => {
    const groups: CommandGroupView[] = [];
    filtered.forEach((command, index) => {
      const last = groups[groups.length - 1];
      if (!last || last.group !== command.group) {
        groups.push({ group: command.group, items: [{ command, index }] });
      } else {
        last.items.push({ command, index });
      }
    });
    return groups;
  }, [filtered]);

  // Selection follows the filtered list: start (or reset) on the first enabled
  // row, and leave `-1` when every match is disabled.
  useEffect(() => {
    if (!open || mode !== 'commands') return;
    setActiveIndex(filtered.findIndex(isCommandEnabled));
  }, [filtered, mode, open]);

  useEffect(() => {
    if (!open) return;
    if (mode === 'page') {
      pageRef.current?.focus();
      pageRef.current?.select();
    } else {
      searchRef.current?.focus();
    }
  }, [mode, open]);

  useEffect(() => {
    if (!open || mode !== 'commands' || activeIndex < 0) return;
    try {
      document.getElementById(`command-palette-option-${activeIndex}`)?.scrollIntoView({
        block: 'nearest',
      });
    } catch {
      // jsdom and older engines may not implement scrollIntoView.
    }
  }, [activeIndex, mode, open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (!open) {
          openPalette();
        } else if (mode === 'page') {
          setMode('commands');
          setPageInput('');
        } else {
          searchRef.current?.focus();
        }
        return;
      }

      if (open && event.key === 'Escape') {
        // Capture phase: keep the app-level Escape handler (clear selection /
        // filters) from also running while the palette is open.
        event.preventDefault();
        event.stopPropagation();
        closePalette();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [closePalette, mode, open, openPalette]);

  const executeCommand = useCallback(
    (command: CommandDefinition) => {
      if (!isCommandEnabled(command)) return;

      if (command.id === GO_TO_PAGE_COMMAND_ID) {
        setMode('page');
        setPageInput(String(usePdfStore.getState().currentPage || 1));
        return;
      }

      if (command.id === CLOSE_PALETTE_COMMAND_ID) {
        closePalette();
        return;
      }

      // Close first: subsequent dialogs (Export, Diff setup) must not stack on
      // top of the palette.
      closePalette();
      try {
        const result = command.run();
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch((error) => {
            console.error(`Command "${command.id}" failed:`, error);
          });
        }
      } catch (error) {
        console.error(`Command "${command.id}" failed:`, error);
      }
    },
    [closePalette],
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return;
      let index = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
      for (let step = 0; step < filtered.length; step += 1) {
        index = (index + delta + filtered.length) % filtered.length;
        if (isCommandEnabled(filtered[index])) {
          setActiveIndex(index);
          return;
        }
      }
    },
    [activeIndex, filtered],
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const command = filtered[activeIndex];
        if (command) executeCommand(command);
      }
    },
    [activeIndex, executeCommand, filtered, moveActive],
  );

  const submitPage = useCallback(() => {
    const value = pageInput.trim();
    if (!/^\d+$/.test(value)) return;
    const count = usePdfStore.getState().pageCount;
    if (count <= 0) return;
    const page = Math.min(count, Math.max(1, Number(value)));
    closePalette();
    void navigate(page).catch((error) => {
      console.error('Go to page failed:', error);
    });
  }, [closePalette, navigate, pageInput]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      closePalette();
    },
    [closePalette],
  );

  if (!open) return null;

  const activeCommand = activeIndex >= 0 ? filtered[activeIndex] : undefined;

  return (
    <div
      className={styles.backdrop}
      data-testid="command-palette-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {mode === 'commands' ? (
          <>
            <h2 id={titleId} className={styles.title}>
              {t('palette.title')}
            </h2>
            <input
              ref={searchRef}
              className={styles.search}
              type="text"
              role="combobox"
              aria-label={t('palette.search')}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                activeCommand ? `command-palette-option-${activeIndex}` : undefined
              }
              placeholder={t('palette.placeholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            <div className={styles.list} id={listId} role="listbox" aria-label={t('palette.commands')}>
              {grouped.length === 0 ? (
                <p className={styles.empty}>{t('palette.empty')}</p>
              ) : (
                grouped.map(({ group, items }) => (
                  <div
                    key={group}
                    className={styles.group}
                    role="group"
                    aria-label={t(groupLabelKey(group))}
                  >
                    <div className={styles.groupLabel} aria-hidden="true">
                      {t(groupLabelKey(group))}
                    </div>
                    {items.map(({ command, index }) => {
                      const enabled = isCommandEnabled(command);
                      const active = index === activeIndex;
                      return (
                        <div
                          key={command.id}
                          id={`command-palette-option-${index}`}
                          className={`${styles.option} ${active ? styles.optionActive : ''} ${
                            enabled ? '' : styles.optionDisabled
                          }`}
                          role="option"
                          aria-selected={active}
                          aria-disabled={!enabled}
                          onMouseMove={() => {
                            if (enabled) setActiveIndex(index);
                          }}
                          onClick={() => executeCommand(command)}
                        >
                          <span className={styles.optionTitle}>{command.title}</span>
                          {command.shortcut && (
                            <span className={styles.shortcut}>{command.shortcut}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <p className={styles.hint}>{t('palette.hint')}</p>
          </>
        ) : (
          <>
            <h2 id={titleId} className={styles.title}>
              {t('palette.goToPage')}
            </h2>
            <button
              className={styles.backButton}
              type="button"
              onClick={() => {
                setMode('commands');
                setPageInput('');
              }}
            >
              {t('palette.back')}
            </button>
            <form
              className={styles.pageForm}
              onSubmit={(event) => {
                event.preventDefault();
                submitPage();
              }}
            >
              <label className={styles.pageLabel} htmlFor={pageInputId}>
                {t('palette.pageNumber')}
              </label>
              <input
                ref={pageRef}
                id={pageInputId}
                className={styles.pageInput}
                type="text"
                inputMode="numeric"
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  submitPage();
                }}
                placeholder={
                  pageCount > 0
                    ? t('palette.pagePlaceholder', { count: pageCount })
                    : t('palette.noDocument')
                }
                spellCheck={false}
                autoComplete="off"
              />
              <button className={styles.goButton} type="submit" disabled={pageCount <= 0}>
                {t('palette.go')}
              </button>
            </form>
            <p className={styles.hint}>
              {t('palette.pageHint', { count: pageCount })}
            </p>
          </>
        )}
      </div>
    </div>
  );
};
