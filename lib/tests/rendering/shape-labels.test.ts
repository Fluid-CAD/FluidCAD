import { describe, it, expect } from "vitest";
import { ShapeLabels, type LabelledRow } from "../../rendering/shape-labels.js";

// One rule for the Shapes panel and the scene summary: `<Type> <n>`, n per
// part and per shape type, holders in timeline order, shapes in their
// holder's order; part-less shapes count under "Model"; meta shapes have no
// row. The helper reads the rendered payload only, so the ui and the server
// cannot drift apart.

const solid = (shapeId: string) => ({ shapeId, shapeType: 'solid' });
const face = (shapeId: string) => ({ shapeId, shapeType: 'face' });
const meta = (shapeId: string) => ({ shapeId, shapeType: 'solid', isMetaShape: true });

/** Two parts (two solids + a face, one solid), one top-level solid, one meta shape. */
function scene(): LabelledRow[] {
  return [
    { id: 'A', name: 'Bracket', type: 'part', sceneShapes: [] },
    { id: 'a1', name: 'Extrude 1', type: 'extrude', parentId: 'A', sceneShapes: [solid('s1'), meta('m1'), solid('s2')] },
    { id: 'a2', name: 'Boss', type: 'extrude', parentId: 'A', sceneShapes: [face('f1')] },
    { id: 'B', name: 'Lid', type: 'part', sceneShapes: [] },
    { id: 'b1', name: 'Extrude 2', type: 'extrude', parentId: 'B', sceneShapes: [solid('s3')] },
    { id: 't1', name: 'Extrude 3', type: 'extrude', sceneShapes: [solid('s4')] },
  ];
}

describe('ShapeLabels.labelsFor', () => {
  it('numbers per part and per shape type, in timeline order', () => {
    const labels = ShapeLabels.labelsFor(scene());
    expect([...labels.values()].map((l) => [l.shapeId, l.label, l.part])).toEqual([
      ['s1', 'Solid 1', 'Bracket'],
      ['s2', 'Solid 2', 'Bracket'],
      ['f1', 'Face 1', 'Bracket'],
      ['s3', 'Solid 1', 'Lid'],
      ['s4', 'Solid 1', null],
    ]);
  });

  it('skips meta shapes and shapes without an id', () => {
    const rows = scene();
    rows[1].sceneShapes = [solid('s1'), { shapeType: 'solid' }, solid('s2')];
    const labels = ShapeLabels.labelsFor(rows);
    expect(labels.has('m1')).toBe(false);
    // The id-less shape still takes its number: the rows the panel shows are "Solid 1" and "Solid 3".
    expect(labels.get('s2')?.label).toBe('Solid 3');
  });

  it('names the holder and the part row', () => {
    const rows = scene();
    const labels = ShapeLabels.labelsFor(rows);
    expect(labels.get('f1')?.holder).toBe(rows[2]);
    expect(labels.get('f1')?.partRow).toBe(rows[0]);
    expect(labels.get('s4')?.holder).toBe(rows[5]);
    expect(labels.get('s4')?.partRow).toBeNull();
  });

  it('files a shape held two levels under a part with that part', () => {
    const labels = ShapeLabels.labelsFor([
      { id: 'A', name: 'Bracket', type: 'part', sceneShapes: [] },
      { id: 'r', name: 'Repeat 1', type: 'repeat', parentId: 'A', sceneShapes: [] },
      { id: 'rc', name: 'Extrude 1', type: 'extrude', parentId: 'r', sceneShapes: [solid('s1')] },
      { id: 'top', name: 'Extrude 2', type: 'extrude', sceneShapes: [solid('s2')] },
    ]);
    expect(labels.get('s1')?.part).toBe('Bracket');
    expect(labels.get('s1')?.label).toBe('Solid 1');
    expect(labels.get('s2')?.part).toBeNull();
    expect(labels.get('s2')?.label).toBe('Solid 1');
  });

  it('files a part row\'s own shapes under that part', () => {
    const labels = ShapeLabels.labelsFor([
      { id: 'A', name: 'Bracket', type: 'part', sceneShapes: [solid('p1')] },
      { id: 'a1', name: 'Extrude 1', type: 'extrude', parentId: 'A', sceneShapes: [solid('s1')] },
    ]);
    expect(labels.get('p1')?.label).toBe('Solid 1');
    expect(labels.get('p1')?.part).toBe('Bracket');
    expect(labels.get('s1')?.label).toBe('Solid 2');
  });

  it('returns nothing for a scene without drawn shapes', () => {
    expect(ShapeLabels.labelsFor([{ id: 'A', name: 'Bracket', type: 'part', sceneShapes: [] }]).size).toBe(0);
    expect(ShapeLabels.labelsFor([]).size).toBe(0);
  });

  it('capitalises the type and falls back to "unknown"', () => {
    expect(ShapeLabels.typeLabel('solid')).toBe('Solid');
    const labels = ShapeLabels.labelsFor([{ id: 'x', type: 'extrude', sceneShapes: [{ shapeId: 'u1' }] }]);
    expect(labels.get('u1')?.label).toBe('Unknown 1');
    expect(labels.get('u1')?.shapeType).toBe('unknown');
  });
});
