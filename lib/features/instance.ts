import { AssemblyInstance } from "../rendering/assembly-scene.js";
import { BoundConnector } from "./connector.js";
import { PoseHandle } from "./pose-handle.js";

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
export class Instance<P = unknown> extends PoseHandle<AssemblyInstance> {
  readonly connectors: InstanceConnectors<P>;

  constructor(record: AssemblyInstance) {
    super(record);
    const named = record.part.getNamedConnectors();
    const out: Record<string, BoundConnector> = {};
    for (const [name, c] of Object.entries(named)) {
      out[name] = c.boundTo(record.instanceId);
    }
    this.connectors = out as InstanceConnectors<P>;
  }
}
