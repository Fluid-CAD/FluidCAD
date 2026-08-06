import { Edge } from "../common/edge.js";
import { SceneObject } from "../common/scene-object.js";
import { BuildError } from "../common/build-error.js";
import { Sketch } from "../features/2d/sketch.js";
import { buildTextEdgesAlongPath } from "../features/2d/text.js";
import { FontRegistry } from "../io/font-registry.js";
import { Mesh } from "../oc/mesh.js";
import type { TextAlign } from "../oc/text-outline.js";
import { Scene } from "./scene.js";

/** The text dialogs' path-preview request: the picked edge names its whole
 * producing geometry (owner-level, like the apply), plus the layout options
 * the dialog edits. */
export type TextPathPreviewRequest = {
  shapeId: string;
  text: string;
  font?: string;
  weight: number;
  italic: boolean;
  size: number;
  align: TextAlign;
  lineSpacing: number;
  letterSpacing: number;
  /** The path-only chain options (`.offset()`, `.startAt()`, `.flip()`). */
  offset?: number;
  startAt?: number;
  flip?: boolean;
};

/**
 * The glyph outlines `text("…", path)` would lay along the picked geometry,
 * discretized to world-space polylines the viewport can draw — the dialogs'
 * live preview while a path is selected. Resolution is owner-level with
 * guides included, mirroring the apply's own (`resolvePicks` in
 * sketch-apply.ts): one shapeId names one sketch edge, and the edge stands
 * for its whole producing geometry. Layout failures (a disconnected or
 * non-planar path) surface as the reason the build itself would give.
 */
export function buildTextPathPreview(
  scene: Scene,
  request: TextPathPreviewRequest,
): { polylines: number[][] } | { reason: string } {
  const owner = findPathOwner(scene, request.shapeId);
  if (!owner) {
    return { reason: "That edge is not in the rendered scene." };
  }

  let edges: Edge[];
  try {
    const font = FontRegistry.resolve({
      font: request.font,
      weight: request.weight,
      italic: request.italic,
    });
    edges = buildTextEdgesAlongPath(owner, request.text, font, {
      size: request.size,
      align: request.align,
      lineSpacing: request.lineSpacing,
      letterSpacing: request.letterSpacing,
      offset: request.offset,
      startAt: request.startAt,
      flip: request.flip,
    }).edges;
  } catch (err) {
    if (err instanceof BuildError) {
      return { reason: err.message };
    }
    throw err;
  }

  const polylines: number[][] = [];
  for (const edge of edges) {
    try {
      const vertices = Mesh.discretizeEdge(edge).vertices;
      if (vertices.length >= 6) {
        polylines.push(vertices);
      }
    } finally {
      edge.dispose();
    }
  }
  return { polylines };
}

/** The picked edge's producing geometry, guides included — text paths are
 * classically `.guide()` construction curves. */
function findPathOwner(scene: Scene, shapeId: string): SceneObject | null {
  const sketches = scene.getAllSceneObjects().filter((o): o is Sketch => o instanceof Sketch);
  for (const sketch of sketches) {
    for (const [edge, owner] of sketch.getEdgesWithOwner({ excludeGuide: false })) {
      if (edge.id === shapeId) {
        return owner;
      }
    }
  }
  return null;
}
