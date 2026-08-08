import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import helix from "../core/helix.js";
import plane from "../core/plane.js";
import { circle, rect } from "../core/2d/index.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import {
  buildFeatureGhost, FeatureGhostResult, GhostPlaneBaseRef, PlaneGhostRequest,
} from "../rendering/feature-ghost.js";
import { Scene } from "../rendering/scene.js";

const FILE = '/tmp/plane-ghost-test.fluid.js';

const BASE: Omit<PlaneGhostRequest, 'bases'> = {
  feature: 'plane',
  type: 'offset',
  offset: null,
  rotateX: null,
  rotateY: null,
  rotateZ: null,
  position: null,
};

function planeGhost(
  scene: Scene,
  bases: GhostPlaneBaseRef[],
  overrides: Partial<PlaneGhostRequest> = {},
): FeatureGhostResult {
  return buildFeatureGhost(scene, { ...BASE, ...overrides, bases }, DEFAULT_MESH_CONFIG);
}

function sceneSolids(scene: Scene): Shape[] {
  const solids: Shape[] = [];
  for (const obj of scene.getSceneObjects()) {
    solids.push(...obj.getShapes(undefined, 'solid'));
  }
  return solids;
}

/** A plain 40 x 40 x 20 block. */
function block(): Solid {
  sketch('xy', () => { rect(40, 40); });
  extrude(20);
  return sceneSolids(render()).pop() as Solid;
}

/** A face pick, the way the viewport makes one, plus the face's own extent. */
function facePick(solid: Shape, matches: (box: ReturnType<typeof ShapeOps.getBoundingBox>) => boolean) {
  const faces = Explorer.findFacesWrapped(solid);
  let picked: { ref: GhostPlaneBaseRef; box: ReturnType<typeof ShapeOps.getBoundingBox> } | null = null;
  faces.forEach((f, index) => {
    const box = ShapeOps.getBoundingBox(f);
    if (!picked && matches(box)) {
      picked = { ref: { kind: 'face', shapeId: solid.id, index }, box };
    }
    f.dispose();
  });
  if (!picked) {
    throw new Error('no matching face');
  }
  return picked as { ref: GhostPlaneBaseRef; box: ReturnType<typeof ShapeOps.getBoundingBox> };
}

/** A statement addressable by source location, the way the parser records one. */
function located<T extends SceneObject>(obj: T, line: number): T {
  obj.setSourceLocation({ filePath: FILE, line, column: 0 });
  return obj;
}

/** The extent of the ghost quad, straight off the returned vertices. */
function bounds(result: FeatureGhostResult) {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  const quad = result.solids[0].meshes[0];
  const along = (offset: number) => quad.vertices.filter((_, i) => i % 3 === offset);
  const [xs, ys, zs] = [along(0), along(1), along(2)];
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

function frame(result: FeatureGhostResult) {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  return result.solids[0].plane!;
}

describe("plane ghost", () => {
  setupOC();

  it("draws the quad an origin plane's offset would land on", () => {
    const scene = render();

    const result = planeGhost(scene, [{ kind: 'standard', plane: 'xy' }], { offset: 12 });

    expect(result.ok).toBe(true);
    const box = bounds(result);
    expect(box.minZ).toBeCloseTo(12, 6);
    expect(box.maxZ).toBeCloseTo(12, 6);
    // The quad is the same 200 x 200 square `plane()` renders.
    expect(box.maxX - box.minX).toBeCloseTo(200, 6);
    expect(box.maxY - box.minY).toBeCloseTo(200, 6);
  });

  it("carries the plane's own frame for the normal arrow", () => {
    const scene = render();

    const { normal, center } = frame(planeGhost(scene, [{ kind: 'standard', plane: 'xz' }], { offset: 5 }));

    expect(Math.abs(normal.x)).toBeCloseTo(0, 6);
    expect(Math.abs(normal.y)).toBeCloseTo(1, 6);
    expect(Math.abs(normal.z)).toBeCloseTo(0, 6);
    // The center rides the offset with the plane — the arrow stands on the quad.
    expect(Math.abs(center.y)).toBeCloseTo(5, 6);
  });

  it("centers the quad on a picked face, not on the plane origin", () => {
    const solid = block();
    const scene = render();
    const top = facePick(solid, b => Math.abs(b.minZ - 20) < 0.5 && Math.abs(b.maxZ - 20) < 0.5);

    const box = bounds(planeGhost(scene, [top.ref], { offset: 8 }));

    expect(box.minZ).toBeCloseTo(28, 6);
    // The face's own center, offset along the normal — not the world origin,
    // which is where a plane built from the face's `Plane` alone would sit.
    expect((box.minX + box.maxX) / 2).toBeCloseTo(top.box.centerX, 6);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(top.box.centerY, 6);
  });

  it("reads an existing plane statement as a base", () => {
    located(plane('xy', { offset: 30 }) as unknown as SceneObject, 3);
    const scene = render();

    const box = bounds(planeGhost(
      scene,
      [{ kind: 'plane', filePath: FILE, line: 3 }],
      { offset: 5 },
    ));

    expect(box.minZ).toBeCloseTo(35, 6);
  });

  it("lands a mid plane halfway between its two bases", () => {
    located(plane('xy', { offset: 40 }) as unknown as SceneObject, 4);
    const scene = render();

    const box = bounds(planeGhost(
      scene,
      [{ kind: 'standard', plane: 'xy' }, { kind: 'plane', filePath: FILE, line: 4 }],
      { type: 'mid' },
    ));

    expect(box.minZ).toBeCloseTo(20, 6);
    expect(box.maxZ).toBeCloseTo(20, 6);
  });

  it("tilts the quad by the dialog's rotation", () => {
    const scene = render();

    const box = bounds(planeGhost(scene, [{ kind: 'standard', plane: 'xy' }], { rotateX: 90 }));

    // Rotated onto its edge: the quad now spans z and collapses in one of the
    // two horizontal directions.
    expect(box.maxZ - box.minZ).toBeCloseTo(200, 6);
    expect(Math.min(box.maxX - box.minX, box.maxY - box.minY)).toBeCloseTo(0, 6);
  });

  it("stands normal to a helix at the requested position", () => {
    located(helix('z').radius(10).pitch(5).turns(2) as unknown as SceneObject, 7);
    const scene = render();

    const { center } = frame(planeGhost(
      scene,
      [{ kind: 'wire', filePath: FILE, line: 7 }],
      { type: 'edge', position: 1 },
    ));

    // One pitch per turn, two turns — the far end sits at z = 10.
    expect(center.z).toBeCloseTo(10, 4);
  });

  it("takes a single-curve sketch as an edge base", () => {
    located(sketch('xy', () => { circle(10); }) as Sketch, 9);
    const scene = render();

    const result = planeGhost(
      scene,
      [{ kind: 'wire', filePath: FILE, line: 9 }],
      { type: 'edge', position: 0.5 },
    );

    expect(result.ok).toBe(true);
    // Normal to a circle at its halfway point: the plane stands on edge.
    const box = bounds(result);
    expect(box.maxZ - box.minZ).toBeCloseTo(200, 6);
  });

  it("takes a picked edge as an edge base", () => {
    const solid = block();
    const scene = render();
    const edges = Explorer.findEdgesWrapped(solid);
    const vertical = edges.findIndex(e => {
      const b = ShapeOps.getBoundingBox(e);
      return b.maxZ - b.minZ > 19;
    });
    for (const e of edges) {
      e.dispose();
    }
    expect(vertical).toBeGreaterThanOrEqual(0);

    const { normal } = frame(planeGhost(
      scene,
      [{ kind: 'edge', shapeId: solid.id, index: vertical }],
      { type: 'edge', position: 0.5 },
    ));

    // Normal to a vertical edge — the plane lies flat.
    expect(Math.abs(normal.z)).toBeCloseTo(1, 6);
  });

  it("refuses a base the scene no longer holds", () => {
    const scene = render();

    const result = planeGhost(scene, [{ kind: 'plane', filePath: FILE, line: 99 }]);

    expect(result.ok).toBe(false);
  });

  it("refuses a mid plane missing one of its bases", () => {
    const scene = render();

    const result = planeGhost(scene, [{ kind: 'standard', plane: 'xy' }], { type: 'mid' });

    expect(result.ok).toBe(false);
  });
});
