import { type BufferAttribute, type BufferGeometry, type InterleavedBufferAttribute, Group, type Material, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import type { SceneContext } from '../scene/scene-context';
import type { SelectedEntity } from '../viewer';
import type { SubSelection } from '../types';
import { entityKey } from '../helpers/entities';
import { addFrameHook } from '../meshes/frame-hooks';
import { createPointMarker } from '../meshes/point-marker';
import { onThemeChange, themeColors } from '../scene/theme-colors';
import { worldFromMm } from '../units/scene-scale';
import { collectPickCandidates, type VertexCandidate } from './pick-candidates';
import { viewerSettings } from '../scene/viewer-settings';

/** Same grab radius as solved sketch vertices. */
/** The live pick radius, screen px — the `pickRadiusPx` preference. */
export function vertexPickPx(): number {
  return viewerSettings.current.pickRadiusPx;
}
type VertexEntity = SelectedEntity & { sub: Extract<SubSelection, { type: 'vertex' }> };
type PointGroup = { position: Vector3; members: VertexCandidate[] };
type MarkerState = 'candidate' | 'hover' | 'selected';

/** Restrict a shape to explicit topology vertices; an omitted list includes all. */
export type VertexPickScope = string | { shapeId: string; indices: readonly number[] };

/**
 * Everything the visibility of the candidate dots depends on. While two
 * snapshots are equal the previous answer still holds, so a pointer move (a
 * pick, then the hover repaint) and a repaint with nothing changed cost one
 * linear comparison instead of a sight-line raycast per vertex.
 */
type VisibilitySnapshot = {
  camera: number[];
  scope: ReadonlySet<string> | null;
  vertices: VertexCandidate[];
  occluders: OccluderState[];
};
type OccluderState = {
  object: Object3D;
  geometry: BufferGeometry | null;
  positionVersion: number;
  indexVersion: number;
  matrix: number[];
  clipping: number[];
};

/** Opt-in vertex channel, using the viewer's candidates, visibility test and markers. */
export class VertexPicking {
  private active = false;
  private scope: ReadonlySet<string> | null = null;
  private indices = new Map<string, Set<number> | null>();
  private selected = new Set<string>();
  private emphasized: Set<string> | null = null;
  private hovered: string | null = null;
  private readonly group = new Group();
  private readonly markers = new Map<string, { group: Group; state: MarkerState }>();
  private readonly removeFrameHook: () => void;
  private readonly removeThemeListener: () => void;
  private cache: { snapshot: VisibilitySnapshot; groups: PointGroup[] } | null = null;
  private sketchDots = new Map<Object3D, boolean>();

  constructor(
    private readonly ctx: Pick<SceneContext, 'scene' | 'camera' | 'renderer' | 'requestRender'>,
    private readonly isVisible: (point: Vector3, occluders: Object3D[]) => boolean,
    private readonly extraOccluders: () => Object3D[] = () => [],
  ) {
    this.group.userData.isMetaShape = true;
    this.group.name = 'vertex-pick-dots';
    ctx.scene.add(this.group);
    this.removeFrameHook = addFrameHook(renderer => {
      if (renderer === this.ctx.renderer) {
        this.refresh();
      }
    });
    this.removeThemeListener = onThemeChange(() => this.ctx.requestRender());
  }

  setActive(active: boolean): void {
    this.active = active;
    this.hovered = null;
    this.syncSketchDots();
    this.ctx.requestRender();
  }

  setScope(shapes: readonly VertexPickScope[] | null): void {
    this.indices = new Map();
    for (const shape of shapes ?? []) {
      const id = typeof shape === 'string' ? shape : shape.shapeId;
      const previous = this.indices.get(id);
      if (typeof shape === 'string') {
        this.indices.set(id, null);
      } else if (previous !== null) {
        const indices = previous ?? new Set<number>();
        for (const index of shape.indices) {
          indices.add(index);
        }
        this.indices.set(id, indices);
      }
    }
    this.scope = shapes === null ? null : new Set(this.indices.keys());
    this.hovered = null;
    this.ctx.requestRender();
  }

  /** null uses the ordinary selected tint; a list dims the other selected dots. */
  setEmphasized(entities: SelectedEntity[] | null): void {
    this.emphasized = entities === null ? null : new Set(entities.map(entityKey));
    this.ctx.requestRender();
  }

  setSelected(entities: SelectedEntity[]): void {
    this.selected = new Set(entities.filter(entity => entity.sub.type === 'vertex').map(entityKey));
    this.ctx.requestRender();
  }

  setHover(entity: SelectedEntity | null): void {
    this.hovered = entity?.sub.type === 'vertex' ? entityKey(entity) : null;
    this.ctx.requestRender();
  }

  pick(clientX: number, clientY: number): VertexEntity | null {
    if (!this.active) {
      return null;
    }
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    let best: PointGroup | null = null;
    let bestDistance = vertexPickPx() ** 2;
    let bestDepth = Infinity;
    for (const group of this.visibleGroups()) {
      const projected = group.position.clone().project(this.ctx.camera);
      const x = rect.left + (projected.x + 1) * rect.width / 2;
      const y = rect.top + (1 - projected.y) * rect.height / 2;
      const distance = (x - clientX) ** 2 + (y - clientY) ** 2;
      if (distance < bestDistance || (distance === bestDistance && projected.z < bestDepth)) {
        best = group;
        bestDistance = distance;
        bestDepth = projected.z;
      }
    }
    return best ? VertexPicking.vertexEntity(best.members[0], best.members) : null;
  }

  /** The frame hook and picks use this same visibility decision. No depth offsets. */
  private visibleGroups(): PointGroup[] {
    this.ctx.scene.updateMatrixWorld(true);
    const candidates = collectPickCandidates(this.ctx.scene, {
      sketchWires: false, profileWires: false, axes: false, planes: false,
      vertices: true, vertexScope: this.scope,
    });
    const occluders = [...candidates.faces, ...this.extraOccluders()];
    candidates.vertices = candidates.vertices.filter(candidate => {
      const indices = this.indices.get(candidate.shapeId);
      return !indices || indices.has(candidate.index);
    });

    const snapshot = this.snapshot(candidates.vertices, occluders);
    if (this.cache && VertexPicking.sameSnapshot(this.cache.snapshot, snapshot)) {
      return this.cache.groups;
    }

    const buckets = new Map<string, PointGroup[]>();
    const groups: PointGroup[] = [];
    const tolerance = worldFromMm(1e-6);
    for (const candidate of candidates.vertices) {
      const point = candidate.position;
      const ndc = point.clone().project(this.ctx.camera);
      if (!Number.isFinite(ndc.x + ndc.y + ndc.z)
        || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || Math.abs(ndc.z) > 1) {
        continue;
      }
      const cell = [point.x, point.y, point.z].map(value => Math.floor(value / tolerance));
      const group = VertexPicking.coincidentGroup(buckets, cell, point, tolerance);
      if (group) {
        group.members.push(candidate);
      } else if (this.isVisible(point, occluders)) {
        const added = { position: point, members: [candidate] };
        const key = cell.join(':');
        const bucket = buckets.get(key) ?? [];
        bucket.push(added);
        buckets.set(key, bucket);
        groups.push(added);
      }
    }
    this.cache = { snapshot, groups };
    return groups;
  }

  private snapshot(vertices: VertexCandidate[], occluders: Object3D[]): VisibilitySnapshot {
    const camera = this.ctx.camera;
    return {
      camera: [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements],
      scope: this.scope,
      vertices,
      occluders: occluders.map(object => VertexPicking.occluderState(object)),
    };
  }

  private static occluderState(object: Object3D): OccluderState {
    const mesh = object as Mesh;
    const geometry = mesh.geometry ?? null;
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    const clipping: number[] = [];
    for (const material of materials) {
      clipping.push(material.clipIntersection ? 1 : 0);
      for (const plane of material.clippingPlanes ?? []) {
        clipping.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
      }
    }
    return {
      object,
      geometry,
      positionVersion: VertexPicking.attributeVersion(geometry?.attributes.position),
      indexVersion: geometry?.index?.version ?? 0,
      matrix: [...object.matrixWorld.elements],
      clipping,
    };
  }

  private static attributeVersion(attribute: BufferAttribute | InterleavedBufferAttribute | undefined): number {
    if (!attribute) {
      return 0;
    }
    return 'data' in attribute ? attribute.data.version : attribute.version;
  }

  private static sameSnapshot(a: VisibilitySnapshot, b: VisibilitySnapshot): boolean {
    if (a.scope !== b.scope
      || a.vertices.length !== b.vertices.length
      || a.occluders.length !== b.occluders.length
      || !VertexPicking.sameNumbers(a.camera, b.camera)) {
      return false;
    }
    for (let i = 0; i < a.vertices.length; i++) {
      const p = a.vertices[i];
      const q = b.vertices[i];
      if (p.shapeId !== q.shapeId || p.index !== q.index || p.instanceId !== q.instanceId
        || !p.position.equals(q.position)) {
        return false;
      }
    }
    for (let i = 0; i < a.occluders.length; i++) {
      const p = a.occluders[i];
      const q = b.occluders[i];
      if (p.object !== q.object || p.geometry !== q.geometry
        || p.positionVersion !== q.positionVersion || p.indexVersion !== q.indexVersion
        || !VertexPicking.sameNumbers(p.matrix, q.matrix)
        || !VertexPicking.sameNumbers(p.clipping, q.clipping)) {
        return false;
      }
    }
    return true;
  }

  private static sameNumbers(a: number[], b: number[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  private static coincidentGroup(
    buckets: Map<string, PointGroup[]>, cell: number[], point: Vector3, tolerance: number,
  ): PointGroup | undefined {
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const key = `${cell[0] + x}:${cell[1] + y}:${cell[2] + z}`;
          const found = buckets.get(key)?.find(group => group.position.distanceToSquared(point) <= tolerance * tolerance);
          if (found) {
            return found;
          }
        }
      }
    }
    return undefined;
  }

  private static vertexEntity(candidate: VertexCandidate, members: VertexCandidate[]): VertexEntity {
    const alternates = members.filter(member => member !== candidate).map(member => ({
      shapeId: member.shapeId, index: member.index, instanceId: member.instanceId,
    }));
    return {
      shapeId: candidate.shapeId, instanceId: candidate.instanceId,
      sub: {
        type: 'vertex', index: candidate.index,
        position: { x: candidate.position.x, y: candidate.position.y, z: candidate.position.z },
        ...(alternates.length > 0 ? { alternates } : {}),
      },
    };
  }

  refresh(): void {
    this.syncSketchDots();
    const keep = new Set<string>();
    const groups = this.active || this.selected.size > 0 ? this.visibleGroups() : [];
    for (const points of groups) {
      const keys = points.members.map(candidate => entityKey(VertexPicking.vertexEntity(candidate, [])));
      const selected = keys.some(key => this.selected.has(key));
      if (!this.active && !selected) {
        continue;
      }
      const state: MarkerState = selected ? 'selected' : keys.includes(this.hovered) ? 'hover' : 'candidate';
      const key = keys[0];
      keep.add(key);
      let marker = this.markers.get(key);
      if (marker && marker.state !== state) {
        this.removeMarker(key);
        marker = undefined;
      }
      if (!marker) {
        const group = createPointMarker(points.position, 0xffffff, {
          pixelRadius: state === 'candidate' ? 2.5 : state === 'hover' ? 4.5 : 3.5,
        });
        group.userData.vertexState = state;
        marker = { group, state };
        this.group.add(group);
        this.markers.set(key, marker);
      }
      marker.group.position.copy(points.position);
      marker.group.quaternion.copy(this.ctx.camera.quaternion);
      const dot = marker.group.children[0] as Mesh;
      const material = dot.material as MeshBasicMaterial;
      material.transparent = true;
      material.opacity = selected && this.emphasized !== null
        && !keys.some(key => this.emphasized!.has(key)) ? 0.6 : 1;
      material.color.copy(state === 'selected' ? themeColors.vertexSelectedColor
        : state === 'hover' ? themeColors.vertexHoverColor : themeColors.vertexColor);
    }
    for (const key of [...this.markers.keys()]) {
      if (!keep.has(key)) {
        this.removeMarker(key);
      }
    }
  }

  /** The topology channel owns point states while armed; hide the sketch's larger endpoint dots. */
  private syncSketchDots(): void {
    const found = new Set<Object3D>();
    if (this.active) {
      this.ctx.scene.traverse(node => {
        if (node.userData.isVertexDot) {
          found.add(node);
          if (!this.sketchDots.has(node)) {
            this.sketchDots.set(node, node.visible);
          }
          node.visible = false;
        }
      });
    }
    for (const [node, visible] of this.sketchDots) {
      if (!found.has(node)) {
        node.visible = visible;
        this.sketchDots.delete(node);
      }
    }
  }

  private removeMarker(key: string): void {
    const marker = this.markers.get(key)!;
    marker.group.removeFromParent();
    const dot = marker.group.children[0] as Mesh;
    dot.geometry.dispose();
    (dot.material as MeshBasicMaterial).dispose();
    this.markers.delete(key);
  }

  dispose(): void {
    this.active = false;
    this.syncSketchDots();
    this.removeFrameHook();
    this.removeThemeListener();
    for (const key of [...this.markers.keys()]) {
      this.removeMarker(key);
    }
    this.group.removeFromParent();
  }
}
