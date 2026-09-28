// End to end through the kernel: a rendered part's `.material(id)` reaches
// the server's warning pass and its mass aggregate exactly as the render
// payload carries it (`row.type === 'part'`, `row.object.material`).

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import part from '../../lib/core/part.js';
import plane from '../../lib/core/plane.js';
import { testRect } from '../../lib/tests/helpers/profiles.js';
import { PartPropertiesAggregator } from '../src/fluidcad-server/part-properties.ts';

function bracket(material: string) {
  return part('Bracket', () => {
    sketch('xy', () => { testRect(10, 10); });
    extrude(10);
    // A second, disjoint solid: the part's final result is two bodies.
    sketch(plane('xy', { offset: 50 }), () => { testRect(10, 10); });
    extrude(10);
  }).material(material);
}

describe('part material through a real render', () => {
  setupOC();

  it('warns on the part row for an unknown id and sums the final solids into a mass for a known one', () => {
    bracket('fluidcad-aluminum-6061');
    const scene = render();
    const rows = scene.getRenderedObjects() as any[];
    const partRow = rows.find((r) => r.type === 'part');
    expect(partRow.object.material).toBe('fluidcad-aluminum-6061');
    expect(PartPropertiesAggregator.collectWarnings(rows, null)).toEqual([]);

    const manager = getSceneManager();
    const props = PartPropertiesAggregator.compute(
      rows, partRow.id, (shapeId) => manager.getShapeProperties(scene, shapeId), null, 'mm',
    )!;
    expect(props.name).toBe('Bracket');
    expect(props.solidCount).toBe(2);
    expect(props.shapeIds).toHaveLength(2);
    expect(props.volumeMm3).toBeCloseTo(2000, 6);
    expect(props.surfaceAreaMm2).toBeCloseTo(1200, 6);
    // Two equal cubes at z 0..10 and z 50..60 → centroid z = 30.
    expect(props.centroid.z).toBeCloseTo(30, 6);
    expect(props.material?.name).toBe('Aluminum 6061');
    expect(props.massG).toBeCloseTo(2 * 2.7, 6);
    expect(props.warning).toBeUndefined();
  });

  it('keeps the geometry and reports the unknown id', () => {
    bracket('unobtainium');
    const scene = render();
    const rows = scene.getRenderedObjects() as any[];
    const warnings = PartPropertiesAggregator.collectWarnings(rows, null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe('Unknown material: unobtainium');
    expect(rows[warnings[0].index].type).toBe('part');
    expect(rows[warnings[0].index].hasError).toBe(false);

    // The same id declared in the project map resolves.
    expect(PartPropertiesAggregator.collectWarnings(rows, { unobtainium: { name: 'Unobtainium', density: 42 } })).toEqual([]);

    const manager = getSceneManager();
    const props = PartPropertiesAggregator.compute(
      rows, rows[warnings[0].index].id, (shapeId) => manager.getShapeProperties(scene, shapeId), null, 'mm',
    )!;
    expect(props.volumeMm3).toBeCloseTo(2000, 6);
    expect(props.material).toEqual({ id: 'unobtainium' });
    expect(props.massG).toBeUndefined();
    expect(props.warning).toBe('Unknown material: unobtainium');
  });
});
