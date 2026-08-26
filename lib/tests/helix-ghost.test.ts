import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import axis from "../core/axis.js";
import helix from "../core/helix.js";
import { circle } from "../core/2d/index.js";
import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { MeshBuilder } from "../rendering/mesh-builder.js";
import {
  buildFeatureGhost, FeatureGhostResult, GhostHelixSourceRef, HelixGhostRequest,
} from "../rendering/feature-ghost.js";
import { Scene, SceneObjectMesh } from "../rendering/scene.js";
import { testRect } from "./helpers/profiles.js";

const FILE = '/tmp/helix-ghost-test.fluid.js';

/** The dialog's From-axis defaults: a 15 mm coil, 4 turns, 10 mm apart. */
const BASE: Omit<HelixGhostRequest, 'source'> = {
  feature: 'helix',
  radius: 15,
  endRadius: null,
  pitch: 10,
  turns: 4,
  height: null,
  startOffset: null,
  endOffset: null,
};

function helixGhost(
  scene: Scene,
  source: GhostHelixSourceRef,
  overrides: Partial<HelixGhostRequest> = {},
): FeatureGhostResult {
  return buildFeatureGhost(scene, { ...BASE, ...overrides, source }, DEFAULT_MESH_CONFIG);
}

/** A world-axis `axis()` statement the way the parser records one. */
function locatedAxis(line: number, standard: 'x' | 'y' | 'z'): SceneObject {
  const a = axis(standard) as unknown as SceneObject;
  a.setSourceLocation({ filePath: FILE, line, column: 0 });
  return a;
}

/** The extent of a ghost curve, straight off the returned vertices. */
function bounds(result: FeatureGhostResult, body = 0) {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  return meshBounds(result.solids[body].meshes);
}

function meshBounds(meshes: SceneObjectMesh[]) {
  const vertices = meshes.flatMap(m => m.vertices);
  const along = (offset: number) => vertices.filter((_, i) => i % 3 === offset);
  const [xs, ys, zs] = [along(0), along(1), along(2)];
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

/** The scene's solids — what a viewport pick addresses. */
function solids(scene: Scene): Shape[] {
  const found: Shape[] = [];
  for (const obj of scene.getAllSceneObjects()) {
    found.push(...obj.getAddedShapes().filter(s => s.isSolid()));
  }
  return found;
}

/** A pick on the first solid's subshape matching `matches`, by mesh order. */
function pick(
  scene: Scene,
  kind: 'edge' | 'face',
  matches: (box: ReturnType<typeof ShapeOps.getBoundingBox>) => boolean,
): { shapeId: string; index: number } {
  for (const solid of solids(scene)) {
    const shapes: Shape[] = kind === 'edge'
      ? Explorer.findEdgesWrapped(solid)
      : Explorer.findFacesWrapped(solid);
    let found: { shapeId: string; index: number } | null = null;
    shapes.forEach((shape: Shape, index: number) => {
      if (!found && matches(ShapeOps.getBoundingBox(shape))) {
        found = { shapeId: solid.id, index };
      }
      shape.dispose();
    });
    if (found) {
      return found;
    }
  }
  throw new Error(`no ${kind} in the scene matches`);
}

/** A 20 mm box standing at x,y 0…20 — its vertical edges are pickable axes. */
function box(): void {
  sketch('xy', () => {
      testRect(20, 20);
    });
  extrude(20);
}

/** A cylinder r20 (circle() takes a diameter), z 0…50 — the face and edge sources. */
function cylinder(): void {
  sketch('xy', () => {
      circle([0, 0], 40);
    });
  extrude(50);
}

/**
 * What counts as "no extent at all" when picking by bounding box: the boxes
 * carry a 0.1 gap per side, so a flat one still measures 0.2 across — well
 * under any real span in these fixtures.
 */
const FLAT = 0.3;

describe("feature ghost — helix", () => {
  setupOC();

  it("draws the coil the dialog's values describe", () => {
    box();
    const scene = render();

    const result = helixGhost(scene, { kind: 'standard', axis: 'z' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // One curve, and one mesh in it — a helix is a single edge, so the ghost
    // never carries the face/edge mesh pair a solid does.
    expect(result.solids).toHaveLength(1);
    expect(result.solids[0].meshes).toHaveLength(1);
    expect(result.solids[0].meshes[0].vertices.length).toBeGreaterThan(0);
    const coil = bounds(result);
    expect(coil.maxX).toBeCloseTo(15, 1);
    expect(coil.minX).toBeCloseTo(-15, 1);
    expect(coil.maxY).toBeCloseTo(15, 1);
    expect(coil.minY).toBeCloseTo(-15, 1);
    // 4 turns at a 10 mm pitch climb 40 mm from the axis origin.
    expect(coil.minZ).toBeCloseTo(0, 3);
    expect(coil.maxZ).toBeCloseTo(40, 1);
  });

  /**
   * The ghost and the statement have to agree — they run the same builder
   * (`buildHelixEdge`), and this is what says so. Both sides are discretized
   * at the same deflection before measuring: a B-rep bounding box on a
   * B-spline bounds its control hull, not the curve.
   */
  it("draws exactly the curve an apply would build", () => {
    helix('z').radius(15).pitch(10).turns(4);
    const scene = render();

    const ghost = helixGhost(scene, { kind: 'standard', axis: 'z' });

    const applied = scene.getAllSceneObjects().find(o => o.getType() === 'helix')!;
    const meshes = new MeshBuilder(DEFAULT_MESH_CONFIG).build(applied.getAddedShapes()[0])!;
    const built = meshBounds(meshes);
    const drawn = bounds(ghost);
    expect(drawn.minX).toBeCloseTo(built.minX, 6);
    expect(drawn.maxX).toBeCloseTo(built.maxX, 6);
    expect(drawn.minY).toBeCloseTo(built.minY, 6);
    expect(drawn.maxY).toBeCloseTo(built.maxY, 6);
    expect(drawn.minZ).toBeCloseTo(built.minZ, 6);
    expect(drawn.maxZ).toBeCloseTo(built.maxZ, 6);
  });

  it("coils around an axis() statement named by call site", () => {
    locatedAxis(3, 'x');
    box();
    const scene = render();

    const coil = bounds(helixGhost(scene, { kind: 'axis', filePath: FILE, line: 3 }));

    // Around +x: the climb is along x, the radius spans y and z.
    expect(coil.minX).toBeCloseTo(0, 3);
    expect(coil.maxX).toBeCloseTo(40, 1);
    expect(coil.maxY).toBeCloseTo(15, 1);
    expect(coil.maxZ).toBeCloseTo(15, 1);
  });

  /**
   * The edit dialog's keep-source path: the helix being edited has already
   * consumed its own axis statement, which drops that axis's guide line from
   * the scene. The axis it stored survives that, and the ghost reads it.
   */
  it("still coils around an axis the edited statement already consumed", () => {
    const a = locatedAxis(3, 'x');
    helix(a as never).radius(5).turns(2);
    const scene = render();

    const coil = bounds(helixGhost(scene, { kind: 'axis', filePath: FILE, line: 3 }));

    expect(coil.maxX).toBeCloseTo(40, 1);
    expect(coil.maxY).toBeCloseTo(15, 1);
  });

  /**
   * The source slot's edge mode, which the apply writes as `axis(<selector>)`:
   * a `{shapeId, index}` viewport pick has to become the same line the build
   * would use. The box's vertical edges run along z at its corners, so the
   * coil centers on one — not on the origin, which is what a fallback to a
   * world axis would give.
   */
  it("turns a picked edge into the axis", () => {
    box();
    const scene = render();
    const edge = pick(scene, 'edge', b => b.maxZ - b.minZ > 19 && b.maxX - b.minX < FLAT);
    const at = cornerOf(scene, edge);

    const coil = bounds(helixGhost(scene, { kind: 'axis-edge', ...edge }));

    expect((coil.minX + coil.maxX) / 2).toBeCloseTo(at.x, 1);
    expect((coil.minY + coil.maxY) / 2).toBeCloseTo(at.y, 1);
  });

  /** Where a picked straight edge actually runs, for the assertion above. */
  function cornerOf(scene: Scene, ref: { shapeId: string; index: number }) {
    const solid = solids(scene).find(s => s.id === ref.shapeId)!;
    const edges = Explorer.findEdgesWrapped(solid);
    try {
      return EdgeOps.edgeToAxis(edges[ref.index]).origin;
    } finally {
      for (const edge of edges) {
        edge.dispose();
      }
    }
  }

  /**
   * The From-face tab. A cylindrical face fixes the radius and the axial
   * extent, which is exactly what the dialog leaves blank in face mode — so
   * the ghost has to read them off the face the way `Helix.build` does.
   */
  it("coils on a picked cylindrical face at the face's own radius and height", () => {
    cylinder();
    const scene = render();
    const face = pick(scene, 'face', b => b.maxZ - b.minZ > 49);

    const coil = bounds(helixGhost(scene, { kind: 'face', ...face }, {
      radius: null,
      pitch: null,
      turns: 5,
    }));

    expect(coil.maxX).toBeCloseTo(20, 1);
    expect(coil.minX).toBeCloseTo(-20, 1);
    expect(coil.minZ).toBeCloseTo(0, 3);
    expect(coil.maxZ).toBeCloseTo(50, 3);
  });

  /**
   * A bare edge source — `helix(select(edge().circle()))`, which only an edit
   * dialog's keep chip produces. It coils in the circle's own frame (radius
   * and center from the circle), which is a different curve from reading the
   * same edge as an axis — and reading it as one refuses outright, since a
   * circle is not a line.
   */
  it("coils in a circular edge's own frame", () => {
    cylinder();
    const scene = render();
    const edge = pick(scene, 'edge', b => b.maxZ - b.minZ < FLAT && b.maxZ > 49);

    const coil = bounds(helixGhost(scene, { kind: 'edge', ...edge }, { radius: null }));

    expect(coil.maxX).toBeCloseTo(20, 1);
    expect(coil.minX).toBeCloseTo(-20, 1);
    // A circle fixes the frame but not the climb: with no height set, this
    // source falls to the API default of 50 (the requested turns spread over
    // it, the pitch field ignored), running off the circle's own plane at
    // z = 50 in whichever direction its normal points.
    expect(coil.maxZ - coil.minZ).toBeCloseTo(50, 1);
    expect(Math.min(Math.abs(coil.minZ - 50), Math.abs(coil.maxZ - 50))).toBeCloseTo(0, 3);

    expect(helixGhost(scene, { kind: 'axis-edge', ...edge }).ok).toBe(false);
  });

  it("refuses a face no helix can coil on", () => {
    box();
    const scene = render();
    const face = pick(scene, 'face', b => b.maxZ - b.minZ < FLAT);

    expect(helixGhost(scene, { kind: 'face', ...face }).ok).toBe(false);
  });

  it("refuses a source the scene doesn't hold", () => {
    box();
    const scene = render();

    expect(helixGhost(scene, { kind: 'axis', filePath: FILE, line: 99 }).ok).toBe(false);
    expect(helixGhost(scene, { kind: 'face', shapeId: 'not-a-shape', index: 0 }).ok).toBe(false);
    expect(helixGhost(scene, { kind: 'edge', shapeId: 'not-a-shape', index: 0 }).ok).toBe(false);
  });

  /**
   * Values that describe no curve at all are ordinary mid-typing states, not
   * errors: an end offset that eats the whole height leaves the dialog with
   * nothing to draw, and it says so by drawing nothing.
   */
  it("stays silent when the values leave no curve to draw", () => {
    box();
    const scene = render();

    const result = helixGhost(scene, { kind: 'standard', axis: 'z' }, {
      height: 40,
      endOffset: -40,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.solids).toHaveLength(0);
    }
  });

  /**
   * Ghost shapes are unreachable from scene state, so `SceneDisposal` never
   * collects them — every one has to be freed on the way out. A double free
   * takes the process with it, so completing the loop is the assertion.
   */
  it("frees its shapes on every pass", () => {
    cylinder();
    const scene = render();
    const face = pick(scene, 'face', b => b.maxZ - b.minZ > 49);

    let last: FeatureGhostResult | null = null;
    for (let i = 0; i < 40; i++) {
      last = helixGhost(scene, { kind: 'face', ...face }, { radius: null, turns: 1 + i * 0.1 });
    }

    expect(last?.ok).toBe(true);
  });
});
