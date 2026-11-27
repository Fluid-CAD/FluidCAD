import { AxisOption } from './axis-options';
import { ConnectorOption, ConnectorOptions, type ConnectorSite } from './connector-options';
import type { PlaneOption } from './plane-bases';
import type { StandardPlane } from './plane-slot';
import { keepChip, sourceChip } from './sketch-profiles';
import { consumedReveal } from './consumed-reveal';
import { PickSlot } from '../pick-slot';


export type StandardAxis = 'x' | 'y' | 'z';

const STANDARD_AXES: readonly StandardAxis[] = ['x', 'y', 'z'];
const STANDARD_PLANES: readonly StandardPlane[] = ['xy', 'xz', 'yz'];

/**
 * An axis slot's state, shared by every axis-picking dialog: a standard axis
 * (a world axis clicked in the viewport, or a sketch datum axis in the 2D
 * dialogs), an existing axis statement, a picked edge (the service owns the
 * entity), a connector standing for its Z axis through its origin (a gizmo
 * or a connector row — the 3D dialogs offer them), or — edit mode only — the
 * statement's own axis expression kept verbatim.
 */
export type AxisSelection =
  | { kind: 'standard'; axis: StandardAxis }
  | { kind: 'axis'; option: AxisOption }
  | { kind: 'edge' }
  | { kind: 'connector'; option: ConnectorOption }
  | { kind: 'keep' };

/**
 * What a plane-taking axis slot holds beside an axis: a plane, standing for
 * its normal — an origin plane clicked in the viewport, an existing plane
 * statement, or a picked planar face (the owner keeps the entity).
 */
export type PlaneDirectionSelection =
  | { kind: 'standard-plane'; plane: StandardPlane }
  | { kind: 'plane'; option: PlaneOption }
  | { kind: 'face' };

/** The state of an axis slot that takes a plane too: a direction, given as an axis or as a plane's normal. */
export type DirectionSelection = AxisSelection | PlaneDirectionSelection;

/**
 * The axis picker every axis-consuming dialog shares: a single-chip PickSlot
 * owning the {@link AxisSelection} state machine — rendering the chip per
 * state, re-matching an axis-statement choice after re-renders,
 * seeding/reverting to the edited statement's own axis (a standard literal
 * like `'z'` reads as the standard selection itself), and tracking the
 * picked-edge chip. Every pick comes from the viewport or the timeline: the
 * world axes shown while the slot is armed, an axis statement's line, a
 * solid edge, or a connector — a gizmo or a connector row — re-found after
 * renders by its site like an axis statement. An edit whose own axis is a
 * connector (the sources say so) shows that connector's chip, still kept as
 * written. The panel owns arming policy and the service owns scene data and
 * the edge entity.
 *
 * With `planes` the slot is a direction's: it takes a plane too, which
 * stands for its normal — an origin plane, a plane statement's quad, a
 * planar face — and a kept origin-plane literal (`'xy'`) reads as that
 * plane. {@link direction} is its whole state; {@link selection} stays the
 * axis half.
 */
export class AxisSlotControl {
  /** The slot was clicked — the panel arms this slot. */
  onArm?: () => void;
  /** A gesture changed the selection (the chip's ✕). */
  onChange?: () => void;
  /** The selection left edge (or, taking planes, face) mode via a gesture — the owner drops the entity. */
  onModeChange?: () => void;

  private readonly slot: PickSlot;
  private state: DirectionSelection | null = null;
  /** The edited statement's own axis text; null in create mode. */
  private keepLabel: string | null = null;
  /** The picked-edge chip label the service pushed. */
  private edgeLabel: string | null = null;
  /** The picked-face chip label the owner pushed (a plane-taking slot). */
  private faceLabel: string | null = null;
  /** Edit mode: the connector the statement's own axis is, as this scene offers it. */
  private keptConnector: ConnectorOption | null = null;
  /** Its site, which outlives the scene ids. */
  private keptConnectorSite: ConnectorSite | null = null;

  constructor(
    private readonly slotHost: HTMLElement,
    private readonly opts: {

      label?: string;
      /** The chosen-standard chip's label; default `World X axis`. */
      chipLabel?: (axis: StandardAxis) => string;
      /**
       * How a kept statement axis reads back as a standard selection — the
       * capture group is the axis letter. Default matches the world-axis
       * string literals (`'z'`); the 2D dialogs pass an `xAxis()` matcher.
       */
      keepMatcher?: RegExp;
      /**
       * The axes a kept text may read back as; default the three world
       * axes. The 2D dialogs, whose datums are the sketch's X and Y, name
       * those two so a kept `xAxis()` lands on its standard chip.
       */
      keepAxes?: readonly StandardAxis[];
      /** The empty slot's pick prompt. */
      prompt?: string;
      /**
       * The slot takes a plane as well as an axis — a direction, which a
       * plane gives as its normal. Default off: an axis only.
       */
      planes?: boolean;
      /**
       * The value may be left out: the edited statement's own axis has a ✕
       * too, which empties the slot (a re-pick's ✕ still goes back to the
       * statement's own first). Default off: an edit always keeps one.
       */
      clearable?: boolean;
    } = {},
  ) {
    this.slot = new PickSlot(slotHost, { label: opts.label ?? 'Axis', multiple: false });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      // Create mode: back to the prompt; edit mode: back to the statement's
      // own axis (a re-pick is undone, never the axis itself) — unless the
      // value may be left out and the statement's own is what the ✕ was on.
      this.state = this.opts.clearable && this.atFallback() ? null : this.fallbackState();
      this.render();
      this.onModeChange?.();
      this.onChange?.();
    };
    this.render();
  }

  /** The axis the slot holds; null too while a plane-taking slot holds a plane. */
  get selection(): AxisSelection | null {
    const state = this.state;
    return state && state.kind !== 'standard-plane' && state.kind !== 'plane' && state.kind !== 'face' ? state : null;
  }

  /** The whole state of a plane-taking slot: an axis or a plane. */
  get direction(): DirectionSelection | null {
    return this.state;
  }

  /**
   * The connector the slot holds — one picked, or the edited statement's own
   * axis when it is one — whose gizmo the viewport draws enlarged.
   */
  get connector(): ConnectorOption | null {
    if (this.state?.kind === 'connector') {
      return this.state.option;
    }
    return this.state?.kind === 'keep' ? this.keptConnector : null;
  }

  /** Fresh create-mode arming: no keep label, the empty pick prompt. */
  reset(): void {
    this.keepLabel = null;
    this.edgeLabel = null;
    this.faceLabel = null;
    this.keptConnector = null;
    this.keptConnectorSite = null;
    this.state = null;
    this.render();
  }

  /**
   * Seed the edited statement's own axis (edit mode): a standard world-axis
   * literal (`'z'`) reads as the standard selection itself, so the chip
   * reads "World Z axis" and the viewport axis lights up; anything else (a
   * variable, an axis() call) stays a verbatim "Current: …" keep.
   */
  seedKeep(label: string | null): void {
    this.keepLabel = label;
    this.edgeLabel = null;
    this.faceLabel = null;
    this.keptConnector = null;
    this.keptConnectorSite = null;
    this.state = this.fallbackState();
    this.render();
  }

  /**
   * Edit mode: the statement's own axis is this connector — its sources
   * said so — or nothing (null). The kept chip reads as the connector's own
   * chip; the selection stays `keep`, so the statement keeps its text as
   * written. No events fire.
   */
  setKeptConnector(option: ConnectorOption | null): void {
    this.keptConnector = option;
    this.keptConnectorSite = option ? { filePath: option.filePath, line: option.line, slot: option.slot } : null;
    this.render();
  }

  /** Clear the slot outright (a removed repeat direction); no events fire. */
  clear(): void {
    this.state = null;
    this.render();
  }

  /** Re-seed the kept statement axis (a re-added repeat direction). */
  restoreFallback(): void {
    this.state = this.fallbackState();
    this.render();
  }

  /**
   * Refresh the offered axis statements after a re-render, keeping the
   * current choice when the same statement is still offered (matched by
   * source location — scene ids change every render). A choice that vanished
   * falls back to the statement's own axis in edit mode, or to the pick
   * prompt. Standard-axis and picked-edge states are scene-independent and
   * survive as they are (the service re-validates edge picks itself).
   */
  setOptions(axes: AxisOption[]): void {
    if (this.state?.kind === 'axis') {
      const prev = this.state.option;
      const match = axes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.state = match ? { kind: 'axis', option: match } : this.fallbackState();
    }
    this.render();
  }

  /** An axis picked in 3D or the timeline; no events fire. */
  selectOption(option: AxisOption): void {
    this.state = { kind: 'axis', option };
    this.render();
  }

  /**
   * A connector picked as the axis — a gizmo, or a connector row. Only a
   * connector-taking slot has it. No events fire.
   */
  selectConnector(option: ConnectorOption): void {
    this.state = { kind: 'connector', option };
    this.render();
  }

  /**
   * Re-find a held connector after a render, by its site (its id changed
   * with the render); one the scene no longer holds falls back like a
   * vanished axis statement. A kept connector re-finds its own the same way
   * (gone, the chip reads as the statement's text). Every other state is
   * left alone.
   */
  setConnectorOptions(connectors: readonly ConnectorOption[]): void {
    if (this.keptConnectorSite) {
      this.keptConnector = ConnectorOptions.forSite(this.keptConnectorSite, connectors) ?? null;
    }
    const state = this.state;
    if (state?.kind === 'connector') {
      const match = ConnectorOptions.forSite(state.option, connectors);
      this.state = match ? { kind: 'connector', option: match } : this.fallbackState();
    }
    this.render();
  }

  /**
   * A standard axis: a world axis clicked in the viewport, a sketch datum
   * pick, or a create-mode default. No events fire — the service drops any
   * picked edge and schedules the preview itself.
   */
  selectStandard(axis: StandardAxis): void {
    this.state = { kind: 'standard', axis };
    this.render();
  }

  /**
   * The picked-edge chip (the service owns the entity); null clears it —
   * back to the statement's own axis (edit mode), else the prompt.
   */
  setEdgeChip(label: string | null): void {
    this.edgeLabel = label;
    if (label !== null) {
      this.state = { kind: 'edge' };
    } else if (this.state?.kind === 'edge') {
      this.state = this.fallbackState();
    }
    this.render();
  }

  /**
   * An origin plane clicked in the viewport, standing for its normal. Only
   * a plane-taking slot has it. No events fire.
   */
  selectStandardPlane(plane: StandardPlane): void {
    if (!this.opts.planes) {
      return;
    }
    this.state = { kind: 'standard-plane', plane };
    this.render();
  }

  /**
   * A plane statement picked in 3D or the timeline, standing for its
   * normal. Only a plane-taking slot has it. No events fire.
   */
  selectPlane(option: PlaneOption): void {
    if (!this.opts.planes) {
      return;
    }
    this.state = { kind: 'plane', option };
    this.render();
  }

  /**
   * Refresh the offered plane statements after a re-render, as
   * {@link setOptions} does the axes: a held plane re-matches by source
   * location, and one that vanished falls back like a vanished axis.
   */
  setPlaneOptions(planes: PlaneOption[]): void {
    if (this.state?.kind === 'plane') {
      const prev = this.state.option;
      const match = planes.find(o => o.filePath === prev.filePath && o.line === prev.line);
      this.state = match ? { kind: 'plane', option: match } : this.fallbackState();
    }
    this.render();
  }

  /**
   * The picked-face chip of a plane-taking slot (the owner keeps the
   * entity); null clears it — back to the statement's own direction (edit
   * mode), else the prompt.
   */
  setFaceChip(label: string | null): void {
    if (!this.opts.planes) {
      return;
    }
    this.faceLabel = label;
    if (label !== null) {
      this.state = { kind: 'face' };
    } else if (this.state?.kind === 'face') {
      this.state = this.fallbackState();
    }
    this.render();
  }

  /** Mark the slot as the live pick target (the primary border). */
  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** The slot holds the statement's own axis: kept as written, or the literal it reads back as. */
  private atFallback(): boolean {
    const state = this.state;
    const fallback = this.fallbackState();
    if (!state || !fallback) {
      return false;
    }
    if (fallback.kind === 'standard') {
      return state.kind === 'standard' && state.axis === fallback.axis;
    }
    if (fallback.kind === 'standard-plane') {
      return state.kind === 'standard-plane' && state.plane === fallback.plane;
    }
    return state.kind === 'keep';
  }

  /** The statement-axis state a cleared slot reverts to; null in create mode. */
  private fallbackState(): DirectionSelection | null {
    if (this.keepLabel === null) {
      return null;
    }
    const matcher = this.opts.keepMatcher ?? /^['"]([xyz])['"]$/;
    const standard = this.keepLabel.trim().match(matcher);
    const keepAxes = this.opts.keepAxes ?? STANDARD_AXES;
    if (standard && keepAxes.includes(standard[1] as StandardAxis)) {
      return { kind: 'standard', axis: standard[1] as StandardAxis };
    }
    const plane = this.opts.planes ? this.keepLabel.trim().match(/^['"](xy|xz|yz)['"]$/) : null;
    if (plane && STANDARD_PLANES.includes(plane[1] as StandardPlane)) {
      return { kind: 'standard-plane', plane: plane[1] as StandardPlane };
    }
    return { kind: 'keep' };
  }

  /** The slot: one chip (the chosen axis), or the pick prompt. */
  private render(): void {
    const state = this.state;
    // A consumed axis or plane picked here is drawn for as long as the slot holds it.
    consumedReveal.set(this, this.slotHost,
      (state?.kind === 'axis' || state?.kind === 'plane') && state.option.consumer ? state.option : null);
    if (state?.kind === 'keep') {
      const removable = this.opts.clearable === true;
      this.slot.setChips([this.keptConnector
        ? ConnectorOptions.chip(this.keptConnector, { badge: '●', removable })
        : { ...keepChip(this.keepLabel ?? ''), removable }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'standard') {
      this.slot.setChips([{
        label: this.opts.chipLabel?.(state.axis) ?? `World ${state.axis.toUpperCase()} axis`,
        badge: '●',
        removable: true,
      }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'axis') {
      this.slot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'edge') {
      this.slot.setChips([{ label: this.edgeLabel ?? 'Picked edge', badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'connector') {
      this.slot.setChips([ConnectorOptions.chip(state.option, { badge: '●', removable: true })]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'standard-plane') {
      this.slot.setChips([{ label: `${state.plane.toUpperCase()} plane`, badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'plane') {
      this.slot.setChips([sourceChip(state.option, { badge: '●', removable: true })]);
      this.slot.setPrompt(null);
    } else if (state?.kind === 'face') {
      this.slot.setChips([{ label: this.faceLabel ?? 'Picked face', badge: '●', removable: true }]);
      this.slot.setPrompt(null);
    } else {
      this.slot.setChips([]);
      this.slot.setPrompt(this.opts.prompt ?? (this.opts.planes
        ? 'Pick an axis, an edge, a connector, a plane or a planar face'
        : 'Pick a world axis, an axis, an edge or a connector'));
    }
  }
}
