import { Group, Matrix4, type Object3D, Vector2, type Vector3, Vector4 } from 'three';
import type { SceneContext } from '../scene/scene-context';
import type { SelectedEntity } from '../viewer';
import type { SubSelection } from '../types';
import { entityKey } from '../helpers/entities';
import { addFrameHook } from '../meshes/frame-hooks';
import { onThemeChange, themeColors } from '../scene/theme-colors';
import { worldFromMm } from '../units/scene-scale';
import { collectVertexSources, expandVertexSource, type VertexCandidate, type VertexSource } from './pick-candidates';
import { viewerSettings } from '../scene/viewer-settings';
import { OccluderDepthMap, type PointOcclusion } from './occluder-depth';
import { VertexDots, type VertexDot } from './vertex-dots';

/** The live pick radius, screen px — the `pickRadiusPx` preference. */
export function vertexPickPx(): number {
  return viewerSettings.current.pickRadiusPx;
}
type VertexEntity = SelectedEntity & { sub: Extract<SubSelection, { type: 'vertex' }> };
/** Coincident vertices (edge endpoints, shared corners) drawn and picked as one dot. */
type PointGroup = { position: Vector3; members: VertexCandidate[]; keys: string[] };
type MarkerState = 'candidate' | 'hover' | 'selected';

/** Dot radius per state, CSS pixels. */
const RADIUS_PX: Record<MarkerState, number> = { candidate: 2.5, hover: 4.5, selected: 3.5 };
/** Selected dots draw over candidates, the hovered one over both. */
const DRAW_ORDER: Record<MarkerState, number> = { candidate: 0, selected: 1, hover: 2 };

/** Restrict a shape to explicit topology vertices; an omitted list includes all. */
export type VertexPickScope = string | { shapeId: string; indices: readonly number[] };

/**
 * Opt-in vertex channel: the candidate dots and the vertex picks, over the
 * viewer's topology vertices.
 *
 * Nothing here costs per vertex per frame. The candidates are collected and
 * merged only when a shape, its placement, its clipping or the scope
 * changes; the dots are one instanced draw whose shader hides a dot an
 * occluder covers, against a depth map of the faces redrawn only when the
 * camera or a face moves ({@link PointOcclusion}); and a pick projects the
 * candidates once and asks the same map about the few under the cursor, so
 * a dot is pickable exactly when it is drawn.
 */
export class VertexPicking {
  private active = false;
  private scope: ReadonlySet<string> | null = null;
  private indices = new Map<string, Set<number> | null>();
  private scopeVersion = 0;
  private selected = new Set<string>();
  private emphasized: Set<string> | null = null;
  private hovered: string | null = null;
  private readonly group = new Group();
  private readonly dots = new VertexDots();
  private readonly occlusion: PointOcclusion;
  private readonly removeFrameHook: () => void;
  private readonly removeThemeListener: () => void;
  /** The merged candidates and what they were built from; rebuilt only when that changes. */
  private cache: { signature: unknown[]; groups: PointGroup[] } | null = null;
  /** The dots no longer match the groups or their states. */
  private displayDirty = true;
  private sketchDots = new Map<Object3D, boolean>();
  private readonly drawingBuffer = new Vector2();

  constructor(
    private readonly ctx: Pick<SceneContext, 'scene' | 'camera' | 'renderer' | 'requestRender'>,
    private readonly extraOccluders: () => Object3D[] = () => [],
    occlusion?: PointOcclusion,
  ) {
    this.occlusion = occlusion ?? new OccluderDepthMap(ctx);
    this.group.userData.isMetaShape = true;
    this.group.name = 'vertex-pick-dots';
    this.group.add(this.dots);
    ctx.scene.add(this.group);
    this.removeFrameHook = addFrameHook(renderer => {
      if (renderer === this.ctx.renderer) {
        this.refresh();
      }
    });
    this.removeThemeListener = onThemeChange(() => {
      this.displayDirty = true;
      this.ctx.requestRender();
    });
  }

  setActive(active: boolean): void {
    this.active = active;
    this.hovered = null;
    this.displayDirty = true;
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
    this.scopeVersion++;
    this.hovered = null;
    this.ctx.requestRender();
  }

  /** null uses the ordinary selected tint; a list dims the other selected dots. */
  setEmphasized(entities: SelectedEntity[] | null): void {
    this.emphasized = entities === null ? null : new Set(entities.map(entityKey));
    this.displayDirty = true;
    this.ctx.requestRender();
  }

  setSelected(entities: SelectedEntity[]): void {
    this.selected = new Set(entities.filter(entity => entity.sub.type === 'vertex').map(entityKey));
    this.displayDirty = true;
    this.ctx.requestRender();
  }

  setHover(entity: SelectedEntity | null): void {
    this.hovered = entity?.sub.type === 'vertex' ? entityKey(entity) : null;
    this.displayDirty = true;
    this.ctx.requestRender();
  }

  /**
   * The visible dot nearest the cursor within the pick radius (the nearer to
   * the camera on a tie), or null. Projects every candidate once, then asks
   * the occlusion about only the ones under the cursor.
   */
  pick(clientX: number, clientY: number): VertexEntity | null {
    if (!this.active) {
      return null;
    }
    const { groups, occluders } = this.scan();
    const camera = this.ctx.camera;
    camera.updateMatrixWorld();
    const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const radius = vertexPickPx() ** 2;
    const near: { group: PointGroup; distance: number; depth: number }[] = [];
    const clip = new Vector4();
    for (const group of groups) {
      clip.set(group.position.x, group.position.y, group.position.z, 1).applyMatrix4(viewProjection);
      if (!(clip.w > 0)) {
        continue;
      }
      const x = clip.x / clip.w;
      const y = clip.y / clip.w;
      const z = clip.z / clip.w;
      if (!Number.isFinite(x + y + z) || Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) {
        continue;
      }
      const distance = (rect.left + (x + 1) * rect.width / 2 - clientX) ** 2
        + (rect.top + (1 - y) * rect.height / 2 - clientY) ** 2;
      if (distance < radius) {
        near.push({ group, distance, depth: z });
      }
    }
    if (near.length === 0) {
      return null;
    }
    near.sort((a, b) => a.distance - b.distance || a.depth - b.depth);
    const visible = this.occlusion.visible(near.map(({ group }) => group.position), occluders);
    const best = near.find((_, i) => visible[i]);
    return best ? VertexPicking.vertexEntity(best.group.members[0], best.group.members) : null;
  }

  /** Before each frame: the dots' states when they changed, and the occlusion map for this camera. */
  refresh(): void {
    if (!this.active && this.selected.size === 0) {
      this.syncSketchDots();
      if (this.dots.drawn.length > 0) {
        this.dots.setDots([]);
      }
      this.occlusion.release();
      this.displayDirty = true;
      return;
    }
    const { groups, occluders, sketchDots } = this.scan();
    this.syncSketchDots(sketchDots);
    if (this.displayDirty) {
      this.dots.setDots(this.dotsFor(groups));
      this.displayDirty = false;
    }
    this.dots.setOcclusion(this.dots.drawn.length > 0 ? this.occlusion.update(occluders) : null);
    const renderer = this.ctx.renderer;
    renderer.getDrawingBufferSize(this.drawingBuffer);
    this.dots.setViewport(this.drawingBuffer, renderer.getPixelRatio());
  }

  /** The dots to draw: every candidate while armed, else only the selected ones; hovered and selected on top. */
  private dotsFor(groups: PointGroup[]): VertexDot[] {
    const drawn: (VertexDot & { order: number })[] = [];
    for (const group of groups) {
      const selected = group.keys.some(key => this.selected.has(key));
      if (!this.active && !selected) {
        continue;
      }
      const state: MarkerState = selected ? 'selected'
        : this.hovered !== null && group.keys.includes(this.hovered) ? 'hover' : 'candidate';
      drawn.push({
        position: group.position,
        color: state === 'selected' ? themeColors.vertexSelectedColor
          : state === 'hover' ? themeColors.vertexHoverColor : themeColors.vertexColor,
        opacity: selected && this.emphasized !== null && !group.keys.some(key => this.emphasized!.has(key)) ? 0.6 : 1,
        radiusPx: RADIUS_PX[state],
        order: DRAW_ORDER[state],
      });
    }
    // A stable sort: candidates keep their order, the few highlighted dots move last.
    return drawn.sort((a, b) => a.order - b.order);
  }

  /**
   * The merged candidates and the faces that occlude them. The scene walk
   * is per object, never per vertex; the vertices are expanded and merged
   * only when a source, its placement, its clipping or the scope changed.
   */
  private scan(): { groups: PointGroup[]; occluders: Object3D[]; sketchDots: Object3D[] } {
    // Only what moved: the renderer does the same before drawing, so this is the scene it draws.
    this.ctx.scene.updateMatrixWorld();
    const sketchDots: Object3D[] = [];
    const { faces, sources } = collectVertexSources(this.ctx.scene, this.scope, obj => {
      if (obj.userData.isVertexDot) {
        sketchDots.push(obj);
      }
    });
    const occluders: Object3D[] = [...faces, ...this.extraOccluders()];
    const signature = this.signatureOf(sources);
    if (!this.cache || !VertexPicking.sameValues(this.cache.signature, signature)) {
      this.cache = { signature, groups: this.mergeCandidates(sources) };
      this.displayDirty = true;
    }
    return { groups: this.cache.groups, occluders, sketchDots };
  }

  /** Everything the candidates depend on, compared by identity and value. */
  private signatureOf(sources: VertexSource[]): unknown[] {
    const out: unknown[] = [this.scopeVersion];
    for (const source of sources) {
      out.push(source.object, source.coordinates, source.instanceId, ...source.object.matrixWorld.elements);
      for (const material of source.materials) {
        out.push(material, material.clipIntersection);
        for (const plane of material.clippingPlanes ?? []) {
          out.push(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
        }
      }
    }
    return out;
  }

  /** The candidates in scope, coincident ones merged into one group. */
  private mergeCandidates(sources: VertexSource[]): PointGroup[] {
    const candidates: VertexCandidate[] = [];
    for (const source of sources) {
      expandVertexSource(source, candidates);
    }
    const buckets = new Map<string, PointGroup[]>();
    const groups: PointGroup[] = [];
    const tolerance = worldFromMm(1e-6);
    for (const candidate of candidates) {
      const indices = this.indices.get(candidate.shapeId);
      if (indices && !indices.has(candidate.index)) {
        continue;
      }
      const point = candidate.position;
      const key = entityKey(VertexPicking.vertexEntity(candidate, []));
      const cell = [point.x, point.y, point.z].map(value => Math.floor(value / tolerance));
      const group = VertexPicking.coincidentGroup(buckets, cell, point, tolerance);
      if (group) {
        group.members.push(candidate);
        group.keys.push(key);
        continue;
      }
      const added = { position: point, members: [candidate], keys: [key] };
      const cellKey = cell.join(':');
      const bucket = buckets.get(cellKey) ?? [];
      bucket.push(added);
      buckets.set(cellKey, bucket);
      groups.push(added);
    }
    return groups;
  }

  private static sameValues(a: unknown[], b: unknown[]): boolean {
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

  /**
   * The topology channel owns point states while armed; hide the sketch's
   * larger endpoint dots. `shown` is the endpoint dots a walk of the visible
   * scene just passed: those, and the ones already hidden while they stay in
   * the scene, are the armed set. Without it, the whole scene is walked.
   */
  private syncSketchDots(shown?: readonly Object3D[]): void {
    const found = new Set<Object3D>();
    if (this.active) {
      if (shown) {
        shown.forEach(node => found.add(node));
        for (const node of this.sketchDots.keys()) {
          if (VertexPicking.inScene(node, this.ctx.scene)) {
            found.add(node);
          }
        }
      } else {
        this.ctx.scene.traverse(node => {
          if (node.userData.isVertexDot) {
            found.add(node);
          }
        });
      }
      for (const node of found) {
        if (!this.sketchDots.has(node)) {
          this.sketchDots.set(node, node.visible);
        }
        node.visible = false;
      }
    }
    for (const [node, visible] of this.sketchDots) {
      if (!found.has(node)) {
        node.visible = visible;
        this.sketchDots.delete(node);
      }
    }
  }

  private static inScene(node: Object3D, scene: Object3D): boolean {
    let current: Object3D | null = node;
    while (current && current !== scene) {
      current = current.parent;
    }
    return current === scene;
  }

  /** The dots drawn now, in draw order — for tests and probes. */
  get drawnDots(): readonly VertexDot[] {
    return this.dots.drawn;
  }

  dispose(): void {
    this.active = false;
    this.syncSketchDots();
    this.removeFrameHook();
    this.removeThemeListener();
    this.occlusion.dispose();
    this.dots.dispose();
    this.group.removeFromParent();
  }
}

