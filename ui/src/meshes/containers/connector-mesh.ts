import {
  Camera,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { ConnectorData, SceneObjectRender, Vec3Data } from '../../types';

function computeViewScale(camera: Camera, position: Vector3, factor: number): number {
  if (camera instanceof OrthographicCamera) {
    const viewHeight = (camera.top - camera.bottom) / camera.zoom;
    return viewHeight * factor;
  } else if (camera instanceof PerspectiveCamera) {
    const dist = camera.position.distanceTo(position);
    const vFov = camera.fov * Math.PI / 180;
    const viewHeight = 2 * dist * Math.tan(vFov / 2);
    return viewHeight * factor;
  }
  return 1;
}

const X_COLOR = '#e44';
const Y_COLOR = '#4d4';
const Z_COLOR = '#48f';
const ORIGIN_COLOR = '#fff';

const X_LENGTH = 6;
const Y_LENGTH = 4;
const Z_LENGTH = 8;
const SHAFT_RADIUS = 0.25;
const HEAD_LENGTH = 1.5;
const HEAD_RADIUS = 0.6;
const ORIGIN_RADIUS = 0.6;
const DISC_COLOR = '#fa0';
const DISC_RADIUS = 2.8;
const DISC_RIM_WIDTH = 0.2;
const DISC_OPACITY = 0.35;
const VIEW_SCALE_FACTOR = 0.006;

function toVec3(v: Vec3Data): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/** The frame a gizmo stands on — the connector's serialized axes. */
export type ConnectorFrameData = {
  origin: Vec3Data;
  xDirection: Vec3Data;
  yDirection: Vec3Data;
  normal: Vec3Data;
};

function buildAxis(length: number, color: string, withHead: boolean, opacity: number): Group {
  const material = new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity });
  const group = new Group();

  const shaftLength = withHead ? length - HEAD_LENGTH : length;
  const shaft = new Mesh(
    new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, shaftLength, 12),
    material,
  );
  shaft.geometry.translate(0, shaftLength / 2, 0);
  group.add(shaft);

  if (withHead) {
    const head = new Mesh(
      new ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 12),
      material,
    );
    head.geometry.translate(0, shaftLength + HEAD_LENGTH / 2, 0);
    group.add(head);
  }

  return group;
}

/**
 * The RGB axis triad + white origin ball a connector renders as, positioned
 * on `frame` and screen-scaled against the camera on every draw. Shared by
 * the settled scene gizmo ({@link ConnectorMesh}) and the connector tool's
 * translucent suggestion/preview ghost — `opacity` is the only difference.
 */
export function buildConnectorGizmo(frame: ConnectorFrameData, camera: Camera, opts: { opacity?: number } = {}): Group {
  const gizmo = new Group();
  const opacity = opts.opacity ?? 1;

  const origin = toVec3(frame.origin);
  const xDir = toVec3(frame.xDirection).normalize();
  const yDir = toVec3(frame.yDirection).normalize();
  const zDir = toVec3(frame.normal).normalize();

  const upY = new Vector3(0, 1, 0);

  const xAxis = buildAxis(X_LENGTH, X_COLOR, false, opacity);
  xAxis.quaternion.copy(new Quaternion().setFromUnitVectors(upY, xDir));
  gizmo.add(xAxis);

  const yAxis = buildAxis(Y_LENGTH, Y_COLOR, false, opacity);
  yAxis.quaternion.copy(new Quaternion().setFromUnitVectors(upY, yDir));
  gizmo.add(yAxis);

  const zAxis = buildAxis(Z_LENGTH, Z_COLOR, true, opacity);
  zAxis.quaternion.copy(new Quaternion().setFromUnitVectors(upY, zDir));
  gizmo.add(zAxis);

  // Filled disc in the connector's XY plane, with an opaque rim for contrast.
  const discOrient = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), zDir);
  const disc = new Mesh(
    new CircleGeometry(DISC_RADIUS, 32),
    new MeshBasicMaterial({
      color: DISC_COLOR,
      depthTest: false,
      transparent: true,
      opacity: opacity * DISC_OPACITY,
      side: DoubleSide,
    }),
  );
  disc.quaternion.copy(discOrient);
  gizmo.add(disc);

  const rim = new Mesh(
    new RingGeometry(DISC_RADIUS - DISC_RIM_WIDTH, DISC_RADIUS, 32),
    new MeshBasicMaterial({
      color: DISC_COLOR,
      depthTest: false,
      transparent: true,
      opacity,
      side: DoubleSide,
    }),
  );
  rim.quaternion.copy(discOrient);
  gizmo.add(rim);

  const originBall = new Mesh(
    new SphereGeometry(ORIGIN_RADIUS, 16, 12),
    new MeshBasicMaterial({ color: ORIGIN_COLOR, depthTest: false, transparent: true, opacity }),
  );
  gizmo.add(originBall);

  gizmo.position.copy(origin);
  gizmo.scale.setScalar(computeViewScale(camera, gizmo.position, VIEW_SCALE_FACTOR));

  // Render on top so the gizmo isn't hidden inside surrounding geometry.
  gizmo.traverse(child => { child.renderOrder = 1000; });

  originBall.onBeforeRender = (_renderer, _scene, cam) => {
    // `highlight` is the hover-feedback multiplier the assembly controller
    // sets while a mate dialog is picking connectors; the scale must be
    // re-derived here every draw, so the multiplier rides userData.
    const highlight = typeof gizmo.userData.highlight === 'number' ? gizmo.userData.highlight : 1;
    gizmo.scale.setScalar(computeViewScale(cam, gizmo.position, VIEW_SCALE_FACTOR) * highlight);
    gizmo.updateMatrixWorld(true);
  };

  return gizmo;
}

export class ConnectorMesh extends Group {
  constructor(sceneObject: SceneObjectRender, camera: Camera) {
    super();

    const data = sceneObject.object as ConnectorData | undefined;
    if (!data || !data.origin || !data.normal || !data.xDirection || !data.yDirection) {
      return;
    }

    this.userData.isMetaShape = true;
    this.userData.isConnector = true;
    this.userData.connectorId = sceneObject.id;
    this.userData.hostShapeIds = data.hostShapeIds ?? [];

    this.add(buildConnectorGizmo(data, camera));
  }
}
