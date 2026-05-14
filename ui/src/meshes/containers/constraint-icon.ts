import {
  Camera,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { PlaneData, SceneObjectPart, SceneObjectRender, Vec3Data } from '../../types';
import { localToWorld, worldToSketch2D } from '../../interactive/sketch-plane-utils';
import { computeViewScale } from '../../interactive/tools/tool-preview-utils';

const CONSTRAINT_LABELS: Record<string, string> = {
  'hline': 'H',
  'vline': 'V',
  'tarc-to-point': 'T',
  'tarc-to-point-tangent': 'T',
  'tarc-with-tangent': 'T',
};

const TARC_TYPES = new Set(['tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent']);

const ICON_SCALE_FACTOR = 0.003;
const ICON_MIN_SCALE = 0.5;
const ICON_MAX_SCALE = 4.0;
const ICON_OFFSET = 12;
const ICON_PLANE_SIZE = 5;
const CANVAS_SIZE = 64;
const ICON_RENDER_ORDER = 3;

function clampScale(raw: number): number {
  return Math.max(ICON_MIN_SCALE, Math.min(raw, ICON_MAX_SCALE));
}

const textureCache = new Map<string, CanvasTexture>();

function getIconTexture(letter: string): CanvasTexture {
  const cached = textureCache.get(letter);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;

  const pad = 4;
  const r = 10;
  const x = pad;
  const y = pad;
  const w = CANVAS_SIZE - pad * 2;
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
  ctx.fillStyle = 'rgba(30, 35, 50, 0.8)';
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `${CANVAS_SIZE * 0.55}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, CANVAS_SIZE / 2, CANVAS_SIZE / 2);

  const texture = new CanvasTexture(canvas);
  textureCache.set(letter, texture);
  return texture;
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
  letter: string,
  position: Vector3,
  perpendicular: [number, number],
  plane: PlaneData,
  normal: Vec3Data,
  camera: Camera,
): Group {
  const texture = getIconTexture(letter);
  const geometry = new PlaneGeometry(ICON_PLANE_SIZE, ICON_PLANE_SIZE);
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

  const pos2d = worldToSketch2D(position, plane);
  const offset2d: [number, number] = [
    pos2d[0] + perpendicular[0] * ICON_OFFSET,
    pos2d[1] + perpendicular[1] * ICON_OFFSET,
  ];
  const iconPos = localToWorld(offset2d, plane);
  group.position.copy(iconPos);

  group.up.set(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);
  group.lookAt(new Vector3(
    iconPos.x + normal.x,
    iconPos.y + normal.y,
    iconPos.z + normal.z,
  ));

  group.add(mesh);

  group.scale.setScalar(clampScale(computeViewScale(camera, iconPos, ICON_SCALE_FACTOR)));
  mesh.onBeforeRender = (_r, _s, cam) => {
    group.scale.setScalar(clampScale(computeViewScale(cam, iconPos, ICON_SCALE_FACTOR)));
    group.updateMatrixWorld(true);
  };

  return group;
}

export function buildConstraintIcons(
  sceneObject: SceneObjectRender,
  allObjects: SceneObjectRender[],
  camera: Camera,
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

    const letter = CONSTRAINT_LABELS[obj.uniqueType ?? ''];
    if (!letter) {
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
      icons.push(createIconMesh(letter, sample.position, perpendicular, plane, normal, camera));
    }
  }

  return icons;
}
