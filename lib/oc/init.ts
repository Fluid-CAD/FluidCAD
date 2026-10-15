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
 * use. Before the kernel loads this also sets how many workers it starts with.
 * Once loaded it applies from the next operation, up to the workers the
 * kernel started with: a lower count idles threads without ending them, and a
 * higher one than it started with takes effect when the kernel next starts.
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
 * Let OCCT's parallel algorithms use `count` threads, the calling thread
 * included. The pool has one slot per worker the kernel pre-spawned
 * (`pthreadPoolSize`, set by the binding while loading) and keeps them for
 * life; only the number of slots a job may take moves. A slot's thread starts
 * the first time a job takes it, on one of those pre-spawned workers.
 *
 * The pool is never re-sized (`Init`) or taken past the pre-spawned workers.
 * Both start kernel threads on workers created after load — a re-size ends
 * threads and restarts them, racing the exited workers' return to the pool —
 * and the kernel then trapped at random in unrelated calls ("null function or
 * function signature mismatch", "operation does not support unaligned
 * accesses"), on the main thread and in threads as they started. The lib
 * suite, whose only thread churn was the re-size, failed about one run in
 * three until it stopped. So a count above the pre-spawned pool waits for the
 * next kernel start, which then pre-spawns that many.
 */
function applyThreadCount(instance: OpenCascadeInstance, count: number): void {
  const pool = instance.OSD_ThreadPool.DefaultPool();
  pool.SetNbDefaultThreadsToLaunch(Math.min(count, pool.NbThreads()));
  pool.delete();
}
