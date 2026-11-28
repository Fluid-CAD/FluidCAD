import type { EndInputRef, EndSourceSlotRef } from '../../api';
import type { SelectedEntity } from '../../viewer';
import { EntitySlotControl } from './entity-slot';
import type { HandingControl } from './operand-row-panel';

/**
 * Why an end offers its position only: a corner of a solid or a surface,
 * where the edges meeting give it no one direction, or a point, which has
 * none of its own.
 */
export type PositionOnly = 'corner' | 'point';

/** An end the row picked, with what the requests, the chip and the highlight read off it. */
export type EndPick = {
  /** What Apply sends: an edge's start or end, or a vertex (a corner, a point, a sketch edge's end). */
  input: EndInputRef;
  /** The chip: "Edge end", "Corner", "Sketch point". */
  label: string;
  /** The end offers its position only, so it is met at Position whatever the row's continuity said; null when it has a direction. */
  positionOnly: PositionOnly | null;
  /** What it lights: the edge and the dot at its end, or the vertex. */
  entities: SelectedEntity[];
};

/**
 * A dialog row that holds one curve end (Bridge's From and To): the start
 * or the end of an edge, or a point. It shows the pick as a chip, an edit's
 * own end as a "Current: …" chip (`a.end()`), or its prompt while it holds
 * neither. The chip's ✕ drops the pick, back to the edit's own end or the
 * prompt.
 *
 * It owns what it holds, never the viewer: the service's {@link EndRow}
 * routes hovers and clicks in and lights what it holds, the panel arms it
 * and keeps the end's continuity in step with it ({@link onHeldChange}).
 */
export class EndSlotControl implements HandingControl {
  /** The row was clicked — the panel arms it as the pick target. */
  onArm?: () => void;
  /** A gesture in the row changed what it holds (the chip's ✕). */
  onChange?: () => void;
  /** What the row holds changed, by any route — a pick, the ✕, a reset, an edit's seed. */
  onHeldChange?: () => void;

  private readonly slot: EntitySlotControl;
  private picked: EndPick | null = null;
  /** Edit mode: the statement's own end, as written; null in create mode. */
  private keepText: string | null = null;
  /** Edit mode: what the engine resolved the statement's own end to, once it answered. */
  private kept: EndSourceSlotRef | null = null;

  constructor(host: HTMLElement, opts: { label: string; prompt: string }) {
    this.slot = new EntitySlotControl(host, { label: opts.label, prompt: opts.prompt });
    this.slot.onArm = () => this.onArm?.();
    this.slot.onRemove = () => {
      if (this.picked) {
        this.clear();
        this.onChange?.();
      }
    };
  }

  /** The end the row picked, or null while it holds none of its own. */
  get pick(): EndPick | null {
    return this.picked;
  }

  /** What the engine resolved an edit's own end to, or null (create mode, no answer yet, or nothing it can address). */
  get keptSource(): EndSourceSlotRef | null {
    return this.picked === null && this.keepText !== null ? this.kept : null;
  }

  holds(): boolean {
    return this.picked !== null;
  }

  isEmpty(): boolean {
    return this.picked === null && this.keepText === null;
  }

  /** The row takes `pick`, in place of what it held. */
  take(pick: EndPick): void {
    this.picked = pick;
    this.slot.setChip(pick.label);
    this.onHeldChange?.();
  }

  /** Drop the pick: back to an edit's own end, or the prompt. */
  clear(): void {
    if (this.picked === null) {
      return;
    }
    this.picked = null;
    this.slot.setChip(null);
    this.onHeldChange?.();
  }

  /** Edit mode: the statement's own end as a "Current: …" chip, nothing picked. */
  seedKeep(text: string): void {
    this.picked = null;
    this.keepText = text;
    this.kept = null;
    this.slot.seedKeep(text);
    this.onHeldChange?.();
  }

  /** What the engine resolved the statement's own end to — the preview stands on it and the highlight lights it. */
  setKeptSource(source: EndSourceSlotRef | null): void {
    this.kept = source;
  }

  setArmed(armed: boolean): void {
    this.slot.setArmed(armed);
  }

  /** Fresh create-mode arming: no pick, no edit's own end, the prompt. */
  reset(): void {
    this.picked = null;
    this.keepText = null;
    this.kept = null;
    this.slot.reset();
    this.onHeldChange?.();
  }
}
