import { Axis } from "../math/axis.js";
import { Plane } from "../math/plane.js";
import type { AxisLazySource } from "../math/lazy-matrix.js";
import { Connector } from "./connector.js";

/**
 * A connector standing in for an axis: its Z axis through its origin. A
 * `copy()` handed a connector where the axis goes walks along or turns
 * around that line, the way Onshape takes a mate connector's primary axis
 * as a pattern axis. It joins the world axes, `axis()` features and edges
 * a 3D copy already takes.
 *
 * Not a scene object: the connector already is one, declared (and so built)
 * before any statement that names it, and the axis is read off its frame
 * only when the copy's moves resolve at build time. So it adds no timeline
 * row, no dashed line, and nothing an assembly scene would have to host.
 */
export class ConnectorAxis implements AxisLazySource {
  constructor(readonly connector: Connector) {}

  getAxis(): Axis {
    return ConnectorAxis.of(this.connector);
  }

  compareTo(other: unknown): boolean {
    return other instanceof ConnectorAxis && this.connector.compareTo(other.connector);
  }

  /**
   * The axis a built connector stands for: its frame's Z axis. The copy
   * ghost reads a rendered connector through this too, so the preview
   * follows the rule the statement builds with.
   */
  static of(connector: Connector): Axis {
    let frame: Plane;
    try {
      frame = connector.getFrame();
    } catch {
      throw new Error(`copy(): ${connector.label()} did not build, so it gives no axis to copy along`);
    }
    return frame.zAxis;
  }
}
