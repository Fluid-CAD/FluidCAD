import { describe, expect, it } from 'vitest';
import { setupOC } from '../setup.js';
import { Point } from '../../math/point.js';
import { EdgeOps } from '../../oc/edge-ops.js';
import { WireOps } from '../../oc/wire-ops.js';
import { LoftOps } from '../../oc/loft-ops.js';
import { SectionCompatibility } from '../../oc/loft/section-compatibility.js';
import { Skinning } from '../../oc/loft/skinning.js';
import { Explorer } from '../../oc/explorer.js';
import { ShapeValidator } from '../../oc/shape-validator.js';
import { evaluateBSplinePoint } from '../../oc/loft/curve-eval.js';

// Actual face/sketch profile vertices from the toggle-clamp reproduction.
const coordinates: [number, number, number][][] = [
  [
    [
      60.3094011998352,
      -2,
      45.000000000032145
    ],
    [
      60.3094011998352,
      2,
      45.000000000032145
    ],
    [
      44.309401199900336,
      2,
      45.00000002376967
    ],
    [
      44.309401199900336,
      -2,
      45.00000002376967
    ]
  ],
  [
    [
      47.93476878193662,
      7.205418100290924,
      57.50000001839091
    ],
    [
      45.10634165719043,
      4.376990975544732,
      57.500000022586846
    ],
    [
      56.420050156175186,
      -6.936717523440024,
      57.500000005803095
    ],
    [
      59.24847728092138,
      -4.108290398693832,
      57.500000001607155
    ]
  ],
  [
    [
      54.3094012369224,
      8.000000000001053,
      70.00000000893421
    ],
    [
      50.30940123692239,
      8.00000000000053,
      70.00000001486816
    ],
    [
      50.30940123692239,
      -7.999999999997485,
      70.00000001486816
    ],
    [
      54.3094012369224,
      -7.999999999998007,
      70.00000000893421
    ]
  ]
];

function profiles(reverse = false) {
  const points = coordinates.map(ps => ps.map(p => Point.fromArray(p)));
  const wires = points.map((ps, k) => {
    const ordered = reverse && k === 1 ? [...ps].reverse() : ps;
    return WireOps.makeWireFromEdges(ordered.map((p, i) => EdgeOps.makeLineEdge(p, ordered[(i + 1) % ordered.length])));
  });
  return { wires, connections: points[0].map((p, i) => [p, points[1][(i + 2) % 4], points[2][(i + 2) % 4]]) };
}

describe('automatic loft corner correspondence', () => {
  setupOC();

  it.each(['none', 'start', 'end', 'both'] as const)('keeps matching corners with %s conditions', mode => {
    const { wires, connections } = profiles();
    const normal = { kind: 'normal' as const, magnitude: 1 };
    const compatible = SectionCompatibility.build(wires.map(w => w.getShape()));
    const skin = Skinning.skinSections(compatible,
      mode === 'start' || mode === 'both' ? normal : undefined,
      mode === 'end' || mode === 'both' ? normal : undefined);
    const solid = Skinning.buildLoftSolid(compatible, skin.grid, skin.vBasis);
    const validation = ShapeValidator.validate(solid.getShape());
    expect(validation.findings).toEqual([]);
    expect(validation.faces).toBe(6);
    const edges = Explorer.findEdgesWrapped(solid);
    try {
      for (const connection of connections) {
        expect(edges.some(e => connection.every(p => EdgeOps.distancePointToEdge(p, e) < 1e-6))).toBe(true);
      }
    } finally {
      for (const edge of edges) {
        edge.dispose();
      }
    }
    if (mode === 'none') {
      const [plain] = LoftOps.makeLoft(wires);
      expect(validation.solidVolumes[0]).toBeCloseTo(ShapeValidator.signedVolume(plain.getShape()), 5);
    }
  });

  it('keeps the matching when the middle wire winding is reversed', () => {
    const { wires, connections } = profiles(true);
    const [solid] = LoftOps.makeLoft(wires, { startCondition: { kind: 'normal', magnitude: 1 } });
    const edges = Explorer.findEdgesWrapped(solid);
    try {
      for (const connection of connections) {
        expect(edges.some(e => connection.every(p => EdgeOps.distancePointToEdge(p, e) < 1e-6))).toBe(true);
      }
    } finally {
      for (const edge of edges) {
        edge.dispose();
      }
    }
  });

  it('aligns unequal corner spans while ignoring a collinear edge split', () => {
    const bottom = [[-10, -3], [10, -3], [10, 3], [-10, 3]].map(([x, y]) => new Point(x, y, 0));
    const top = [[-5, -8], [5, -8], [5, 8], [-5, 8]].map(([x, y]) => new Point(x + 40, y, 1000000));
    const outline = [top[2], top[3], top[0], new Point(40, -8, 1000000), top[1]];
    const wires = [bottom, outline].map(ps => WireOps.makeWireFromEdges(ps.map((p, i) =>
      EdgeOps.makeLineEdge(p, ps[(i + 1) % ps.length]),
    )));
    const compatible = SectionCompatibility.build(wires.map(w => w.getShape()));
    expect(compatible.creases).toHaveLength(3);
    for (const [i, u] of [0, ...compatible.creases].entries()) {
      for (const [k, expected] of [bottom, top].entries()) {
        const actual = evaluateBSplinePoint({ ...compatible, poles: compatible.sections[k].poles }, u);
        expect(Point.fromArray(actual as [number, number, number]).distanceTo(expected[i])).toBeLessThan(1e-6);
      }
    }
  });
});
