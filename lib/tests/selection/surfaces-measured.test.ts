// Surfaces and curves are measured and addressed like solids: their
// properties say what they are (a surface has an area and no volume, a curve
// a length), and every lookup that names a face or an edge by shape id and
// index — properties, measure, hit test, resolve_selection, the pick
// universe — finds them and reports their kind.

import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import loft from "../../core/loft.js";
import plane from "../../core/plane.js";
import { circle, eArc, ellipse, line, spline } from "../../core/2d/index.js";
import { coincident } from "../../core/constraints/index.js";
import { testRect } from "../helpers/profiles.js";
import { TestSheets } from "../helpers/sheets.js";
import { TestCurves } from "../helpers/curves.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionResult } from "../../selection/resolve-selection.js";
import { buildPickUniverse } from "../../selection/expand.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import type { Scene } from "../../rendering/scene.js";
import type { Shape } from "../../common/shape.js";

type Built = { scene: Scene; solid: Shape; surface: Shape; curve: Shape };

/**
 * A 20 × 20 × 10 box at x = 50, beside a loaded 10 × 10 plate on XY from the
 * origin and a loaded three-edge curve: a line to (10, 0), a half circle of
 * radius 5 over to (20, 0), and a line down to (20, -10).
 */
function build(): Built {
  sketch("xy", () => {
    testRect(20, 20, { at: [50, 0] });
  });
  const e = extrude(10) as unknown as { getShapes(): Shape[] };
  const l = loadShapes([TestSheets.plate(10, 10), TestCurves.threeEdges()]);
  const scene = render();
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
  const loaded = l.getShapes();
  const surface = loaded.find(shape => shape.getType() === "surface")!;
  const curve = loaded.find(shape => shape.isWire() || shape.isEdge())!;
  expect(surface).toBeDefined();
  expect(curve).toBeDefined();
  return { scene, solid: e.getShapes()[0], surface, curve };
}

function resolved(result: ResolveSelectionResult): Extract<ResolveSelectionResult, { ok: true }> {
  expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
  return result as Extract<ResolveSelectionResult, { ok: true }>;
}

describe("surfaces and curves measured and addressed", () => {
  setupOC();
  useLoadedBodies();

  it("a surface has an area, a centroid and a box, and no volume", () => {
    const { scene, surface } = build();
    const props = getSceneManager().getShapeProperties(scene, surface.id)!;

    expect(props.kind).toBe("surface");
    expect(props.volumeMm3).toBeUndefined();
    expect(props.surfaceAreaMm2).toBeCloseTo(100, 6);
    expect(props.centroid.x).toBeCloseTo(5, 6);
    expect(props.centroid.y).toBeCloseTo(5, 6);
    expect(props.centroid.z).toBeCloseTo(0, 6);
    expect(props.boundingBox.min.x).toBeCloseTo(0, 6);
    expect(props.boundingBox.max.x).toBeCloseTo(10, 6);
    expect(props.boundingBox.max.y).toBeCloseTo(10, 6);
    expect(props.boundingBox.max.z - props.boundingBox.min.z).toBeCloseTo(0, 6);
  });

  it("a solid keeps its volume and area; a curve has a length", () => {
    const { scene, solid, curve } = build();
    const solidProps = getSceneManager().getShapeProperties(scene, solid.id)!;
    expect(solidProps.kind).toBe("solid");
    expect(solidProps.volumeMm3).toBeCloseTo(4000, 3);
    expect(solidProps.surfaceAreaMm2).toBeCloseTo(2 * 400 + 4 * 200, 3);
    expect(solidProps.centroid.z).toBeCloseTo(5, 6);

    const curveProps = getSceneManager().getShapeProperties(scene, curve.id)!;
    expect(curveProps.kind).toBe("curve");
    expect(curveProps.volumeMm3).toBeUndefined();
    expect(curveProps.surfaceAreaMm2).toBeUndefined();
    expect(curveProps.length).toBeCloseTo(20 + 5 * Math.PI, 6);
  });

  it("face and edge properties read a surface's faces and a curve's edges, with the edge's endpoints", () => {
    const { scene, surface, curve } = build();
    const manager = getSceneManager();

    expect(manager.getFaceProperties(scene, surface.id, 0)).toMatchObject({ surfaceType: "plane" });

    const line = manager.getEdgeProperties(scene, curve.id, 0)!;
    expect(line.curveType).toBe("line");
    expect(line.length).toBeCloseTo(10, 6);
    const ends = [line.start, line.end].map(p => [p.x, p.y, p.z].map(v => Math.round(v * 1e6) / 1e6 + 0));
    expect(ends).toEqual(expect.arrayContaining([[0, 0, 0], [10, 0, 0]]));

    const arc = manager.getEdgeProperties(scene, curve.id, 1)!;
    expect(arc.curveType).toBe("arc");
    expect(arc.radius).toBeCloseTo(5, 6);

    const rim = manager.getEdgeProperties(scene, surface.id, 0)!;
    expect(rim.curveType).toBe("line");
    expect(rim.length).toBeCloseTo(10, 6);
  });

  it("a face or an edge carries the surface or the curve it is part of, measured whole; a solid's carry none", () => {
    const { scene, solid, surface, curve } = build();
    const manager = getSceneManager();

    const face = manager.getFaceProperties(scene, surface.id, 0)!;
    expect(face.owner?.kind).toBe("surface");
    expect(face.owner?.kind === "surface" && face.owner.area).toBeCloseTo(100, 6);

    const arc = manager.getEdgeProperties(scene, curve.id, 1)!;
    expect(arc.owner?.kind).toBe("curve");
    expect(arc.owner?.kind === "curve" && arc.owner.length).toBeCloseTo(20 + 5 * Math.PI, 6);

    expect(manager.getEdgeProperties(scene, surface.id, 0)!.owner?.kind).toBe("surface");
    expect(manager.getFaceProperties(scene, solid.id, 0)!.owner).toBeUndefined();
    expect(manager.getEdgeProperties(scene, solid.id, 0)!.owner).toBeUndefined();
  });

  it("measure and hit test report what the entity is part of", () => {
    const { scene, surface, curve, solid } = build();
    const manager = getSceneManager();

    const measured = manager.measure(scene, [
      { shapeId: surface.id, kind: "face", index: 0 },
      { shapeId: curve.id, kind: "edge", index: 0 },
    ])!;
    expect(measured.entities.map(entity => entity.bodyKind)).toEqual(["surface", "curve"]);

    const onPlate = manager.hitTest(scene, surface.id, [5, 5, 10], [0, 0, -1], 0);
    expect(onPlate).toEqual({ type: "face", index: 0, bodyKind: "surface" });
    const onBox = manager.hitTest(scene, solid.id, [50, 0, 50], [0, 0, -1], 0);
    expect(onBox?.bodyKind).toBe("solid");
  });

  it("resolve_selection matches a surface's faces and a curve's edges with their body kind", () => {
    const { scene, surface, curve, solid } = build();

    const faces = resolved(SelectionResolver.resolve(scene, { expression: "face()" }));
    const bySurface = faces.matches.filter(match => match.shapeId === surface.id);
    expect(bySurface.map(match => match.bodyKind)).toEqual(["surface"]);
    expect(bySurface[0].summary.area).toBeCloseTo(100, 3);
    // A solid's matches leave the kind out: it is the common case.
    expect(faces.matches.filter(match => match.shapeId === solid.id).every(match => match.bodyKind === undefined)).toBe(true);

    const picked = resolved(SelectionResolver.resolve(scene, {
      picks: [
        { shapeId: curve.id, sub: { type: "edge", index: 1 } },
        { shapeId: surface.id, sub: { type: "edge", index: 2 } },
      ],
    }));
    expect(picked.matches.map(match => [match.shapeId, match.bodyKind, match.summary.form])).toEqual([
      [curve.id, "curve", "arc"],
      [surface.id, "surface", "line"],
    ]);
  });

  it("a curve's edges are resolved on the curve when a filter names them", () => {
    const { scene, curve } = build();
    const loadId = scene.getAllSceneObjects().find(obj => obj.getType() === "load")!.id;

    const lines = resolved(SelectionResolver.resolve(scene, { expression: `edge().line().from($obj["${loadId}"])` }));
    const onCurve = lines.matches.filter(match => match.shapeId === curve.id);
    expect(onCurve.length).toBe(2);
    expect(onCurve.every(match => match.bodyKind === "curve")).toBe(true);
    expect(lines.warning).toBeUndefined();
  });

  it("the pick universe holds a surface's faces and edges and a curve's edges", () => {
    const { scene, surface, curve } = build();
    const index = new SelectionIndex(scene);
    try {
      const faceOwners = new Set(buildPickUniverse(scene, index, "face").map(entry => entry.ref.shapeId));
      const edgeOwners = buildPickUniverse(scene, index, "edge").map(entry => entry.ref.shapeId);
      expect(faceOwners.has(surface.id)).toBe(true);
      expect(faceOwners.has(curve.id)).toBe(false);
      expect(edgeOwners.filter(id => id === surface.id).length).toBe(4);
      expect(edgeOwners.filter(id => id === curve.id).length).toBe(3);
    } finally {
      index.dispose();
    }
  });

  it("resolve_selection names a free-form face and a spline edge by their kind", () => {
    const base = sketch(plane("xy", 0), () => {
      circle([0, 0], 40);
    });
    const top = sketch(plane("xy", 30), () => {
      ellipse([0, 0], 5, 9);
    });
    loft(base, top);
    sketch("xy", () => {
      line([100, 0], [140, 0]);
      line([140, 0], [140, 20]);
      spline([140, 20], [126, 26], [114, 16], [100, 20]);
      line([100, 20], [100, 0]);
    });
    extrude(10);
    const scene = render();

    const walls = resolved(SelectionResolver.resolve(scene, { expression: "face().freeform()" }));
    expect(walls.matches).toHaveLength(1);
    expect(walls.matches[0].summary).toMatchObject({ form: "surface", surfaceType: "freeform" });
    // The match's own `kind` is what it is in the topology, never the surface's kind.
    expect(walls.matches[0].kind).toBe("face");

    const splines = resolved(SelectionResolver.resolve(scene, { expression: "edge().spline()" }));
    expect(splines.matches).toHaveLength(2);
    expect(splines.matches.map(m => m.summary)).toEqual([
      expect.objectContaining({ form: "curve", curveType: "spline", closed: false, planar: true }),
      expect.objectContaining({ form: "curve", curveType: "spline", closed: false, planar: true }),
    ]);

    // A form that says it all carries none of the extra fields.
    const lines = resolved(SelectionResolver.resolve(scene, { expression: "edge().line()" }));
    for (const field of ["surfaceType", "curveType", "closed", "planar", "recovered"] as const) {
      expect(lines.matches.every(m => m.summary[field] === undefined)).toBe(true);
    }
    const flat = resolved(SelectionResolver.resolve(scene, { expression: "face().planar()" }));
    expect(flat.matches.every(m => m.summary.surfaceType === undefined)).toBe(true);
  });

  it("resolve_selection tells a full ellipse from an elliptical arc, and a face recovered from a B-spline from a native one", () => {
    // A half ellipse closed by its long axis, extruded: two elliptical arcs. Beside it, a whole ellipse: two full ones.
    sketch("xy", () => {
      const arc = eArc([40, 0], [-40, 0], [0, 0], 40, 20);
      const chord = line([-40, 0], [40, 0]);
      coincident(arc.end(), chord.start());
      coincident(chord.end(), arc.start());
      ellipse([200, 0], 12, 6);
    });
    extrude(10);
    FreeformBodies.roundedLoft(400);
    const scene = render();
    expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);

    const ellipses = resolved(SelectionResolver.resolve(scene, { expression: "edge().ellipse()" }));
    expect(ellipses.matches.every(m => m.summary.form === "ellipse" && m.summary.planar === undefined)).toBe(true);
    expect(ellipses.matches.map(m => m.summary.closed).sort()).toEqual([false, false, true, true]);
    // closed() and open() split them as the summary reads them.
    const full = resolved(SelectionResolver.resolve(scene, { expression: "edge().ellipse().closed()" }));
    expect(full.matches.map(m => m.summary.closed)).toEqual([true, true]);

    const planar = resolved(SelectionResolver.resolve(scene, { expression: "face().planar()" }));
    // The loft's four flat walls are B-splines read as planes; every native plane leaves the field out.
    expect(planar.matches.filter(m => m.summary.recovered === true).map(m => m.summary.form)).toEqual(["plane", "plane", "plane", "plane"]);
    expect(planar.matches.filter(m => m.summary.recovered !== true).every(m => !("recovered" in m.summary))).toBe(true);
  });
});
