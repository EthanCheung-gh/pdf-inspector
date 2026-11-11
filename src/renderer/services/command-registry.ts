/**
 * Dependency-free command registry for the command palette.
 *
 * Components register a named set of commands; re-registering the same owner
 * replaces that owner's previous set. Commands are flattened with a
 * deterministic "last registration wins" rule for duplicate ids, then sorted
 * by group and title for display.
 *
 * The registry caches the flattened list so it can be consumed directly with
 * `useSyncExternalStore(subscribeCommands, listCommands)`: the snapshot keeps
 * its identity until a registration changes.
 */

export type CommandGroup = 'File' | 'Navigate' | 'View' | 'Analyze' | 'Export';

export interface CommandDefinition {
  id: string;
  title: string;
  group: CommandGroup;
  keywords?: readonly string[];
  shortcut?: string;
  isEnabled?: () => boolean;
  run: () => void | Promise<void>;
}

export type CommandListener = () => void;

const GROUP_ORDER: Record<CommandGroup, number> = {
  File: 0,
  Navigate: 1,
  View: 2,
  Analyze: 3,
  Export: 4,
};

interface OwnerEntry {
  commands: CommandDefinition[];
  token: object;
  order: number;
}

const owners = new Map<string, OwnerEntry>();
const listeners = new Set<CommandListener>();

let nextOrder = 0;
let cachedCommands: CommandDefinition[] = [];
let cacheDirty = true;

const compareCommands = (a: CommandDefinition, b: CommandDefinition): number => {
  const groupDelta = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
  if (groupDelta !== 0) return groupDelta;

  const left = a.title.toLowerCase();
  const right = b.title.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Sort a command list the same way the palette lists it. */
export const sortCommands = (
  commands: readonly CommandDefinition[],
): CommandDefinition[] => [...commands].sort(compareCommands);

const computeCommands = (): CommandDefinition[] => {
  // Most recently registered owner first: a duplicate id from a later
  // registration shadows the earlier one deterministically.
  const entries = [...owners.values()].sort((a, b) => b.order - a.order);
  const seen = new Set<string>();
  const winners: CommandDefinition[] = [];

  for (const entry of entries) {
    for (const command of entry.commands) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      winners.push(command);
    }
  }

  return sortCommands(winners);
};

const invalidate = (): void => {
  cacheDirty = true;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      // One broken subscriber must not prevent the others (or the palette)
      // from observing the new command list.
      console.error('Command registry listener failed:', error);
    }
  }
};

/**
 * Register (or replace) one owner's commands.
 *
 * Returns an idempotent unregister function. Calling it after the owner was
 * re-registered is a no-op, so a late effect cleanup can never remove the
 * owner's newer command set.
 */
export const registerCommands = (
  owner: string,
  commands: readonly CommandDefinition[],
): (() => void) => {
  const token = {};
  const deduped: CommandDefinition[] = [];
  const seen = new Set<string>();

  // Within one owner, the first definition of an id wins. This keeps an owner's
  // own set deterministic instead of depending on array patch order.
  for (const command of commands) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    deduped.push(command);
  }

  owners.set(owner, { commands: deduped, token, order: ++nextOrder });
  invalidate();

  return () => {
    const current = owners.get(owner);
    if (!current || current.token !== token) return;
    owners.delete(owner);
    invalidate();
  };
};

/**
 * Current command list, sorted by group order and then case-insensitive title.
 * The returned array is a stable snapshot between registry changes.
 */
export const listCommands = (): CommandDefinition[] => {
  if (cacheDirty) {
    cachedCommands = computeCommands();
    cacheDirty = false;
  }
  return cachedCommands;
};

/** Subscribe to registry changes; returns an idempotent unsubscribe. */
export const subscribeCommands = (listener: CommandListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
