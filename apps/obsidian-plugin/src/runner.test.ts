import { describe, expect, it, vi } from "vitest";
import { createDebouncer, createSyncRunner } from "./runner";

describe("createSyncRunner", () => {
  it("runs one pass at a time and coalesces overlapping triggers into a single follow-up", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const runner = createSyncRunner(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await gate; // hold the first pass open while we trigger more
      active -= 1;
    });

    const first = runner.run(); // starts, blocks on gate
    void runner.run(); // in-flight → pending
    void runner.run(); // in-flight → still just one pending
    expect(runner.isRunning()).toBe(true);

    release();
    await first;
    // wait microtasks for the coalesced follow-up pass to complete
    await new Promise((r) => setTimeout(r, 0));

    expect(maxActive).toBe(1); // never two passes at once
    expect(calls).toBe(2); // first + exactly one coalesced follow-up
    expect(runner.isRunning()).toBe(false);
  });
});

describe("createDebouncer", () => {
  it("collapses repeated schedules for a key into one trailing call", () => {
    vi.useFakeTimers();
    try {
      const d = createDebouncer(2000);
      const fn = vi.fn();
      d.schedule("a", fn);
      d.schedule("a", fn);
      d.schedule("a", fn);
      vi.advanceTimersByTime(1999);
      expect(fn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces independently per key and cancelAll stops pending timers", () => {
    vi.useFakeTimers();
    try {
      const d = createDebouncer(1000);
      const a = vi.fn();
      const b = vi.fn();
      d.schedule("a", a);
      d.schedule("b", b);
      d.cancelAll();
      vi.advanceTimersByTime(2000);
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
