import { Group, Object3D } from 'three';
import { GhostSolid } from '../../api';
import { SolidMesh } from '../../meshes/shape-meshes/solid-mesh';
import { themeColors } from '../../scene/theme-colors';
import { Viewer } from '../../viewer';

/** Green for the body an apply would add, red for the tool a cut would sweep. */
export type GhostKind = 'add' | 'remove';

const FACE_OPACITY = 0.45;
const EDGE_OPACITY = 0.9;

/**
 * The live geometry a feature dialog would produce, drawn translucent over
 * the scene while the user tweaks values ("ghost" — the panel's *preview* is
 * its statement-text row, a different thing entirely).
 *
 * The meshes come from the server's side channel: they are never scene
 * shapes, carry no shape ids anything can pick, and are thrown away and
 * rebuilt on every debounce tick. The group sits in the scene as a **sibling**
 * of `compiledMesh`, which is what keeps it out of three things at once —
 * `Viewer.updateView`'s teardown of the compiled tree, the auto-fit bounds
 * (via `isMetaShape`), and sketch-mode ghosting, which tints only
 * `compiledMesh`'s children.
 *
 * A theme switch mid-dialog leaves the current ghost in the old theme's
 * colors until the next tick repaints it — a debounce away, not worth wiring
 * a theme listener for.
 */
export class FeatureGhostOverlay {
  private group = new Group();

  constructor(private viewer: Viewer) {
    this.group.name = 'featureGhost';
    this.group.userData.isMetaShape = true;
    this.group.renderOrder = 3;
    this.viewer.sceneContext.scene.add(this.group);
  }

  /** Replace the drawn bodies; an empty list just clears. */
  set(solids: GhostSolid[], kind: GhostKind): void {
    this.clear();
    const face = kind === 'remove' ? themeColors.ghostRemoveFaceColor : themeColors.ghostAddFaceColor;
    const edge = kind === 'remove' ? themeColors.ghostRemoveEdgeColor : themeColors.ghostAddEdgeColor;
    // Depth testing off, on the faces as well as the edges: a cut tool sits
    // buried inside the material it removes, and an extrusion can sweep back
    // into the model — depth-tested, those ghosts would vanish behind the very
    // solid they act on, leaving only their outline. The ghost is an overlay,
    // so it always draws over the scene.
    const options = {
      face: { color: `#${face.getHexString()}`, opacity: FACE_OPACITY, depthTest: false },
      edge: { color: `#${edge.getHexString()}`, opacity: EDGE_OPACITY, depthWrite: false },
    };
    solids.forEach((solid, index) => {
      this.group.add(new SolidMesh(
        { shapeId: `ghost-${index}`, shapeType: 'solid', meshes: solid.meshes },
        options,
      ));
    });
    this.viewer.sceneContext.requestRender();
  }

  /** Drop the drawn bodies and free their GPU resources. */
  clear(): void {
    if (this.group.children.length === 0) {
      return;
    }
    while (this.group.children.length > 0) {
      const child = this.group.children[0];
      this.group.remove(child);
      disposeTree(child);
    }
    this.viewer.sceneContext.requestRender();
  }
}

function disposeTree(root: Object3D): void {
  root.traverse((node: Object3D & { geometry?: { dispose?: () => void }; material?: any }) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) {
      material.forEach(m => m?.dispose?.());
    } else {
      material?.dispose?.();
    }
  });
}
