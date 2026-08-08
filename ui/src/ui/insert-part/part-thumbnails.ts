import {
  ACESFilmicToneMapping,
  DirectionalLight,
  AmbientLight,
  Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { buildObjectMesh } from '../../meshes/mesh-factory';
import { computeSceneBounds, eyeTargetForNamedView } from '../../screenshot-view';
import { FIT_PADDING } from '../../scene/scene-context';
import type { SceneObjectRender } from '../../types';

const THUMB_SIZE = 160;
const CAMERA_FOV = 35;

/**
 * Renders catalog parts to small PNG data-URLs for the Insert dialog.
 *
 * One shared offscreen `WebGLRenderer` serves every thumbnail — browsers cap
 * live WebGL contexts at around a dozen, so a renderer per tile would evict
 * the viewer's own context. Each part is built into a private `Scene` with
 * the ordinary mesh factory (the same call the assembly view uses for
 * instance groups), framed from the standard iso direction, rendered, and
 * read back synchronously. Call `dispose()` when the dialog closes to free
 * the GL context; the next render lazily recreates it.
 */
export class PartThumbnailRenderer {
  private renderer: WebGLRenderer | null = null;

  render(objects: SceneObjectRender[], rootId: string): string | null {
    const root = objects.find(o => o.id === rootId);
    if (!root) {
      return null;
    }

    const renderer = this.ensureRenderer();
    const scene = new Scene();
    scene.add(new AmbientLight(0xddeeff, 2.5));

    const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 1e7);
    camera.up.set(0, 0, 1);

    const group = buildObjectMesh(root, objects, null, camera, false);
    hideConnectors(group);
    scene.add(group);
    scene.updateMatrixWorld(true);

    const box = computeSceneBounds(group);
    if (box.isEmpty()) {
      scene.remove(group);
      disposeMaterials(group);
      return null;
    }

    const center = box.getCenter(new Vector3());
    const diameter = box.getSize(new Vector3()).length() * FIT_PADDING;
    const halfFov = (CAMERA_FOV * Math.PI) / 360;
    const distance = Math.max(diameter / 2 / Math.sin(halfFov), 1);
    const { eye, target } = eyeTargetForNamedView('iso-ftr', center, distance);

    camera.position.copy(eye);
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance + diameter * 4;
    camera.lookAt(target);
    camera.updateProjectionMatrix();

    const light = new DirectionalLight(0xffffff, 1);
    light.position.copy(eye);
    light.target.position.copy(center);
    scene.add(light);
    scene.add(light.target);

    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');

    scene.remove(group);
    // Materials are fresh per buildObjectMesh call (the assembly controller
    // disposes them the same way); geometry GPU buffers are reclaimed when
    // dispose() drops the shared context on dialog close.
    disposeMaterials(group);
    return dataUrl;
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }

  private ensureRenderer(): WebGLRenderer {
    if (!this.renderer) {
      this.renderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      this.renderer.setSize(THUMB_SIZE, THUMB_SIZE);
      this.renderer.setPixelRatio(1);
      this.renderer.toneMapping = ACESFilmicToneMapping;
      this.renderer.outputColorSpace = SRGBColorSpace;
    }
    return this.renderer;
  }
}

function hideConnectors(root: Object3D): void {
  root.traverse(child => {
    if (child.userData?.isConnector) {
      child.visible = false;
    }
  });
}

function disposeMaterials(root: Object3D): void {
  root.traverse(child => {
    const mat = (child as any).material;
    if (!mat) {
      return;
    }
    if (Array.isArray(mat)) {
      for (const m of mat) {
        m.dispose?.();
      }
    } else {
      mat.dispose?.();
    }
  });
}
