import type { Object3D } from 'three';
import { viewerSettings } from '../../scene/viewer-settings';
import type { SketchMesh } from './sketch-mesh';

export interface SketchConstraintVisibility {
  /** Dimensional constraints: distance/angle/radius/diameter annotations. */
  dimensions: boolean;
  /** Positional constraints: badges and coincidence dots. */
  positional: boolean;
}

/**
 * Re-derive every live sketch mesh's constraint glyphs from the current
 * visibility settings — the sketch dialog's dimensional/positional toggles
 * and the screenshot options both end up here. No server round-trip: the
 * meshes rebuild their annotation groups in place. `annotateInactive` lets
 * a capture annotate sketches that are not being edited, which the live
 * view never does.
 */
export function refreshSketchConstraintGlyphs(scene: Object3D, annotateInactive = false): void {
  // Collect before refreshing: the rebuild swaps the mesh's own children,
  // which must not happen under scene.traverse's child iteration.
  const meshes: SketchMesh[] = [];
  scene.traverse(node => {
    if (node.userData.isSketchRoot) {
      meshes.push(node as SketchMesh);
    }
  });
  for (const mesh of meshes) {
    mesh.refreshConstraintGlyphs(annotateInactive);
  }
}

/**
 * Temporarily apply a constraint-visibility choice to the live sketch
 * meshes. Returns the undo, which puts the session-wide settings back and
 * rebuilds the glyphs once more. A capture that asks for either category
 * gets it on every sketch, not only the one being edited, so a shot of a
 * sketch's state reads the same whether or not sketch mode is open; that
 * override always rebuilds. A capture that asks for neither is a no-op
 * (identity undo) when the settings already agree, so it never churns the
 * meshes needlessly.
 */
export function withSketchConstraintVisibility(
  scene: Object3D,
  visibility: SketchConstraintVisibility,
): () => void {
  const saved = {
    sketchShowDimensions: viewerSettings.current.sketchShowDimensions,
    sketchShowPositional: viewerSettings.current.sketchShowPositional,
  };
  const unchanged = saved.sketchShowDimensions === visibility.dimensions
    && saved.sketchShowPositional === visibility.positional;
  const annotate = visibility.dimensions || visibility.positional;
  if (unchanged && !annotate) {
    return () => {};
  }
  viewerSettings.update({
    sketchShowDimensions: visibility.dimensions,
    sketchShowPositional: visibility.positional,
  });
  refreshSketchConstraintGlyphs(scene, annotate);
  return () => {
    viewerSettings.update(saved);
    refreshSketchConstraintGlyphs(scene);
  };
}
