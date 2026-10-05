import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshPhongMaterial, Object3D } from 'three';
import { fetchInterference, type InterferencePairData, type InterferenceRequestBody, type MeasurePose } from '../../api';
import type { SceneObjectMesh } from '../../types';

/** What the overlay reads off the assembly workbench: live instance poses. */
export type InterferenceOverlayHooks = {
  /** The instance ids the scene shows, or an empty list in a part file. */
  instanceIds: () => string[];
  /** An instance's live world pose (the browser-side solver's), or null for the statement pose. */
  poseOf: (instanceId: string) => MeasurePose | null;
};

/**
 * The interference overlay of a section view: the volume every pair of
 * bodies shares (the engine's SceneInterference, geometry included), drawn
 * as red solids inside the geometry root so the section caps them like any
 * body — the red cap is where the parts collide. The bodies themselves are
 * buried inside the parts they belong to, so nothing red shows until a cut
 * opens them.
 *
 * `refresh` asks the engine again (a render, a moved instance); `attach`
 * rebuilds the meshes under whatever root the viewer holds now, from the
 * last answer. The overlay never takes a pick: its meshes do not raycast.
 */
export class InterferenceOverlay {
  static readonly GROUP_NAME = 'sectionInterference';
  static readonly COLOR = 0xd0191e;

  private group: Group | null = null;
  private pairs: InterferencePairData[] = [];
  private inflight: AbortController | null = null;
  private generation = 0;

  constructor(private readonly hooks: InterferenceOverlayHooks) {}

  /** The pairs of the last answer (clashes and intra-part overlaps alike). */
  get currentPairs(): readonly InterferencePairData[] {
    return this.pairs;
  }

  /**
   * Re-run the check and rebuild under `root`. Resolves true when the
   * overlay changed (new geometry landed, or the previous one was dropped),
   * false when a newer refresh superseded this one or nothing changed.
   */
  async refresh(root: Object3D | null): Promise<boolean> {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    const generation = ++this.generation;
    const body: InterferenceRequestBody = { includeGeometry: true };
    const poses = this.hooks.instanceIds().flatMap((instanceId) => {
      const pose = this.hooks.poseOf(instanceId);
      return pose ? [{ instanceId, position: pose.position, quaternion: pose.quaternion }] : [];
    });
    if (poses.length > 0) {
      body.poses = poses;
    }
    const report = await fetchInterference(body, controller.signal).catch(() => null);
    if (generation !== this.generation) {
      return false;
    }
    this.inflight = null;
    const next = report ? [...report.clashes, ...report.intraPart].filter(p => p.meshes && p.meshes.length > 0) : [];
    const changed = next.length > 0 || this.pairs.length > 0;
    this.pairs = next;
    this.attach(root);
    return changed;
  }

  /** (Re)build the red bodies under `root` from the last answer; null clears. */
  attach(root: Object3D | null): void {
    this.detach();
    if (!root || this.pairs.length === 0) {
      return;
    }
    const group = new Group();
    group.name = InterferenceOverlay.GROUP_NAME;
    group.userData.isInterferenceOverlay = true;
    // The meshes are in world space whatever the root's own transform.
    group.matrixAutoUpdate = false;
    root.updateMatrixWorld(true);
    group.matrix.copy(root.matrixWorld).invert();
    group.matrixWorldNeedsUpdate = true;
    for (const pair of this.pairs) {
      const body = new Group();
      body.name = `interference:${pair.a.shapeId}:${pair.b.shapeId}`;
      body.userData.isSolid = true;
      body.userData.isInterferenceOverlay = true;
      body.userData.sectionCapColor = new Color(InterferenceOverlay.COLOR);
      for (const data of pair.meshes ?? []) {
        if (data.label === 'solid-edges' || data.vertices.length === 0) {
          continue;
        }
        const mesh = InterferenceOverlay.buildMesh(data);
        body.add(mesh);
      }
      group.add(body);
    }
    root.add(group);
    group.updateMatrixWorld(true);
    this.group = group;
  }

  /** Forget the last answer and remove the bodies. */
  clear(): void {
    this.inflight?.abort();
    this.inflight = null;
    this.generation++;
    this.pairs = [];
    this.detach();
  }

  private detach(): void {
    if (!this.group) {
      return;
    }
    this.group.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        (mesh.material as MeshPhongMaterial).dispose();
      }
    });
    this.group.removeFromParent();
    this.group = null;
  }

  private static buildMesh(data: SceneObjectMesh): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(data.vertices), 3));
    if (data.normals.length === data.vertices.length) {
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(data.normals), 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (data.indices.length > 0) {
      geometry.setIndex(new BufferAttribute(new Uint32Array(data.indices), 1));
    }
    geometry.computeBoundingSphere();
    const material = new MeshPhongMaterial({
      color: InterferenceOverlay.COLOR,
      shininess: 10,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = 1;
    mesh.userData.isInterferenceOverlay = true;
    // Never a pick target: the bodies it lies in own the clicks.
    mesh.raycast = () => {};
    return mesh;
  }
}
