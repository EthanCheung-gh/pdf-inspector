import { beforeEach, describe, expect, it } from 'vitest';
import {
  INITIAL_SESSION_RESTORE_PROGRESS,
  useSessionRestoreStore,
} from '../session-restore-store';

const store = () => useSessionRestoreStore.getState();

beforeEach(() => {
  store().reset();
});

describe('defaults', () => {
  it('starts idle with no progress, failures or error', () => {
    expect(store()).toMatchObject(INITIAL_SESSION_RESTORE_PROGRESS);
    expect(store().failed).toEqual([]);
  });
});

describe('progress', () => {
  it('starts a run with its planned document count', () => {
    store().begin(3);

    expect(store()).toMatchObject({ restoring: true, done: 0, total: 3, error: null });
    expect(store().failed).toEqual([]);
  });

  it('normalizes a broken planned count instead of reporting it', () => {
    store().begin(Number.NaN);
    expect(store()).toMatchObject({ restoring: false, done: 0, total: 0 });

    store().begin(4.7);
    expect(store()).toMatchObject({ restoring: true, total: 4 });
  });

  it('counts attempts and never exceeds the plan', () => {
    store().begin(2);
    store().advance();
    expect(store().done).toBe(1);
    store().advance();
    store().advance();
    expect(store().done).toBe(2);
  });

  it('keeps progress and failures after the run finishes', () => {
    store().begin(2);
    store().advance();
    store().recordFailure({ name: 'gone.pdf', kind: 'local' });
    store().advance();
    store().finish();

    expect(store()).toMatchObject({
      restoring: false,
      done: 2,
      total: 2,
      failed: [{ name: 'gone.pdf', kind: 'local' }],
      error: null,
    });
  });
});

describe('failures', () => {
  it('records skipped documents in attempt order without counting them twice', () => {
    store().begin(2);
    store().recordFailure({ name: 'a.pdf', kind: 'local' });
    store().recordFailure({ name: 'b.pdf', kind: 'upload' });

    expect(store().failed).toEqual([
      { name: 'a.pdf', kind: 'local' },
      { name: 'b.pdf', kind: 'upload' },
    ]);
    expect(store().done).toBe(0);
  });

  it('counts documents, not attempts: the same kind and name is recorded once', () => {
    store().begin(3);
    store().recordFailure({ name: 'a.pdf', kind: 'local' });
    store().recordFailure({ name: 'a.pdf', kind: 'local' });
    // A different kind is a different document even when the label matches.
    store().recordFailure({ name: 'a.pdf', kind: 'upload' });

    expect(store().failed).toEqual([
      { name: 'a.pdf', kind: 'local' },
      { name: 'a.pdf', kind: 'upload' },
    ]);
  });

  it('reports a fatal error without throwing and stops the run', () => {
    store().begin(2);
    store().fail('Session is corrupted');

    expect(store()).toMatchObject({
      restoring: false,
      error: 'Session is corrupted',
      done: 0,
      total: 2,
    });
  });

  it('begin clears the previous run outcome', () => {
    store().begin(1);
    store().advance();
    store().recordFailure({ name: 'x.pdf', kind: 'url' });
    store().fail('boom');

    store().begin(2);

    expect(store()).toMatchObject({ restoring: true, done: 0, total: 2, failed: [], error: null });
  });
});

describe('dismiss', () => {
  it('clears the outcome without touching the run counters', () => {
    store().begin(2);
    store().advance();
    store().recordFailure({ name: 'x.pdf', kind: 'url' });
    store().fail('boom');

    store().dismiss();

    expect(store()).toMatchObject({
      restoring: false,
      done: 1,
      total: 2,
      failed: [],
      error: null,
    });
  });
});
