import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import { runFluid } from "../helpers/run-fluid.js";
import { Explorer } from "../../oc/explorer.js";
import { FaceQuery } from "../../oc/face-query.js";
import { ShapeProps } from "../../oc/props.js";
import { ShapeValidator } from "../../oc/shape-validator.js";
import { SplitOps } from "../../oc/split-ops.js";
import { ColorTransfer } from "../../oc/color-transfer.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { Scene } from "../../rendering/scene.js";
import { Solid } from "../../common/solid.js";
import { Face } from "../../common/face.js";

// A sphere of r = 21.2 with a half-round groove around each pole (test.part.js,
// 2026-10-28): revolved about Z, split at the YZ plane, the kept half copied,
// turned 90° about X and 180° about Z, and the two fused. The grooves of the
// two halves meet at the cut with the same cross-section, so the channel runs
// on round the ball and the sphere surface is left as two tennis-ball patches.
const GROOVED_HALF_BALL = `
  const s = sketch('xz', () => {
    const c1 = circle([0, 0], 60);
    const l1 = line([30, 0], [0, 30]);
    const l2 = line([0, 30], [-30, 0]);
    const l3 = line([-30, 0], [0, -30]);
    const l4 = line([0, -30], [30, 0]);
    const c2 = circle([0, 0], 60).guide();
    const c3 = circle([15, 15], 17.57);
    const c4 = circle([15, -15], 17.57);
    const c5 = circle([0, 0], 42.43);
    const l5 = line([0, -26.23], [0, 26.58]);
    coincident(c1.center(), origin());
    diameter(c1, 60);
    coincident(l1.end(), l2.start());
    coincident(l2.end(), l3.start());
    coincident(l3.end(), l4.start());
    coincident(l4.end(), l1.start());
    equal(l1, l2, l3, l4);
    coincident(l1.start(), c2);
    coincident(l2.start(), c2);
    coincident(l3.start(), c2);
    coincident(l4.start(), c2);
    coincident(c2.center(), origin());
    tangent(c3, c1);
    coincident(c3.center(), l1);
    midpoint(c3.center(), l2.start(), l4.end());
    coincident(l2.start(), c1);
    symmetric(c3, c4, xAxis());
    coincident(c5.center(), origin());
    coincident(l5.end(), yAxis());
    vertical(l5);
    coincident(l2.start(), yAxis());
    region('r2', far(c3), c5, far(l5), far(c4));
  }).close();
  revolve('z', s).region('r2');
`;
const SPLIT = `const f = split('yz', { keep: 'front' });\n`;
const TURN_AND_FUSE = `
  const f2 = rotate('x', 90, true, f);
  const f3 = rotate('z', 180, f2);
  fuse(f3, f);
`;

function solids(scene: Scene): Solid[] {
  const all = new Set(scene.getAllSceneObjects());
  return scene.getAllSceneObjects().flatMap(o => o.getShapes({}, 'solid', all)) as Solid[];
}

function errors(scene: Scene): string[] {
  return scene.getSceneObjects().map(o => o.getError()).filter((e): e is string => !!e);
}

function facesByKind(solid: Solid): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const face of Explorer.findFacesWrapped(solid)) {
    const kind = FaceQuery.getSurfaceType(face);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

function volume(solid: Solid): number {
  return ShapeProps.getProperties(solid.getShape()).volumeMm3;
}

/** The volume of the model `code` builds, rendered in a scene of its own. */
function volumeOf(code: string): number {
  getSceneManager().startScene();
  getSceneManager().setCurrentFile("");
  runFluid(code);
  const v = volume(solids(render())[0]);
  getSceneManager().startScene();
  getSceneManager().setCurrentFile("");
  return v;
}

describe("a revolved ball split at its sketch plane", () => {
  setupOC();

  // The splitter cuts every revolved face at the revolve's own seam (the
  // sketch plane): the band in two, each cap in two, each groove in two.
  // The split merges them back, as the booleans simplify their results.
  it("comes out of the split with whole faces", () => {
    runFluid(GROOVED_HALF_BALL + SPLIT);
    const scene = render();
    expect(errors(scene)).toEqual([]);
    const [half] = solids(scene);
    expect(facesByKind(half)).toEqual({ sphere: 3, torus: 2, plane: 1 });
    expect(ShapeValidator.validate(half.getShape()).findings).toEqual([]);
  });

  it("tells two pieces of one sphere or torus apart from two surfaces", () => {
    runFluid(GROOVED_HALF_BALL);
    const [ball] = solids(render());
    const colors = ColorTransfer.viewOf([], ball);
    const plane = new Plane(new Point(0, 0, 0), new Vector3d(0, 1, 0), new Vector3d(1, 0, 0));
    const { pieces, colors: carried } = SplitOps.splitSolidByPlane({ shape: ball, colors }, plane);
    colors.delete();
    try {
      const front = pieces.find(p => p.side === 'front')!.solid;
      const faces = Explorer.findFacesWrapped(front) as Face[];
      const spheres = faces.filter(f => FaceQuery.getSurfaceType(f) === 'sphere');
      const tori = faces.filter(f => FaceQuery.getSurfaceType(f) === 'torus');
      // The raw pieces: the band and the caps in two, the grooves in two.
      expect(spheres).toHaveLength(6);
      expect(tori).toHaveLength(4);
      // Every sphere piece lies on the one sphere.
      for (const a of spheres) {
        for (const b of spheres) {
          expect(FaceQuery.isSameSurface(a, b)).toBe(true);
        }
      }
      // The groove pieces pair up by groove: same torus for a groove's two halves, not across grooves.
      const sameTorus = tori.map(a => tori.filter(b => FaceQuery.isSameSurface(a, b)).length);
      expect(sameTorus).toEqual([2, 2, 2, 2]);
      expect(FaceQuery.isSameSurface(spheres[0], tori[0])).toBe(false);
    } finally {
      ColorTransfer.disposeCarried(carried);
      for (const piece of pieces) piece.solid.dispose();
    }
  });
});

describe("the fused tennis ball", () => {
  setupOC();

  it("chamfers the rim of a groove", () => {
    const before = volumeOf(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE);

    runFluid(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE +
      `chamfer(1, select(edge().belongsToFace(face().torus()).above('xy', 18)));`);
    const scene = render();
    expect(errors(scene)).toEqual([]);
    const [ball] = solids(scene);
    expect(ShapeValidator.validate(ball.getShape()).findings).toEqual([]);
    expect(volume(ball)).toBeLessThan(before - 1);
  });

  // The sphere patches stay in pieces across the two halves (the kernel
  // cannot merge faces of one sphere carrying two pole axes once the group
  // wraps the whole sphere), so a cap's edges include the seam to the other
  // half's band. That seam is no corner: it is reported, the rim is chamfered.
  it("reports a seam in the selection and chamfers the rest", () => {
    const before = volumeOf(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE);

    runFluid(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE +
      `chamfer(1, select(edge().above('xy', 18)));`);
    const scene = render();
    const [message] = errors(scene);
    expect(message).toMatch(/^chamfer: \d+ of the \d+ selected edge\(s\) lie between two faces of one sphere/);
    expect(message).toMatch(/were chamfered/);
    const [ball] = solids(scene);
    expect(volume(ball)).toBeLessThan(before - 1);
  });

  it("refuses a selection of seams only, naming them", () => {
    const before = volumeOf(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE);

    runFluid(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE +
      `chamfer(1, select(edge().notBelongsToFace(face().torus()).above('xy', 18)));`);
    const scene = render();
    const [message] = errors(scene);
    expect(message).toMatch(/lie between two faces of one sphere/);
    expect(message).toMatch(/nothing to chamfer/);
    expect(volume(solids(scene)[0])).toBeCloseTo(before, 6);
  });

  it("fillets the rim of a groove and reports a seam the same way", () => {
    runFluid(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE +
      `fillet(1, select(edge().belongsToFace(face().torus()).above('xy', 18)));`);
    expect(errors(render())).toEqual([]);

    getSceneManager().startScene();
    getSceneManager().setCurrentFile("");
    runFluid(GROOVED_HALF_BALL + SPLIT + TURN_AND_FUSE +
      `fillet(1, select(edge().notBelongsToFace(face().torus()).above('xy', 18)));`);
    const [message] = errors(render());
    expect(message).toMatch(/^fillet: .*nothing to fillet/);
  });
});
