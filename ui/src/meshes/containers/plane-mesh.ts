import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { SceneObjectMesh, SceneObjectRender, Vec3Data } from '../../types';
import { applyConstantPixelSize } from '../screen-scale';

const PLANE_COLOR = '#ffc26c';
const EDGE_COLOR = '#c88f40';
const ARROW_COLOR = '#c88f40';
export const PLANE_OPACITY = 0.1;
const ARROW_LENGTH = 20;
const ARROW_HEAD_LENGTH = 3;
const ARROW_HEAD_WIDTH = 1.5;
const ARROW_SHAFT_RADIUS = 0.4;
const ARROW_PX_LENGTH = 96;

/** How a construction plane is drawn, wherever it is drawn. */
export type PlaneVisualOptions = {
  /** Face opacity; the dialog ghost draws a touch stronger than a settled plane. */
  opacity?: number;
  /** Makes the quad pickable through the viewer's plane-pick channel. */
  shapeId?: string;
};

/**
 * Draw a construction plane into `group`: the translucent yellow quad, its
 * outline, and the normal arrow standing at `center`. Filled once here and
 * used twice — by {@link PlaneMesh} for a plane the scene holds, and by the
 * feature ghost for the plane a dialog would create — so a live preview reads
 * as the very thing it is about to become.
 *
 * The arrow keeps a constant on-screen length: it says which way the plane
 * faces, and that has to stay legible at every zoom.
 */
export function buildPlaneVisual(
  group: Group,
  mesh: SceneObjectMesh,
  normal: Vec3Data,
  center: Vec3Data,
  options: PlaneVisualOptions = {},
): void {
  group.userData.isMetaShape = true;
  group.userData.isConstructionPlane = true;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(mesh.vertices), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(mesh.normals), 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array(mesh.indices), 1));
  geometry.computeBoundingBox();

  // Translucent face
  const face = new Mesh(
    geometry,
    new MeshBasicMaterial({
      color: PLANE_COLOR,
      transparent: true,
      opacity: options.opacity ?? PLANE_OPACITY,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );

  // Plane quads are pickable only through the viewer's opt-in plane-pick
  // channel (the armed sketch mode) — mark the raycastable quad and address
  // it by its shape id for pick resolution and hover highlighting. The id
  // rides on the quad itself: the group is a meta shape, which the pick
  // resolution walk skips. A ghost passes none, so it never picks.
  if (options.shapeId) {
    face.userData.shapeId = options.shapeId;
    face.userData.isConstructionPlaneQuad = true;
  }

  group.add(face);

  // Sharp outer edges
  const edges = new LineSegments(
    new EdgesGeometry(geometry, 18),
    new LineBasicMaterial({ color: EDGE_COLOR, linewidth: 1 }),
  );
  group.add(edges);

  // Normal direction arrow at the plane origin
  const dir = new Vector3(normal.x, normal.y, normal.z).normalize();
  const originPos = new Vector3(center.x, center.y, center.z);
  const arrowMaterial = new MeshBasicMaterial({ color: ARROW_COLOR });

  const shaftLength = ARROW_LENGTH - ARROW_HEAD_LENGTH;
  const shaftGeometry = new CylinderGeometry(ARROW_SHAFT_RADIUS, ARROW_SHAFT_RADIUS, shaftLength, 8);
  shaftGeometry.translate(0, shaftLength / 2, 0);
  const shaft = new Mesh(shaftGeometry, arrowMaterial);

  const headGeometry = new ConeGeometry(ARROW_HEAD_WIDTH, ARROW_HEAD_LENGTH, 8);
  headGeometry.translate(0, shaftLength + ARROW_HEAD_LENGTH / 2, 0);
  const head = new Mesh(headGeometry, arrowMaterial);

  const arrowGroup = new Group();
  arrowGroup.add(shaft);
  arrowGroup.add(head);

  // Rotate from default Y-up to the normal direction
  const up = new Vector3(0, 1, 0);
  const quaternion = new Quaternion().setFromUnitVectors(up, dir);
  arrowGroup.quaternion.copy(quaternion);
  arrowGroup.position.copy(originPos);

  // Attach the size hook to the shaft (opaque) so the scale is applied before
  // the arrow renders, not on the face (transparent, which renders after opaques).
  applyConstantPixelSize(shaft, arrowGroup, arrowGroup.position, ARROW_PX_LENGTH, ARROW_LENGTH);

  group.add(arrowGroup);

  group.position.z = 0.01; // slight offset to avoid z-fighting
}

export class PlaneMesh extends Group {
  constructor(sceneObject: SceneObjectRender, _camera: Camera) {
    super();

    const shape = sceneObject.sceneShapes[0];
    const meshData = shape?.meshes[0];
    if (!meshData)  {
      return;
    }

    buildPlaneVisual(
      this,
      meshData,
      sceneObject.object.normal,
      sceneObject.object.center,
      { shapeId: shape.shapeId },
    );
  }
}
