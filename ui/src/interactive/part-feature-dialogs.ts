import type { FeatureEditTarget, ParsedFeatureStatement } from '../api';
import type { ConnectorData, SceneObjectRender } from '../types';
import type { BooleanFeatureService } from './create-feature/boolean-service';
import type { ConnectorFeatureService } from './create-feature/connector-service';
import type { CopyFeatureService } from './create-feature/copy-service';
import type { ExtrudeFeatureService } from './create-feature/extrude-service';
import type { HelixFeatureService } from './create-feature/helix-service';
import type { HoleFeatureService } from './create-feature/hole/hole-service';
import type { LoftFeatureService } from './create-feature/loft-service';
import type { MirrorFeatureService } from './create-feature/mirror-service';
import type { PlaneFeatureService } from './create-feature/plane-service';
import type { RepeatFeatureService } from './create-feature/repeat-service';
import type { RevolveFeatureService } from './create-feature/revolve-service';
import type { RibFeatureService } from './create-feature/rib-service';
import type { RotateFeatureService } from './create-feature/rotate-service';
import type { SplitFeatureService } from './create-feature/split-service';
import type { SweepFeatureService } from './create-feature/sweep-service';
import type { TextEditService } from './create-feature/text-edit-service';
import type { TranslateFeatureService } from './create-feature/translate-service';
import type { WrapFeatureService } from './create-feature/wrap-service';
import {
  FeatureDialogRegistry, ServiceDialog,
  type FeatureDialogExit, type FeatureDialogService, type FeatureEditInfo, type ParsedFeatureKind,
} from './feature-dialog-registry';

/** The built-in part-mode dialog services, constructed by the page. */
export type PartDialogServices = {
  extrude: ExtrudeFeatureService;
  rib: RibFeatureService;
  hole: HoleFeatureService;
  revolve: RevolveFeatureService;
  sweep: SweepFeatureService;
  wrap: WrapFeatureService;
  loft: LoftFeatureService;
  helix: HelixFeatureService;
  repeat: RepeatFeatureService;
  copy: CopyFeatureService;
  mirror: MirrorFeatureService;
  translate: TranslateFeatureService;
  rotate: RotateFeatureService;
  split: SplitFeatureService;
  connector: ConnectorFeatureService;
  boolean: BooleanFeatureService;
  plane: PlaneFeatureService;
  text: TextEditService;
};

/**
 * The text edit dialog (a timeline double-click on a text row). It is
 * edit-only and pick-less: it takes no viewer or timeline picks, has no
 * toolbar button and leaves the Sketch button alone. Open means editing, and
 * the sketch UI stays suspended for as long as it is open.
 */
class TextEditDialog implements FeatureDialogService {
  readonly id = 'text';
  readonly editRowTypes = ['text'];
  readonly parsedFeatures: readonly ParsedFeatureKind[] = ['text'];
  readonly toolbarButton = null;
  readonly pinsSketchToolbar = false;
  readonly blocksSketchButton = false;
  readonly isPicking = false;

  constructor(private readonly service: TextEditService) {}

  get isActive(): boolean {
    return this.service.isActive;
  }

  get isEditing(): boolean {
    return this.service.isActive;
  }

  get sketchUISuspended(): boolean {
    return this.service.isActive;
  }

  exit(opts: FeatureDialogExit = {}): void {
    this.service.exit(opts.editEnd);
  }

  enterEdit(target: FeatureEditTarget, parsed: ParsedFeatureStatement, info: FeatureEditInfo): void {
    if (parsed.feature === 'text') {
      this.service.enterEdit(target, parsed, info);
    }
  }

  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    this.service.handleSceneRendered(sceneObjects, stop, isRollback);
  }
}

/**
 * Registers the built-in part-mode dialogs, each through a thin adapter over
 * its service. The order is the scene fan-out's and the timeline intercept's;
 * `part-feature-dialogs.test.ts` pins it. The viewport chains used to list
 * the dialogs in other orders, which never mattered: one dialog is armed at a
 * time, and every claim below reads its own dialog's armed state.
 */
export class PartFeatureDialogs {
  static register(registry: FeatureDialogRegistry, s: PartDialogServices): void {
    registry.register(new ServiceDialog('extrude', s.extrude, {
      // Cut is extrude's remove operation.
      edit: { rowTypes: ['extrude', 'cut'], kind: 'extrude', open: (t, p, i) => s.extrude.enterEdit(t, p, i) },
      toolbarButton: s.extrude.toolbarButton,
      pinsSketchToolbar: true,
      // The profile comes from dropdown, timeline or wire clicks only, so an
      // edit session owns the viewport only while it picks a face: "Up to
      // face" takes the target face, an armed scope slot a whole solid.
      picking: (d) => (d.isActive && !d.isEditing) || d.isFacePicking || d.isScopePicking,
      claims: { click: (d) => d.isFacePicking || d.isScopePicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('rib', s.rib, {
      edit: { rowTypes: ['rib'], kind: 'rib', open: (t, p, i) => s.rib.enterEdit(t, p, i) },
      toolbarButton: s.rib.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid into the scope slot.
      claims: { click: (d) => d.isPicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('hole', s.hole, {
      edit: { rowTypes: ['hole'], kind: 'hole', open: (t, p, i) => s.hole.enterEdit(t, p, i) },
      toolbarButton: s.hole.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isPicking,
      claims: {
        // A vertex dot or a face/edge anchor is a placement; a face or edge
        // with the scope slot armed its whole solid.
        click: (d) => d.isPicking,
        connector: (d) => d.isPicking,
        // The anchor suggestion floats at the hovered face/edge.
        hover: (d) => d.isPicking,
      },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('revolve', s.revolve, {
      edit: { rowTypes: ['revolve'], kind: 'revolve', open: (t, p, i) => s.revolve.enterEdit(t, p, i) },
      toolbarButton: s.revolve.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isAxisPicking,
      // An edge, an axis line or (axis slot armed) a connector gizmo is the axis.
      claims: { click: (d) => d.isAxisPicking, axis: (d) => d.isAxisPicking, connector: (d) => d.isConnectorPicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('sweep', s.sweep, {
      edit: { rowTypes: ['sweep'], kind: 'sweep', open: (t, p, i) => s.sweep.enterEdit(t, p, i) },
      toolbarButton: s.sweep.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => (d.isActive && !d.isEditing) || d.isEdgePicking,
      // Live path picking owns edge clicks, and the right-click chain and
      // double-click bucket expansion of the modify tools.
      claims: {
        click: (d) => d.isEdgePicking,
        contextMenu: (d) => d.isEdgePicking,
        doubleClick: (d) => d.isEdgePicking,
      },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('wrap', s.wrap, {
      edit: { rowTypes: ['wrap'], kind: 'wrap', open: (t, p, i) => s.wrap.enterEdit(t, p, i) },
      toolbarButton: s.wrap.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isFacePicking,
      // The pick is the target face.
      claims: { click: (d) => d.isFacePicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('loft', s.loft, {
      edit: { rowTypes: ['loft'], kind: 'loft', open: (t, p, i) => s.loft.enterEdit(t, p, i) },
      toolbarButton: s.loft.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isFacePicking,
      // Face profiles, scoped vertex connections and solid scope picks.
      claims: { click: (d) => d.isFacePicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('helix', s.helix, {
      edit: { rowTypes: ['helix'], kind: 'helix', open: (t, p, i) => s.helix.enterEdit(t, p, i) },
      toolbarButton: s.helix.toolbarButton,
      picking: (d) => d.isPicking,
      // An edge or a connector gizmo (axis mode) or a face (face mode) is the helix's source.
      claims: { click: (d) => d.isPicking, axis: (d) => d.isAxisPicking, connector: (d) => d.isConnectorPicking },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('repeat', s.repeat, {
      // `repeat('mirror'|'rotate', …)` rows carry the mirror and rotate
      // feature types; they parse as `repeat` all the same. A raw-matrix
      // repeat surfaces its parse refusal as the toast.
      edit: {
        rowTypes: ['repeat-linear', 'repeat-circular', 'repeat-matrix'],
        kind: 'repeat',
        open: (t, p, i) => s.repeat.enterEdit(t, p, i),
      },
      picking: (d) => d.isPicking,
      claims: {
        // An edge is the repeat axis, a face (Mirror type) the mirror plane.
        click: (d) => d.isPicking,
        axis: (d) => d.isAxisPicking,
        plane: (d) => d.isPlanePicking,
        // A connector gizmo: an armed axis slot's axis, else the dialog
        // explains that Copy repeats connectors.
        connector: (d) => d.isPicking,
      },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('copy', s.copy, {
      // A connector copy row opens it too, filed with its part's connectors;
      // a copy that follows a repeat (`copy(holes, bolt)`) opens on "Along a
      // repeat". A 2D copy row edits on the sketch rails, not here.
      edit: {
        rowTypes: ['copy-linear', 'copy-circular', 'copy-pattern'],
        kind: 'copy',
        open: (t, p, i) => s.copy.enterEdit(t, p, i),
      },
      picking: (d) => d.isPicking,
      claims: {
        // A face or edge selects its whole solid as a target, or (axis slot
        // armed) an edge is the copy axis; a connector gizmo is a target or
        // the axis.
        click: (d) => d.isPicking,
        axis: (d) => d.isAxisPicking,
        connector: (d) => d.isPicking,
      },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('mirror', s.mirror, {
      // The 3D `mirror()` rows; a 2D mirror row edits on the sketch rails.
      edit: { rowTypes: ['mirror'], kind: 'mirror', open: (t, p, i) => s.mirror.enterEdit(t, p, i) },
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid as a target, or (plane slot
      // armed) a face is the mirror plane.
      claims: { click: (d) => d.isPicking, plane: (d) => d.isPlanePicking },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('translate', s.translate, {
      edit: { rowTypes: ['translate'], kind: 'translate', open: (t, p, i) => s.translate.enterEdit(t, p, i) },
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid as a target; the gizmo's own
      // gestures never reach the click chain.
      claims: { click: (d) => d.isPicking },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('rotate', s.rotate, {
      edit: { rowTypes: ['rotate'], kind: 'rotate', open: (t, p, i) => s.rotate.enterEdit(t, p, i) },
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid as a target, or (axis slot
      // armed) an edge or a connector gizmo is the rotation axis.
      claims: { click: (d) => d.isPicking, axis: (d) => d.isAxisPicking, connector: (d) => d.isConnectorPicking },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('split', s.split, {
      edit: { rowTypes: ['split'], kind: 'split', open: (t, p, i) => s.split.enterEdit(t, p, i) },
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid as a target, or (cut slot
      // armed) a face or a plane quad is the cut plane; the cut slot also
      // takes one sketched line as the seed of the plane it sweeps out of
      // its sketch.
      claims: { click: (d) => d.isPicking, plane: (d) => d.isPlanePicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new ServiceDialog('connector', s.connector, {
      // A connector row sits inside its part() body. The copies a `copy()`
      // made of one have no statement of their own and never open it.
      edit: {
        rowTypes: ['connector'],
        kind: 'connector',
        open: (t, p, i, row) => s.connector.enterEdit(t, p, i, PartFeatureDialogs.connectorFrameOf(row)),
      },
      pinsSketchToolbar: true,
      picking: (d) => d.isPicking,
      claims: {
        // A face or edge locks the floated anchor suggestion into the source slot.
        click: (d) => d.isPicking,
        // The armed tool floats its anchor suggestion at the hovered face/edge.
        hover: (d) => d.isActive,
      },
    }));
    registry.register(new ServiceDialog('boolean', s.boolean, {
      edit: { rowTypes: ['fuse', 'subtract', 'common'], kind: 'boolean', open: (t, p, i) => s.boolean.enterEdit(t, p, i) },
      picking: (d) => d.isPicking,
      // A face or edge selects its whole solid into the armed target slot.
      claims: { click: (d) => d.isPicking },
      timelinePicks: true,
    }));
    registry.register(new ServiceDialog('plane', s.plane, {
      // A plane row qualifies only when it is a plane() statement's own (see
      // the timeline's isFeatureEditable).
      edit: { rowTypes: ['plane'], kind: 'plane', open: (t, p, i) => s.plane.enterEdit(t, p, i) },
      toolbarButton: s.plane.toolbarButton,
      pinsSketchToolbar: true,
      picking: (d) => d.isPicking,
      // A base slot in pick mode takes faces, edges and plane quads; the
      // From-edge type takes a single-curve sketch as its edge.
      claims: { click: (d) => d.isPicking, plane: (d) => d.isPlanePicking },
      timelinePicks: true,
      sketchPicks: true,
    }));
    registry.register(new TextEditDialog(s.text));
  }

  /**
   * The built frame a connector row carries — the dialog's live gizmo
   * recovers the anchor it stands on from it, so the rotation and offset
   * fields preview even before the source is re-picked. A connector whose
   * build failed serializes only its name; the dialog then opens ghost-less.
   */
  static connectorFrameOf(row: SceneObjectRender): ConnectorData | null {
    const data = row.object as ConnectorData | undefined;
    return data?.origin && data.xDirection && data.yDirection && data.normal ? data : null;
  }
}
