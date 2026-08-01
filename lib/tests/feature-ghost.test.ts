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
import { bezier, circle, move, rect, vLine } from "../core/2d/index.js";
import { Sketch } from "../features/2d/sketch.js";
import { SceneObject } from "../common/scene-object.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import {
  buildFeatureGhost, ExtrudeGhostRequest, FeatureGhostResult, GhostPathRef, GhostSectionRef,
  LoftGhostRequest, RevolveGhostRequest, SweepGhostRequest,
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
