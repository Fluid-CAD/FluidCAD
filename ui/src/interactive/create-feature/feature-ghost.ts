import { Group, Object3D } from 'three';
import { GhostSolid } from '../../api';
import { EdgeMesh } from '../../meshes/shape-meshes/edge-mesh';
import { SolidMesh } from '../../meshes/shape-meshes/solid-mesh';
import { buildPlaneVisual, PLANE_OPACITY } from '../../meshes/containers/plane-mesh';
import { themeColors } from '../../scene/theme-colors';
import { Viewer } from '../../viewer';

/**
 * What the ghost is showing. Green for the body an apply would add, red for
 * the tool a cut would sweep — and two kinds for the features that put no
 * material anywhere at all: `wire` for one that is a curve (a helix), which
 * wears the blue a standalone wire renders in once applied, and `plane` for a
 * construction plane, which wears the plane's own yellow.
 */
export type GhostKind = 'add' | 'remove' | 'wire' | 'plane';

const FACE_OPACITY = 0.45;
const EDGE_OPACITY = 0.9;

/** A ghost curve is the whole feature, so it draws at the applied wire's weight. */
const WIRE_LINE_WIDTH = 2;

/**
 * A ghost plane draws a shade stronger than the settled one. The face is the
 * whole feature and the dialog is steering it live, so it has to register on
 * every keystroke — a plane at its resting translucency reads as scenery.
 */
const GHOST_PLANE_OPACITY = PLANE_OPACITY * 1.8;

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

  /**
   * Replace the drawn bodies; an empty list just clears. `kind` says what the
   * whole ghost is, except where a body names its own — a fillet reports that
   * per band, because one selection can shave a convex corner and fill a
   * concave one in the same breath.
   */
  set(solids: GhostSolid[], kind: GhostKind): void {
    this.clear();
    solids.forEach((solid, index) => {
      const bodyKind = solid.kind ?? kind;
      if (bodyKind === 'plane') {
        // A construction plane draws as the scene draws one — same quad, same
        // outline, same normal arrow. `plane` carries the frame that arrow
        // stands on; without it there is nothing to orient and nothing to draw.
        if (solid.plane && solid.meshes[0]) {
          const group = new Group();
          buildPlaneVisual(group, solid.meshes[0], solid.plane.normal, solid.plane.center,
            { opacity: GHOST_PLANE_OPACITY });
          this.group.add(group);
        }
        return;
      }
      this.group.add(bodyKind === 'wire'
        // A curve has no faces to split off: its meshes go straight to the
        // line renderer, which draws whatever it is handed.
        ? new EdgeMesh({ shapeType: 'edge', meshes: solid.meshes }, wireOptions())
        : new SolidMesh(
          { shapeId: `ghost-${index}`, shapeType: 'solid', meshes: solid.meshes },
          bodyOptions(bodyKind),
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

/**
 * Green for material an apply would add, red for material it takes away.
 *
 * Depth testing off, on the faces as well as the edges: a cut tool sits buried
 * inside the material it removes, an extrusion can sweep back into the model,
 * and a fillet band lies in the corner it rounds — depth-tested, all three
 * would vanish behind the very solid they act on, leaving only their outline.
 * The ghost is an overlay, so it always draws over the scene.
 */
function bodyOptions(kind: GhostKind) {
  const face = kind === 'remove' ? themeColors.ghostRemoveFaceColor : themeColors.ghostAddFaceColor;
  const edge = kind === 'remove' ? themeColors.ghostRemoveEdgeColor : themeColors.ghostAddEdgeColor;
  return {
    face: { color: `#${face.getHexString()}`, opacity: FACE_OPACITY, depthTest: false },
    edge: { color: `#${edge.getHexString()}`, opacity: EDGE_OPACITY, depthWrite: false },
  };
}

/**
 * A ghost curve: the applied wire's blue, drawn over the model like every
 * other ghost (EdgeMesh ties depth testing to `depthWrite`, so a helix coiled
 * on a shaft still reads in front of it). Barely translucent — a hairline
 * needs its color, and unlike a body there is nothing behind it to see.
 */
function wireOptions() {
  return {
    color: `#${themeColors.ghostWireColor.getHexString()}`,
    lineWidth: WIRE_LINE_WIDTH,
    opacity: EDGE_OPACITY,
    depthWrite: false,
  };
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
