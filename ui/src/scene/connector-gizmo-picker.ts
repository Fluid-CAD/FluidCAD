import { Camera, Object3D, Vector3 } from 'three';

/** Screen radius a click may miss a connector-gizmo origin by and still pick it. */
export const CONNECTOR_PICK_RADIUS_PX = 22;

/**
 * Gizmos whose origins project this close to the nearest hit are ambiguous
 * with it — an assembly connector placed exactly on a part connector, say —
 * and the click offers them all instead of silently taking the first.
 */
export const CONNECTOR_AMBIGUITY_PX = 6;

/** Hover feedback while picking: the hovered gizmo grows by this factor. */
export const CONNECTOR_HOVER_SCALE = 1.35;

/**
 * One drawn connector gizmo a click can land on: the assembly instance it
 * belongs to (the world body's id for an assembly connector, null in a part
 * scene), the connector scene object's id, and the object standing at the
 * frame's origin.
 */
export type ConnectorGizmoTarget<I extends string | null = string | null> = {
  instanceId: I;
  connectorId: string;
  anchor: Object3D;
};

/** A gizmo under the cursor, with how far its origin projects from it. */
export type ConnectorPickCandidate<I extends string | null = string | null> = {
  instanceId: I;
  connectorId: string;
  distPx: number;
};

/**
 * Connector picking by screen distance — the one rule every connector pick
 * shares, the mate and replicate dialogs' in an assembly and the part
 * dialogs' (the Copy dialog's targets and axis) alike.
 *
 * Gizmos draw depth-test-off on top of everything, so a raycast would be
 * wrong about them twice over: it would let geometry in front hide a gizmo
 * the user plainly sees, and a gizmo is a few pixels of triad anyway. What
 * the user sees under the cursor is the gizmo whose origin projects nearest
 * it, so that is what a click picks — and when several project within
 * {@link CONNECTOR_AMBIGUITY_PX} of each other (coincident gizmos), all of
 * them come back, for the caller to ask which.
 *
 * The caller decides which gizmos are candidates (only drawn ones should be
 * — see {@link ConnectorGizmoPicker.gizmosIn}); the picker only measures.
 */
export class ConnectorGizmoPicker {
  constructor(
    private readonly camera: () => Camera,
    private readonly canvas: HTMLElement,
  ) {}

  /**
   * Every target whose origin projects within `maxPx` of the cursor,
   * nearest first, cut down to the ones within
   * {@link CONNECTOR_AMBIGUITY_PX} of the nearest — the set a click must
   * choose among. Empty when none is close enough, or the canvas has no size.
   */
  candidatesAt<I extends string | null>(
    targets: Iterable<ConnectorGizmoTarget<I>>,
    clientX: number,
    clientY: number,
    maxPx = CONNECTOR_PICK_RADIUS_PX,
  ): ConnectorPickCandidate<I>[] {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return [];
    }
    const camera = this.camera();
    const world = new Vector3();
    const hits: ConnectorPickCandidate<I>[] = [];
    for (const { instanceId, connectorId, anchor } of targets) {
      anchor.getWorldPosition(world).project(camera);
      if (world.z > 1) {
        continue; // behind the camera
      }
      const px = ((world.x + 1) / 2) * rect.width + rect.left;
      const py = ((1 - world.y) / 2) * rect.height + rect.top;
      const distPx = Math.hypot(px - clientX, py - clientY);
      if (distPx <= maxPx) {
        hits.push({ instanceId, connectorId, distPx });
      }
    }
    hits.sort((a, b) => a.distPx - b.distPx);
    if (hits.length === 0) {
      return [];
    }
    const nearest = hits[0].distPx;
    return hits.filter(hit => hit.distPx <= nearest + CONNECTOR_AMBIGUITY_PX);
  }

  /**
   * The drawn connector gizmos under `root`: every node flagged
   * `isConnector` (a ConnectorMesh) whose whole path down from `root` is
   * visible — a hidden ancestor draws nothing, so it picks nothing — each
   * anchored at its gizmo child: the flagged group sits at the part's
   * origin, the gizmo inside it carries the frame's.
   */
  static gizmosIn<I extends string | null>(root: Object3D, instanceId: I): ConnectorGizmoTarget<I>[] {
    const out: ConnectorGizmoTarget<I>[] = [];
    root.traverseVisible((node) => {
      const connectorId = node.userData?.isConnector === true ? node.userData.connectorId : undefined;
      if (typeof connectorId === 'string') {
        out.push({ instanceId, connectorId, anchor: node.children[0] ?? node });
      }
    });
    return out;
  }
}
