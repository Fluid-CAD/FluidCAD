import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Plane } from "../math/plane.js";
import { Vertex } from "../common/vertex.js";
import { AnchoredLazyVertex } from "./anchored-vertex.js";
import { ConnectorInput, ConnectorOptions, frameFromSource, sourceSubShape } from "./connector-frame.js";
import { Shape } from "../common/shape.js";
import { TopologyIndex } from "../oc/topology-index.js";
import { IConnector } from "../core/interfaces.js";
import { rad } from "../helpers/math-helpers.js";

const FRAME_STATE_KEY = 'connector-frame';
/** The body the source face/edge/vertex belonged to when the connector built — see {@link Connector.getHostShape}. */
const HOST_STATE_KEY = 'connector-host';

/**
 * The scene body carrying `sub` among the objects built before the connector
 * (its part only). A plane- or point-sourced connector has none.
 */
function findHostShape(sub: Shape | null, context: BuildSceneObjectContext | undefined): Shape | null {
  if (!sub || !context) {
    return null;
  }
  for (const obj of context.getActiveSceneObjects()) {
    for (const candidate of obj.getShapes()) {
      if (candidate !== sub && TopologyIndex.containsSubShape(candidate.getShape(), sub.getShape())) {
        return candidate;
      }
    }
  }
  return null;
}

type ConnectorTransform =
  | { kind: "rotate"; axis: "x" | "y" | "z"; angle: number }
  | { kind: "offset"; x: number; y: number; z: number };

function applyConnectorTransform(frame: Plane, t: ConnectorTransform): Plane {
  if (t.kind === "rotate") {
    const axis =
      t.axis === "x" ? frame.xAxis :
      t.axis === "y" ? frame.yAxis :
                       frame.zAxis;
    // Public API takes degrees (matching `Plane.transform` / `rotate(angle)` DSL);
    // Plane.rotateAroundAxis expects radians.
    return frame.rotateAroundAxis(axis, rad(t.angle));
  }
  const delta = frame.xDirection.multiply(t.x)
    .add(frame.yDirection.multiply(t.y))
    .add(frame.normal.multiply(t.z));
  return frame.translateVector(delta);
}

export class Connector extends SceneObject implements IConnector {
  private transforms: ConnectorTransform[] = [];

  constructor(
    public connectorName: string,
    public sourceShape: ConnectorInput,
    public options: ConnectorOptions = {},
  ) {
    super();
    this.name(connectorName);
  }

  rotate(axis: "x" | "y" | "z", angle: number): this {
    this.transforms.push({ kind: "rotate", axis, angle });
    return this;
  }

  offset(x: number, y: number = 0, z: number = 0): this {
    this.transforms.push({ kind: "offset", x, y, z });
    return this;
  }

  build(context?: BuildSceneObjectContext) {
    let frame = frameFromSource(this.sourceShape, this.options);
    for (const t of this.transforms) {
      frame = applyConnectorTransform(frame, t);
    }
    this.setState(FRAME_STATE_KEY, frame);
    // Resolved before the source is consumed below — a consumed selection
    // reads as empty. The as-built host is what the render pass walks forward
    // (attachConnectorHosts) to the body actually on screen.
    this.setState(HOST_STATE_KEY, findHostShape(sourceSubShape(this.sourceShape), context));

    // The connector consumes its source — the face/edge/vertex selection
    // (or lazy edge) was used purely to derive the frame, and the frame
    // now lives on the connector. Mirrors plane-from-object / axis-from-edge.
    (this.sourceShape as SceneObject).removeShapes(this);
    if (this.sourceShape instanceof AnchoredLazyVertex) {
      // Anchored vertices wrap an inline selection (`e.endFaces().center()`)
      // whose highlight shapes would otherwise linger — consume through.
      this.sourceShape.getSourceSelection().removeShapes(this);
    }

    const center = Vertex.fromPoint(frame.origin);
    center.markAsMetaShape();
    this.addShape(center);
  }

  getFrame(): Plane {
    const frame = this.getState(FRAME_STATE_KEY) as Plane | undefined;
    if (!frame) {
      throw new Error("Connector: getFrame() called before build().");
    }
    return frame;
  }

  /**
   * The body the connector sits on, as it was when the connector built —
   * later features may have replaced it (a fillet after the connector), so
   * consumers walk the removal lineage forward from here. Null for a
   * connector on a plane or a bare point, and before build().
   */
  getHostShape(): Shape | null {
    return (this.getState(HOST_STATE_KEY) as Shape | undefined) ?? null;
  }

  override getDependencies(): SceneObject[] {
    return [this.sourceShape];
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    const copy = new Connector(this.connectorName, this.sourceShape, this.options);
    copy.transforms = [...this.transforms];
    return copy;
  }

  compareTo(other: Connector): boolean {
    if (!(other instanceof Connector)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.connectorName !== other.connectorName) {
      return false;
    }
    if (!(this.sourceShape as SceneObject).compareTo(other.sourceShape as SceneObject)) {
      return false;
    }
    if (JSON.stringify(this.options) !== JSON.stringify(other.options)) {
      return false;
    }
    if (JSON.stringify(this.transforms) !== JSON.stringify(other.transforms)) {
      return false;
    }
    return true;
  }

  getType(): string {
    return "connector";
  }

  serialize() {
    const frame = this.getState(FRAME_STATE_KEY) as Plane | undefined;
    if (!frame) {
      return { name: this.connectorName };
    }
    return {
      name: this.connectorName,
      origin: frame.origin,
      xDirection: frame.xDirection,
      yDirection: frame.yDirection,
      normal: frame.normal,
    };
  }

  boundTo(instanceId: string): BoundConnector {
    return new BoundConnector(this, instanceId);
  }
}

export class BoundConnector {
  constructor(
    public readonly connector: Connector,
    public readonly instanceId: string,
  ) {}

  getFrame(): Plane {
    return this.connector.getFrame();
  }
}
