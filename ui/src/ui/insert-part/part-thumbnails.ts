import {
  ACESFilmicToneMapping,
  DirectionalLight,
  AmbientLight,
  Group,
  Object3D,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { SceneIndex } from '../../helpers/scene-index';
import { buildObjectMesh, buildSceneMesh } from '../../meshes/mesh-factory';
import { disposeEnvironmentOf, environmentFor } from '../../meshes/appearance/environment';
import { computeSceneBounds, eyeTargetForNamedView } from '../../screenshot-view';
import { FIT_PADDING } from '../../scene/scene-context';
import { AssemblySolverModel, Solver } from '../../../../lib/assembly-solver/index.js';
import { PartMateGeometryReader } from '../../scene/part-mate-geometry';
import type {
  SceneObjectRender,
  SerializedAssemblyInstance,
  SerializedAssemblyConnector,
  SerializedAssemblyMate,
} from '../../types';

const THUMB_SIZE = 160;
const CAMERA_FOV = 35;

/**
 * Renders catalog entries to small PNG data-URLs for the Insert dialog.
 *
 * One shared offscreen `WebGLRenderer` serves every thumbnail — browsers cap
 * live WebGL contexts at around a dozen, so a renderer per tile would evict
 * the viewer's own context. Each entry is built into a private `Scene` with
 * the ordinary mesh factory (the same call the assembly view uses for
 * instance groups), framed from the standard iso direction, rendered, and
 * read back synchronously. Call `dispose()` when the dialog closes to free
 * the GL context; the next render lazily recreates it.
 */
export class PartThumbnailRenderer {
  private renderer: WebGLRenderer | null = null;
  private solver = new Solver();

  /** A single part: its rendered subtree, camera-framed. */
  render(objects: SceneObjectRender[], rootId: string): string | null {
    const root = SceneIndex.of(objects).byId(rootId);
    if (!root) {
      return null;
    }
    const camera = this.makeCamera();
    const group = buildObjectMesh(root, objects, null, camera, false);
    return this.renderGroup(group, camera);
  }

  /**
   * A whole model: every root row of a rendered scene with what is under
   * it — a file's parts, or the bare statements of a model without one (a
   * scratch build's rows).
   */
  renderScene(objects: SceneObjectRender[]): string | null {
    const camera = this.makeCamera();
    return this.renderGroup(buildSceneMesh(objects, null, camera), camera);
  }

  /**
   * A sub-assembly: one group per instance (same part-template building the
   * assembly view uses), posed at its warm-start transform, then refined by
   * the mate solver so the thumbnail shows the assembled arrangement rather
   * than every instance piled at its authored offset.
   */
  renderAssembly(
    objects: SceneObjectRender[],
    instances: SerializedAssemblyInstance[],
    mates: SerializedAssemblyMate[],
    connectors: SerializedAssemblyConnector[] = [],
  ): string | null {
    const templates = new Map<string, SceneObjectRender>();
    for (const obj of objects) {
      if (obj.type === 'part' && obj.id) {
        templates.set(obj.id, obj);
      }
    }

    const camera = this.makeCamera();
    const container = new Group();
    const groups = new Map<string, Group>();
    for (const inst of instances) {
      const template = templates.get(inst.partId);
      if (!template) {
        continue;
      }
      const group = new Group();
      group.position.set(inst.position.x, inst.position.y, inst.position.z);
      group.quaternion.set(inst.quaternion.x, inst.quaternion.y, inst.quaternion.z, inst.quaternion.w);
      group.add(buildObjectMesh(template, objects, null, camera, false));
      container.add(group);
      groups.set(inst.instanceId, group);
    }
    if (groups.size === 0) {
      return null;
    }

    // Best-effort: a solve that fails (or an over-free assembly) keeps the
    // warm-start poses, which the source authored to be roughly right.
    try {
      const model = new AssemblySolverModel({
        instances,
        mates,
        connectors,
        partGeometry: partId => PartMateGeometryReader.of(objects, partId),
      });
      // Only the instances that drew a group are solved — the same set the
      // assembly view solves.
      const out = this.solver.solve(model.input({
        poseOf: instanceId => groups.get(instanceId) ?? null,
      }));
      if (out.result === 'okay') {
        for (const solved of out.bodies) {
          const group = groups.get(solved.instanceId);
          if (group) {
            group.position.copy(solved.position);
            group.quaternion.copy(solved.quaternion);
          }
        }
      }
    } catch {
      // Keep warm-start poses.
    }

    return this.renderGroup(container, camera);
  }

  dispose(): void {
    if (this.renderer) {
      disposeEnvironmentOf(this.renderer);
      this.renderer.dispose();
    }
    this.renderer = null;
  }

  /** Shared tail: frame the group, light it, render, read back, clean up. */
  private renderGroup(group: Object3D, camera: PerspectiveCamera): string | null {
    const renderer = this.ensureRenderer();
    const scene = new Scene();
    scene.add(new AmbientLight(0xddeeff, 2.5));
    // An appearance part's thumbnail reflects the same studio the viewport does.
    scene.environment = environmentFor(renderer);

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

  private makeCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 1e7);
    camera.up.set(0, 0, 1);
    return camera;
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
