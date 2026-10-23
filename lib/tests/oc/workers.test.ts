import { describe, expect, it } from "vitest";
import { getOC } from "../../oc/init.js";
import { MAX_WORKERS_DEFAULT_CAP, clampMaxWorkers, defaultMaxWorkers, logicalCpuCount } from "../../oc/workers.js";

// The kernel's worker pool is sized once, when it loads. Nothing in this suite
// moves it afterwards: every later test file shares the same kernel, and a
// count changed mid-run is not supported — the user restarts the engine to
// apply a new pool size.

/** The most threads a parallel boolean or mesh may take from the kernel's pool. */
function launchCap(): number {
  const pool = getOC().OSD_ThreadPool.DefaultPool();
  const count = pool.NbDefaultThreadsToLaunch();
  pool.delete();
  return count;
}

/** Slots in the kernel's pool, one per worker it pre-spawned. */
function poolSlots(): number {
  const pool = getOC().OSD_ThreadPool.DefaultPool();
  const count = pool.NbThreads();
  pool.delete();
  return count;
}

describe("kernel worker count", () => {
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

  it("the loaded kernel pre-spawned the default worker count and launches up to that many threads", () => {
    expect(poolSlots()).toBe(defaultMaxWorkers());
    expect(launchCap()).toBe(defaultMaxWorkers());
  });
});
