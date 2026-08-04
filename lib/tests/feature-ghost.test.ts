import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import axis from "../core/axis.js";
import loft from "../core/loft.js";
import plane from "../core/plane.js";
import revolve from "../core/revolve.js";
import sweep from "../core/sweep.js";
import helix from "../core/helix.js";
import chamfer from "../core/chamfer.js";
import fillet from "../core/fillet.js";
import rib from "../core/rib.js";
import repeat from "../core/repeat.js";
import copy from "../core/copy.js";
import shell from "../core/shell.js";
import { aLine, bezier, circle, hLine, move, rect, vLine } from "../core/2d/index.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { FaceQuery } from "../oc/face-query.js";
import { ShapeOps } from "../oc/shape-ops.js";
import {
  buildFeatureGhost, CopyGhostRequest, ExtrudeGhostRequest, FeatureGhostResult, GhostPathRef,
  GhostSectionRef, LoftGhostRequest, RepeatGhostRequest, RevolveGhostRequest, RibGhostRequest,
  SweepGhostRequest,
} from "../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { Scene, SceneObjectMesh } from "../rendering/scene.js";

const FILE = '/tmp/ghost-test.fluid.js';

const BASE: Omit<ExtrudeGhostRequest, 'profile'> = {
  feature: 'extrude',
  op: 'add',
  distance: 10,
  distance2: null,
  symmetric: false,
  draft: null,
  endOffset: null,
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
function locatedSketch(line: number, draw: () => void, on: 'xy' | 'xz' | 'yz' = 'xy'): Sketch {
  const s = sketch(on, draw) as Sketch;
  s.setSourceLocation({ filePath: FILE, line, column: 0 });
  return s;
}

/** The same, on an offset parallel plane — the second section of a loft. */
function locatedSketchAt(line: number, offset: number, draw: () => void): Sketch {
  const s = sketch(plane("xy", { offset }), draw) as Sketch;
  s.setSourceLocation({ filePath: FILE, line, column: 0 });
  return s;
}

/** The extent of a ghost body's face mesh, straight off the returned vertices. */
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

/** Why a ghost refused, or '' when it didn't. */
function refusal(result: FeatureGhostResult): string {
  return 'reason' in result ? result.reason : '';
}

/** The scene box's top face, as a viewport pick names it. */
function topFace(scene: Scene): { shapeId: string; index: number } {
  for (const obj of scene.getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (!shape.isSolid()) {
        continue;
      }
      const top = ShapeOps.getBoundingBox(shape).maxZ;
      const faces = Explorer.findFacesWrapped(shape);
      try {
        for (let index = 0; index < faces.length; index++) {
          const box = ShapeOps.getBoundingBox(faces[index]);
          if (Math.abs(box.minZ - top) < 1e-6 && Math.abs(box.maxZ - top) < 1e-6) {
            return { shapeId: shape.id, index };
          }
        }
      } finally {
        for (const face of faces) {
          face.dispose();
        }
      }
    }
  }
  throw new Error('no top face in the scene');
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

/**
 * The loft branch, where the chips are a list: sections resolve from sketch
 * call sites and from viewport face picks, rails from their own statements,
 * and each of them has an edit-mode twin the loft being edited has already
 * consumed.
 */
describe("feature ghost — loft", () => {
  setupOC();

  const LOFT_BASE: Omit<LoftGhostRequest, 'profiles'> = {
    feature: 'loft',
    op: 'add',
    thin: null,
    guides: [],
    startCondition: null,
    endCondition: null,
  };

  function loftGhost(
    scene: Scene,
    profiles: GhostSectionRef[],
    overrides: Partial<LoftGhostRequest> = {},
  ): FeatureGhostResult {
    return buildFeatureGhost(
      scene,
      { ...LOFT_BASE, ...overrides, profiles },
      DEFAULT_MESH_CONFIG,
    );
  }

  function sketchRef(line: number): GhostSectionRef {
    return { kind: 'sketch', filePath: FILE, line };
  }

  /** Two identical 100 × 50 rects, at z = 0 (line 5) and z = 40 (line 9). */
  function rectStack(): [Sketch, Sketch] {
    return [
      locatedSketch(5, () => { rect(100, 50); }),
      locatedSketchAt(9, 40, () => { rect(100, 50); }),
    ];
  }

  /** Two circles (diameter 80), at z = 0 (line 5) and z = 60 (line 9). */
  function circleStack(): [Sketch, Sketch] {
    return [
      locatedSketch(5, () => { circle(80); }),
      locatedSketchAt(9, 60, () => { circle(80); }),
    ];
  }

  it("skins between the sections its chips name", () => {
    rectStack();
    const scene = render();

    const result = loftGhost(scene, [sketchRef(5), sketchRef(9)]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(1);
    const labels = result.solids[0].meshes.map(m => m.label);
    expect(labels).toContain('solid-faces');
    expect(labels).toContain('solid-edges');
    const box = bounds(result);
    expect(box.minZ).toBeCloseTo(0, 3);
    expect(box.maxZ).toBeCloseTo(40, 3);
  });

  /**
   * The edit dialog's kept-chip path: the loft being edited has already
   * consumed both of its sections, whose shapes are recorded as removed.
   * Reading them back is what makes an edit-mode ghost possible at all.
   */
  it("still skins sections the edited statement already consumed", () => {
    const [bottom, top] = rectStack();
    loft(bottom as never, top as never);
    const scene = render();

    const box = bounds(loftGhost(scene, [sketchRef(5), sketchRef(9)]));

    expect(box.minZ).toBeCloseTo(0, 3);
    expect(box.maxZ).toBeCloseTo(40, 3);
  });

  /**
   * The profile slot's face mode, which the apply writes as `select(face(…))`:
   * the ghost has to turn a `{shapeId, index}` viewport pick into the same
   * section the build would. The box below tops out at z = 20, so a loft from
   * its top face to the sketch at z = 40 spans exactly the gap between them.
   */
  it("turns a picked face into a section", () => {
    locatedSketch(2, () => { rect(100, 50); });
    extrude(20);
    locatedSketchAt(9, 40, () => { rect(100, 50); });
    const scene = render();
    const picked = topFace(scene);

    const box = bounds(loftGhost(scene, [
      { kind: 'faces', entities: [picked] },
      sketchRef(9),
    ]));

    expect(box.minZ).toBeCloseTo(20, 3);
    expect(box.maxZ).toBeCloseTo(40, 3);
  });

  it("follows a rail named by call site", () => {
    circleStack();
    locatedSketch(7, () => { bezier([40, 0], [65, 30], [40, 60]); }, 'xz');
    const scene = render();

    const plain = bounds(loftGhost(scene, [sketchRef(5), sketchRef(9)]));
    const railed = bounds(loftGhost(scene, [sketchRef(5), sketchRef(9)], {
      guides: [{ filePath: FILE, line: 7 }],
    }));

    expect(plain.maxX).toBeCloseTo(40, 0);
    // The sections ride out to the rail's bulge, past the straight side.
    expect(railed.maxX).toBeGreaterThan(46);
  });

  /** The rails are consumed by the edited loft too — same read-back. */
  it("still follows a rail the edited statement already consumed", () => {
    const [bottom, top] = circleStack();
    const bowed = locatedSketch(7, () => { bezier([40, 0], [65, 30], [40, 60]); }, 'xz');
    loft(bottom as never, top as never).guides(bowed as never);
    const scene = render();

    const railed = bounds(loftGhost(scene, [sketchRef(5), sketchRef(9)], {
      guides: [{ filePath: FILE, line: 7 }],
    }));

    expect(railed.maxX).toBeGreaterThan(46);
  });

  it("refuses a section the scene doesn't hold", () => {
    rectStack();
    const scene = render();

    expect(loftGhost(scene, [sketchRef(5), sketchRef(99)]).ok).toBe(false);
  });

  it("refuses a rail the scene doesn't hold", () => {
    rectStack();
    const scene = render();

    const result = loftGhost(scene, [sketchRef(5), sketchRef(9)], {
      guides: [{ filePath: FILE, line: 99 }],
    });

    expect(result.ok).toBe(false);
  });
});

/**
 * The sweep branch: one profile, plus a spine the path slot names — a wire
 * statement by call site, or edges picked in the viewport. The fixtures keep
 * the profile a circle of diameter 10 (`circle()` takes a diameter) at the
 * origin on xy, so a tube swept up the z axis reads straight off the mesh:
 * ±5 across, as long as the spine.
 */
describe("feature ghost — sweep", () => {
  setupOC();

  const SWEEP_BASE: Omit<SweepGhostRequest, 'profile' | 'path'> = {
    feature: 'sweep',
    op: 'add',
    thin: null,
  };

  function sweepGhost(
    scene: Scene,
    line: number,
    path: GhostPathRef,
    overrides: Partial<SweepGhostRequest> = {},
  ): FeatureGhostResult {
    return buildFeatureGhost(
      scene,
      { ...SWEEP_BASE, ...overrides, profile: { filePath: FILE, line }, path },
      DEFAULT_MESH_CONFIG,
    );
  }

  function wireRef(line: number): GhostPathRef {
    return { kind: 'wire', filePath: FILE, line };
  }

  /** The profile at line 5, and a 50 mm spine straight up z at line 3. */
  function tube(): [Sketch, Sketch] {
    return [
      locatedSketch(5, () => { circle(10); }),
      locatedSketch(3, () => { vLine(50); }, 'xz'),
    ];
  }

  it("sweeps the profile along a path named by call site", () => {
    tube();
    const scene = render();

    const result = sweepGhost(scene, 5, wireRef(3));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(1);
    const labels = result.solids[0].meshes.map(m => m.label);
    expect(labels).toContain('solid-faces');
    expect(labels).toContain('solid-edges');
    const box = bounds(result);
    expect(box.minZ).toBeCloseTo(0, 1);
    expect(box.maxZ).toBeCloseTo(50, 1);
    expect(box.maxX).toBeCloseTo(5, 0);
    expect(box.minX).toBeCloseTo(-5, 0);
  });

  /**
   * The edit dialog's keep-path chip: the sweep being edited has consumed both
   * its profile and its spine, whose shapes are recorded as removed. Reading
   * them back is what makes an edit-mode ghost possible at all — and since the
   * ghost reaches the spine its own way (through the scene object's edges,
   * not `Sweep.getSpineWire`'s reader), the body it stands in for is only
   * worth drawing if it matches the one the statement actually built.
   */
  it("still runs along a path the edited statement already consumed", () => {
    const [profile, path] = tube();
    const applied = sweep(path as never, profile as never) as unknown as SceneObject;
    const scene = render();

    const box = bounds(sweepGhost(scene, 5, wireRef(3)));

    const real = ShapeOps.getBoundingBox(applied.getShapes()[0]);
    expect(box.minZ).toBeCloseTo(real.minZ, 0);
    expect(box.maxZ).toBeCloseTo(real.maxZ, 0);
    expect(box.minX).toBeCloseTo(real.minX, 0);
    expect(box.maxX).toBeCloseTo(real.maxX, 0);
  });

  /**
   * The path slot's other named source, and the sweep's own reason for
   * existing: a helix. Two turns of a radius-20 coil at 10 mm pitch carry the
   * profile twice round the z axis and 20 mm up it.
   */
  it("runs along a helix named by call site", () => {
    const coil = helix('z').radius(20).pitch(10).turns(2) as unknown as SceneObject;
    coil.setSourceLocation({ filePath: FILE, line: 3, column: 0 });
    locatedSketch(5, () => { move([20, 0]); circle(6); }, 'xz');
    const scene = render();

    const box = bounds(sweepGhost(scene, 5, wireRef(3)));

    // The coil's own 20 mm rise, plus the tube's 3 mm half-width at each end.
    expect(box.maxZ - box.minZ).toBeGreaterThan(20);
    expect(box.maxZ - box.minZ).toBeLessThan(27);
    expect(box.maxX).toBeCloseTo(23, 0);
    expect(box.minX).toBeCloseTo(-23, 0);
  });

  /**
   * The path slot's edge mode, which the apply writes as `select(edge(…))`:
   * the ghost has to turn `{shapeId, index}` viewport picks into the same
   * spine the build would. The box below stands z 0…20, so its vertical edges
   * carry the profile a fifth of the way the line-3 sketch would.
   */
  it("runs along the edges picked in the viewport", () => {
    locatedSketch(2, () => { rect([-30, -30], 20, 20); });
    extrude(20);
    tube();
    const scene = render();
    const picked = verticalEdge(scene);

    const box = bounds(sweepGhost(scene, 5, { kind: 'edges', entities: [picked] }));

    expect(box.maxZ - box.minZ).toBeCloseTo(20, 1);
  });

  it("refuses a picked edge the scene doesn't hold", () => {
    tube();
    const scene = render();

    const result = sweepGhost(scene, 5, {
      kind: 'edges',
      entities: [{ shapeId: 'gone', index: 0 }],
    });

    expect(result.ok).toBe(false);
  });

  it("refuses a path the scene doesn't hold", () => {
    tube();
    const scene = render();

    expect(sweepGhost(scene, 5, wireRef(99)).ok).toBe(false);
  });

  it("sweeps a thin profile as its offset shell", () => {
    tube();
    const scene = render();

    const solid = bounds(sweepGhost(scene, 5, wireRef(3)));
    const result = sweepGhost(scene, 5, wireRef(3), { thin: [2] });

    expect(result.ok).toBe(true);
    // The thin wall grows outward off the profile — a hollow tube, run along
    // the same spine to the same height.
    const thin = bounds(result);
    expect(thin.maxX).toBeCloseTo(solid.maxX + 2, 0);
    expect(thin.maxZ).toBeCloseTo(solid.maxZ, 1);
  });

  /** A vertical (z-running) edge of the scene's box, as a viewport pick names it. */
  function verticalEdge(scene: Scene): { shapeId: string; index: number } {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (!shape.isSolid()) {
          continue;
        }
        const edges = Explorer.findEdgesWrapped(shape);
        for (let index = 0; index < edges.length; index++) {
          try {
            if (Math.abs(EdgeOps.edgeToAxis(edges[index]).direction.z) > 0.99) {
              return { shapeId: shape.id, index };
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

/**
 * The repeat branch, the odd one out: it builds no geometry at all. What it
 * draws is the target features themselves, stamped at each instance transform
 * — so the fixtures keep a 20 × 20 × 10 box at the origin (x and y from -10 to
 * 10) and every assertion reads that box back somewhere else.
 */
describe("feature ghost — repeat", () => {
  setupOC();

  const REPEAT_BASE: Omit<RepeatGhostRequest, 'targets'> = {
    feature: 'repeat',
    kind: 'linear',
    axes: [{ kind: 'standard', axis: 'x' }],
    plane: null,
    directions: [{ count: 3, offset: 40, length: null }],
    centered: false,
    count: null,
    sweep: null,
    angle: null,
  };

  function repeatGhost(
    scene: Scene,
    lines: number[],
    overrides: Partial<RepeatGhostRequest> = {},
  ): FeatureGhostResult {
    return buildFeatureGhost(
      scene,
      {
        ...REPEAT_BASE,
        ...overrides,
        targets: lines.map(line => ({ filePath: FILE, line })),
      },
      DEFAULT_MESH_CONFIG,
    );
  }

  /** A box built by an `extrude()` addressable at `line`, like the parser's. */
  function locatedBox(line: number, draw = () => { rect(20, 20); }, height = 10): SceneObject {
    sketch("xy", draw);
    const solid = extrude(height).new() as unknown as SceneObject;
    solid.setSourceLocation({ filePath: FILE, line, column: 0 });
    return solid;
  }

  /**
   * Put every clone of `source` on `line`. The parser stamps a repeat's clones
   * with the statement that made them (index.ts:78) — this is how a test says
   * "an earlier repeat already replayed this line".
   */
  function stampClones(scene: Scene, source: SceneObject, line: number): void {
    for (const obj of scene.getAllSceneObjects()) {
      if (obj.getCloneSource() === source) {
        obj.setSourceLocation({ filePath: FILE, line, column: 0 });
      }
    }
  }

  function solidsOf(result: FeatureGhostResult) {
    if (!result.ok) {
      throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
    }
    return result.solids;
  }

  it("stamps a body at every instance but the original", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5]);

    expect(solidsOf(result)).toHaveLength(2);
    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 0).maxX).toBeCloseTo(60, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(80, 3);
    expect(bounds(result, 1).maxX).toBeCloseTo(100, 3);
  });

  it("lays out the grid two directions describe", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'standard', axis: 'y' }],
      directions: [
        { count: 2, offset: 40, length: null },
        { count: 2, offset: 30, length: null },
      ],
    });

    // 2 × 2 cells, the origin corner left to the box already on screen.
    expect(solidsOf(result)).toHaveLength(3);
  });

  it("centers the pattern on the original", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], { centered: true });

    expect(solidsOf(result)).toHaveLength(2);
    expect(bounds(result, 0).minX).toBeCloseTo(-40, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(40, 3);
  });

  it("spreads a total span across the gaps", () => {
    locatedBox(5);
    const scene = render();

    // 3 instances over 80 mm = the same 40 mm step the offset form states.
    const result = repeatGhost(scene, [5], {
      directions: [{ count: 3, offset: null, length: 80 }],
    });

    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(80, 3);
  });

  it("spins the instances around a circular axis", () => {
    // Off the axis, so the rotation is visible in the bounds at all.
    locatedBox(5, () => { rect([40, -10], 20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'circular',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      count: 4,
      sweep: { mode: 'angle', value: 360 },
    });

    expect(solidsOf(result)).toHaveLength(3);
    // A quarter turn carries the box from +x round to +y.
    const first = bounds(result, 0);
    expect(first.minY).toBeCloseTo(40, 3);
    expect(first.maxY).toBeCloseTo(60, 3);
    expect(first.minX).toBeCloseTo(-10, 3);
  });

  it("turns a single rotate clone around the axis", () => {
    locatedBox(5, () => { rect([40, -10], 20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'rotate',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      angle: 90,
    });

    expect(solidsOf(result)).toHaveLength(1);
    expect(bounds(result, 0).minY).toBeCloseTo(40, 3);
  });

  it("mirrors across an origin plane", () => {
    locatedBox(5, () => { rect([-10, 20], 20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'standard', plane: 'xz' },
    });

    expect(solidsOf(result)).toHaveLength(1);
    const box = bounds(result, 0);
    expect(box.minY).toBeCloseTo(-40, 3);
    expect(box.maxY).toBeCloseTo(-20, 3);
  });

  /** Mirror takes the difference too: a fused boss reflects alone. */
  it("mirrors only the material a fused instance adds", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const boss = extrude(10) as unknown as SceneObject;
    boss.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [9], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'standard', plane: 'yz' },
    });

    expect(solidsOf(result)).toHaveLength(1);
    const box = bounds(result, 0);
    // The boss alone, reflected in x — still standing on the plate's face.
    expect(box.minX).toBeCloseTo(65, 1);
    expect(box.maxX).toBeCloseTo(95, 1);
    expect(box.minZ).toBeCloseTo(20, 3);
    expect(box.maxZ).toBeCloseTo(30, 3);
  });

  it("mirrors across a plane() statement named by call site", () => {
    const p = plane("xy", { offset: 20 }) as unknown as SceneObject;
    p.setSourceLocation({ filePath: FILE, line: 3, column: 0 });
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'plane', filePath: FILE, line: 3 },
    });

    // The box stands z 0…10; reflected in z = 20 it hangs from 40 down to 30.
    const box = bounds(result, 0);
    expect(box.minZ).toBeCloseTo(30, 3);
    expect(box.maxZ).toBeCloseTo(40, 3);
  });

  it("mirrors across a face picked in the viewport", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'face', ...topFace(scene) },
    });

    // Reflected in its own top face, the box sits on top of itself.
    const box = bounds(result, 0);
    expect(box.minZ).toBeCloseTo(10, 3);
    expect(box.maxZ).toBeCloseTo(20, 3);
  });

  /**
   * A mirror flips triangle winding, and a body whose winding no longer agrees
   * with its normals renders inside-out. `transformMeshes` swaps the indices
   * back; this is the guard that the ghost actually goes through it.
   */
  it("keeps a mirrored body's winding facing outward", () => {
    locatedBox(5, () => { rect([-10, 20], 20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'standard', plane: 'xz' },
    });

    const faces = solidsOf(result)[0].meshes.find(m => m.label === 'solid-faces')!;
    expect(windingFollowsNormals(faces)).toBe(true);
  });

  it("refuses a curved face as a mirror plane", () => {
    sketch("xy", () => { circle(40); });
    const round = extrude(10).new() as unknown as SceneObject;
    round.setSourceLocation({ filePath: FILE, line: 5, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [5], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'face', ...curvedFace(scene) },
    });

    expect(result.ok).toBe(false);
  });

  /**
   * The edit dialog's own blind spot, and a plain fuse's: a target whose solid
   * a later statement consumed reads back empty, so it is re-read as if no
   * removal applied. Without that, repeating anything already fused into the
   * model would silently draw nothing.
   */
  it("stamps a target a later statement already consumed", () => {
    locatedBox(5);
    sketch("xy", () => { rect([0, 0], 20, 20); });
    extrude(10);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      directions: [{ count: 2, offset: 100, length: null }],
    });

    // The pre-fuse box, not the fused body it disappeared into.
    const box = bounds(result, 0);
    expect(box.minX).toBeCloseTo(100, 3);
    expect(box.maxX).toBeCloseTo(120, 3);
  });

  /**
   * The case a plain body stamp gets wrong. A boss sketched on a plate's face
   * fuses into the plate, so the target's solid is plate-plus-boss — but the
   * repeat clones only the boss's own chain, and each instance's fuse merges
   * into the plate already there. What lands per instance is the boss alone.
   */
  it("stamps only the material a fused instance adds", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const boss = extrude(10) as unknown as SceneObject;
    boss.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [9], {
      directions: [{ count: 2, offset: 50, length: null }],
    });

    expect(solidsOf(result)).toHaveLength(1);
    const box = bounds(result, 0);
    // The boss (Ø30 at x -80, standing on the plate's top face), moved 50
    // along x — not the 200 × 100 plate it was fused into.
    expect(box.minZ).toBeCloseTo(20, 3);
    expect(box.maxZ).toBeCloseTo(30, 3);
    expect(box.maxX - box.minX).toBeCloseTo(30, 1);
    expect(box.minX).toBeCloseTo(-45, 1);
  });

  /**
   * The whole chain, as a model is actually written: a plate, a boss fused
   * onto its face, a chamfer on the boss, and a repeat of that chamfer. The
   * chamfer consumed the boss's own solid — a removal INSIDE the cloned chain,
   * which must not be mistaken for a body carried in from outside — so each
   * instance is still the chamfered boss alone, not a plate.
   */
  it("follows a chain past a feature that consumed its own input", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const boss = extrude(10) as unknown as { endEdges: () => unknown };
    const rounded = chamfer(2, boss.endEdges() as never) as unknown as SceneObject;
    rounded.setSourceLocation({ filePath: FILE, line: 13, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [13], {
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'standard', axis: 'y' }],
      directions: [
        { count: 4, offset: null, length: 160 },
        { count: 2, offset: null, length: -60 },
      ],
    });

    // 4 × 2 instances, the original excluded.
    expect(solidsOf(result)).toHaveLength(7);
    const box = bounds(result, 0);
    expect(box.minZ).toBeCloseTo(20, 3);
    expect(box.maxZ).toBeCloseTo(30, 3);
    // The Ø30 boss, not the 200 × 100 plate it stands on.
    expect(box.maxX - box.minX).toBeLessThan(31);
    expect(box.maxY - box.minY).toBeLessThan(31);
  });

  /**
   * Several targets at once, with a feature the repeat does NOT replay built
   * in between them — `repeat('mirror', 'front', e, c1, f)` over a model that
   * also cut something else along the way. The chain reaches the scene as two
   * separate stretches, and each one's difference has to be taken against its
   * OWN input: pairing the later stretch's output with the earlier stretch's
   * input would blame the pattern for the feature in between.
   */
  it("takes each stretch of a multi-target chain against its own input", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    // Run one: a boss fused onto the plate.
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const boss = extrude(10) as unknown as SceneObject;
    boss.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    // Not repeated: a pocket sunk into the plate between the two stretches.
    sketch(plate.endFaces() as never, () => { circle([80, -30], 30); });
    extrude(10).remove();
    // Run two: a chamfer on the boss's top edges.
    const rounded = chamfer(2, (boss as never as { endEdges: () => unknown }).endEdges() as never) as unknown as SceneObject;
    rounded.setSourceLocation({ filePath: FILE, line: 17, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [9, 17], {
      kind: 'mirror',
      axes: [],
      directions: [],
      plane: { kind: 'standard', plane: 'yz' },
    });

    const solids = solidsOf(result);
    // The boss (added) and the chamfer's own sliver (removed) — never the
    // unrelated pocket, which this repeat does not replay.
    expect(solids.map(s => s.kind).sort()).toEqual(['add', 'remove']);
    const added = solids.find(s => s.kind === 'add')!;
    const addedXs = added.meshes.flatMap(m => m.vertices.filter((_, i) => i % 3 === 0));
    // Mirrored in x: the boss alone, nowhere near the pocket at x 65…95.
    expect(Math.min(...addedXs)).toBeCloseTo(65, 0);
    expect(Math.max(...addedXs)).toBeCloseTo(95, 0);
    const addedZs = added.meshes.flatMap(m => m.vertices.filter((_, i) => i % 3 === 2));
    expect(Math.min(...addedZs)).toBeCloseTo(20, 1);
    expect(Math.max(...addedZs)).toBeCloseTo(30, 1);
  });

  /** The same rule the other way round: a repeated cut previews its pockets. */
  it("stamps the material a repeated cut takes away", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const pocket = extrude(10).remove() as unknown as SceneObject;
    pocket.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    const scene = render();

    const result = repeatGhost(scene, [9], {
      directions: [{ count: 2, offset: 50, length: null }],
    });

    const solids = solidsOf(result);
    expect(solids).toHaveLength(1);
    // Material leaving, not arriving — the overlay paints this one red.
    expect(solids[0].kind).toBe('remove');
    const box = bounds(result, 0);
    // The pocket the cut opens (Ø30, 10 deep in the plate's top), moved 50.
    expect(box.maxX - box.minX).toBeCloseTo(30, 1);
    expect(box.minX).toBeCloseTo(-45, 1);
    expect(box.minZ).toBeCloseTo(10, 3);
    expect(box.maxZ).toBeCloseTo(20, 3);
  });

  it("stamps every target the request names", () => {
    locatedBox(5);
    locatedBox(9, () => { rect([100, -10], 20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [5, 9], {
      directions: [{ count: 2, offset: 40, length: null }],
    });

    const solids = solidsOf(result);
    expect(solids).toHaveLength(1);
    // One body per instance, carrying both targets' meshes.
    expect(solids[0].meshes.filter(m => m.label === 'solid-faces')).toHaveLength(2);
    const xs = solids[0].meshes.flatMap(m => m.vertices.filter((_, i) => i % 3 === 0));
    expect(Math.min(...xs)).toBeCloseTo(40, 3);
    expect(Math.max(...xs)).toBeCloseTo(160, 3);
  });

  /**
   * A repeat's clones are stamped with the statement that made them, so a line
   * an earlier repeat replayed holds the original AND every clone of it. The
   * new repeat replays the statement, not the pattern that came out of it.
   */
  it("takes the original alone on a line an earlier repeat already replayed", () => {
    const box = locatedBox(5);
    repeat("linear", "x", { count: 2, offset: 200 }, box as never);
    const scene = render();
    stampClones(scene, box, 5);

    const result = repeatGhost(scene, [5], {
      directions: [{ count: 2, offset: 40, length: null }],
    });

    const solids = solidsOf(result);
    expect(solids[0].meshes.filter(m => m.label === 'solid-faces')).toHaveLength(1);
    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 0).maxX).toBeCloseTo(60, 3);
  });

  /** Repeating a repeat is legal — the container hands over its children. */
  it("gathers a container target's children", () => {
    const box = locatedBox(5);
    const pattern = repeat("linear", "x", { count: 2, offset: 200 }, box as never) as unknown as SceneObject;
    pattern.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    const scene = render();
    stampClones(scene, box, 9);

    const result = repeatGhost(scene, [9], {
      directions: [{ count: 2, offset: 500, length: null }],
    });

    const solids = solidsOf(result);
    // The pattern holds one clone (at x 200…220); the original at the origin
    // belongs to line 5, not to the container.
    expect(solids[0].meshes.filter(m => m.label === 'solid-faces')).toHaveLength(1);
    expect(bounds(result, 0).minX).toBeCloseTo(700, 3);
  });

  it("refuses more instances than it draws", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      directions: [{ count: 300, offset: 5, length: null }],
    });

    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain('299');
    // A limit the user can act on — the dialog says this one out loud.
    expect('surface' in result && result.surface).toBe(true);
  });

  it("draws nothing while the numbers are still being typed", () => {
    locatedBox(5);
    const scene = render();

    for (const directions of [
      [{ count: 1, offset: 40, length: null }],
      [{ count: 3, offset: 0, length: null }],
    ]) {
      const result = repeatGhost(scene, [5], { directions });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.solids).toHaveLength(0);
      }
    }
  });

  it("refuses a target the scene doesn't hold", () => {
    locatedBox(5);
    const scene = render();

    expect(repeatGhost(scene, [99]).ok).toBe(false);
  });

  it("refuses a target with nothing solid to stamp", () => {
    locatedSketch(7, () => { rect(20, 20); });
    const scene = render();

    const result = repeatGhost(scene, [7]);

    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain('no solid');
    // Ordinary refusals stay silent — the dialog clears and says nothing.
    expect('surface' in result && result.surface).toBeFalsy();
  });

  it("refuses an axis the scene doesn't hold", () => {
    locatedBox(5);
    const scene = render();

    const result = repeatGhost(scene, [5], {
      axes: [{ kind: 'axis', filePath: FILE, line: 99 }],
    });

    expect(result.ok).toBe(false);
  });

  /** A round face of the scene's cylinder, as a viewport pick names it. */
  function curvedFace(scene: Scene): { shapeId: string; index: number } {
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (!shape.isSolid()) {
          continue;
        }
        const faces = Explorer.findFacesWrapped(shape);
        try {
          for (let index = 0; index < faces.length; index++) {
            if (!FaceQuery.isPlanarFace(faces[index])) {
              return { shapeId: shape.id, index };
            }
          }
        } finally {
          for (const face of faces) {
            face.dispose();
          }
        }
      }
    }
    throw new Error('no curved face in the scene');
  }
});

describe("feature ghost — copy", () => {
  setupOC();

  const COPY_BASE: Omit<CopyGhostRequest, 'targets'> = {
    feature: 'copy',
    kind: 'linear',
    axes: [{ kind: 'standard', axis: 'x' }],
    directions: [{ count: 3, offset: 40, length: null }],
    centered: false,
    count: null,
    sweep: null,
  };

  function copyGhost(
    scene: Scene,
    lines: number[],
    overrides: Partial<CopyGhostRequest> = {},
  ): FeatureGhostResult {
    return buildFeatureGhost(
      scene,
      {
        ...COPY_BASE,
        ...overrides,
        targets: lines.map(line => ({ filePath: FILE, line })),
      },
      DEFAULT_MESH_CONFIG,
    );
  }

  /** A box built by an `extrude()` addressable at `line`, like the parser's. */
  function locatedBox(line: number, draw = () => { rect(20, 20); }, height = 10): SceneObject {
    sketch("xy", draw);
    const solid = extrude(height).new() as unknown as SceneObject;
    solid.setSourceLocation({ filePath: FILE, line, column: 0 });
    return solid;
  }

  function solidsOf(result: FeatureGhostResult) {
    if (!result.ok) {
      throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
    }
    return result.solids;
  }

  it("clones a body at every instance but the original", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5]);

    expect(solidsOf(result)).toHaveLength(2);
    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 0).maxX).toBeCloseTo(60, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(80, 3);
    expect(bounds(result, 1).maxX).toBeCloseTo(100, 3);
  });

  it("lays out the grid two directions describe", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], {
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'standard', axis: 'y' }],
      directions: [
        { count: 2, offset: 40, length: null },
        { count: 2, offset: 30, length: null },
      ],
    });

    // 2 × 2 cells, the origin corner left to the box already on screen.
    expect(solidsOf(result)).toHaveLength(3);
  });

  it("centers the clones on the original", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], { centered: true });

    expect(solidsOf(result)).toHaveLength(2);
    expect(bounds(result, 0).minX).toBeCloseTo(-40, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(40, 3);
  });

  /**
   * The dialog's Skip field, drawn: the instances it names are the ones the
   * apply won't place, so the ghost leaves exactly those holes
   * (copy-linear.ts:82).
   */
  it("leaves out the instances the skip list names", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], {
      directions: [{ count: 4, offset: 40, length: null }],
      skip: [[2]],
    });

    // Instances 1, 2 and 3, less the skipped 2 — the original was never drawn.
    expect(solidsOf(result)).toHaveLength(2);
    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(120, 3);
  });

  /**
   * A grid cell is named by its whole tuple; a shorter entry names every cell
   * whose leading indices agree, which is how a statement leaves out a whole
   * row (the kernel compares a coordinate only as far as it is stated).
   */
  it("leaves out a grid cell, and a bare index leaves out its row", () => {
    locatedBox(5);
    const scene = render();

    const grid: Partial<CopyGhostRequest> = {
      axes: [{ kind: 'standard', axis: 'x' }, { kind: 'standard', axis: 'y' }],
      directions: [
        { count: 2, offset: 40, length: null },
        { count: 2, offset: 30, length: null },
      ],
    };
    // 2 × 2 less the original: cells (0,1), (1,0), (1,1).
    expect(solidsOf(copyGhost(scene, [5], grid))).toHaveLength(3);
    expect(solidsOf(copyGhost(scene, [5], { ...grid, skip: [[1, 0]] }))).toHaveLength(2);
    // The whole row at index 1 along direction 1 — cells (1,0) and (1,1).
    expect(solidsOf(copyGhost(scene, [5], { ...grid, skip: [[1]] }))).toHaveLength(1);
  });

  it("leaves out circular instances by index", () => {
    locatedBox(5, () => { rect([40, -10], 20, 20); });
    const scene = render();

    const result = copyGhost(scene, [5], {
      kind: 'circular',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      count: 4,
      sweep: { mode: 'angle', value: 360 },
      skip: [[1], [3]],
    });

    // Of the three clones at 90/180/270°, only the half turn survives.
    expect(solidsOf(result)).toHaveLength(1);
    expect(bounds(result, 0).minX).toBeCloseTo(-60, 3);
  });

  it("spreads a total span across the gaps", () => {
    locatedBox(5);
    const scene = render();

    // 3 instances over 80 mm = the same 40 mm step the offset form states.
    const result = copyGhost(scene, [5], {
      directions: [{ count: 3, offset: null, length: 80 }],
    });

    expect(bounds(result, 0).minX).toBeCloseTo(40, 3);
    expect(bounds(result, 1).minX).toBeCloseTo(80, 3);
  });

  it("spins the clones around a circular axis", () => {
    // Off the axis, so the rotation is visible in the bounds at all.
    locatedBox(5, () => { rect([40, -10], 20, 20); });
    const scene = render();

    const result = copyGhost(scene, [5], {
      kind: 'circular',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      count: 4,
      sweep: { mode: 'angle', value: 360 },
    });

    expect(solidsOf(result)).toHaveLength(3);
    // A quarter turn carries the box from +x round to +y.
    const first = bounds(result, 0);
    expect(first.minY).toBeCloseTo(40, 3);
    expect(first.maxY).toBeCloseTo(60, 3);
    expect(first.minX).toBeCloseTo(-10, 3);
  });

  /**
   * The one placement rule a copy does not share with a repeat: a partial
   * sweep is divided by the instance count (copy-circular.ts:48), not by the
   * gaps between them, so the last clone stops short of the stated angle.
   */
  it("divides a partial sweep by the count, not the gaps", () => {
    locatedBox(5, () => { rect([40, -10], 20, 20); });
    const scene = render();

    const result = copyGhost(scene, [5], {
      kind: 'circular',
      axes: [{ kind: 'standard', axis: 'z' }],
      directions: [],
      count: 2,
      sweep: { mode: 'angle', value: 180 },
    });

    // 180 / 2 = a single clone at 90°, where a repeat would put it at 180°.
    expect(solidsOf(result)).toHaveLength(1);
    const box = bounds(result, 0);
    expect(box.minY).toBeCloseTo(40, 3);
    expect(box.maxY).toBeCloseTo(60, 3);
  });

  /**
   * Where the repeat and the copy part company. A boss sketched on a plate's
   * face fuses into the plate, so the statement's body is plate-plus-boss —
   * and `copy()` clones the body its target holds, so that whole fused body is
   * what lands per instance (the repeat replays the boss's chain instead, and
   * stamps the boss alone).
   */
  it("clones the whole body its target holds, fused plate and all", () => {
    sketch("xy", () => { rect(200, 100).centered(); });
    const plate = extrude(20) as unknown as { endFaces: () => unknown };
    sketch(plate.endFaces() as never, () => { circle([-80, 30], 30); });
    const boss = extrude(10) as unknown as SceneObject;
    boss.setSourceLocation({ filePath: FILE, line: 9, column: 0 });
    const scene = render();

    const result = copyGhost(scene, [9], {
      directions: [{ count: 2, offset: 300, length: null }],
    });

    expect(solidsOf(result)).toHaveLength(1);
    const box = bounds(result, 0);
    // The plate spans x -100…100 and stands z 0…20, the boss on top of it —
    // all of it moved 300 mm along x.
    expect(box.minX).toBeCloseTo(200, 1);
    expect(box.maxX).toBeCloseTo(400, 1);
    expect(box.minZ).toBeCloseTo(0, 3);
    expect(box.maxZ).toBeCloseTo(30, 3);
  });

  it("clones every target the request names", () => {
    locatedBox(5);
    locatedBox(9, () => { rect([100, -10], 20, 20); });
    const scene = render();

    const result = copyGhost(scene, [5, 9], {
      directions: [{ count: 2, offset: 40, length: null }],
    });

    const solids = solidsOf(result);
    expect(solids).toHaveLength(1);
    // One body per instance, carrying both targets' meshes.
    expect(solids[0].meshes.filter(m => m.label === 'solid-faces')).toHaveLength(2);
    const xs = solids[0].meshes.flatMap(m => m.vertices.filter((_, i) => i % 3 === 0));
    expect(Math.min(...xs)).toBeCloseTo(40, 3);
    expect(Math.max(...xs)).toBeCloseTo(160, 3);
  });

  /**
   * The edit dialog's own blind spot: a copy takes its targets' shapes over
   * (copy-linear.ts:33-38), so re-previewing the statement being edited finds
   * them already consumed — by itself. Re-reading as if no removal applied
   * brings the body back, and without it editing any copy would draw nothing.
   */
  it("clones a target the copy being edited already took over", () => {
    const box = locatedBox(5);
    copy("linear", "x", { count: 2, offset: 200 }, box as never);
    const scene = render();

    const result = copyGhost(scene, [5], {
      directions: [{ count: 2, offset: 40, length: null }],
    });

    // The target's own body at its own place, not the copy's clone at x 200.
    const stamped = bounds(result, 0);
    expect(stamped.minX).toBeCloseTo(40, 3);
    expect(stamped.maxX).toBeCloseTo(60, 3);
  });

  it("clones along an axis() statement named by call site", () => {
    const a = axis("y") as unknown as SceneObject;
    a.setSourceLocation({ filePath: FILE, line: 3, column: 0 });
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], {
      axes: [{ kind: 'axis', filePath: FILE, line: 3 }],
      directions: [{ count: 2, offset: 40, length: null }],
    });

    const box = bounds(result, 0);
    expect(box.minY).toBeCloseTo(40, 3);
    expect(box.maxY).toBeCloseTo(60, 3);
  });

  it("refuses more instances than it draws", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], {
      directions: [{ count: 300, offset: 5, length: null }],
    });

    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain('299');
    // A limit the user can act on — the dialog says this one out loud.
    expect('surface' in result && result.surface).toBe(true);
  });

  it("draws nothing while the numbers are still being typed", () => {
    locatedBox(5);
    const scene = render();

    for (const directions of [
      [{ count: 1, offset: 40, length: null }],
      [{ count: 3, offset: 0, length: null }],
    ]) {
      const result = copyGhost(scene, [5], { directions });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.solids).toHaveLength(0);
      }
    }
  });

  it("refuses a target the scene doesn't hold", () => {
    locatedBox(5);
    const scene = render();

    expect(copyGhost(scene, [99]).ok).toBe(false);
  });

  it("refuses a target with nothing solid to clone", () => {
    locatedSketch(7, () => { rect(20, 20); });
    const scene = render();

    const result = copyGhost(scene, [7]);

    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain('no solid');
    // Ordinary refusals stay silent — the dialog clears and says nothing.
    expect('surface' in result && result.surface).toBeFalsy();
  });

  it("refuses an axis the scene doesn't hold", () => {
    locatedBox(5);
    const scene = render();

    const result = copyGhost(scene, [5], {
      axes: [{ kind: 'axis', filePath: FILE, line: 99 }],
    });

    expect(result.ok).toBe(false);
  });
});

/**
 * Whether every triangle still winds the way its stored normals say it should
 * — what a mirror breaks unless the indices are swapped with the vertices.
 */
function windingFollowsNormals(mesh: SceneObjectMesh): boolean {
  const at = (values: number[], index: number) =>
    [values[index * 3], values[index * 3 + 1], values[index * 3 + 2]];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const [ax, ay, az] = at(mesh.vertices, a);
    const [bx, by, bz] = at(mesh.vertices, b);
    const [cx, cy, cz] = at(mesh.vertices, c);
    const [ux, uy, uz] = [bx - ax, by - ay, bz - az];
    const [vx, vy, vz] = [cx - ax, cy - ay, cz - az];
    const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(cross[0], cross[1], cross[2]);
    if (length < 1e-9) {
      // A degenerate triangle winds neither way.
      continue;
    }
    const normal = at(mesh.normals, a);
    const dot = (cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2]) / length;
    if (dot < 0.5) {
      return false;
    }
  }
  return true;
}

describe("feature ghost — rib", () => {
  setupOC();

  const RIB_BASE: Omit<RibGhostRequest, 'spine' | 'scope'> = {
    feature: 'rib',
    op: 'add',
    thickness: 5,
    parallel: false,
    extend: false,
    draft: null,
  };

  function ribGhost(
    scene: Scene,
    spineLine: number,
    overrides: Partial<RibGhostRequest> = {},
  ) {
    return buildFeatureGhost(
      scene,
      {
        ...RIB_BASE,
        scope: [],
        ...overrides,
        spine: { filePath: FILE, line: spineLine },
      },
      DEFAULT_MESH_CONFIG,
    );
  }

  /** The shelled box every rib test walls up, plus its front spine sketch. */
  function shelledBoxWithSpine(): { box: SceneObject } {
    locatedSketch(3, () => { rect(100, 50).centered(); }, 'xy');
    const box = extrude(30) as unknown as SceneObject;
    box.setSourceLocation({ filePath: FILE, line: 4, column: 0 });
    const sh = shell(-4, (box as any).endFaces()) as unknown as SceneObject;
    sh.setSourceLocation({ filePath: FILE, line: 5, column: 0 });
    const spine = sketch("front", () => {
      move([-20, 15]);
      hLine(40);
    }) as Sketch;
    spine.setSourceLocation({ filePath: FILE, line: 7, column: 0 });
    return { box: sh };
  }

  it("meshes the conformed wall inside the cavity", () => {
    shelledBoxWithSpine();
    const scene = render();

    const result = ribGhost(scene, 7);
    expect(refusal(result)).toBe('');
    if (result.ok) {
      expect(result.solids.length).toBeGreaterThan(0);
      const box = bounds(result);
      // Conformance keeps the wall inside the shelled box.
      expect(box.minX).toBeGreaterThanOrEqual(-50 - 0.1);
      expect(box.maxX).toBeLessThanOrEqual(50 + 0.1);
      expect(box.minY).toBeGreaterThanOrEqual(-25 - 0.1);
      expect(box.maxY).toBeLessThanOrEqual(25 + 0.1);
      expect(box.minZ).toBeGreaterThanOrEqual(-0.1);
      expect(box.maxZ).toBeLessThanOrEqual(30 + 0.1);
    }
  });

  it("resolves an explicit scope statement, parallel and extended", () => {
    shelledBoxWithSpine();
    const scene = render();

    const result = ribGhost(scene, 7, {
      parallel: true,
      extend: true,
      scope: [{ filePath: FILE, line: 5 }],
    });
    expect(refusal(result)).toBe('');
    if (result.ok) {
      expect(result.solids.length).toBeGreaterThan(0);
    }
  });

  it("builds the exact tapered prism for a parallel draft", () => {
    shelledBoxWithSpine();
    const scene = render();

    const result = ribGhost(scene, 7, { parallel: true, draft: 3 });
    expect(refusal(result)).toBe('');
  });

  it("refuses a spine the scene does not hold", () => {
    shelledBoxWithSpine();
    const scene = render();

    expect(refusal(ribGhost(scene, 99))).toContain('not in the rendered scene');
  });

  it("refuses a scope statement the scene does not hold", () => {
    shelledBoxWithSpine();
    const scene = render();

    const result = ribGhost(scene, 7, { scope: [{ filePath: FILE, line: 99 }] });
    expect(refusal(result)).toContain('scope solid is not in the rendered scene');
  });

  it("refuses when the scene has no solids to conform to", () => {
    locatedSketch(7, () => {
      move([-20, 15]);
      hLine(40);
    }, 'xz');
    const scene = render();

    expect(refusal(ribGhost(scene, 7))).toContain('no solids to conform to');
  });

  it("edit mode: conforms against the pre-statement bodies via `exclude`", () => {
    // The rib3 repro: the statement being edited is APPLIED — built and fused
    // into the model. Without `exclude` the ghost prism is cut against a body
    // that already contains the rib, leaving only boundary slivers (the
    // flat-sheet bug); with it, the scope reads as of just before the rib.
    sketch("top", () => { rect(100, 50).centered(); }, );
    const box = extrude(30);
    const sh = shell(-4, (box as any).endFaces());
    fillet(2, (sh as any).internalEdges());
    const spine = locatedSketch(15, () => {
      move([-50 + 4, 20]);
      aLine(-45, 20);
    }, 'xz');
    void spine;
    const r = rib(5).parallel() as unknown as SceneObject;
    r.setSourceLocation({ filePath: FILE, line: 20, column: 0 });
    const scene = render();

    // Sketch line 15 sits on the 'front' plane in the repro; locatedSketch
    // draws on xz which shares the geometry for this purpose.
    const result = ribGhost(scene, 15, {
      parallel: true,
      exclude: { filePath: FILE, line: 20 },
    });
    expect(refusal(result)).toBe('');
    if (result.ok) {
      expect(result.solids).toHaveLength(1);
      const wall = bounds(result);
      // The proper gusset: full 5-thickness slab under the spine, inside the
      // cavity — never buried in the wall (x < -46) or under the floor (z < 4).
      expect(wall.maxY - wall.minY).toBeGreaterThan(4.9);
      expect(wall.minX).toBeGreaterThanOrEqual(-46 - 0.1);
      expect(wall.minZ).toBeGreaterThanOrEqual(4 - 0.1);
    }
  });
});
