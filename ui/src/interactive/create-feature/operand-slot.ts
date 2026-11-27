import { fetchSketchNames, type SelectionBoundaryRef, type SourceSlotRef } from '../../api';
import { sameEntity } from '../../helpers/entities';
import { holdsSurface, modelShapeIdsOf } from '../../helpers/scene-utils';
import type { SceneObjectRender, SubSelection } from '../../types';
import type { SelectedEntity } from '../../viewer';
import { expandDoubleClick } from '../pick-expansion';
import { PickSlot, type PickSlotChip } from '../pick-slot';
import { consumedLabel, consumerName } from './consumed-option';
import { consumedReveal } from './consumed-reveal';
import { NO_CHANNELS, type PickChannels, type PickOutcome } from './schema/schema-pickers';
import {
  collectWireSources, keepChip, labelWithSketchNames, resolveWireByShapeId, resolveWireRow, sketchWireShapeIds,
  sourceChip, type SketchProfileOption,
} from './sketch-profiles';

/** What an operand slot collects: curves, or surfaces. */
export type OperandKind = 'curve' | 'surface';

/**
 * One pick of an operand slot, as Apply sends it: a whole object, written
 * as its variable, or an edge or a face of a body, written as a selector.
 */
export type OperandSlotPick =
  | { kind: 'object'; row: SceneObjectRender }
  | { kind: 'entity'; entity: SelectedEntity };

/**
 * What an operand slot holds for Apply: the edited statement's own argument,
 * kept as written, or the picks in pick order — with the whole objects and
 * the entities (for selector synthesis) each listed on their own.
 */
export type OperandSlotPicks =
  | { keep: true }
  | { picks: OperandSlotPick[]; objects: SceneObjectRender[]; entities: SelectedEntity[] };

/** Everything an operand slot holds, for the viewport highlight. */
export type OperandSlotHighlight = {
  /** Picked edges and faces. */
  entities: SelectedEntity[];
  /** The wires of the sketches and curve objects held whole. */
  wireIds: string[];
  /** Every body and curve of the surface holders held whole. */
  shapeIds: string[];
};

/** A whole object the slot can take, by call site. */
type OperandOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** The feature that hid it in this world; the slot reveals it while it holds it. */
  consumer?: string;
  /** False while a sketch has nothing drawn. */
  hasGeometry: boolean;
  /** Its row in this render: the sketch, the curve object, the first row holding the surface. */
  row: SceneObjectRender;
};

type OperandPick =
  | { kind: 'object'; option: OperandOption }
  | { kind: 'entity'; entity: SelectedEntity };

/** One element of the edited statement's own argument: its text, and what the engine resolved it to. */
type OperandKeep = { text: string; ref: SourceSlotRef | null };

/**
 * A dialog row that collects curve picks or surface picks. What a click
 * means is the same in every tool that takes one, so it is decided here:
 *
 * - a **curve** row takes an edge of a curve object (a helix, a curve tool's
 *   result, a loaded curve) or a sketch's wire as the whole object, an edge
 *   of a solid or a surface as that edge, and the timeline row of a sketch
 *   or a curve object as that object;
 * - a **surface** row takes a face of a surface as the whole object holding
 *   it, a face of a solid as that face, and the timeline row of an object
 *   holding a surface as that object.
 *
 * Standalone construction geometry is usually meant whole; geometry on a
 * solid, piece by piece. Which rows are curve objects and which hold a
 * surface is asked of what the scene rows hold (`isCurveObject`,
 * `holdsSurface`), so a tool that leaves one is taken without being listed.
 * A list grows the edges and faces it takes as themselves as the built-in
 * pick dialogs' selections do: a double-click takes a surface rim edge's
 * loop or any other pick's bucket ({@link takeDoubleClick}), and a
 * right-click group's members join it ({@link takeMembers}), as plain
 * picks.
 *
 * Whole objects are addressed by call site and re-found after each render
 * ({@link setScene}); picked edges and faces die with the render that minted
 * their ids. An edit opens on the statement's own argument as "Current: …"
 * chips ({@link seedKeep}), kept as written until a pick replaces them — a
 * list slot whose elements all resolved starts from them, so a pick adds to
 * what the statement has. Removing every pick goes back to the statement's
 * own. The panel owns arming and the service routes clicks in and repaints
 * from {@link highlight}; this control calls no viewer.
 */
export class OperandSlotControl {
  /** The slot was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture in the slot changed what it holds (a chip's ✕). */
  onChange?: () => void;

  private readonly slot: PickSlot;
  private readonly kind: OperandKind;
  private readonly label: string;
  private readonly prompt: string;
  private readonly multiple: boolean;
  private scene: SceneObjectRender[] = [];
  private options: OperandOption[] = [];
  /** A curve row's options as the wire-source collector gave them, for the name lookup. */
  private wireSources: SketchProfileOption[] = [];
  private picked: OperandPick[] = [];
  /** Edit mode: the statement's own argument; null in create mode. */
  private keeps: OperandKeep[] | null = null;
  /** Edit mode: the slot still holds the statement's own argument, untouched. */
  private keeping = false;
  /** One consumed-reveal owner per chip position. */
  private readonly revealOwners: object[] = [];

  constructor(
    private readonly host: HTMLElement,
    opts: { kind: OperandKind; label: string; prompt: string; multiple: boolean },
  ) {
    this.kind = opts.kind;
    this.label = opts.label;
    this.prompt = opts.prompt;
    this.multiple = opts.multiple;
    this.slot = new PickSlot(host, { label: opts.label, multiple: opts.multiple });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = (index) => {
      this.removeAt(index);
      this.onChange?.();
    };
    this.render();
  }

  /** The viewer channels the row needs while armed: edges and sketch wires for curves, faces for surfaces. */
  channels(): PickChannels {
    return this.kind === 'curve'
      ? { ...NO_CHANNELS, pickFilter: 'edge', sketchWires: true }
      : { ...NO_CHANNELS, pickFilter: 'face' };
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** Fresh create-mode arming: no keep, no pick, the prompt. */
  reset(): void {
    this.keeps = null;
    this.keeping = false;
    this.picked = [];
    this.render();
  }

  /**
   * Edit mode: the statement's own argument as "Current: …" chips, one per
   * element text, with what the engine resolved each to (`refs`, in the same
   * order) — what the kept chips light up, and what a list slot's first pick
   * starts from.
   */
  seedKeep(texts: string[], refs: (SourceSlotRef | null | undefined)[] = []): void {
    this.keeps = texts.map((text, index) => ({ text, ref: refs[index] ?? null }));
    this.keeping = true;
    this.picked = [];
    this.render();
  }

  /**
   * Edit mode: what the engine resolved the statement's own argument to,
   * once it answers or in a scene that re-minted the ids — what the kept
   * chips light up and a list's first pick starts from. The row keeps
   * whatever it holds; with no edit seeded there is nothing to resolve.
   */
  setKeepRefs(refs: (SourceSlotRef | null | undefined)[]): void {
    if (this.keeps === null) {
      return;
    }
    this.keeps = this.keeps.map((keep, index) => ({ text: keep.text, ref: refs[index] ?? null }));
    this.render();
  }

  /**
   * A new scene: the whole objects on offer rebuild, picked objects re-find
   * theirs by call site (and drop when it is gone), and — when
   * `dropEntities` — picked edges and faces drop, since the render minted
   * new ids. Answers whether a pick the user made was dropped.
   */
  setScene(sceneObjects: SceneObjectRender[], opts: { dropEntities: boolean } = { dropEntities: true }): boolean {
    this.scene = sceneObjects;
    this.options = this.collectOptions();
    const before = this.picked.length;
    this.picked = this.picked.flatMap((pick): OperandPick[] => {
      if (pick.kind === 'entity') {
        return opts.dropEntities ? [] : [pick];
      }
      const match = this.optionAt(pick.option);
      return match ? [{ kind: 'object', option: match }] : [];
    });
    this.settle();
    this.render();
    void this.relabel();
    return this.picked.length < before;
  }

  /**
   * A viewport click: taken as a whole object or as an entity, by the
   * row's kind; `ignored` when the row takes no such thing (a face in a
   * curve row). Picking what the slot already holds takes it back off.
   */
  takeClick(shapeId: string, sub: SubSelection): PickOutcome {
    if (!sub) {
      return 'ignored';
    }
    if (this.kind === 'curve') {
      if (sub.type !== 'edge' && sub.type !== 'sketch') {
        return 'ignored';
      }
      // An edge of a curve object or a sketch's wire stands for the whole
      // object; one that has no statement to name is taken as the edge.
      const owner = resolveWireByShapeId(shapeId, this.scene);
      if (owner?.sourceLocation) {
        return this.takeObject(owner, owner.sourceLocation);
      }
      return sub.type === 'edge' ? this.take({ kind: 'entity', entity: { shapeId, sub } }) : 'ignored';
    }
    if (sub.type !== 'face') {
      return 'ignored';
    }
    // A face of a surface stands for the whole object holding it.
    const holder = this.surfaceHolder(shapeId);
    if (holder?.sourceLocation) {
      return this.takeObject(holder, holder.sourceLocation);
    }
    return this.take({ kind: 'entity', entity: { shapeId, sub } });
  }

  /**
   * Whether a double-click or a right-click group on this pick grows the
   * slot: a list that takes the edge or the face as itself — an edge of a
   * solid or a surface in a curve row, a face of a solid in a surface row.
   * A pick that stands for a whole object is whole already.
   */
  expands(shapeId: string, sub: SubSelection): boolean {
    if (!this.multiple || !sub) {
      return false;
    }
    if (this.kind === 'curve') {
      return sub.type === 'edge' && !resolveWireByShapeId(shapeId, this.scene)?.sourceLocation;
    }
    return sub.type === 'face' && !this.surfaceHolder(shapeId)?.sourceLocation;
  }

  /**
   * A double-click, routed by the host like {@link takeClick} (its two
   * clicks have already toggled the pick): an edge or a face the slot takes
   * as itself expands — a surface's rim edge to its rim loop, any other to
   * its classified bucket ({@link expandDoubleClick}) — and the members join
   * the picks, so the seed ends up picked either way. `before` is an edit
   * session's boundary. A render that lands meanwhile drops the answer: its
   * ids are stale.
   */
  async takeDoubleClick(shapeId: string, sub: SubSelection, before?: SelectionBoundaryRef): Promise<PickOutcome> {
    if (!sub || (sub.type !== 'edge' && sub.type !== 'face') || !this.expands(shapeId, sub)) {
      return 'ignored';
    }
    const scene = this.scene;
    const result = await expandDoubleClick({ shapeId, sub }, before);
    if (this.scene !== scene) {
      return 'ignored';
    }
    return 'error' in result ? { message: result.error } : this.takeMembers(result.members);
  }

  /**
   * A right-click group's members, or a double-click's expansion: each the
   * slot takes as itself joins the picks as an edge or a face, and the ones
   * it holds stay — a list only; an operand writes no chains.
   */
  takeMembers(members: SelectedEntity[]): PickOutcome {
    const taken = members.filter(member => member.sub.type !== 'vertex' && this.expands(member.shapeId, member.sub));
    if (taken.length === 0) {
      return 'ignored';
    }
    this.startPicking();
    const fresh = taken.filter(member => !this.picked.some(pick => pick.kind === 'entity' && sameEntity(pick.entity, member)));
    this.picked.push(...fresh.map((entity): OperandPick => ({ kind: 'entity', entity })));
    this.settle();
    this.render();
    return fresh.length > 0 ? 'taken' : 'ignored';
  }

  /**
   * A timeline row: taken when it is of the row's kind — a sketch (or one of
   * its entities) or a curve object for curves, an object holding a surface
   * for surfaces — and `ignored` otherwise.
   */
  takeRow(row: SceneObjectRender): PickOutcome {
    const source = this.kind === 'curve'
      ? resolveWireRow(row, this.scene)
      : holdsSurface(row) ? row : undefined;
    return source?.sourceLocation ? this.takeObject(source, source.sourceLocation) : 'ignored';
  }

  /** What Apply sends: the statement's own argument kept, or the picks. */
  picks(): OperandSlotPicks {
    if (this.keeping) {
      return { keep: true };
    }
    return {
      picks: this.picked.map(pick => pick.kind === 'object'
        ? { kind: 'object', row: pick.option.row }
        : { kind: 'entity', entity: pick.entity }),
      objects: this.picked.flatMap(pick => pick.kind === 'object' ? [pick.option.row] : []),
      entities: this.picked.flatMap(pick => pick.kind === 'entity' ? [pick.entity] : []),
    };
  }

  /**
   * Everything the row holds, for the viewport highlight. A whole object
   * lights every body and curve it holds; kept elements light what the
   * engine resolved them to.
   */
  highlight(): OperandSlotHighlight {
    const lit: OperandSlotHighlight = { entities: [], wireIds: [], shapeIds: [] };
    const held = this.keeping ? (this.keeps ?? []).flatMap(keep => this.resolved(keep) ?? []) : this.picked;
    for (const pick of held) {
      if (pick.kind === 'entity') {
        lit.entities.push(pick.entity);
      } else if (this.kind === 'curve') {
        lit.wireIds.push(...sketchWireShapeIds(pick.option, this.scene));
      } else {
        lit.shapeIds.push(...this.rowsAt(pick.option).flatMap(row => modelShapeIdsOf(row, this.scene)));
      }
    }
    return lit;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** A whole object, by the statement that made it — refused when the slot cannot name it. */
  private takeObject(row: SceneObjectRender, loc: { filePath: string; line: number }): PickOutcome {
    const option = this.optionAt(loc);
    if (!option) {
      return { message: `${this.label}: that ${row.type === 'sketch' ? 'sketch' : this.kind} cannot be used — only ones still in the scene can be.` };
    }
    if (!option.hasGeometry) {
      return { message: `Nothing is drawn in "${option.label}" yet.` };
    }
    return this.take({ kind: 'object', option });
  }

  /**
   * Take one pick. A list toggles it; a single slot swaps it in, and
   * picking the same thing again undoes the pick.
   */
  private take(pick: OperandPick): PickOutcome {
    this.startPicking();
    const existing = this.picked.findIndex(other => OperandSlotControl.same(other, pick));
    if (existing >= 0) {
      this.picked.splice(existing, 1);
    } else if (this.multiple) {
      this.picked.push(pick);
    } else {
      this.picked = [pick];
    }
    this.settle();
    this.render();
    return 'taken';
  }

  /**
   * The first pick of an edit leaves the statement's own argument. A list
   * slot whose elements all resolved starts from them, so the pick adds to
   * (or takes off) what the statement has; otherwise the pick replaces it.
   */
  private startPicking(): void {
    if (!this.keeping) {
      return;
    }
    this.keeping = false;
    const resolved = (this.keeps ?? []).map(keep => this.resolved(keep));
    this.picked = this.multiple && resolved.every(picks => picks !== null)
      ? resolved.flatMap(picks => picks ?? [])
      : [];
  }

  /** An edit emptied of its picks goes back to the statement's own argument. */
  private settle(): void {
    if (this.keeps !== null && this.picked.length === 0) {
      this.keeping = true;
    }
  }

  private removeAt(index: number): void {
    if (this.keeping) {
      return;
    }
    this.picked.splice(index, 1);
    this.settle();
    this.render();
  }

  /**
   * What a kept element stands for in this scene, as picks: the statement
   * it names, the edges or faces its selection resolved to. Null when
   * nothing here can stand in for it (an expression, a statement the scene
   * does not offer).
   */
  private resolved(keep: OperandKeep): OperandPick[] | null {
    const ref = keep.ref;
    if (ref?.kind === 'sketch') {
      const option = this.optionAt(ref);
      return option ? [{ kind: 'object', option }] : null;
    }
    if (ref?.kind === 'entities' && ref.entities.length > 0) {
      const wanted = this.kind === 'curve' ? 'edge' : 'face';
      const picks: OperandPick[] = [];
      for (const entity of ref.entities) {
        if (entity.sub.type !== wanted) {
          return null;
        }
        picks.push({ kind: 'entity', entity: { shapeId: entity.shapeId, sub: entity.sub } });
      }
      return picks;
    }
    return null;
  }

  /** The object holding the surface a face is on, when it is a surface's face. */
  private surfaceHolder(shapeId: string): SceneObjectRender | undefined {
    return this.scene.find(obj => obj.sourceLocation && holdsSurface(obj)
      && modelShapeIdsOf(obj, this.scene, ['surface']).includes(shapeId));
  }

  private optionAt(loc: { filePath: string; line: number }): OperandOption | undefined {
    return this.options.find(option => option.filePath === loc.filePath && option.line === loc.line);
  }

  /** Every row at a statement: a copy's clones carry its call site. */
  private rowsAt(loc: { filePath: string; line: number }): SceneObjectRender[] {
    return this.scene.filter(obj => obj.sourceLocation?.filePath === loc.filePath && obj.sourceLocation.line === loc.line);
  }

  /** The whole objects the slot can take in this scene, one per statement. */
  private collectOptions(): OperandOption[] {
    if (this.kind === 'curve') {
      this.wireSources = collectWireSources(this.scene);
      return this.wireOptions(this.wireSources);
    }
    const options = new Map<string, OperandOption>();
    for (const obj of this.scene) {
      const loc = obj.sourceLocation;
      if (!loc || !holdsSurface(obj)) {
        continue;
      }
      const key = `${loc.filePath}:${loc.line}`;
      if (options.has(key)) {
        continue;
      }
      const consumer = consumerName(obj, this.scene);
      options.set(key, {
        label: consumedLabel(obj.name || 'Surface', consumer),
        filePath: loc.filePath,
        line: loc.line,
        column: loc.column,
        consumer,
        hasGeometry: true,
        row: obj,
      });
    }
    return [...options.values()];
  }

  /** The wire sources as the slot's options, each with its row: the sketch, or the curve object. */
  private wireOptions(sources: SketchProfileOption[]): OperandOption[] {
    return sources.flatMap((source): OperandOption[] => {
      const rows = this.rowsAt(source);
      const row = rows.find(obj => obj.type === 'sketch') ?? rows.find(obj => resolveWireRow(obj, this.scene) === obj);
      return row ? [{
        label: source.label,
        filePath: source.filePath,
        line: source.line,
        column: source.column,
        consumer: source.consumer,
        hasGeometry: source.hasGeometry,
        row,
      }] : [];
    });
  }

  /**
   * Name the row's options after the variables their statements are bound
   * to; an unbound statement keeps its timeline name. The lookup is async:
   * its answer is dropped when the scene moved on meanwhile.
   */
  private async relabel(): Promise<void> {
    if (this.kind === 'surface') {
      await this.relabelSurfaces();
      return;
    }
    if (this.wireSources.length === 0) {
      return;
    }
    const sources = this.wireSources;
    const labeled = await labelWithSketchNames(sources);
    if (this.wireSources !== sources) {
      return;
    }
    this.options = this.wireOptions(labeled);
    this.picked = this.picked.map((pick): OperandPick => {
      const match = pick.kind === 'object' ? this.optionAt(pick.option) : undefined;
      return match ? { kind: 'object', option: match } : pick;
    });
    this.render();
  }

  /**
   * A surface row's options under their variables' names: the statements
   * that hold a surface are of any callee (a load, a copy, a surface tool),
   * so each is asked for as `'any'`.
   */
  private async relabelSurfaces(): Promise<void> {
    const options = this.options;
    if (options.length === 0) {
      return;
    }
    const names = await fetchSketchNames(options.map(option => option.line), 'any');
    if (this.options !== options) {
      return;
    }
    this.options = options.map((option, index) => {
      const name = names[index];
      return name ? { ...option, label: consumedLabel(name, option.consumer) } : option;
    });
    this.picked = this.picked.map((pick): OperandPick => {
      const match = pick.kind === 'object' ? this.optionAt(pick.option) : undefined;
      return match ? { kind: 'object', option: match } : pick;
    });
    this.render();
  }

  private chipFor(pick: OperandPick): PickSlotChip {
    const badge = this.multiple ? undefined : '●';
    if (pick.kind === 'object') {
      return sourceChip(pick.option, { badge, removable: true });
    }
    return { label: pick.entity.sub.type === 'edge' ? 'Picked edge' : 'Picked face', badge, removable: true };
  }

  private render(): void {
    const chips = this.keeping
      ? (this.keeps ?? []).map((keep): PickSlotChip => this.multiple
        ? { label: `Current: ${keep.text}`, title: keep.text, removable: false }
        : keepChip(keep.text))
      : this.picked.map(pick => this.chipFor(pick));
    this.slot.setChips(chips);
    // A list keeps its prompt under the chips: it always takes one more.
    this.slot.setPrompt(this.multiple || chips.length === 0 ? this.prompt : null);
    this.renderReveal();
  }

  /** A consumed object held here is drawn for as long as the slot shows it. */
  private renderReveal(): void {
    const held = this.keeping ? [] : this.picked;
    const count = Math.max(held.length, this.revealOwners.length);
    for (let i = 0; i < count; i++) {
      const owner = this.revealOwners[i] ?? (this.revealOwners[i] = {});
      const pick = held[i];
      const option = pick?.kind === 'object' && pick.option.consumer ? pick.option : null;
      consumedReveal.set(owner, this.host, option
        ? { filePath: option.filePath, line: option.line, column: option.column }
        : null);
    }
  }

  private static same(a: OperandPick, b: OperandPick): boolean {
    if (a.kind === 'entity' && b.kind === 'entity') {
      return sameEntity(a.entity, b.entity);
    }
    return a.kind === 'object' && b.kind === 'object'
      && a.option.filePath === b.option.filePath && a.option.line === b.option.line;
  }
}
