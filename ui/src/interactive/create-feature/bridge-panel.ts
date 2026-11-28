import type { BridgeContinuity, NewVariable, ValueExpr } from '../../api';
import type { ExpressionField } from '../../ui/expression-field';
import { EndSlotControl, type PositionOnly } from './end-slot';
import { OperandRowPanel } from './operand-row-panel';
import { ChoiceTabs } from './panel-controls';

/** The two end rows: where the bridge starts, and where it ends. */
export type BridgeEnd = 'from' | 'to';

/** The magnitude a new bridge opens with at each end. */
const DEFAULT_MAGNITUDE = 1;

/** What an end that offers its position only says under its continuity. */
export const POSITION_ONLY_HINT: Record<PositionOnly, string> = {
  corner: 'A corner is met at its position.',
  point: 'A point is met at its position.',
};

/** What a magnitude field gives the requests: its value, with the declaration a new name commits — or why it can't be sent. */
export type MagnitudeRead = { magnitude: ValueExpr; newVariable?: NewVariable } | { error: string };

/** How each end row is named in the messages. */
const END_NAME: Record<BridgeEnd, string> = { from: 'From', to: 'To' };

/** One end's options: how the bridge meets it, and how far it runs straight there. */
type EndOptions = {
  slot: EndSlotControl;
  tabs: ChoiceTabs<BridgeContinuity>;
  /** The continuity the user chose, which a position-only end overrides while it holds one. */
  chosen: BridgeContinuity;
  magnitude: ExpressionField;
  magnitudeRow: HTMLElement;
  hint: HTMLElement;
};

/** One end's rows in the body: the end, its continuity, its magnitude. */
function endHtml(end: BridgeEnd): string {
  return `
    <div data-role="${end}-group" class="flex flex-col gap-3${end === 'to' ? ' border-t border-base-content/10 pt-3' : ''}">
      <div data-role="${end}-slot"></div>
      <div class="flex flex-col gap-1.5">
        <span class="text-base-content/70">Continuity</span>
        <div data-role="${end}-continuity" class="join w-full"></div>
        <span data-role="${end}-continuity-hint" class="hidden text-xs leading-snug text-base-content/50"></span>
      </div>
      <label data-role="${end}-magnitude-row" class="flex flex-col gap-1.5"
        title="How far the bridge keeps going straight at this end before it turns, against the gap: larger is fuller, smaller is tighter">
        <span class="text-base-content/70">Magnitude</span>
        <input data-role="${end}-magnitude" type="number" step="0.1" min="0" value="${DEFAULT_MAGNITUDE}"
          class="input input-sm input-bordered w-full text-xs" />
      </label>
    </div>
  `;
}

/**
 * The Bridge dialog of the Curves menu — `bridge(from, to)`, a smooth curve
 * joining two curve ends. Its rows, grouped by end:
 *
 * - **From**, an end row ({@link EndSlotControl}): the start or the end of
 *   an edge, or a point;
 * - its **Continuity**: *Position*, *Tangent* (the default) or *Curvature*
 *   — how the bridge meets that end;
 * - its **Magnitude** ({@link valueField}): how far the bridge keeps going
 *   straight there, 1 by default; hidden while the end is met at Position,
 *   where it does nothing;
 * - then **To**, with the same three.
 *
 * The dialog opens with From armed, and From's first pick hands the border
 * to an empty To (both rows join the hand-on of {@link OperandRowPanel}).
 * An end that offers its position only — a corner of a solid or a surface,
 * where tangent would follow whichever edge names it, or a point — is met
 * at Position: its continuity locks there with a hint, and comes back to
 * the user's choice once the row holds another end. A curve puts no
 * material anywhere, so there is no operation and no scope.
 */
export class BridgePanel extends OperandRowPanel<never, BridgeEnd> {
  readonly from: EndSlotControl;
  readonly to: EndSlotControl;
  private readonly ends: Record<BridgeEnd, EndOptions>;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'bridge',
      title: 'Bridge',
      editTitle: 'Edit bridge',
      rows: [],
      bodyHtml: endHtml('from') + endHtml('to'),
    });
    this.from = this.armable('from', new EndSlotControl(this.role('from-slot'), {
      label: 'From',
      prompt: 'Pick near the end of an edge or a curve, or a point',
    }), { handsOn: true });
    this.to = this.armable('to', new EndSlotControl(this.role('to-slot'), {
      label: 'To',
      prompt: 'Pick near the end of another edge or curve, or a point',
    }), { handsOn: true });
    this.ends = { from: this.endOptions('from', this.from), to: this.endOptions('to', this.to) };
  }

  /** How the bridge meets `end`: Position while the end offers its position only, else the user's choice. */
  continuity(end: BridgeEnd): BridgeContinuity {
    const options = this.ends[end];
    return options.slot.pick?.positionOnly ? 'g0' : options.chosen;
  }

  /** The magnitude field of `end` is on show: the end is not met at Position. */
  magnitudeShown(end: BridgeEnd): boolean {
    return this.continuity(end) !== 'g0';
  }

  /**
   * The magnitude at `end` — a number, or an expression with the
   * declaration a new name commits — or the message keeping the requests
   * back: an empty or unreadable field, or a number not above zero. Read
   * only while the field is on show.
   */
  readMagnitude(end: BridgeEnd): MagnitudeRead {
    const read = this.ends[end].magnitude.read();
    const name = END_NAME[end];
    if ('error' in read) {
      return {
        error: read.error === 'empty'
          ? `Enter a magnitude at the ${name} end.`
          : `Enter a valid magnitude at the ${name} end — ${read.error}.`,
      };
    }
    if (typeof read.value === 'number' && read.value <= 0) {
      return { error: `Enter a magnitude greater than zero at the ${name} end.` };
    }
    return { magnitude: read.value, ...(read.newVariable ? { newVariable: read.newVariable } : {}) };
  }

  /** Edit mode: each end's continuity and magnitude as the statement writes them. */
  seedOptions(state: Record<BridgeEnd, { continuity: BridgeContinuity; magnitude: ValueExpr }>): void {
    for (const end of ['from', 'to'] as const) {
      this.ends[end].chosen = state[end].continuity;
      this.ends[end].magnitude.setValue(state[end].magnitude);
      this.syncEnd(end);
    }
  }

  /** Create mode: Tangent and a magnitude of 1 at each end. */
  protected override resetOptions(): void {
    for (const end of ['from', 'to'] as const) {
      this.ends[end].chosen = 'g1';
      this.ends[end].magnitude.setValue(DEFAULT_MAGNITUDE);
      this.syncEnd(end);
    }
  }

  private endOptions(end: BridgeEnd, slot: EndSlotControl): EndOptions {
    const tabs = new ChoiceTabs<BridgeContinuity>(this.role(`${end}-continuity`), [
      {
        key: 'g0',
        label: 'Position',
        title: "The bridge meets the end at its position only, at an angle — .continuity('g0')",
      },
      {
        key: 'g1',
        label: 'Tangent',
        title: 'The bridge leaves the end heading the way its curve heads, carrying it on smoothly',
      },
      {
        key: 'g2',
        label: 'Curvature',
        title: "The bridge carries on the curve's bend at the end as well — .continuity('g2')",
      },
    ], 'g1', { compact: true });
    const options: EndOptions = {
      slot,
      tabs,
      chosen: 'g1',
      magnitude: this.valueField(`${end}-magnitude`),
      magnitudeRow: this.role(`${end}-magnitude-row`),
      hint: this.role(`${end}-continuity-hint`),
    };
    tabs.onChange = () => {
      options.chosen = tabs.value;
      this.syncEnd(end);
      this.onChange?.();
    };
    // A pick, the chip's ✕, a reset, an edit's seed: the continuity follows what the end offers.
    slot.onHeldChange = () => this.syncEnd(end);
    return options;
  }

  /**
   * Show `end` as it is met: a position-only end locked at Position with
   * its hint, else the user's choice live; the magnitude only off Position.
   */
  private syncEnd(end: BridgeEnd): void {
    const options = this.ends?.[end];
    if (!options) {
      // A row reset while the panel is still building its options.
      return;
    }
    const only = options.slot.pick?.positionOnly ?? null;
    options.tabs.setValue(only ? 'g0' : options.chosen);
    options.tabs.setDisabled(only ? ['g1', 'g2'] : []);
    options.hint.textContent = only ? POSITION_ONLY_HINT[only] : '';
    options.hint.classList.toggle('hidden', only === null);
    options.magnitudeRow.classList.toggle('hidden', !this.magnitudeShown(end));
  }
}
