import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { ShapeFilter } from "../filters/filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { anchorFromShape, type VertexAnchorSpec } from "../features/shape-anchor.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick, PickAttribution } from "./attribution.js";
import { synthesizeSelectors, SelectorPart } from "./synthesis.js";
import {
  allocateNames, collectImports, makeStatementBindable, rehomePlaneFacePick, renderPartArgs,
} from "./explain.js";
import { VertexPointSynthesizer } from "./vertex-synthesis.js";
import { renderSolvedTarget, type SolvedEmissionTarget } from "./sketch-target.js";
import {
  ApplyFeatureEditSpec, nameHintFor, PickRef, renderConnectorAnchorSuffix, SelectionScene, SynthesizeOptions,
} from "./types.js";

/**
 * The picker kinds whose picks are geometry: a selector names them — a
 * point as the end of an edge or a sketch point, an anchor as a face's or
 * an edge's well-known point.
 */
export type FeatureSlotPicker = 'face' | 'edge' | 'axis' | 'plane' | 'point' | 'anchor';

/** What a slot's picker declares that the picks must honour — the value's spec, as the feature's metadata states it. */
export type FeatureSlotOptions = {
  /** The value's label, for the messages; its name when left out. */
  label?: string;
  /** The value is a list. */
  multiple?: boolean;
  /** The value is a list of at most this many. */
  max?: number;
  /** Only faces of this surface. */
  surface?: 'planar' | 'cylinder' | 'cone' | 'torus';
  /** Only edges of this curve. */
  curve?: 'line' | 'circle' | 'arc';
  /** A picked face stands for all of its edges. */
  facesAsEdges?: boolean;
  /** An anchor picker's: the well-known points it takes; every one when left out. */
  anchors?: readonly VertexAnchorSpec['kind'][];
};

/** One picked value of a feature: its picker and what was picked for it. */
export type FeatureSlotPicks = {
  picker: FeatureSlotPicker;
  entities: PickRef[];
  /** An anchor picker's: the well-known point of each picked face or edge, in pick order. */
  anchors?: VertexAnchorSpec[];
  options?: FeatureSlotOptions;
};

/**
 * One element of a point or anchor value: a point a selector names, with
 * what follows it (`e.endFaces()` + `.center()`, `e.endEdges(0)` +
 * `.start()`), or a point of a sketch the sketch must export before a
 * statement outside it can name it.
 */
export type FeatureSlotPoint =
  | { part: number; suffix: string }
  | { sketch: number; target: SolvedEmissionTarget };

/** Every picked value of one statement, by value name. */
export type FeatureSlotRequest = { slots: Record<string, FeatureSlotPicks> };

/** One value's answer: its elements, in order. */
export type FeatureSlotResult = {
  /** One spec part per element (an index into the synthesis's `parts`): a list takes several, a single value one. */
  parts: number[];
  /** Each element as the statement writes it, producers by the namer's names: `e.endFaces()`, `axis(e.sideEdges(0))`. */
  args: string[];
  /** The call each element's selector is wrapped in: an axis picker's `axis(…)`, a plane picker's `plane(…)`. */
  wrap: 'axis' | 'plane' | null;
  /**
   * A point or anchor picker's elements, one per pick in pick order — the
   * sketch a sketch point stands in indexing `producers`. `parts` lists the
   * selectors they use; `args` one text per element.
   */
  points?: FeatureSlotPoint[];
};

export type FeatureSlotSynthesis =
  | {
    ok: true;
    /** The file the producers live in — where the statement goes; null when nothing was picked. */
    filePath: string | null;
    /** Every slot's producers, merged: a statement two slots read is bound once. */
    producers: ApplyFeatureEditSpec['producers'];
    /** Every slot's selector parts, `producer` and `refs` indexing {@link producers}. */
    parts: ApplyFeatureEditSpec['parts'];
    /** Symbols the selectors need imported (`select`, `face`, `edge`, `axis`, `plane`). */
    imports: string[];
    slots: Record<string, FeatureSlotResult>;
  }
  | { ok: false; reason: string; slot?: string; pick?: PickRef };

/** A point or anchor element before the producers are named: a winner's index and its suffix, or a sketch point. */
type SlotPoint =
  | { winner: number; suffix: string }
  | { sketch: SceneObject; target: SolvedEmissionTarget; entity: SceneObject | null };

/** A slot checked and synthesized, waiting for the producers every slot shares to be named. */
type SynthesizedSlot = { name: string; winners: SelectorPart[]; wrap: 'axis' | 'plane' | null; points?: SlotPoint[] };

/** A refusal while synthesizing one slot. */
class SlotRefusal extends Error {
  constructor(message: string, readonly slot: string, readonly pick?: PickRef) {
    super(message);
  }
}

/**
 * The selectors a custom feature's picked values write: each geometry
 * picker's picks (faces, edges, an axis edge, a plane face) synthesized the
 * way the language names them — the same attribution, tier ladder and
 * oracle verification every dialog's picks go through — and checked against
 * what the picker declares: the kind of sub-shape, how many, and the
 * `surface`/`curve` filters, which run the language's own face and edge
 * filters on the picked shape. A point value's vertices are named the way
 * every vertex pick is ({@link VertexPointSynthesizer}), an anchor value's
 * faces and edges each by a selector of its own with the anchor after it.
 *
 * Kind-agnostic: a slot is described by its picker, never by the feature
 * that declares it, so a new feature needs nothing here. Statement-backed
 * picks (a sketch, an axis or plane statement, a solid, a feature, a
 * connector) name no geometry and never come here — the editor binds them
 * by call site. A value of several kinds arrives as one slot per kind.
 */
export class FeatureSlotSynthesizer {

  private static readonly SURFACE_FILTERS: Record<NonNullable<FeatureSlotOptions['surface']>, { code: string; filter: () => FaceFilterBuilder }> = {
    planar: { code: 'face().planar()', filter: () => new FaceFilterBuilder().planar() },
    cylinder: { code: 'face().cylinder()', filter: () => new FaceFilterBuilder().cylinder() },
    cone: { code: 'face().cone()', filter: () => new FaceFilterBuilder().cone() },
    torus: { code: 'face().torus()', filter: () => new FaceFilterBuilder().torus() },
  };

  private static readonly CURVE_FILTERS: Record<NonNullable<FeatureSlotOptions['curve']>, { code: string; filter: () => EdgeFilterBuilder }> = {
    line: { code: 'edge().line()', filter: () => new EdgeFilterBuilder().line() },
    circle: { code: 'edge().circle()', filter: () => new EdgeFilterBuilder().circle() },
    arc: { code: 'edge().arc()', filter: () => new EdgeFilterBuilder().arc() },
  };

  static synthesize(scene: SelectionScene, request: FeatureSlotRequest, options: SynthesizeOptions = {}): FeatureSlotSynthesis {
    const entries = Object.entries(request?.slots ?? {});
    if (entries.length === 0) {
      return { ok: false, reason: 'nothing picked' };
    }
    const index = new SelectionIndex(scene);
    try {
      return new FeatureSlotSynthesizer(scene, index, options).run(entries);
    } catch (error) {
      if (error instanceof SlotRefusal) {
        return { ok: false, reason: error.message, slot: error.slot, ...(error.pick ? { pick: error.pick } : {}) };
      }
      throw error;
    } finally {
      index.dispose();
    }
  }

  private readonly stmtBindable: ((feature: SceneObject) => boolean) | undefined;

  /** Every bound producer in first-seen order; a statement two slots read is listed once. */
  private readonly producers: SceneObject[] = [];

  /** Statements that only anchor a slot's scope (every part a global `select()`), never bound. */
  private readonly anchors: SceneObject[] = [];

  private constructor(
    private readonly scene: SelectionScene,
    private readonly index: SelectionIndex,
    private readonly options: SynthesizeOptions,
  ) {
    this.stmtBindable = makeStatementBindable(options.bindable);
  }

  private run(entries: [string, FeatureSlotPicks][]): FeatureSlotSynthesis {
    const slots = entries.map(([name, picks]) => this.slot(name, picks));

    const located = [...this.producers, ...this.anchors.filter(anchor => !this.producers.includes(anchor))];
    const filePaths = new Set(located.map(obj => obj.getSourceLocation()!.filePath));
    if (filePaths.size > 1) {
      return { ok: false, reason: 'the picks come from features in different files' };
    }

    const names = allocateNames(this.producers, this.options.namer);
    const producerIndex = (obj: SceneObject) => located.indexOf(obj);
    const parts: ApplyFeatureEditSpec['parts'] = [];
    const results: Record<string, FeatureSlotResult> = {};
    const imports = new Set<string>();
    const entityNames = new Set(names.values());
    for (const slot of slots) {
      const result: FeatureSlotResult = { parts: [], args: [], wrap: slot.wrap };
      const selectors: string[] = [];
      for (const part of slot.winners) {
        result.parts.push(parts.length);
        parts.push({
          producer: part.producer ? producerIndex(part.producer) : null,
          accessor: part.accessor,
          indices: part.indices,
          filterArgs: part.filterArgs,
          refs: part.refs && part.refs.length > 0 ? part.refs.map(producerIndex) : null,
        });
        const selector = renderPartArgs(part, names);
        selectors.push(selector);
        if (!slot.points) {
          result.args.push(slot.wrap ? `${slot.wrap}(${selector})` : selector);
        }
      }
      if (slot.points) {
        result.points = [];
        for (const point of slot.points) {
          if ('winner' in point) {
            result.points.push({ part: result.parts[point.winner], suffix: point.suffix });
            result.args.push(`${selectors[point.winner]}${point.suffix}`);
            continue;
          }
          result.points.push({ sketch: producerIndex(point.sketch), target: point.target });
          const sketchName = names.get(point.sketch) ?? 's';
          const entityName = point.entity ? VertexPointSynthesizer.entityName(point.entity, entityNames) : 'e';
          result.args.push(renderSolvedTarget(point.target, () => `${sketchName}.geometries.${entityName}`));
        }
      }
      for (const symbol of collectImports(slot.winners)) {
        imports.add(symbol);
      }
      if (slot.wrap) {
        imports.add(slot.wrap);
      }
      results[slot.name] = result;
    }

    return {
      ok: true,
      filePath: filePaths.size === 1 ? filePaths.values().next().value! : null,
      producers: located.map(obj => {
        const loc = obj.getSourceLocation()!;
        return {
          line: loc.line,
          column: loc.column,
          featureType: obj.getType(),
          nameHint: nameHintFor(obj.getType()),
          bind: this.producers.includes(obj),
        };
      }),
      parts,
      imports: [...imports],
      slots: results,
    };
  }

  /** One slot's picks, checked against its picker and synthesized into its selectors. */
  private slot(name: string, picks: FeatureSlotPicks): SynthesizedSlot {
    const options = picks.options ?? {};
    const label = options.label ?? name;
    const kind = picks.picker;
    if (kind === 'point') {
      return this.pointSlot(name, label, picks, options);
    }
    if (kind === 'anchor') {
      return this.anchorSlot(name, label, picks, options);
    }
    if (kind !== 'face' && kind !== 'edge' && kind !== 'axis' && kind !== 'plane') {
      throw new SlotRefusal(`${label}: the ${String(kind)} picker names no geometry to synthesize`, name);
    }
    const refs = picks.entities ?? [];
    if (refs.length === 0) {
      throw new SlotRefusal(`${label}: nothing picked`, name);
    }
    const isList = options.multiple === true || options.max !== undefined;
    if (kind === 'axis' || kind === 'plane' || !isList) {
      if (refs.length !== 1) {
        throw new SlotRefusal(`${label}: pick exactly one ${kind === 'axis' ? 'edge' : kind === 'plane' ? 'face or edge' : kind}`, name, refs[1] ?? refs[0]);
      }
    } else if (options.max !== undefined && refs.length > options.max) {
      throw new SlotRefusal(`${label}: takes at most ${options.max} ${kind}s, got ${refs.length}`, name, refs[options.max]);
    }

    const attributions = refs.map(ref => attributePick(this.scene, this.index, ref));
    for (const attr of attributions) {
      if (attr.error) {
        throw new SlotRefusal(`${label}: ${attr.error}`, name, attr.ref);
      }
      this.check(name, label, kind, options, attr);
    }

    // A plane is read off the picked face alone, so a face a later feature
    // reshaped may be named by a stand-in on the same plane — the re-home
    // sketch() and plane() picks get. A plane prefers the compact index form.
    if (kind === 'plane') {
      for (let i = 0; i < attributions.length; i++) {
        attributions[i] = rehomePlaneFacePick(this.scene, this.index, attributions[i], this.stmtBindable);
      }
    }
    const synthesis = synthesizeSelectors(
      this.scene, this.index, attributions, [], this.options.params ?? [], kind === 'plane', this.stmtBindable,
    );
    if (synthesis.ok === false) {
      throw new SlotRefusal(`${label}: ${synthesis.reason}`, name, synthesis.pick);
    }
    const winners = synthesis.groups.map(group => group.winner);
    // A single value — and an axis or a plane — is one scene object, which a
    // selection spread over several parts can't be.
    if (winners.length !== 1 && (!isList || kind === 'axis' || kind === 'plane')) {
      throw new SlotRefusal(`${label}: the picks need ${winners.length} selectors, and this value takes one — pick geometry of one feature`, name);
    }
    for (const producer of synthesis.producers) {
      if (!this.producers.includes(producer)) {
        this.producers.push(producer);
      }
    }
    if (synthesis.anchor && !this.anchors.includes(synthesis.anchor)) {
      this.anchors.push(synthesis.anchor);
    }
    return { name, winners, wrap: kind === 'axis' || kind === 'plane' ? kind : null };
  }

  /**
   * A point value's picks, each a vertex: a solid's written as the end of an
   * edge that names it (`e.endEdges(0).start()`), a sketch's as a point the
   * sketch exports (`s.geometries.l1.start()`) — the vertex synthesis every
   * point pick goes through.
   */
  private pointSlot(name: string, label: string, picks: FeatureSlotPicks, options: FeatureSlotOptions): SynthesizedSlot {
    const refs = picks.entities ?? [];
    this.checkCount(name, label, 'point', options, refs);
    for (const ref of refs) {
      if (ref.sub.type !== 'vertex') {
        throw new SlotRefusal(`${label}: takes points — a vertex of a solid or a sketch, not ${ref.sub.type === 'edge' ? 'an edge' : `a ${ref.sub.type}`}`, name, ref);
      }
    }
    const best = VertexPointSynthesizer.best(this.scene, this.index, refs, this.options);
    if (best.ok === false) {
      throw new SlotRefusal(`${label}: ${best.reason}`, name, best.pick);
    }
    const winners: SelectorPart[] = [];
    const points: SlotPoint[] = [];
    for (const part of best.parts) {
      if (part.kind === 'edge') {
        winners.push(part.selector);
        points.push({ winner: winners.length - 1, suffix: `.${part.role}()` });
        this.bind([part.selector.producer, ...part.selector.refs ?? []]);
        continue;
      }
      this.bind([part.sketch]);
      const target = part.request.target;
      points.push({ sketch: part.sketch, target, entity: target.line !== undefined ? part.entities.get(target.line) ?? null : null });
    }
    return { name, winners, wrap: null, points };
  }

  /**
   * An anchor value's picks, each a face or an edge with the well-known
   * point taken on it (`e.endFaces().center()`): each named by a selector of
   * its own, which must name exactly that face or edge — an anchor reads the
   * first shape of its selection. Never a connector: the statement writes
   * the bare anchor.
   */
  private anchorSlot(name: string, label: string, picks: FeatureSlotPicks, options: FeatureSlotOptions): SynthesizedSlot {
    const refs = picks.entities ?? [];
    const anchors = picks.anchors ?? [];
    this.checkCount(name, label, 'anchor', options, refs);
    if (anchors.length !== refs.length) {
      throw new SlotRefusal(`${label}: each picked face or edge needs the anchor taken on it`, name);
    }
    const winners: SelectorPart[] = [];
    const points: SlotPoint[] = [];
    refs.forEach((ref, i) => {
      const spec = anchors[i];
      if (ref.sub.type !== 'face' && ref.sub.type !== 'edge') {
        throw new SlotRefusal(`${label}: takes anchors on faces and edges, not ${ref.sub.type === 'vertex' ? 'a vertex' : `a ${ref.sub.type}`}`, name, ref);
      }
      if (options.anchors && options.anchors.length > 0 && !options.anchors.includes(spec?.kind)) {
        throw new SlotRefusal(`${label}: takes anchors at ${options.anchors.map(anchor => `${anchor}()`).join(', ')} — not ${spec?.kind}()`, name, ref);
      }
      const attribution = attributePick(this.scene, this.index, ref);
      if (attribution.error || !attribution.picked) {
        throw new SlotRefusal(`${label}: ${attribution.error ?? 'the pick does not resolve in the current scene'}`, name, ref);
      }
      try {
        anchorFromShape(attribution.picked, spec);
      } catch (error) {
        throw new SlotRefusal(`${label}: ${(error as Error).message}`, name, ref);
      }
      const synthesis = synthesizeSelectors(
        this.scene, this.index, [attribution], [], this.options.params ?? [], false, this.stmtBindable,
      );
      if (synthesis.ok === false) {
        throw new SlotRefusal(`${label}: ${synthesis.reason}`, name, synthesis.pick);
      }
      if (synthesis.groups.length !== 1) {
        throw new SlotRefusal(`${label}: the anchor's ${ref.sub.type} needs ${synthesis.groups.length} selectors — pick it on one feature`, name, ref);
      }
      winners.push(synthesis.groups[0].winner);
      points.push({ winner: winners.length - 1, suffix: renderConnectorAnchorSuffix(spec) });
      this.bind(synthesis.producers);
      if (synthesis.anchor && !this.anchors.includes(synthesis.anchor)) {
        this.anchors.push(synthesis.anchor);
      }
    });
    return { name, winners, wrap: null, points };
  }

  /** How many picks a point or anchor value takes: one for a single value, up to its `max` for a list. */
  private checkCount(name: string, label: string, kind: 'point' | 'anchor', options: FeatureSlotOptions, refs: PickRef[]): void {
    const isList = options.multiple === true || options.max !== undefined;
    if (refs.length === 0) {
      throw new SlotRefusal(`${label}: nothing picked`, name);
    }
    if (!isList && refs.length !== 1) {
      throw new SlotRefusal(`${label}: pick exactly one ${kind}`, name, refs[1]);
    }
    if (options.max !== undefined && refs.length > options.max) {
      throw new SlotRefusal(`${label}: takes at most ${options.max} ${kind}s, got ${refs.length}`, name, refs[options.max]);
    }
  }

  /** Bind the producers a selector or a sketch point names, each once. */
  private bind(producers: (SceneObject | null | undefined)[]): void {
    for (const producer of producers) {
      if (producer && !this.producers.includes(producer)) {
        this.producers.push(producer);
      }
    }
  }

  /** The picked sub-shape is of the kind the picker takes, and passes its declared filter. */
  private check(name: string, label: string, kind: 'face' | 'edge' | 'axis' | 'plane', options: FeatureSlotOptions, attr: PickAttribution): void {
    const type = attr.ref.sub.type;
    const takes = kind === 'face' ? type === 'face'
      : kind === 'edge' ? type === 'edge' || (type === 'face' && options.facesAsEdges === true)
        : kind === 'axis' ? type === 'edge'
          : type === 'face' || type === 'edge';
    if (!takes) {
      const wanted = kind === 'face' ? 'faces' : kind === 'edge' ? 'edges' : kind === 'axis' ? 'an edge' : 'a face or an edge';
      throw new SlotRefusal(`${label}: takes ${wanted}, not ${type === 'edge' ? 'an edge' : `a ${type}`}`, name, attr.ref);
    }
    const picked = attr.picked;
    if (!picked) {
      return;
    }
    if (kind === 'face' && options.surface) {
      const surface = FeatureSlotSynthesizer.SURFACE_FILTERS[options.surface];
      if (surface && !FeatureSlotSynthesizer.matches(picked, surface.filter())) {
        throw new SlotRefusal(`${label}: the picked face is not ${FeatureSlotSynthesizer.article(options.surface)} — this value takes faces that match ${surface.code}`, name, attr.ref);
      }
    }
    if (kind === 'edge' && options.curve && type === 'edge') {
      const curve = FeatureSlotSynthesizer.CURVE_FILTERS[options.curve];
      if (curve && !FeatureSlotSynthesizer.matches(picked, curve.filter())) {
        throw new SlotRefusal(`${label}: the picked edge is not ${FeatureSlotSynthesizer.article(options.curve)} — this value takes edges that match ${curve.code}`, name, attr.ref);
      }
    }
  }

  /** Whether the language's own filter keeps `shape`. */
  private static matches(shape: Shape, filter: FaceFilterBuilder | EdgeFilterBuilder): boolean {
    return new ShapeFilter([shape], filter).apply().length > 0;
  }

  /** `planar`, `a cylinder`, `an arc`: what a filter names, as the message reads it. */
  private static article(name: string): string {
    if (name === 'planar') {
      return 'planar';
    }
    return `${/^[aeiou]/.test(name) ? 'an' : 'a'} ${name}`;
  }
}
