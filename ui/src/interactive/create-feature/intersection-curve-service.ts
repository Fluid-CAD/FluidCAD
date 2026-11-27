import {
  applyIntersectionCurve, applyIntersectionCurveEdit,
  type FeatureSourcesResult, type GhostOperandRef, type IntersectionCurveApplyOptions, type IntersectionCurveEditOptions,
  type IntersectionCurveGhostRequest, type OperandInputRef,
} from '../../api';
import { hasSolid, hasSurface } from '../../helpers/scene-utils';
import type { SceneObjectRender } from '../../types';
import type { Navbar } from '../../ui/navbar';
import type { Viewer } from '../../viewer';
import type { ParsedFeatureOf } from '../feature-dialog-registry';
import { detachedLauncher, type FeatureLauncher } from './feature-button';
import { IntersectionCurvePanel, type IntersectionRow } from './intersection-curve-panel';
import { OperandRowService, type OperandRowHooks, type RowEdits, type RowLists } from './operand-row-service';

/** What the Intersect dialog reads and sends, each with its two rows. */
type IntersectionWires = {
  parsed: ParsedFeatureOf<'intersection-curve'>;
  sources: Extract<FeatureSourcesResult, { feature: 'intersection-curve' }>;
  create: IntersectionCurveApplyOptions;
  edit: IntersectionCurveEditOptions;
  ghost: IntersectionCurveGhostRequest;
};

/**
 * The Intersect dialog, opened from the Curves menu: `intersect(first,
 * second)` outside a sketch, the curve where two sets of faces meet. Its two
 * surface rows ({@link IntersectionCurvePanel}) collect the picks — a face of
 * a solid as that face, a surface whole — from the viewport and the
 * timeline; a double-click on a face of a body grows the armed row by the
 * face's bucket, and the right-click menu's groups land in it as plain
 * faces. Once both rows hold a pick the curve previews, in the colour of an
 * applied curve, and an engine refusal (the two sides do not cross, a face
 * on both) shows in the dialog. Apply writes the statement; the re-render
 * is the result, editor undo the rollback.
 *
 * A timeline double-click reopens it over an existing statement: the view
 * rolls back to just before it, each row opens on the statement's own
 * argument as "Current: …" chips, and Apply rewrites only the row that was
 * re-picked — a row left alone (a `plane()` the dialog cannot pick among
 * them) is written back as it was. The rows, the gestures, editing and the
 * preview are the operand-row dialogs' ({@link OperandRowService}); the
 * statement has no options.
 */
export class IntersectionCurveFeatureService extends OperandRowService<IntersectionRow, never, IntersectionWires, IntersectionCurvePanel> {
  constructor(
    container: HTMLElement,
    viewer: Viewer,
    _navbar: Navbar,
    launcher: FeatureLauncher = detachedLauncher(),
    hooks: OperandRowHooks = {},
  ) {
    super(container, viewer, launcher, hooks, new IntersectionCurvePanel(container), {
      kind: 'intersection-curve',
      noun: 'intersection curve',
      create: applyIntersectionCurve,
      edit: applyIntersectionCurveEdit,
      extraRows: {},
    });
  }

  /** A curve where two sets of faces meet needs a body to cut: a solid or a surface. */
  protected isAvailable(sceneObjects: SceneObjectRender[]): boolean {
    return hasSolid(sceneObjects) || hasSurface(sceneObjects);
  }

  protected createRequest(rows: RowLists<IntersectionRow, OperandInputRef>): IntersectionCurveApplyOptions {
    return rows;
  }

  protected editRequest(rows: RowEdits<IntersectionRow>): IntersectionCurveEditOptions {
    return { ...rows, ...this.editSession(rows) };
  }

  protected ghostRequest(rows: RowLists<IntersectionRow, GhostOperandRef>): IntersectionCurveGhostRequest {
    return { feature: 'intersection-curve', ...rows };
  }
}
