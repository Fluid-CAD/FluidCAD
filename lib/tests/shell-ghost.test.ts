import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import shell from "../core/shell.js";
import select from "../core/select.js";
import { } from "../core/2d/index.js";
import { face } from "../filters/index.js";
import { Shape } from "../common/shape.js";
import { Solid } from "../common/solid.js";
import { Shell } from "../features/shell.js";
import { SceneObject } from "../common/scene-object.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeOps } from "../oc/shape-ops.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import {
  buildFeatureGhost, FeatureGhostResult, GhostFaceRef, ShellGhostRequest,
} from "../rendering/feature-ghost.js";
import { Scene } from "../rendering/scene.js";
import { testRect } from "./helpers/profiles.js";

const BASE: Omit<ShellGhostRequest, 'faces'> = {
  feature: 'shell',
  thickness: -3,
  joinType: 'arc',
};

function shellGhost(
  scene: Scene,
  faces: GhostFaceRef[],
  overrides: Partial<ShellGhostRequest> = {},
): FeatureGhostResult {
  return buildFeatureGhost(
    scene,
    { ...BASE, ...overrides, faces } as ShellGhostRequest,
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

type Box = ReturnType<typeof ShapeOps.getBoundingBox>;

/**
 * A face pick as the viewport makes one: the solid's id plus the face's index
 * in mesh order. `matches` picks out the faces to reference by their extent.
 */
function picks(solid: Shape, matches: (box: Box) => boolean): GhostFaceRef[] {
  const faces = Explorer.findFacesWrapped(solid);
  const refs: GhostFaceRef[] = [];
  faces.forEach((f, index) => {
    if (matches(ShapeOps.getBoundingBox(f))) {
      refs.push({ shapeId: solid.id, index });
    }
    f.dispose();
  });
  return refs;
}

/** The extent of a wall's face mesh, straight off the returned vertices. */
function bounds(result: FeatureGhostResult, wall: number): Box {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  const faces = result.solids[wall].meshes.find(m => m.label === 'solid-faces')!;
  const along = (offset: number) => faces.vertices.filter((_, i) => i % 3 === offset);
  const [xs, ys, zs] = [along(0), along(1), along(2)];
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
    minZ: Math.min(...zs), maxZ: Math.max(...zs),
  } as Box;
}

/** Every wall's extent, in a stable order, so two ghosts (or a ghost and an apply) compare. */
function sortedBounds(boxes: Box[]): number[][] {
  const rounded = boxes.map(b => [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].map(v => Math.round(v * 1e4) / 1e4));
  return rounded.sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

function wallBounds(result: FeatureGhostResult): number[][] {
  if (!result.ok) {
    throw new Error(`ghost refused: ${'reason' in result ? result.reason : ''}`);
  }
  return sortedBounds(result.solids.map((_, i) => bounds(result, i)));
}

/** A plain 40 x 40 x 20 block. */
function block(): Solid {
  sketch('xy', () => {
      testRect(40, 40);
    });
  extrude(20);
  return sceneSolids(render()).pop() as Solid;
}

const isTop = (b: Box) => Math.abs(b.minZ - 20) < 0.5 && Math.abs(b.maxZ - 20) < 0.5;
const isFront = (b: Box) => Math.abs(b.minY - 40) < 0.5 && Math.abs(b.maxY - 40) < 0.5;

describe("shell ghost", () => {
  setupOC();

  it("draws the inner walls of an opened box, labeled like a solid", () => {
    const solid = block();
    const scene = render();

    const result = shellGhost(scene, picks(solid, isTop));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Four side walls and the floor; the opened top has no wall.
    expect(result.solids).toHaveLength(5);
    for (const wall of result.solids) {
      expect(wall.kind).toBe('remove');
      expect(wall.meshes.map(m => m.label)).toContain('solid-faces');
    }
  });

  it("sets the walls in by the thickness", () => {
    const solid = block();
    const scene = render();

    const result = shellGhost(scene, picks(solid, isTop), { thickness: -3 });

    const walls = wallBounds(result);
    // The floor: a 34 x 34 square at z = 3, the thickness up from the bottom.
    expect(walls).toContainEqual([3, 3, 3, 37, 37, 3]);
    // A side wall runs from the floor to the open top, one thickness in.
    expect(walls).toContainEqual([3, 3, 3, 3, 37, 20]);
  });

  it("follows the thickness as it changes", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTop);

    const thin = wallBounds(shellGhost(scene, refs, { thickness: -2 }));
    const thick = wallBounds(shellGhost(scene, refs, { thickness: -6 }));

    expect(thin).toContainEqual([2, 2, 2, 38, 38, 2]);
    expect(thick).toContainEqual([6, 6, 6, 34, 34, 6]);
  });

  it("builds the wall outside the solid, as material arriving, for a positive thickness", () => {
    const solid = block();
    const scene = render();

    const result = shellGhost(scene, picks(solid, isTop), { thickness: 3, joinType: 'intersection' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(5);
    for (const wall of result.solids) {
      expect(wall.kind).toBe('add');
    }
    // The new floor sits one thickness below the block; the rim at z = 20
    // and the block's own faces, now the cavity, are not walls.
    expect(wallBounds(result)).toContainEqual([-3, -3, -3, 43, 43, -3]);
  });

  it("rounds an outward shell's corners with the arc join and squares them with intersection", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTop);

    const arc = shellGhost(scene, refs, { thickness: 3, joinType: 'arc' });
    const squared = shellGhost(scene, refs, { thickness: 3, joinType: 'intersection' });

    expect(arc.ok && squared.ok).toBe(true);
    if (!arc.ok || !squared.ok) {
      return;
    }
    expect(squared.solids).toHaveLength(5);
    expect(arc.solids.length).toBeGreaterThan(squared.solids.length);
  });

  it("opens every picked face", () => {
    const solid = block();
    const scene = render();

    const result = shellGhost(scene, [...picks(solid, isTop), ...picks(solid, isFront)]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Three side walls and the floor; the top and the front are open.
    expect(result.solids).toHaveLength(4);
  });

  it("counts a face picked twice once", () => {
    const solid = block();
    const scene = render();
    const top = picks(solid, isTop);

    const result = shellGhost(scene, [...top, ...top]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(5);
  });

  it("shows nothing when the wall is one OCCT refuses", () => {
    const solid = block();
    const scene = render();

    // Thicker than the block is tall: the offset collapses.
    const result = shellGhost(scene, picks(solid, isTop), { thickness: -30 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(0);
  });

  it("shows nothing while the thickness is still empty", () => {
    const solid = block();
    const scene = render();

    const result = shellGhost(scene, picks(solid, isTop), { thickness: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(0);
  });

  it("refuses when a picked face is no longer in the scene", () => {
    const solid = block();
    const scene = render();

    const gone = shellGhost(scene, [{ shapeId: 'not-a-shape', index: 0 }]);
    const outOfRange = shellGhost(scene, [{ shapeId: solid.id, index: 99 }]);

    expect(gone.ok).toBe(false);
    expect(outOfRange.ok).toBe(false);
  });

  it("hollows each solid the picks straddle on its own", () => {
    sketch('xy', () => {
        testRect(40, 40);
      });
    extrude(20);
    sketch('xy', () => {
        testRect(20, 20, { at: [60, 0] });
      });
    extrude(20);
    const scene = render();
    const [big, small] = sceneSolids(scene) as Solid[];

    const result = shellGhost(scene, [...picks(big, isTop), ...picks(small, isTop)]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(10);
  });

  it("draws the walls the applied shell records as its internal faces", () => {
    sketch('xy', () => {
        testRect(40, 40);
      });
    const stock = extrude(20) as unknown as SceneObject;
    select(face().onPlane('xy', 20));
    const applied = shell(-4) as unknown as Shell;
    const internal = applied.internalFaces();
    addToScene(internal);
    const scene = render();

    // The stock the shell consumed is still addressable — the edit dialog's
    // own situation — so the ghost hollows the same solid the apply did.
    const consumed = stock.getAddedShapes().find(shape => shape.getType() === 'solid') as Solid;
    const ghost = wallBounds(shellGhost(scene, picks(consumed, isTop), { thickness: -4 }));

    expect(internal.getShapes()).toHaveLength(5);
    expect(sortedBounds(internal.getShapes().map(f => ShapeOps.getBoundingBox(f)))).toEqual(ghost);
  });

  it("ghosts a solid the edited statement already consumed", () => {
    sketch('xy', () => {
        testRect(40, 40);
      });
    extrude(20);
    const beforeShell = sceneSolids(render()).pop() as Solid;
    const refs = picks(beforeShell, isTop);

    select(face().onPlane('xy', 20));
    shell(-3);
    const scene = render();

    const result = shellGhost(scene, refs, { thickness: -5 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.solids).toHaveLength(5);
  });

  /** Ghost temporaries are unreachable from scene state — a leak compounds. */
  it("survives repeated build-and-free cycles", () => {
    const solid = block();
    const scene = render();
    const refs = picks(solid, isTop);

    for (let i = 0; i < 50; i++) {
      const result = shellGhost(scene, refs, { thickness: -(1 + (i % 5)) });
      expect(result.ok).toBe(true);
    }
  });
});
