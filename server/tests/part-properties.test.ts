// A part's mass properties are the sum over its FINAL solids — the ones the
// render leaves on screen inside the part (what the Shapes panel lists for
// its rows), not every intermediate feature — with a volume-weighted
// centroid, and a mass only when the part's `.material(id)` resolves against
// the merged table. An unknown id is a warning, never a failure.

import { describe, it, expect } from 'vitest';
import { PartPropertiesAggregator } from '../src/fluidcad-server/part-properties.ts';

type Row = {
  id: string;
  name: string;
  type: string;
  uniqueType?: string;
  parentId: string | null;
  object?: Record<string, unknown>;
  sceneShapes?: { shapeId: string; shapeType: string; isMetaShape?: boolean }[];
  sourceLocation?: { filePath: string; line: number; column: number };
};

const PROPS: Record<string, { volumeMm3: number; surfaceAreaMm2: number; centroid: { x: number; y: number; z: number } }> = {
  // Two solids: 1000 mm³ at x=0 and 3000 mm³ at x=40 → centroid x = 30.
  s1: { volumeMm3: 1000, surfaceAreaMm2: 600, centroid: { x: 0, y: 0, z: 5 } },
  s2: { volumeMm3: 3000, surfaceAreaMm2: 1400, centroid: { x: 40, y: 0, z: 5 } },
  // A solid outside the part, and a sketch face inside it — neither counts.
  other: { volumeMm3: 999, surfaceAreaMm2: 999, centroid: { x: 999, y: 0, z: 0 } },
  f1: { volumeMm3: 0, surfaceAreaMm2: 50, centroid: { x: 0, y: 0, z: 0 } },
};

function rows(material?: string): Row[] {
  return [
    { id: 'sk0', name: 'Sketch', type: 'sketch', parentId: null, sceneShapes: [{ shapeId: 'f1', shapeType: 'face' }] },
    { id: 'e0', name: 'Extrude', type: 'extrude', parentId: null, sceneShapes: [{ shapeId: 'other', shapeType: 'solid' }] },
    {
      id: 'p1', name: 'Bracket', type: 'part', uniqueType: 'part', parentId: null,
      object: material ? { name: 'Bracket', material } : { name: 'Bracket' },
      sceneShapes: [],
      sourceLocation: { filePath: '/ws/m.fluid.js', line: 4, column: 1 },
    },
    // The part's own sketch: a face, listed but not a solid.
    { id: 'sk1', name: 'Sketch', type: 'sketch', parentId: 'p1', sceneShapes: [{ shapeId: 'f1', shapeType: 'face' }] },
    // An intermediate feature the next one consumed leaves no scene shapes.
    { id: 'e1', name: 'Extrude', type: 'extrude', parentId: 'p1', sceneShapes: [] },
    { id: 'e2', name: 'Extrude', type: 'extrude', parentId: 'p1', sceneShapes: [{ shapeId: 's1', shapeType: 'solid' }] },
    // Nested container (a repeat) still belongs to the part.
    { id: 'r1', name: 'Repeat', type: 'repeat', parentId: 'p1', sceneShapes: [] },
    { id: 'e3', name: 'Extrude', type: 'extrude', parentId: 'r1', sceneShapes: [{ shapeId: 's2', shapeType: 'solid' }, { shapeId: 'meta', shapeType: 'solid', isMetaShape: true }] },
  ];
}

const lookup = (id: string) => PROPS[id] ?? null;

describe('PartPropertiesAggregator.compute', () => {
  it('sums volume and area over the part\'s final solids with a volume-weighted centroid', () => {
    const props = PartPropertiesAggregator.compute(rows(), 'p1', lookup, null, 'mm');
    expect(props).toEqual({
      partId: 'p1', name: 'Bracket', shapeIds: ['s1', 's2'], solidCount: 2,
      volumeMm3: 4000, surfaceAreaMm2: 2000, centroid: { x: 30, y: 0, z: 5 }, material: null,
    });
  });

  it('is null for an unknown id and for a row that is not a part', () => {
    expect(PartPropertiesAggregator.compute(rows(), 'nope', lookup, null, 'mm')).toBeNull();
    expect(PartPropertiesAggregator.compute(rows(), 'e2', lookup, null, 'mm')).toBeNull();
  });

  it('resolves a built-in material and reports mass in grams from the document unit', () => {
    const props = PartPropertiesAggregator.compute(rows('fluidcad-aluminum-6061'), 'p1', lookup, null, 'mm')!;
    expect(props.material).toEqual({
      id: 'fluidcad-aluminum-6061', name: 'Aluminum 6061', density: 2.7, densityUnit: 'g/cm³', source: 'builtin', densityGcm3: 2.7,
    });
    // 4000 mm³ = 4 cm³ × 2.7 g/cm³
    expect(props.massG).toBeCloseTo(10.8, 9);
    expect(props.warning).toBeUndefined();

    // An inch document: 4000 in³ × 16.387064 cm³/in³ × 2.7.
    const inches = PartPropertiesAggregator.compute(rows('fluidcad-aluminum-6061'), 'p1', lookup, null, 'in')!;
    expect(inches.massG).toBeCloseTo(4000 * 16.387064 * 2.7, 6);
  });

  it('resolves a project material, converting its declared density unit', () => {
    const project = { 'alloy-steel': { name: 'Alloy Steel', density: 0.0077, densityUnit: 'g/mm³' as const } };
    const props = PartPropertiesAggregator.compute(rows('alloy-steel'), 'p1', lookup, project, 'mm')!;
    expect(props.material?.source).toBe('project');
    expect(props.material?.densityGcm3).toBeCloseTo(7.7, 9);
    expect(props.massG).toBeCloseTo(4 * 7.7, 9);
  });

  it('keeps the geometry and warns for an unknown material, with no mass', () => {
    const props = PartPropertiesAggregator.compute(rows('unobtainium'), 'p1', lookup, null, 'mm')!;
    expect(props.volumeMm3).toBe(4000);
    expect(props.material).toEqual({ id: 'unobtainium' });
    expect(props.massG).toBeUndefined();
    expect(props.warning).toBe('Unknown material: unobtainium');
  });
});

describe('PartPropertiesAggregator.collectWarnings', () => {
  it('lists only part rows whose material is in neither table, with the row\'s index and location', () => {
    expect(PartPropertiesAggregator.collectWarnings(rows(), null)).toEqual([]);
    expect(PartPropertiesAggregator.collectWarnings(rows('fluidcad-pla'), null)).toEqual([]);
    expect(PartPropertiesAggregator.collectWarnings(rows('acme-pla'), { 'acme-pla': { name: 'ACME', density: 1.2 } })).toEqual([]);
    expect(PartPropertiesAggregator.collectWarnings(rows('acme-pla'), null)).toEqual([{
      index: 2, id: 'p1', name: 'Bracket', uniqueKind: 'part',
      message: 'Unknown material: acme-pla',
      sourceLocation: { filePath: '/ws/m.fluid.js', line: 4, column: 1 },
    }]);
  });
});
