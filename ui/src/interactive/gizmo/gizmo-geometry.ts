import {
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import type { GizmoHandleId } from './gizmo-session';

/** Repo axis colors (connector-mesh convention). */
const X_COLOR = 0xee4444;
const Y_COLOR = 0x44dd44;
const Z_COLOR = 0x4488ff;
const CENTER_COLOR = 0xffffff;

/**
 * Geometry is authored in a fixed "gizmo unit" space and screen-scaled by the
 * core: GIZMO_UNITS gizmo units ≈ the configured pixel size on screen.
 */
export const GIZMO_UNITS = 10;

const SHAFT_RADIUS = 0.14;
const SHAFT_START = 1.2;
const SHAFT_LENGTH = 5.2;
const HEAD_RADIUS = 0.5;
const HEAD_LENGTH = 1.4;
const RING_CENTER = 8.2;
const RING_RADIUS = 1.05;
const RING_TUBE = 0.09;
/** The rotate indicator is an open arc, not a full circle. */
const RING_ARC = Math.PI * 1.5;
const RING_ARROW_RADIUS = 0.22;
const RING_ARROW_LENGTH = 0.55;
const PLANE_SIZE = 0.9;
const PLANE_OFFSET = 2.2;
const CENTER_RADIUS = 0.45;

const HIT_SHAFT_RADIUS = 0.55;
const HIT_RING_TUBE = 0.42;
const HIT_PLANE_SIZE = 1.5;
const HIT_CENTER_RADIUS = 0.9;

/** Everything the gizmo draws on top; above connector triads (1000). */
export const GIZMO_RENDER_ORDER = 1001;

export type GizmoHandleRecord = {
  id: GizmoHandleId;
  group: Group;
  hitMesh: Mesh;
  /** The handle's visible materials — hover/dim state swaps their color/opacity. */
  materials: MeshBasicMaterial[];
  baseColor: number;
  baseOpacity: number;
};

export type GizmoHandleSet = {
  root: Group;
  handles: GizmoHandleRecord[];
  hitMeshes: Mesh[];
  /** A visible mesh whose onBeforeRender drives the screen-constant scaling. */
  scaleHost: Mesh;
};

export type GizmoHandleOptions = {
  arrows?: boolean;
  rings?: boolean;
  planes?: boolean;
  center?: boolean;
};

const UNIT_Y = new Vector3(0, 1, 0);
const UNIT_Z = new Vector3(0, 0, 1);

const AXIS_DIRS: [Vector3, Vector3, Vector3] = [
  new Vector3(1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
];
const AXIS_COLORS = [X_COLOR, Y_COLOR, Z_COLOR];

/**
 * Builds the triad's handle meshes: arrows (translate), rings past the arrow
 * tips (rotate), plane diamonds (plane translate), center sphere (view-plane
 * translate). Every handle group carries a visible mesh set plus an invisible
 * fat hit mesh stamped `userData.gizmoHandle`; the core raycasts the hit
 * meshes directly, so nothing here participates in app picking.
 */
export class GizmoHandleFactory {
  static build(options: GizmoHandleOptions = {}): GizmoHandleSet {
    const root = new Group();
    root.name = 'transformGizmo';
    root.userData.isMetaShape = true;

    const handles: GizmoHandleRecord[] = [];
    const arrows = options.arrows !== false;
    const rings = options.rings !== false;
    const planes = options.planes !== false;
    const center = options.center !== false;

    for (let axis = 0; axis < 3; axis++) {
      if (arrows) {
        handles.push(GizmoHandleFactory.buildArrow(axis as 0 | 1 | 2));
      }
      if (rings) {
        handles.push(GizmoHandleFactory.buildRing(axis as 0 | 1 | 2));
      }
      if (planes) {
        handles.push(GizmoHandleFactory.buildPlane(axis as 0 | 1 | 2));
      }
    }
    if (center) {
      handles.push(GizmoHandleFactory.buildCenter());
    }

    let scaleHost: Mesh | null = null;
    for (const handle of handles) {
      root.add(handle.group);
      if (!scaleHost) {
        const visual = handle.group.children.find(
          (c): c is Mesh => c instanceof Mesh && c.visible,
        );
        scaleHost = visual ?? null;
      }
    }
    root.traverse((child) => {
      child.renderOrder = GIZMO_RENDER_ORDER;
      child.userData.isMetaShape = true;
    });

    if (!scaleHost) {
      throw new Error('transform gizmo built with no visible handles');
    }
    return {
      root,
      handles,
      hitMeshes: handles.map((h) => h.hitMesh),
      scaleHost,
    };
  }

  private static visualMaterial(color: number, opacity: number): MeshBasicMaterial {
    return new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity });
  }

  private static hitMaterial(): MeshBasicMaterial {
    return new MeshBasicMaterial({ visible: false, side: DoubleSide });
  }

  private static record(
    id: GizmoHandleId,
    group: Group,
    hitMesh: Mesh,
    materials: MeshBasicMaterial[],
    baseColor: number,
    baseOpacity: number,
  ): GizmoHandleRecord {
    hitMesh.visible = false;
    hitMesh.userData.gizmoHandle = id;
    group.userData.gizmoHandle = id;
    group.add(hitMesh);
    return { id, group, hitMesh, materials, baseColor, baseOpacity };
  }

  /** Shaft + cone along the axis, hit-tested by one fat cylinder. */
  private static buildArrow(axis: 0 | 1 | 2): GizmoHandleRecord {
    const id = (['tx', 'ty', 'tz'] as const)[axis];
    const color = AXIS_COLORS[axis];
    const material = GizmoHandleFactory.visualMaterial(color, 1);

    const group = new Group();
    group.quaternion.copy(new Quaternion().setFromUnitVectors(UNIT_Y, AXIS_DIRS[axis]));

    const shaft = new Mesh(new CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, SHAFT_LENGTH, 12), material);
    shaft.geometry.translate(0, SHAFT_START + SHAFT_LENGTH / 2, 0);
    group.add(shaft);

    const head = new Mesh(new ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 12), material);
    head.geometry.translate(0, SHAFT_START + SHAFT_LENGTH + HEAD_LENGTH / 2, 0);
    group.add(head);

    const hitLength = SHAFT_LENGTH + HEAD_LENGTH + 0.4;
    const hit = new Mesh(
      new CylinderGeometry(HIT_SHAFT_RADIUS, HIT_SHAFT_RADIUS, hitLength, 8),
      GizmoHandleFactory.hitMaterial(),
    );
    hit.geometry.translate(0, SHAFT_START + hitLength / 2 - 0.2, 0);

    return GizmoHandleFactory.record(id, group, hit, [material], color, 1);
  }

  /**
   * The rotate indicator just past the arrow tip: an open arc encircling
   * the axis, tipped with an arrowhead at each end pointing along the two
   * rotation directions. The invisible hit mesh stays a full torus, so the
   * rotation can be grabbed anywhere around the axis, not only on the
   * drawn arc.
   */
  private static buildRing(axis: 0 | 1 | 2): GizmoHandleRecord {
    const id = (['rx', 'ry', 'rz'] as const)[axis];
    const color = AXIS_COLORS[axis];
    const material = GizmoHandleFactory.visualMaterial(color, 1);

    const group = new Group();
    // The arc lies in its local XY plane (around Z); align Z onto the axis
    // so it encircles it, then slide out along the axis.
    group.quaternion.copy(new Quaternion().setFromUnitVectors(UNIT_Z, AXIS_DIRS[axis]));
    group.position.copy(AXIS_DIRS[axis]).multiplyScalar(RING_CENTER);

    const arc = new Mesh(new TorusGeometry(RING_RADIUS, RING_TUBE, 8, 24, RING_ARC), material);
    group.add(arc);

    // TorusGeometry sweeps counter-clockwise from local +X; each arrowhead
    // continues its end of the arc tangentially outward.
    const addArrowhead = (theta: number, direction: Vector3) => {
      const cone = new Mesh(new ConeGeometry(RING_ARROW_RADIUS, RING_ARROW_LENGTH, 10), material);
      cone.position
        .set(Math.cos(theta) * RING_RADIUS, Math.sin(theta) * RING_RADIUS, 0)
        .addScaledVector(direction, RING_ARROW_LENGTH / 2);
      cone.quaternion.setFromUnitVectors(UNIT_Y, direction);
      group.add(cone);
    };
    addArrowhead(0, new Vector3(0, -1, 0));
    addArrowhead(RING_ARC, new Vector3(-Math.sin(RING_ARC), Math.cos(RING_ARC), 0).normalize());

    const hit = new Mesh(
      new TorusGeometry(RING_RADIUS, HIT_RING_TUBE, 8, 24),
      GizmoHandleFactory.hitMaterial(),
    );

    return GizmoHandleFactory.record(id, group, hit, [material], color, 1);
  }

  /** A 45°-rotated quad between two axes, colored by its plane normal. */
  private static buildPlane(normalAxis: 0 | 1 | 2): GizmoHandleRecord {
    const id = (['pyz', 'pxz', 'pxy'] as const)[normalAxis];
    const color = AXIS_COLORS[normalAxis];
    const material = GizmoHandleFactory.visualMaterial(color, 0.6);
    material.side = DoubleSide;

    const group = new Group();
    group.quaternion.copy(new Quaternion().setFromUnitVectors(UNIT_Z, AXIS_DIRS[normalAxis]));

    const diamond = new Mesh(new PlaneGeometry(PLANE_SIZE, PLANE_SIZE), material);
    diamond.rotation.z = Math.PI / 4;
    diamond.position.set(PLANE_OFFSET, PLANE_OFFSET, 0);
    group.add(diamond);

    const hit = new Mesh(new PlaneGeometry(HIT_PLANE_SIZE, HIT_PLANE_SIZE), GizmoHandleFactory.hitMaterial());
    hit.rotation.z = Math.PI / 4;
    hit.position.set(PLANE_OFFSET, PLANE_OFFSET, 0);

    return GizmoHandleFactory.record(id, group, hit, [material], color, 0.6);
  }

  /** The origin sphere — view-plane free translate. */
  private static buildCenter(): GizmoHandleRecord {
    const material = GizmoHandleFactory.visualMaterial(CENTER_COLOR, 1);
    const group = new Group();
    const ball = new Mesh(new SphereGeometry(CENTER_RADIUS, 16, 12), material);
    group.add(ball);
    const hit = new Mesh(new SphereGeometry(HIT_CENTER_RADIUS, 12, 8), GizmoHandleFactory.hitMaterial());
    return GizmoHandleFactory.record('center', group, hit, [material], CENTER_COLOR, 1);
  }
}
