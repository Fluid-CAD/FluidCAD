import { AssemblyMate, MateType } from "../rendering/assembly-scene.js";
import { BoundConnector } from "./connector.js";
import { SourceLocation } from "../common/scene-object.js";

export class MateBuilder {
  constructor(private readonly mate: AssemblyMate) {}

  flip(): this {
    this.ensureOptions().flip = !this.mate.options!.flip;
    return this;
  }

  rotate(deg: number): this {
    const opts = this.ensureOptions();
    opts.rotate = (opts.rotate ?? 0) + deg;
    return this;
  }

  offset(x: number, y: number = 0, z: number = 0): this {
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

  private ensureOptions() {
    if (!this.mate.options) {
      this.mate.options = {};
    }
    return this.mate.options;
  }
}

export function makeAssemblyMate(
  type: MateType,
  a: BoundConnector,
  b: BoundConnector,
  mateId: string,
  sourceLocation: SourceLocation | undefined,
): AssemblyMate {
  // Hold live Connector references — see AssemblyMate's docs for why
  // snapshotting `.id` here would go stale across SceneCompare runs.
  return {
    mateId,
    type,
    connectorA: { instanceId: a.instanceId, connector: a.connector },
    connectorB: { instanceId: b.instanceId, connector: b.connector },
    options: {},
    sourceLocation,
  };
}
