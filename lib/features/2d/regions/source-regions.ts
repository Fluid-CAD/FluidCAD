// The regions of an extrudable source and the declarations that name them
// — shared by the features that build from a source (ExtrudeBase) and the
// previews that only look at one (the dialog ghost, the region picker).

import { Edge } from "../../../common/edge.js";
import { SceneObject } from "../../../common/scene-object.js";
import { Extrudable } from "../../../helpers/types.js";
import { Plane } from "../../../math/plane.js";
import { GeometrySceneObject } from "../geometry.js";
import { Sketch } from "../sketch.js";
import { SketchRegion, SketchRegionBuilder } from "./region-builder.js";
import { DeclaredRegion, RegionRequest, RegionResolution, resolveRegions } from "./region-match.js";
import { RegionItem, sameItem } from "./region-ref.js";
import { RegionPick, itemOfRef } from "./region-wire.js";
import { StatementLabels } from "./statement-label.js";

/** The sketch a statement sits in, or null for one outside any sketch. */
export function enclosingSketchOf(statement: SceneObject): Sketch | null {
  for (let parent = statement.getParent(); parent; parent = parent.getParent()) {
    if (parent instanceof Sketch) {
      return parent;
    }
  }
  return null;
}

/**
 * The sketch whose declarations a source's regions are named in: the
 * source itself, or the sketch a primitive passed straight to an operation
 * (`extrude(10, c)`) belongs to. Null for a source outside any sketch (a
 * top-level offset) — its regions can be listed but not declared.
 */
export function sourceSketchOf(source: Extrudable, edges?: Map<Edge, GeometrySceneObject>): Sketch | null {
  if (source instanceof Sketch) {
    return source;
  }
  if (source instanceof SceneObject) {
    const own = enclosingSketchOf(source);
    if (own) {
      return own;
    }
  }
  const statements = [...new Set((edges ?? source.getGeometriesWithOwner()).values())];
  return statements.map(enclosingSketchOf).find((s): s is Sketch => s !== null) ?? null;
}

/** The labels the source's regions read by — its sketch's statements, else the edge owners in order. */
export function sourceLabels(source: Extrudable, edges: Map<Edge, GeometrySceneObject>): StatementLabels {
  const sketch = sourceSketchOf(source, edges);
  if (sketch) {
    return StatementLabels.ofSketchChildren(sketch.getChildren());
  }
  return new StatementLabels([...new Set(edges.values())]);
}

/**
 * The regions of `source` on `plane`. `edges` overrides the edges the
 * source reports live — a preview of a consumed sketch reads them as if
 * nothing had consumed them.
 */
export function sourceRegions(
  source: Extrudable,
  plane: Plane,
  edges: Map<Edge, GeometrySceneObject> = source.getGeometriesWithOwner(),
): SketchRegion[] {
  return new SketchRegionBuilder(edges, plane, sourceLabels(source, edges)).build();
}

/** The declarations of the source's sketch, in the form the matcher takes. */
export function sourceDeclarations(sketch: Sketch | null): Map<string, DeclaredRegion> {
  const out = new Map<string, DeclaredRegion>();
  if (!sketch) {
    return out;
  }
  for (const [name, declaration] of sketch.declaredRegions()) {
    out.set(name, { name, items: declaration.items, error: declaration.registrationError });
  }
  return out;
}

/**
 * Everything a consumer needs to resolve regions against a source: the
 * arrangement, the sketch's declarations and the labels for messages.
 */
export type SourceRegionContext = {
  sketch: Sketch | null;
  regions: SketchRegion[];
  declarations: Map<string, DeclaredRegion>;
  labels: StatementLabels;
};

export function sourceRegionContext(
  source: Extrudable,
  plane: Plane,
  edges: Map<Edge, GeometrySceneObject> = source.getGeometriesWithOwner(),
): SourceRegionContext {
  const sketch = sourceSketchOf(source, edges);
  const labels = sourceLabels(source, edges);
  return {
    sketch,
    regions: new SketchRegionBuilder(edges, plane, labels).build(),
    declarations: sourceDeclarations(sketch),
    labels,
  };
}

/**
 * Resolve the picks a dialog holds — declared names and/or boundaries in
 * wire form — against the source. A boundary whose statements are gone
 * (the source changed under the dialog) becomes a problem, like a name
 * nobody declared.
 */
export function resolveRegionPicks(context: SourceRegionContext, picks: RegionPick[]): RegionResolution {
  const requests: RegionRequest[] = [];
  const problems: string[] = [];
  for (const pick of picks) {
    if (pick.items && pick.items.length > 0) {
      if (!context.sketch) {
        problems.push('the profile is not a sketch — its regions cannot be picked');
        continue;
      }
      const items: RegionItem[] = [];
      let lost = false;
      for (const ref of pick.items) {
        const item = itemOfRef(ref, context.sketch);
        if (!item) {
          lost = true;
          break;
        }
        items.push(item);
      }
      if (lost) {
        problems.push(`region ${pick.name ? `'${pick.name}'` : ''} names a statement that is no longer in the sketch — pick it again`);
        continue;
      }
      requests.push({ name: pick.name, items });
    } else if (pick.name) {
      requests.push({ name: pick.name });
    }
  }
  const resolution = resolveRegions(requests, context.regions, context.declarations, context.labels);
  return { selected: resolution.selected, problems: [...problems, ...resolution.problems] };
}

/**
 * The name of the declaration that lists exactly one of the given
 * boundaries (a region's full half-edge list, or its writable form), or
 * null when no declaration describes the region.
 */
export function declaredNameOf(declarations: Map<string, DeclaredRegion>, ...boundaries: RegionItem[][]): string | null {
  for (const declared of declarations.values()) {
    if (declared.error) {
      continue;
    }
    for (const boundary of boundaries) {
      if (declared.items.length === boundary.length
        && declared.items.every(item => boundary.some(other => sameItem(item, other)))) {
        return declared.name;
      }
    }
  }
  return null;
}
