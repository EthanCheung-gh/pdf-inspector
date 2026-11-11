import { useEffect } from 'react';
import {
  registerCommands,
  type CommandDefinition,
} from '../services/command-registry';

/**
 * Keep one owner's commands registered for the lifetime of a component.
 *
 * `commands` is used as an effect dependency, so callers should memoize it
 * (`useMemo`) when it is built inline; an inline array re-registers on every
 * render and needlessly notifies the palette. The cleanup is token-guarded in
 * the registry, so it only removes the registration it created.
 */
export function useRegisterCommands(
  owner: string,
  commands: readonly CommandDefinition[],
): void {
  useEffect(() => registerCommands(owner, commands), [owner, commands]);
}
