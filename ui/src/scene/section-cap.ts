import {
  AlwaysStencilFunc,
  BackSide,
  Box3,
  DecrementWrapStencilOp,
  DoubleSide,
  FrontSide,
  Group,
  IncrementWrapStencilOp,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  NotEqualStencilFunc,
  Object3D,
  Plane,
  PlaneGeometry,
  Quaternion,
  ReplaceStencilOp,
  Sphere,
  Vector3,
} from 'three';
import { SceneContext } from './scene-context';
import { onThemeChange, themeColors } from './theme-colors';

const Z_AXIS = new Vector3(0, 0, 1);
const FALLBACK_CAP_SIZE = 10000;
const STENCIL_RENDER_ORDER = -2;
const CAP_RENDER_ORDER = -1;
// Push the cap slightly behind the sketch plane (into the body) so it doesn't
// z-fight with sketch edges drawn on that plane. The body is clipped at the
// sketch plane, so there's nothing in front of the cap to make this offset
// visible.
const CAP_DEPTH_OFFSET = 0.05;

/**
 * Returns true only for meshes that represent solid body faces — the things we
 * want to cap. Excludes sketch UI (cursor, tangent arrow), construction-plane
 * meshes, axis arrows, and other meta shapes whose ancestors carry an
 * `isSketchRoot` or `isMetaShape` flag.
 */
function isSolidFaceMesh(mesh: Object3D): boolean {
  for (let node: Object3D | null = mesh; node; node = node.parent) {
    if (node.userData.isSketchRoot || node.userData.isMetaShape) {
      return false;
    }
  }
  return true;
}

/**
 * Renders a filled cross-section ("cap") on solids clipped by the sketch-mode
 * section plane, so cut surfaces look closed instead of hollow.
 *
 * Uses Three.js's stencil-buffer cap technique: per source mesh we draw two
 * stencil-only clones (back-side INCR, front-side DECR) clipped by the same
 * plane, then a large quad on the plane that only colors fragments where
 * stencil != 0 — i.e. inside the cut volume.
 */
export class SectionCapManager {
  private group: Group | null = null;
  private capMaterial: MeshPhongMaterial | null = null;
  private unsubscribeTheme: () => void;

  constructor(private ctx: SceneContext) {
    this.unsubscribeTheme = onThemeChange(() => {
      if (this.capMaterial) {
        this.capMaterial.color.copy(themeColors.faceColor);
        this.ctx.requestRender();
      }
    });
  }

  apply(sourceGroup: Object3D, plane: Plane): void {
    this.clear();

    const group = new Group();
    group.name = 'sectionCap';

    let hasSource = false;
    sourceGroup.traverseVisible((child) => {
      if (!(child instanceof Mesh)) {
        return;
      }
      if (!isSolidFaceMesh(child)) {
        return;
      }
      const geom = child.geometry;
      if (!geom) {
        return;
      }

      hasSource = true;
      for (const side of [BackSide, FrontSide] as const) {
        const stencilMesh = new Mesh(geom, this.createStencilMaterial(side, plane));
        stencilMesh.matrixAutoUpdate = false;
        stencilMesh.matrix.copy(child.matrixWorld);
        stencilMesh.renderOrder = STENCIL_RENDER_ORDER;
        stencilMesh.frustumCulled = false;
        stencilMesh.raycast = () => {};
        group.add(stencilMesh);
      }
    });

    if (!hasSource) {
      return;
    }

    const capMesh = this.createCapMesh(sourceGroup, plane);
    group.add(capMesh);

    this.ctx.scene.add(group);
    this.group = group;
  }

  clear(): void {
    if (!this.group) {
      return;
    }
    this.ctx.scene.remove(this.group);
    this.group.traverse((child) => {
      if (child instanceof Mesh) {
        const mat = child.material;
        if (Array.isArray(mat)) {
          for (const m of mat) { m.dispose(); }
        } else {
          mat.dispose();
        }
      }
    });
    if (this.capMaterial) {
      const capMesh = this.group.children.find(
        (c): c is Mesh => c instanceof Mesh && c.material === this.capMaterial,
      );
      capMesh?.geometry.dispose();
    }
    this.group = null;
    this.capMaterial = null;
  }

  dispose(): void {
    this.clear();
    this.unsubscribeTheme();
  }

  private createStencilMaterial(side: typeof BackSide | typeof FrontSide, plane: Plane): MeshBasicMaterial {
    const op = side === BackSide ? IncrementWrapStencilOp : DecrementWrapStencilOp;
    return new MeshBasicMaterial({
      side,
      clippingPlanes: [plane],
      colorWrite: false,
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilFunc: AlwaysStencilFunc,
      stencilRef: 0,
      stencilFail: op,
      stencilZFail: op,
      stencilZPass: op,
    });
  }

  private createCapMesh(sourceGroup: Object3D, plane: Plane): Mesh {
    const size = this.computeCapSize(sourceGroup);
    const geometry = new PlaneGeometry(size, size);

    const material = new MeshPhongMaterial({
      color: themeColors.faceColor.clone(),
      side: DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: NotEqualStencilFunc,
      stencilFail: ReplaceStencilOp,
      stencilZFail: ReplaceStencilOp,
      stencilZPass: ReplaceStencilOp,
    });
    this.capMaterial = material;

    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = CAP_RENDER_ORDER;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};

    const center = plane.normal.clone().multiplyScalar(-plane.constant + CAP_DEPTH_OFFSET);
    const orientation = new Quaternion().setFromUnitVectors(Z_AXIS, plane.normal);
    mesh.position.copy(center);
    mesh.quaternion.copy(orientation);

    mesh.onAfterRender = (renderer) => {
      renderer.clear(false, false, true);
    };

    return mesh;
  }

  private computeCapSize(sourceGroup: Object3D): number {
    const box = new Box3().setFromObject(sourceGroup);
    if (box.isEmpty()) {
      return FALLBACK_CAP_SIZE;
    }
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = sphere.radius;
    if (!Number.isFinite(radius) || radius <= 0) {
      return FALLBACK_CAP_SIZE;
    }
    return radius * 4;
  }
}
