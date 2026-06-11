import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDebouncedValue } from "./use-debounced-value";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the initial value immediately, then the latest value after the delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), { initialProps: { v: "a" } });
    expect(result.current).toBe("a");

    rerender({ v: "ab" });
    rerender({ v: "abc" });
    expect(result.current).toBe("a"); // unchanged before the delay elapses

    act(() => vi.advanceTimersByTime(250));
    expect(result.current).toBe("abc"); // coalesced to the most recent value
  });

  it("resets the timer on each change (no premature emit)", () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 200), { initialProps: { v: "x" } });
    rerender({ v: "xy" });
    act(() => vi.advanceTimersByTime(150));
    rerender({ v: "xyz" });
    act(() => vi.advanceTimersByTime(150)); // 300ms total but only 150ms since last change
    expect(result.current).toBe("x");
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("xyz");
  });
});
