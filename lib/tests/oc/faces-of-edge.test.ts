import { describe, it, expect } from "vitest";
import type { TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import fillet from "../../core/fillet.js";
import { circle } from "../../core/2d/index.js";
import { Extrude } from "../../features/extrude.js";
import { Solid } from "../../common/solid.js";
import { Edge } from "../../common/edge.js";
import { TopologyIndex } from "../../oc/topology-index.js";
import { testL } from "../helpers/profiles.js";

function sceneSolids(): Solid[] {
  return getCurrentScene().getAllSceneObjects()
    .flatMap(o => o.getShapes())
    .filter((s): s is Solid => s instanceof Solid);
}

/** The edge→faces index's answer, each face once (a seam lists its face twice). */
function indexedFaces(solid: Solid, edge: Edge): TopoDS_Shape[] {
  const unique: TopoDS_Shape[] = [];
  for (const raw of TopologyIndex.seekShapes(solid.getEdgeToFacesIndex(), edge.getShape())) {
    if (!unique.some(kept => kept.IsSame(raw))) {
      unique.push(raw);
    }
  }
  return unique;
}

describe("Solid.getFacesOfEdge", () => {
  setupOC();

  it("answers what the edge→faces index does, in its order, as the solid's own face wrappers", () => {
    sketch("xy", () => {
      testL();
    });
    const e = extrude(30) as Extrude;
    fillet(3, e.sideEdges());
    sketch("xy", () => {
      circle([200, 0], 20);
    });
    extrude(10);
    render();

    const solids = sceneSolids();
    expect(solids.length).toBeGreaterThanOrEqual(2);
    let seams = 0;
    for (const solid of solids) {
      const own = new Set(solid.getFaces());
      // Every edge in pick-index space, seams included.
      for (const edge of solid.getIndexedShapes('edge') as Edge[]) {
        const faces = solid.getFacesOfEdge(edge);
        const expected = indexedFaces(solid, edge);
        expect(faces.length).toBe(expected.length);
        faces.forEach((face, i) => {
          expect(own.has(face)).toBe(true);
          expect(face.getShape().IsSame(expected[i])).toBe(true);
        });
        if (solid.isHiddenEdge(edge.getShape())) {
          seams++;
        }
        // Answered once per edge wrapper.
        expect(solid.getFacesOfEdge(edge)).toBe(faces);
      }
    }
    // The cylinder's seam is exercised: its face bounds it once, not twice.
    expect(seams).toBeGreaterThan(0);
  });

  it("is empty for an edge the solid does not own", () => {
    sketch("xy", () => {
      circle([0, 0], 20);
    });
    extrude(10);
    sketch("xy", () => {
      circle([200, 0], 20);
    });
    extrude(10);
    render();

    const [first, second] = sceneSolids();
    expect(second).toBeDefined();
    for (const edge of second.getEdges() as Edge[]) {
      expect(first.getFacesOfEdge(edge)).toEqual([]);
    }
  });
});
