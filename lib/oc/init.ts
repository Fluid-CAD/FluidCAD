import initOpenCascade from "occjs-wrapper/node/multi-threaded"
import type { OpenCascadeInstance } from "occjs-wrapper/node/multi-threaded";

let oc: OpenCascadeInstance | null = null;

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

  console.debug("Loading OpenCascade...");
  oc = await initOpenCascade()
  console.debug("OpenCascade loaded successfully.");

  return oc;
}
