import {
  Camera,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { createMetaEdgeMesh } from './shape-group';
import { isDraggableSketchObject } from '../../interactive/sketch-edge-utils';
import { buildSolvedConstraintMeshes } from './solved-constraint-meshes';
import type { SolvedGlyphLayout } from './solved-glyph-layout';
import { addFrameHook } from '../frame-hooks';
import {
  SolvedSketchModel,
  buildSolvedSketchModel,
  layoutConstraintGlyphs,
  tessellateSolvedEntity,
} from '../../sketch-solver-client';
import type { LiveEntityGeometry } from '../../sketch-solver-client';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { themeColors } from '../../scene/theme-colors';
import { viewerSettings } from '../../scene/viewer-settings';
import { applyConstantPixelSize } from '../screen-scale';

const SKETCH_EDGE_COLOR = '#2297ff';
const VERTEX_RADIUS = 2;
const VERTEX_SEGMENTS = 16;
const VERTEX_PX_RADIUS = 6;
// Non-interactive edges (text outlines, derived curves) can carry dozens of
// joints; full-size dots would drown the geometry, so keep them subtle.
const NON_INTERACTIVE_VERTEX_PX_RADIUS = 3;
const NON_INTERACTIVE_VERTEX_OPACITY = 0.6;
const META_VERTEX_COLOR = '#8899aa';
const META_VERTEX_RADIUS = 1.5;
const META_VERTEX_PX_RADIUS = 4.5;
/** Frames a glyph-layout hook waits for its mesh to reach the scene before
 * assuming it never will (a mesh built and then dropped). */
const DETACHED_GRACE_FRAMES = 300;

/**
 * Renders a sketch: child edges in blue, with solved-sketch diagnostics
 * tinting per entity — conflict red, constrained green.
 */
export class SketchMesh extends Group {
  /** Read model of a solved-mode sketch; null for legacy sketches. */
  private solvedModel: SolvedSketchModel | null;
  /** Solved entity id → its edge meshes, for live drag updates (P4). */
  private solvedEdgeMeshes = new Map<number, EdgeMesh[]>();
  /** Vertex-dot groups bound to solved entity points, for live drag moves. */
  private solvedDotBindings: { group: Group; entityId: number; role: 'point' | 'start' | 'end' | 'center' }[] = [];
  /** The current glyph groups — replaced wholesale on live updates. */
  private solvedGlyphGroups: Group[] = [];
  /** Constraint badges and dimensions belong to the sketch being edited.
   * Sketch-edit mode keeps every other sketch on screen for reference, but
   * their annotations would crowd — and be picked alongside — the active
   * sketch's own, so only the active sketch draws them. Outside sketch mode
   * (no active sketch) every visible sketch still annotates itself. */
  private readonly showConstraints: boolean;
  /** Screen-space annotation placement (P5.5); null without annotations. */
  private glyphLayout: SolvedGlyphLayout | null = null;
  private layoutHookOff: (() => void) | null = null;
  private layoutAttached = false;
  private detachedFrames = 0;

  constructor(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], activeSketchId: string | null, _camera: Camera) {
    super();
    this.userData.isSketchRoot = true;
    this.userData.sketchObjectId = sceneObject.id;
    this.showConstraints = !activeSketchId || sceneObject.id === activeSketchId;
    this.solvedModel = buildSolvedSketchModel(sceneObject, allObjects);
    this.buildEdges(sceneObject, allObjects);
    this.buildVertices(sceneObject, allObjects);
    this.bindSolvedDots();
    this.addConstraintIcons();
  }

  get solved(): SolvedSketchModel | null {
    return this.solvedModel;
  }

  /**
   * Live drag frame (P4): pull every entity's current geometry from the
   * client-side solve, mutate the read model in place, rewrite edge mesh
   * positions, move bound vertex dots, and re-layout the constraint glyphs.
   * The next real render replaces this mesh wholesale.
   */
  updateSolvedGeometry(read: (entityId: number) => LiveEntityGeometry | null): void {
    const model = this.solvedModel;
    if (!model) {
      return;
    }

    for (const [entityId, view] of model.entities) {
      const g = read(entityId);
      if (!g) {
        continue;
      }
      if (g.point) {
        view.point = g.point;
      }
      if (g.start) {
        view.start = g.start;
      }
      if (g.end) {
        view.end = g.end;
      }
      if (g.center) {
        view.center = g.center;
      }
      if (g.radius !== undefined) {
        view.radius = g.radius;
      }
    }

    for (const [entityId, meshes] of this.solvedEdgeMeshes) {
      const view = model.entities.get(entityId);
      if (!view) {
        continue;
      }
      for (const edgeMesh of meshes) {
        for (const child of edgeMesh.children) {
          if (!child.userData.isEdgeLine) {
            continue;
          }
          const line = child as LineSegments2;
          const geometry = line.geometry as LineSegmentsGeometry;
          // setPositions must keep the segment count the mesh was built
          // with — the renderer caches the instance count per geometry, so
          // a different count clips or overruns the draw.
          const segments = geometry.attributes.instanceStart?.count;
          if (!segments) {
            continue;
          }
          const points = tessellateSolvedEntity(view, segments);
          if (!points || points.length !== segments + 1) {
            continue;
          }
          const positions = new Float32Array(segments * 6);
          let offset = 0;
          let prev = localToWorld(points[0], model.plane);
          for (let i = 1; i < points.length; i++) {
            const next = localToWorld(points[i], model.plane);
            positions[offset++] = prev.x;
            positions[offset++] = prev.y;
            positions[offset++] = prev.z;
            positions[offset++] = next.x;
            positions[offset++] = next.y;
            positions[offset++] = next.z;
            prev = next;
          }
          geometry.setPositions(positions);
          geometry.computeBoundingBox();
          geometry.computeBoundingSphere();
        }
      }
    }

    for (const binding of this.solvedDotBindings) {
      const view = model.entities.get(binding.entityId);
      if (!view) {
        continue;
      }
      const at = binding.role === 'point' ? view.point
        : binding.role === 'start' ? view.start
          : binding.role === 'end' ? view.end : view.center;
      if (at) {
        // The group's own position vector is the screen-scale anchor too
        // (addVertexDots hands it to applyConstantPixelSize), so this move
        // keeps the constant-pixel sizing tracking the dot.
        binding.group.position.copy(localToWorld(at, model.plane));
      }
    }

    this.rebuildSolvedGlyphs();
  }

  /** Bind each vertex dot to the solved entity point it sits on, by world
   * position — dots are derived from tessellation and carry no identity of
   * their own. A junction dot binds to its first matching point; coincident
   * points move together during solves, so any member tracks it. */
  private bindSolvedDots(): void {
    const model = this.solvedModel;
    if (!model) {
      return;
    }
    const slots: { entityId: number; role: 'point' | 'start' | 'end' | 'center'; world: Vector3 }[] = [];
    for (const [entityId, e] of model.entities) {
      const push = (role: 'point' | 'start' | 'end' | 'center', at: [number, number] | undefined) => {
        if (at) {
          slots.push({ entityId, role, world: localToWorld(at, model.plane) });
        }
      };
      push('point', e.point);
      push('start', e.start);
      push('end', e.end);
      push('center', e.center);
    }
    const EPS_SQ = 1e-10;
    for (const child of this.children) {
      if (!child.userData.isVertexDot) {
        continue;
      }
      const slot = slots.find(s => s.world.distanceToSquared(child.position) < EPS_SQ);
      if (slot) {
        this.solvedDotBindings.push({ group: child as Group, entityId: slot.entityId, role: slot.role });
      }
    }
  }

  /** Re-derive the constraint annotations from the model and the current
   * visibility settings — the sketch dialog's dimensional/positional
   * toggles call this on the live mesh (a full render replaces it anyway). */
  refreshConstraintGlyphs(): void {
    this.rebuildSolvedGlyphs();
  }

  private rebuildSolvedGlyphs(): void {
    const model = this.solvedModel;
    if (!model || !this.showConstraints) {
      return;
    }
    this.glyphLayout?.dispose();
    for (const group of this.solvedGlyphGroups) {
      this.remove(group);
      group.traverse(child => {
        const mesh = child as Mesh;
        // Textures are shared through the badge-texture cache; material
        // disposal deliberately leaves them alive.
        (mesh.geometry as { dispose?: () => void } | undefined)?.dispose?.();
        (mesh.material as { dispose?: () => void } | undefined)?.dispose?.();
      });
    }
    // The sketch dialog's visibility toggles: dimensional constraints draw
    // as leaders/readouts/angle arcs, positional ones as badges and dots —
    // a filtered category also releases its reserved layout space.
    const { sketchShowDimensions, sketchShowPositional } = viewerSettings.current;
    const glyphs = layoutConstraintGlyphs(model).filter(glyph => {
      const dimensional = glyph.type === 'text' || glyph.type === 'leader' || glyph.type === 'angle-arc';
      return dimensional ? sketchShowDimensions : sketchShowPositional;
    });
    const { groups, hitTargets, layout } = buildSolvedConstraintMeshes(model, glyphs);
    this.solvedGlyphGroups = groups;
    this.glyphLayout = layout;
    for (const group of groups) {
      this.add(group);
    }
    this.userData.solvedBadgeTargets = hitTargets;
    this.ensureGlyphLayoutHook();
  }

  /**
   * Drive the screen-space annotation layout once per frame.
   *
   * The hook self-retires when this mesh leaves the scene: a render pass
   * replaces the whole `compiledMesh` subtree without telling its children,
   * so there is no disposal signal to hang the unregister on. Detachment
   * only counts once the mesh has actually been seen in the scene — it is
   * built before it is added, and an on-demand render can land in between.
   * A mesh that is never added at all retires on the grace counter instead
   * of leaking a hook forever.
   */
  private ensureGlyphLayoutHook(): void {
    if (this.layoutHookOff || !this.glyphLayout) {
      return;
    }
    this.layoutHookOff = addFrameHook((renderer, camera) => {
      if (this.isInScene()) {
        this.layoutAttached = true;
      } else if (this.layoutAttached || ++this.detachedFrames > DETACHED_GRACE_FRAMES) {
        this.layoutHookOff?.();
        this.layoutHookOff = null;
        this.glyphLayout?.dispose();
        this.glyphLayout = null;
        return;
      }
      this.glyphLayout?.update(renderer, camera);
    });
  }

  private isInScene(): boolean {
    let node: Object3D | null = this;
    while (node.parent) {
      node = node.parent;
    }
    return (node as { isScene?: boolean }).isScene === true;
  }

  private buildEdges(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      const edgeColor = this.edgeColorFor(obj);

      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          if (shape.shapeType === 'wire' || shape.shapeType === 'edge') {
            const metaMesh = createMetaEdgeMesh(shape);
            metaMesh.traverse(child => { child.renderOrder = 1; });
            if (shape.shapeId) {
              metaMesh.userData.shapeId = shape.shapeId;
            }
            // Guide geometry shares the dash-dot rendering with true meta
            // shapes but stays hover/selectable (un-guiding picks it), so the
            // select handler needs to tell the two apart.
            if (shape.isGuide && !shape.isMetaShape) {
              metaMesh.userData.isGuideShape = true;
            }
            this.add(metaMesh);
          }
          continue;
        }
        const edgeMesh = new EdgeMesh(shape, { color: edgeColor, lineWidth: 2, depthWrite: false, transparent: true });
        edgeMesh.traverse(child => { child.renderOrder = 1; });
        if (shape.shapeId) {
          edgeMesh.userData.shapeId = shape.shapeId;
          // Sketch wires are pickable only through the viewer's opt-in
          // sketch-pick channel (create dialogs) — mark the raycastable lines.
          edgeMesh.traverse(child => { child.userData.isSketchWire = true; });
        }
        if (this.isSolvedEntity(obj)) {
          const entityId = obj.object.entityId as number;
          edgeMesh.userData.entityId = entityId;
          const list = this.solvedEdgeMeshes.get(entityId) ?? [];
          list.push(edgeMesh);
          this.solvedEdgeMeshes.set(entityId, list);
        }
        this.add(edgeMesh);
      }
    }
  }

  private buildVertices(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    const normal = sceneObject.object?.plane?.normal;
    // Endpoint dots bucketed by style: legacy interactive/non-interactive
    // plus one bucket per solved-entity edge color (conflict/constrained).
    const buckets = new Map<string, { positions: Vector3[]; pxRadius: number; opacity: number }>();
    const metaVertices: Vector3[] = [];

    const bucketFor = (color: string, pxRadius: number, opacity: number): Vector3[] => {
      const key = `${color}|${pxRadius}|${opacity}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { positions: [], pxRadius, opacity };
        buckets.set(key, bucket);
      }
      return bucket.positions;
    };

    for (const obj of allObjects) {
      if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
        continue;
      }

      const interactive = isDraggableSketchObject(obj) || this.isSolvedEntity(obj);
      const color = this.edgeColorFor(obj);
      const target = interactive
        ? bucketFor(color, VERTEX_PX_RADIUS, 1)
        : bucketFor(color, NON_INTERACTIVE_VERTEX_PX_RADIUS, NON_INTERACTIVE_VERTEX_OPACITY);

      for (const shape of obj.sceneShapes) {
        // Meta point vertices (circle/arc/ellipse centers, text anchors)
        // before the guide skip: guiding an entity marks every shape it
        // owns, but its center stays a solver point — draggable and
        // constrainable — so the dot must survive the conversion.
        if (shape.isMetaShape) {
          for (const meshData of shape.meshes) {
            if (meshData.vertices.length === 3 && meshData.indices.length === 0) {
              metaVertices.push(new Vector3(
                meshData.vertices[0],
                meshData.vertices[1],
                meshData.vertices[2],
              ));
            }
          }
          continue;
        }

        if (shape.isGuide) {
          continue;
        }

        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          const endpoints: number[] = [];
          for (const [idx, c] of count) {
            if (c === 1) {
              endpoints.push(idx);
            }
          }

          // A closed curve's polyline duplicates its seam vertex at both
          // ends, so the two lone indices coincide. That seam is not a
          // topological endpoint — a circle grows no endpoint dot (it also
          // has no solver point role, so a seam dot could never track drags).
          if (endpoints.length === 2 && this.samePosition(meshData.vertices, endpoints[0], endpoints[1])) {
            continue;
          }

          for (const idx of endpoints) {
            target.push(new Vector3(
              meshData.vertices[idx * 3],
              meshData.vertices[idx * 3 + 1],
              meshData.vertices[idx * 3 + 2],
            ));
          }
        }
      }
    }

    const EPSILON_SQ = 1e-12;

    for (const [key, bucket] of buckets) {
      const color = key.split('|')[0];
      const unique = this.dedup(bucket.positions, EPSILON_SQ);
      this.addVertexDots(unique, normal, VERTEX_RADIUS, bucket.pxRadius, color, bucket.opacity);
    }
    const uniqueMeta = this.dedup(metaVertices, EPSILON_SQ);
    this.addVertexDots(uniqueMeta, normal, META_VERTEX_RADIUS, META_VERTEX_PX_RADIUS, META_VERTEX_COLOR, 0.5);
  }

  /** Solved-entity child of this solved sketch (they report 'selectable'
   * until P4, but must read as first-class sketch geometry, not derived
   * curves). */
  private isSolvedEntity(obj: SceneObjectRender): boolean {
    return this.solvedModel !== null
      && typeof obj.object?.entityId === 'number'
      && this.solvedModel.entities.has(obj.object.entityId);
  }

  /** Edge (and endpoint-dot) color: solved entities carry the diagnostic
   * tints — conflict red for members of unsatisfiable constraints, the
   * constrained tint per entity once the solver vouches it cannot move.
   * Reference producers (P6 projections/intersects) are locked geometry,
   * so they read constrained too. Everything else is the sketch blue. */
  private edgeColorFor(obj: SceneObjectRender): string {
    const model = this.solvedModel;
    if (model) {
      if (this.isSolvedEntity(obj)) {
        const entityId = obj.object.entityId as number;
        if (model.conflictingEntityIds.has(entityId) || obj.hasError) {
          return `#${themeColors.constraintConflictColor.getHexString()}`;
        }
        if (model.constrainedEntityIds.has(entityId)) {
          return `#${themeColors.sketchConstrainedColor.getHexString()}`;
        }
        return SKETCH_EDGE_COLOR;
      }
      const refIds = obj.id ? model.referenceProducers.get(obj.id) : undefined;
      if (refIds) {
        // A fixed reference can still be a conflict member — an
        // unsatisfiable constraint against a projected edge.
        if (obj.hasError || refIds.some(id => model.conflictingEntityIds.has(id))) {
          return `#${themeColors.constraintConflictColor.getHexString()}`;
        }
        return `#${themeColors.sketchConstrainedColor.getHexString()}`;
      }
      // Derived-op duplicates (copy/mirror/rotate) are rigid images of
      // their sources: they wear the sources' verdict.
      const srcIds = obj.id ? model.derivedProducers.get(obj.id) : undefined;
      if (srcIds) {
        if (obj.hasError || srcIds.some(id => model.conflictingEntityIds.has(id))) {
          return `#${themeColors.constraintConflictColor.getHexString()}`;
        }
        const pinned = (id: number) =>
          model.constrainedEntityIds.has(id) || model.entities.get(id)?.reference !== undefined;
        if (srcIds.length > 0 && srcIds.every(pinned)) {
          return `#${themeColors.sketchConstrainedColor.getHexString()}`;
        }
      }
    }
    return SKETCH_EDGE_COLOR;
  }

  private addConstraintIcons(): void {
    if (!this.showConstraints) {
      return;
    }
    if (this.solvedModel) {
      // Same path as a live-drag refresh: build the glyphs, hand them to the
      // layout, and let the frame hook place them (screen-space hit test —
      // badges float a pixel offset away from their anchors).
      this.rebuildSolvedGlyphs();
    }
  }

  private samePosition(vertices: number[], a: number, b: number): boolean {
    const dx = vertices[a * 3] - vertices[b * 3];
    const dy = vertices[a * 3 + 1] - vertices[b * 3 + 1];
    const dz = vertices[a * 3 + 2] - vertices[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz < 1e-12;
  }

  private dedup(points: Vector3[], epsilonSq: number): Vector3[] {
    const unique: Vector3[] = [];
    for (const p of points) {
      if (!unique.some(u => u.distanceToSquared(p) < epsilonSq)) {
        unique.push(p);
      }
    }
    return unique;
  }

  private addVertexDots(
    positions: Vector3[],
    normal: { x: number; y: number; z: number } | undefined,
    radius: number,
    targetPixels: number,
    color: string | number,
    opacity: number,
  ): void {
    const geometry = new CircleGeometry(radius, VERTEX_SEGMENTS);
    const material = new MeshBasicMaterial({
      color,
      side: DoubleSide,
      depthTest: false,
      transparent: true,
      opacity,
    });

    for (const pos of positions) {
      const dot = new Mesh(geometry, material);
      dot.renderOrder = 2;

      const dotGroup = new Group();
      dotGroup.renderOrder = 2;
      dotGroup.userData.isVertexDot = true;
      dotGroup.add(dot);
      dotGroup.position.copy(pos);

      if (normal) {
        dotGroup.lookAt(new Vector3(
          pos.x + normal.x,
          pos.y + normal.y,
          pos.z + normal.z,
        ));
      }

      // The group's own position is the scale anchor, so live drag moves
      // (updateSolvedGeometry) keep the constant-pixel sizing tracking.
      applyConstantPixelSize(dot, dotGroup, dotGroup.position, targetPixels, radius);

      this.add(dotGroup);
    }
  }

}
