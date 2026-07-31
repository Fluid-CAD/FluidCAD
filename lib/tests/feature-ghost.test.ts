import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import axis from "../core/axis.js";
import revolve from "../core/revolve.js";
import { rect } from "../core/2d/index.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import {
  buildFeatureGhost, ExtrudeGhostRequest, FeatureGhostResult, RevolveGhostRequest,
} from "../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { Scene } from "../rendering/scene.js";

const FILE = '/tmp/ghost-test.fluid.js';

const BASE: Omit<ExtrudeGhostRequest, 'profile'> = {
  feature: 'extrude',
  op: 'add',
  distance: 10,
  distance2: null,
  symmetric: false,
  draft: null,
  drill: true,
  thin: null,
};

function ghost(scene: Scene, line: number, overrides: Partial<ExtrudeGhostRequest> = {}) {
  return buildFeatureGhost(
    scene,
    { ...BASE, ...overrides, profile: { filePath: FILE, line } },
    DEFAULT_MESH_CONFIG,
  );
}

const REVOLVE_BASE: Omit<RevolveGhostRequest, 'profile'> = {
  feature: 'revolve',
  op: 'add',
  angle: 360,
  thin: null,
  axis: { kind: 'standard', axis: 'y' },
};

function revolveGhost(scene: Scene, line: number, overrides: Partial<RevolveGhostRequest> = {}) {
  return buildFeatureGhost(
    scene,
    { ...REVOLVE_BASE, ...overrides, profile: { filePath: FILE, line } },
    DEFAULT_MESH_CONFIG,
  );
}

/** A sketch addressable by source location, the way the parser records one. */
function locatedSketch(line: number, draw: () => void, plane: 'xy' | 'xz' | 'yz' = 'xy'): Sketch {
  const s = sketch(plane, draw) as Sketch;
  s.setSourceLocation({ filePath: FILE, line, column: 0 });
  return s;
}

describe("feature ghost", () => {
  setupOC();

  it("meshes the body the dialog's values would build", () => {
    locatedSketch(5, () => { rect(100, 50); });
    const scene = render();

    const result = ghost(scene, 5);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(1);
    const labels = result.solids[0].meshes.map(m => m.label);
    expect(labels).toContain('solid-faces');
    expect(labels).toContain('solid-edges');
  });

  it("finds the profile through the live-render buffer's path prefix", () => {
    const s = locatedSketch(5, () => { rect(100, 50); });
    s.setSourceLocation({ filePath: `virtual:live-render:${FILE}`, line: 5, column: 0 });
    const scene = render();

    expect(ghost(scene, 5).ok).toBe(true);
  });

  it("refuses a profile the scene doesn't hold", () => {
    locatedSketch(5, () => { rect(100, 50); });
    const scene = render();

    const result = ghost(scene, 99);

    expect(result.ok).toBe(false);
  });

  /**
   * The edit dialog's keep-profile path: the statement being edited has
   * already consumed its own sketch, whose shapes are recorded as removed.
   * Reading them back is what makes an edit-mode ghost possible at all.
   */
  it("still sweeps a profile the edited statement already consumed", () => {
    locatedSketch(5, () => { rect(100, 50); });
    extrude(20);
    const scene = render();

    const result = ghost(scene, 5, { distance: 30 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(1);
    const faces = result.solids[0].meshes.find(m => m.label === 'solid-faces');
    const zs = faces!.vertices.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeCloseTo(30, 3);
  });

  it("sizes a through-all cut to the model, not the kernel's 100 m stand-in", () => {
    locatedSketch(5, () => { rect(100, 50); });
    extrude(20);
    const scene = render();

    const result = ghost(scene, 5, { op: 'remove', distance: null });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const faces = result.solids[0].meshes.find(m => m.label === 'solid-faces');
    const zs = faces!.vertices.filter((_, i) => i % 3 === 2);
    // The solid reaches z = 20; the ghost clears it with a margin and stops.
    expect(Math.min(...zs)).toBeLessThan(-20);
    expect(Math.min(...zs)).toBeGreaterThan(-100);
    expect(Math.max(...zs)).toBeCloseTo(0, 3);
  });
});

/**
 * The revolve branch. A profile straddling the axis can't be swept at all, so
 * these sit off to the side, where the ring they produce reads straight off
 * the mesh: a 20×10 section from x = 60 to 80 in the xy plane sweeps an
 * annulus 60…80 out from the y axis, 10 tall.
 */
describe("feature ghost — revolve", () => {
  setupOC();

  /** The 20×10 section spanning x 60…80, y ±5 — the ring's cross-section. */
  function ringSection(line = 5): Sketch {
    return locatedSketch(line, () => { rect([60, -5], 20, 10); });
  }

  /** A world-axis `axis()` statement the way the parser records one. */
  function locatedAxis(line: number, standard: 'x' | 'y' | 'z'): SceneObject {
    const a = axis(standard) as unknown as SceneObject;
    a.setSourceLocation({ filePath: FILE, line, column: 0 });
    return a;
  }

  function bounds(result: FeatureGhostResult, solid = 0) {
    if (!result.ok) {
      throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
    }
    const faces = result.solids[solid].meshes.find(m => m.label === 'solid-faces')!;
    const along = (offset: number) => faces.vertices.filter((_, i) => i % 3 === offset);
    const [xs, ys, zs] = [along(0), along(1), along(2)];
    return {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minY: Math.min(...ys), maxY: Math.max(...ys),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
  }

  it("sweeps the profile all the way around a world axis", () => {
    ringSection();
    const scene = render();

    const result = revolveGhost(scene, 5);

    expect(result.ok).toBe(true);
    const box = bounds(result);
    expect(box.maxX).toBeCloseTo(80, 0);
    expect(box.minX).toBeCloseTo(-80, 0);
    expect(box.maxZ).toBeCloseTo(80, 0);
    expect(box.minZ).toBeCloseTo(-80, 0);
    expect(box.maxY).toBeCloseTo(5, 3);
    expect(box.minY).toBeCloseTo(-5, 3);
  });

  it("stops at the dialog's angle", () => {
    ringSection();
    const scene = render();

    const box = bounds(revolveGhost(scene, 5, { angle: 90 }));

    // A quarter turn about +y carries +x round to -z and no further.
    expect(box.maxX).toBeCloseTo(80, 0);
    expect(box.minX).toBeCloseTo(0, 0);
    expect(box.maxZ).toBeCloseTo(0, 0);
    expect(box.minZ).toBeCloseTo(-80, 0);
  });

  it("sweeps around an axis() statement named by call site", () => {
    locatedAxis(3, 'y');
    ringSection();
    const scene = render();

    const box = bounds(revolveGhost(scene, 5, {
      axis: { kind: 'axis', filePath: FILE, line: 3 },
    }));

    expect(box.maxX).toBeCloseTo(80, 0);
    expect(box.minX).toBeCloseTo(-80, 0);
  });

  /**
   * The edit dialog's keep-axis path: the revolve being edited has already
   * consumed its own axis statement, which drops that axis's guide line from
   * the scene. The axis it stored survives that, and the ghost reads it.
   */
  it("still sweeps around an axis the edited statement already consumed", () => {
    const a = locatedAxis(3, 'y');
    const profile = ringSection();
    revolve(a as never, 90, profile as never);
    const scene = render();

    const box = bounds(revolveGhost(scene, 5, {
      axis: { kind: 'axis', filePath: FILE, line: 3 },
      angle: 180,
    }));

    expect(box.maxX).toBeCloseTo(80, 0);
    expect(box.minX).toBeCloseTo(-80, 0);
  });

  /**
   * The axis-slot's edge mode, which the apply writes as `axis(<selector>)`:
   * the ghost has to turn a `{shapeId, index}` viewport pick into the same
   * line the build would. A vertical edge of the box below runs along z at
   * (x, y) = (10, 10), so the swept ring centers there — not on the origin,
   * which is what a fallback to a world axis would give.
   */
  it("turns a picked edge into the axis", () => {
    locatedSketch(2, () => { rect([-10, -10], 20, 20); });
    extrude(40);
    locatedSketch(5, () => { rect([60, 0], 20, 10); }, 'xz');
    const scene = render();
    const picked = verticalEdge(scene);

    const box = bounds(revolveGhost(scene, 5, {
      axis: { kind: 'edge', shapeId: picked.shapeId, index: picked.index },
    }));

    expect((box.minX + box.maxX) / 2).toBeCloseTo(picked.x, 1);
    expect((box.minY + box.maxY) / 2).toBeCloseTo(picked.y, 1);
  });

  it("refuses an axis the scene doesn't hold", () => {
    ringSection();
    const scene = render();

    const result = revolveGhost(scene, 5, {
      axis: { kind: 'axis', filePath: FILE, line: 99 },
    });

    expect(result.ok).toBe(false);
  });

  it("sweeps a thin profile as its offset shell", () => {
    ringSection();
    const scene = render();

    const solid = bounds(revolveGhost(scene, 5));
    const result = revolveGhost(scene, 5, { thin: [2] });

    expect(result.ok).toBe(true);
    // The thin wall grows outward off the profile — a different body, swept
    // around the same axis to the same height.
    const thin = bounds(result);
    expect(thin.maxX).toBeCloseTo(solid.maxX + 2, 0);
    expect(thin.maxY).toBeCloseTo(solid.maxY + 2, 0);
  });

  /** A vertical (z-running) edge of the scene's box, as a viewport pick names it. */
  function verticalEdge(scene: Scene): { shapeId: string; index: number; x: number; y: number } {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (!shape.isSolid()) {
          continue;
        }
        const edges = Explorer.findEdgesWrapped(shape);
        for (let index = 0; index < edges.length; index++) {
          try {
            const line = EdgeOps.edgeToAxis(edges[index]);
            if (Math.abs(line.direction.z) > 0.99) {
              return { shapeId: shape.id, index, x: line.origin.x, y: line.origin.y };
            }
          } catch {
            // Not a straight edge — keep looking.
          }
        }
      }
    }
    throw new Error('no vertical edge in the scene');
  }
});
