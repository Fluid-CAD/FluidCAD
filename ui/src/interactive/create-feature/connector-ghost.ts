import { Group, Object3D, Vector3 } from 'three';
import { buildConnectorGizmo, ConnectorFrameData } from '../../meshes/containers/connector-mesh';
import { Viewer } from '../../viewer';

/** A hover suggestion is a whisper; the locked live preview reads solid. */
const SUGGESTION_OPACITY = 0.35;
const PREVIEW_OPACITY = 0.85;

/**
 * The connector tool's translucent gizmo overlay, two independent layers:
 * the hovered suggestion (faint) and the locked dialog preview (strong).
 * Both can show at once — with a pick locked, hovering other faces/edges
 * still floats their nearest anchor, so the next click can re-lock there.
 * Same visual as the settled scene gizmo — shared via
 * {@link buildConnectorGizmo} — and the same sibling-group/`isMetaShape`
 * placement as {@link FeatureGhostOverlay}, keeping it out of picking,
 * auto-fit, and scene teardown.
 */
export class ConnectorGhostOverlay {
  private suggestionGroup = new Group();
  private previewGroup = new Group();

  constructor(private viewer: Viewer) {
    this.suggestionGroup.name = 'connectorGhostSuggestion';
    this.previewGroup.name = 'connectorGhostPreview';
    for (const group of [this.suggestionGroup, this.previewGroup]) {
      group.userData.isMetaShape = true;
      group.renderOrder = 3;
      this.viewer.sceneContext.scene.add(group);
    }
  }

  showSuggestion(frame: ConnectorFrameData): void {
    this.fill(this.suggestionGroup, frame, SUGGESTION_OPACITY);
  }

  showPreview(frame: ConnectorFrameData): void {
    this.fill(this.previewGroup, frame, PREVIEW_OPACITY);
  }

  clearSuggestion(): void {
    this.empty(this.suggestionGroup);
  }

  clearPreview(): void {
    this.empty(this.previewGroup);
  }

  clear(): void {
    this.clearSuggestion();
    this.clearPreview();
  }

  private fill(group: Group, frame: ConnectorFrameData, opacity: number): void {
    this.empty(group);
    group.add(buildConnectorGizmo(frame, this.viewer.sceneContext.camera, { opacity }));
    this.viewer.sceneContext.requestRender();
  }

  private empty(group: Group): void {
    if (group.children.length === 0) {
      return;
    }
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      disposeTree(child);
    }
    this.viewer.sceneContext.requestRender();
  }
}

/**
 * The dialog's rotate/offset applied to an anchor frame, mirroring the
 * statement's own semantics: `.rotate('<axis>', deg)` spins the frame
 * around its **own** X, Y, or Z axis first (pivoting at the origin), then
 * `.offset(x, y, z)` walks along the **rotated** axes.
 */
export function adjustConnectorFrame(
  frame: ConnectorFrameData,
  rotate: { axis: 'x' | 'y' | 'z'; angle: number },
  offset: [number, number, number],
): ConnectorFrameData {
  const origin = new Vector3(frame.origin.x, frame.origin.y, frame.origin.z);
  let normal = new Vector3(frame.normal.x, frame.normal.y, frame.normal.z).normalize();
  let xDir = new Vector3(frame.xDirection.x, frame.xDirection.y, frame.xDirection.z).normalize();
  let yDir = new Vector3(frame.yDirection.x, frame.yDirection.y, frame.yDirection.z).normalize();

  if (rotate.angle % 360 !== 0) {
    const axis = rotate.axis === 'x' ? xDir.clone()
      : rotate.axis === 'y' ? yDir.clone()
      : normal.clone();
    const angle = (rotate.angle * Math.PI) / 180;
    // The pivot axis maps onto itself; rotating all three keeps it simple.
    xDir = xDir.clone().applyAxisAngle(axis, angle);
    yDir = yDir.clone().applyAxisAngle(axis, angle);
    normal = normal.clone().applyAxisAngle(axis, angle);
  }

  origin.addScaledVector(xDir, offset[0]);
  origin.addScaledVector(yDir, offset[1]);
  origin.addScaledVector(normal, offset[2]);

  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    xDirection: { x: xDir.x, y: xDir.y, z: xDir.z },
    yDirection: { x: yDir.x, y: yDir.y, z: yDir.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
  };
}

function disposeTree(root: Object3D): void {
  root.traverse((node: Object3D & { geometry?: { dispose?: () => void }; material?: any }) => {
    node.geometry?.dispose?.();
    const material = node.material;
    if (Array.isArray(material)) {
      material.forEach(m => m?.dispose?.());
    } else {
      material?.dispose?.();
    }
  });
}
