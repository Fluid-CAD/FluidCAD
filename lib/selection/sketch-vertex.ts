import { SceneObject } from '../common/scene-object.js';
import { Edge } from '../common/edge.js';
import { Sketch } from '../features/2d/sketch.js';
import { SolvedGeometryBase } from '../features/2d/solved/solved-base.js';
import { SolvedPointRef } from '../features/2d/solved/refs.js';
import { isReferenceProducer, ReferencePointRef } from '../features/2d/solved/reference.js';
import { Copy2DBase } from '../features/copy2d-base.js';
import { MirrorShape2D } from '../features/mirror-shape2d.js';
import { BezierCurve } from '../features/2d/bezier.js';
import { Offset } from '../features/2d/offset.js';
import { PointResolver } from '../features/point-resolver.js';
import { LazyVertex } from '../features/lazy-vertex.js';
import { Point } from '../math/point.js';
import { mmTol } from '../units/tolerance.js';
import { topologyVertices } from './vertex-pick.js';
import type { SolvedEmissionTarget, SketchExportRequest } from './sketch-target.js';
import type { SelectionScene } from './types.js';

type Address = {
  target: SolvedEmissionTarget;
  /** Bindings for source rendering and the existing scene's evaluable form. */
  entities: Map<number, SceneObject>;
  entity: SceneObject;
  point(role: 'start' | 'end'): LazyVertex;
};

export type SketchVertexAttribution = {
  ok: true;
  sketch: Sketch;
  request: SketchExportRequest;
  entities: Map<number, SceneObject>;
} | { ok: false; reason: string };

/** Attribute a shared corner to the earliest incident entity with a named point. */
export function attributeSketchVertex(scene: SelectionScene, sketch: Sketch, point: Point): SketchVertexAttribution {
  const location = sketch.getSourceLocation();
  if (!location) {
    return { ok: false, reason: 'the sketch has no source location — name and return its geometry explicitly' };
  }
  const objects = new Set(scene.getAllSceneObjects());
  const edges = [...sketch.getEdgesWithOwner({}, scene.editedStatement ? objects : undefined)]
    .filter(([edge, owner]) => objects.has(owner) && incident(edge, point));
  // Both edges at a corner of one derived statement (an offset) share owner
  // and source line: the lower edge index wins there.
  edges.sort(([edgeA, a], [edgeB, b]) => {
    const x = a.getSourceLocation();
    const y = b.getSourceLocation();
    return (x?.line ?? Infinity) - (y?.line ?? Infinity)
      || (x?.column ?? Infinity) - (y?.column ?? Infinity)
      || a.getOrder() - b.getOrder()
      || a.getAddedShapes().indexOf(edgeA) - b.getAddedShapes().indexOf(edgeB);
  });
  let refusal: string | undefined;
  for (const [edge, owner] of edges) {
    try {
      const address = entityAddress(owner, edge, sketch);
      if (!address) {
        continue;
      }
      for (const role of ['start', 'end'] as const) {
        const ref = address.point(role);
        if (PointResolver.toWorld(ref).distanceTo(point) > mmTol(1e-6)) {
          continue;
        }
        for (const entity of address.entities.values()) {
          const loc = entity.getSourceLocation()!;
          if (loc.filePath !== location.filePath) {
            throw new Error('the sketch entity lives in another file — export it explicitly in its defining file');
          }
          // Entities are addressed by source line: the line must hold this
          // one statement, executed once.
          const siblings = scene.getAllSceneObjects().filter(other => {
            const otherLoc = other.getSourceLocation();
            return otherLoc?.filePath === loc.filePath && otherLoc.line === loc.line;
          });
          const repeated = siblings.filter(other => other.getSourceLocation()!.column === loc.column);
          if (repeated.length !== 1 || entity.getCloneSource()) {
            throw new Error('the sketch entity runs more than once (loop/helper) — name and return the desired geometry explicitly');
          }
          if (siblings.length !== 1) {
            throw new Error(`line ${loc.line} holds several statements — put the geometry on its own line so it can be named`);
          }
        }
        const target = owner instanceof BezierCurve
          ? { ...address.target, pointIndex: role === 'start' ? 0 : owner.controlPoints.length - 1 }
          : { ...address.target, role };
        return { ok: true, sketch, request: { sketch: location, target }, entities: address.entities };
      }
    } catch (error) {
      refusal ??= error instanceof Error ? error.message : String(error);
    }
  }
  const operations = [...new Set(edges.map(([, owner]) => owner.getType()))].join('/') || 'sketch operation';
  return { ok: false, reason: refusal ?? `this vertex is produced by ${operations}() and has no supported named entity point — outside sketch edge references are not available for this operation yet` };
}

function incident(edge: Edge, point: Point): boolean {
  const points = topologyVertices(edge);
  for (let i = 0; i < points.length; i += 3) {
    if (new Point(points[i], points[i + 1], points[i + 2]).distanceTo(point) <= mmTol(1e-6)) {
      return true;
    }
  }
  return false;
}

function entityAddress(owner: SceneObject, edge: Edge, sketch: Sketch, seen = new Set<SceneObject>()): Address | null {
  const location = owner.getSourceLocation();
  if (!location || seen.has(owner)) {
    return null;
  }
  const entities = new Map([[location.line, owner]]);
  const target = { line: location.line };
  if (owner instanceof SolvedGeometryBase && (owner.solverKind === 'line' || owner.solverKind === 'arc')) {
    return { target: { ...target, featureType: owner.solverKind }, entities, entity: owner,
      point: role => new SolvedPointRef(owner, role, `vertex-${role}`) };
  }
  if (owner instanceof BezierCurve) {
    return { target: { ...target, featureType: 'bezier' }, entities, entity: owner,
      point: role => owner.point(role === 'start' ? 0 : owner.controlPoints.length - 1) };
  }
  if (isReferenceProducer(owner)) {
    const index = owner.getAddedShapes().filter(shape => shape instanceof Edge).findIndex(shape => shape === edge);
    const record = owner.referenceEntities().find(record => record.edgeIndex === index && record.kind !== 'circle');
    if (record) {
      const refIndex = owner.referenceEntities().length === 1 ? null : index;
      return { target: { ...target, featureType: owner.getType() === 'projection' ? 'project' : 'intersect', refIndex }, entities,
        entity: owner, point: role => new ReferencePointRef(owner, refIndex, role) };
    }
  }
  if (owner instanceof Offset) {
    // Index-based (D9): the edge's position along the offset walk.
    const index = owner.edgeIndexOf(edge);
    if (index >= 0) {
      const handle = owner.edge(index);
      return { target: { ...target, featureType: 'offset', edgeIndex: index }, entities, entity: owner,
        point: role => handle[role]() };
    }
  }
  if (owner instanceof Copy2DBase) {
    const slot = owner.getInstanceIndex(edge);
    if (slot !== null) {
      const instance = owner.instance(slot);
      return { target: { ...target, featureType: 'copy', instanceIndex: slot }, entities, entity: instance,
        point: role => instance[role]() };
    }
  }
  if (owner instanceof MirrorShape2D) {
    const visited = new Set([...seen, owner]);
    // Sources may have been consumed by the mirror; use their added shapes.
    for (const source of sketch.getChildren()) {
      if (source.getOrder() >= owner.getOrder() || source.isLazy() || source.isSelection()) {
        continue;
      }
      for (const shape of source.getAddedShapes()) {
        if (!(shape instanceof Edge)) {
          continue;
        }
        const address = entityAddress(source, shape, sketch, visited);
        if (!address) {
          continue;
        }
        try {
          if (owner.instanceSolverRef(address.entity, 'vertex').entity !== owner.duplicateEntityForShape(edge)) {
            continue;
          }
        } catch {
          continue;
        }
        const instance = owner.instance(address.entity);
        return { target: { ...target, featureType: 'mirror', source: address.target },
          entities: new Map([...entities, ...address.entities]), entity: instance, point: role => instance[role]() };
      }
    }
  }
  return null;
}
