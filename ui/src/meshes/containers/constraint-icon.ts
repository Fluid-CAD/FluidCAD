import {
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Vector3,
} from 'three';
import { PlaneData, SceneObjectPart, SceneObjectRender, Vec3Data } from '../../types';
import { worldToSketch2D } from '../../interactive/sketch-plane-utils';
import { pixelScale, pixelsToWorld } from '../screen-scale';
import { themeColors } from '../../scene/theme-colors';

const CONSTRAINT_LABELS: Record<string, string> = {
  'hline': 'H',
  'vline': 'V',
  'tarc-to-point': 'T',
  'tarc-to-point-tangent': 'T',
  'tarc-with-tangent': 'T',
};

const TARC_TYPES = new Set(['tarc-to-point', 'tarc-to-point-tangent', 'tarc-with-tangent']);

const ICON_OFFSET_PX = 28;
const ICON_PLANE_SIZE = 5;
const ICON_PX_SIZE = 24;
const CANVAS_SIZE = 64;
const ICON_RENDER_ORDER = 3;

const textureCache = new Map<string, CanvasTexture>();

function getIconTexture(letter: string, colorHex: string): CanvasTexture {
  const key = `${letter}|${colorHex}`;
  const cached = textureCache.get(key);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;

  const stroke = 4;
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
  ctx.lineWidth = stroke;
  ctx.strokeStyle = colorHex;
  ctx.stroke();

  ctx.fillStyle = colorHex;
  ctx.font = `${CANVAS_SIZE * 0.55}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, CANVAS_SIZE / 2, CANVAS_SIZE / 2);

  const texture = new CanvasTexture(canvas);
  textureCache.set(key, texture);
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
): Group {
  const texture = getIconTexture(letter, `#${themeColors.constraintColor.getHexString()}`);
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
      icons.push(createIconMesh(letter, sample.position, perpendicular, plane, normal));
    }
  }

  return icons;
}
