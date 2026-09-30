import { SceneObject } from "../common/scene-object.js";
import { PlaneObjectBase } from "./plane-renderable-base.js";
import { Plane } from "../math/plane.js";
import { ISection } from "../core/interfaces.js";

/** The dialog-editable options of a `section()` statement. */
export type SectionOptions = {
  /** Distance the cut plane is moved along the plane normal (document units). */
  offset?: number;
  /** Keep the half on the normal's side instead of removing it. */
  flip?: boolean;
};

/**
 * A saved section view: a named cut plane the viewer can clip the scene at
 * on demand. It builds nothing — no shape reaches the scene — and it is
 * internal, so the timeline leaves it out; the viewer lists it in the
 * section menu instead. Its plane is read from the datum it names (an
 * origin plane, a `plane()` statement, or a picked face lifted to a plane),
 * which it consumes for display exactly as a sketch or a mirror would, so a
 * picked face's helper plane never draws a quad of its own.
 *
 * Convention (shared with the viewer's `SectionSpec`): the plane normal
 * points at the half that is removed; `flip` keeps that half instead.
 */
export class SectionView extends SceneObject implements ISection {

  constructor(
    public readonly sectionName: string,
    public readonly source: PlaneObjectBase,
    public readonly options: SectionOptions = {},
  ) {
    super();
  }

  getType(): string {
    return 'section';
  }

  /** Never a timeline row: the section menu is its home. */
  override isInternal(): boolean {
    return true;
  }

  build() {
    const plane = this.source.getPlane();
    if (!plane) {
      throw new Error(`section('${this.sectionName}'): the plane it names did not build.`);
    }
    // Display-only consumption: the datum's quad leaves the screen from here
    // on (a later feature may still read the plane).
    this.source.removeShapes(this);
    this.setState('plane', plane);
  }

  /** The cut plane before its offset, as built. */
  getPlane(): Plane {
    return this.getState('plane') as Plane;
  }

  override getDependencies(): SceneObject[] {
    return [this.source];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const source = (remap.get(this.source) as PlaneObjectBase | undefined) ?? this.source;
    return new SectionView(this.sectionName, source, { ...this.options });
  }

  compareTo(other: SectionView): boolean {
    if (!(other instanceof SectionView)) {
      return false;
    }
    if (!super.compareTo(other)) {
      return false;
    }
    if (this.sectionName !== other.sectionName) {
      return false;
    }
    if (!this.source.compareTo(other.source)) {
      return false;
    }
    return (this.options.offset ?? 0) === (other.options.offset ?? 0)
      && (this.options.flip ?? false) === (other.options.flip ?? false);
  }

  /**
   * What the viewer reads: the plane as numbers plus the options, so the
   * section menu can clip at `origin + normal * offset` without asking the
   * engine again.
   */
  serialize() {
    const plane = this.getPlane();
    return {
      name: this.sectionName,
      origin: plane ? [plane.origin.x, plane.origin.y, plane.origin.z] : [0, 0, 0],
      normal: plane ? [plane.normal.x, plane.normal.y, plane.normal.z] : [0, 0, 1],
      offset: this.options.offset ?? 0,
      flip: this.options.flip ?? false,
    };
  }
}
