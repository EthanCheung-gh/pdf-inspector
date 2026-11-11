// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useElapsedSeconds } from '../useElapsedSeconds';

afterEach(() => {
  vi.useRealTimers();
});

describe('useElapsedSeconds', () => {
  it('counts whole seconds while active', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useElapsedSeconds(true));

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(3_400);
    });
    expect(result.current).toBe(3);

    act(() => {
      vi.advanceTimersByTime(38_600);
    });
    expect(result.current).toBe(42);
  });

  it('resets when inactive and restarts from zero on the next run', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useElapsedSeconds(active),
      { initialProps: { active: true } },
    );

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(result.current).toBe(12);

    act(() => rerender({ active: false }));
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // Nothing ticks while the comparison is not running.
    expect(result.current).toBe(0);

    act(() => rerender({ active: true }));
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(5);
  });

  it('never ticks while inactive', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useElapsedSeconds(false));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current).toBe(0);
  });
});
