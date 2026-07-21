import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { pixelToSketchThreshold } from '../sketch-plane-utils';
import { pointToSegmentDist, isDraggableSketchObject } from '../sketch-edge-utils';
import { circumcenter, isCCW } from '../tools/tool-preview-utils';
import { meshToSketch2D } from '../tools/tangent-utils';
import { DragHitResult } from './types';

export function findHitGeometry(
  point2d: [number, number],
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
  ctx: SceneContext,
  includeRectEdges = false,
): DragHitResult | null {
  const sketchChildren = sceneObjects.filter(o => o.parentId === sketchId);
  const threshold = pixelToSketchThreshold(ctx, 12);
  const thresholdSq = threshold * threshold;

  let bestHit: DragHitResult | null = null;
  let bestDistSq = Infinity;

  for (const child of sketchChildren) {
    if (!child.sourceLocation || !isDraggableSketchObject(child)) {
      continue;
    }
    const uniqueType = (child as any).uniqueType as string | undefined;
    const sourceLocation = child.sourceLocation;

    if (uniqueType && uniqueType.startsWith('bezier-')) {
      const result = hitTestBezier(point2d, child, sourceLocation, uniqueType, thresholdSq, bestDistSq);
      if (result) {
        bestHit = result.hit;
        bestDistSq = result.distSq;
      }
      continue;
    }

    if (uniqueType === 'polygon') {
      const allVerts: [number, number][] = [];
      for (const part of child.sceneShapes) {
        if (part.isMetaShape) {
          continue;
        }
        for (const mesh of part.meshes) {
          const mv = meshToSketch2D(mesh.vertices, plane);
          for (const v of mv) {
            allVerts.push(v);
          }
        }
      }
      if (allVerts.length > 0) {
        const result = hitTestPolygon(point2d, allVerts, sourceLocation, child, thresholdSq, bestDistSq);
        if (result) {
          bestHit = result.hit;
          bestDistSq = result.distSq;
        }
      }
      continue;
    }

    if (uniqueType === 'slot') {
      const metaCenters: [number, number][] = [];
      for (const part of child.sceneShapes) {
        if (part.isMetaShape) {
          for (const mesh of part.meshes) {
            if (mesh.vertices.length === 3 && mesh.indices.length === 0) {
              const cv = meshToSketch2D(mesh.vertices, plane);
              if (cv.length === 1) {
                metaCenters.push(cv[0]);
              }
            }
          }
        }
      }
      if (metaCenters.length === 2) {
        const result = hitTestSlot(point2d, metaCenters, sourceLocation, child, plane, thresholdSq, bestDistSq);
        if (result) {
          bestHit = result.hit;
          bestDistSq = result.distSq;
        }
      }
      continue;
    }

    if (uniqueType === 'rect') {
      const allVerts: [number, number][] = [];
      for (const part of child.sceneShapes) {
        if (part.isMetaShape) {
          continue;
        }
        for (const mesh of part.meshes) {
          const mv = meshToSketch2D(mesh.vertices, plane);
          for (const v of mv) {
            allVerts.push(v);
          }
        }
      }
      if (allVerts.length > 0) {
        const result = hitTestRect(point2d, allVerts, sourceLocation, child, thresholdSq, bestDistSq, includeRectEdges);
        if (result) {
          bestHit = result.hit;
          bestDistSq = result.distSq;
        }
      }
      continue;
    }

    for (const part of child.sceneShapes) {
      if (part.isMetaShape) {
        continue;
      }
      for (const mesh of part.meshes) {
        const verts2d = meshToSketch2D(mesh.vertices, plane);
        if (verts2d.length === 0) {
          continue;
        }

        if (uniqueType === 'circle') {
          const result = hitTestCircle(point2d, verts2d, sourceLocation, thresholdSq, bestDistSq);
          if (result) {
            bestHit = result.hit;
            bestDistSq = result.distSq;
          }
        } else if (uniqueType === 'line-two-points' || uniqueType === 'hline' || uniqueType === 'vline' || uniqueType === 'tline') {
          const result = hitTestLine(point2d, verts2d, sourceLocation, uniqueType, child, thresholdSq, bestDistSq);
          if (result) {
            bestHit = result.hit;
            bestDistSq = result.distSq;
          }
        } else if (uniqueType === 'arc' && verts2d.length >= 3) {
          const result = hitTestArc(point2d, verts2d, sourceLocation, child, plane, thresholdSq, bestDistSq);
          if (result) {
            bestHit = result.hit;
            bestDistSq = result.distSq;
          }
        } else if ((uniqueType === 'tarc-to-point' || uniqueType === 'tarc-to-point-tangent') && verts2d.length >= 2) {
          const result = hitTestTangentArc(point2d, verts2d, sourceLocation, uniqueType, child, plane, thresholdSq, bestDistSq);
          if (result) {
            bestHit = result.hit;
            bestDistSq = result.distSq;
          }
        } else {
          for (const v of verts2d) {
            const ddx = v[0] - point2d[0];
            const ddy = v[1] - point2d[1];
            const d = ddx * ddx + ddy * ddy;
            if (d < thresholdSq && d < bestDistSq) {
              bestHit = { sourceLocation, uniqueType: uniqueType || '', hitZone: 'body' };
              bestDistSq = d;
            }
          }
        }
      }
    }
  }

  return bestHit;
}

type HitTestResult = { hit: DragHitResult; distSq: number };

function hitTestCircle(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const uniqueVerts: [number, number][] = [];
  const DUP_EPS_SQ = 1e-6;
  for (const v of verts2d) {
    let isDup = false;
    for (const u of uniqueVerts) {
      const dx = u[0] - v[0];
      const dy = u[1] - v[1];
      if (dx * dx + dy * dy < DUP_EPS_SQ) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      uniqueVerts.push(v);
    }
  }
  let cx = 0, cy = 0;
  for (const v of uniqueVerts) {
    cx += v[0];
    cy += v[1];
  }
  cx /= uniqueVerts.length;
  cy /= uniqueVerts.length;

  const sample = uniqueVerts[0];
  const sdx = sample[0] - cx;
  const sdy = sample[1] - cy;
  const radius = Math.sqrt(sdx * sdx + sdy * sdy);
  const diameter = Math.round(2 * radius * 100) / 100;

  let result: HitTestResult | null = null;
  for (const v of verts2d) {
    const ddx = v[0] - point2d[0];
    const ddy = v[1] - point2d[1];
    const d = ddx * ddx + ddy * ddy;
    if (d < thresholdSq && d < bestDistSq) {
      result = {
        hit: {
          sourceLocation, uniqueType: 'circle', hitZone: 'body',
          anchorPoint: [cx, cy],
          initialValue: diameter,
        },
        distSq: d,
      };
      bestDistSq = d;
    }
  }
  return result;
}

function hitTestLine(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  uniqueType: string,
  child: SceneObjectRender,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const startV = verts2d[0];
  const endV = verts2d[verts2d.length - 1];

  const sdx = startV[0] - point2d[0];
  const sdy = startV[1] - point2d[1];
  const startDist = sdx * sdx + sdy * sdy;

  const edx = endV[0] - point2d[0];
  const edy = endV[1] - point2d[1];
  const endDist = edx * edx + edy * edy;

  const isConstrained = uniqueType === 'hline' || uniqueType === 'vline' || uniqueType === 'tline';

  let signedDist: number | undefined;
  let tangent: [number, number] | undefined;
  if (uniqueType === 'tline') {
    const dx = endV[0] - startV[0];
    const dy = endV[1] - startV[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1e-10) {
      tangent = [dx / len, dy / len];
      signedDist = len;
      if (verts2d.length >= 2) {
        const a = verts2d[verts2d.length - 2];
        const b = verts2d[verts2d.length - 1];
        const tdx = b[0] - a[0];
        const tdy = b[1] - a[1];
        const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
        if (tlen > 1e-10) {
          tangent = [tdx / tlen, tdy / tlen];
        }
      }
      const fullDx = endV[0] - startV[0];
      const fullDy = endV[1] - startV[1];
      signedDist = fullDx * tangent[0] + fullDy * tangent[1];
    }
  } else if (uniqueType === 'hline' || uniqueType === 'vline') {
    signedDist = uniqueType === 'hline' ? endV[0] - startV[0] : endV[1] - startV[1];
  }

  const initialValue = isConstrained
    ? Math.round((signedDist ?? 0) * 100) / 100
    : undefined;

  const nearAnyEndpoint = startDist < thresholdSq || endDist < thresholdSq;

  let result: HitTestResult | null = null;

  if (endDist < thresholdSq && endDist < bestDistSq) {
    result = {
      hit: {
        sourceLocation, uniqueType: uniqueType || '', hitZone: 'end',
        anchorPoint: startV, fixedVertex: startV,
        initialValue,
        draggedVertices: [endV],
        tangentDir: tangent,
      },
      distSq: endDist,
    };
    bestDistSq = endDist;
  }

  if (uniqueType !== 'tline'
      && child.object?.hasExplicitStart === true
      && !(isConstrained && child.object?.centered === true)
      && startDist < thresholdSq && startDist < bestDistSq) {
    result = {
      hit: {
        sourceLocation, uniqueType: uniqueType || '', hitZone: 'start',
        anchorPoint: startV, fixedVertex: endV,
        originalDistance: signedDist,
        draggedVertices: [startV],
      },
      distSq: startDist,
    };
    bestDistSq = startDist;
  }

  if (!nearAnyEndpoint && uniqueType === 'line-two-points') {
    const bodyDist = pointToSegmentDist(
      point2d[0], point2d[1],
      startV[0], startV[1],
      endV[0], endV[1],
    );
    const bodyDistSq = bodyDist * bodyDist;
    if (bodyDistSq < thresholdSq && bodyDistSq < bestDistSq) {
      result = {
        hit: {
          sourceLocation,
          uniqueType: uniqueType || '',
          hitZone: 'body',
          anchorPoint: startV,
          fixedVertex: endV,
          originalDistance: signedDist,
          initialValue,
          draggedVertices: [startV, endV],
        },
        distSq: bodyDistSq,
      };
    }
  }

  return result;
}

function findArcCenter(child: SceneObjectRender, plane: PlaneData): [number, number] | null {
  for (const sp of child.sceneShapes) {
    if (!sp.isMetaShape) {
      continue;
    }
    for (const md of sp.meshes) {
      if (md.vertices.length === 3 && md.indices.length === 0) {
        const cv = meshToSketch2D(md.vertices, plane);
        if (cv.length === 1) {
          return cv[0];
        }
      }
    }
  }
  return null;
}

function hitTestArc(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  child: SceneObjectRender,
  plane: PlaneData,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const startV = verts2d[0];
  const endV = verts2d[verts2d.length - 1];
  const hasExplicitStart = child.object?.startPoint !== undefined;
  const arcArgCount = hasExplicitStart ? 3 : 2;

  let centerV = findArcCenter(child, plane);

  if (!centerV) {
    const midV = verts2d[Math.floor(verts2d.length / 2)];
    centerV = circumcenter(startV, midV, endV);
  }

  if (!centerV) {
    return null;
  }

  const midV = verts2d[Math.floor(verts2d.length / 2)];
  const arcCCW = isCCW(centerV, startV, midV);

  const sdx = startV[0] - point2d[0];
  const sdy = startV[1] - point2d[1];
  const startDist = sdx * sdx + sdy * sdy;

  const edx = endV[0] - point2d[0];
  const edy = endV[1] - point2d[1];
  const endDist = edx * edx + edy * edy;

  const cdx = centerV[0] - point2d[0];
  const cdy = centerV[1] - point2d[1];
  const centerDist = cdx * cdx + cdy * cdy;

  const minDist = Math.min(startDist, endDist, centerDist);

  let result: HitTestResult | null = null;

  if (hasExplicitStart && startDist < thresholdSq && startDist < bestDistSq && startDist === minDist) {
    result = {
      hit: {
        sourceLocation, uniqueType: 'arc', hitZone: 'start',
        anchorPoint: centerV,
        fixedVertex: endV,
        draggedVertices: [startV],
        arcCCW, arcArgCount,
      },
      distSq: startDist,
    };
    bestDistSq = startDist;
  }
  if (endDist < thresholdSq && endDist < bestDistSq && endDist === minDist) {
    result = {
      hit: {
        sourceLocation, uniqueType: 'arc', hitZone: 'end',
        anchorPoint: centerV,
        fixedVertex: startV,
        draggedVertices: [endV],
        arcCCW, arcArgCount,
      },
      distSq: endDist,
    };
    bestDistSq = endDist;
  }
  if (centerDist < thresholdSq && centerDist < bestDistSq && centerDist === minDist) {
    result = {
      hit: {
        sourceLocation, uniqueType: 'arc', hitZone: 'center',
        anchorPoint: centerV,
        fixedVertex: startV,
        fixedVertex2: endV,
        draggedVertices: [centerV],
        arcCCW, arcArgCount,
      },
      distSq: centerDist,
    };
  }

  return result;
}

function hitTestTangentArc(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  uniqueType: string,
  child: SceneObjectRender,
  plane: PlaneData,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const startV = verts2d[0];
  const endV = verts2d[verts2d.length - 1];

  const tdx = verts2d[1][0] - startV[0];
  const tdy = verts2d[1][1] - startV[1];
  const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
  const tangent: [number, number] = tlen > 1e-10
    ? [tdx / tlen, tdy / tlen]
    : [1, 0];

  let centerV = findArcCenter(child, plane);

  if (!centerV) {
    const midV = verts2d[Math.floor(verts2d.length / 2)];
    centerV = circumcenter(startV, midV, endV);
  }

  const midV = verts2d[Math.floor(verts2d.length / 2)];
  const arcCCW = centerV ? isCCW(centerV, startV, midV) : true;

  const edx = endV[0] - point2d[0];
  const edy = endV[1] - point2d[1];
  const endDist = edx * edx + edy * edy;

  let result: HitTestResult | null = null;

  if (endDist < thresholdSq && endDist < bestDistSq) {
    result = {
      hit: {
        sourceLocation,
        uniqueType: uniqueType || '',
        hitZone: 'end',
        anchorPoint: startV,
        fixedVertex: startV,
        draggedVertices: [endV],
        tangentDir: tangent,
        arcCCW,
      },
      distSq: endDist,
    };
    bestDistSq = endDist;
  }

  if (centerV) {
    const cdx = centerV[0] - point2d[0];
    const cdy = centerV[1] - point2d[1];
    const centerDist = cdx * cdx + cdy * cdy;

    if (centerDist < thresholdSq && centerDist < bestDistSq) {
      result = {
        hit: {
          sourceLocation,
          uniqueType: uniqueType || '',
          hitZone: 'center',
          anchorPoint: startV,
          fixedVertex: startV,
          fixedVertex2: endV,
          draggedVertices: [centerV],
          tangentDir: tangent,
          arcCCW,
        },
        distSq: centerDist,
      };
    }
  }

  return result;
}

function hitTestBezier(
  point2d: [number, number],
  child: SceneObjectRender,
  sourceLocation: { line: number; column: number },
  uniqueType: string,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const start = child.object?.startPoint as [number, number] | null | undefined;
  const resolved = (child.object?.resolvedPoints ?? []) as [number, number][];

  const allPoles: [number, number][] = start ? [start, ...resolved] : resolved;
  if (allPoles.length === 0) {
    return null;
  }

  let result: HitTestResult | null = null;
  for (let i = 0; i < allPoles.length; i++) {
    const p = allPoles[i];
    const dx = p[0] - point2d[0];
    const dy = p[1] - point2d[1];
    const d = dx * dx + dy * dy;
    if (d < thresholdSq && d < bestDistSq) {
      result = {
        hit: {
          sourceLocation,
          uniqueType,
          hitZone: 'end',
          anchorPoint: p,
          draggedVertices: [p],
          bezierPoleIndex: i,
          bezierPoles: allPoles,
        },
        distSq: d,
      };
      bestDistSq = d;
    }
  }
  return result;
}

function hitTestRect(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  child: SceneObjectRender,
  thresholdSq: number,
  bestDistSq: number,
  includeEdges = false,
): HitTestResult | null {
  const rawRadius = child.object?.radius;
  if (rawRadius && !includeEdges) {
    return null;
  }

  const DUP_EPS_SQ = 1e-6;
  const uniqueVerts: [number, number][] = [];
  for (const v of verts2d) {
    let isDup = false;
    for (const u of uniqueVerts) {
      const dx = u[0] - v[0];
      const dy = u[1] - v[1];
      if (dx * dx + dy * dy < DUP_EPS_SQ) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      uniqueVerts.push(v);
    }
  }

  if (uniqueVerts.length < 4) {
    return null;
  }

  const isCentered = child.object?.centered === true;

  let center: [number, number] | undefined;
  if (isCentered) {
    let cx = 0, cy = 0;
    for (const v of uniqueVerts) {
      cx += v[0];
      cy += v[1];
    }
    center = [cx / uniqueVerts.length, cy / uniqueVerts.length];
  }

  let result: HitTestResult | null = null;

  for (const corner of rawRadius ? [] : uniqueVerts) {
    const ddx = corner[0] - point2d[0];
    const ddy = corner[1] - point2d[1];
    const d = ddx * ddx + ddy * ddy;
    if (d < thresholdSq && d < bestDistSq) {
      let anchor: [number, number];
      if (isCentered && center) {
        anchor = center;
      } else {
        let maxDistSq = -1;
        anchor = uniqueVerts[0];
        for (const other of uniqueVerts) {
          const ox = other[0] - corner[0];
          const oy = other[1] - corner[1];
          const od = ox * ox + oy * oy;
          if (od > maxDistSq) {
            maxDistSq = od;
            anchor = other;
          }
        }
      }

      result = {
        hit: {
          sourceLocation,
          uniqueType: 'rect',
          hitZone: 'end',
          anchorPoint: anchor,
          fixedVertex: anchor,
          draggedVertices: [corner],
          rectCentered: isCentered,
        },
        distSq: d,
      };
      bestDistSq = d;
    }
  }

  if (includeEdges && !result) {
    const edgeResult = hitTestRectEdges(point2d, uniqueVerts, sourceLocation, child, isCentered, thresholdSq, bestDistSq);
    if (edgeResult) {
      result = edgeResult;
    }
  }

  return result;
}

type RectCornerInfo = {
  corner: [number, number];
  outward: [number, number];
  radius: number;
  radiusArgOffset: number;
};

// The four visual corners in [bottom-left, bottom-right, top-right, top-left]
// order, each with its fillet radius and the radius's non-array arg offset
// (from the end) within the source `.radius(...)` call. The radius args are
// [bottomLeft, bottomRight, topRight, topLeft] in the rect's own frame, whose
// "left"/"bottom" land on the visually opposite side when the width/height
// is negative.
function rectCornerInfos(
  child: SceneObjectRender,
  minX: number, maxX: number, minY: number, maxY: number,
): RectCornerInfo[] {
  const rawRadius = child.object?.radius;
  const signW = typeof child.object?.width === 'number' && child.object.width < 0 ? -1 : 1;
  const signH = typeof child.object?.height === 'number' && child.object.height < 0 ? -1 : 1;

  const semanticIndex = (visLeft: boolean, visBottom: boolean): number => {
    const left = signW > 0 ? visLeft : !visLeft;
    const bottom = signH > 0 ? visBottom : !visBottom;
    if (bottom) {
      return left ? 0 : 1;
    }
    return left ? 3 : 2;
  };

  const make = (
    corner: [number, number],
    outward: [number, number],
    visLeft: boolean,
    visBottom: boolean,
  ): RectCornerInfo => {
    const index = semanticIndex(visLeft, visBottom);
    let radius = 0;
    let radiusArgOffset = 0;
    if (Array.isArray(rawRadius)) {
      const r = rawRadius[index];
      radius = typeof r === 'number' && r > 0 ? r : 0;
      radiusArgOffset = rawRadius.length - 1 - index;
    } else if (typeof rawRadius === 'number' && rawRadius > 0) {
      radius = rawRadius;
    }
    return { corner, outward, radius, radiusArgOffset };
  };

  return [
    make([minX, minY], [-1, -1], true, true),
    make([maxX, minY], [1, -1], false, true),
    make([maxX, maxY], [1, 1], false, false),
    make([minX, maxY], [-1, 1], true, false),
  ];
}

function hitTestRectEdges(
  point2d: [number, number],
  uniqueVerts: [number, number][],
  sourceLocation: { line: number; column: number },
  child: SceneObjectRender,
  isCentered: boolean,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const v of uniqueVerts) {
    minX = Math.min(minX, v[0]);
    maxX = Math.max(maxX, v[0]);
    minY = Math.min(minY, v[1]);
    maxY = Math.max(maxY, v[1]);
  }

  const corners = rectCornerInfos(child, minX, maxX, minY, maxY);
  const [bl, br, tr, tl] = corners;

  // Sharp corners stay corner-drag handles; a leg hit that close would fight
  // the resize interaction.
  for (const c of corners) {
    if (c.radius > 0) {
      continue;
    }
    const ddx = c.corner[0] - point2d[0];
    const ddy = c.corner[1] - point2d[1];
    if (ddx * ddx + ddy * ddy < thresholdSq) {
      return null;
    }
  }

  let result: HitTestResult | null = null;

  for (const c of corners) {
    if (c.radius <= 0) {
      continue;
    }
    const cx = c.corner[0] - c.outward[0] * c.radius;
    const cy = c.corner[1] - c.outward[1] * c.radius;
    const dx = point2d[0] - cx;
    const dy = point2d[1] - cy;
    if (dx * c.outward[0] < 0 || dy * c.outward[1] < 0) {
      continue;
    }
    const deviation = Math.abs(Math.sqrt(dx * dx + dy * dy) - c.radius);
    const devSq = deviation * deviation;
    if (devSq < thresholdSq && devSq < bestDistSq) {
      result = {
        hit: {
          sourceLocation,
          uniqueType: 'rect',
          hitZone: 'body',
          rectDim: 'radius',
          rectRadiusArgOffset: c.radiusArgOffset,
          initialValue: Math.round(c.radius * 100) / 100,
          rectCentered: isCentered,
        },
        distSq: devSq,
      };
      bestDistSq = devSq;
    }
  }

  const legs: { a: [number, number]; b: [number, number]; dim: 'width' | 'height' }[] = [
    { a: [minX + bl.radius, minY], b: [maxX - br.radius, minY], dim: 'width' },
    { a: [minX + tl.radius, maxY], b: [maxX - tr.radius, maxY], dim: 'width' },
    { a: [minX, minY + bl.radius], b: [minX, maxY - tl.radius], dim: 'height' },
    { a: [maxX, minY + br.radius], b: [maxX, maxY - tr.radius], dim: 'height' },
  ];

  for (const leg of legs) {
    if (leg.a[0] > leg.b[0] || leg.a[1] > leg.b[1]) {
      continue;
    }
    const dist = pointToSegmentDist(point2d[0], point2d[1], leg.a[0], leg.a[1], leg.b[0], leg.b[1]);
    const distSq = dist * dist;
    if (distSq < thresholdSq && distSq < bestDistSq) {
      const objectDim = leg.dim === 'width' ? child.object?.width : child.object?.height;
      const geomDim = leg.dim === 'width' ? maxX - minX : maxY - minY;
      const initialValue = typeof objectDim === 'number'
        ? Math.round(objectDim * 100) / 100
        : Math.round(geomDim * 100) / 100;
      result = {
        hit: {
          sourceLocation,
          uniqueType: 'rect',
          hitZone: 'body',
          rectDim: leg.dim,
          initialValue,
          rectCentered: isCentered,
        },
        distSq,
      };
      bestDistSq = distSq;
    }
  }
  return result;
}

function hitTestPolygon(
  point2d: [number, number],
  verts2d: [number, number][],
  sourceLocation: { line: number; column: number },
  child: SceneObjectRender,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const DUP_EPS_SQ = 1e-6;
  const uniqueVerts: [number, number][] = [];
  for (const v of verts2d) {
    let isDup = false;
    for (const u of uniqueVerts) {
      const dx = u[0] - v[0];
      const dy = u[1] - v[1];
      if (dx * dx + dy * dy < DUP_EPS_SQ) {
        isDup = true;
        break;
      }
    }
    if (!isDup) {
      uniqueVerts.push(v);
    }
  }

  let cx = 0, cy = 0;
  for (const v of uniqueVerts) {
    cx += v[0];
    cy += v[1];
  }
  cx /= uniqueVerts.length;
  cy /= uniqueVerts.length;

  const sample = uniqueVerts[0];
  const sdx = sample[0] - cx;
  const sdy = sample[1] - cy;
  const circumscribedRadius = Math.sqrt(sdx * sdx + sdy * sdy);

  const sides = child.object?.numberOfSides ?? uniqueVerts.length;
  const diameter = child.object?.diameter ?? Math.round(2 * circumscribedRadius * 100) / 100;

  let result: HitTestResult | null = null;
  for (const v of verts2d) {
    const ddx = v[0] - point2d[0];
    const ddy = v[1] - point2d[1];
    const d = ddx * ddx + ddy * ddy;
    if (d < thresholdSq && d < bestDistSq) {
      result = {
        hit: {
          sourceLocation,
          uniqueType: 'polygon',
          hitZone: 'body',
          anchorPoint: [cx, cy],
          initialValue: diameter,
          originalDistance: circumscribedRadius,
          polygonSides: sides,
        },
        distSq: d,
      };
      bestDistSq = d;
    }
  }
  return result;
}

function hitTestSlot(
  point2d: [number, number],
  metaCenters: [number, number][],
  sourceLocation: { line: number; column: number },
  child: SceneObjectRender,
  plane: PlaneData,
  thresholdSq: number,
  bestDistSq: number,
): HitTestResult | null {
  const leftCenter = metaCenters[0];
  const rightCenter = metaCenters[1];
  const hasTwoPoints = child.object?.hasTwoPoints ?? false;
  const radius = child.object?.radius ?? 0;

  const dx = rightCenter[0] - leftCenter[0];
  const dy = rightCenter[1] - leftCenter[1];
  const dist = Math.sqrt(dx * dx + dy * dy);

  let axisDir: [number, number];
  if (!hasTwoPoints) {
    const baseAngle = ((child.object?.angle ?? 0) * Math.PI) / 180;
    axisDir = [Math.cos(baseAngle), Math.sin(baseAngle)];
  } else {
    axisDir = dist > 1e-10 ? [dx / dist, dy / dist] : [1, 0];
  }

  const common = {
    sourceLocation,
    uniqueType: 'slot' as const,
    initialValue: radius,
    slotHasTwoPoints: hasTwoPoints,
    slotAxisDir: axisDir,
    slotRadius: radius,
  };

  function makeStartHit(): DragHitResult {
    return {
      ...common,
      hitZone: 'start',
      anchorPoint: leftCenter,
      fixedVertex: rightCenter,
      slotOtherCenter: rightCenter,
      slotPointIndex: 0,
      draggedVertices: [leftCenter],
    };
  }

  function makeEndHit(): DragHitResult {
    return {
      ...common,
      hitZone: 'end',
      anchorPoint: rightCenter,
      fixedVertex: leftCenter,
      slotOtherCenter: leftCenter,
      slotPointIndex: 1,
      draggedVertices: [rightCenter],
    };
  }

  let result: HitTestResult | null = null;

  // Test meta shape centers first (arc center points)
  const ldx = leftCenter[0] - point2d[0];
  const ldy = leftCenter[1] - point2d[1];
  const leftDist = ldx * ldx + ldy * ldy;

  const rdx = rightCenter[0] - point2d[0];
  const rdy = rightCenter[1] - point2d[1];
  const rightDist = rdx * rdx + rdy * rdy;

  if (leftDist < thresholdSq && leftDist < bestDistSq && leftDist <= rightDist) {
    result = { hit: makeStartHit(), distSq: leftDist };
    bestDistSq = leftDist;
  }

  if (rightDist < thresholdSq && rightDist < bestDistSq) {
    result = { hit: makeEndHit(), distSq: rightDist };
    bestDistSq = rightDist;
  }

  // Test non-meta edge vertices — these are arc/line outline points (radius editing)
  for (const part of child.sceneShapes) {
    if (part.isMetaShape) {
      continue;
    }
    for (const mesh of part.meshes) {
      const verts2d = meshToSketch2D(mesh.vertices, plane);
      for (const v of verts2d) {
        const vdx = v[0] - point2d[0];
        const vdy = v[1] - point2d[1];
        const d = vdx * vdx + vdy * vdy;
        if (d < thresholdSq && d < bestDistSq) {
          result = {
            hit: {
              ...common,
              hitZone: 'body',
              anchorPoint: leftCenter,
              fixedVertex: rightCenter,
              slotOtherCenter: rightCenter,
              slotRadius: radius,
            },
            distSq: d,
          };
          bestDistSq = d;
        }
      }
    }
  }

  return result;
}
