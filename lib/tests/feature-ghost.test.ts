import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { rect } from "../core/2d/index.js";
import { Sketch } from "../features/2d/sketch.js";
import { buildFeatureGhost, FeatureGhostRequest } from "../rendering/feature-ghost.js";
import { DEFAULT_MESH_CONFIG } from "../oc/mesh.js";
import { Scene } from "../rendering/scene.js";

const FILE = '/tmp/ghost-test.fluid.js';

const BASE: Omit<FeatureGhostRequest, 'profile'> = {
  feature: 'extrude',
  op: 'add',
  distance: 10,
  distance2: null,
  symmetric: false,
  draft: null,
  drill: true,
  thin: null,
};

function ghost(scene: Scene, line: number, overrides: Partial<FeatureGhostRequest> = {}) {
  return buildFeatureGhost(
    scene,
    { ...BASE, ...overrides, profile: { filePath: FILE, line } },
    DEFAULT_MESH_CONFIG,
  );
}

/** A sketch addressable by source location, the way the parser records one. */
function locatedSketch(line: number, draw: () => void): Sketch {
  const s = sketch("xy", draw) as Sketch;
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
