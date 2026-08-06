import { PlaneData, SceneObjectRender } from '../types';

const INTERACTIVE_SKETCH_TYPES = new Set([
  'line-two-points', 'hline', 'vline',
  'circle',
  'arc', 'arc-from-center',
  'tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent',
  'tarc-radius-to-point',
  'tline',
  'trim2d',
  'rect',
  'polygon',
  'slot',
]);

export function isInteractiveSketchType(uniqueType: string | undefined): boolean {
  if (!uniqueType) {
    return false;
  }
  if (uniqueType.startsWith('bezier-')) {
    return true;
  }
  return INTERACTIVE_SKETCH_TYPES.has(uniqueType);
}

/**
 * Whether the geometry's statement can be edited by dragging in the viewport.
 * Server-driven via `interactivity`; the type allow-list is a fallback for
 * older payloads.
 */
export function isDraggableSketchObject(obj: SceneObjectRender): boolean {
  if (obj.interactivity) {
    return obj.interactivity === 'draggable';
  }
  return isInteractiveSketchType(obj.uniqueType);
}

/**
 * Whether the geometry can be hovered/picked as an operation target. Derived
 * geometry (offset results, projections, mirror copies) is selectable even
 * though it is not draggable.
 */
export function isSelectableSketchObject(obj: SceneObjectRender): boolean {
  if (obj.interactivity) {
    return obj.interactivity === 'draggable' || obj.interactivity === 'selectable';
  }
  return isInteractiveSketchType(obj.uniqueType);
}

export type EdgeEntry = {
  shapeId: string;
  segments: { ax: number; ay: number; bx: number; by: number }[];
  endpoints: [number, number, number][];
};

export function buildEdgeIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
  options: { includeGuides?: boolean } = {},
): EdgeEntry[] {
  const result: EdgeEntry[] = [];
  const ox = plane.origin.x, oy = plane.origin.y, oz = plane.origin.z;
  const xx = plane.xDirection.x, xy = plane.xDirection.y, xz = plane.xDirection.z;
  const yx = plane.yDirection.x, yy = plane.yDirection.y, yz = plane.yDirection.z;

  const hasTrimMeta = sceneObjects.some(obj =>
    obj.parentId === sketchId &&
    obj.sceneShapes.some(s => s.metaType === 'trim'),
  );

  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    if (!isSelectableSketchObject(obj)) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (!shape.shapeId) {
        continue;
      }
      if (hasTrimMeta) {
        // A trim replaces the profile's display shapes with its 'trim' meta
        // segments; guides are never consumed by trim, so they stay
        // indexable alongside when requested.
        const guidePass = options.includeGuides === true && shape.isGuide && !shape.isMetaShape;
        if (shape.metaType !== 'trim' && !guidePass) {
          continue;
        }
      } else {
        if (shape.isMetaShape || (shape.isGuide && options.includeGuides !== true)) {
          continue;
        }
      }
      const segments: EdgeEntry['segments'] = [];
      const endpoints: [number, number, number][] = [];

      for (const mesh of shape.meshes) {
        const verts = mesh.vertices;
        const indices = mesh.indices;
        if (!indices.length) {
          continue;
        }

        const count = new Map<number, number>();
        for (const idx of indices) {
          count.set(idx, (count.get(idx) || 0) + 1);
        }
        for (const [idx, c] of count) {
          if (c === 1) {
            endpoints.push([verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]]);
          }
        }

        for (let k = 0; k < indices.length; k += 2) {
          const ia = indices[k] * 3;
          const ib = indices[k + 1] * 3;

          const rax = verts[ia] - ox, ray = verts[ia + 1] - oy, raz = verts[ia + 2] - oz;
          const ax = rax * xx + ray * xy + raz * xz;
          const ay = rax * yx + ray * yy + raz * yz;

          const rbx = verts[ib] - ox, rby = verts[ib + 1] - oy, rbz = verts[ib + 2] - oz;
          const bx = rbx * xx + rby * xy + rbz * xz;
          const by = rbx * yx + rby * yy + rbz * yz;

          segments.push({ ax, ay, bx, by });
        }
      }

      if (segments.length > 0) {
        result.push({ shapeId: shape.shapeId, segments, endpoints });
      }
    }
  }

  return result;
}

/** A tArc snap candidate: one edge of a single-edge geometry statement. */
export type TarcTargetEntry = {
  shapeId: string;
  segments: EdgeEntry['segments'];
  /** Source line of the producing statement (self/later-statement exclusion). */
  ownerLine: number;
};

/**
 * Snap candidates for a tangent-arc-to-target reference: edges of
 * single-edge geometries in this sketch, guide edges included —
 * construction geometry is the classic thing to arc up to. The kernel's
 * `tArc(radius, target)` resolves the target through the owner's FIRST
 * shape, so multi-edge owners (rect, polygon) are excluded — on those the
 * arc would silently aim at an arbitrary edge. Owners without a source
 * location can't be bound to a variable and are excluded too.
 */
export function buildTarcTargetIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
): TarcTargetEntry[] {
  const ownerByShapeId = new Map<string, SceneObjectRender>();
  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (shape.shapeId) {
        ownerByShapeId.set(shape.shapeId, obj);
      }
    }
  }

  const entries = buildEdgeIndex(sceneObjects, sketchId, plane, { includeGuides: true });
  const entriesPerOwner = new Map<SceneObjectRender, number>();
  for (const entry of entries) {
    const owner = ownerByShapeId.get(entry.shapeId);
    if (owner) {
      entriesPerOwner.set(owner, (entriesPerOwner.get(owner) ?? 0) + 1);
    }
  }

  const result: TarcTargetEntry[] = [];
  for (const entry of entries) {
    const owner = ownerByShapeId.get(entry.shapeId);
    if (!owner || !owner.sourceLocation || entriesPerOwner.get(owner) !== 1) {
      continue;
    }
    result.push({ shapeId: entry.shapeId, segments: entry.segments, ownerLine: owner.sourceLocation.line });
  }
  return result;
}

/** A text-path pick candidate: one whole sketch geometry, hit-tested by all its edges. */
export type PathTargetEntry = {
  /** One shapeId of the owner — the server resolves the pick owner-level. */
  shapeId: string;
  /** Every edge shapeId of the owner — the viewport highlight tints them all. */
  shapeIds: string[];
  /** Every segment of the owner's edges, in sketch-plane 2D. */
  segments: EdgeEntry['segments'];
  /** The owning statement row; chip labels and ordering checks read it. */
  owner: SceneObjectRender;
};

/**
 * Pick candidates for a text path (`text("Hi", path)`): whole sketch
 * geometries — text chains ALL edges of the picked geometry into a wire, so
 * hits are owner-level, and multi-edge owners (rect, polygon, slot) are
 * valid. Guide edges are included — marking the path `.guide()` is the
 * classic way to keep it out of the extruded profile. Owners without a
 * source location can't be bound to a variable and are excluded.
 */
export function buildPathTargetIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
): PathTargetEntry[] {
  const ownerByShapeId = new Map<string, SceneObjectRender>();
  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (shape.shapeId) {
        ownerByShapeId.set(shape.shapeId, obj);
      }
    }
  }

  const entries = buildEdgeIndex(sceneObjects, sketchId, plane, { includeGuides: true });
  const grouped = new Map<SceneObjectRender, PathTargetEntry>();
  for (const entry of entries) {
    const owner = ownerByShapeId.get(entry.shapeId);
    if (!owner || !owner.sourceLocation) {
      continue;
    }
    const existing = grouped.get(owner);
    if (existing) {
      existing.shapeIds.push(entry.shapeId);
      existing.segments.push(...entry.segments);
    } else {
      grouped.set(owner, {
        shapeId: entry.shapeId,
        shapeIds: [entry.shapeId],
        segments: [...entry.segments],
        owner,
      });
    }
  }
  return [...grouped.values()];
}

/** The nearest path candidate within `threshold` of a sketch-plane point, or null. */
export function hitTestPathTargets(
  entries: PathTargetEntry[],
  point2d: [number, number],
  threshold: number,
): PathTargetEntry | null {
  let best: PathTargetEntry | null = null;
  let bestDist = threshold;
  for (const entry of entries) {
    for (const s of entry.segments) {
      const d = pointToSegmentDist(point2d[0], point2d[1], s.ax, s.ay, s.bx, s.by);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
  }
  return best;
}

export type CenterEntry = {
  shapeId: string;
  point2d: [number, number];
};

const ARC_UNIQUE_TYPES = new Set([
  'arc', 'tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent',
  'tarc-radius-to-point',
  'slot',
]);

export function buildCenterIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
): CenterEntry[] {
  const result: CenterEntry[] = [];
  const ox = plane.origin.x, oy = plane.origin.y, oz = plane.origin.z;
  const xx = plane.xDirection.x, xy = plane.xDirection.y, xz = plane.xDirection.z;
  const yx = plane.yDirection.x, yy = plane.yDirection.y, yz = plane.yDirection.z;

  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    if (!isDraggableSketchObject(obj)) {
      continue;
    }

    let shapeId: string | null = null;
    for (const shape of obj.sceneShapes) {
      if (!shape.isMetaShape && shape.shapeId) {
        shapeId = shape.shapeId;
        break;
      }
    }
    if (!shapeId) {
      continue;
    }

    const uniqueType = obj.uniqueType ?? '';
    if (uniqueType.startsWith('bezier-')) {
      const start = (obj as any).object?.startPoint as [number, number] | null | undefined;
      const poles = (obj as any).object?.resolvedPoints as [number, number][] | undefined;
      if (start) {
        result.push({ shapeId, point2d: [start[0], start[1]] });
      }
      if (poles) {
        for (const p of poles) {
          result.push({ shapeId, point2d: [p[0], p[1]] });
        }
      }
      continue;
    }

    if (!ARC_UNIQUE_TYPES.has(uniqueType)) {
      continue;
    }

    for (const shape of obj.sceneShapes) {
      if (!shape.isMetaShape) {
        continue;
      }
      for (const mesh of shape.meshes) {
        if (mesh.vertices.length === 3 && mesh.indices.length === 0) {
          const rx = mesh.vertices[0] - ox;
          const ry = mesh.vertices[1] - oy;
          const rz = mesh.vertices[2] - oz;
          const u = rx * xx + ry * xy + rz * xz;
          const v = rx * yx + ry * yy + rz * yz;
          result.push({ shapeId, point2d: [u, v] });
        }
      }
    }
  }

  return result;
}

export function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  return closestPointOnSegment(px, py, ax, ay, bx, by).dist;
}

export function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let cx: number;
  let cy: number;

  if (lenSq === 0) {
    cx = ax;
    cy = ay;
  } else {
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) {
      t = 0;
    } else if (t > 1) {
      t = 1;
    }
    cx = ax + t * dx;
    cy = ay + t * dy;
  }

  const ex = cx - px;
  const ey = cy - py;
  return { x: cx, y: cy, dist: Math.sqrt(ex * ex + ey * ey) };
}
