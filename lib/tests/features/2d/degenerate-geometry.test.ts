import { describe, it, expect } from "vitest";
import { setupOC, render } from "../../setup.js";
import { Geometry } from "../../../oc/geometry.js";
import { Point } from "../../../math/point.js";
import { Vector3d } from "../../../math/vector3d.js";
import sketch from "../../../core/sketch.js";
import { line } from "../../../core/2d/index.js";
import {
  coincident, horizontal, vertical, distance, angle,
} from "../../../core/constraints/index.js";

// Degenerate inputs (coincident points, ~zero radius) make several OCCT
// GC_ constructors raise Standard_ConstructionError, which the WASM
// binding aborts on with the cryptic "null function or function signature
// mismatch" BEFORE IsDone() is reachable. The Geometry wrapper validates
// first so every caller gets an honest error. Found via a zero-length
// line literal that the pre-collapse-guard drag write-back had committed
// into a sketch (Marwan's triangle, 2026-08-19).

describe("degenerate geometry inputs", () => {
  setupOC();

  it("makeSegment with coincident points throws a clear error", () => {
    expect(() => Geometry.makeSegment(new Point(1, 2, 0), new Point(1, 2, 0)))
      .toThrow(/zero-length segment/);
  });

  it("makeCircle and makeArc with ~zero radius throw clear errors", () => {
    const up = new Vector3d(0, 0, 1);
    expect(() => Geometry.makeCircle(new Point(0, 0, 0), 0, up))
      .toThrow(/radius must be positive/);
    expect(() =>
      Geometry.makeArc(new Point(0, 0, 0), 0, up, new Point(0, 0, 0), new Point(0, 0, 0)),
    ).toThrow(/radius must be positive/);
  });

  it("a zero-length line literal in a solved sketch errors that statement only", () => {
    // The collapsed literals the pre-guard write-back committed: l3 has
    // identical endpoints, and angle() conflicts with the (trivially
    // satisfied) horizontal/vertical.
    sketch('xy', () => {
      const l2 = line([236.96, 192.81], [116.96, 192.81]);
      const l1 = line([116.96, 192.81], [236.96, 192.81]);
      const l3 = line([236.96, 192.81], [236.96, 192.81]);
      horizontal(l1);
      coincident(l2.end(), l1.start());
      coincident(l3.start(), l1.end());
      vertical(l3);
      coincident(l2.start(), l3.end());
      distance(l2.end(), l2.start(), 120);
      angle(l3, l1, 80);
    }, true);
    const scene = render();

    const lines = scene.getRenderedObjects().filter(r => r.uniqueType === 'solved-line');
    expect(lines).toHaveLength(3);
    const broken = lines.filter(r => r.hasError);
    expect(broken).toHaveLength(1);
    expect(broken[0].errorMessage).toContain('zero-length segment');
    // The healthy lines still render their edges.
    expect(lines.filter(r => !r.hasError).every(r => r.sceneShapes.length > 0)).toBe(true);
  });
});
