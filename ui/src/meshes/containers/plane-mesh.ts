import {
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import { SceneObjectRender } from '../../types';

const PLANE_COLOR = '#ffc26c';
const EDGE_COLOR = '#c88f40';
const ARROW_COLOR = '#c88f40';
const PLANE_OPACITY = 0.1;
const ARROW_LENGTH = 20;
const ARROW_HEAD_LENGTH = 3;
const ARROW_HEAD_WIDTH = 1.5;
const ARROW_SHAFT_RADIUS = 0.4;

export class PlaneMesh extends Group {
  constructor(sceneObject: SceneObjectRender) {
    super();

    const meshData = sceneObject.sceneShapes[0]?.meshes[0];
    if (!meshData)  {
      return;
    }

    this.userData.isMetaShape = true;

    const normal = sceneObject.object.normal; // { x: number, y: number, z: number }
    const center = sceneObject.object.center; // { x: number, y: number, z: number }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshData.vertices), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(meshData.normals), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(meshData.indices), 1));
    geometry.computeBoundingBox();

    // Translucent face
    const face = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: PLANE_COLOR,
        transparent: true,
        opacity: PLANE_OPACITY,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );

    this.add(face);

    // Sharp outer edges
    const edges = new LineSegments(
      new EdgesGeometry(geometry, 18),
      new LineBasicMaterial({ color: EDGE_COLOR, linewidth: 1 }),
    );
    this.add(edges);

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

    // Keep consistent screen size regardless of zoom level.
    // Attach to the shaft (opaque) so the scale is applied before the arrow renders,
    // not on the face (transparent) which renders after opaque objects.
    shaft.onBeforeRender = (_renderer, _scene, camera) => {
      if (camera instanceof OrthographicCamera) {
        const viewHeight = (camera.top - camera.bottom) / camera.zoom;
        arrowGroup.scale.setScalar(viewHeight * 0.006);
      } else if (camera instanceof PerspectiveCamera) {
        const dist = camera.position.distanceTo(arrowGroup.position);
        const vFov = camera.fov * Math.PI / 180;
        const viewHeight = 2 * dist * Math.tan(vFov / 2);
        arrowGroup.scale.setScalar(viewHeight * 0.006);
      }
      arrowGroup.updateMatrixWorld(true);
    };

    this.add(arrowGroup);

    this.position.z = 0.01; // slight offset to avoid z-fighting
  }
}
