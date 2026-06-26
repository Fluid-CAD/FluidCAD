import initOpenCascade from "ocjs-fluidcad"
import type { OpenCascadeInstance } from "ocjs-fluidcad";

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
