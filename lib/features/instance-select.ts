import { Shape } from "../common/shapes.js";
import { SceneObject } from "../common/scene-object.js";
import { FilterBuilderBase } from "../filters/filter-builder-base.js";
import { AssemblyInstance } from "../rendering/assembly-scene.js";
import { SelectSceneObject } from "./select.js";

/**
 * An instance-scoped selection: `arm1.select(...)` / `arm1.face(...)` /
 * `arm1.edge(...)`. Resolves exactly like a `select(...)` inside the
 * instance's part() block — the constraint object narrows the universe to
 * that part's subtree — while carrying the instance identity so an
 * assembly-scoped `connector()` can bind its frame to ONE instance instead
 * of every instance of the part.
 */
export class InstanceSelectSceneObject extends SelectSceneObject {
  constructor(
    filters: FilterBuilderBase<Shape>[],
    public readonly instance: AssemblyInstance,
  ) {
    super(filters, instance.part);
  }

  get instanceId(): string {
    return this.instance.instanceId;
  }

  override compareTo(other: SelectSceneObject): boolean {
    if (!(other instanceof InstanceSelectSceneObject)) {
      return false;
    }
    if (this.instanceId !== other.instanceId) {
      return false;
    }
    return super.compareTo(other);
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const remappedFilters = this.getFilters().map(f => f.remap(remap));
    return new InstanceSelectSceneObject(remappedFilters, this.instance);
  }
}
