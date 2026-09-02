import { describe, it, expect } from 'vitest';
import { entityKey, mergeUniqueEntities, sameEntity, toggleEntity } from '../src/helpers/entities';
import type { SelectedEntity } from '../src/viewer';

const face = (shapeId: string, index: number, instanceId?: string): SelectedEntity =>
  instanceId ? { shapeId, sub: { type: 'face', index }, instanceId } : { shapeId, sub: { type: 'face', index } };

/**
 * Assembly instances of one part share a shapeId, so an entity is identified
 * together with its instance; part-mode entities (no instance) keep their
 * old identity and key text.
 */
describe('selected-entity identity across assembly instances', () => {
  it('part-mode entities compare and key as before', () => {
    expect(sameEntity(face('s1', 0), face('s1', 0))).toBe(true);
    expect(sameEntity(face('s1', 0), face('s1', 1))).toBe(false);
    expect(entityKey(face('s1', 3))).toBe('s1:face:3');
  });

  it('the same face on two instances is two entities', () => {
    const a = face('s1', 0, 'inst-0');
    const b = face('s1', 0, 'inst-1');
    expect(sameEntity(a, b)).toBe(false);
    expect(entityKey(a)).not.toBe(entityKey(b));
    expect(mergeUniqueEntities([a], [b, a])).toEqual([a, b]);
    expect(toggleEntity(a, b)).toBe(b);
    expect(toggleEntity(a, face('s1', 0, 'inst-0'))).toBeNull();
  });

  it('a null instance equals an absent one', () => {
    expect(sameEntity(face('s1', 0), { shapeId: 's1', sub: { type: 'face', index: 0 }, instanceId: null })).toBe(true);
    expect(entityKey({ shapeId: 's1', sub: { type: 'face', index: 0 }, instanceId: null })).toBe('s1:face:0');
  });
});
