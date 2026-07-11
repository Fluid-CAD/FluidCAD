import type { SelectedEntity } from '../viewer';

export function sameEntity(a: SelectedEntity, b: SelectedEntity): boolean {
  return a.shapeId === b.shapeId && a.sub.type === b.sub.type && a.sub.index === b.sub.index;
}

export function entityKey(e: SelectedEntity): string {
  return `${e.shapeId}:${e.sub.type}:${e.sub.index}`;
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
