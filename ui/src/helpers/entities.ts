import type { SelectedEntity } from '../viewer';

/**
 * Assembly instances of one part share a shapeId, so an entity is only
 * identified together with its instance. Part-mode entities carry none and
 * compare as before.
 */
export function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId
    && a.sub.type === b.sub.type
    && a.sub.index === b.sub.index
    && (a.instanceId ?? null) === (b.instanceId ?? null);
}

export function entityKey(e: SelectedEntity): string {
  const base = `${e.shapeId}:${e.sub.type}:${e.sub.index}`;
  return e.instanceId ? `${base}@${e.instanceId}` : base;
}

/** Click-to-toggle: re-picking the current entity clears it back to null. */
export function toggleEntity(current: SelectedEntity | null, next: SelectedEntity): SelectedEntity | null {
  return current && sameEntity(current, next) ? null : next;
}

/**
 * The removable chip rows for a pick set: one row per plain pick, a whole
 * chain as a single row — removing it removes the chain like a viewport
 * click on a member would. A tangent chain reads "Tangent chain", a loop
 * of edges "Loop", a run of connected faces "Connected faces".
 * Shared by the fillet/chamfer/shell dialog, the sweep path slot, the
 * colour dialog's Face tab and the Project tool.
 */
export function selectionChipRows(
  entities: SelectedEntity[],
  chains: { seed: SelectedEntity; members: SelectedEntity[]; kind?: 'tangent' | 'loop' }[],
): { label: string; members: SelectedEntity[] }[] {
  const chainOf = new Map<string, (typeof chains)[number]>();
  for (const chain of chains) {
    for (const member of chain.members) {
      chainOf.set(entityKey(member), chain);
    }
  }
  const seen = new Set<(typeof chains)[number]>();
  const rows: { label: string; members: SelectedEntity[] }[] = [];
  for (const entity of entities) {
    const chain = chainOf.get(entityKey(entity));
    if (chain) {
      if (!seen.has(chain)) {
        seen.add(chain);
        rows.push({ label: chainLabel(chain), members: chain.members });
      }
    } else {
      const labels = { face: 'Face', edge: 'Edge', vertex: 'Vertex' };
      rows.push({ label: labels[entity.sub.type], members: [entity] });
    }
  }
  return rows;
}

/** A chain's chip: what kind of chain it is and how many edges or faces it holds. */
function chainLabel(chain: { members: SelectedEntity[]; kind?: 'tangent' | 'loop' }): string {
  const faces = chain.members.every(m => m.sub.type === 'face');
  const count = `${chain.members.length} ${faces ? 'faces' : 'edges'}`;
  if (chain.kind === 'loop') {
    return faces ? `Connected faces (${count})` : `Loop (${count})`;
  }
  return `Tangent chain (${count})`;
}

/** `base` plus the members of `added` it doesn't already contain, in order. */
export function mergeUniqueEntities(base: SelectedEntity[], added: SelectedEntity[]): SelectedEntity[] {
  const seen = new Set(base.map(entityKey));
  const merged = [...base];
  for (const entity of added) {
    if (!seen.has(entityKey(entity))) {
      seen.add(entityKey(entity));
      merged.push(entity);
    }
  }
  return merged;
}
