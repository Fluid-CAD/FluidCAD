import { afterAll, describe, expect, it } from "vitest";
import { getOC, setMaxWorkers } from "../../oc/init.js";
import { MAX_WORKERS_DEFAULT_CAP, clampMaxWorkers, defaultMaxWorkers, logicalCpuCount } from "../../oc/workers.js";

/** The most threads a parallel boolean or mesh may take from the kernel's pool. */
function launchCap(): number {
  const pool = getOC().OSD_ThreadPool.DefaultPool();
  const count = pool.NbDefaultThreadsToLaunch();
  pool.delete();
  return count;
}

/** Slots in the kernel's pool, one per worker it pre-spawned; the count never moves. */
function poolSlots(): number {
  const pool = getOC().OSD_ThreadPool.DefaultPool();
  const count = pool.NbThreads();
  pool.delete();
  return count;
}

describe("kernel worker count", () => {
  afterAll(() => {
    // Every later test file shares this kernel: leave it at the default.
    setMaxWorkers(defaultMaxWorkers());
  });

  it("defaults to one worker per CPU, at most eight", () => {
    expect(MAX_WORKERS_DEFAULT_CAP).toBe(8);
    expect(defaultMaxWorkers(20)).toBe(8);
    expect(defaultMaxWorkers(4)).toBe(4);
    expect(defaultMaxWorkers(0)).toBe(1);
    expect(defaultMaxWorkers()).toBe(Math.min(logicalCpuCount(), 8));
  });

  it("clamps a requested count to a whole number of workers the machine has", () => {
    expect(clampMaxWorkers(0, 6)).toBe(1);
    expect(clampMaxWorkers(99, 6)).toBe(6);
    expect(clampMaxWorkers(2.6, 6)).toBe(3);
    expect(clampMaxWorkers("4", 6)).toBeNull();
    expect(clampMaxWorkers(Number.NaN, 6)).toBeNull();
  });

  it("the loaded kernel starts at the default and follows setMaxWorkers, ignoring a non-number", () => {
    expect(launchCap()).toBe(defaultMaxWorkers());
    setMaxWorkers(1);
    expect(launchCap()).toBe(1);
    setMaxWorkers(2);
    const two = Math.min(2, logicalCpuCount());
    expect(launchCap()).toBe(two);
    setMaxWorkers(Number.NaN);
    expect(launchCap()).toBe(two);
  });

  it("moving the count never re-sizes the pool: its threads stay, only the cap moves, never past the pre-spawned workers", () => {
    const slots = poolSlots();
    expect(slots).toBe(defaultMaxWorkers());
    setMaxWorkers(1);
    expect(poolSlots()).toBe(slots);
    setMaxWorkers(logicalCpuCount());
    expect(poolSlots()).toBe(slots);
    expect(launchCap()).toBe(Math.min(logicalCpuCount(), slots));
  });
});
