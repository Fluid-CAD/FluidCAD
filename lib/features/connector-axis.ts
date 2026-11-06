import { Axis } from "../math/axis.js";
import { Plane } from "../math/plane.js";
import type { AxisLazySource } from "../math/lazy-matrix.js";
import { Connector } from "./connector.js";

/**
 * A connector standing in for an axis: its Z axis through its origin. Every
 * statement that takes an axis takes a connector there too — a `connector()`
 * variable or one of its copies (`bolt.instance(2)`) — the way Onshape takes
 * a mate connector's primary axis. This class is the one reading of that
 * rule: {@link connectorOf} tells a connector argument apart, {@link axisOf}
 * reads its axis off the built frame.
 *
 * An instance is the lazy form a `copy()` keeps for its moves. Not a scene
 * object: the connector already is one, declared (and so built) before any
 * statement that names it, and the axis is read off its frame only when the
 * copy's moves resolve at build time. So it adds no timeline row, no dashed
 * line, and nothing an assembly scene would have to host. The statements
 * that hold a scene object for their axis (revolve, rotate, helix, repeat,
 * a custom feature's axis value) hold an `AxisFromConnector` instead, which
 * reads through here too.
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
   * The connector an axis argument names — a declared connector or one of
   * its copies — or null when the argument is something else. (An inserted
   * instance's connector is the copy statement's own business: see
   * `ConnectorCopyRules.boundAxis`.)
   */
  static connectorOf(value: unknown): Connector | null {
    return value instanceof Connector ? value : null;
  }

  /**
   * The axis a built connector stands for: its frame's Z axis through its
   * origin. Throws, naming the connector, when it did not build.
   */
  static axisOf(connector: Connector): Axis {
    let frame: Plane;
    try {
      frame = connector.getFrame();
    } catch {
      throw new Error(`${connector.label()} did not build, so it gives no axis`);
    }
    return frame.zAxis;
  }

  /**
   * {@link axisOf} as a copy reads it — its message says what the axis was
   * for. The copy ghost reads a rendered connector through this too, so the
   * preview follows the rule the statement builds with.
   */
  static of(connector: Connector): Axis {
    try {
      return ConnectorAxis.axisOf(connector);
    } catch {
      throw new Error(`copy(): ${connector.label()} did not build, so it gives no axis to copy along`);
    }
  }
}
