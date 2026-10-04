import type {
  ConnectorAnchor, CustomPickInput, FeaturePickerKind, FeaturePickerParam, GhostCustomRef, ParsedCustomPick, SourceSlotRef,
} from '../../../api';
import { sameEntity } from '../../../helpers/entities';
import { findEnclosingPartRow } from '../../../helpers/scene-utils';
import type { StandardAxisId } from '../../../scene/standard-axes';
import type { StandardPlaneId } from '../../../scene/standard-planes';
import type { SceneObjectRender, SourceLocation, SubSelection } from '../../../types';
import type { SelectedEntity } from '../../../viewer';
import { PickSlot, type PickSlotChip } from '../../pick-slot';
import {
  AXIS_UNAVAILABLE_MESSAGE, axisLineShapeIds, axisOptionForLocation, axisOptionForShape, collectAxisOptions,
} from '../axis-options';
import { anchorChipLabel, type LockedAnchor } from '../anchor-suggestions';
import { ConnectorOptions } from '../connector-options';
import { consumedReveal } from '../consumed-reveal';
import { vertexLabel } from '../hole/hole-placements';
import {
  collectPlaneOptions, planeOptionForLocation, planeOptionForShape, planeQuadShapeIds, resolvePlaneRow,
} from '../plane-bases';
import { resolveRepeatTargetRow } from '../repeat-targets';
import { partScopedSolidTargets } from '../scope-targets';
import {
  collectSketchProfiles, collectWireSources, resolveSketchByShapeId, resolveSketchRow, resolveWireByShapeId,
  resolveWireRow, sketchWireShapeIds, sourceChip,
} from '../sketch-profiles';
import { FeatureSchema } from './feature-schema';

/** A world axis or an origin plane, as a picked value names it. */
export type StandardDatum = StandardAxisId | StandardPlaneId;

/** A statement a picker offers, by call site. */
export type PickerOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** The feature that consumed it (hid it) in this world; the dialog reveals it while it holds it. */
  consumer?: string;
  /** A sketch: whether it holds geometry yet. */
  hasGeometry?: boolean;
  /** A sketch: it is the one being edited. */
  active?: boolean;
  /** A solid or a feature: its rendered solids, lit while it is picked. */
  shapeIds?: string[];
  /** The kind it is picked as — a value of several kinds offers each kind's statements. */
  picker: FeaturePickerKind;
  /** A connector copy's pattern slot (`bolt.instance(2)`), addressed by its seed's statement. */
  slot?: number;
  /** A connector's scene id in this render: gizmo picks find it by it, and the viewport enlarges it. */
  connectorId?: string;
};

/** A statement's call site, and a connector copy's slot. */
type StatementSite = { filePath: string; line: number; slot?: number };

/**
 * One element of a picked value. `keep` is the edited statement's own
 * element, kept verbatim by its position — `loc` the statement a plain
 * variable names, `option` that statement as this scene offers it, `source`
 * what the engine resolved the element to (its faces, its edge). The rest
 * are the dialog's picks: a statement, a face or edge, a world axis or an
 * origin plane.
 */
export type PickElement =
  | {
    kind: 'keep';
    sourceIndex: number;
    text: string;
    loc: (SourceLocation & { slot?: number }) | null;
    option: PickerOption | null;
    source: SourceSlotRef | null;
  }
  | { kind: 'statement'; option: PickerOption }
  /** A face or an edge — or, for a point, a vertex — picked in the viewport. */
  | { kind: 'entity'; entity: SelectedEntity }
  /** A face or an edge and the well-known point taken on it, locked from the hover suggestions. */
  | { kind: 'anchor'; locked: LockedAnchor }
  | { kind: 'standard'; name: StandardDatum };

/** What the viewer offers while a slot is armed. */
export type PickChannels = {
  pickFilter: 'all' | 'edge' | 'face' | 'vertex' | 'none';
  sketchWires: boolean;
  axes: boolean;
  planes: boolean;
  standardAxes: boolean;
  standardPlanes: boolean;
  /** Connector gizmos, revealed and pickable. */
  connectors: boolean;
  /** Vertex dots, tried ahead of faces and edges. */
  vertices: boolean;
  /** The anchor suggestions a hovered face or edge floats. */
  anchors: boolean;
};

/** The armed scope slot (whole solids) and no armed slot at all. */
export const SCOPE_CHANNELS: PickChannels = {
  pickFilter: 'all', sketchWires: false, axes: false, planes: false, standardAxes: false, standardPlanes: false,
  connectors: false, vertices: false, anchors: false,
};
export const NO_CHANNELS: PickChannels = { ...SCOPE_CHANNELS, pickFilter: 'none' };

/** The kinds a value picks as statements, by call site. */
const STATEMENT_KINDS: ReadonlySet<FeaturePickerKind> = new Set(['sketch', 'axis', 'plane', 'solid', 'feature', 'connector']);

/** The kinds that stand for a location: their kept elements are read off the edited feature. */
const LOCATION_KINDS: ReadonlySet<FeaturePickerKind> = new Set(['connector', 'point', 'anchor']);

/** What each kind's armed slot needs the viewer to offer. */
const KIND_CHANNELS: Record<FeaturePickerKind, { faces?: boolean; edges?: boolean } & Partial<PickChannels>> = {
  sketch: { sketchWires: true },
  face: { faces: true },
  edge: { edges: true },
  axis: { edges: true, axes: true, standardAxes: true },
  plane: { faces: true, planes: true, standardPlanes: true },
  solid: { faces: true, edges: true },
  // A feature comes from the timeline only.
  feature: {},
  connector: { connectors: true },
  point: { vertices: true },
  anchor: { faces: true, edges: true, anchors: true },
};

/** How a prompt names each kind: one, and several. */
const KIND_NOUNS: Record<FeaturePickerKind, [string, string]> = {
  sketch: ['a sketch', 'sketches'],
  face: ['a face', 'faces'],
  edge: ['an edge', 'edges'],
  axis: ['an axis', 'axes'],
  plane: ['a plane', 'planes'],
  solid: ['a solid', 'solids'],
  feature: ['a feature', 'features'],
  connector: ['a connector', 'connectors'],
  point: ['a point (a vertex)', 'points (vertices)'],
  anchor: ['a face or edge centre', 'face or edge centres'],
};

/** Everything the dialog's picks light up, gathered for one highlight pass. */
export class PickHighlight {
  readonly entities: SelectedEntity[] = [];
  readonly wireIds: string[] = [];
  readonly solidIds: string[] = [];
  readonly planeQuadIds: string[] = [];
  readonly standardAxes: StandardAxisId[] = [];
  /** Picked connectors' scene ids — the viewport draws their gizmos enlarged. */
  readonly connectorIds: string[] = [];

  get isEmpty(): boolean {
    return this.entities.length === 0 && this.wireIds.length === 0 && this.solidIds.length === 0
      && this.planeQuadIds.length === 0;
  }
}

/** A pick offered to a picker: it took it, it doesn't take that kind of thing, or why it refused. */
export type PickOutcome = 'taken' | 'ignored' | { message: string };

/** The scene a picker resolves against, and the part a statement it writes lands in. */
export type PickerScene = { objects: SceneObjectRender[]; partLoc: SourceLocation | null };

const STANDARD_AXIS_TEXT = /^['"]([xyz])['"]$/;
const STANDARD_PLANE_TEXT = /^['"](xy|xz|yz)['"]$/;

/**
 * One picked value of a schema dialog — a `face`, `edge`, `sketch`, `axis`,
 * `plane`, `solid`, `feature`, `connector`, `point` or `anchor` picker, or a
 * picker of several of them — over the shared {@link PickSlot} and the
 * option collectors the built-in dialogs use. Single and list values share
 * one element model: a single value holds at most one element, a list up to
 * its `max`, ordered when the author asked. A value of several kinds routes
 * each pick to the one kind that takes it (the metadata guarantees there is
 * one): a vertex to its point, a connector gizmo to its connector, a face
 * to its face — or, for an anchor, to the suggestion the dialog locks.
 *
 * Every pick comes from the viewport or the timeline. Statement picks —
 * connectors among them, a copy by its seed's statement and slot — re-match
 * their statement by `(filePath, line, slot)` after each render; raw face,
 * edge and vertex picks and locked anchors die with the render that minted
 * their ids, as in the built-in dialogs; an edit's kept elements are
 * addressed by their text and survive anything. The picker answers which
 * viewer channels its armed slot needs, what it lights up, and the request
 * elements it writes.
 */
export class SchemaPicker {
  /** The slot was clicked — the panel arms it. */
  onArm?: () => void;
  /** A gesture in the slot changed the value (a chip's ✕, a reorder). */
  onChange?: () => void;

  /** The row element, hidden while the value's `visibleWhen` fails. */
  readonly row: HTMLElement;
  /** The kinds the value takes, in the order its metadata lists them. */
  readonly kinds: readonly FeaturePickerKind[];
  private readonly slot: PickSlot;
  private elements: PickElement[] = [];
  /**
   * An edit's own elements, in order — what an untouched value still is:
   * the statement's elements, or — for a value the statement leaves out
   * that its feature holds anyway — what the engine reports it holds.
   */
  private keeps: PickElement[] = [];
  /** The edited statement writes elements of its own for this value (else its keeps are what its feature took). */
  private written = false;
  private options: PickerOption[] = [];
  private scene: PickerScene = { objects: [], partLoc: null };
  private editing = false;
  /** One consumed-reveal owner per element position. */
  private readonly revealOwners: object[] = [];

  constructor(readonly name: string, readonly spec: FeaturePickerParam) {
    this.kinds = FeatureSchema.kindsOf(spec);
    this.row = document.createElement('div');
    this.row.dataset.param = name;
    if (spec.description) {
      this.row.title = spec.description;
    }
    const mount = document.createElement('div');
    this.row.appendChild(mount);
    this.slot = new PickSlot(mount, {
      label: spec.label,
      multiple: this.isList,
      reorderable: this.isList && spec.ordered === true,
    });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = (index) => this.removeAt(index);
    this.slot.onReorder = (from, to) => this.reorder(from, to);
    this.render();
  }

  /** Whether the value takes picks of `kind`. */
  takes(kind: FeaturePickerKind): boolean {
    return this.kinds.includes(kind);
  }

  /** The value takes more than one kind of pick. */
  get isUnion(): boolean {
    return this.kinds.length > 1;
  }

  get isList(): boolean {
    return FeatureSchema.isList(this.spec);
  }

  get isEmpty(): boolean {
    return this.elements.length === 0;
  }

  /** It holds all it can take. */
  get isFull(): boolean {
    return this.elements.length >= this.capacity;
  }

  /** An edit changed the value: anything else than its own elements, in their order. */
  get touched(): boolean {
    return this.elements.length !== this.keeps.length || this.elements.some((e, i) => e !== this.keeps[i]);
  }

  /** The elements, for the tests and the ghost to read. */
  get value(): readonly PickElement[] {
    return this.elements;
  }

  get visible(): boolean {
    return !this.row.classList.contains('hidden');
  }

  setVisible(visible: boolean): void {
    this.row.classList.toggle('hidden', !visible);
    this.renderReveal();
  }

  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * A fresh create: empty — except a single sketch value, which opens on
   * the sketch being edited, as the built-in profile slots do.
   */
  reset(): void {
    this.editing = false;
    this.written = false;
    this.keeps = [];
    this.elements = [];
    if (this.kinds.length === 1 && this.takes('sketch') && !this.isList && this.spec.implicitDefault !== true) {
      const active = this.options.find(o => o.active);
      if (active) {
        this.elements = [{ kind: 'statement', option: active }];
      }
    }
    this.render();
  }

  /**
   * An edit: the statement's own elements, each kept verbatim until the
   * user changes the value. `filePath` is the statement's file — the one a
   * plain variable's statement lives in.
   */
  seedKeeps(picks: readonly ParsedCustomPick[] | undefined, filePath: string): void {
    this.editing = true;
    this.written = (picks ?? []).length > 0;
    this.keeps = (picks ?? []).map((pick, sourceIndex) => ({
      kind: 'keep',
      sourceIndex,
      text: pick.text,
      loc: pick.ref
        ? { filePath, line: pick.ref.line, column: pick.ref.column, ...(pick.ref.slot !== undefined ? { slot: pick.ref.slot } : {}) }
        : null,
      option: null,
      source: null,
    }));
    this.elements = [...this.keeps];
    this.resolveKeeps();
    this.render();
  }

  /**
   * What the engine resolved the edited statement's elements to — one slot
   * per element, in order. A kept statement learns its call site; a kept
   * selection (or an anchor's face), the faces or edges it lights up.
   *
   * A value the statement leaves out may still hold something: its builder
   * filled it in — `draft(5)` drafts the last selection. Those elements
   * stand as the value, as the built-in dialogs seed an implicit selection:
   * untouched, the statement keeps leaving it out; changed, the dialog
   * writes them with the rest of the picks.
   */
  setSources(slots: SourceSlotRef | SourceSlotRef[] | undefined): void {
    const list = Array.isArray(slots) ? slots : slots ? [slots] : [];
    if (this.editing && !this.written) {
      this.seedTaken(list);
      return;
    }
    this.keeps.forEach((keep, index) => {
      if (keep.kind !== 'keep') {
        return;
      }
      const source = list[index] ?? null;
      keep.source = source;
      if (!keep.loc && source?.kind === 'sketch') {
        keep.loc = { filePath: source.filePath, line: source.line, column: source.column };
      }
    });
    this.resolveKeeps();
    this.render();
  }

  /**
   * A new scene: the offered statements rebuild, picked statements re-match
   * theirs by `(filePath, line, slot)` (and drop when it is gone), and —
   * when `dropEntities` — picked faces, edges, vertices and anchors drop,
   * since the render minted new ids. Answers whether a pick the user made
   * was dropped.
   */
  setScene(scene: PickerScene, opts: { dropEntities: boolean }): boolean {
    this.scene = scene;
    this.options = this.collectOptions();
    let dropped = false;
    const rematch = (element: PickElement): PickElement[] => {
      if (element.kind === 'statement') {
        const match = this.optionAt(element.option, element.option.picker);
        return match ? [{ kind: 'statement', option: match }] : [];
      }
      return (element.kind === 'entity' || element.kind === 'anchor') && opts.dropEntities ? [] : [element];
    };
    // A value the statement leaves out holds what its feature took: those
    // elements re-match (or drop) with the scene, and come back with the
    // sources the next boundary resolves.
    const keeps = new Map(this.keeps.map(keep => [keep, rematch(keep)[0] ?? null]));
    this.elements = this.elements.flatMap((element): PickElement[] => {
      if (keeps.has(element)) {
        const kept = keeps.get(element);
        return kept ? [kept] : [];
      }
      const next = rematch(element);
      dropped = dropped || next.length === 0;
      return next;
    });
    this.keeps = this.keeps.flatMap(keep => keeps.get(keep) ?? []);
    this.resolveKeeps();
    this.render();
    return dropped;
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /** What the armed slot needs the viewer to offer: every kind's channels, together. */
  channels(): PickChannels {
    const merged: PickChannels & { faces: boolean; edges: boolean } = { ...NO_CHANNELS, faces: false, edges: false };
    for (const kind of this.kinds) {
      const wanted = KIND_CHANNELS[kind];
      for (const key of Object.keys(wanted) as (keyof typeof merged)[]) {
        if (key !== 'pickFilter' && wanted[key as keyof typeof wanted]) {
          (merged as Record<string, unknown>)[key] = true;
        }
      }
      if (kind === 'edge' && this.spec.facesAsEdges) {
        merged.faces = true;
      }
    }
    const { faces, edges, ...channels } = merged;
    channels.pickFilter = faces && edges ? 'all' : faces ? 'face' : edges ? 'edge' : channels.vertices ? 'vertex' : 'none';
    return channels;
  }

  /**
   * The kind a viewport click of this sub-shape lands in, or null when the
   * value takes none: a vertex is a point, a face or an edge whichever kind
   * takes it — an anchor's the suggestion rail locks.
   */
  clickKind(sub: SubSelection): FeaturePickerKind | null {
    if (!sub) {
      return null;
    }
    if (sub.type === 'vertex') {
      return this.takes('point') ? 'point' : null;
    }
    if (sub.type === 'face') {
      const taker = this.kinds.find(kind => kind === 'face' || kind === 'plane' || kind === 'solid' || kind === 'anchor');
      return taker ?? (this.takes('edge') && this.spec.facesAsEdges ? 'edge' : null);
    }
    if (sub.type === 'edge') {
      return this.kinds.find(kind => kind === 'edge' || kind === 'axis' || kind === 'solid' || kind === 'anchor') ?? null;
    }
    return null;
  }

  /** A face, edge or vertex clicked in the viewport. An anchor's clicks go through the suggestion rail ({@link takeAnchor}). */
  takeClick(shapeId: string, sub: SubSelection): PickOutcome {
    const kind = this.clickKind(sub);
    if (!kind || !sub || kind === 'anchor') {
      return 'ignored';
    }
    const entity = { shapeId, sub } as SelectedEntity;
    if (kind === 'solid') {
      const option = this.options.find(o => o.picker === 'solid' && o.shapeIds?.includes(shapeId));
      return option
        ? this.add({ kind: 'statement', option })
        : { message: `${this.spec.label}: that shape is not a solid this statement can reference.` };
    }
    return this.add({ kind: 'entity', entity });
  }

  /** A face's or an edge's anchor, locked from the hover suggestions. */
  takeAnchor(locked: LockedAnchor): PickOutcome {
    if (!this.takes('anchor')) {
      return 'ignored';
    }
    const anchor = locked.anchors[locked.anchorIndex]?.anchor;
    if (!anchor || !this.offersAnchor(anchor)) {
      return { message: `${this.spec.label} takes anchors at ${(this.spec.anchors ?? []).map(a => `${a}()`).join(', ')}.` };
    }
    return this.add({ kind: 'anchor', locked });
  }

  /** Whether the value offers this anchor: its metadata's `anchors`, all of them when it lists none. */
  offersAnchor(anchor: ConnectorAnchor): boolean {
    const offered = this.spec.anchors;
    return !offered || offered.length === 0 || offered.includes(anchor.kind);
  }

  /** A connector gizmo clicked: the connector, or one of its copies. */
  takeConnector(connectorId: string): PickOutcome {
    if (!this.takes('connector')) {
      return 'ignored';
    }
    const option = this.options.find(o => o.picker === 'connector' && o.connectorId === connectorId);
    return option
      ? this.add({ kind: 'statement', option })
      : { message: 'That connector cannot be referenced — only connector() features and their copies can be picked.' };
  }

  /** A timeline row clicked: the statement it stands for, as the first kind that takes it. */
  takeRow(obj: SceneObjectRender): PickOutcome {
    for (const kind of this.kinds) {
      const outcome = this.takeRowAs(kind, obj);
      if (outcome !== 'ignored') {
        return outcome;
      }
    }
    return 'ignored';
  }

  private takeRowAs(kind: FeaturePickerKind, obj: SceneObjectRender): PickOutcome {
    const objects = this.scene.objects;
    switch (kind) {
      case 'sketch': {
        const row = this.spec.wire ? resolveWireRow(obj, objects) : resolveSketchRow(obj, objects);
        return row?.sourceLocation ? this.addStatementAt(kind, row.sourceLocation, 'That sketch is not one this statement can reference.') : 'ignored';
      }
      case 'axis':
        return obj.type === 'axis' && obj.sourceLocation
          ? this.addOption(this.ofKind(kind, axisOptionForLocation(this.optionsOf(kind), obj.sourceLocation)), AXIS_UNAVAILABLE_MESSAGE)
          : 'ignored';
      case 'plane': {
        const row = resolvePlaneRow(obj);
        return row?.sourceLocation
          ? this.addOption(this.ofKind(kind, planeOptionForLocation(this.optionsOf(kind), row.sourceLocation)),
            'That plane cannot be referenced — only plane() features can.')
          : 'ignored';
      }
      case 'solid': {
        if (!obj.sourceLocation || !SchemaPicker.solidIdsOf(obj).length) {
          return 'ignored';
        }
        return this.addStatementAt(kind, obj.sourceLocation, 'That solid is in another part — this statement cannot reference it.');
      }
      case 'feature': {
        const row = resolveRepeatTargetRow(obj, objects);
        if (!row?.sourceLocation) {
          return 'ignored';
        }
        if (!SchemaPicker.typeAllowed(row, this.spec.types)) {
          return { message: `${this.spec.label} takes ${this.spec.types!.join(', ')} features.` };
        }
        return this.addStatementAt(kind, row.sourceLocation, 'That feature is in another part — this statement cannot reference it.');
      }
      case 'connector':
        return obj.type === 'connector' && obj.id != null ? this.takeConnector(obj.id) : 'ignored';
      default:
        return 'ignored';
    }
  }

  /** A sketch wire (or helix) clicked in the viewport. */
  takeSketchWire(shapeId: string): PickOutcome {
    if (!this.takes('sketch')) {
      return 'ignored';
    }
    const objects = this.scene.objects;
    const row = this.spec.wire ? resolveWireByShapeId(shapeId, objects) : resolveSketchByShapeId(shapeId, objects);
    return row?.sourceLocation ? this.addStatementAt('sketch', row.sourceLocation, 'That sketch is not one this statement can reference.') : 'ignored';
  }

  /** An `axis()` line clicked. */
  takeAxisLine(shapeId: string): PickOutcome {
    if (!this.takes('axis')) {
      return 'ignored';
    }
    return this.addOption(this.ofKind('axis', axisOptionForShape(shapeId, this.scene.objects, this.optionsOf('axis'))), AXIS_UNAVAILABLE_MESSAGE);
  }

  /** A `plane()` quad clicked. */
  takePlaneQuad(shapeId: string): PickOutcome {
    if (!this.takes('plane')) {
      return 'ignored';
    }
    return this.addOption(this.ofKind('plane', planeOptionForShape(shapeId, this.scene.objects, this.optionsOf('plane'))),
      'That plane cannot be referenced — only plane() features can.');
  }

  /** A world axis or an origin plane clicked in the viewport. */
  takeStandard(name: StandardDatum): PickOutcome {
    const fits = name.length === 1 ? this.takes('axis') : this.takes('plane');
    return fits ? this.add({ kind: 'standard', name }) : 'ignored';
  }

  // -------------------------------------------------------------------------
  // Request and highlight
  // -------------------------------------------------------------------------

  /**
   * The value as the request writes it: undefined leaves it out (a create
   * lets the builder's default stand; an edit keeps the statement's own),
   * an empty list drops it (an edit), or the message blocking the apply.
   * Picked faces and edges travel together as one `entities` element, where
   * the first of them stood; a point and an anchor each as its own, in the
   * order they were picked.
   */
  request(): CustomPickInput[] | undefined | { error: string } {
    if (this.editing && !this.touched) {
      return undefined;
    }
    if (this.elements.length === 0) {
      if (!this.spec.optional && !(this.kinds.length === 1 && this.takes('sketch') && this.spec.implicitDefault)) {
        return { error: `${this.spec.label}: ${this.prompt().toLowerCase()}.` };
      }
      return this.editing ? [] : undefined;
    }
    const inputs: CustomPickInput[] = [];
    let entities: { kind: 'entities'; entities: SelectedEntity[] } | null = null;
    for (const element of this.elements) {
      if (element.kind === 'keep') {
        inputs.push({ kind: 'verbatim', sourceIndex: element.sourceIndex });
      } else if (element.kind === 'standard') {
        inputs.push({ kind: 'standard', name: element.name });
      } else if (element.kind === 'statement') {
        if (this.spec.hasGeometry && element.option.hasGeometry === false) {
          return { error: `Nothing is drawn in "${element.option.label}" yet.` };
        }
        const { filePath, line, column, slot, picker } = element.option;
        inputs.push({
          kind: 'statement', filePath, line, column,
          ...(this.isUnion ? { picker } : {}),
          ...(slot !== undefined ? { slot } : {}),
        });
      } else if (element.kind === 'anchor') {
        const locked = element.locked;
        inputs.push({ kind: 'anchor', entity: locked.entity, anchor: locked.anchors[locked.anchorIndex].anchor });
      } else if (element.entity.sub.type === 'vertex') {
        inputs.push({ kind: 'point', entity: { shapeId: element.entity.shapeId, sub: { type: 'vertex', index: element.entity.sub.index } } });
      } else if (entities) {
        entities.entities.push(element.entity);
      } else {
        entities = { kind: 'entities', entities: [element.entity] };
        inputs.push(entities);
      }
    }
    return inputs;
  }

  /**
   * The value as its ghost addresses it, one ref per element, in the order
   * the statement holds them: a statement by call site (a connector — a copy
   * with its slot — as a connector), the picked faces and edges together
   * where the first of them stood, a vertex as its point, an anchor as its
   * face or edge and the point taken on it, a world axis or plane; and a
   * kept element as what it resolved to — a location's read off the edited
   * feature itself, any other's as its faces or edges on the solids before
   * the statement, else the statement it names, else the world axis or
   * plane its text spells. Undefined for a value left out; null when an
   * element can't be addressed (a kept expression), which means no ghost
   * rather than a partial one.
   */
  ghostRefs(): GhostCustomRef[] | undefined | null {
    if (this.elements.length === 0) {
      return undefined;
    }
    const refs: GhostCustomRef[] = [];
    let picked: Extract<GhostCustomRef, { kind: 'entities' }> | null = null;
    for (const element of this.elements) {
      if (element.kind === 'entity') {
        const sub = element.entity.sub;
        if (sub.type === 'vertex') {
          refs.push({ kind: 'point', shapeId: element.entity.shapeId, index: sub.index });
          continue;
        }
        if (sub.type !== 'face' && sub.type !== 'edge') {
          return null;
        }
        const entity = { shapeId: element.entity.shapeId, index: sub.index, kind: sub.type };
        if (picked) {
          picked.entities.push(entity);
        } else {
          picked = { kind: 'entities', entities: [entity] };
          refs.push(picked);
        }
        continue;
      }
      const ref = this.elementRef(element);
      if (!ref) {
        return null;
      }
      refs.push(ref);
    }
    return refs;
  }

  private elementRef(element: Exclude<PickElement, { kind: 'entity' }>): GhostCustomRef | null {
    switch (element.kind) {
      case 'statement': {
        const { filePath, line, slot, picker } = element.option;
        return picker === 'connector'
          ? { kind: 'connector', filePath, line, ...(slot !== undefined ? { slot } : {}) }
          : { kind: 'statement', filePath, line };
      }
      case 'standard':
        return { kind: 'standard', name: element.name };
      case 'anchor': {
        const { entity, anchors, anchorIndex } = element.locked;
        if (entity.sub.type === 'vertex') {
          return null;
        }
        return {
          kind: 'anchor',
          entity: { shapeId: entity.shapeId, index: entity.sub.index, kind: entity.sub.type },
          anchor: anchors[anchorIndex].anchor,
        };
      }
      default:
        return this.kinds.some(kind => LOCATION_KINDS.has(kind))
          ? { kind: 'kept', index: element.sourceIndex }
          : this.keepRef(element);
    }
  }

  /** What a kept element resolved to, as a ghost ref — null when it names nothing the ghost can find. */
  private keepRef(keep: Extract<PickElement, { kind: 'keep' }>): GhostCustomRef | null {
    const source = keep.source;
    if (source?.kind === 'entities' && source.entities.length > 0) {
      const entities: Extract<GhostCustomRef, { kind: 'entities' }>['entities'] = [];
      for (const entity of source.entities) {
        if (entity.sub.type !== 'face' && entity.sub.type !== 'edge') {
          return null;
        }
        entities.push({ shapeId: entity.shapeId, index: entity.sub.index, kind: entity.sub.type });
      }
      return { kind: 'entities', entities };
    }
    const loc = source?.kind === 'sketch' ? source : keep.option ?? keep.loc;
    if (loc) {
      return { kind: 'statement', filePath: loc.filePath, line: loc.line };
    }
    const standard = this.standardOf(keep.text);
    return standard ? { kind: 'standard', name: standard } : null;
  }

  /** Whether the request carries viewport geometry — an edit then needs its boundary. */
  get hasPickedGeometry(): boolean {
    return (!this.editing || this.touched) && this.elements.some(e => e.kind === 'entity' || e.kind === 'anchor');
  }

  /** Light up what the value holds. */
  highlight(into: PickHighlight): void {
    for (const element of this.elements) {
      if (element.kind === 'entity') {
        into.entities.push(element.entity);
      } else if (element.kind === 'anchor') {
        into.entities.push({ shapeId: element.locked.entity.shapeId, sub: element.locked.entity.sub } as SelectedEntity);
      } else if (element.kind === 'standard') {
        if (element.name.length === 1) {
          into.standardAxes.push(element.name as StandardAxisId);
        }
      } else if (element.kind === 'statement') {
        this.highlightOption(element.option, into);
      } else if (element.option) {
        this.highlightOption(element.option, into);
      } else if (element.source?.kind === 'entities') {
        into.entities.push(...element.source.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }) as SelectedEntity));
      } else {
        const standard = this.standardOf(element.text);
        if (standard && standard.length === 1) {
          into.standardAxes.push(standard as StandardAxisId);
        }
      }
    }
  }

  /** Whether the value holds this anchor already — the suggestion rail floats no faint twin under it. */
  holdsAnchor(key: string, anchorIndex: number): boolean {
    return this.elements.some(e => e.kind === 'anchor' && e.locked.key === key && e.locked.anchorIndex === anchorIndex);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private get capacity(): number {
    if (!this.isList) {
      return 1;
    }
    return this.spec.max ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Take one element. A list toggles it (picking it again takes it back
   * off) up to its `max`; a single value swaps it in — and picking the same
   * thing again undoes the pick, back to the edited statement's own value or
   * to empty.
   */
  private add(element: PickElement): PickOutcome {
    const existing = this.elements.findIndex(e => SchemaPicker.same(e, element));
    if (existing >= 0) {
      if (!this.isList) {
        if (this.elements[existing].kind !== 'keep') {
          this.elements = [...this.keeps];
          this.render();
        }
        return 'taken';
      }
      this.elements.splice(existing, 1);
      this.render();
      return 'taken';
    }
    if (!this.isList) {
      this.elements = [element];
    } else if (this.elements.length >= this.capacity) {
      return { message: `${this.spec.label} takes at most ${this.capacity}.` };
    } else {
      this.elements.push(element);
    }
    this.render();
    return 'taken';
  }

  private addOption(option: PickerOption | undefined, refusal: string): PickOutcome {
    return option ? this.add({ kind: 'statement', option }) : { message: refusal };
  }

  private addStatementAt(kind: FeaturePickerKind, loc: { filePath: string; line: number }, refusal: string): PickOutcome {
    return this.addOption(this.optionAt(loc, kind), refusal);
  }

  /** A chip's ✕: a list loses the element; a single value undoes its pick (or, optional, drops its own). */
  private removeAt(index: number): void {
    const element = this.elements[index];
    if (!element) {
      return;
    }
    if (this.isList) {
      this.elements.splice(index, 1);
    } else if (this.keeps.includes(element)) {
      this.elements = [];
    } else {
      this.elements = [...this.keeps];
    }
    this.render();
    this.onChange?.();
  }

  private reorder(from: number, to: number): void {
    const [moved] = this.elements.splice(from, 1);
    if (!moved) {
      return;
    }
    this.elements.splice(to, 0, moved);
    this.render();
    this.onChange?.();
  }

  /** The option at a statement's site, as `kind` offers it (any kind when left out). */
  private optionAt(loc: StatementSite, kind?: FeaturePickerKind): PickerOption | undefined {
    return this.options.find(o => (kind === undefined || o.picker === kind)
      && o.filePath === loc.filePath && o.line === loc.line && o.slot === loc.slot);
  }

  /** The options `kind` offers. */
  private optionsOf(kind: FeaturePickerKind): PickerOption[] {
    return this.options.filter(o => o.picker === kind);
  }

  /** An option a collector of `kind` found — typed back to its kind. */
  private ofKind(kind: FeaturePickerKind, option: Omit<PickerOption, 'picker'> | undefined): PickerOption | undefined {
    return option ? { ...option, picker: kind } as PickerOption : undefined;
  }

  /**
   * The elements a value the statement leaves out holds, from the engine's
   * sources — faces and edges, a statement — as the value's keeps; an
   * untouched value shows them, one the user already changed keeps the
   * change. An element nothing can address (opaque) is left out.
   */
  private seedTaken(list: readonly SourceSlotRef[]): void {
    const untouched = !this.touched;
    const taken: PickElement[] = [];
    for (const source of list) {
      if (source.kind === 'entities') {
        for (const entity of source.entities) {
          if (entity.sub.type === 'face' || entity.sub.type === 'edge') {
            taken.push({ kind: 'entity', entity: { shapeId: entity.shapeId, sub: entity.sub } as SelectedEntity });
          }
        }
      } else if (source.kind === 'sketch') {
        const option = this.optionAt(source);
        if (option) {
          taken.push({ kind: 'statement', option });
        }
      }
    }
    this.keeps = taken;
    if (untouched) {
      this.elements = [...taken];
    }
    this.render();
  }

  /** Whether an element is one the edited statement holds already: its own, or what its feature took. */
  private isKept(element: PickElement): boolean {
    return element.kind === 'keep' || this.keeps.includes(element);
  }

  /** A kept element that names a statement, as this scene offers it. */
  private resolveKeeps(): void {
    for (const element of this.keeps) {
      if (element.kind === 'keep') {
        element.option = element.loc ? this.optionAt(element.loc) ?? null : null;
      }
    }
  }

  /** The statements this value can take in the current scene, every kind's. */
  private collectOptions(): PickerOption[] {
    return this.kinds.flatMap(kind => this.collectOptionsOf(kind));
  }

  private collectOptionsOf(kind: FeaturePickerKind): PickerOption[] {
    const { objects, partLoc } = this.scene;
    const typed = (options: Omit<PickerOption, 'picker'>[]): PickerOption[] => options.map(option => ({ ...option, picker: kind }) as PickerOption);
    switch (kind) {
      case 'sketch':
        return typed((this.spec.wire ? collectWireSources(objects) : collectSketchProfiles(objects)).map(option => ({
          label: option.label,
          filePath: option.filePath,
          line: option.line,
          column: option.column,
          consumer: option.consumer,
          hasGeometry: option.hasGeometry,
          active: option.kind === 'active',
        })));
      case 'axis':
        return typed(collectAxisOptions(objects));
      case 'plane':
        return typed(collectPlaneOptions(objects));
      case 'solid':
        return typed(partScopedSolidTargets(objects, partLoc));
      case 'feature':
        return typed(SchemaPicker.featureOptions(objects, partLoc, this.spec.types));
      case 'connector':
        return ConnectorOptions.collect(objects).map(option => ({
          label: option.label,
          filePath: option.filePath,
          line: option.line,
          column: option.column,
          picker: 'connector',
          connectorId: option.id,
          ...(option.slot !== undefined ? { slot: option.slot } : {}),
        }));
      default:
        return [];
    }
  }

  private highlightOption(option: PickerOption, into: PickHighlight): void {
    const objects = this.scene.objects;
    switch (option.picker) {
      case 'sketch':
        into.wireIds.push(...sketchWireShapeIds(option, objects));
        break;
      case 'axis':
        into.wireIds.push(...axisLineShapeIds(option, objects));
        break;
      case 'plane':
        into.planeQuadIds.push(...planeQuadShapeIds(option, objects));
        break;
      case 'connector':
        if (option.connectorId) {
          into.connectorIds.push(option.connectorId);
        }
        break;
      default:
        into.solidIds.push(...(option.shapeIds ?? []));
    }
  }

  private standardOf(text: string): StandardDatum | null {
    const pattern = this.takes('axis') ? STANDARD_AXIS_TEXT : this.takes('plane') ? STANDARD_PLANE_TEXT : null;
    const match = pattern ? text.trim().match(pattern) : null;
    return match ? match[1] as StandardDatum : null;
  }

  private prompt(): string {
    const many = this.isList;
    if (this.isUnion) {
      return `Pick ${SchemaPicker.listed(this.kinds.map(kind => KIND_NOUNS[kind][many ? 1 : 0]))}`;
    }
    switch (this.kinds[0]) {
      case 'sketch':
        return this.spec.implicitDefault ? 'The active sketch, or pick one' : many ? 'Pick sketches' : 'Pick a sketch';
      case 'face': {
        const surface = this.spec.surface ? `${this.spec.surface} ` : '';
        return many ? `Pick ${surface}faces` : `Pick a ${surface}face`;
      }
      case 'edge': {
        const curve = this.spec.curve ? `${this.spec.curve} ` : '';
        return many ? `Pick ${curve}edges` : `Pick ${curve ? `a ${curve}` : 'an'} edge`;
      }
      case 'axis':
        return 'Pick a world axis, an axis or an edge';
      case 'plane':
        return 'Pick an origin plane, a plane or a face';
      case 'solid':
        return many ? 'Pick solids' : 'Pick a solid';
      case 'connector':
        return many ? 'Pick connectors' : 'Pick a connector';
      case 'point':
        return many ? 'Pick points (vertices)' : 'Pick a point (a vertex)';
      case 'anchor':
        return many ? 'Pick face or edge centres' : 'Pick a face or edge centre';
      default:
        return many ? 'Pick features in the timeline' : 'Pick a feature in the timeline';
    }
  }

  private chipFor(element: PickElement, index: number): PickSlotChip {
    const badge = this.isList ? (this.spec.ordered ? String(index + 1) : undefined) : '●';
    const removable = this.isList || !this.isKept(element) || this.spec.optional === true;
    if (element.kind === 'entity' && this.keeps.includes(element)) {
      // What the feature took for a value its statement leaves out — the last selection.
      return {
        label: `Current: last selected ${element.entity.sub.type}`,
        title: 'Not written in the statement: its feature takes the last selection',
        badge,
        removable,
      };
    }
    switch (element.kind) {
      case 'keep': {
        if (element.option) {
          return this.optionChip(element.option, { badge, removable });
        }
        const standard = this.standardOf(element.text);
        return {
          label: standard ? SchemaPicker.standardLabel(standard) : `Current: ${element.text}`,
          title: element.text,
          badge,
          removable,
        };
      }
      case 'statement':
        return this.optionChip(element.option, { badge, removable });
      case 'standard':
        return { label: SchemaPicker.standardLabel(element.name), badge, removable };
      case 'anchor': {
        const anchor = element.locked.anchors[element.locked.anchorIndex];
        const label = anchorChipLabel(element.locked.entity, anchor);
        return { label, title: element.locked.args ? `${element.locked.args}${anchor.suffix}` : label, badge, removable };
      }
      default: {
        const type = element.entity.sub.type;
        if (type === 'vertex') {
          return { label: vertexLabel(element.entity.shapeId, this.scene.objects), badge, removable };
        }
        return { label: type === 'edge' ? 'Picked edge' : 'Picked face', badge, removable };
      }
    }
  }

  /** A statement's chip: a connector by how code names it, anything else by its row. */
  private optionChip(option: PickerOption, opts: { badge?: string; removable?: boolean }): PickSlotChip {
    if (option.picker === 'connector') {
      return { ...sourceChip(option, opts), label: `Connector ${option.label}`, title: `Connector ${option.label}` };
    }
    return sourceChip(option, opts);
  }

  private render(): void {
    this.slot.setChips(this.elements.map((element, index) => this.chipFor(element, index)));
    const wantsMore = this.elements.length === 0 || (this.isList && this.elements.length < this.capacity);
    this.slot.setPrompt(wantsMore ? this.prompt() : null);
    this.renderReveal();
  }

  /** A consumed statement held here is drawn for as long as the slot shows it. */
  private renderReveal(): void {
    const count = Math.max(this.elements.length, this.revealOwners.length);
    for (let i = 0; i < count; i++) {
      const owner = this.revealOwners[i] ?? (this.revealOwners[i] = {});
      const element = this.elements[i];
      const option = element?.kind === 'statement' ? element.option : element?.kind === 'keep' ? element.option : null;
      consumedReveal.set(owner, this.row, option?.consumer
        ? { filePath: option.filePath, line: option.line, column: option.column }
        : null);
    }
  }

  private static same(a: PickElement, b: PickElement): boolean {
    const siteOf = (e: PickElement): StatementSite | null => e.kind === 'statement' ? e.option : e.kind === 'keep' ? e.option ?? e.loc : null;
    if (a.kind === 'entity' && b.kind === 'entity') {
      return sameEntity(a.entity, b.entity);
    }
    if (a.kind === 'anchor' && b.kind === 'anchor') {
      return a.locked.key === b.locked.key && a.locked.anchorIndex === b.locked.anchorIndex;
    }
    if (a.kind === 'standard' && b.kind === 'standard') {
      return a.name === b.name;
    }
    const sa = siteOf(a);
    const sb = siteOf(b);
    return sa !== null && sb !== null && sa.filePath === sb.filePath && sa.line === sb.line && sa.slot === sb.slot;
  }

  private static standardLabel(name: StandardDatum): string {
    return name.length === 1 ? `World ${name.toUpperCase()} axis` : `${name.toUpperCase()} plane`;
  }

  /** `a, b or c`. */
  private static listed(words: string[]): string {
    return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
  }

  private static solidIdsOf(obj: SceneObjectRender): string[] {
    return (obj.sceneShapes ?? []).filter(s => s.shapeId && s.shapeType === 'solid').map(s => s.shapeId!);
  }

  private static typeAllowed(row: SceneObjectRender, types: readonly string[] | undefined): boolean {
    return !types || types.length === 0
      || (row.type !== undefined && types.includes(row.type))
      || (row.uniqueType !== undefined && types.includes(row.uniqueType));
  }

  /**
   * The feature statements a `feature` value can name, one per source line
   * (a repeat's clones carry its call site; the first object there names
   * it), of the allowed types, in the part the statement lands in — a
   * variable declared in another part's body is out of its reach.
   */
  private static featureOptions(
    objects: SceneObjectRender[],
    partLoc: SourceLocation | null,
    types: readonly string[] | undefined,
  ): Omit<PickerOption, 'picker'>[] {
    const part = partLoc
      ? objects.find(o => o.type === 'part' && !o.parentId
        && o.sourceLocation?.filePath === partLoc.filePath && o.sourceLocation?.line === partLoc.line)
      : undefined;
    if (partLoc && !part) {
      return [];
    }
    const byLine = new Map<string, Omit<PickerOption, 'picker'>>();
    for (const obj of objects) {
      const row = resolveRepeatTargetRow(obj, objects);
      if (!row?.sourceLocation || !SchemaPicker.typeAllowed(row, types)) {
        continue;
      }
      if (findEnclosingPartRow(row, objects)?.id !== part?.id) {
        continue;
      }
      const loc = row.sourceLocation;
      const key = `${loc.filePath}:${loc.line}`;
      const existing = byLine.get(key);
      if (existing) {
        existing.shapeIds!.push(...SchemaPicker.solidIdsOf(row));
        continue;
      }
      byLine.set(key, {
        label: row.name || row.type || 'Feature',
        filePath: loc.filePath,
        line: loc.line,
        column: loc.column,
        shapeIds: SchemaPicker.solidIdsOf(row),
      });
    }
    return [...byLine.values()];
  }
}
