import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import { getSceneManager } from "../scene-manager.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import plane from "../core/plane.js";
import select from "../core/select.js";
import sphere from "../core/sphere.js";
import { line, arc, circle } from "../core/2d/index.js";
import { edge, face } from "../filters/index.js";
import { getOC } from "../oc/init.js";
import { Explorer } from "../oc/explorer.js";
import { HiddenEdges } from "../oc/hidden-edges.js";
import { renderSolid } from "../rendering/render-solid.js";
import { Extrude } from "../features/extrude.js";
import { Solid } from "../common/solid.js";
import { Face } from "../common/face.js";
import { testRect } from "./helpers/profiles.js";

/**
 * A B-rep seam (the same face on both sides) and a degenerated edge are not
 * model edges: the renderer never draws them and no selection ever returns
 * one. This keeps a part looking the same wherever a cylinder's seam
 * happens to sit — the seam's angle comes from the sketch plane's X axis,
 * so two identical parts sketched on different planes must draw identical
 * edges.
 */
describe("hidden edges — seams and degenerated edges", () => {
  setupOC();

  function drawnEdges(solid: Solid) {
    return renderSolid(solid).filter(m => m.label === 'solid-edges');
  }

  /** Total polyline length of a set of edge meshes. */
  function drawnLength(meshes: { vertices: number[]; indices: number[] }[]): number {
    let total = 0;
    for (const m of meshes) {
      for (let i = 0; i + 1 < m.indices.length; i += 2) {
        const a = m.indices[i] * 3;
        const b = m.indices[i + 1] * 3;
        total += Math.hypot(m.vertices[b] - m.vertices[a], m.vertices[b + 1] - m.vertices[a + 1], m.vertices[b + 2] - m.vertices[a + 2]);
      }
    }
    return total;
  }

  function isSeamOfItsFace(solid: Solid, edgeIndex: number): boolean {
    const oc = getOC();
    const raw = Explorer.findEdgesWrapped(solid)[edgeIndex].getShape();
    const parents = solid.getEdgeToFacesIndex().Seek(raw);
    const face = oc.TopoDS.Face(parents.First());
    try {
      return HiddenEdges.ofFace(face).some(e => e.IsSame(raw));
    } finally {
      face.delete();
    }
  }

  it("a cylinder's seam is neither listed nor drawn, and the drawn edges keep their raw indices", () => {
    sketch("xy", () => {
      circle([0, 0], 40);
    });
    const e = extrude(30) as Extrude;
    render();

    const solid = e.getShapes()[0] as Solid;
    const raw = Explorer.findEdgesWrapped(solid);
    expect(raw).toHaveLength(3); // two rims + the seam
    expect(solid.getEdges()).toHaveLength(2);
    expect(solid.getEdges().every(edge => !solid.isHiddenEdge(edge.getShape()))).toBe(true);

    const drawn = drawnEdges(solid);
    expect(drawn).toHaveLength(2);
    for (const mesh of drawn) {
      // The index still addresses the raw explorer list the property and
      // measure tools read, and it never names the seam.
      expect(isSeamOfItsFace(solid, mesh.edgeIndex!)).toBe(false);
      expect(solid.isHiddenEdge(raw[mesh.edgeIndex!].getShape())).toBe(false);
    }

    // The side face counts its two rims only.
    const side = solid.getFaces().find(f => HiddenEdges.ofFace(f.getShape()).length > 0) as Face;
    expect(side).toBeDefined();
    expect(side.getEdges()).toHaveLength(2);
  });

  it("select(edge()) and the extrude accessors never hand back a seam", () => {
    sketch("xy", () => {
      circle([0, 0], 40);
    });
    const e = extrude(30) as Extrude;
    const all = select(edge()) as unknown as { getShapes(): Solid[] };
    const sides = e.sideEdges();
    const oneEdgeFaces = select(face().edgeCount(2)) as unknown as { getShapes(): Solid[] };
    render();

    expect(all.getShapes()).toHaveLength(2);
    expect(sides.getShapes()).toHaveLength(0);
    // The lateral face has exactly its two rims; the caps have one edge each.
    expect(oneEdgeFaces.getShapes()).toHaveLength(1);
  });

  it("a sphere has no model edges at all — its seam and both poles are hidden", () => {
    const s = sphere(20) as unknown as { getShapes(): Solid[] };
    render();

    const solid = s.getShapes()[0];
    expect(Explorer.findEdgesWrapped(solid).length).toBeGreaterThan(0);
    expect(solid.getEdges()).toHaveLength(0);
    expect(drawnEdges(solid)).toHaveLength(0);
  });

  /**
   * The case that motivated the rule: a Ø16 boss fused onto a web whose cap
   * arc is the same R8 cylinder. Sketched on the web's start face the circle
   * seam sits inside the coincident arc, and the fuse's own UnifySameDomain
   * leaves the merged face with a partial seam plus a duplicated arc; on an
   * offset plane the seam lands elsewhere and the face is plain. Both must
   * draw the same edges.
   */
  const R = 8;
  const CY = 45;
  const ang = Math.PI / 6;
  const px = R * Math.cos(ang);
  const py = CY + R * Math.sin(ang);
  const t = (py - 15) / Math.cos(ang);
  const bx = px + t * Math.sin(ang);

  function web(): Extrude {
    sketch(plane("xz", 20), () => {
      line([-bx, 15], [-px, py]);
      arc([-px, py], [px, py], [0, CY]).cw();
      line([px, py], [bx, 15]);
      line([bx, 15], [-bx, 15]);
    });
    return extrude(11) as Extrude;
  }

  function bossOn(target: unknown): Solid {
    sketch(target as Parameters<typeof sketch>[0], () => {
      circle([0, CY], 16);
      circle([0, CY], 10);
    });
    const boss = extrude(-15) as Extrude;
    render();
    return boss.getShapes()[0] as Solid;
  }

  it("a boss draws the same edges whether its seam falls inside the coincident arc or not", () => {
    const web1 = web();
    const seamInsideArc = bossOn(web1.startFaces());
    const drawnA = drawnEdges(seamInsideArc);
    // The two leftovers of the merge live on the R8 cylinder above the web's
    // end face (y <= -31) on its upper half: the 4 mm seam stub at the top
    // and the arc at y = -31 the wire traverses twice. Neither may be drawn.
    const onBossTopAboveWeb = (m: { vertices: number[] }) => {
      for (let i = 0; i < m.vertices.length; i += 3) {
        const [x, y, z] = [m.vertices[i], m.vertices[i + 1], m.vertices[i + 2]];
        if (Math.abs(Math.hypot(x, z - CY) - R) > 1e-3 || z < CY + 4.05 || y > -30.9) {
          return false;
        }
      }
      return true;
    };
    expect(drawnA.filter(onBossTopAboveWeb)).toHaveLength(0);
    for (const mesh of drawnA) {
      expect(isSeamOfItsFace(seamInsideArc, mesh.edgeIndex!)).toBe(false);
    }
    const lengthA = drawnLength(drawnA);

    // Fresh scene: same web, boss sketched on an offset plane instead. The
    // seam vertex now splits the web-junction arc in two, so edge counts
    // differ by one; what must agree is the line work on screen.
    getSceneManager().startScene();
    web();
    const seamOutsideArc = bossOn(plane("xz", 35));
    const drawnB = drawnEdges(seamOutsideArc);
    expect(drawnB.filter(onBossTopAboveWeb)).toHaveLength(0);

    expect(lengthA).toBeGreaterThan(0);
    expect(Math.abs(drawnLength(drawnB) - lengthA)).toBeLessThan(lengthA * 0.005);
  });

  it("flags tangent junctions as smooth and leaves creases plain", () => {
    // The web's slanted flanks run tangent into the boss cylinder: those two
    // lines are G1 junctions. The box-like rest of the model is all creases.
    web();
    const solid = bossOn(plane("xz", 35));
    const drawn = drawnEdges(solid);
    const smooth = drawn.filter(m => m.smooth);
    expect(smooth.length).toBeGreaterThanOrEqual(2);
    expect(smooth.length).toBeLessThan(drawn.length);
  });

  it("a plain box has no smooth edges", () => {
    sketch("xy", () => {
      testRect(40, 30);
    });
    const e = extrude(20) as Extrude;
    render();
    const solid = e.getShapes()[0] as Solid;
    const drawn = drawnEdges(solid);
    expect(drawn).toHaveLength(12);
    expect(drawn.some(m => m.smooth)).toBe(false);
  });
});
