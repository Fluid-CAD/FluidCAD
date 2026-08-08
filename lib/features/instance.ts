import { AssemblyInstance } from "../rendering/assembly-scene.js";
import { BoundConnector } from "./connector.js";
import { AxisLike, toAxis } from "../math/axis.js";
import { Quaternion } from "../math/quaternion.js";
import { Vector3d } from "../math/vector3d.js";
import { rad } from "../helpers/math-helpers.js";

/**
 * `Instance.connectors`: every connector the part registered, keyed by the
 * name its `connector('name', …)` statement declared. Names are strings
 * decided at build time, so the type is a plain record.
 */
export type InstanceConnectors<_P = unknown> = Record<string, BoundConnector>;

/**
 * `connectors` is a Record keyed by connector name. Part authors register
 * connectors by name inside `part(name, () => { connector('main', …);
 * connector('bore', …); })`, then assembly code references them as
 * `instance.connectors.main` / `instance.connectors.bore`. Every connector
 * is named, so every connector can be referenced by mates.
 */
export class Instance<P = unknown> {
  readonly connectors: InstanceConnectors<P>;

  constructor(public readonly record: AssemblyInstance) {
    const named = record.part.getNamedConnectors();
    const out: Record<string, BoundConnector> = {};
    for (const [name, c] of Object.entries(named)) {
      out[name] = c.boundTo(record.instanceId);
    }
    this.connectors = out as InstanceConnectors<P>;
  }

  grounded(): this {
    this.record.grounded = true;
    return this;
  }

  name(value: string): this {
    this.record.name = value;
    return this;
  }

  translate(x: number, y: number = 0, z: number = 0): this {
    this.record.position = { x, y, z };
    return this;
  }

  rotate(axis: AxisLike, angleDegrees: number): this {
    const a = toAxis(axis);
    const rotQ = Quaternion.fromAxisAngle(a.direction, rad(angleDegrees));

    const cur = this.record.quaternion;
    const newQ = rotQ.multiply(new Quaternion(cur.x, cur.y, cur.z, cur.w));
    this.record.quaternion = { x: newQ.x, y: newQ.y, z: newQ.z, w: newQ.w };

    const p = this.record.position;
    const offset = new Vector3d(p.x - a.origin.x, p.y - a.origin.y, p.z - a.origin.z);
    const rotated = rotQ.rotateVector(offset);
    this.record.position = {
      x: a.origin.x + rotated.x,
      y: a.origin.y + rotated.y,
      z: a.origin.z + rotated.z,
    };

    return this;
  }
}
