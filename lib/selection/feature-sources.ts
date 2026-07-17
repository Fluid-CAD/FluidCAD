import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeHasher } from "../oc/shape-hash.js";
import { Shell } from "../features/shell.js";
import { Fillet } from "../features/fillet.js";
import { Chamfer } from "../features/chamfer.js";
import { Sweep } from "../features/sweep.js";
import { Loft } from "../features/loft.js";
import { ExtrudeBase } from "../features/extrude-base.js";
import { ExtrudeToFace } from "../features/extrude-to-face.js";
import { Revolve } from "../features/revolve.js";
import { Wrap } from "../features/wrap.js";
import { AxisObjectBase } from "../features/axis-renderable-base.js";
import { Sketch } from "../features/2d/sketch.js";
import {
  PickRef, SelectionBoundary, SelectionScene, resolveScopedScene,
} from "./types.js";

/**
 * One source slot of a feature statement, resolved for edit-dialog seeding:
 * a sketch input by call site, a selection input as viewport entities on the
 * pre-statement solids (what a rollback to just before the statement
 * displays), or `opaque` — real but not representable as picks (inline
 * sketches, clones, loop call sites, to-face targets, unmappable shapes), so
 * the dialog keeps that slot's verbatim text.
 */
export type SourceSlot =
  | { kind: 'sketch'; filePath: string; line: number; column: number }
  | { kind: 'entities'; entities: PickRef[] }
  | { kind: 'opaque' };

export type FeatureSources =
  | {
    feature: 'extrude' | 'cut';
    profile: SourceSlot;
    /** Up-to-face target; absent for a distance extrude. */
    toFace?: SourceSlot;
  }
  | { feature: 'sweep'; profile: SourceSlot; path: SourceSlot }
  | { feature: 'loft'; profiles: SourceSlot[]; guides: SourceSlot[] }
  | { feature: 'revolve'; profile: SourceSlot; axis: SourceSlot }
  | { feature: 'wrap'; sketch: SourceSlot; face: SourceSlot }
  | { feature: 'shell' | 'fillet' | 'chamfer'; selection: SourceSlot };

export type FeatureSourcesResult =
  | ({ ok: true } & FeatureSources)
  | { ok: false; reason: string };

/**
 * Resolve the current sources of the statement at `boundary` for seeding its
 * edit dialog. Selection inputs read the resolved shapes the build stored on
 * the select objects (`addedShapes` — build-time truth, no re-resolution) and
 * hash-map them onto the pre-statement terminal solids, mirroring what the
 * rolled-back viewport displays. All-or-nothing per selection slot: one
 * unmappable shape makes the whole slot opaque, never a silently smaller
 * pick set.
 */
export function resolveFeatureSources(
  scene: SelectionScene,
  boundary: SelectionBoundary,
): FeatureSourcesResult {
  const scoped = resolveScopedScene(scene, boundary);
  if (scoped.ok === false) {
    return scoped;
  }
  const feature = scene.getAllSceneObjects()[boundary.index];
  const resolver = new SourceResolver(scoped.scene.getAllSceneObjects(), boundary);
  try {
    if (feature instanceof Shell) {
      return { ok: true, feature: 'shell', selection: resolver.entitiesSlot(feature.faceSelections) };
    }
    if (feature instanceof Fillet) {
      return { ok: true, feature: 'fillet', selection: resolver.entitiesSlot(feature.targetEdges) };
    }
    if (feature instanceof Chamfer) {
      return { ok: true, feature: 'chamfer', selection: resolver.entitiesSlot(feature.selections) };
    }
    if (feature instanceof Sweep) {
      return {
        ok: true,
        feature: 'sweep',
        profile: resolver.profileSlot(feature),
        path: resolver.mixedSlot(feature.path),
      };
    }
    if (feature instanceof Loft) {
      return {
        ok: true,
        feature: 'loft',
        profiles: feature.profiles.map(p => resolver.mixedSlot(p)),
        guides: feature.guideObjects.map(g => resolver.sketchSlot(g)),
      };
    }
    // Wrap extends ExtrudeBase — its case must come first.
    if (feature instanceof Wrap) {
      return {
        ok: true,
        feature: 'wrap',
        sketch: resolver.profileSlot(feature),
        face: resolver.entitiesSlot([feature.face]),
      };
    }
    // Revolve extends ExtrudeBase — its case must come first.
    if (feature instanceof Revolve) {
      return {
        ok: true,
        feature: 'revolve',
        profile: resolver.profileSlot(feature),
        axis: resolver.axisSlot(feature.axis),
      };
    }
    if (feature instanceof ExtrudeBase) {
      const kind = feature.getType() === 'cut' ? 'cut' as const : 'extrude' as const;
      if (feature instanceof ExtrudeToFace) {
        return {
          ok: true,
          feature: kind,
          profile: resolver.profileSlot(feature),
          // The target face as viewport entities; 'first-face'/'last-face'
          // literals have no picked face to resolve.
          toFace: feature.face instanceof SceneObject
            ? resolver.entitiesSlot([feature.face])
            : OPAQUE,
        };
      }
      return { ok: true, feature: kind, profile: resolver.profileSlot(feature) };
    }
    return { ok: false, reason: `${feature.getType()}() has no editable sources` };
  } finally {
    resolver.dispose();
  }
}

const OPAQUE: SourceSlot = { kind: 'opaque' };

class SourceResolver {
  private hasher = new ShapeHasher();
  private solids: Shape[] | null = null;
  private keyMaps = new Map<string, Map<number, number>>();
  private callSiteCounts: Map<string, number> | null = null;

  constructor(private prefix: SceneObject[], private boundary: SelectionBoundary) {}

  dispose(): void {
    this.hasher.delete();
  }

  /** A sketch input, by call site — opaque when binding it could mis-target. */
  sketchSlot(obj: SceneObject | null): SourceSlot {
    return obj instanceof Sketch ? this.callSiteSlot(obj) : OPAQUE;
  }

  /**
   * A revolve's axis input, by call site — an axis statement the dialog can
   * point at and highlight. An axis built inline in the revolve's own
   * arguments (`revolve('z')`, `revolve(axis(…))`) captures a line on the
   * statement itself and stays opaque; the dialog keeps its verbatim text.
   */
  axisSlot(obj: SceneObject | null): SourceSlot {
    return obj instanceof AxisObjectBase ? this.callSiteSlot(obj) : OPAQUE;
  }

  /** An input statement by call site — opaque when binding it could mis-target. */
  private callSiteSlot(obj: SceneObject): SourceSlot {
    if (obj.getCloneSource()) {
      return OPAQUE;
    }
    const loc = obj.getSourceLocation();
    // An inline argument captures a line on/inside the edited statement
    // itself — it has no standalone statement to re-target.
    if (!loc || loc.line >= this.boundary.line) {
      return OPAQUE;
    }
    if ((this.countCallSites().get(`${obj.getType()}@${loc.filePath}:${loc.line}:${loc.column}`) ?? 0) > 1) {
      return OPAQUE;
    }
    return { kind: 'sketch', filePath: loc.filePath, line: loc.line, column: loc.column };
  }

  /** The profile of an extrude-family feature: a sketch, or nothing pickable. */
  profileSlot(feature: ExtrudeBase): SourceSlot {
    return this.sketchSlot(feature.extrudable instanceof Sketch ? feature.extrudable : null);
  }

  /** A slot holding either a sketch or a geometry selection (loft profile, sweep path). */
  mixedSlot(obj: SceneObject | null): SourceSlot {
    if (obj instanceof Sketch) {
      return this.sketchSlot(obj);
    }
    return obj ? this.entitiesSlot([obj]) : OPAQUE;
  }

  /**
   * Selection inputs as viewport entities on the pre-statement terminal
   * solids. The selections' `addedShapes` are the exact shapes the feature
   * consumed at build time.
   */
  entitiesSlot(selections: SceneObject[]): SourceSlot {
    const shapes = selections.flatMap(sel => sel.getAddedShapes());
    if (shapes.length === 0) {
      return OPAQUE;
    }
    const entities: PickRef[] = [];
    for (const shape of shapes) {
      const ref = this.mapShape(shape);
      if (!ref) {
        return OPAQUE;
      }
      entities.push(ref);
    }
    return { kind: 'entities', entities };
  }

  /** Hash-map one consumed sub-shape onto a terminal solid's mesh-order universe. */
  private mapShape(shape: Shape): PickRef | null {
    const kind = shape.getType() === 'edge' ? 'edge' : shape.getType() === 'face' ? 'face' : null;
    if (!kind) {
      return null;
    }
    const key = this.hasher.key(shape.getShape());
    for (const solid of this.terminalSolids()) {
      const index = this.keyMapFor(solid, kind).get(key);
      if (index !== undefined) {
        return { shapeId: solid.id, sub: { type: kind, index } };
      }
    }
    return null;
  }

  /**
   * The solids a rollback to just before the statement displays: every
   * prefix object's own solids whose removal (if any) was recorded by a
   * feature outside the prefix — the same scope rule renderRollback applies.
   */
  private terminalSolids(): Shape[] {
    if (this.solids) {
      return this.solids;
    }
    const scope = new Set(this.prefix);
    this.solids = [];
    for (const obj of this.prefix) {
      if (obj.isLazy()) {
        continue;
      }
      for (const shape of obj.getOwnShapes({ excludeMeta: false, excludeGuide: false }, scope)) {
        if (shape.getType() === 'solid') {
          this.solids.push(shape);
        }
      }
    }
    return this.solids;
  }

  private keyMapFor(solid: Shape, kind: 'edge' | 'face'): Map<number, number> {
    const mapKey = `${solid.id}:${kind}`;
    let map = this.keyMaps.get(mapKey);
    if (!map) {
      map = new Map();
      const universe: Shape[] = kind === 'face'
        ? Explorer.findFacesWrapped(solid)
        : Explorer.findEdgesWrapped(solid);
      universe.forEach((sub: Shape, index: number) => {
        const key = this.hasher.key(sub.getShape());
        if (!map!.has(key)) {
          map!.set(key, index);
        }
      });
      this.keyMaps.set(mapKey, map);
    }
    return map;
  }

  private countCallSites(): Map<string, number> {
    if (this.callSiteCounts) {
      return this.callSiteCounts;
    }
    this.callSiteCounts = new Map();
    for (const obj of this.prefix) {
      const loc = obj.getSourceLocation();
      if (!loc) {
        continue;
      }
      const key = `${obj.getType()}@${loc.filePath}:${loc.line}:${loc.column}`;
      this.callSiteCounts.set(key, (this.callSiteCounts.get(key) ?? 0) + 1);
    }
    return this.callSiteCounts;
  }
}
