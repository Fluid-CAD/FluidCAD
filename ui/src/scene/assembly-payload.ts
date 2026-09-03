import type { SerializedAssembly } from '../types';

/**
 * The assembly payload as the UI consumes it, rebuilt field by field from
 * the `scene-rendered` message so an older engine's missing lists read as
 * empty. Every list the payload can carry is named here — a field left out
 * of this rebuild silently vanishes from the UI (the occurrences list once
 * did, and the parts panel stopped grouping sub-assemblies).
 */
export function normalizeAssemblyPayload(raw: Partial<SerializedAssembly> | null | undefined): SerializedAssembly {
  return {
    instances: raw?.instances ?? [],
    mates: raw?.mates ?? [],
    occurrences: raw?.occurrences ?? [],
    connectors: raw?.connectors ?? [],
    replicates: raw?.replicates ?? [],
  };
}
