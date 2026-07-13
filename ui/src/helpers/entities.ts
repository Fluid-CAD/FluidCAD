import type { SelectedEntity } from '../viewer';

export function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

export function entityKey(e: SelectedEntity): string {
  return `${e.shapeId}:${e.sub.type}:${e.sub.index}`;
}

/**
 * The removable chip rows for a pick set: one row per plain pick, a whole
 * tangent chain as a single row — removing it removes the chain like a
 * viewport click on a member would. Shared by the fillet/chamfer/shell
 * dialog and the sweep path slot.
 */
export function selectionChipRows(
  entities: SelectedEntity[],
  chains: { seed: SelectedEntity; members: SelectedEntity[] }[],
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
        rows.push({
          label: `Tangent chain (${chain.members.length} edges)`,
          members: chain.members,
        });
      }
    } else {
      rows.push({ label: entity.sub.type === 'face' ? 'Face' : 'Edge', members: [entity] });
    }
  }
  return rows;
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
