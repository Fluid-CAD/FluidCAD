import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import repeat from "../../core/repeat.js";
import fillet from "../../core/fillet.js";
import { line, circle, arc, rect } from "../../core/2d/index.js";
import { getCurrentScene } from "../../scene-manager.js";
import { Plane } from "../../math/plane.js";
import { Shape } from "../../common/shape.js";
import { Solid } from "../../common/solid.js";
import { Explorer } from "../../oc/explorer.js";
import { getOC } from "../../oc/init.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { THROUGH_ALL_FALLBACK, THROUGH_ALL_MARGIN, throughAllLength } from "../../helpers/through-all.js";
import { Scene } from "../../rendering/scene.js";
import { ISceneObject } from "../../core/interfaces.js";

/**
 * A flanged cone with a scalloped flute cut through it by a symmetric
 * through-all cut, then repeated around Z.
 *
 * Reduced versions of this do NOT reproduce the bug it guards: the failure
 * needs the first cut to leave an elevated tolerance behind (the r=1 arc
 * tangency and the -4° drafted walls do that, at ~1.4e-3 mm), which the
 * second cut's tool then amplifies. Cut the model down and the boolean stays
 * comfortably inside its limits — so it is kept whole on purpose.
 *
 * The flute profile is transcribed from the constrained sketch it was
 * reported with; the coordinates are that solve's output.
 */
function flutedCone(): ISceneObject {
  sketch('xy', () => {
    rect(55, 55).centered();
    fillet(6);
  });
  extrude(3);

  sketch('xy', () => {
    circle([0, 0], 44);
  });
  const cone = extrude(33).draft(-4);

  sketch(cone.endFaces(), () => {
    circle([0, 0], 30);
  });
  cut(30).draft(-4);

  sketch('xz', () => {
    line([-5, 33], [-4.6142148739, 27.4830156744]);
    arc([-4.6142148739, 27.4830156744], [1.4665302061, 8.4777368884])
      .center([37.2834752366, 30.4127875763]);
    arc([1.4665302061, 8.4777368884], [3.3168786619, 8.9302435261])
      .center([2.3193146116, 9]);
    line([3.3168786619, 8.9302435261], [5, 33]);
    line([-5, 33], [5, 33]);
  });

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
