import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyInstance } from "../rendering/assembly-scene.js";
import { BoundConnector } from "./connector.js";
import { InstanceSelectSceneObject } from "./instance-select.js";
import { PoseHandle } from "./pose-handle.js";
import { Shape } from "../common/shapes.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { ISelect } from "../core/interfaces.js";

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

  /**
   * An instance-scoped selection: resolves exactly like `select(...)` inside
   * this instance's part() block, but carries the instance identity so an
   * assembly-scoped `connector('name', arm1.select(...))` binds to THIS
   * instance only (a connector declared inside the part appears on every
   * instance).
   * @param filters - One or more `face()` / `edge()` filter builders.
   */
  select(...filters: FilterBuilderBase<Shape>[]): ISelect {
    if (filters.length === 0) {
      throw new Error("instance.select(): at least one face()/edge() filter is required.");
    }
    return this.registerSelection(filters);
  }

  /**
   * Face-selection shorthand: `arm1.face(f => f.parallelTo('xy').largest())`.
   * The callback receives a fresh face filter builder; returning it (or a
   * chained builder) is optional — the builder mutates in place.
   */
  face(build: (f: FaceFilterBuilder) => FaceFilterBuilder | void): ISelect {
    if (typeof build !== "function") {
      throw new Error("instance.face(): pass a callback building the filter, e.g. arm1.face(f => f.parallelTo('xy')).");
    }
    const builder = new FaceFilterBuilder();
    const result = build(builder);
    return this.registerSelection([result instanceof FaceFilterBuilder ? result : builder]);
  }

  /**
   * Edge-selection shorthand: `arm1.edge(e => e.circle(5))`. The callback
   * receives a fresh edge filter builder.
   */
  edge(build: (e: EdgeFilterBuilder) => EdgeFilterBuilder | void): ISelect {
    if (typeof build !== "function") {
      throw new Error("instance.edge(): pass a callback building the filter, e.g. arm1.edge(e => e.circle(5)).");
    }
    const builder = new EdgeFilterBuilder();
    const result = build(builder);
    return this.registerSelection([result instanceof EdgeFilterBuilder ? result : builder]);
  }

  private registerSelection(filters: FilterBuilderBase<Shape>[]): ISelect {
    const selection = new InstanceSelectSceneObject(filters, this.record);
    const sourceLocation = captureSourceLocation();
    if (sourceLocation) {
      selection.setSourceLocation(sourceLocation);
    }
    getCurrentScene().addSceneObject(selection);
    return selection;
  }
}
