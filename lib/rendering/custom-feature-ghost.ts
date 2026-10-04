import { Edge } from "../common/edge.js";
import { Face } from "../common/face.js";
import { Profiler } from "../common/profiler.js";
import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { AxisObject } from "../features/axis.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { PlaneObject } from "../features/plane.js";
import { PlaneObjectBase } from "../features/plane-renderable-base.js";
import { toAxis } from "../math/axis.js";
import { toPlane } from "../math/plane.js";
import type { MeshSettings } from "../oc/mesh.js";
import { EdgeOps } from "../oc/edge-ops.js";
import { FaceQuery } from "../oc/face-query.js";
import { Feature } from "../sdk/feature.js";
import type { FeatureOperation } from "../sdk/call-shape.js";
import type { FeatureScalar } from "../sdk/feature-inputs.js";
import { FeatureMetas, type PickerParamSpec, type ResolvedFeatureMeta } from "../sdk/meta.js";
import type { FeatureGhostResult, GhostEntityRef, GhostSolid } from "./feature-ghost.js";
import { GhostScene } from "./ghost-scene.js";
import { MeshBuilder } from "./mesh-builder.js";
import { renderFacePatch } from "./render-face.js";
import { Scene, type SceneObjectMesh } from "./scene.js";
import { SceneDisposal } from "./scene-disposal.js";

/**
 * One element of a custom feature's picked value, as its dialog addresses
 * it for the ghost: a statement by call site (a sketch, an axis or plane
 * statement, a solid, a feature), faces or edges picked in the viewport
 * (several of them one element, as the dialog writes them in one selector),
 * or a world axis or an origin plane.
 */
export type GhostCustomRef =
  | { kind: 'statement'; filePath: string; line: number }
  | { kind: 'entities'; entities: GhostEntityRef[] }
  | { kind: 'standard'; name: 'x' | 'y' | 'z' | 'xy' | 'xz' | 'yz' };

/**
 * A custom feature dialog's live geometry request: the feature's builder —
 * whose metadata names the class the ghost constructs — and the dialog's
 * values, the typed-in ones resolved to numbers by the server and the
 * picked ones as refs into the rendered scene.
 */
export type CustomGhostRequest = {
  feature: 'custom';
  /** The builder the feature's module exports. */
  builder: Function;
  /** Typed-in values by name; one left out takes its default. */
  values: Record<string, FeatureScalar>;
  /** Picked values by name, one ref per element; one left out is left out of the call. */
  refs: Record<string, GhostCustomRef[]>;
  /** The operation the dialog shows; null applies the feature's default. */
  operation: FeatureOperation | null;
  /**
   * Edit mode: the edited statement's call site. The scene holds that
   * statement already built — it fused into, or consumed, what it read — so
   * the ghost reads the scene as it stood just before it.
   */
  exclude?: { filePath: string; line: number };
  /**
   * How long building and meshing may take, in ms, before the answer is a
   * pause instead of geometry: a feature too slow to follow every keystroke
   * stops being previewed until the dialog asks again. Null for no limit;
   * {@link CustomFeatureGhost.BUDGET_MS} when left out.
   */
  budgetMs?: number | null;
};

/**
 * A reference the ghost hands a feature: the shapes a pick or a statement
 * stands for, held by an object of its own — the feature reads it through
 * `shapesOf`/`facesOf`/`edgesOf` like any reference, and nothing it does to
 * it can reach the scene.
 */
class GhostReference extends SceneObject {
  constructor(private readonly type: string, shapes: Shape[], private readonly selection: boolean) {
    super();
    this.addShapes(shapes);
  }

  getType(): string {
    return this.type;
  }

  override isSelection(): boolean {
    return this.selection;
  }

  build(): void {}

  serialize() {
    return {};
  }
}

/**
 * The geometry a custom feature's dialog would produce, built from the
 * dialog's values without touching the model: the feature's class is
 * constructed from them — references stood in by {@link GhostReference}s
 * over what the picks name — and its {@link Feature.ghost} drawn. A tool's
 * ghost is its tool, whatever the operation; the dialog colours it.
 *
 * Everything built here is freed before returning: the pick wrappers, the
 * shapes the feature returned and the buckets it declared on the way — but
 * never a shape the scene holds, which a feature may hand back as it is.
 */
export class CustomFeatureGhost {
  /** The default time a ghost may take before the dialog's preview pauses. */
  static readonly BUDGET_MS = 1500;

  /** Wrappers made to reach the picks: the preview's to free. */
  private readonly scratch: Shape[] = [];
  /** What the feature built for the preview: the preview's to free, scene shapes aside. */
  private readonly built: Shape[] = [];
  /** The edited statement's own objects, in edit mode. */
  private readonly edited: SceneObject[];
  /** The removal scope that reads the scene as of just before the edited statement. */
  private readonly before: Set<SceneObject> | undefined;

  private constructor(
    private readonly scene: Scene,
    private readonly meta: ResolvedFeatureMeta,
    private readonly request: CustomGhostRequest,
  ) {
    this.edited = request.exclude ? GhostScene.objectsAt(scene, request.exclude) : [];
    this.before = this.edited.length > 0
      ? new Set(GhostScene.allObjects(scene).filter(obj => !this.edited.includes(obj)))
      : undefined;
  }

  /** Build, mesh and free the ghost a custom feature's dialog asked for. */
  static build(scene: Scene, request: CustomGhostRequest, meshConfig: MeshSettings): FeatureGhostResult {
    const meta = FeatureMetas.of(request.builder);
    if (!meta) {
      return { ok: false, reason: 'That is not the builder of a feature.' };
    }
    if (!meta.ghost) {
      return { ok: false, reason: `${meta.label} draws no preview.` };
    }
    const ghost = new CustomFeatureGhost(scene, meta, request);
    try {
      return ghost.run(meshConfig);
    } finally {
      ghost.dispose();
    }
  }

  private run(meshConfig: MeshSettings): FeatureGhostResult {
    if (this.request.exclude && this.edited.length === 0) {
      return { ok: false, reason: 'That statement is not in the rendered scene.' };
    }
    const read = this.values();
    if ('reason' in read) {
      return { ok: false, reason: read.reason };
    }

    let feature: Feature;
    try {
      feature = new this.meta.class(FeatureMetas.complete(this.meta, read.values));
      this.applyOperation(feature);
    } catch (error) {
      return { ok: false, reason: CustomFeatureGhost.messageOf(error) };
    }

    const budget = this.request.budgetMs === undefined ? CustomFeatureGhost.BUDGET_MS : this.request.budgetMs;
    const start = performance.now();
    let preview: { shapes: Shape[]; scratch: Shape[] } | null;
    try {
      preview = feature.buildPreview(this.context());
    } catch (error) {
      return { ok: false, reason: CustomFeatureGhost.messageOf(error) };
    }
    if (!preview) {
      return { ok: false, reason: `${this.meta.label} draws no preview.` };
    }
    this.built.push(...preview.scratch, ...preview.shapes);

    const builder = new MeshBuilder(meshConfig);
    const solids: GhostSolid[] = [];
    for (const shape of preview.shapes) {
      if (!(shape instanceof Shape)) {
        return { ok: false, reason: `${this.meta.id}: ghost() returned something that is not a shape` };
      }
      const meshes = CustomFeatureGhost.meshesOf(shape, builder);
      if (meshes.length > 0) {
        solids.push({ meshes });
      }
    }

    const elapsed = performance.now() - start;
    if (budget !== null && elapsed > budget) {
      return {
        ok: false,
        paused: true,
        reason: `Building it took ${CustomFeatureGhost.seconds(elapsed)} — over the ${CustomFeatureGhost.seconds(budget)} a live preview may take.`,
      };
    }
    return { ok: true, solids };
  }

  /**
   * The values to construct the feature from, by name: the typed-in ones as
   * they came, the picked ones resolved — a single value to its one element,
   * a list to all of them. Anything the scene no longer holds refuses: a
   * ghost missing one of its references would show a feature the apply
   * won't build.
   */
  private values(): { values: Record<string, unknown> } | { reason: string } {
    const values: Record<string, unknown> = {};
    for (const name of Object.keys(this.request.values)) {
      const spec = this.meta.params[name];
      if (!spec || !('type' in spec)) {
        return { reason: `${this.meta.label} has no typed-in value '${name}'.` };
      }
      values[name] = this.request.values[name];
    }
    for (const [name, refs] of Object.entries(this.request.refs)) {
      const spec = this.meta.params[name];
      if (!spec || !('picker' in spec)) {
        return { reason: `${this.meta.label} has no picked value '${name}'.` };
      }
      const objects: SceneObject[] = [];
      for (const ref of refs) {
        const object = this.reference(spec, ref);
        if (!object) {
          return { reason: `${FeatureMetas.labelOf(name, spec)}: that pick is not in the rendered scene.` };
        }
        objects.push(object);
      }
      if (FeatureMetas.isList(spec)) {
        values[name] = objects;
      } else if (objects.length > 1) {
        return { reason: `${FeatureMetas.labelOf(name, spec)} takes one pick, got ${objects.length}.` };
      } else {
        values[name] = objects[0];
      }
    }
    return { values };
  }

  /** The stand-in for one element of a picked value, or null when the scene no longer holds it. */
  private reference(spec: PickerParamSpec, ref: GhostCustomRef): SceneObject | null {
    if (ref.kind === 'standard') {
      if (spec.picker === 'axis' && ref.name.length === 1) {
        return new AxisObject(toAxis(ref.name as 'x' | 'y' | 'z'));
      }
      if (spec.picker === 'plane' && ref.name.length === 2) {
        return new PlaneObject(toPlane(ref.name as 'xy' | 'xz' | 'yz'));
      }
      return null;
    }
    if (ref.kind === 'entities') {
      return this.entities(spec, ref.entities);
    }
    return this.statement(spec, ref);
  }

  /**
   * Faces or edges picked in the viewport: the selection holding them —
   * or, for an axis or a plane value, the axis of the one edge or the plane
   * of the one face, as `axis(<edge>)` and `plane(<face>)` read them.
   */
  private entities(spec: PickerParamSpec, entities: GhostEntityRef[]): SceneObject | null {
    if (entities.length === 0) {
      return null;
    }
    const shapes: Shape[] = [];
    for (const entity of entities) {
      const shape = entity.kind === 'face'
        ? GhostScene.pickedFace(this.scene, entity, this.scratch)
        : GhostScene.pickedEdge(this.scene, entity, this.scratch);
      if (!shape) {
        return null;
      }
      shapes.push(shape);
    }
    if (spec.picker === 'axis') {
      if (shapes.length !== 1 || !(shapes[0] instanceof Edge)) {
        return null;
      }
      try {
        return new AxisObject(EdgeOps.edgeToAxis(shapes[0]));
      } catch {
        // Not a straight edge — nothing to stand for an axis.
        return null;
      }
    }
    if (spec.picker === 'plane') {
      if (shapes.length !== 1 || !(shapes[0] instanceof Face) || !FaceQuery.isPlanarFace(shapes[0])) {
        return null;
      }
      return new PlaneObject(shapes[0].getPlane());
    }
    return new GhostReference('select', shapes, true);
  }

  /**
   * The statement at a call site, as the feature would read it: an axis or
   * a plane by its axis or plane, anything else by the shapes it holds — in
   * edit mode, read as they stood before the edited statement took or
   * consumed them.
   */
  private statement(spec: PickerParamSpec, ref: { filePath: string; line: number }): SceneObject | null {
    const candidates = GhostScene.objectsAt(this.scene, ref)
      .filter(obj => !obj.isLazy() && !obj.getCloneSource() && !this.edited.includes(obj));
    if (spec.picker === 'axis') {
      const axis = candidates.find(obj => obj instanceof AxisObjectBase) as AxisObjectBase | undefined;
      return axis ? new AxisObject(axis.getAxis()) : null;
    }
    if (spec.picker === 'plane') {
      const plane = candidates.find(obj => obj instanceof PlaneObjectBase) as PlaneObjectBase | undefined;
      return plane ? new PlaneObject(plane.getPlane()) : null;
    }
    const object = spec.picker === 'sketch'
      ? candidates.find(obj => obj.getType() === 'sketch' || (spec.wire === true && obj.getType() === 'helix'))
      : candidates.find(obj => !obj.isInternal() && !(obj instanceof AxisObjectBase) && !(obj instanceof PlaneObjectBase));
    if (!object) {
      return null;
    }
    return new GhostReference(object.getType(), object.getShapes(undefined, undefined, this.before), object.isSelection());
  }

  /** The operation the dialog shows, chosen the way the statement's chain would. */
  private applyOperation(feature: Feature): void {
    switch (this.request.operation) {
      case 'add':
        feature.add();
        break;
      case 'new':
        feature.new();
        break;
      case 'remove':
        feature.remove();
        break;
      default:
        break;
    }
  }

  /**
   * What the feature's build is handed: the scene as the statement would
   * see it — in edit mode the objects before the edited statement, else
   * every object, the statement landing at the end. No transform: a ghost
   * is the statement itself, never a repeat's copy.
   */
  private context(): BuildSceneObjectContext {
    const anchor = this.edited.find(obj => obj instanceof Feature) ?? this.edited[0] ?? null;
    const objects = anchor ? this.scene.getPartScopedObjectsUpTo(anchor) : this.scene.getSceneObjects();
    const active = anchor
      ? this.scene.getPartScopedActiveObjectsUpTo(anchor)
      : objects.filter(obj => obj.hasShapes());
    const profiler = new Profiler();
    return {
      getSceneObjects: () => objects,
      getActiveSceneObjects: () => active,
      getSceneObjectsFromTo: (from, to) => this.scene.getSceneObjectsFromTo(from, to),
      getTransform: () => null,
      getLastObject: () => {
        for (let i = objects.length - 1; i >= 0; i--) {
          const obj = objects[i];
          if (!(obj instanceof PlaneObjectBase) && !(obj instanceof AxisObjectBase)) {
            return obj;
          }
        }
        return null;
      },
      getProfiler: () => profiler,
    };
  }

  /**
   * Free everything built for this ghost — with the sub-shape wrappers it
   * cached — but no shape the scene holds and no raw handle one shares: a
   * feature may hand back a reference's own shape, or a copy sharing its
   * handle, whose disposal would pull it out from under the model.
   */
  private dispose(): void {
    SceneDisposal.releaseDetached([...this.built, ...this.scratch], GhostScene.allObjects(this.scene));
  }

  /**
   * One returned shape's meshes, labelled the way the dialog's overlay draws
   * a ghost body — its triangles as `solid-faces`, its outline as
   * `solid-edges`. A solid comes out of the mesh builder labelled; a lone
   * face (a modifier's preview of the faces it changes) is meshed as a patch
   * with its outline, and an edge or a wire as outline alone: unlabelled,
   * the overlay would skip them.
   */
  private static meshesOf(shape: Shape, builder: MeshBuilder): SceneObjectMesh[] {
    if (shape.isFace()) {
      return renderFacePatch(shape, builder.resolveConfig(shape));
    }
    const meshes = builder.build(shape) ?? [];
    if (shape.isEdge() || shape.isWire()) {
      return meshes.map(mesh => ({ ...mesh, label: 'solid-edges' }));
    }
    return meshes;
  }

  private static messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
  }
}
