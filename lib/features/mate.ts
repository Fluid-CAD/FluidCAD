import { AssemblyMate, MateType } from "../rendering/assembly-scene.js";
import { BoundConnector, Connector } from "./connector.js";
import { BoundExposure } from "./exposed.js";
import { SourceLocation } from "../common/scene-object.js";

export class MateBuilder {
  constructor(private readonly mate: AssemblyMate) {}

  flip(): this {
    this.rejectOnTangent('flip()', 'contact side is canonical from the B-rep face orientation, so there is no side to flip');
    this.ensureOptions().flip = !this.mate.options!.flip;
    return this;
  }

  rotate(deg: number): this {
    this.rejectOnTangent(`rotate(${deg})`, 'a tangent mate has no joint frame to rotate in');
    const opts = this.ensureOptions();
    opts.rotate = (opts.rotate ?? 0) + deg;
    return this;
  }

  offset(x: number, y: number = 0, z: number = 0): this {
    this.rejectOnTangent(`offset(${x}, ${y}, ${z})`, 'a tangent mate has no joint frame to offset in — a future .gap(d) would set tangency at a distance');
    if (
      (this.mate.type === "slider" || this.mate.type === "cylindrical")
      && (x !== 0 || y !== 0)
    ) {
      throw new Error(
        `mate('${this.mate.type}').offset(${x}, ${y}, ${z}) — ${this.mate.type} offsets must be along Z (0, 0, d). The connectors share an axis (PT_ON_LINE along Z); an XY offset would contradict that on-axis constraint.`,
      );
    }
    if (this.mate.type === "planar" && (x !== 0 || y !== 0)) {
      throw new Error(
        `mate('planar').offset(${x}, ${y}, ${z}) — planar offsets must be along Z (0, 0, d). The XY directions are the mate's free in-plane DOFs; pinning them with an offset would conflict with the slide/spin the user can drag.`,
      );
    }
    this.ensureOptions().offset = [x, y, z];
    return this;
  }

  limits(min: number, max: number): this {
    if (this.mate.type !== "slider" && this.mate.type !== "revolute") {
      throw new Error(
        `mate('${this.mate.type}').limits(${min}, ${max}) — motion limits are only supported on 'slider' (travel along Z, in mm) and 'revolute' (hinge angle about Z, in degrees) mates.`,
      );
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      throw new Error(
        `mate('${this.mate.type}').limits(${min}, ${max}) — both limits must be finite numbers.`,
      );
    }
    if (min >= max) {
      throw new Error(
        `mate('${this.mate.type}').limits(${min}, ${max}) — min must be strictly less than max.`,
      );
    }
    this.ensureOptions().limits = [min, max];
    return this;
  }

  /**
   * Tangent only: restrict the contact to the picked seed face/edge instead
   * of its whole tangent-continuous chain (propagation is on by default).
   */
  noPropagate(): this {
    if (this.mate.type !== "tangent") {
      throw new Error(
        `mate('${this.mate.type}').noPropagate() — tangent propagation only applies to 'tangent' mates.`,
      );
    }
    this.ensureOptions().propagate = false;
    return this;
  }

  private rejectOnTangent(call: string, why: string): void {
    if (this.mate.type === "tangent") {
      throw new Error(`mate('tangent').${call} — not supported on tangent mates: ${why}.`);
    }
  }

  private ensureOptions() {
    if (!this.mate.options) {
      this.mate.options = {};
    }
    return this.mate.options;
  }
}

export function makeAssemblyMate(
  type: MateType,
  a: BoundConnector | Connector,
  b: BoundConnector | Connector,
  mateId: string,
  owner: string,
  sourceLocation: SourceLocation | undefined,
): AssemblyMate {
  // Hold live Connector references — see AssemblyMate's docs for why
  // snapshotting `.id` here would go stale across SceneCompare runs.
  // Assembly-connector sides hold the bare Connector (mate() already
  // rejected the both-frames case).
  return {
    mateId,
    owner,
    type,
    connectorA: a instanceof BoundConnector
      ? { instanceId: a.instanceId, connector: a.connector }
      : undefined,
    connectorB: b instanceof BoundConnector
      ? { instanceId: b.instanceId, connector: b.connector }
      : undefined,
    frameA: a instanceof Connector ? { connector: a } : undefined,
    frameB: b instanceof Connector ? { connector: b } : undefined,
    options: {},
    sourceLocation,
  };
}

export function makeTangentAssemblyMate(
  a: BoundExposure,
  b: BoundExposure,
  mateId: string,
  owner: string,
  sourceLocation: SourceLocation | undefined,
): AssemblyMate {
  // Live Exposed references for the same staleness reason as connectors.
  return {
    mateId,
    owner,
    type: "tangent",
    geometryA: { instanceId: a.instanceId, exposed: a.exposed },
    geometryB: { instanceId: b.instanceId, exposed: b.exposed },
    options: {},
    sourceLocation,
  };
}
