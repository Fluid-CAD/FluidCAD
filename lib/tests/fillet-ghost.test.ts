import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import fillet from "../core/fillet.js";
import select from "../core/select.js";
import { rect } from "../core/2d/index.js";
import { edge } from "../filters/index.js";
import { Edge } from "../common/edge.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import {
  buildFeatureGhost, FeatureGhostResult, FilletGhostRequest, GhostEntityRef,
} from "../rendering/feature-ghost.js";
import { Scene } from "../rendering/scene.js";

const BASE: Omit<FilletGhostRequest, 'edges'> = {
  feature: 'fillet',
  value: 3,
  distance2: null,
  isAngle: false,
};

function bandGhost(
  scene: Scene,
  edges: GhostEntityRef[],
  overrides: Partial<FilletGhostRequest> = {},
): FeatureGhostResult {
  return buildFeatureGhost(
    scene,
    { ...BASE, ...overrides, edges } as FilletGhostRequest,
    DEFAULT_MESH_CONFIG,
  );
}

function sceneSolids(scene: Scene): Shape[] {
  const solids: Shape[] = [];
  for (const obj of scene.getSceneObjects()) {
    solids.push(...obj.getShapes(undefined, 'solid'));
  }
  return solids;
}

/**
 * A pick as the viewport makes one: the solid's id plus the edge's index in
 * mesh order. `matches` picks out the edges to reference by their extent.
 */
function picks(solid: Shape, matches: (box: ReturnType<typeof ShapeOps.getBoundingBox>) => boolean) {
  const edges = Explorer.findEdgesWrapped(solid) as Edge[];
  const refs: GhostEntityRef[] = [];
  edges.forEach((e, index) => {
    if (matches(ShapeOps.getBoundingBox(e))) {
      refs.push({ shapeId: solid.id, index, kind: 'edge' });
    }
    e.dispose();
  });
  return refs;
}

/** A face pick, the way the viewport makes one. */
function facePicks(solid: Shape, matches: (box: ReturnType<typeof ShapeOps.getBoundingBox>) => boolean) {
  const faces = Explorer.findFacesWrapped(solid);
  const refs: GhostEntityRef[] = [];
  faces.forEach((f, index) => {
    if (matches(ShapeOps.getBoundingBox(f))) {
      refs.push({ shapeId: solid.id, index, kind: 'face' });
    }
    f.dispose();
  });
  return refs;
}

/** The extent of a band's face mesh, straight off the returned vertices. */
function bounds(result: FeatureGhostResult, band: number) {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  const faces = result.solids[band].meshes.find(m => m.label === 'solid-faces')!;
  const along = (offset: number) => faces.vertices.filter((_, i) => i % 3 === offset);
  const [xs, ys, zs] = [along(0), along(1), along(2)];
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

/** A plain 40 x 40 x 20 block — four convex vertical edges. */
function block(): Solid {
  sketch('xy', () => { rect(40, 40); });
  extrude(20);
  return sceneSolids(render()).pop() as Solid;
}

/**
 * A 20 x 20 tower on a 40 x 40 base. The tower's footprint on the base's top
 * face (z = 20) is concave — a fillet there ADDS material.
 */
function steppedBlock(): Solid {
  sketch('xy', () => { rect(40, 40); });
  extrude(20);
  sketch('xy', () => { rect(20, 20); });
  extrude(40);
  return sceneSolids(render()).pop() as Solid;
}

const isTall = (b: { minZ: number; maxZ: number }) => Math.abs(b.maxZ - b.minZ) > 19;
const isStep = (b: {
  minZ: number; maxZ: number; maxX: number; maxY: number;
}) => Math.abs(b.maxZ - b.minZ) < 0.5 && Math.abs(b.minZ - 20) < 0.5
  && b.maxX < 20.5 && b.maxY < 20.5;

describe("fillet ghost", () => {
  setupOC();

  it("draws one band per picked edge, labeled like a solid", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTall);
    expect(refs).toHaveLength(4);

    const result = bandGhost(scene, refs);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(4);
    for (const band of result.solids) {
      const labels = band.meshes.map(m => m.label);
      expect(labels).toContain('solid-faces');
      expect(labels).toContain('solid-edges');
    }
  });

  it("sizes the band to the radius and spans the edge", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTall).slice(0, 1);

    const box = bounds(bandGhost(scene, refs, { value: 5 }), 0);

    // The band wraps a vertical corner: full height, and 5 mm of reach into
    // each of the two faces that meet there.
    expect(box.maxZ - box.minZ).toBeCloseTo(20, 3);
    expect(box.maxX - box.minX).toBeCloseTo(5, 3);
    expect(box.maxY - box.minY).toBeCloseTo(5, 3);
  });

  it("grows the band with the radius", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTall).slice(0, 1);

    const small = bounds(bandGhost(scene, refs, { value: 2 }), 0);
    const large = bounds(bandGhost(scene, refs, { value: 8 }), 0);

    expect(large.maxX - large.minX).toBeGreaterThan(small.maxX - small.minX);
  });

  it("marks a convex edge's band as material leaving", () => {
    const solid = block();
    const scene = render();

    const result = bandGhost(scene, picks(solid, isTall));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids.map(s => s.kind)).toEqual(['remove', 'remove', 'remove', 'remove']);
  });

  it("marks a concave edge's band as material arriving", () => {
    const solid = steppedBlock();
    const scene = render();
    const refs = picks(solid, isStep);
    expect(refs.length).toBeGreaterThan(0);

    const result = bandGhost(scene, refs);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids.length).toBe(refs.length);
    for (const band of result.solids) {
      expect(band.kind).toBe('add');
    }
  });

  /** One statement, picks on both sides of a step — the colors must split. */
  it("colors each band independently within one selection", () => {
    const solid = steppedBlock();
    const scene = render();
    const refs = [...picks(solid, isStep), ...picks(solid, b => isTall(b) && b.maxX > 39.5 && b.maxY > 39.5)];

    const result = bandGhost(scene, refs);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const kinds = result.solids.map(s => s.kind);
    expect(kinds).toContain('add');
    expect(kinds).toContain('remove');
  });

  it("shows nothing when the radius is one OCCT refuses", () => {
    const solid = block();
    const scene = render();

    // 500 mm on a 40 mm block: the maker reports not-done rather than throwing.
    const result = bandGhost(scene, picks(solid, isTall), { value: 500 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toEqual([]);
  });

  it("shows nothing while the value is still empty", () => {
    const solid = block();
    const scene = render();

    const result = bandGhost(scene, picks(solid, isTall), { value: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toEqual([]);
  });

  it("refuses when a picked edge is no longer in the scene", () => {
    const solid = block();
    const scene = render();

    const gone = bandGhost(scene, [{ shapeId: 'no-such-shape', index: 0, kind: 'edge' }]);
    const outOfRange = bandGhost(scene, [{ shapeId: solid.id, index: 9999, kind: 'edge' }]);

    expect(gone.ok).toBe(false);
    expect(outOfRange.ok).toBe(false);
  });

  /** A picked face means every edge of it — the features explode faces. */
  it("bands every edge of a picked face", () => {
    const solid = block();
    const scene = render();
    // The block's top face (z = 20) — four edges around it.
    const face = facePicks(solid, b => Math.abs(b.minZ - 20) < 0.5 && Math.abs(b.maxZ - 20) < 0.5);
    expect(face).toHaveLength(1);

    const result = bandGhost(scene, face, { value: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(4);
    for (const band of result.solids) {
      expect(band.kind).toBe('remove');
    }
  });

  describe("chamfer", () => {
    it("bands an equal-distance chamfer", () => {
      const solid = block();
      const scene = render();
      const refs = picks(solid, isTall).slice(0, 1);

      const result = bandGhost(scene, refs, { feature: 'chamfer', value: 4 });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.solids).toHaveLength(1);
      expect(result.solids[0].kind).toBe('remove');
      const box = bounds(result, 0);
      expect(box.maxX - box.minX).toBeCloseTo(4, 3);
      expect(box.maxY - box.minY).toBeCloseTo(4, 3);
    });

    it("bands a two-distance chamfer asymmetrically", () => {
      const solid = block();
      const scene = render();
      const refs = picks(solid, isTall).slice(0, 1);

      const result = bandGhost(scene, refs,
        { feature: 'chamfer', value: 2, distance2: 8 });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const box = bounds(result, 0);
      const reach = [box.maxX - box.minX, box.maxY - box.minY].sort((a, b) => a - b);
      expect(reach[0]).toBeCloseTo(2, 3);
      expect(reach[1]).toBeCloseTo(8, 3);
    });

    it("bands a distance-and-angle chamfer", () => {
      const solid = block();
      const scene = render();
      const refs = picks(solid, isTall).slice(0, 1);

      const result = bandGhost(scene, refs,
        { feature: 'chamfer', value: 5, distance2: 45, isAngle: true });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // 45° off a 5 mm run is a 5 mm rise — an equal-distance chamfer.
      const box = bounds(result, 0);
      expect(box.maxX - box.minX).toBeCloseTo(5, 3);
      expect(box.maxY - box.minY).toBeCloseTo(5, 3);
    });
  });

  /**
   * The edit dialog's case: the statement being edited has already consumed
   * its target solid, whose shape the fillet recorded as removed. The picks
   * still address it, because `getAddedShapes` ignores removal scope.
   */
  it("bands a solid the edited statement already consumed", () => {
    sketch('xy', () => { rect(40, 40); });
    extrude(20);
    const beforeFillet = sceneSolids(render()).pop() as Solid;
    const refs = picks(beforeFillet, isTall);

    select(edge().verticalTo("xy"));
    fillet(5);
    const scene = render();

    const result = bandGhost(scene, refs, { value: 6 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(4);
  });

  /** Ghost temporaries are unreachable from scene state — a leak compounds. */
  it("survives repeated build-and-free cycles", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTall);

    for (let i = 0; i < 50; i++) {
      const result = bandGhost(scene, refs, { value: 1 + (i % 5) });
      expect(result.ok).toBe(true);
    }
  });
});
