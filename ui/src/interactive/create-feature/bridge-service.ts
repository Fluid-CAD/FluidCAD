import {
  applyBridge, applyBridgeEdit,
  type BridgeApplyOptions, type BridgeEditOptions, type BridgeGhostRequest, type FeatureSourcesResult, type NewVariable,
  type ValueExpr,
} from '../../api';
import { SceneIndex } from '../../helpers/scene-index';
import { hasCurve, hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { SceneObjectRender } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { Viewer } from '../../viewer';
import type { ParsedFeatureOf } from '../feature-dialog-registry';
import { BridgePanel, type BridgeEnd, type MagnitudeRead } from './bridge-panel';
import { EndPicks, EndRow } from './end-row';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { OperandRowService, type Blocked, type OperandRowHooks } from './operand-row-service';

/** The parsed statement the dialog edits. */
type ParsedBridge = ParsedFeatureOf<'bridge'>;

/** What the Bridge dialog reads and sends: no operand rows, its two ends beside them. */
type BridgeWires = {
  parsed: ParsedBridge;
  sources: Extract<FeatureSourcesResult, { feature: 'bridge' }>;
  create: BridgeApplyOptions;
  edit: BridgeEditOptions;
  ghost: BridgeGhostRequest;
};

/** What an Apply with an end row empty is told. */
const EMPTY_END: Record<BridgeEnd, string> = {
  from: 'Pick where the bridge starts: near the end of an edge or a curve, or a point.',
  to: 'Pick where the bridge ends: near the end of an edge or a curve, or a point.',
};

/** What an end row is told when the other end already holds the same end. */
const SAME_END: Record<BridgeEnd, string> = {
  from: 'The bridge already ends there — pick another end.',
  to: 'The bridge already starts there — pick another end.',
};

/** The other end. */
const OTHER: Record<BridgeEnd, BridgeEnd> = { from: 'to', to: 'from' };

/** One end's magnitude as a request carries it: the value, with the declaration a new name commits. */
type EndMagnitude = { magnitude: ValueExpr; newVariable?: NewVariable };

/**
 * The Bridge dialog, opened from the Curves menu: `bridge(from, to)`, a
 * smooth curve joining two curve ends. Its rows ({@link BridgePanel}) are
 * the two ends — each the start or the end of an edge of a solid, a surface,
 * a curve or a sketch, or a point — each with how the bridge meets it
 * (Position, Tangent, Curvature) and its magnitude. While an end row is
 * armed, hovering an edge floats its nearer end and a click takes it; a
 * vertex click takes the vertex, a corner or a point met at Position only
 * ({@link EndRow}). From opens armed and its pick hands the border to To.
 * Once both ends hold a pick and the magnitudes on show read, the bridge
 * previews as a curve, following every continuity and magnitude change,
 * and an engine refusal (the two ends at one point) shows in the dialog.
 * Apply writes the statement; the re-render is the result, editor undo the
 * rollback.
 *
 * A timeline double-click on a bridge's row reopens it over the statement:
 * the view rolls back to just before it, the ends open on the statement's
 * own as "Current: …" chips, the continuities and magnitudes as written,
 * and Apply sends only what changed — an end re-picked, a continuity, a
 * magnitude. The arming, the gestures, editing and the preview are the
 * operand-row dialogs' ({@link OperandRowService}), the ends two rows beside
 * no operand rows.
 */
export class BridgeFeatureService extends OperandRowService<never, BridgeEnd, BridgeWires, BridgePanel> {
  private readonly ends: Record<BridgeEnd, EndRow>;

  constructor(
    container: HTMLElement,
    viewer: Viewer,
    _navbar: Navbar,
    launcher: FeatureLauncher = detachedLauncher(),
    hooks: OperandRowHooks = {},
  ) {
    const panel = new BridgePanel(container);
    const picks = new EndPicks(viewer);
    const ends = {} as Record<BridgeEnd, EndRow>;
    for (const end of ['from', 'to'] as const) {
      ends[end] = new EndRow(panel[end], picks, viewer, {
        refuse: input => EndRow.sameEnd(input, ends[OTHER[end]].createValue()) ? SAME_END[end] : null,
      });
    }
    super(container, viewer, launcher, hooks, panel, {
      kind: 'bridge',
      noun: 'bridge',
      create: applyBridge,
      edit: applyBridgeEdit,
      extraRows: ends,
    });
    this.ends = ends;
  }

  /** An end is an edge's or a vertex's: a body, a curve or a sketch's edges are all it needs. */
  protected isAvailable(sceneObjects: SceneObjectRender[]): boolean {
    return hasSolid(sceneObjects) || hasSurface(sceneObjects) || hasCurve(sceneObjects) || hasSketchEdge(sceneObjects);
  }

  /** Both ends, how the bridge meets each, and each magnitude — 1 at an end met at Position, where it is not written. */
  protected createRequest(): BridgeApplyOptions | Blocked {
    const from = this.ends.from.createValue();
    const to = this.ends.to.createValue();
    if (!from || !to) {
      return { error: EMPTY_END[from ? 'to' : 'from'] };
    }
    const start = this.magnitude('from');
    const end = this.magnitude('to');
    if ('error' in start) {
      return start;
    }
    if ('error' in end) {
      return end;
    }
    const newVariables = [start, end].flatMap(read => read.newVariable ? [read.newVariable] : []);
    return {
      from,
      to,
      startContinuity: this.panel.continuity('from'),
      endContinuity: this.panel.continuity('to'),
      startMagnitude: start.magnitude,
      endMagnitude: end.magnitude,
      ...(newVariables.length > 0 ? { newVariables } : {}),
    };
  }

  /**
   * Only what changed: a re-picked end (with the boundary for an edge or a
   * vertex); a continuity that differs from the statement's; a magnitude on
   * show that differs from its own — one at an end met at Position is not
   * written, so never sent.
   */
  protected editRequest(_rows: object, parsed: ParsedBridge): BridgeEditOptions | Blocked {
    const start = this.magnitude('from');
    const end = this.magnitude('to');
    if ('error' in start) {
      return start;
    }
    if ('error' in end) {
      return end;
    }
    const startContinuity = this.panel.continuity('from');
    const endContinuity = this.panel.continuity('to');
    const startChanged = this.panel.magnitudeShown('from') && start.magnitude !== parsed.startMagnitude;
    const endChanged = this.panel.magnitudeShown('to') && end.magnitude !== parsed.endMagnitude;
    const newVariables = [startChanged ? start : null, endChanged ? end : null]
      .flatMap(read => read?.newVariable ? [read.newVariable] : []);
    return {
      from: this.ends.from.editValue(),
      to: this.ends.to.editValue(),
      startContinuity: startContinuity !== parsed.startContinuity ? startContinuity : undefined,
      endContinuity: endContinuity !== parsed.endContinuity ? endContinuity : undefined,
      startMagnitude: startChanged ? start.magnitude : undefined,
      endMagnitude: endChanged ? end.magnitude : undefined,
      ...(newVariables.length > 0 ? { newVariables } : {}),
      ...this.editSession({}, this.ends.from.picksGeometry || this.ends.to.picksGeometry),
    };
  }

  /** Both ends as the preview addresses them, the continuities, and the magnitudes once those on show read. */
  protected ghostRequest(): BridgeGhostRequest | null {
    const from = this.ends.from.ghost();
    const to = this.ends.to.ghost();
    const start = this.magnitude('from');
    const end = this.magnitude('to');
    if (!from || !to || 'error' in start || 'error' in end) {
      return null;
    }
    return {
      feature: 'bridge',
      from,
      to,
      startContinuity: this.panel.continuity('from'),
      endContinuity: this.panel.continuity('to'),
      startMagnitude: start.magnitude,
      endMagnitude: end.magnitude,
    };
  }

  /** The ends on the statement's own as "Current: …" chips, each continuity and magnitude as written. */
  protected override seedEdit(parsed: ParsedBridge): void {
    this.ends.from.seedKeep(parsed.fromText);
    this.ends.to.seedKeep(parsed.toText);
    this.panel.seedOptions({
      from: { continuity: parsed.startContinuity, magnitude: parsed.startMagnitude },
      to: { continuity: parsed.endContinuity, magnitude: parsed.endMagnitude },
    });
  }

  /** What the statement's own ends resolve to, which their chips light and the preview stands on. */
  protected override seedSources(sources: BridgeWires['sources'] | null): void {
    this.ends.from.setKeptSource(sources?.from ?? null);
    this.ends.to.setKeptSource(sources?.to ?? null);
  }

  /** The magnitude at `end` as the requests carry it: the field's while on show, 1 at an end met at Position. */
  private magnitude(end: BridgeEnd): EndMagnitude | Blocked {
    if (!this.panel.magnitudeShown(end)) {
      return { magnitude: 1 };
    }
    const read: MagnitudeRead = this.panel.readMagnitude(end);
    return read;
  }
}

/** The scene holds a sketch with an edge drawn — a line's end is an end too. */
function hasSketchEdge(sceneObjects: SceneObjectRender[]): boolean {
  const index = SceneIndex.of(sceneObjects);
  return sceneObjects.some(row => index.enclosing(row, 'sketch') !== undefined
    && (row.sceneShapes ?? []).some(shape => !shape.isMetaShape && !shape.isGuide
      && (shape.shapeType === 'edge' || shape.shapeType === 'wire')));
}
