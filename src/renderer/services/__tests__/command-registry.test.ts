import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listCommands,
  registerCommands,
  sortCommands,
  subscribeCommands,
  type CommandDefinition,
  type CommandGroup,
} from '../command-registry';

const cleanups: (() => void)[] = [];

const register = (owner: string, commands: CommandDefinition[]): (() => void) => {
  const unregister = registerCommands(owner, commands);
  cleanups.push(unregister);
  return unregister;
};

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const command = (
  id: string,
  title: string,
  group: CommandGroup,
  extra: Partial<CommandDefinition> = {},
): CommandDefinition => ({
  id,
  title,
  group,
  run: vi.fn(),
  ...extra,
});

const ids = (): string[] => listCommands().map((entry) => entry.id);

describe('command-registry', () => {
  it('registers commands and unregisters them again', () => {
    const unregister = register('registry-basic', [
      command('registry-basic.a', 'Alpha', 'File'),
      command('registry-basic.b', 'Beta', 'View'),
    ]);

    expect(ids()).toEqual(expect.arrayContaining(['registry-basic.a', 'registry-basic.b']));

    unregister();
    expect(ids()).not.toContain('registry-basic.a');
    expect(ids()).not.toContain('registry-basic.b');

    // Unregister is idempotent.
    expect(() => unregister()).not.toThrow();
  });

  it('replaces an owner set and ignores a stale unregister', () => {
    const first = register('registry-replace', [
      command('registry-replace.old', 'Old', 'File'),
    ]);
    const second = register('registry-replace', [
      command('registry-replace.new', 'New', 'File'),
    ]);

    expect(ids()).toContain('registry-replace.new');
    expect(ids()).not.toContain('registry-replace.old');

    // The cleanup from the first registration must not remove the second set.
    first();
    expect(ids()).toContain('registry-replace.new');

    second();
    expect(ids()).not.toContain('registry-replace.new');
  });

  it('sorts by group order and then case-insensitive title', () => {
    register('registry-order', [
      command('registry-order.view-b', 'beta', 'View'),
      command('registry-order.file-b', 'Bravo', 'File'),
      command('registry-order.navigate', 'Zulu', 'Navigate'),
      command('registry-order.file-a', 'alpha', 'File'),
      command('registry-order.export', 'Export', 'Export'),
      command('registry-order.analyze', 'Audit', 'Analyze'),
      command('registry-order.view-a', 'Alpha', 'View'),
    ]);

    const own = listCommands()
      .filter((entry) => entry.id.startsWith('registry-order.'))
      .map((entry) => entry.id);

    expect(own).toEqual([
      'registry-order.file-a',
      'registry-order.file-b',
      'registry-order.navigate',
      'registry-order.view-a',
      'registry-order.view-b',
      'registry-order.analyze',
      'registry-order.export',
    ]);
  });

  it('lets the last owner win a duplicate id and restores the previous one', () => {
    const unregisterA = register('registry-dup-a', [
      command('registry-dup.shared', 'From A', 'File'),
    ]);
    const unregisterB = register('registry-dup-b', [
      command('registry-dup.shared', 'From B', 'File'),
    ]);

    const winner = listCommands().find((entry) => entry.id === 'registry-dup.shared');
    expect(winner?.title).toBe('From B');

    unregisterB();
    expect(listCommands().find((entry) => entry.id === 'registry-dup.shared')?.title).toBe(
      'From A',
    );

    unregisterA();
    expect(ids()).not.toContain('registry-dup.shared');
  });

  it('deduplicates duplicate ids inside one owner deterministically', () => {
    register('registry-owner-dup', [
      command('registry-owner-dup.same', 'First', 'File'),
      command('registry-owner-dup.same', 'Second', 'File'),
    ]);

    const matches = listCommands().filter((entry) => entry.id === 'registry-owner-dup.same');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('First');
  });

  it('notifies subscribers on register and unregister, and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCommands(listener);

    const unregister = register('registry-subscribe', [
      command('registry-subscribe.a', 'A', 'File'),
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    register('registry-subscribe', [command('registry-subscribe.b', 'B', 'File')]);
    expect(listener).toHaveBeenCalledTimes(2);

    unregister();
    // The first registration is stale; unregistering it must not notify.
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    register('registry-subscribe', [command('registry-subscribe.c', 'C', 'File')]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the snapshot identity stable until a registration changes', () => {
    const before = listCommands();
    expect(listCommands()).toBe(before);

    const unregister = register('registry-snapshot', [
      command('registry-snapshot.a', 'A', 'File'),
    ]);
    const after = listCommands();
    expect(after).not.toBe(before);
    expect(listCommands()).toBe(after);

    unregister();
    expect(listCommands()).not.toBe(after);
  });

  it('sorts a detached list without mutating the input', () => {
    const input = [
      command('sort.view', 'View', 'View'),
      command('sort.file', 'File', 'File'),
    ];
    const sorted = sortCommands(input);

    expect(sorted.map((entry) => entry.id)).toEqual(['sort.file', 'sort.view']);
    expect(input.map((entry) => entry.id)).toEqual(['sort.view', 'sort.file']);
  });
});
