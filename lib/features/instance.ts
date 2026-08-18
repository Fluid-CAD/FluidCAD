import { AssemblyInstance } from "../rendering/assembly-scene.js";
import { BoundConnector } from "./connector.js";
import { BoundExposure } from "./exposed.js";
import { PoseHandle } from "./pose-handle.js";

/**
 * `Instance.connectors`: every connector the part registered, keyed by the
 * name its `connector('name', …)` statement declared. Names are strings
 * decided at build time, so the type is a plain record.
 */
export type InstanceConnectors<_P = unknown> = Record<string, BoundConnector>;

/**
 * `Instance.features`: every exposure the part registered, keyed by its
 * `expose('name', …)` name. Deliberately a different type from
 * `def.features.<name>` (the source SceneObject, authoring-frame refs):
 * the instance level binds the exposure to ONE inserted instance — a mate
 * must know which instance (and thereby which param variant) it touches.
 * Same asymmetry as `connectors`.
 */
export type InstanceFeatures<_P = unknown> = Record<string, BoundExposure>;

/**
 * `connectors` is a Record keyed by connector name. Part authors register
 * connectors by name inside `part(name, () => { connector('main', …);
 * connector('bore', …); })`, then assembly code references them as
 * `instance.connectors.main` / `instance.connectors.bore`. Every connector
 * is named, so every connector can be referenced by mates.
 */
export class Instance<P = unknown> extends PoseHandle<AssemblyInstance> {
  readonly connectors: InstanceConnectors<P>;
  readonly features: InstanceFeatures<P>;

  constructor(record: AssemblyInstance) {
    super(record);
    const named = record.part.getNamedConnectors();
    const out: Record<string, BoundConnector> = {};
    for (const [name, c] of Object.entries(named)) {
      out[name] = c.boundTo(record.instanceId);
    }
    this.connectors = out as InstanceConnectors<P>;

    // `record.part` is the materialized variant for THIS insert, so the
    // bound exposure's geometry is per-variant correct for free — the same
    // reason `connectors` already is.
    const features: Record<string, BoundExposure> = {};
    for (const exposed of record.part.getExposed()) {
      features[exposed.exposeName] = exposed.boundTo(record.instanceId);
    }
    this.features = features as InstanceFeatures<P>;
  }
}
