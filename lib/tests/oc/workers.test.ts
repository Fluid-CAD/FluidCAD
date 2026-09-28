import { afterAll, describe, expect, it } from "vitest";
import { getOC, setMaxWorkers } from "../../oc/init.js";
import { MAX_WORKERS_DEFAULT_CAP, clampMaxWorkers, defaultMaxWorkers, logicalCpuCount } from "../../oc/workers.js";

/** Threads in the kernel's default pool: the most a parallel boolean or mesh can use. */
function poolThreads(): number {
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
    expect(poolThreads()).toBe(defaultMaxWorkers());
    setMaxWorkers(1);
    expect(poolThreads()).toBe(1);
    setMaxWorkers(2);
    const two = Math.min(2, logicalCpuCount());
    expect(poolThreads()).toBe(two);
    setMaxWorkers(Number.NaN);
    expect(poolThreads()).toBe(two);
  });
});
