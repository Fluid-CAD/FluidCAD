import { SceneObject } from "../common/scene-object.js";
import { Shape } from "../common/shape.js";
import { ShapeFilter } from "../filters/filter.js";
import { FaceFilterBuilder } from "../filters/face/face-filter.js";
import { EdgeFilterBuilder } from "../filters/edge/edge-filter.js";
import { SelectionIndex } from "./selection-index.js";
import { attributePick, PickAttribution } from "./attribution.js";
import { synthesizeSelectors, SelectorChain, SelectorPart } from "./synthesis.js";
import {
  allocateNames, collectImports, makeStatementBindable, rehomePlaneFacePick, renderPartArgs,
} from "./explain.js";
import { ApplyFeatureEditSpec, nameHintFor, PickChain, PickRef, SelectionScene, SynthesizeOptions } from "./types.js";

/** The picker kinds whose picks are geometry: a selector names them. */
export type FeatureSlotPicker = 'face' | 'edge' | 'axis' | 'plane';

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
};

/** One picked value of a feature: its picker and what was picked for it. */
export type FeatureSlotPicks = {
  picker: FeatureSlotPicker;
  entities: PickRef[];
  /** Tangent chains ("Select with tangents"), an edge picker's only. */
  chains?: PickChain[];
  options?: FeatureSlotOptions;
};

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

/** A slot checked and synthesized, waiting for the producers every slot shares to be named. */
type SynthesizedSlot = { name: string; winners: SelectorPart[]; wrap: 'axis' | 'plane' | null };

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
 * filters on the picked shape.
 *
 * Kind-agnostic: a slot is described by its picker, never by the feature
 * that declares it, so a new feature needs nothing here. Statement-backed
 * picks (a sketch, an axis or plane statement, a solid, a feature) name no
 * geometry and never come here — the editor binds them by call site.
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
    for (const slot of slots) {
      const result: FeatureSlotResult = { parts: [], args: [], wrap: slot.wrap };
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
        result.args.push(slot.wrap ? `${slot.wrap}(${selector})` : selector);
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
    if (kind !== 'face' && kind !== 'edge' && kind !== 'axis' && kind !== 'plane') {
      throw new SlotRefusal(`${label}: the ${String(kind)} picker names no geometry to synthesize`, name);
    }
    const chains = picks.chains ?? [];
    const refs = picks.entities ?? [];
    if (refs.length === 0 && chains.length === 0) {
      throw new SlotRefusal(`${label}: nothing picked`, name);
    }
    if (chains.length > 0 && kind !== 'edge') {
      throw new SlotRefusal(`${label}: only an edge picker takes tangent chains`, name, chains[0].seed);
    }
    const isList = options.multiple === true || options.max !== undefined;
    const pickCount = refs.length + chains.length;
    if (kind === 'axis' || kind === 'plane' || !isList) {
      if (pickCount !== 1) {
        throw new SlotRefusal(`${label}: pick exactly one ${kind === 'axis' ? 'edge' : kind === 'plane' ? 'face or edge' : kind}`, name, refs[1] ?? refs[0]);
      }
    } else if (options.max !== undefined && pickCount > options.max) {
      throw new SlotRefusal(`${label}: takes at most ${options.max} ${kind}s, got ${pickCount}`, name, refs[options.max]);
    }

    // Chain members are routed through their chain, never as free picks.
    const chained = new Set(chains.flatMap(chain => chain.members.map(FeatureSlotSynthesizer.refKey)));
    const attributions = refs
      .filter(ref => !chained.has(FeatureSlotSynthesizer.refKey(ref)))
      .map(ref => attributePick(this.scene, this.index, ref));
    const chainInputs: SelectorChain[] = chains.map(chain => ({
      seed: attributePick(this.scene, this.index, chain.seed),
      members: chain.members.map(member => attributePick(this.scene, this.index, member)),
    }));
    for (const attr of [...attributions, ...chainInputs.flatMap(chain => [chain.seed, ...chain.members])]) {
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
      this.scene, this.index, attributions, chainInputs, this.options.params ?? [], kind === 'plane', this.stmtBindable,
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

  /** The picked sub-shape is of the kind the picker takes, and passes its declared filter. */
  private check(name: string, label: string, kind: FeatureSlotPicker, options: FeatureSlotOptions, attr: PickAttribution): void {
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

  private static refKey(ref: PickRef): string {
    return `${ref.shapeId}:${ref.sub.type}:${ref.sub.index}`;
  }
}
