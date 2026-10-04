import type { CustomPickInput, FeaturePickerParam, ParsedCustomPick, SourceSlotRef } from '../../../api';
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
import { consumedReveal } from '../consumed-reveal';
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
};

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
    loc: SourceLocation | null;
    option: PickerOption | null;
    source: SourceSlotRef | null;
  }
  | { kind: 'statement'; option: PickerOption }
  | { kind: 'entity'; entity: SelectedEntity }
  | { kind: 'standard'; name: StandardDatum };

/** What the viewer offers while a slot is armed. */
export type PickChannels = {
  pickFilter: 'all' | 'edge' | 'face' | 'none';
  sketchWires: boolean;
  axes: boolean;
  planes: boolean;
  standardAxes: boolean;
  standardPlanes: boolean;
};

/** The armed scope slot (whole solids) and no armed slot at all. */
export const SCOPE_CHANNELS: PickChannels = {
  pickFilter: 'all', sketchWires: false, axes: false, planes: false, standardAxes: false, standardPlanes: false,
};
export const NO_CHANNELS: PickChannels = { ...SCOPE_CHANNELS, pickFilter: 'none' };

/** Everything the dialog's picks light up, gathered for one highlight pass. */
export class PickHighlight {
  readonly entities: SelectedEntity[] = [];
  readonly wireIds: string[] = [];
  readonly solidIds: string[] = [];
  readonly planeQuadIds: string[] = [];
  readonly standardAxes: StandardAxisId[] = [];

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
 * `plane`, `solid` or `feature` picker — over the shared {@link PickSlot}
 * and the option collectors the built-in dialogs use. Single and list values
 * share one element model: a single value holds at most one element, a list
 * up to its `max`, ordered when the author asked.
 *
 * Every pick comes from the viewport or the timeline. Statement picks
 * re-match their statement by `(filePath, line)` after each render; raw
 * face and edge picks die with the render that minted their ids, as in the
 * built-in dialogs; an edit's kept elements are addressed by their text and
 * survive anything. The picker answers which viewer channels its armed slot
 * needs, what it lights up, and the request elements it writes.
 */
export class SchemaPicker {
  /** The slot was clicked — the panel arms it. */
  onArm?: () => void;
  /** A gesture in the slot changed the value (a chip's ✕, a reorder). */
  onChange?: () => void;

  /** The row element, hidden while the value's `visibleWhen` fails. */
  readonly row: HTMLElement;
  private readonly slot: PickSlot;
  private elements: PickElement[] = [];
  /** An edit's own elements, in order — what an untouched value still is. */
  private keeps: PickElement[] = [];
  private options: PickerOption[] = [];
  private scene: PickerScene = { objects: [], partLoc: null };
  private editing = false;
  /** One consumed-reveal owner per element position. */
  private readonly revealOwners: object[] = [];

  constructor(readonly name: string, readonly spec: FeaturePickerParam) {
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

  get kind(): FeaturePickerParam['picker'] {
    return this.spec.picker;
  }

  get isList(): boolean {
    return FeatureSchema.isList(this.spec);
  }

  /** The dialog can pick this kind (the location pickers come later). */
  get offered(): boolean {
    return FeatureSchema.offersPicker(this.spec.picker);
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
    this.keeps = [];
    this.elements = [];
    if (this.kind === 'sketch' && !this.isList && this.spec.implicitDefault !== true) {
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
    this.keeps = (picks ?? []).map((pick, sourceIndex) => ({
      kind: 'keep',
      sourceIndex,
      text: pick.text,
      loc: pick.ref ? { filePath, line: pick.ref.line, column: pick.ref.column } : null,
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
   * selection, the faces or edges it lights up.
   */
  setSources(slots: SourceSlotRef | SourceSlotRef[] | undefined): void {
    const list = Array.isArray(slots) ? slots : slots ? [slots] : [];
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
   * theirs by `(filePath, line)` (and drop when it is gone), and — when
   * `dropEntities` — picked faces and edges drop, since the render minted
   * new ids. Answers whether a pick was dropped.
   */
  setScene(scene: PickerScene, opts: { dropEntities: boolean }): boolean {
    this.scene = scene;
    this.options = this.collectOptions();
    let dropped = false;
    this.elements = this.elements.flatMap((element): PickElement[] => {
      if (element.kind === 'statement') {
        const match = this.optionAt(element.option);
        if (!match) {
          dropped = true;
          return [];
        }
        return [{ kind: 'statement', option: match }];
      }
      if (element.kind === 'entity' && opts.dropEntities) {
        dropped = true;
        return [];
      }
      return [element];
    });
    this.resolveKeeps();
    this.render();
    return dropped;
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /** What the armed slot needs the viewer to offer. */
  channels(): PickChannels {
    switch (this.kind) {
      case 'sketch':
        return { ...NO_CHANNELS, sketchWires: true };
      case 'face':
        return { ...NO_CHANNELS, pickFilter: 'face' };
      case 'edge':
        return { ...NO_CHANNELS, pickFilter: this.spec.facesAsEdges ? 'all' : 'edge' };
      case 'axis':
        return { ...NO_CHANNELS, pickFilter: 'edge', axes: true, standardAxes: true };
      case 'plane':
        return { ...NO_CHANNELS, pickFilter: 'face', planes: true, standardPlanes: true };
      case 'solid':
        return { ...NO_CHANNELS, pickFilter: 'all' };
      default:
        // A feature comes from the timeline only.
        return NO_CHANNELS;
    }
  }

  /** A face, edge or vertex clicked in the viewport. */
  takeClick(shapeId: string, sub: SubSelection): PickOutcome {
    if (!sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return 'ignored';
    }
    const entity: SelectedEntity = { shapeId, sub };
    switch (this.kind) {
      case 'face':
      case 'plane':
        return sub.type === 'face' ? this.add({ kind: 'entity', entity }) : 'ignored';
      case 'edge':
        return sub.type === 'edge' || this.spec.facesAsEdges ? this.add({ kind: 'entity', entity }) : 'ignored';
      case 'axis':
        return sub.type === 'edge' ? this.add({ kind: 'entity', entity }) : 'ignored';
      case 'solid': {
        const option = this.options.find(o => o.shapeIds?.includes(shapeId));
        return option
          ? this.add({ kind: 'statement', option })
          : { message: `${this.spec.label}: that shape is not a solid this statement can reference.` };
      }
      default:
        return 'ignored';
    }
  }

  /** A timeline row clicked: the statement it stands for, when this value takes that kind. */
  takeRow(obj: SceneObjectRender): PickOutcome {
    const objects = this.scene.objects;
    switch (this.kind) {
      case 'sketch': {
        const row = this.spec.wire ? resolveWireRow(obj, objects) : resolveSketchRow(obj, objects);
        return row?.sourceLocation ? this.addStatementAt(row.sourceLocation, 'That sketch is not one this statement can reference.') : 'ignored';
      }
      case 'axis':
        return obj.type === 'axis' && obj.sourceLocation
          ? this.addOption(axisOptionForLocation(this.options, obj.sourceLocation), AXIS_UNAVAILABLE_MESSAGE)
          : 'ignored';
      case 'plane': {
        const row = resolvePlaneRow(obj);
        return row?.sourceLocation
          ? this.addOption(planeOptionForLocation(this.options, row.sourceLocation),
            'That plane cannot be referenced — only plane() features can.')
          : 'ignored';
      }
      case 'solid': {
        if (!obj.sourceLocation || !SchemaPicker.solidIdsOf(obj).length) {
          return 'ignored';
        }
        return this.addStatementAt(obj.sourceLocation, 'That solid is in another part — this statement cannot reference it.');
      }
      case 'feature': {
        const row = resolveRepeatTargetRow(obj, objects);
        if (!row?.sourceLocation) {
          return 'ignored';
        }
        if (!SchemaPicker.typeAllowed(row, this.spec.types)) {
          return { message: `${this.spec.label} takes ${this.spec.types!.join(', ')} features.` };
        }
        return this.addStatementAt(row.sourceLocation, 'That feature is in another part — this statement cannot reference it.');
      }
      default:
        return 'ignored';
    }
  }

  /** A sketch wire (or helix) clicked in the viewport. */
  takeSketchWire(shapeId: string): PickOutcome {
    if (this.kind !== 'sketch') {
      return 'ignored';
    }
    const objects = this.scene.objects;
    const row = this.spec.wire ? resolveWireByShapeId(shapeId, objects) : resolveSketchByShapeId(shapeId, objects);
    return row?.sourceLocation ? this.addStatementAt(row.sourceLocation, 'That sketch is not one this statement can reference.') : 'ignored';
  }

  /** An `axis()` line clicked. */
  takeAxisLine(shapeId: string): PickOutcome {
    if (this.kind !== 'axis') {
      return 'ignored';
    }
    return this.addOption(axisOptionForShape(shapeId, this.scene.objects, this.options), AXIS_UNAVAILABLE_MESSAGE);
  }

  /** A `plane()` quad clicked. */
  takePlaneQuad(shapeId: string): PickOutcome {
    if (this.kind !== 'plane') {
      return 'ignored';
    }
    return this.addOption(planeOptionForShape(shapeId, this.scene.objects, this.options),
      'That plane cannot be referenced — only plane() features can.');
  }

  /** A world axis or an origin plane clicked in the viewport. */
  takeStandard(name: StandardDatum): PickOutcome {
    const fits = this.kind === 'axis' ? name.length === 1 : this.kind === 'plane' ? name.length === 2 : false;
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
   * the first of them stood.
   */
  request(): CustomPickInput[] | undefined | { error: string } {
    if (!this.offered) {
      return undefined;
    }
    if (this.editing && !this.touched) {
      return undefined;
    }
    if (this.elements.length === 0) {
      if (!this.spec.optional && !(this.kind === 'sketch' && this.spec.implicitDefault)) {
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
        const { filePath, line, column } = element.option;
        inputs.push({ kind: 'statement', filePath, line, column });
      } else if (entities) {
        entities.entities.push(element.entity);
      } else {
        entities = { kind: 'entities', entities: [element.entity] };
        inputs.push(entities);
      }
    }
    return inputs;
  }

  /** Whether the request carries viewport geometry — an edit then needs its boundary. */
  get hasPickedGeometry(): boolean {
    return this.elements.some(e => e.kind === 'entity');
  }

  /** Light up what the value holds. */
  highlight(into: PickHighlight): void {
    for (const element of this.elements) {
      if (element.kind === 'entity') {
        into.entities.push(element.entity);
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

  private addStatementAt(loc: { filePath: string; line: number }, refusal: string): PickOutcome {
    return this.addOption(this.optionAt(loc), refusal);
  }

  /** A chip's ✕: a list loses the element; a single value undoes its pick (or, optional, drops its own). */
  private removeAt(index: number): void {
    const element = this.elements[index];
    if (!element) {
      return;
    }
    if (this.isList) {
      this.elements.splice(index, 1);
    } else if (element.kind === 'keep') {
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

  private optionAt(loc: { filePath: string; line: number }): PickerOption | undefined {
    return this.options.find(o => o.filePath === loc.filePath && o.line === loc.line);
  }

  /** A kept element that names a statement, as this scene offers it. */
  private resolveKeeps(): void {
    for (const element of this.keeps) {
      if (element.kind === 'keep') {
        element.option = element.loc ? this.optionAt(element.loc) ?? null : null;
      }
    }
  }

  /** The statements this value can take in the current scene. */
  private collectOptions(): PickerOption[] {
    const { objects, partLoc } = this.scene;
    switch (this.kind) {
      case 'sketch':
        return (this.spec.wire ? collectWireSources(objects) : collectSketchProfiles(objects)).map(option => ({
          label: option.label,
          filePath: option.filePath,
          line: option.line,
          column: option.column,
          consumer: option.consumer,
          hasGeometry: option.hasGeometry,
          active: option.kind === 'active',
        }));
      case 'axis':
        return collectAxisOptions(objects);
      case 'plane':
        return collectPlaneOptions(objects);
      case 'solid':
        return partScopedSolidTargets(objects, partLoc);
      case 'feature':
        return SchemaPicker.featureOptions(objects, partLoc, this.spec.types);
      default:
        return [];
    }
  }

  private highlightOption(option: PickerOption, into: PickHighlight): void {
    const objects = this.scene.objects;
    switch (this.kind) {
      case 'sketch':
        into.wireIds.push(...sketchWireShapeIds(option, objects));
        break;
      case 'axis':
        into.wireIds.push(...axisLineShapeIds(option, objects));
        break;
      case 'plane':
        into.planeQuadIds.push(...planeQuadShapeIds(option, objects));
        break;
      default:
        into.solidIds.push(...(option.shapeIds ?? []));
    }
  }

  private standardOf(text: string): StandardDatum | null {
    const pattern = this.kind === 'axis' ? STANDARD_AXIS_TEXT : this.kind === 'plane' ? STANDARD_PLANE_TEXT : null;
    const match = pattern ? text.trim().match(pattern) : null;
    return match ? match[1] as StandardDatum : null;
  }

  private prompt(): string {
    if (!this.offered) {
      return `Not offered in the dialog yet — write the ${this.kind} in the code`;
    }
    const many = this.isList;
    switch (this.kind) {
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
      default:
        return many ? 'Pick features in the timeline' : 'Pick a feature in the timeline';
    }
  }

  private chipFor(element: PickElement, index: number): PickSlotChip {
    const badge = this.isList ? (this.spec.ordered ? String(index + 1) : undefined) : '●';
    const removable = this.isList || element.kind !== 'keep' || this.spec.optional === true;
    switch (element.kind) {
      case 'keep': {
        if (element.option) {
          return sourceChip(element.option, { badge, removable });
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
        return sourceChip(element.option, { badge, removable });
      case 'standard':
        return { label: SchemaPicker.standardLabel(element.name), badge, removable };
      default:
        return { label: element.entity.sub.type === 'edge' ? 'Picked edge' : 'Picked face', badge, removable };
    }
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
    const locOf = (e: PickElement) => e.kind === 'statement' ? e.option : e.kind === 'keep' ? e.option ?? e.loc : null;
    if (a.kind === 'entity' && b.kind === 'entity') {
      return sameEntity(a.entity, b.entity);
    }
    if (a.kind === 'standard' && b.kind === 'standard') {
      return a.name === b.name;
    }
    const la = locOf(a);
    const lb = locOf(b);
    return la !== null && lb !== null && la.filePath === lb.filePath && la.line === lb.line;
  }

  private static standardLabel(name: StandardDatum): string {
    return name.length === 1 ? `World ${name.toUpperCase()} axis` : `${name.toUpperCase()} plane`;
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
  ): PickerOption[] {
    const part = partLoc
      ? objects.find(o => o.type === 'part' && !o.parentId
        && o.sourceLocation?.filePath === partLoc.filePath && o.sourceLocation?.line === partLoc.line)
      : undefined;
    if (partLoc && !part) {
      return [];
    }
    const byLine = new Map<string, PickerOption>();
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
