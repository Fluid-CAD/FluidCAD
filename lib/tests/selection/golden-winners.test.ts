import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import { arc, circle, line } from "../../core/2d/index.js";
import { coincident, tangent } from "../../core/constraints/index.js";
import { IExtrude } from "../../core/interfaces.js";
import { Shape } from "../../common/shape.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { SelectionIndex } from "../../selection/selection-index.js";
import { attributePick } from "../../selection/attribution.js";
import { synthesizeSelectors, SelectorPart } from "../../selection/synthesis.js";
import { globalContext } from "../../selection/filter-search.js";
import type { PickRef } from "../../selection/types.js";
import type { Scene } from "../../rendering/scene.js";
import { testRect } from "../helpers/profiles.js";
import { edgeRefsWhere, findSolid, setLocation } from "./pick-helpers.js";

// What a pick on an ordinary prismatic solid writes: the winner and the
// listed alternatives, through the feature's bucket and scene-wide. Every
// expectation here was produced by the synthesizer as it stood before the
// kinds of step 08 (`a8a27c2e`), run over these same fixtures. The kind
// predicates, `facing()`, `closed()` / `open()` and the recovery of faces
// stored as B-splines must leave them alone: an existing model's picks keep
// writing the code they wrote. A changed line in this file is a changed
// model; the one deliberate change is listed where it stands (the washer).

type Mid = { x: number; y: number; z: number };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** A closed ring of lines and arcs, each tangent to the next. */
function tangentRing(ring: { start(): unknown; end(): unknown }[]) {
  for (let i = 0; i < ring.length; i++) {
    const next = ring[(i + 1) % ring.length];
    coincident(ring[i].end() as never, next.start() as never);
    tangent(ring[i] as never, next as never);
  }
}

/** A slot along x: half-round ends of radius `r` centred at (±cx, cy). */
function slotProfile(cx: number, r: number, cy = 0) {
  tangentRing([
    line([-cx, cy - r], [cx, cy - r]),
    arc([cx, cy - r], [cx, cy + r], [cx, cy]),
    line([cx, cy + r], [-cx, cy + r]),
    arc([-cx, cy + r], [-cx, cy - r], [-cx, cy]),
  ]);
}

/** A 2w × 2h pad centred on the origin whose four corners are arcs of radius `r`. */
function roundedPadProfile(w: number, h: number, r: number) {
  tangentRing([
    line([-(w - r), -h], [w - r, -h]),
    arc([w - r, -h], [w, -(h - r)], [w - r, -(h - r)]),
    line([w, -(h - r)], [w, h - r]),
    arc([w, h - r], [w - r, h], [w - r, h - r]),
    line([w - r, h], [-(w - r), h]),
    arc([-(w - r), h], [-w, h - r], [-(w - r), h - r]),
    line([-w, h - r], [-w, -(h - r)]),
    arc([-w, -(h - r)], [-(w - r), -h], [-(w - r), -(h - r)]),
  ]);
}

/** Refs of the solid's faces whose boundary edges' midpoints, taken together, satisfy `where`. */
function facesWhere(solid: Shape, where: (mids: Mid[]) => boolean): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findFacesWrapped(solid).forEach((face, index) => {
    const mids = face.getEdges().map(e => EdgeOps.getEdgeMidPoint(e));
    if (mids.length > 0 && where(mids)) {
      refs.push({ shapeId: solid.id, sub: { type: "face", index } });
    }
  });
  return refs;
}

function partText(part: SelectorPart): string {
  if (part.accessor === "select") {
    return `select(${part.filterArgs})`;
  }
  return `${part.accessor}(${part.indices ? part.indices.join(", ") : part.filterArgs ?? ""})`;
}

/**
 * The ranked selector texts for the picks, winner first: through the
 * producing feature's bucket, or scene-wide, as for a statement that cannot
 * be bound to a variable.
 */
function written(scene: Scene, refs: PickRef[], route: "bucket" | "sceneWide"): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    const result = synthesizeSelectors(scene, index, attrs, [], [], false, route === "bucket" ? undefined : () => false);
    expect(result.ok, result.ok === false ? result.reason : "").toBe(true);
    if (result.ok === false) {
      return [];
    }
    expect(result.groups).toHaveLength(1);
    return [result.groups[0].winner, ...result.groups[0].alternatives].map(partText);
  } finally {
    index.dispose();
  }
}

/** The `above` / `below` atoms the scene-wide search is offered for the picks: where it would place a cut. */
function cuts(scene: Scene, refs: PickRef[]): string[] {
  const index = new SelectionIndex(scene);
  try {
    const attrs = refs.map(ref => attributePick(scene, index, ref));
    return globalContext(scene, index, refs[0].sub.type as "edge" | "face").instantiate(attrs)
      .map(atom => atom.code)
      .filter(code => code.startsWith(".above(") || code.startsWith(".below("));
  } finally {
    index.dispose();
  }
}

type Golden = { bucket: string[]; sceneWide: string[]; cuts: string[] };

function expectWritten(scene: Scene, refs: PickRef[], picks: number, golden: Golden) {
  expect(refs).toHaveLength(picks);
  expect(written(scene, refs, "bucket")).toEqual(golden.bucket);
  expect(written(scene, refs, "sceneWide")).toEqual(golden.sceneWide);
  expect(cuts(scene, refs)).toEqual(golden.cuts);
}

function rendered(): { scene: Scene; solid: Shape } {
  const scene = render();
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
  return { scene, solid: findSolid(scene) };
}

describe("picks on prismatic solids write the code they wrote before the kind predicates", () => {
  setupOC();

  it("an extruded slot: a half-round end, both ends, their arc edges", () => {
    sketch("xy", () => {
      slotProfile(15, 5);
    });
    setLocation(extrude(10), 2);
    const { scene, solid } = rendered();

    expectWritten(scene, facesWhere(solid, mids => mids.every(m => m.x >= 15 - 1e-6)), 1, GOLDEN.slotEnd);
    expectWritten(scene, facesWhere(solid, mids => mids.every(m => Math.abs(m.x) >= 15 - 1e-6)), 2, GOLDEN.slotBothEnds);
    expectWritten(scene, edgeRefsWhere(solid, m => near(m.x, 20) && near(m.z, 10)), 1, GOLDEN.slotArc);
    expectWritten(scene, edgeRefsWhere(solid, m => near(Math.abs(m.x), 20) && near(m.z, 10)), 2, GOLDEN.slotBothArcs);
  });

  it("a slot pocket cut into a plate: its half-round end, with the cuts clear of the bulge", () => {
    sketch("xy", () => {
      testRect(56, 30, { at: [-28, -15] });
    });
    const plate = extrude(10) as IExtrude;
    setLocation(plate, 2);
    sketch(plate.endFaces(), () => {
      slotProfile(20, 5);
    });
    setLocation(cut(4), 6);
    const { scene, solid } = rendered();

    // The end's vertices sit at x = 20, it bulges to x = 25 and the plate
    // ends at x = 28: a cut past the end belongs beyond 25, not at 24.
    const onEnd = (m: Mid) => Math.abs(m.x) >= 20 - 1e-6 && Math.abs(m.x) <= 25 + 1e-6;
    expectWritten(scene, facesWhere(solid, mids => mids.every(m => onEnd(m) && m.x > 0)), 1, GOLDEN.pocketEnd);
    expectWritten(scene, facesWhere(solid, mids => mids.every(onEnd)), 2, GOLDEN.pocketBothEnds);
    expectWritten(scene, edgeRefsWhere(solid, m => near(m.x, 25) && near(m.z, 10)), 1, GOLDEN.pocketRimArc);
    expectWritten(scene, edgeRefsWhere(solid, m => near(m.x, 25) && near(m.z, 6)), 1, GOLDEN.pocketFloorArc);
  });

  it("two slot pockets in one plate: one end among four", () => {
    sketch("xy", () => {
      testRect(56, 60, { at: [-28, -30] });
    });
    const plate = extrude(10) as IExtrude;
    setLocation(plate, 2);
    sketch(plate.endFaces(), () => {
      slotProfile(20, 5, -15);
      slotProfile(10, 5, 15);
    });
    setLocation(cut(4), 6);
    const { scene, solid } = rendered();

    const longEnd = facesWhere(solid, mids => mids.every(m => m.x >= 20 - 1e-6 && m.x <= 25 + 1e-6 && m.y < 0));
    const shortEnd = facesWhere(solid, mids => mids.every(m => m.x >= 10 - 1e-6 && m.x <= 15 + 1e-6 && m.y > 0));
    expectWritten(scene, longEnd, 1, GOLDEN.twoPocketsLongEnd);
    expectWritten(scene, shortEnd, 1, GOLDEN.twoPocketsShortEnd);
    expectWritten(scene, [...longEnd, ...shortEnd], 2, GOLDEN.twoPocketsBothEnds);
  });

  it("a vertical bore beside a horizontal bore: each wall, each rim", () => {
    sketch("xy", () => {
      testRect(30, 30);
    });
    const block = extrude(30) as IExtrude;
    setLocation(block, 2);
    sketch(block.endFaces(), () => {
      circle([8, 20], 8);
    });
    setLocation(cut(30), 6);
    sketch("yz", () => {
      circle([10, 15], 8);
    });
    setLocation(cut(30, 30), 10);
    const { scene, solid } = rendered();

    const onVertical = (m: Mid) => Math.hypot(m.x - 8, m.y - 20) < 4 + 1e-6;
    const onHorizontal = (m: Mid) => Math.hypot(m.y - 10, m.z - 15) < 4 + 1e-6;
    const vertical = facesWhere(solid, mids => mids.length >= 2 && mids.every(onVertical));
    const horizontal = facesWhere(solid, mids => mids.length >= 2 && mids.every(onHorizontal));
    expectWritten(scene, vertical, 1, GOLDEN.verticalBore);
    expectWritten(scene, horizontal, 1, GOLDEN.horizontalBore);
    expectWritten(scene, edgeRefsWhere(solid, m => onVertical(m) && near(m.z, 30)), 1, GOLDEN.verticalBoreRim);
    expectWritten(scene, edgeRefsWhere(solid, m => onHorizontal(m) && near(m.x, 30)), 1, GOLDEN.horizontalBoreRim);
  });

  it("a boss beside a bore: the boss wall, the bore wall, their rims", () => {
    sketch("xy", () => {
      testRect(60, 30);
    });
    const plate = extrude(10) as IExtrude;
    setLocation(plate, 2);
    sketch(plate.endFaces(), () => {
      circle([15, 15], 8);
    });
    setLocation(cut(10), 6);
    sketch(plate.endFaces(), () => {
      circle([45, 15], 8);
    });
    setLocation(extrude(6), 10);
    const { scene, solid } = rendered();

    const onBoss = (m: Mid) => Math.hypot(m.x - 45, m.y - 15) < 4 + 1e-6;
    const onBore = (m: Mid) => Math.hypot(m.x - 15, m.y - 15) < 4 + 1e-6;
    expectWritten(scene, facesWhere(solid, mids => mids.length >= 2 && mids.every(m => onBoss(m) && m.z >= 10 - 1e-6)), 1, GOLDEN.bossWall);
    expectWritten(scene, facesWhere(solid, mids => mids.length >= 2 && mids.every(onBore)), 1, GOLDEN.boreWallBesideBoss);
    expectWritten(scene, facesWhere(solid, mids => mids.every(m => near(m.z, 16))), 1, GOLDEN.bossTop);
    expectWritten(scene, edgeRefsWhere(solid, m => near(m.z, 16)), 1, GOLDEN.bossTopRim);
    expectWritten(scene, edgeRefsWhere(solid, m => onBore(m) && near(m.z, 10)), 1, GOLDEN.boreRimBesideBoss);
  });

  it("a rounded pad with a bore: a corner face, the four corners, a corner arc, the bore", () => {
    sketch("xy", () => {
      roundedPadProfile(60, 33, 13);
    });
    const pad = extrude(13) as IExtrude;
    setLocation(pad, 2);
    sketch(pad.endFaces(), () => {
      circle([0, 0], 10);
    });
    setLocation(cut(13), 6);
    const { scene, solid } = rendered();

    const onCorner = (cx: number, cy: number) => (m: Mid) => near(Math.hypot(m.x - cx, m.y - cy), 13);
    const onAnyCorner = (m: Mid) => [[47, 20], [47, -20], [-47, 20], [-47, -20]].some(([cx, cy]) => onCorner(cx, cy)(m));
    const onBore = (m: Mid) => Math.hypot(m.x, m.y) < 5 + 1e-6;
    expectWritten(scene, facesWhere(solid, mids => mids.every(onCorner(47, 20))), 1, GOLDEN.padCorner);
    expectWritten(scene, facesWhere(solid, mids => mids.every(onAnyCorner)), 4, GOLDEN.padFourCorners);
    expectWritten(scene, edgeRefsWhere(solid, m => onCorner(47, 20)(m) && near(m.z, 13) && m.x > 47 && m.y > 20), 1, GOLDEN.padCornerArc);
    expectWritten(scene, facesWhere(solid, mids => mids.length >= 2 && mids.every(onBore)), 1, GOLDEN.padBore);
    expectWritten(scene, edgeRefsWhere(solid, m => onBore(m) && near(m.z, 13)), 1, GOLDEN.padBoreRim);
  });

  it("a washer beside a wider one: its top face", () => {
    sketch("xy", () => {
      circle([0, 0], 40);
      circle([0, 0], 16);
    });
    setLocation(extrude(5), 2);
    sketch("xy", () => {
      circle([100, 0], 60);
      circle([100, 0], 16);
    });
    setLocation(extrude(5), 6);
    const scene = render();
    const solid = findSolid(scene);

    const top = facesWhere(solid, mids => mids.length === 2 && mids.every(m => near(m.z, 5)));
    expectWritten(scene, top, 1, GOLDEN.washerTop);
  });
});

const GOLDEN: Record<string, Golden> = {
  slotEnd: {
    bucket: [
      "sideFaces(face().above('yz'))",
      "sideFaces(face().farthest('x'))",
      "sideFaces(face().cylinderCurve().nth('x', 1))",
      "sideFaces(2)",
    ],
    sceneWide: [
      "select(face().above('yz'))",
      "select(face().farthest('x'))",
      "select(face().cylinderCurve().nth('x', 1))",
    ],
    cuts: [".above('yz')"],
  },
  slotBothEnds: {
    bucket: [
      "sideFaces(face().cylinderCurve())",
      "sideFaces(face().smallest())",
      "sideFaces(face().largest('radius'))",
      "sideFaces(0, 2)",
    ],
    sceneWide: ["select(face().cylinderCurve())", "select(face().smallest())", "select(face().largest('radius'))"],
    cuts: [],
  },
  slotArc: {
    bucket: [
      "endEdges(edge().above('yz'))",
      "endEdges(edge().farthest('x'))",
      "endEdges(edge().arc().nth('x', 1))",
      "endEdges(2)",
    ],
    sceneWide: [
      "select(edge().arc().above('yz').farthest('z'))",
      "select(edge().verticalTo('xz').above('yz').farthest('z'))",
      "select(edge().arc().above('yz').onPlane('xy', 10))",
    ],
    cuts: [".above('xy', 5)", ".above('yz')"],
  },
  slotBothArcs: {
    bucket: [
      "endEdges(edge().arc())",
      "endEdges(edge().verticalTo('xz'))",
      "endEdges(edge().parallelTo('yz'))",
      "endEdges(0, 2)",
    ],
    sceneWide: [
      "select(edge().arc().farthest('z'))",
      "select(edge().verticalTo('xz').farthest('z'))",
      "select(edge().arc().onPlane('xy', 10))",
    ],
    cuts: [".above('xy', 5)"],
  },
  pocketEnd: {
    bucket: [
      "internalFaces(face().above('yz'))",
      "internalFaces(face().farthest('x'))",
      "internalFaces(face().cylinderCurve().nth('x', 1))",
      "internalFaces(2)",
    ],
    sceneWide: [
      "select(face().cylinderCurve().above('yz'))",
      "select(face().above('yz').nearest('x'))",
      "select(face().edgeCount(4).farthest('z').farthest('x'))",
    ],
    cuts: [".above('xy', 3)", ".above('xz', -10)", ".below('xz', 10)", ".above('yz')", ".below('yz', 27)"],
  },
  pocketBothEnds: {
    bucket: [
      "internalFaces(face().cylinderCurve())",
      "internalFaces(face().smallest())",
      "internalFaces(face().largest('radius'))",
      "internalFaces(0, 2)",
    ],
    sceneWide: ["select(face().cylinderCurve())", "select(face().smallest())", "select(face().largest('radius'))"],
    cuts: [
      ".above('xy', 3)",
      ".above('xz', -10)",
      ".below('xz', 10)",
      ".above('yz', -26)",
      ".below('yz', 27)",
    ],
  },
  pocketRimArc: {
    bucket: [
      "startEdges(edge().above('yz'))",
      "startEdges(edge().farthest('x'))",
      "startEdges(edge().arc().nth('x', 1))",
      "startEdges(2)",
    ],
    sceneWide: [
      "select(edge().arc().convex().above('yz'))",
      "select(edge().verticalTo('xz').above('yz').belongsToFace(face().cylinderCurve()).convex())",
      "select(edge().above('yz').parallelTo('xy').belongsToFace(face().cylinderCurve()).convex())",
    ],
    cuts: [".above('xy', 8)", ".above('xz', -10)", ".below('xz', 10)", ".above('yz')", ".below('yz', 24)"],
  },
  pocketFloorArc: {
    bucket: [
      "endEdges(edge().above('yz'))",
      "endEdges(edge().farthest('x'))",
      "endEdges(edge().arc().nth('x', 1))",
      "endEdges(2)",
    ],
    sceneWide: [
      "select(edge().arc().concave().above('yz'))",
      "select(edge().concave().above('yz'))",
      "select(edge().verticalTo('xz').above('yz').belongsToFace(face().cylinderCurve()).nearest('z'))",
    ],
    cuts: [
      ".above('xy', 3)",
      ".below('xy', 8)",
      ".above('xz', -10)",
      ".below('xz', 10)",
      ".above('yz')",
      ".below('yz', 24)",
    ],
  },
  twoPocketsLongEnd: {
    bucket: [
      "internalFaces(face().farthest('x'))",
      "internalFaces(face().cylinderCurve().above('xz').nth('x', 1))",
      "internalFaces(2)",
      "internalFaces(face().above('yz', 15))",
    ],
    sceneWide: [
      "select(face().cylinderCurve().farthest('x'))",
      "select(face().above('xz').farthest('x'))",
      "select(face().above('yz', 15).cylinderCurve())",
    ],
    cuts: [".above('xy', 3)", ".above('xz')", ".below('xz', 25)", ".above('yz', 15)", ".below('yz', 27)"],
  },
  twoPocketsShortEnd: {
    bucket: [
      "internalFaces(face().above('yz').below('xz'))",
      "internalFaces(face().cylinderCurve().below('xz').farthest('x'))",
      "internalFaces(face().below('xz').farthest('x'))",
      "internalFaces(6)",
    ],
    sceneWide: [
      "select(face().above('yz').below('xz'))",
      "select(face().cylinderCurve().below('xz').farthest('x'))",
      "select(face().below('xz').farthest('x'))",
    ],
    cuts: [".above('xy', 3)", ".above('xz', -25)", ".below('xz')", ".above('yz')", ".below('yz', 18)"],
  },
  twoPocketsBothEnds: {
    bucket: ["internalFaces(face().above('yz'))", "internalFaces(2, 6)"],
    sceneWide: ["select(face().above('yz').cylinderCurve())"],
    cuts: [".above('xy', 3)", ".above('xz', -25)", ".below('xz', 25)", ".above('yz')", ".below('yz', 27)"],
  },
  verticalBore: {
    bucket: ["internalFaces()", "internalFaces(0)"],
    sceneWide: [
      "select(face().cylinder().nearest('x'))",
      "select(face().edgeCount(2).nearest('x'))",
      "select(face().cylinder().above('yz', 2))",
    ],
    cuts: [".above('xz', -25)", ".below('xz', -15)", ".above('yz', 2)", ".below('yz', 20)"],
  },
  horizontalBore: {
    bucket: ["internalFaces()", "internalFaces(0)"],
    sceneWide: [
      "select(face().cylinder().nearest('y'))",
      "select(face().edgeCount(2).nearest('y'))",
      "select(face().cylinder().above('xy', 10))",
    ],
    cuts: [".above('xy', 10)", ".below('xy', 20)", ".above('xz', -15)", ".below('xz', -5)"],
  },
  verticalBoreRim: {
    bucket: ["startEdges()", "startEdges(0)"],
    sceneWide: [
      "select(edge().circle().farthest('z'))",
      "select(edge().belongsToFace(face().cylinder()).farthest('z'))",
      "select(edge().onPlane('xz', -20).onPlane('xy', 30))",
    ],
    cuts: [
      ".above('xy', 20)",
      ".above('xz', -25)",
      ".below('xz', -15)",
      ".above('yz', 10)",
      ".below('yz', 20)",
    ],
  },
  horizontalBoreRim: {
    bucket: ["endEdges()", "endEdges(0)"],
    sceneWide: [
      "select(edge().circle().farthest('x'))",
      "select(edge().belongsToFace(face().cylinder()).farthest('x'))",
      "select(edge().onPlane('xz', -10).onPlane('yz', 30))",
    ],
    cuts: [
      ".above('xy', 10)",
      ".below('xy', 20)",
      ".above('xz', -15)",
      ".below('xz', -5)",
      ".above('yz', 20)",
    ],
  },
  bossWall: {
    bucket: ["sideFaces()", "sideFaces(0)"],
    sceneWide: [
      "select(face().cylinder().farthest('x'))",
      "select(face().edgeCount(2).farthest('x'))",
      "select(face().cylinder().above('xy', 5))",
    ],
    cuts: [
      ".above('xy', 5)",
      ".above('xz', -20)",
      ".below('xz', -10)",
      ".above('yz', 30)",
      ".below('yz', 50)",
    ],
  },
  boreWallBesideBoss: {
    bucket: ["internalFaces()", "internalFaces(0)"],
    sceneWide: [
      "select(face().cylinder().nearest('x'))",
      "select(face().edgeCount(2).nearest('x'))",
      "select(face().cylinder().below('xy', 13))",
    ],
    cuts: [
      ".below('xy', 13)",
      ".above('xz', -20)",
      ".below('xz', -10)",
      ".above('yz', 10)",
      ".below('yz', 30)",
    ],
  },
  bossTop: {
    bucket: ["endFaces()", "endFaces(0)"],
    sceneWide: ["select(face().circle())", "select(face().farthest('z'))", "select(face().smallest())"],
    cuts: [
      ".above('xy', 13)",
      ".above('xz', -20)",
      ".below('xz', -10)",
      ".above('yz', 30)",
      ".below('yz', 50)",
    ],
  },
  bossTopRim: {
    bucket: ["endEdges()", "endEdges(0)"],
    sceneWide: [
      "select(edge().farthest('z'))",
      "select(edge().circle().convex().farthest('x'))",
      "select(edge().onPlane('xy', 16))",
    ],
    cuts: [
      ".above('xy', 13)",
      ".above('xz', -20)",
      ".below('xz', -10)",
      ".above('yz', 30)",
      ".below('yz', 50)",
    ],
  },
  boreRimBesideBoss: {
    bucket: ["startEdges()", "startEdges(0)"],
    sceneWide: [
      "select(edge().circle().convex().nearest('x').farthest('z'))",
      "select(edge().belongsToFace(face().cylinder()).convex().nearest('x').farthest('z'))",
      "select(edge().circle().onPlane('xy', 10).convex())",
    ],
    cuts: [
      ".above('xy', 5)",
      ".below('xy', 13)",
      ".above('xz', -20)",
      ".below('xz', -10)",
      ".above('yz', 10)",
      ".below('yz', 30)",
    ],
  },
  padCorner: {
    bucket: [
      "sideFaces(face().below('xz').above('yz'))",
      "sideFaces(face().above('yz').farthest('y'))",
      "sideFaces(face().cylinderCurve().farthest('x').farthest('y'))",
      "sideFaces(4)",
    ],
    sceneWide: [
      "select(face().cylinderCurve().farthest('x').farthest('y'))",
      "select(face().edgeCount(4).smallest().farthest('x').farthest('y'))",
      "select(face().above('yz', 30).below('xz', -10))",
    ],
    cuts: [".below('xz', -10)", ".above('yz', 30)"],
  },
  padFourCorners: {
    bucket: [
      "sideFaces(face().cylinderCurve())",
      "sideFaces(face().smallest())",
      "sideFaces(face().largest('radius'))",
      "sideFaces(0, 2, 4, 6)",
    ],
    sceneWide: ["select(face().cylinderCurve())", "select(face().smallest())", "select(face().largest('radius'))"],
    cuts: [],
  },
  padCornerArc: {
    bucket: [
      "endEdges(edge().below('xz').above('yz'))",
      "endEdges(edge().above('yz').farthest('y'))",
      "endEdges(edge().arc().farthest('x').farthest('y'))",
      "endEdges(5)",
    ],
    sceneWide: [
      "select(edge().arc().farthest('x').farthest('y').farthest('z'))",
      "select(edge().arc().onPlane('xy', 13).above('yz', 30).below('xz', -10))",
      "select(edge().arc().onPlane('xy', 13).above('yz', 30).farthest('y'))",
    ],
    cuts: [".above('xy', 10)", ".below('xz', -10)", ".above('yz', 30)"],
  },
  padBore: {
    bucket: ["internalFaces()", "internalFaces(0)"],
    sceneWide: ["select(face().cylinder())", "select(face().smallest('radius'))", "select(face().edgeCount(2))"],
    cuts: [".above('xz', -10)", ".below('xz', 10)", ".above('yz', -30)", ".below('yz', 30)"],
  },
  padBoreRim: {
    bucket: ["startEdges()", "startEdges(0)"],
    sceneWide: [
      "select(edge().circle().farthest('z'))",
      "select(edge().onPlane('xz').farthest('z'))",
      "select(edge().circle().onPlane('xy', 13))",
    ],
    cuts: [".above('xy', 10)", ".above('xz', -10)", ".below('xz', 10)", ".above('yz')", ".below('yz', 30)"],
  },
  // The one deliberate change. Before, the atom read the washer's bore
  // (`circle(16)`), the filter its outer circle, so the atom never verified
  // and the third form was `face().onPlane('xy', 5).hasEdge(edge().circle(40))`.
  // The face properties and the filter now agree on the outer circle, so
  // `circle(40)` is written.
  washerTop: {
    bucket: ["endFaces()", "endFaces(0)"],
    sceneWide: [
      "select(face().circle().nearest('x').farthest('z'))",
      "select(face().parallelTo('xy').nearest('x').farthest('z'))",
      "select(face().onPlane('xy', 5).circle(40))",
    ],
    cuts: [".above('xy', 3)", ".below('yz', 100)"],
  },
};
