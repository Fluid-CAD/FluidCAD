import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import fillet from "../../core/fillet.js";
import { line, circle, arc, origin, xAxis, yAxis } from "../../core/2d/index.js";
import {
  angle, symmetric, radius, distance, diameter, vertical, coincident, horizontal, tangent,
} from "../../core/constraints/index.js";
import { getCurrentScene } from "../../scene-manager.js";
import { Plane } from "../../math/plane.js";
import { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { Explorer } from "../../oc/explorer.js";
import { getOC } from "../../oc/init.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { THROUGH_ALL_FALLBACK, THROUGH_ALL_MARGIN, throughAllLength } from "../../helpers/through-all.js";
import { Scene } from "../../rendering/scene.js";
import { ISceneObject, ISolvedCircle } from "../../core/interfaces.js";

/**
 * A flanged cone with a scalloped flute cut through it by a symmetric
 * through-all cut, then repeated around Z.
 *
 * Reduced versions of this do NOT reproduce the bug it guards: the failure
 * needs the first cut to leave an elevated tolerance behind (the r=1 arc
 * tangency and the -4° drafted walls do that, at ~1.4e-3 mm), which the
 * second cut's tool then amplifies. Cut the model down and the boolean stays
 * comfortably inside its limits — so it is kept whole on purpose.
 */
function flutedCone(): ISceneObject {
  sketch('xy', () => {
    const l1 = line([-22.46, -26.8], [32.54, -26.8]);
    const l2 = line([32.54, -26.8], [32.54, 28.2]);
    const l3 = line([32.54, 28.2], [-22.46, 28.2]);
    const l4 = line([-22.46, 28.2], [-22.46, -26.8]);
    coincident(l1.end(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l3.end(), l4.start());
    coincident(l4.end(), l1.start());
    horizontal(l1);
    horizontal(l3);
    vertical(l2);
    vertical(l4);
    distance(l1.start(), l1.end(), 55);
    distance(l2.start(), l2.end(), 55);
    symmetric(l2.end(), l3.end(), yAxis());
    symmetric(l2.start(), l3.start(), xAxis());
    fillet(6, l2, l3, l4, l1);
  }, true);
  extrude(3);

  sketch('xy', () => {
    const c1 = circle([0, 0], 44) as ISolvedCircle;
    coincident(c1.center(), origin());
    diameter(c1, 44);
  }, true);
  const cone = extrude(33).draft(-4);

  sketch(cone.endFaces(), () => {
    const c2 = circle([0, 0], 30) as ISolvedCircle;
    coincident(c2.center(), origin());
    diameter(c2, 30);
  }, true);
  cut(30).draft(-4);

  sketch('xz', () => {
    const l5 = line([-5, 33], [-4.59, 27.09]);
    const a1 = arc([-4.59, 27.09], [1.25, 8.49], [37.31, 30.02]);
    const a2 = arc([1.25, 8.49], [3.11, 8.93], [2.11, 9]);
    const l6 = line([3.11, 8.93], [4.79, 33]);
    const l7 = line([-5, 33], [5, 33]);
    coincident(a1.start(), l5.end());
    tangent(l5, a1);
    coincident(a2.start(), a1.end());
    tangent(a1, a2);
    coincident(l6.start(), a2.end());
    tangent(a2, l6);
    angle(yAxis(), l5.start(), 4);
    radius(a1, 42);
    radius(a2, 1);
    angle(l6, yAxis(), 4);
    horizontal(l5.start(), l6.end());
    coincident(l7.start(), l5.start());
    horizontal(l7);
    distance(l7, a2, 25).max();
    distance(l6.end(), xAxis(), 33);
    distance(l7.end(), yAxis(), 5);
    distance(l7.start(), l7.end(), 10, 'x');
    distance(l6.end(), yAxis(), 5);
  }, true);

  return cut().symmetric();
}

/**
 * `repeat('rotate', axis, object)` with the angle left out. The overload
 * reserves that slot for the angle, which the runtime resolves by type.
 */
const rotateRepeat = repeat as unknown as
  (type: 'rotate', axis: string, ...rest: unknown[]) => ISceneObject;

function renderErrors(scene: Scene): string[] {
  return scene.getRenderedObjects()
    .filter(r => r.hasError || r.errorMessage)
    .map(r => `${r.uniqueType}: ${r.errorMessage}`);
}

/**
 * Every distinct solid left in the scene. A repeat container re-exposes its
 * child's shapes, so the same Solid arrives under two owners — dedupe by
 * identity rather than counting it twice.
 */
function sceneSolids(): Solid[] {
  const solids = new Set<Solid>();
  for (const obj of getCurrentScene().getAllSceneObjects()) {
    for (const shape of obj.getShapes()) {
      if (shape.getType() === 'solid') {
        solids.add(shape as Solid);
      }
    }
  }
  return [...solids];
}

function facesWithoutTriangulation(solid: Shape): number {
  const oc = getOC();
  let missing = 0;
  for (const face of Explorer.findFacesWrapped(solid)) {
    const loc = new oc.TopLoc_Location();
    const tri = oc.BRep_Tool.Triangulation(face.getShape(), loc, 0);
    loc.delete();
    if (!tri) {
      missing++;
    }
  }
  return missing;
}

function isValid(solid: Shape): boolean {
  const oc = getOC();
  const checker = new oc.BRepCheck_Analyzer(solid.getShape(), true, true);
  const valid = checker.IsValid();
  checker.delete();
  return valid;
}

/**
 * A repeated symmetric through-all cut used to hand the kernel a 200 m tool
 * against a 55 mm part. The boolean came back invalid with ~39 mm tolerances,
 * ShapeFix then reduced the body to two faces, and the unmeshable cone that
 * was left surfaced as "Cannot read properties of null (reading 'isNull')".
 */
describe("through-all cut tool sizing", () => {
  setupOC();

  function expectIntactBody() {
    const scene = render();
    expect(renderErrors(scene)).toEqual([]);

    const solids = sceneSolids();
    expect(solids).toHaveLength(1);

    const body = solids[0];
    expect(isValid(body)).toBe(true);
    expect(facesWithoutTriangulation(body)).toBe(0);
    // The shredded body had 2 faces; the intact one has the base plate, the
    // drafted cone, the bore and both flutes.
    expect(Explorer.findFacesWrapped(body).length).toBeGreaterThan(25);

    // A tolerance blow-up inflates the bounding box by the tolerance itself,
    // so the outer dimensions double as the health check: 55 mm plate, 33 tall.
    const box = ShapeOps.getBoundingBox(body);
    expect(box.minX).toBeCloseTo(-27.5, 0);
    expect(box.maxX).toBeCloseTo(27.5, 0);
    expect(box.minY).toBeCloseTo(-27.5, 0);
    expect(box.maxY).toBeCloseTo(27.5, 0);
    expect(box.minZ).toBeCloseTo(0, 0);
    expect(box.maxZ).toBeCloseTo(33, 0);
  }

  it("survives repeat('rotate') of a symmetric through-all cut", () => {
    // The reported statement: no angle, so it defaults to 90°.
    rotateRepeat('rotate', 'z', flutedCone());
    expectIntactBody();
  });

  it("survives repeat('circular') of a symmetric through-all cut", () => {
    repeat('circular', 'z', { count: 2, offset: 90 }, flutedCone());
    expectIntactBody();
  });

  // 60/90/120 were the angles the fixed 100 m tool failed at, and 180 silently
  // produced an unmodified body — sweep them all so a future re-tune of the
  // sizing can't quietly reintroduce an angle-dependent hole.
  for (const deg of [15, 45, 60, 90, 120, 180, 270]) {
    it(`cuts through at ${deg}°`, () => {
      rotateRepeat('rotate', 'z', deg, flutedCone());
      expectIntactBody();
    });
  }
});

describe("throughAllLength", () => {
  setupOC();

  it("sizes the tool to the stock's reach along the plane normal", () => {
    sketch('xy', () => { circle([0, 0], 40); });
    extrude(30);
    render();

    const body = sceneSolids()[0];
    // The body spans z 0..30, so the XY plane's reach is 30.
    // getBoundingBox overshoots a B-rep slightly, so match to the millimetre.
    expect(throughAllLength([body], [], Plane.XY())).toBeCloseTo(30 * THROUGH_ALL_MARGIN, 0);
    // From XZ the reach is the half-width of the 40 mm-diameter disc.
    expect(throughAllLength([body], [], Plane.XZ())).toBeCloseTo(20 * THROUGH_ALL_MARGIN, 0);
  });

  it("falls back to a fixed length with nothing to measure", () => {
    expect(throughAllLength([], [], Plane.XY())).toBe(THROUGH_ALL_FALLBACK);
  });
});
