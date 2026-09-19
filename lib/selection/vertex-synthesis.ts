import { SceneObject } from '../common/scene-object.js';
import { Shape } from '../common/shape.js';
import { Sketch } from '../features/2d/sketch.js';
import { Point } from '../math/point.js';
import { Explorer } from '../oc/explorer.js';
import { anchorFromShape } from '../features/shape-anchor.js';
import { mmTol } from '../units/tolerance.js';
import { attributePick } from './attribution.js';
import { pickedVertexPoint } from './vertex-pick.js';
import { attributeSketchVertex } from './sketch-vertex.js';
import { SelectionIndex } from './selection-index.js';
import { synthesizeSelectors, selectorRank, canBindProducer, type SelectorPart } from './synthesis.js';
import { allocateNames, collectImports, makeStatementBindable, renderPartArgs } from './explain.js';
import { renderSolvedTarget, SOLVED_ENTITY_NAME_HINTS, type SketchExportRequest } from './sketch-target.js';
import type { SelectionScene, PickRef, SynthesizeOptions } from './types.js';
import type { SynthesizedForm, SynthesizedSelection, SynthesizedSelectionPart } from './synthesize-selection.js';

type EdgePoint = { kind: 'edge'; selector: SelectorPart; role: 'start' | 'end' };
type SketchPoint = { kind: 'sketch'; sketch: Sketch; request: SketchExportRequest; entities: Map<number, SceneObject> };
type PointPart = EdgePoint | SketchPoint;

/** One pick's candidates, best first — a sketch vertex has exactly one. */
type PointGroup = PointPart[];
type Refusal = { ok: false; reason: string; pick: PickRef };
type LocatedVertex = { owner: SceneObject; shape: Shape; point: Point };
type Bindable = ReturnType<typeof makeStatementBindable>;

/** The names a point expression is written with: source variables, or `$obj[…]` for the evaluable form. */
type PointNames = {
  producers: Map<SceneObject, string>;
  tools: Map<SceneObject, string>;
  entities: Map<SceneObject, string>;
};

/**
 * Turns vertex picks into point expressions, one per pick and in pick order.
 * Vertices never enter the face/edge filter pools: a vertex of a solid is
 * named as the end of its best-ranked incident edge (`e.endEdges(0).start()`),
 * a vertex of a sketch as a named entity point exported from the sketch
 * (`s.geometries.l1.start()`), which the consuming edit must first author —
 * see `exports` on the result.
 */
export class VertexPointSynthesizer {
  static synthesize(scene: SelectionScene, refs: PickRef[], options: SynthesizeOptions): SynthesizedSelection {
    const index = new SelectionIndex(scene);
    const bindable = makeStatementBindable(options.bindable);
    try {
      const groups: PointGroup[] = [];
      let scope: SceneObject | null | undefined;
      for (const ref of refs) {
        const located = VertexPointSynthesizer.locate(scene, ref);
        if (!located) {
          return { ok: false, reason: 'the vertex no longer resolves in the current scene', pick: ref };
        }
        const part = scene.findEnclosingPart(located.owner);
        if (scope !== undefined && part !== scope) {
          return { ok: false, reason: 'the picked vertices live in different part() scopes — one point list must stay inside one part', pick: ref };
        }
        scope = part;

        const sketch = VertexPointSynthesizer.owningSketch(located.owner);
        const group = sketch
          ? VertexPointSynthesizer.sketchPoint(scene, index, sketch, located, ref, bindable)
          : VertexPointSynthesizer.edgePoints(scene, index, located, ref, options, bindable);
        if ('ok' in group) {
          return group;
        }
        groups.push(group);
      }

      const producers = VertexPointSynthesizer.producersOf(groups);
      const names = VertexPointSynthesizer.allocatePointNames(groups, producers, options);
      return VertexPointSynthesizer.result(groups, producers, names);
    } finally {
      index.dispose();
    }
  }

  private static locate(scene: SelectionScene, ref: PickRef): LocatedVertex | null {
    const owner = scene.getAllSceneObjects().find(object => !object.isContainer() && !object.isLazy()
      && object.getAddedShapes().some(shape => shape.id === ref.shapeId));
    const shape = owner?.getAddedShapes().find(candidate => candidate.id === ref.shapeId);
    const point = shape ? pickedVertexPoint(shape, ref.sub.index) : null;
    if (!owner || !shape || !point) {
      return null;
    }
    return { owner, shape, point };
  }

  private static owningSketch(owner: SceneObject): Sketch | null {
    for (let parent: SceneObject | null = owner; parent; parent = parent.getParent()) {
      if (parent instanceof Sketch) {
        return parent;
      }
    }
    return null;
  }

  private static sketchPoint(
    scene: SelectionScene, index: SelectionIndex, sketch: Sketch, located: LocatedVertex, ref: PickRef, bindable: Bindable,
  ): PointGroup | Refusal {
    if (sketch.getCloneSource() || !canBindProducer(index, sketch, bindable)) {
      return { ok: false, reason: 'the sketch cannot be bound to one statement — name and return its geometry explicitly', pick: ref };
    }
    const attributed = attributeSketchVertex(scene, sketch, located.point);
    if (attributed.ok === false) {
      return { ok: false, reason: attributed.reason, pick: ref };
    }
    return [{ kind: 'sketch', sketch, request: attributed.request, entities: attributed.entities }];
  }

  /** Every verified selector of every edge meeting the vertex, best ranked first. */
  private static edgePoints(
    scene: SelectionScene, index: SelectionIndex, located: LocatedVertex, ref: PickRef,
    options: SynthesizeOptions, bindable: Bindable,
  ): PointGroup | Refusal {
    const candidates: EdgePoint[] = [];
    const edges = Explorer.findEdgesWrapped(located.shape);
    const vertices = Explorer.findVerticesWrapped(located.shape);
    try {
      for (const [edgeIndex, edge] of edges.entries()) {
        const endpoints = Explorer.findVerticesWrapped(edge);
        const incident = endpoints.some(endpoint => endpoint.isSame(vertices[ref.sub.index]));
        for (const endpoint of endpoints) {
          endpoint.dispose();
        }
        const role = incident ? VertexPointSynthesizer.endpointRole(edge, located.point) : null;
        if (!role) {
          continue;
        }
        const edgeRef: PickRef = { shapeId: located.shape.id, sub: { type: 'edge', index: edgeIndex } };
        const attribution = attributePick(scene, index, edgeRef);
        try {
          const result = synthesizeSelectors(scene, index, [attribution], [], options.params ?? [], false, bindable);
          if (result.ok) {
            for (const group of result.groups) {
              for (const selector of [group.winner, ...group.alternatives]) {
                candidates.push({ kind: 'edge', selector, role });
              }
            }
          }
        } finally {
          attribution.picked?.dispose();
        }
      }
    } finally {
      for (const edge of edges) {
        edge.dispose();
      }
      for (const vertex of vertices) {
        vertex.dispose();
      }
    }
    if (candidates.length === 0) {
      return { ok: false, reason: 'no incident edge can name this vertex with a stable endpoint reference', pick: ref };
    }
    return candidates.sort((a, b) => selectorRank(a.selector) - selectorRank(b.selector));
  }

  /** Which end of the edge the point is — by the same anchor rule `.start()` / `.end()` resolve with. */
  private static endpointRole(edge: Parameters<typeof anchorFromShape>[0], point: Point): 'start' | 'end' | null {
    for (const role of ['start', 'end'] as const) {
      try {
        if (anchorFromShape(edge, { kind: role }).origin.distanceTo(point) <= mmTol(1e-6)) {
          return role;
        }
      } catch {
        // Some degenerate/closed edges cannot supply an endpoint frame.
      }
    }
    return null;
  }

  /** The features the winning expressions reference, in first-use order. */
  private static producersOf(groups: PointGroup[]): SceneObject[] {
    const producers: SceneObject[] = [];
    for (const [winner] of groups) {
      const referenced = winner.kind === 'sketch'
        ? [winner.sketch]
        : [winner.selector.producer, ...winner.selector.refs ?? []];
      for (const producer of referenced) {
        if (producer && !producers.includes(producer)) {
          producers.push(producer);
        }
      }
    }
    return producers;
  }

  /**
   * Producer variables plus provisional names for the sketch entities. The
   * entity names are a preview only — the export transform owns the real ones
   * (an existing binding or export key wins) and reports them per part.
   */
  private static allocatePointNames(groups: PointGroup[], producers: SceneObject[], options: SynthesizeOptions): PointNames {
    const names = allocateNames(producers, options.namer);
    const tools = new Map(producers.map(producer => [producer, `$obj["${producer.id}"]`]));
    const entities = new Map<SceneObject, string>();
    const used = new Set(names.values());
    for (const [winner] of groups) {
      if (winner.kind !== 'sketch') {
        continue;
      }
      for (const entity of winner.entities.values()) {
        if (entities.has(entity)) {
          continue;
        }
        const hint = SOLVED_ENTITY_NAME_HINTS[VertexPointSynthesizer.entityKind(entity)] ?? 'e';
        let n = 1;
        while (used.has(`${hint}${n}`)) {
          n++;
        }
        used.add(`${hint}${n}`);
        entities.set(entity, `${hint}${n}`);
      }
    }
    return { producers: names, tools, entities };
  }

  private static entityKind(entity: SceneObject): string {
    const type = entity.getType();
    if (type === 'projection') {
      return 'project';
    }
    return type.startsWith('copy-') ? 'copy' : type;
  }

  private static render(part: PointPart, names: PointNames, evaluable: boolean): string {
    if (part.kind === 'sketch') {
      return renderSolvedTarget(part.request.target, target => {
        const entity = part.entities.get(target.line!)!;
        return evaluable
          ? `$obj["${entity.id}"]`
          : `${names.producers.get(part.sketch)}.geometries.${names.entities.get(entity)}`;
      });
    }
    return `${renderPartArgs(part.selector, evaluable ? names.tools : names.producers)}.${part.role}()`;
  }

  private static form(parts: PointPart[], names: PointNames): SynthesizedForm {
    const expressions = parts.map(part => VertexPointSynthesizer.render(part, names, true));
    const partSources = parts.map(part => VertexPointSynthesizer.render(part, names, false));
    return {
      expression: expressions.length === 1 ? expressions[0] : `[${expressions.join(', ')}]`,
      source: partSources.join(', '),
      partSources,
    };
  }

  /** Runner-up renderings: one pick swapped to its next candidate, producers already named only. */
  private static alternatives(groups: PointGroup[], names: PointNames): SynthesizedForm[] {
    const winners = groups.map(group => group[0]);
    const alternatives: SynthesizedForm[] = [];
    for (const [i, group] of groups.entries()) {
      for (const alternative of group.slice(1)) {
        if (alternatives.length >= 3) {
          return alternatives;
        }
        const unnamed = alternative.kind === 'edge'
          && [alternative.selector.producer, ...alternative.selector.refs ?? []]
            .some(producer => producer && !names.producers.has(producer));
        if (unnamed) {
          continue;
        }
        alternatives.push(VertexPointSynthesizer.form(winners.map((winner, j) => i === j ? alternative : winner), names));
      }
    }
    return alternatives;
  }

  private static describePart(part: PointPart, names: PointNames): SynthesizedSelectionPart {
    const source = VertexPointSynthesizer.render(part, names, false);
    if (part.kind === 'sketch') {
      return { producer: part.sketch.id, accessor: 'geometries', tier: 0, source, point: { kind: 'sketch', target: part.request.target } };
    }
    return {
      producer: part.selector.producer?.id ?? null,
      accessor: part.selector.accessor,
      tier: part.selector.tier,
      source,
      bakedConstants: part.selector.bakedConstants,
      point: {
        kind: 'edge', role: part.role, indices: part.selector.indices, filterArgs: part.selector.filterArgs,
        refs: (part.selector.refs ?? []).map(ref => ref.id),
      },
    };
  }

  private static result(groups: PointGroup[], producers: SceneObject[], names: PointNames): SynthesizedSelection {
    const winners = groups.map(group => group[0]);
    return {
      ok: true,
      ...VertexPointSynthesizer.form(winners, names),
      sameAsInput: false,
      parts: winners.map(part => VertexPointSynthesizer.describePart(part, names)),
      producers: producers.map(producer => {
        const location = producer.getSourceLocation();
        return {
          sceneObjectId: producer.id, sceneObjectName: producer.getName(), featureType: producer.getType(),
          variable: names.producers.get(producer)!,
          filePath: location?.filePath ?? null, line: location?.line ?? null, column: location?.column ?? null,
        };
      }),
      imports: collectImports(winners.flatMap(part => part.kind === 'edge' ? [part.selector] : [])),
      alternatives: VertexPointSynthesizer.alternatives(groups, names),
      exports: winners.flatMap((part, i) => part.kind === 'sketch' ? [{ part: i, ...part.request }] : []),
    };
  }
}
