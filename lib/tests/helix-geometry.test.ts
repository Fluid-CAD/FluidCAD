import { describe, expect, it } from "vitest";
import {
  buildResolvedHelixEdge, resolveHelixGeometry,
  type HelixDimensions, type HelixSourceKind,
} from "../features/helix-geometry.js";
import { Axis } from "../math/axis.js";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { getOC } from "../oc/init.js";

describe("resolved helix geometry", () => {
  const direction = new Vector3d(1, -2, 3).normalize();
  const frame = new CoordinateSystem(new Point(12, 34, -56), direction, Vector3d.unitX().cross(direction).normalize());

  it("retains the face axis and effective open-model dimensions", () => {
    const geometry = resolveHelixGeometry({
      kind: "cylinder-face", cs: frame, radius: 25, vMin: 0, vMax: 120,
    }, { turns: 5, startOffset: -10, endOffset: 10 });
    expect(geometry.frame).toBe(frame);
    expect(geometry.startRadius).toBeCloseTo(24.999999, 9);
    expect(geometry.endRadius).toBe(geometry.startRadius);
    expect(geometry.zStart).toBe(-10);
    expect(geometry.zEnd).toBe(130);
    expect((geometry.zEnd - geometry.zStart) / geometry.turns).toBe(28);
    expect(geometry.winding).toBe(-1);
    expect(geometry.parameterEnd).toBe(10 * Math.PI);
  });

  const cases: { name: string; source: HelixSourceKind; dimensions: HelixDimensions }[] = [
    { name: "axis with fractional ccw turns", source: { kind: "axis", axis: new Axis(frame.origin, direction) },
      dimensions: { radius: 25, pitch: 28, turns: 1.25, ccw: true } },
    { name: "cylinder with offsets", source: { kind: "cylinder-face", cs: frame, radius: 25, vMin: 0, vMax: 120 },
      dimensions: { turns: 5, startOffset: -10, endOffset: 10 } },
    { name: "outward cone with offsets", source: { kind: "cone-face", cs: frame, semiAngle: 0.1, refRadius: 20, vMin: 0, vMax: 80 },
      dimensions: { turns: 4, startOffset: -2, endOffset: 3 } },
    { name: "line with inward taper", source: { kind: "line-edge", axis: new Axis(frame.origin, direction), length: 80 },
      dimensions: { radius: 25, endRadius: 15, turns: 3, ccw: true } },
    { name: "circle with height", source: { kind: "circle-edge", cs: frame, radius: 12 },
      dimensions: { height: 42, pitch: 14 } },
  ];

  it.each(cases)("maps source angle to actual B-spline parameter: $name", ({ source, dimensions }) => {
    const geometry = resolveHelixGeometry(source, dimensions);
    const edge = buildResolvedHelixEdge(geometry);
    const adaptor = new (getOC().BRepAdaptor_Curve)(edge.getShape());
    try {
      expect(adaptor.FirstParameter()).toBeCloseTo(0, 10);
      expect(adaptor.LastParameter()).toBeCloseTo(geometry.parameterEnd, 10);
      for (let i = 0; i <= 80; i++) {
        const fraction = i / 80;
        const parameter = fraction * geometry.parameterEnd;
        const angle = geometry.winding * parameter;
        const radius = geometry.startRadius + (geometry.endRadius - geometry.startRadius) * fraction;
        const z = geometry.zStart + (geometry.zEnd - geometry.zStart) * fraction;
        const { frame } = geometry;
        const expected = frame.origin.add(frame.mainDirection.multiply(z))
          .add(frame.xDirection.multiply(radius * Math.cos(angle)))
          .add(frame.yDirection.multiply(radius * Math.sin(angle)));
        const point = adaptor.Value(parameter);
        try {
          expect(new Point(point.X(), point.Y(), point.Z()).distanceTo(expected)).toBeLessThan(1e-3);
        } finally {
          point.delete();
        }
      }
    } finally {
      adaptor.delete();
      edge.dispose();
    }
  });
});
