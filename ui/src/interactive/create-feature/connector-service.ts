import {
  applyConnector, applyConnectorEdit, ConnectorApplyOptions, ConnectorEditOptions, ConnectorOffsetSpec, ConnectorRotateSpec,
  FeatureEditTarget, getScopeVariables, ParsedFeatureStatement,
} from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { VariableInfo } from '../../ui/expression-core';
import { EditSession, EditSessionInfo } from '../edit-session';
import { ConnectorFrameData } from '../../meshes/containers/connector-mesh';
import { ConnectorAdjustments, ConnectorPanel } from './connector-panel';
import { ConnectorGhostOverlay, adjustConnectorFrame, unadjustConnectorFrame } from './connector-ghost';
import { AnchorSuggestions, LockedAnchor, anchorChipLabel } from './anchor-suggestions';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { collectSolidTargets } from './solid-targets';
import { collectSketchProfiles } from './sketch-profiles';
import { iconUrl } from '../../ui/icon-url';

/**
 * The Connector tool on the part-design rails: hovering solid faces/edges
 * floats the nearest known connector anchor (face center; edge
 * center/start/end) as a translucent axis-triad gizmo, exact frames served
 * by the kernel's anchor-suggestion endpoint. A click locks the suggestion
 * into the dialog — name (prefilled with the part's free `c1`-style
 * default), frame-local offset, and the 90°-per-click rotation stepper —
 * with the gizmo tracking every edit live (pure client-side frame math; the
 * kernel already supplied exact axes). Apply writes
 * `connector('name', <source>.center())` — with `.offset(…)` /
 * `.rotate('z', …)` chained as dialled — into the enclosing part() body; the
 * re-render is the preview, editor undo the rollback.
 */
export class ConnectorFeatureService {
  private panel: ConnectorPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  private ghost: ConnectorGhostOverlay;
  private runner: ApplyRunner<ConnectorApplyOptions | ConnectorEditOptions>;
  /** The hover → anchor suggestion → click-lock rail (shared with the hole dialog). */
  private suggestions: AnchorSuggestions;

  private locked: LockedAnchor | null = null;

  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /**
   * Edit mode: the anchor frame the edited connector stands on — its built
   * frame with the statement's own adjustments taken back off, so the
   * dialog's live gizmo re-applies from the anchor instead of compounding
   * onto what the statement already did. Null when the row carried no frame
   * (a connector whose build failed), or while an adjustment is an
   * expression the scope's variables cannot yet resolve.
   */
  private anchorFrame: ConnectorFrameData | null = null;
  /** Edit mode: the built connector's frame and the statement's own adjustments, the anchor frame's ingredients. */
  private editFrame: { frame: ConnectorFrameData; adjustments: ConnectorAdjustments } | null = null;
  /** The variables in scope at the statement (edit) or the active part (create), as last read. */
  private variables: VariableInfo[] = [];

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // The connector gets its own group at the end of the bar: it is the
    // assembly-prep tool, neither reshaping bodies (modify) nor repositioning
    // them (transform). main.ts constructs this service last so the group
    // registers — and therefore renders — after every other one. Part-design
    // only: connectors are declared on the part, and assemblies mate through
    // those part-owned connectors — the assembly bar has no Connector tool.
    const group = navbar.getGroup('connector')
      ?? navbar.addGroup('connector', { visible: false, mode: 'part' });
    this.button = new FeatureButton(group, {
      icon: iconUrl('mate-connector'),
      label: 'Connector',
      tip: 'Add a mate connector',
      ariaLabel: 'Add a named mate connector to the part',
      hidden: true,
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.ghost = new ConnectorGhostOverlay(viewer);
    this.suggestions = new AnchorSuggestions(viewer, this.ghost, {
      isTaken: (key, index) => this.locked?.key === key && this.locked.anchorIndex === index,
    });
    this.suggestions.onLock = (locked) => this.lockSuggestion(locked);
    this.suggestions.onRefuse = (reason) => this.panel.setMessage(reason ?? 'A connector cannot attach to that shape.');

    this.panel = new ConnectorPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.updatePreviewGhost();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveSource = () => {
      this.locked = null;
      // Edit mode falls back to the statement's own source (the un-removable
      // "Current: …" chip the slot still holds); create mode falls back to
      // the pick prompt, with nothing left to preview.
      this.panel.setSourceChip(null);
      this.panel.setMessage(null);
      if (this.editTarget) {
        this.updatePreviewGhost();
        this.runner.schedulePreview();
        return;
      }
      this.panel.setPreview(null);
      this.runner.cancelPreview();
      this.ghost.clearPreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      session: this.session,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyConnectorEdit(this.editTarget, { ...(request as ConnectorEditOptions), ...extras })
        : applyConnector({ ...(request as ConnectorApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not add the connector.',
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport face/edge clicks. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps the
   * viewport rolled back to just before the edited statement — the world the
   * connector's source expression sees, its own gizmo absent so the dialog's
   * ghost stands in its place, and the geometry it attaches to visible and
   * re-pickable.
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      this.update(isRollback ? [] : sceneObjects);
      return;
    }
    if (!this.armed) {
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.exit({ editEnd: 'gone' });
      return;
    }
    if (state === 'waiting') {
      return;
    }
    // At the boundary. Shape ids are per-render, so a re-pick made against
    // the old scene died with it — the source falls back to the statement's
    // own expression, which is text and survives. The anchor frame is world
    // geometry from the row, so the ghost keeps drawing throughout.
    this.suggestions.clear();
    if (this.locked) {
      this.locked = null;
      this.panel.setSourceChip(null);
      this.panel.setMessage('The code changed — pick the connector location again.');
    }
    this.syncViewport();
    this.updatePreviewGhost();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // A connector anchors on a solid; a blank document offers the button too
    // (see {@link Viewer.sceneIsEmpty}).
    this.available = collectSolidTargets(sceneObjects).length > 0 || this.viewer.sceneIsEmpty;
    this.navbar.setGroupVisible('connector', this.available, 'connector');
    this.button.setVisible(this.available);
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Shape ids are per-render — the hover cache and any locked pick died
    // with the old scene. The dialog's typed values survive.
    this.suggestions.clear();
    if (this.locked) {
      this.locked = null;
      this.panel.setSourceChip(null);
      this.panel.setPreview(null);
      this.runner.cancelPreview();
      this.ghost.clear();
      this.panel.setMessage('The code changed — pick the connector location again.');
    }
  }

  /**
   * Open the dialog over an existing `connector()` statement (timeline
   * double-click). Every field seeds from the parsed statement and its source
   * expression stands as the slot's kept chip — a viewport click re-points it
   * at fresh geometry, everything else edits in place. `frame` is the built
   * connector's own frame, straight off its timeline row: the ghost recovers
   * the anchor it stands on from it, so dialling the rotation or an offset
   * previews live even before anything is re-picked.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'connector' }>,
    info: Omit<EditSessionInfo, 'target'>,
    frame: ConnectorFrameData | null,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.locked = null;
    this.suggestions.setEnabled(true);
    this.variables = [];
    this.editFrame = frame ? { frame, adjustments: { rotate: parsed.rotate, offset: parsed.offset } } : null;
    this.syncAnchorFrame();
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.panel.showEdit({
      name: parsed.name,
      sourceText: parsed.argsText,
      rotate: parsed.rotate,
      offset: parsed.offset,
    });
    void this.refreshScopeVariables();
    this.syncViewport();
    this.updatePreviewGhost();
    this.runner.schedulePreview();
  }

  /**
   * Edit mode: recover the anchor frame from the built connector's by taking
   * the statement's own adjustments back off — numbers as they are,
   * expressions by the variables in scope. While one cannot be resolved there
   * is no anchor to stand the ghost on, so none draws until a re-pick (whose
   * anchor the kernel supplies) or the variables arrive.
   */
  private syncAnchorFrame(): void {
    if (!this.editFrame) {
      this.anchorFrame = null;
      return;
    }
    const resolved = ConnectorPanel.resolveAdjustments(this.editFrame.adjustments, this.variables);
    this.anchorFrame = resolved ? unadjustConnectorFrame(this.editFrame.frame, resolved.rotate, resolved.offset) : null;
  }

  /**
   * The variables in scope at the statement (edit mode) or the active part
   * (create mode), for the fields' dropdowns and the axis expression; the
   * anchor frame and the ghost re-derive from what the expressions then come
   * to. A read landing after the dialog closed or re-targeted is dropped.
   */
  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    const variables = await getScopeVariables(line);
    if (!this.armed || (this.editTarget?.line ?? null) !== line) {
      return;
    }
    this.variables = variables;
    this.panel.setScopeVariables(variables);
    this.syncAnchorFrame();
    this.updatePreviewGhost();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.locked = null;
    this.suggestions.setEnabled(true);
    this.variables = [];
    // Placing a connector means looking at the whole solid, not down the
    // active sketch plane — leave sketch editing right away.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.panel.show();
    void this.refreshScopeVariables();
    this.syncViewport();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits; user cancels
   * default to `'immediate'`. Ending an edit session always resumes lazily (a
   * render follows every session end).
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'handoff' | 'gone' } = {}): void {
    if (!this.armed) {
      return;
    }
    const hadSession = this.session.active;
    this.session.end(opts.editEnd ?? 'cancel');
    if (hadSession) {
      opts = { ...opts, resume: 'lazy' };
    }
    this.armed = false;
    this.editTarget = null;
    this.anchorFrame = null;
    this.editFrame = null;
    this.locked = null;
    this.suggestions.setEnabled(false);
    this.runner.cancelPreview();
    this.ghost.clear();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Viewer hover while the tool is armed: the suggestion rail floats the
   * hovered face/edge's nearest anchor as the translucent gizmo. A locked
   * pick doesn't stop the hunt: its strong preview stays put while other
   * faces/edges keep floating suggestions, and the next click re-locks.
   */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed) {
      return;
    }
    this.suggestions.handleHover(shapeId, sub, clientX, clientY);
  }

  /**
   * Viewport click while armed: lock the floated suggestion into the source
   * slot (the rail fetches on the spot when the click outran the hover).
   * Clicking with a lock already set re-picks — the slot stays live like
   * every armed pick slot.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed) {
      return;
    }
    this.suggestions.handleClick(shapeId, sub);
  }

  private lockSuggestion(locked: LockedAnchor): void {
    this.locked = locked;
    const anchor = locked.anchors[locked.anchorIndex];
    this.panel.setSourceChip(anchorChipLabel(locked.entity, anchor));
    this.panel.suggestName(locked.defaultName);
    this.panel.setMessage(null);
    this.updatePreviewGhost();
    this.runner.schedulePreview();
  }

  /**
   * The dialog's current rotate/offset on its anchor frame — the locked
   * pick's, or (edit mode, source untouched) the edited connector's own. Pure
   * client-side frame math: the kernel already supplied exact axes. The
   * numbers are the fields' own or what their expressions come to; while one
   * cannot be told, or there is no anchor, no frame draws — the statement
   * preview still says what will be written.
   */
  private updatePreviewGhost(): void {
    const frame = this.locked
      ? this.locked.anchors[this.locked.anchorIndex].frame
      : this.anchorFrame;
    const adjustments = this.panel.resolvedAdjustments();
    if (!frame || !adjustments) {
      this.ghost.clearPreview();
      return;
    }
    this.ghost.showPreview(adjustConnectorFrame(frame, adjustments.rotate, adjustments.offset));
  }

  /** Whether a rotation writes its chain: an expression always may; a literal angle must not be a full turn. */
  private static rotateActive(rotate: ConnectorRotateSpec): boolean {
    return typeof rotate.angle !== 'number' || rotate.angle % 360 !== 0;
  }

  /** Whether an offset writes its chain: a component that is an expression, or a literal that is not 0. */
  private static offsetActive(offset: ConnectorOffsetSpec): boolean {
    return offset.some(v => v !== 0);
  }

  private buildRequest(): ConnectorApplyOptions | { error: string } {
    if (!this.locked) {
      return { error: 'Click a suggested connector location in the viewport first.' };
    }
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    // The create route synthesizes the statement without landing
    // declarations, so a fresh name typed into a field would reference a
    // variable the file lacks — the declaration is the user's to write first.
    if (values.newVariables && values.newVariables.length > 0) {
      const names = values.newVariables.map(variable => variable.name).join(', ');
      return { error: `Declare ${names} in the source first — a new connector writes no declarations.` };
    }
    const anchor = this.locked.anchors[this.locked.anchorIndex].anchor;
    return {
      name: values.name,
      entities: [this.locked.entity],
      anchor,
      rotate: ConnectorFeatureService.rotateActive(values.rotate) ? values.rotate : undefined,
      offset: ConnectorFeatureService.offsetActive(values.offset) ? values.offset : undefined,
    };
  }

  /**
   * The edit-mode apply payload. Name and both adjustments always ride —
   * clearing the rotation or an offset field drops that chain rather than
   * keeping the statement's own. The source travels only when a viewport
   * click replaced it; untouched, the statement's own expression stands byte
   * for byte.
   */
  private buildEditRequest(): ConnectorEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const request: ConnectorEditOptions = {
      name: values.name,
      rotate: ConnectorFeatureService.rotateActive(values.rotate) ? values.rotate : null,
      offset: ConnectorFeatureService.offsetActive(values.offset) ? values.offset : null,
      newVariables: values.newVariables,
      expectedStatement: this.session.expectedStatement,
      before: this.session.boundary ?? undefined,
    };
    if (!this.locked) {
      return request;
    }
    return {
      ...request,
      entities: [this.locked.entity],
      anchor: this.locked.anchors[this.locked.anchorIndex].anchor,
    };
  }

  /** Faces and edges only — no axis/plane/sketch-wire channels. */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickPlanes = false;
    this.viewer.pickFilter = 'all';
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.hooks.onActiveChange?.();
  }
}
