import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { PlaneData, SceneObjectPart, SceneObjectRender, Vec3Data } from '../../types';
import { worldToSketch2D } from '../../interactive/sketch-plane-utils';
import { applyConstantPixelSize, pixelScale, pixelsToWorld } from '../screen-scale';
import { themeColors } from '../../scene/theme-colors';

const CONSTRAINT_LABELS: Record<string, string> = {
  'hline': 'H',
  'vline': 'V',
  'tarc-to-point': 'T',
  'tarc-to-point-tangent': 'T',
  'tarc-with-tangent': 'T',
};

const TARC_TYPES = new Set(['tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent']);

const ICON_OFFSET_PX = 22;
const ICON_PLANE_SIZE = 5;
const ICON_PX_SIZE = 16;
const CANVAS_SIZE = 64;
const ICON_RENDER_ORDER = 3;

// The aline angle indicator: a dimension arc at the segment's start vertex,
// swept from the incoming-tangent reference ray to the line itself.
const ANGLE_ARC_RADIUS = 5;
export const ANGLE_ARC_PX_RADIUS = 26;
export const ANGLE_TEXT_PX_SIZE = 20;
const ANGLE_ARC_SEGMENTS = 32;

/**
 * Polar frame of the aline angle indicator around its start vertex: the arc
 * sweeps from `startAngle` (the incoming-tangent reference ray the statement's
 * angle is measured against) by `sweepRad`. Shared with the double-click hit
 * test so picking matches what is drawn.
 */
export function angleIndicatorFrame(
  angleDeg: number,
  negLen: boolean,
  startTangent2d: [number, number],
): { startAngle: number; sweepRad: number } {
  // Direction of positive serialized length; un-rotating it by the angle
  // recovers the incoming tangent the statement measures against.
  const dir: [number, number] = negLen
    ? [-startTangent2d[0], -startTangent2d[1]]
    : startTangent2d;
  const sweepRad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(-sweepRad);
  const sin = Math.sin(-sweepRad);
  const incoming: [number, number] = [
    dir[0] * cos - dir[1] * sin,
    dir[0] * sin + dir[1] * cos,
  ];
  return { startAngle: Math.atan2(incoming[1], incoming[0]), sweepRad };
}

type IconTexture = { texture: CanvasTexture; aspect: number };

const textureCache = new Map<string, IconTexture>();

const ICON_FONT = `${CANVAS_SIZE * 0.55}px sans-serif`;

function getIconTexture(label: string, colorHex: string): IconTexture {
  const key = `${label}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = ICON_FONT;
  // Multi-character labels (the aline angle) widen the badge to fit.
  const textWidth = measure.measureText(label).width;
  const width = Math.max(CANVAS_SIZE, Math.ceil(textWidth + CANVAS_SIZE * 0.4));

  canvas.width = width;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;

  const stroke = 4;
  const pad = 4;
  const r = 10;
  const x = pad;
  const y = pad;
  const w = width - pad * 2;
  const h = CANVAS_SIZE - pad * 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.lineWidth = stroke;
  ctx.strokeStyle = colorHex;
  ctx.stroke();

  ctx.fillStyle = colorHex;
  ctx.font = ICON_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, CANVAS_SIZE / 2);

  const entry = { texture: new CanvasTexture(canvas), aspect: width / CANVAS_SIZE };
  textureCache.set(key, entry);
  return entry;
}

/** Box-less text texture for the aline angle readout. */
function getTextTexture(text: string, colorHex: string): IconTexture {
  const key = `text:${text}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const font = `${CANVAS_SIZE * 0.7}px sans-serif`;
  const canvas = document.createElement('canvas');
  const measure = canvas.getContext('2d')!;
  measure.font = font;
  const width = Math.max(CANVAS_SIZE, Math.ceil(measure.measureText(text).width + 8));

  canvas.width = width;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = colorHex;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, CANVAS_SIZE / 2);

  const entry = { texture: new CanvasTexture(canvas), aspect: width / CANVAS_SIZE };
  textureCache.set(key, entry);
  return entry;
}

type EdgeSample = { position: Vector3; tangent2d: [number, number] };

function sampleEdge(shape: SceneObjectPart, t: number, plane: PlaneData): EdgeSample | null {
  const segments: { from: Vector3; to: Vector3; length: number }[] = [];
  let totalLength = 0;

  for (const mesh of shape.meshes) {
    const verts = mesh.vertices;
    const indices = mesh.indices;
    for (let k = 0; k < indices.length; k += 2) {
      const ia = indices[k] * 3;
      const ib = indices[k + 1] * 3;
      const from = new Vector3(verts[ia], verts[ia + 1], verts[ia + 2]);
      const to = new Vector3(verts[ib], verts[ib + 1], verts[ib + 2]);
      const len = from.distanceTo(to);
      segments.push({ from, to, length: len });
      totalLength += len;
    }
  }

  if (totalLength < 1e-10 || segments.length === 0) {
    return null;
  }

  const targetLength = totalLength * Math.max(0, Math.min(1, t));
  let accumulated = 0;

  for (const seg of segments) {
    if (accumulated + seg.length >= targetLength || seg === segments[segments.length - 1]) {
      const segT = seg.length > 1e-10 ? (targetLength - accumulated) / seg.length : 0;
      const position = seg.from.clone().lerp(seg.to, segT);

      const from2d = worldToSketch2D(seg.from, plane);
      const to2d = worldToSketch2D(seg.to, plane);
      const dx = to2d[0] - from2d[0];
      const dy = to2d[1] - from2d[1];
      const len = Math.sqrt(dx * dx + dy * dy);
      const tangent2d: [number, number] = len > 1e-10 ? [dx / len, dy / len] : [1, 0];

      return { position, tangent2d };
    }
    accumulated += seg.length;
  }

  return null;
}

function createIconMesh(
  label: string,
  position: Vector3,
  perpendicular: [number, number],
  plane: PlaneData,
  normal: Vec3Data,
): Group {
  const { texture, aspect } = getIconTexture(label, `#${themeColors.constraintColor.getHexString()}`);
  const geometry = new PlaneGeometry(ICON_PLANE_SIZE * aspect, ICON_PLANE_SIZE);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    side: DoubleSide,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = ICON_RENDER_ORDER;

  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;

  const perpWorld = new Vector3(
    plane.xDirection.x * perpendicular[0] + plane.yDirection.x * perpendicular[1],
    plane.xDirection.y * perpendicular[0] + plane.yDirection.y * perpendicular[1],
    plane.xDirection.z * perpendicular[0] + plane.yDirection.z * perpendicular[1],
  );

  group.position.copy(position);

  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(new Vector3(
    position.x + normal.x,
    position.y + normal.y,
    position.z + normal.z,
  ));

  group.add(mesh);

  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const offsetWorld = pixelsToWorld(renderer, camera, position, ICON_OFFSET_PX);
    group.position.set(
      position.x + perpWorld.x * offsetWorld,
      position.y + perpWorld.y * offsetWorld,
      position.z + perpWorld.z * offsetWorld,
    );
    group.scale.setScalar(pixelScale(renderer, camera, position, ICON_PX_SIZE, ICON_PLANE_SIZE));
    group.updateMatrixWorld(true);
  };

  return group;
}

/**
 * The aline constraint indicator: a dimension arc at the start vertex swept
 * from the incoming-tangent reference ray (the direction the statement's
 * angle is measured against) to the line, with the angle readout at mid-arc.
 * Screen-constant size, like the letter badges.
 */
function createAngleIndicator(
  angleDeg: number,
  negLen: boolean,
  position: Vector3,
  startTangent2d: [number, number],
  plane: PlaneData,
  normal: Vec3Data,
): Group {
  const color = themeColors.constraintColor;
  const colorHex = `#${color.getHexString()}`;

  const { startAngle, sweepRad: angleRad } = angleIndicatorFrame(angleDeg, negLen, startTangent2d);
  const incoming: [number, number] = [Math.cos(startAngle), Math.sin(startAngle)];

  const group = new Group();
  group.renderOrder = ICON_RENDER_ORDER;
  group.userData.isConstraintIcon = true;
  group.position.copy(position);
  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(new Vector3(
    position.x + normal.x,
    position.y + normal.y,
    position.z + normal.z,
  ));

  const arcPoints: number[] = [];
  for (let i = 0; i <= ANGLE_ARC_SEGMENTS; i++) {
    const a = startAngle + angleRad * (i / ANGLE_ARC_SEGMENTS);
    arcPoints.push(Math.cos(a) * ANGLE_ARC_RADIUS, Math.sin(a) * ANGLE_ARC_RADIUS, 0);
  }
  const arcGeometry = new BufferGeometry();
  arcGeometry.setAttribute('position', new Float32BufferAttribute(arcPoints, 3));
  const arc = new Line(arcGeometry, new LineBasicMaterial({
    color, transparent: true, opacity: 0.9, depthTest: false,
  }));
  arc.renderOrder = ICON_RENDER_ORDER;
  group.add(arc);

  // Reference ray along the incoming tangent — the previous segment sits on
  // the far side of the vertex, so the ray shows what the arc spans from.
  const rayGeometry = new BufferGeometry();
  rayGeometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0,
    incoming[0] * ANGLE_ARC_RADIUS * 1.35, incoming[1] * ANGLE_ARC_RADIUS * 1.35, 0,
  ], 3));
  const ray = new Line(rayGeometry, new LineBasicMaterial({
    color, transparent: true, opacity: 0.45, depthTest: false,
  }));
  ray.renderOrder = ICON_RENDER_ORDER;
  group.add(ray);

  const label = `${Math.round(angleDeg * 100) / 100}°`;
  const { texture, aspect } = getTextTexture(label, colorHex);
  const textSize = ANGLE_ARC_RADIUS * (ANGLE_TEXT_PX_SIZE / ANGLE_ARC_PX_RADIUS);
  const textMesh = new Mesh(
    new PlaneGeometry(textSize * aspect, textSize),
    new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, side: DoubleSide }),
  );
  textMesh.renderOrder = ICON_RENDER_ORDER;
  const midAngle = startAngle + angleRad / 2;
  const textRadius = ANGLE_ARC_RADIUS + textSize;
  textMesh.position.set(Math.cos(midAngle) * textRadius, Math.sin(midAngle) * textRadius, 0);
  group.add(textMesh);

  applyConstantPixelSize(textMesh, group, position, ANGLE_ARC_PX_RADIUS, ANGLE_ARC_RADIUS);
  return group;
}

export function buildConstraintIcons(
  sceneObject: SceneObjectRender,
  allObjects: SceneObjectRender[],
): Group[] {
  const normal = sceneObject.object?.plane?.normal;
  const plane: PlaneData | undefined = sceneObject.object?.plane;
  if (!normal || !plane) {
    return [];
  }

  const icons: Group[] = [];

  for (const obj of allObjects) {
    if (obj.parentId !== sceneObject.id || !obj.sceneShapes.length) {
      continue;
    }

    if (obj.uniqueType === 'aline') {
      const angle = obj.object?.angle;
      if (typeof angle !== 'number') {
        continue;
      }
      const negLen = typeof obj.object?.length === 'number' && obj.object.length < 0;
      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }
        const sample = sampleEdge(shape, 0, plane);
        if (!sample) {
          continue;
        }
        icons.push(createAngleIndicator(angle, negLen, sample.position, sample.tangent2d, plane, normal));
      }
      continue;
    }

    const label = CONSTRAINT_LABELS[obj.uniqueType ?? ''];
    if (!label) {
      continue;
    }

    const isTarc = TARC_TYPES.has(obj.uniqueType ?? '');

    for (const shape of obj.sceneShapes) {
      if (shape.isMetaShape || shape.isGuide) {
        continue;
      }

      const sample = sampleEdge(shape, isTarc ? 0 : 0.5, plane);
      if (!sample) {
        continue;
      }

      const perpendicular: [number, number] = [-sample.tangent2d[1], sample.tangent2d[0]];
      icons.push(createIconMesh(label, sample.position, perpendicular, plane, normal));
    }
  }

  return icons;
}
