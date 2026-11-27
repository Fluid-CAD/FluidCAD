import {
  applyOffsetCurve, applyOffsetCurveEdit,
  type FeatureSourcesResult, type GhostOperandRef, type OffsetCurveApplyOptions, type OffsetCurveEditOptions,
  type OffsetCurveGhostRequest, type OperandInputRef,
} from '../../api';
import { hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { SceneObjectRender } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { Viewer } from '../../viewer';
import type { ParsedFeatureOf } from '../feature-dialog-registry';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { OffsetCurvePanel, type OffsetCurveRow } from './offset-curve-panel';
import { OperandRowService, type Blocked, type OperandRowHooks, type RowEdits, type RowLists } from './operand-row-service';

/** The parsed statement the dialog edits. */
type ParsedOffsetCurve = ParsedFeatureOf<'offset-curve'>;

/** What the Offset dialog reads and sends, each with its edges and `on` rows. */
type OffsetCurveWires = {
  parsed: ParsedOffsetCurve;
  sources: Extract<FeatureSourcesResult, { feature: 'offset-curve' }>;
  create: OffsetCurveApplyOptions;
  edit: OffsetCurveEditOptions;
  ghost: OffsetCurveGhostRequest;
};

/**
 * The Offset dialog, opened from the Curves menu: `offset(distance, edges,
 * { on })` outside a sketch, a curve running beside edges at a constant
 * distance, lying on faces. Its rows ({@link OffsetCurvePanel}) collect the
 * edges (edges of bodies, sketches and curve objects whole) and the faces
 * they lie on (faces of bodies, surfaces whole), and its Distance field
 * takes a length or an expression, its sign the side. A double-click grows
 * the armed row by an edge's chain or rim loop or a face's bucket, and the
 * right-click menu's groups land in it as plain picks. Once both rows hold
 * a pick and the distance reads, the curve previews in the colour of an
 * applied curve — the preview is how the side is seen — and an engine
 * refusal (the curve leaves the faces, the distance is past the tightest
 * bend, the edges are off the faces) shows in the dialog. Apply writes the
 * statement; the re-render is the result, editor undo the rollback.
 *
 * A timeline double-click on an offset curve's row reopens it over the
 * statement: the view rolls back to just before it, the rows open on the
 * statement's own arguments as "Current: …" chips and the field on its own
 * distance, and Apply sends only what changed — a re-picked row, a new
 * distance. The rows, the gestures, editing and the preview are the
 * operand-row dialogs' ({@link OperandRowService}). The `offset` rows of
 * the sketch tool and the face Offset open their own dialogs.
 */
export class OffsetCurveFeatureService extends OperandRowService<OffsetCurveRow, never, OffsetCurveWires, OffsetCurvePanel> {
  constructor(
    container: HTMLElement,
    viewer: Viewer,
    _navbar: Navbar,
    launcher: FeatureLauncher = detachedLauncher(),
    hooks: OperandRowHooks = {},
  ) {
    super(container, viewer, launcher, hooks, new OffsetCurvePanel(container), {
      kind: 'offset-curve',
      noun: 'offset curve',
      create: applyOffsetCurve,
      edit: applyOffsetCurveEdit,
      extraRows: {},
    });
  }

  /** The edges are a body's and so are the faces they lie on: a solid or a surface is all it needs. */
  protected isAvailable(sceneObjects: SceneObjectRender[]): boolean {
    return hasSolid(sceneObjects) || hasSurface(sceneObjects);
  }

  /** The rows and the distance, with the declaration a new name commits. */
  protected createRequest(rows: RowLists<OffsetCurveRow, OperandInputRef>): OffsetCurveApplyOptions | Blocked {
    const read = this.panel.readDistance();
    return 'error' in read ? read : { ...rows, ...read };
  }

  /** Only what changed: the re-picked rows, and the distance when it differs from the statement's own. */
  protected editRequest(rows: RowEdits<OffsetCurveRow>, parsed: ParsedOffsetCurve): OffsetCurveEditOptions | Blocked {
    const read = this.panel.readDistance();
    if ('error' in read) {
      return read;
    }
    return { ...rows, ...(read.distance !== parsed.distance ? read : {}), ...this.editSession(rows) };
  }

  /** The rows and the distance, which the server reads where the statement sits. */
  protected ghostRequest(rows: RowLists<OffsetCurveRow, GhostOperandRef>): OffsetCurveGhostRequest | null {
    const read = this.panel.readDistance();
    return 'error' in read ? null : { feature: 'offset-curve', distance: read.distance, ...rows };
  }

  /** The field on the statement's own distance. */
  protected override seedEdit(parsed: ParsedOffsetCurve): void {
    this.panel.seedDistance(parsed.distance);
  }
}
