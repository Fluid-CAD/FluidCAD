import initOpenCascade from "ocjs-fluidcad"
import type { OpenCascadeInstance } from "ocjs-fluidcad";
import { clampMaxWorkers, defaultMaxWorkers } from "./workers.js";

let oc: OpenCascadeInstance | null = null;
/** The worker count asked for through `setMaxWorkers`; null means the default. */
let requestedMaxWorkers: number | null = null;

export function getOC() {
  if (!oc) {
    throw new Error("OpenCascade not initialized. Call loadOC() first.");
  }

  return oc;
}

export async function loadOC() {
  if (oc) {
    return oc;
  }

  const maxWorkers = requestedMaxWorkers ?? defaultMaxWorkers();
  console.debug("Loading OpenCascade...");
  // `pthreadPoolSize` is how many workers the runtime starts with; a build
  // without the option starts one per CPU and only the thread cap below holds.
  oc = await initOpenCascade({ pthreadPoolSize: maxWorkers })
  // A count set while the kernel was loading wins over the one it started with.
  applyThreadCount(oc, requestedMaxWorkers ?? maxWorkers);
  console.debug("OpenCascade loaded successfully.");

  return oc;
}

/**
 * How many threads OpenCascade's parallel algorithms (booleans, meshing) may
 * use. Before the kernel loads this also sets how many workers it starts
 * with. Once loaded it applies from the next operation: a higher count starts
 * the extra workers on demand (Node only; a browser can deadlock there), and a
 * lower one idles workers without freeing them until the kernel restarts.
 */
export function setMaxWorkers(count: number): void {
  const clamped = clampMaxWorkers(count);
  if (clamped === null) {
    return;
  }
  requestedMaxWorkers = clamped;
  if (oc) {
    applyThreadCount(oc, clamped);
  }
}

/**
 * Cap OCCT's default thread pool at `count` threads, the calling thread
 * included. The first `DefaultPool` call creates the pool at that size;
 * later ones re-size it, which OCCT allows only while no job holds it — and
 * none can while JS runs, since jobs start and finish inside one kernel call.
 */
function applyThreadCount(instance: OpenCascadeInstance, count: number): void {
  const pool = instance.OSD_ThreadPool.DefaultPool(count);
  if (pool.NbThreads() !== count && !pool.IsInUse()) {
    pool.Init(count);
  }
  pool.delete();
}
