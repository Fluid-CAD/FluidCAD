import {
  Camera,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { SceneObjectRender } from '../../types';
import { EdgeMesh } from '../shape-meshes/edge-mesh';
import { createMetaEdgeMesh, createMetaFaceMesh } from './shape-group';
import { isDraggableSketchObject } from '../../interactive/sketch-edge-utils';
import { buildConstraintIcons } from './constraint-icon';
import { buildSolvedConstraintMeshes } from './solved-constraint-meshes';
import {
  SolvedSketchModel,
  buildSolvedSketchModel,
  layoutConstraintGlyphs,
  tessellateSolvedEntity,
} from '../../sketch-solver-client';
import type { LiveEntityGeometry } from '../../sketch-solver-client';
import { localToWorld } from '../../interactive/sketch-plane-utils';
import { themeColors } from '../../scene/theme-colors';
import { applyConstantPixelSize } from '../screen-scale';

const SKETCH_EDGE_COLOR = '#2297ff';
const NON_INTERACTIVE_EDGE_COLOR = '#6a5acd';
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
const CURSOR_COLOR = 0xf3724f;
const CURSOR_SEGMENTS = 64;
const CURSOR_RADIUS = 3;
const CURSOR_PX_RADIUS = 9;
const TANGENT_ARROW_COLOR = 0xf3724f;
const TANGENT_ARROW_OPACITY = 0.35;
const TANGENT_SHAFT_RADIUS = 0.6;
const TANGENT_SHAFT_LENGTH = 18;
const TANGENT_HEAD_LENGTH = 5;
const TANGENT_HEAD_WIDTH = 2.5;
const TANGENT_TOTAL_LENGTH = TANGENT_SHAFT_LENGTH + TANGENT_HEAD_LENGTH;
const TANGENT_PX_LENGTH = 54;

/**
 * Renders a sketch: all child edges in blue, plus an optional cursor circle
 * at the current drawing position.
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

  constructor(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[], activeSketchId: string | null, _camera: Camera) {
    super();
    this.userData.isSketchRoot = true;
    this.userData.sketchObjectId = sceneObject.id;
    this.solvedModel = buildSolvedSketchModel(sceneObject, allObjects);
    this.buildEdges(sceneObject, allObjects);
    this.buildVertices(sceneObject, allObjects);
    this.bindSolvedDots();
    this.addConstraintIcons(sceneObject, allObjects);
    if (activeSketchId && sceneObject.id === activeSketchId) {
      this.buildCursor(sceneObject);
      this.buildTangentArrow(sceneObject);
    }
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

  private rebuildSolvedGlyphs(): void {
    const model = this.solvedModel;
    if (!model) {
      return;
    }
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
    const glyphs = layoutConstraintGlyphs(model);
    const { groups, hitTargets } = buildSolvedConstraintMeshes(model, glyphs);
    this.solvedGlyphGroups = groups;
    for (const group of groups) {
      this.add(group);
    }
    this.userData.solvedBadgeTargets = hitTargets;
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
          } else if (shape.shapeType === 'face' && shape.metaType === 'trim-region') {
            // By-region trim: the region partition's hover/click cells.
            const faceMesh = createMetaFaceMesh(shape);
            if (shape.shapeId) {
              faceMesh.userData.shapeId = shape.shapeId;
            }
            this.add(faceMesh);
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
        if (shape.isGuide) {
          continue;
        }

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

        for (const meshData of shape.meshes) {
          if (!meshData.indices.length) {
            continue;
          }

          const count = new Map<number, number>();
          for (const idx of meshData.indices) {
            count.set(idx, (count.get(idx) || 0) + 1);
          }

          for (const [idx, c] of count) {
            if (c === 1) {
              target.push(new Vector3(
                meshData.vertices[idx * 3],
                meshData.vertices[idx * 3 + 1],
                meshData.vertices[idx * 3 + 2],
              ));
            }
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
   * constrained tint when the whole sketch is at 0 DOF. */
  private edgeColorFor(obj: SceneObjectRender): string {
    const model = this.solvedModel;
    if (model && this.isSolvedEntity(obj)) {
      const entityId = obj.object.entityId as number;
      if (model.conflictingEntityIds.has(entityId) || obj.hasError) {
        return `#${themeColors.constraintConflictColor.getHexString()}`;
      }
      if (model.fullyConstrained) {
        return `#${themeColors.sketchConstrainedColor.getHexString()}`;
      }
      return SKETCH_EDGE_COLOR;
    }
    return isDraggableSketchObject(obj) ? SKETCH_EDGE_COLOR : NON_INTERACTIVE_EDGE_COLOR;
  }

  private addConstraintIcons(sceneObject: SceneObjectRender, allObjects: SceneObjectRender[]): void {
    if (this.solvedModel) {
      const glyphs = layoutConstraintGlyphs(this.solvedModel);
      const { groups, hitTargets } = buildSolvedConstraintMeshes(this.solvedModel, glyphs);
      this.solvedGlyphGroups = groups;
      for (const group of groups) {
        this.add(group);
      }
      // The sketch hover/select handler picks badges from here (screen-space
      // hit test — badges float a pixel offset away from their anchors).
      this.userData.solvedBadgeTargets = hitTargets;
      return;
    }
    for (const icon of buildConstraintIcons(sceneObject, allObjects)) {
      this.add(icon);
    }
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

  private buildCursor(sceneObject: SceneObjectRender): void {
    const currentPosition = sceneObject.object?.currentPosition;
    if (!currentPosition) {
      return;
    }

    const geometry = new CircleGeometry(CURSOR_RADIUS, CURSOR_SEGMENTS);
    const material = new MeshBasicMaterial({ color: CURSOR_COLOR, side: DoubleSide, depthTest: false });
    material.transparent = true;
    material.opacity = 0.8;

    const dot = new Mesh(
      geometry,
      material
    );
    dot.renderOrder = 1;

    const cursorGroup = new Group();
    cursorGroup.renderOrder = 1;
    // Drawing chrome, not sketch content — must not participate in camera fits.
    cursorGroup.userData.isMetaShape = true;
    cursorGroup.add(dot);
    cursorGroup.position.set(currentPosition.x, currentPosition.y, currentPosition.z);

    const normal = sceneObject.object?.plane?.normal;
    if (normal) {
      const target = new Vector3(
        currentPosition.x + normal.x,
        currentPosition.y + normal.y,
        currentPosition.z + normal.z,
      );
      cursorGroup.lookAt(target);
    }

    applyConstantPixelSize(dot, cursorGroup, cursorGroup.position, CURSOR_PX_RADIUS, CURSOR_RADIUS);

    this.add(cursorGroup);
  }

  private buildTangentArrow(sceneObject: SceneObjectRender): void {
    const currentPosition = sceneObject.object?.currentPosition;
    const currentTangent = sceneObject.object?.currentTangent;
    const planeOrigin = sceneObject.object?.plane?.origin;
    if (!currentPosition || !currentTangent || !planeOrigin) {
      return;
    }

    // currentTangent is localToWorld(tangent_dir), so the world direction is currentTangent - planeOrigin
    const dir = new Vector3(
      currentTangent.x - planeOrigin.x,
      currentTangent.y - planeOrigin.y,
      currentTangent.z - planeOrigin.z,
    ).normalize();

    const material = new MeshBasicMaterial({
      color: TANGENT_ARROW_COLOR,
      transparent: true,
      opacity: TANGENT_ARROW_OPACITY,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });

    const shaftGeometry = new CylinderGeometry(TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_RADIUS, TANGENT_SHAFT_LENGTH, 16);
    shaftGeometry.translate(0, TANGENT_SHAFT_LENGTH / 2, 0);
    const shaft = new Mesh(shaftGeometry, material);

    const headGeometry = new ConeGeometry(TANGENT_HEAD_WIDTH, TANGENT_HEAD_LENGTH, 16);
    headGeometry.translate(0, TANGENT_SHAFT_LENGTH + TANGENT_HEAD_LENGTH / 2, 0);
    const head = new Mesh(headGeometry, material);

    const arrowGroup = new Group();
    arrowGroup.renderOrder = 1;
    // Drawing chrome, not sketch content — must not participate in camera fits.
    arrowGroup.userData.isMetaShape = true;
    arrowGroup.add(shaft);
    arrowGroup.add(head);

    // Rotate from default Y-up to the tangent direction
    const up = new Vector3(0, 1, 0);
    const quaternion = new Quaternion().setFromUnitVectors(up, dir);
    arrowGroup.quaternion.copy(quaternion);
    arrowGroup.position.set(currentPosition.x, currentPosition.y, currentPosition.z);

    applyConstantPixelSize(shaft, arrowGroup, arrowGroup.position, TANGENT_PX_LENGTH, TANGENT_TOTAL_LENGTH);

    this.add(arrowGroup);
  }
}
