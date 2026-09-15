import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { arc, circle, line } from "../../core/2d/index.js";
import { coincident, tangent } from "../../core/constraints/index.js";
import { Extrude } from "../../features/extrude.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { instantiateEdgeAtoms } from "../../selection/atoms.js";
import { probeEdge } from "../../selection/probe.js";
import { FaceProps } from "../../oc/face-props.js";
import { Explorer } from "../../oc/explorer.js";
import { Edge } from "../../common/edge.js";
import { edgeRefsWhere, faceRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

const CORNERS: [number, number][] = [[47, 20], [47, -20], [-47, 20], [-47, -20]];
const CORNER_RADIUS = 13;

/** A 120×66 pad whose four corners are R13 arcs, with a Ø10 bore through the middle. */
function roundedPad(): [number, number][] {
  const [w, h, r] = [60, 33, CORNER_RADIUS];
  const l1 = line([-(w - r), -h], [w - r, -h]);
  const a1 = arc([w - r, -h], [w, -(h - r)], [w - r, -(h - r)]);
  const l2 = line([w, -(h - r)], [w, h - r]);
  const a2 = arc([w, h - r], [w - r, h], [w - r, h - r]);
  const l3 = line([w - r, h], [-(w - r), h]);
  const a3 = arc([-(w - r), h], [-w, h - r], [-(w - r), h - r]);
  const l4 = line([-w, h - r], [-w, -(h - r)]);
  const a4 = arc([-w, -(h - r)], [-(w - r), -h], [-(w - r), -(h - r)]);
  const ring = [l1, a1, l2, a2, l3, a3, l4, a4];
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    coincident(ring[i].end(), next.start());
    tangent(ring[i], next);
  }
  return CORNERS;
}

function onCorner(m: { x: number; y: number }): boolean {
  return CORNERS.some(([cx, cy]) => Math.abs(Math.hypot(m.x - cx, m.y - cy) - CORNER_RADIUS) < 1e-6);
}

function onBore(m: { x: number; y: number }): boolean {
  return Math.abs(Math.hypot(m.x, m.y) - 5) < 1e-6;
}

describe("partial cylinders synthesize cylinderCurve(), full ones cylinder()", () => {
  setupOC();

  function makePad() {
    sketch("xy", () => {
      roundedPad();
    });
    const pad = extrude(13) as Extrude;
    setLocation(pad, 4);
    sketch(pad.endFaces(), () => {
      circle([0, 0], 10);
    });
    const bore = cut(13);
    setLocation(bore, 8);
    const scene = render();
    expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
    return scene;
  }

  it("marks a rounded corner open and a bore closed", () => {
    const scene = makePad();
    const solid = findSolid(scene);
    const faces = Explorer.findFacesWrapped(solid);
    const corners = faceRefsWhere(solid, onCorner).map(r => faces[r.sub.index]);
    const bores = faceRefsWhere(solid, onBore).map(r => faces[r.sub.index]);
    expect(corners).toHaveLength(4);
    expect(bores).toHaveLength(1);
    for (const face of corners) {
      const props = FaceProps.getProperties(face.getShape());
      expect(props).toMatchObject({ surfaceType: 'cylinder', closed: false });
      expect(props.radius).toBeCloseTo(CORNER_RADIUS, 6);
    }
    const bore = FaceProps.getProperties(bores[0].getShape());
    expect(bore).toMatchObject({ surfaceType: 'cylinder', closed: true });
    expect(bore.radius).toBeCloseTo(5, 6);
  });

  it("describes the four rounded corners with cylinderCurve(), never the bore-only cylinder()", () => {
    const scene = makePad();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, onCorner);
    expect(refs).toHaveLength(4);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
    if (result.ok) {
      expect(result.preview).toContain('cylinderCurve()');
      expect(result.preview).not.toContain('.cylinder(');
    }
  });

  it("still describes the bore wall with cylinder()", () => {
    const scene = makePad();
    const solid = findSolid(scene);
    const refs = faceRefsWhere(solid, onBore);
    expect(refs).toHaveLength(1);

    const result = synthesizeApplyFeature(scene, refs, 'fillet', 2);
    expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
    if (result.ok) {
      const forms = [result.preview, ...result.alternatives];
      expect(forms.some(f => f.includes('cylinder()') || f.includes('cylinder(10)') || f.includes('internalFaces'))).toBe(true);
      expect(forms.some(f => f.includes('cylinderCurve'))).toBe(false);
    }
  });

  it("offers belongsToFace(face().cylinderCurve()) for an edge on a rounded corner", () => {
    const scene = makePad();
    const solid = findSolid(scene);
    // The top arc of the (47, 20) corner: its midpoint sits on that corner's circle at z = 13.
    const refs = edgeRefsWhere(solid, m =>
      Math.abs(m.z - 13) < 1e-6 && Math.abs(Math.hypot(m.x - 47, m.y - 20) - CORNER_RADIUS) < 1e-6);
    expect(refs).toHaveLength(1);

    const index = new SelectionIndex(scene);
    try {
      const attr = attributePick(scene, index, refs[0]);
      const universe = solid.getSubShapes('edge') as Edge[];
      const atoms = instantiateEdgeAtoms([probeEdge(attr.picked as Edge, attr.solidShape)], universe, true, [], []);
      const codes = atoms.map(a => a.code);
      expect(codes).toContain('.belongsToFace(face().cylinderCurve())');
      expect(codes).toContain('.belongsToFace(face().cylinderCurve(26))');
      expect(codes).not.toContain('.belongsToFace(face().cylinder())');
    } finally {
      index.dispose();
    }
  });
});
