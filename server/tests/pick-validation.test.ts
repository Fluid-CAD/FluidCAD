import { describe, expect, it } from 'vitest';
import { validatePick } from '../src/routes/apply-feature.ts';
import { SelectionRequests } from '../src/routes/selection-requests.ts';

describe('vertex pick validation', () => {
  it('opts point slots into vertices without widening existing face/edge slots', () => {
    const vertex = { shapeId: 'shape', sub: { type: 'vertex', index: 2 } };
    expect(validatePick(vertex, 'vertex')).toEqual(vertex);
    expect(validatePick(vertex)).toBeNull();
    const edge = { shapeId: 'shape', sub: { type: 'edge', index: 2 } };
    expect(validatePick(edge)).toEqual(edge);
    expect(validatePick(edge, 'vertex')).toBeNull();
  });

  it('rejects invalid indices and accepts vertex resolution requests', () => {
    for (const index of [-1, 0.5, NaN]) {
      expect(validatePick({ shapeId: 'shape', sub: { type: 'vertex', index } }, 'vertex')).toBeNull();
    }
    const picks = [{ shapeId: 'shape', kind: 'vertex', index: 0 }];
    expect(SelectionRequests.picksError(picks)).toBeNull();
    expect(SelectionRequests.asPicks(picks)).toEqual([{ shapeId: 'shape', sub: { type: 'vertex', index: 0 } }]);
  });
});
