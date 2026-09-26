import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinateSystem } from "../math/coordinate-system.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { HelixOps } from "../oc/helix-ops.js";
import { getOC } from "../oc/init.js";
import { withUnit } from "../units/registry.js";
import { MM_PER_UNIT } from "../units/units.js";

const frame = new CoordinateSystem(Point.origin(), Vector3d.unitZ(), Vector3d.unitX());
afterEach(() => vi.restoreAllMocks());

describe("helix approximation accuracy", () => {
  it.each(["mm", "in", "m"] as const)("fits cylindrical and tapered curves in %s", unit => withUnit(unit, () => {
    const oc = getOC();
    const scale = 1 / MM_PER_UNIT[unit];
    for (const endRadius of [15, 25, 35]) {
      const edge = HelixOps.makeHelix(frame, 25 * scale, endRadius * scale, 0, 140 * scale, 10);
      const adaptor = new oc.BRepAdaptor_Curve(edge.getShape());
      try {
        // Check interior stations across every turn, against the analytic curve.
        for (let i = 0; i <= 200; i++) {
          const fraction = i / 200;
          const angle = -20 * Math.PI * fraction;
          const radius = 25 + (endRadius - 25) * fraction;
          const expected = new Point(radius * Math.cos(angle), radius * Math.sin(angle), 140 * fraction);
          const actual = adaptor.Value(20 * Math.PI * fraction);
          try {
            expect(new Point(actual.X() / scale, actual.Y() / scale, actual.Z() / scale).distanceTo(expected))
              .toBeLessThanOrEqual(1e-4);
          } finally { actual.delete(); }
        }
      } finally { adaptor.delete(); edge.dispose(); }
    }
  }));

  it.each([NaN, Infinity, -1, 0.01])("rejects successful fits reporting curve error %s and releases the result", error => {
    const oc = getOC();
    const approximate = oc.HelixGeom_Tools.ApprCurve3D;
    const release = vi.fn();
    const approximateSpy = vi.spyOn(oc.HelixGeom_Tools, "ApprCurve3D").mockImplementation((...args) => {
      const result = approximate(...args);
      return {
        ...result, theMaxError: error,
        [Symbol.dispose]() { release(); result[Symbol.dispose](); },
      };
    });
    expect(() => HelixOps.makeHelix(frame, 25, 25, 0, 28, 1))
      .toThrow(/helix approximation failed.*status 0.*curveError=.*tolerance=0.0001 mm.*turns=1/);
    expect(approximateSpy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    HelixOps.makeHelix(frame, 25, 25, 0, 28, 1).dispose();
  });

  it("releases failed approximation envelopes and reports the original status", () => {
    const oc = getOC();
    const approximate = oc.HelixGeom_Tools.ApprCurve3D;
    const release = vi.fn();
    vi.spyOn(oc.HelixGeom_Tools, "ApprCurve3D").mockImplementation((...args) => {
      const result = approximate(...args);
      return { ...result, returnValue: 2, [Symbol.dispose]() { release(); result[Symbol.dispose](); } };
    });
    expect(() => HelixOps.makeHelix(frame, 25, 25, 0, 28, 1)).toThrow(/status 2/);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
