import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";

/**
 * A named geometry publication registered by `expose('name', source)` inside
 * a `part()` block. Unlike `Connector`, an exposure is a pure pass-through:
 * `build()` never consumes the source and emits no shapes — consumers read
 * the SOURCE (not this wrapper) via `def.features.<name>`, so cross-part
 * dependency tracking keeps resolving to the donor-owned object.
 */
export class Exposed extends SceneObject {
  constructor(
    public readonly exposeName: string,
    public readonly source: SceneObject,
  ) {
    super();
    this.name(exposeName);
  }

  getType(): string {
    return "exposed";
  }

  build(_context?: BuildSceneObjectContext): void {
    // Pass-through — never consume the source.
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(_remap: Map<SceneObject, SceneObject>): SceneObject {
    return new Exposed(this.exposeName, this.source);
  }

  compareTo(other: Exposed): boolean {
    if (!(other instanceof Exposed)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.exposeName !== other.exposeName) {
      return false;
    }
    // A re-pointed exposure (same name, different source) must invalidate —
    // consumers resolve through the name to whatever it now publishes.
    if (!this.source.compareTo(other.source)) {
      return false;
    }
    return true;
  }

  serialize() {
    return { name: this.exposeName };
  }
}
