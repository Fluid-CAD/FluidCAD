import { SketchToolbar } from '../ui/sketch-toolbar';
import { SketchTool, ToolId } from './sketch-tool';
import { LineTool } from './tools/line-tool';
import { CircleTool } from './tools/circle-tool';
import { CenterArcTool } from './tools/center-arc-tool';
import { ThreePointArcTool } from './tools/three-point-arc-tool';
import { RectTool } from './tools/rect-tool';
import { RoundedRectTool } from './tools/rounded-rect-tool';
import { SlotTool } from './tools/slot-tool';
import { PolylineTool } from './tools/polyline';
import { BezierTool } from './tools/bezier-tool';
import { PolygonTool } from './tools/polygon-tool';
import { TextTool } from './tools/text-tool';
import { SolvedDragHandler } from './drag-move-handler/solved-drag-handler';
import { SketchHoverSelectHandler } from './sketch-hover-select-handler';
import { BezierHandlesOverlay } from './bezier-handles-overlay';
import { SnapManager } from '../snapping/snap-manager';
import { SnapController } from '../snapping/snap-controller';
import {
  insertGeometry, insertSolvedGeometry, addGuide, removeGuide, getScopeVariables, gotoSource,
  FeatureEditTarget, ParsedFeatureStatement,
} from '../api';
import type { SolvedToolContext } from './tools/solved-emission';
import { findActiveObject } from '../helpers/scene-utils';
import { SceneObjectRender, PlaneData, SourceLocation } from '../types';
import { Viewer } from '../viewer';
import { ProjectionPickService } from './projection-pick-service';
import { SketchOpDialog, SketchOpService, SketchOpSelection, SketchPickDescription, SolvedFilletRail } from './sketch-op-service';
import { SketchCopyService } from './sketch-copy-service';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { VariableInfo } from '../ui/expression-input';
import { ShortcutManager } from '../ui/shortcut-manager';
import { Navbar } from '../ui/navbar';
import { SketchDofStatus } from '../ui/sketch-dof-status';
import { buildSolvedSketchModel, computeSketchDofState, isSolvedSketch } from '../sketch-solver-client';
import { SolvedDimensionEditor } from './solved-dimension-editor';
import { SolvedConstraintToolbarService } from './solved-constraint-toolbar';

export class SketchToolbarService {
  /**
   * The 2D op dialogs (fillet, offset) occupy the sketch dialog's docked
   * spot — main.ts wires this to suspend the sketch dialog while one is open
   * and restore it when it closes.
   */
  onOpDialogToggle?: (open: boolean) => void;

  /**
   * Fires when a sketch becomes active or inactive (the sketch toolbar shows
   * or hides). main.ts uses it to collapse the create-feature buttons into the
   * Finish Sketch popup while a sketch is being edited.
   */
  onActiveChange?: (active: boolean) => void;

  /**
   * Fires when a solved-sketch constraint badge/dimension is clicked. The
   * service already jumps to the statement's source; main.ts adds the
   * timeline row flash.
   */
  onConstraintPick?: (pick: { objId?: string; sourceLocation?: SourceLocation }) => void;

  /**
   * Whether the solved-sketch DOF pill occupies the bottom-center spot, so
   * main.ts can lift the breakpoint indicator clear of it.
   */
  onDofPillVisibilityChange?: (visible: boolean) => void;

  private viewer: Viewer;
  private container: HTMLElement;
  /**
   * The Project tool's dialog. It lives outside this service (main.ts routes
   * its 3D picks) because arming it suspends sketch editing — the picks are
   * solid edges and faces, not sketch geometry.
   */
  private projectionService: ProjectionPickService;
  private opServices: Partial<Record<ToolId, SketchOpDialog>> = {};
  /** Typed handles for the dialogs with members beyond the shared surface. */
  private filletOp!: SketchOpService;
  private offsetOp!: SketchOpService;
  private rotateOp!: SketchOpService;
  private slotOp!: SketchOpService;
  private copyOp!: SketchCopyService;
  private toolbar: SketchToolbar;
  /** The solved-sketch constraint bar (P4). */
  private solvedToolbar: SolvedConstraintToolbarService;
  /** Bottom-center DOF pill for solved sketches (hidden for legacy). */
  private dofStatus: SketchDofStatus;
  /** Value input behind a dimension glyph's double-click (solved sketches). */
  private solvedDimensionEditor: SolvedDimensionEditor;
  private activeSketchInfo: {
    sketchObj: SceneObjectRender;
    plane: PlaneData;
    sourceLocation: { filePath: string; line: number; column: number };
  } | null = null;
  /** The sketch statement's post-edit line reported by the last solved
   * emission — used until the next render refreshes activeSketchInfo, so a
   * rapid drawing chain can't target a line that an added import shifted. */
  private solvedEmitSketchLine: number | null = null;
  private activeDrawingTool: SketchTool | null = null;
  /** Solver-driven drag (P4). */
  private activeSolvedDragHandler: SolvedDragHandler | null = null;
  private activeHoverSelectHandler: SketchHoverSelectHandler | null = null;
  private bezierHandles: BezierHandlesOverlay;
  private shortcuts: ShortcutManager;
  /** Sticky across tool changes: the coordinate pill is rebuilt per tool. */
  private relativeCoords = false;
  private opMessageToast: HTMLDivElement | null = null;
  private opMessageTimer: number | null = null;
  // Snap options, owned here; the sketch dialog's toggles write them via the
  // setters below (session-only state, deliberately not persisted).
  private snapToVertices = true;
  private snapToGrid = true;
  /** The sketch dialog's Auto-constraints toggle — whether solved-sketch
   * drawing infers constraints (snap coincidents, auto ortho H/V). Read live
   * by the tools through the solved context, so no push is needed. */
  private autoConstraints = true;
  /** Last-reported sketch-active state, so {@link onActiveChange} fires on edges only. */
  private lastActive = false;
  /**
   * Keep the sketch toolbar shown while a create-feature dialog launched from
   * this sketch is open. The dialog suspends sketch editing so the free 3D
   * view can be picked, which would normally hide the bar — pinning leaves the
   * sketch tools in place until the feature is applied (see {@link update}).
   */
  private keepToolbar = false;

  constructor(
    container: HTMLElement,
    viewer: Viewer,
    projectionService: ProjectionPickService,
    navbar: Navbar,
  ) {
    this.viewer = viewer;
    this.container = container;
    this.projectionService = projectionService;
    // An applied projection resumes lazily (its re-render is on the way); a
    // cancel arrives without options and resumes immediately. The exit is
    // explicit rather than left to the disarm below: while an edit session
    // runs, the hidden toolbar has dropped its active tool, so the disarm
    // would not find the tool armed.
    this.projectionService.onDone = (opts) => {
      this.projectionService.exit(opts);
      this.handleToolSelect(null);
    };
    this.projectionService.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);

    const sketchGroup = navbar.addGroup('sketch', { visible: false, exclusive: true });
    this.toolbar = new SketchToolbar(
      sketchGroup,
      (toolId) => this.handleToolSelect(toolId),
      (visible) => navbar.setGroupVisible('sketch', visible),
      () => this.handleGuidePress(),
    );

    this.shortcuts = new ShortcutManager();
    this.shortcuts.register('n', () => this.lookAlongSketchNormal());
    // While an armed tool's coordinate pill is up it takes the next printable
    // key to open itself, so both shortcut tries stand down — the pill is a
    // visible field, and coordinates are expressions, not just digits.
    const pillWantsKeys = () => this.activeDrawingTool?.wantsPrintableKeys() ?? false;
    this.shortcuts.suspendWhile = pillWantsKeys;
    this.toolbar.shortcutSuspend = pillWantsKeys;

    this.bezierHandles = new BezierHandlesOverlay(viewer.sceneContext);

    this.dofStatus = new SketchDofStatus(container, (loc) => gotoSource(loc));
    this.dofStatus.onVisibilityChange = (visible) => this.onDofPillVisibilityChange?.(visible);

    const opSelection: SketchOpSelection = {
      ids: () => [...(this.activeHoverSelectHandler?.selectedIds ?? [])],
      describe: (shapeId) => this.describeOpPick(shapeId),
      clear: () => this.activeHoverSelectHandler?.resetSelection(),
      deselect: (shapeId) => this.activeHoverSelectHandler?.deselectShape(shapeId),
      select: (shapeIds) => this.activeHoverSelectHandler?.selectShapes(shapeIds),
    };
    const opVars = () => this.fetchScopeVariables();
    const opDone = () => this.handleToolSelect(null);
    // One shared overlay for the op dialogs' live geometry — only one dialog
    // is ever open; offset and fillet draw into it.
    const opGhost = new FeatureGhostOverlay(viewer);
    const opService = (config: ConstructorParameters<typeof SketchOpService>[1]) =>
      new SketchOpService(container, config, opSelection, opVars, opDone, opGhost);
    // Constraint-native fillet (P8): the create path reads the solved picks
    // + model for the corner math and applies through the atomic
    // insert-solved rail (arc + coincident/tangent/radius rows, corner
    // coincidents removed). Bypasses the guide latch on purpose — a fillet
    // arc is real profile geometry.
    const filletRail: SolvedFilletRail = {
      picks: () => this.activeHoverSelectHandler?.getSolvedPicks() ?? [],
      model: () => this.activeSketchInfo
        ? buildSolvedSketchModel(this.activeSketchInfo.sketchObj, this.viewer.currentSceneObjects)
        : null,
      emit: async (request) => {
        const info = this.activeSketchInfo;
        if (!info) {
          return { success: false, reason: 'no active sketch' };
        }
        const result = await insertSolvedGeometry({
          sketchLine: this.solvedEmitSketchLine ?? info.sourceLocation.line,
          filePath: info.sourceLocation.filePath,
          geometry: request.geometry,
          constraints: request.constraints,
          ...(request.newVariables && request.newVariables.length > 0
            ? { newVariables: request.newVariables } : {}),
          ...(request.removals && request.removals.length > 0
            ? { removals: request.removals } : {}),
        });
        if (result.success && result.sketchLine !== undefined) {
          this.solvedEmitSketchLine = result.sketchLine;
        }
        return result;
      },
    };
    this.filletOp = new SketchOpService(container, {
      feature: 'fillet', title: 'Fillet', pickHint: 'Pick sketch edges to fillet',
      value: { label: 'Radius', defaultValue: '2', sign: 'positive' },
    }, opSelection, opVars, opDone, opGhost, filletRail);
    this.copyOp = new SketchCopyService(container, opSelection, opVars, opDone, opGhost);
    this.offsetOp = opService({
      feature: 'offset', title: 'Offset', pickHint: 'Pick sketch edges to offset',
      value: { label: 'Distance', defaultValue: '2', sign: 'nonzero' },
      toggles: [
        {
          key: 'close',
          label: 'Close ends',
          title: 'Cap an open offset back onto its original profile with two straight edges, '
            + 'making a closed loop (no-op on already-closed profiles)',
        },
      ],
    });
    // The rotate dialog's center comes from a picked sketch point — vertex
    // clicks land in its Center slot while edge clicks collect targets.
    this.rotateOp = new SketchOpService(container, {
      feature: 'rotate2d', title: 'Rotate', pickHint: 'Pick edges of the geometries to rotate',
      value: { label: 'Angle', defaultValue: '45', sign: 'nonzero' },
      centerSlot: {
        label: 'Center',
        prompt: 'Pick the center point — an endpoint, a center, or the origin',
      },
      toggles: [
        {
          key: 'copy',
          label: 'Copy',
          title: 'Keep the originals and add rotated copies',
        },
      ],
    }, opSelection, opVars, opDone, opGhost, undefined, {
      picks: () => this.activeHoverSelectHandler?.getSolvedPicks() ?? [],
      deselect: (pick) => this.activeHoverSelectHandler?.deselectSolvedPick(pick),
    });
    this.slotOp = opService({
      feature: 'slot', title: 'Slot', pickHint: '',
      draw: {
        hint: 'Draw the slot in the sketch: click the start point, then set the length and the cap radius. '
          + 'Near-horizontal and near-vertical slots snap to the axis — hold Ctrl for a free angle.',
        toggle: {
          label: 'Centered',
          title: 'Anchor the slot at its center instead of its first cap',
        },
      },
    });
    this.opServices = {
      fillet: this.filletOp,
      copy: this.copyOp,
      offset: this.offsetOp,
      rotate: this.rotateOp,
      slot: this.slotOp,
    };
    for (const service of Object.values(this.opServices)) {
      service.onVisibilityChange = (open) => this.onOpDialogToggle?.(open);
    }
    // Centered flips re-arm the drawing tool so the new anchor mode takes
    // effect immediately (the rectangle's toggle reselects the same way).
    this.slotOp.onDrawToggleChange = () => {
      if (this.activeDrawingTool) {
        this.activeDrawingTool.deactivate();
        this.activeDrawingTool = null;
        this.armSlotDrawTool();
      }
    };

    this.solvedToolbar = new SolvedConstraintToolbarService(
      container,
      viewer.sceneContext,
      (message) => this.showOpMessage(message),
      () => this.fetchScopeVariables(),
    );
    this.solvedDimensionEditor = new SolvedDimensionEditor(
      container,
      () => this.fetchScopeVariables(),
      () => this.activeSketchInfo?.sourceLocation.line ?? null,
    );

  }

  get hasActiveDrawingTool(): boolean {
    return this.activeDrawingTool !== null;
  }

  /** The op dialog (fillet, offset, copy) of the currently armed toolbar tool. */
  private activeOpService(): SketchOpDialog | undefined {
    const tool = this.toolbar.activeTool;
    return tool ? this.opServices[tool] : undefined;
  }

  /** The toolbar tool of an op dialog rewriting a statement in place, if any. */
  private editingOpTool(): ToolId | null {
    for (const [tool, service] of Object.entries(this.opServices)) {
      if (service.isEditing) {
        return tool as ToolId;
      }
    }
    return null;
  }

  /**
   * Open the offset dialog over the `offset()` statement at `target`
   * (timeline double-click). The gesture's breakpoint pauses the build just
   * BEFORE that statement — the sketch on its way in is the one the offset's
   * arguments see, without its result — and the render that brings it back
   * re-arms the toolbar and the picking handlers (see {@link update}).
   */
  enterOffsetEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'offset' }>,
    expectedStatement: string,
    opts: { insideSketch?: boolean } = {},
  ): void {
    const service = this.offsetOp;
    // Disarming leaves an armed tool cleanly — except when the dialog is
    // already editing: that path would cancel it, clearing the breakpoint the
    // new double-click just placed. Its own re-entry closes it instead.
    if (!service.isEditing) {
      this.handleToolSelect(null);
    }
    this.toolbar.setActiveTool('offset');
    // A face offset outside a sketch takes no close chain (the kernel
    // refuses it) — that row hides for this opening.
    service.enterEdit(target, parsed, expectedStatement, {
      hideToggles: opts.insideSketch === false ? ['close'] : [],
    });
    if (this.activeSketchInfo) {
      service.noteSketchActive();
      this.activateDragHandler();
    }
  }

  /**
   * Open the fillet dialog over the 2D `fillet()` statement at `target`
   * (timeline double-click) — the same pause-before contract as the offset
   * edit: the sketch on screen is the one the fillet's arguments see, its
   * corner arcs absent and the original corner edges re-pickable.
   */
  enterFilletEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'fillet' }>,
    expectedStatement: string,
  ): void {
    const service = this.filletOp;
    // Same contract as the offset edit: never disarm an already-editing
    // dialog here — that would cancel it and clear the fresh breakpoint.
    if (!service.isEditing) {
      this.handleToolSelect(null);
    }
    this.toolbar.setActiveTool('fillet');
    service.enterEdit(target, parsed, expectedStatement);
    if (this.activeSketchInfo) {
      service.noteSketchActive();
      this.activateDragHandler();
    }
  }

  /**
   * Open the copy dialog over the 2D `copy()` statement at `target`
   * (timeline double-click) — the same pause-before contract as the offset
   * edit: the sketch on screen is the one the copy's arguments see, the
   * originals visible and re-pickable, their copies absent.
   */
  enterCopyEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'copy' }>,
    expectedStatement: string,
  ): void {
    const service = this.copyOp;
    // Same contract as the offset edit: never disarm an already-editing
    // dialog here — that would cancel it and clear the fresh breakpoint.
    if (!service.isEditing) {
      this.handleToolSelect(null);
    }
    this.toolbar.setActiveTool('copy');
    service.enterEdit(target, parsed, expectedStatement);
    if (this.activeSketchInfo) {
      service.noteSketchActive();
      this.activateDragHandler();
    }
  }

  /**
   * Open the projection dialog over the `project()` statement at `target`
   * (timeline double-click). The projection service's edit session rolls the
   * viewport back to just before that row (the fillet/chamfer edit pattern);
   * while it runs, sketch editing stays suspended and this service receives
   * empty scene lists, so the toolbar steps aside.
   */
  enterProjectionEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'project' }>,
    info: { index: number; type: string; expectedStatement: string },
  ): void {
    // Same contract as the offset edit: never disarm an already-editing
    // dialog here — that path would cancel it and clear the breakpoint the
    // new double-click just placed. Its own re-entry closes it instead.
    if (!this.projectionService.isEditing) {
      this.handleToolSelect(null);
    }
    // 3D picking owns the viewport while the tool is armed — the sketch
    // drag/hover handlers a sketch-mode entry left active would fight it
    // (create mode tears them down in handleToolSelect the same way).
    this.deactivateDragHandler();
    this.toolbar.setActiveTool('project');
    this.projectionService.enterEdit(target, parsed, info);
  }

  /** The sketch dialog's snap-to-vertices toggle; live tools follow along. */
  setSnapToVertices(checked: boolean): void {
    this.snapToVertices = checked;
    if (this.activeDrawingTool) {
      this.activeDrawingTool['snapController'].snapToVertices = checked;
    }
    if (this.activeSolvedDragHandler) {
      this.activeSolvedDragHandler['snapController'].snapToVertices = checked;
    }
  }

  /** The sketch dialog's snap-to-grid toggle; live tools follow along. */
  setSnapToGrid(checked: boolean): void {
    this.snapToGrid = checked;
    if (this.activeDrawingTool) {
      this.activeDrawingTool['snapController'].snapToGrid = checked;
    }
    if (this.activeSolvedDragHandler) {
      this.activeSolvedDragHandler['snapController'].snapToGrid = checked;
    }
  }

  /** The sketch dialog's Auto-constraints toggle. Tools read the flag live
   * through their solved context, so there is nothing to push. */
  setAutoConstraints(checked: boolean): void {
    this.autoConstraints = checked;
  }

  /**
   * Pin (or release) the sketch toolbar while a create-feature dialog launched
   * from this sketch is open. main.ts derives this from the dialogs' own
   * suspend state and pushes it in before feeding the suspended (empty) scene.
   */
  setKeepToolbar(keep: boolean): void {
    this.keepToolbar = keep;
  }

  update(sceneObjects: SceneObjectRender[]): void {
    const lastRoot = findActiveObject(sceneObjects) ?? null;

    if (lastRoot?.type === 'sketch' && lastRoot.id && lastRoot.object?.plane && lastRoot.sourceLocation) {
      const plane: PlaneData = lastRoot.object.plane;
      const prevSketchId = this.activeSketchInfo?.sketchObj.id;
      // Solved sketches are container-atomic in the render cache (P2): every
      // emission rebuilds the whole subtree and mints a NEW sketch id, so id
      // equality would tear down the drawing tool mid-chain. The statement
      // identity is the file + line — with the line tracked through the
      // emission's own shift report (an added import moves the statement).
      const prevLoc = this.activeSketchInfo?.sourceLocation;
      const sameSolvedStatement = isSolvedSketch(lastRoot)
        && prevLoc?.filePath === lastRoot.sourceLocation.filePath
        && (this.solvedEmitSketchLine ?? prevLoc?.line) === lastRoot.sourceLocation.line;
      const sameSketch = prevSketchId === lastRoot.id || sameSolvedStatement;
      this.activeSketchInfo = {
        sketchObj: lastRoot,
        plane,
        sourceLocation: lastRoot.sourceLocation,
      };
      // The fresh payload's sourceLocation is authoritative again.
      this.solvedEmitSketchLine = null;

      if (!this.toolbar.isVisible) {
        this.toolbar.show();
        this.shortcuts.enable();
      }
      this.solvedToolbar.show();

      this.bezierHandles.activate();
      this.bezierHandles.update(sceneObjects, lastRoot.id, plane);

      // The sketch an edit dialog was opened over has arrived: re-arm its
      // toolbar button (the bar's own hide() dropped it while the breakpoint
      // render was in flight) so the picking handlers below come back with it.
      const editingTool = this.editingOpTool();
      if (editingTool) {
        this.opServices[editingTool]!.noteSketchActive();
        this.toolbar.setActiveTool(editingTool);
      }

      if (this.activeDrawingTool) {
        if (!sameSketch) {
          this.handleToolSelect(this.toolbar.activeTool);
        } else {
          this.activeDrawingTool.updatePlane(plane);
          this.activeDrawingTool.onSceneUpdate(sceneObjects, lastRoot.id);
        }
      } else if (this.activeSolvedDragHandler) {
        const dragHandler = this.activeSolvedDragHandler;
        dragHandler.updatePlane(plane);
        const snapManager = SnapManager.fromSceneObjects(sceneObjects, lastRoot.id, plane, this.viewer.sceneContext);
        const snapCtrl = new SnapController(snapManager, plane);
        snapCtrl.snapToVertices = this.snapToVertices;
        snapCtrl.snapToGrid = this.snapToGrid;
        dragHandler.updateSnapController(snapCtrl);
        dragHandler.updateSceneData(sceneObjects, lastRoot.id);
        if (this.activeHoverSelectHandler) {
          this.activeHoverSelectHandler.updatePlane(plane);
          this.activeHoverSelectHandler.updateSceneData(sceneObjects, lastRoot.id);
        }
        // A re-render may have pruned selected edges — keep the preview honest.
        this.activeOpService()?.refresh();
      } else if (this.activeOpService()?.isDrawDialog) {
        // The slot dialog owns the viewport through the classic drawing
        // tool — restore it, not the pick handlers.
        this.armSlotDrawTool();
      } else if (!this.toolbar.activeTool || this.activeOpService()) {
        // The op dialogs pick with the drag/hover handlers — an armed one
        // (or one that just regained its sketch) gets them back.
        this.activateDragHandler();
      }

      // After the handlers have digested the new scene (ids change every
      // render): refresh the constraint bar. No selection exists while a
      // drawing tool is armed.
      this.solvedToolbar.sketchUpdated(
        sceneObjects,
        lastRoot,
        this.activeDrawingTool ? null : this.activeHoverSelectHandler,
      );

      this.dofStatus.update(computeSketchDofState(buildSolvedSketchModel(lastRoot, sceneObjects)));
    } else {
      if (this.activeDrawingTool) {
        this.activeDrawingTool.deactivate();
        this.activeDrawingTool = null;
      }
      for (const service of Object.values(this.opServices)) {
        // An edit dialog opens before its sketch renders — the double-click's
        // breakpoint edit is still in flight — so the sketch-less scene it
        // opened over must not fold it away. Once that sketch has arrived,
        // losing it again closes the dialog like any other.
        if (service.isActive && !service.isAwaitingSketch) {
          service.exit();
          this.toolbar.setActiveTool(null);
        }
      }
      if (this.projectionService.isPicking && !this.projectionService.isEditing) {
        // The sketch it was projecting into is gone — or another dialog took
        // the viewport. Either way the caller owns the view now, so sketch
        // editing comes back lazily instead of forcing a render here. An
        // edit dialog is exempt: its session owns the (rolled-back) view and
        // handles its statement's disappearance itself.
        this.projectionService.exit({ resume: 'lazy' });
        this.toolbar.setActiveTool(null);
      }
      this.deactivateDragHandler();
      this.bezierHandles.deactivate();
      this.solvedToolbar.hide();
      this.solvedDimensionEditor.hide();
      this.dofStatus.update({ result: 'hidden' });
      this.activeSketchInfo = null;
      this.solvedEmitSketchLine = null;
      if (this.keepToolbar) {
        // A create-feature dialog launched from this sketch has suspended
        // editing to pick in the free 3D view — keep (or restore, when a
        // switch between dialogs briefly dropped it) the bar on the sketch
        // tools until the feature is applied. keepToolbar is only set while
        // one of those dialogs is armed-and-suspended, which only happens
        // from an active sketch, so re-showing here can't be spurious. Drop
        // any armed tool so none looks active while the dialog owns the view.
        if (!this.toolbar.isVisible) {
          this.toolbar.show();
          this.shortcuts.enable();
        }
        this.toolbar.setActiveTool(null);
      } else {
        this.toolbar.hide();
        this.shortcuts.disable();
      }
    }

    const active = this.activeSketchInfo !== null || this.keepToolbar;
    if (active !== this.lastActive) {
      this.lastActive = active;
      this.onActiveChange?.(active);
    }
  }

  /**
   * Chip content for a picked sketch shape: its owning entity's timeline name
   * and the source line of the statement that drew it (the chip's jump badge).
   */
  private describeOpPick(shapeId: string): SketchPickDescription {
    const owner = this.viewer.currentSceneObjects.find(obj =>
      obj.sceneShapes?.some(shape => shape.shapeId === shapeId));
    const location = owner?.sourceLocation;
    return {
      label: owner?.name || 'Edge',
      line: location?.line,
      goTo: location ? () => gotoSource(location) : undefined,
    };
  }

  private async fetchScopeVariables(): Promise<VariableInfo[]> {
    if (!this.activeSketchInfo) {
      return [];
    }
    return getScopeVariables(this.activeSketchInfo.sourceLocation.line);
  }

  /**
   * Append `.guide()` to a statement drawn while the Guide latch is on. A
   * multi-line emission (`move(...)\nline(...)`, the text tool's
   * `move(...);\ntext(...)`) suffixes only its last line — the geometry
   * call; the leading cursor move is not geometry.
   */
  private withGuideSuffix(statement: string): string {
    if (!this.toolbar.guideModeChecked || statement.includes('.guide(')) {
      return statement;
    }
    const nl = statement.lastIndexOf('\n');
    const head = nl === -1 ? '' : statement.slice(0, nl + 1);
    let tail = nl === -1 ? statement : statement.slice(nl + 1);
    const semi = tail.endsWith(';');
    if (semi) {
      tail = tail.slice(0, -1);
    }
    return `${head}${tail}.guide()${semi ? ';' : ''}`;
  }

  /**
   * The Guide button (or `g`). With edges selected it is a one-shot converter:
   * each selected statement's guide state flips — real geometry gains
   * `.guide()`, construction geometry loses it — one splice per statement (a
   * rect is many edges but one line), fanned out through the same code-edit
   * rail as `.pick()`. The latch is untouched, so un-guiding never silently
   * arms construction mode. Without a selection it flips the latch.
   */
  private handleGuidePress(): void {
    if (this.keepToolbar && !this.activeSketchInfo) {
      return;
    }
    const ids = [...(this.activeHoverSelectHandler?.selectedIds ?? [])];
    if (ids.length === 0 || !this.activeSketchInfo) {
      this.toolbar.setGuideMode(!this.toolbar.guideModeChecked);
      return;
    }
    const seen = new Set<string>();
    for (const shapeId of ids) {
      const owner = this.viewer.currentSceneObjects.find(obj =>
        obj.sceneShapes?.some(shape => shape.shapeId === shapeId));
      const location = owner?.sourceLocation;
      if (!location) {
        continue;
      }
      const key = `${location.filePath}:${location.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const shape = owner!.sceneShapes.find(s => s.shapeId === shapeId);
      if (shape?.isGuide) {
        removeGuide(location);
      } else {
        addGuide(location);
      }
    }
  }

  private createTool(
    toolId: ToolId,
    plane: PlaneData,
    sceneObjects: SceneObjectRender[],
    sketchId: string,
  ): SketchTool | null {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, plane, this.viewer.sceneContext);
    const snapCtrl = new SnapController(snapManager, plane);
    snapCtrl.snapToVertices = this.snapToVertices;
    snapCtrl.snapToGrid = this.snapToGrid;

    const doInsertGeometry = (
      statement: string,
      newVariable?: { name: string; initializer: string } | { name: string; initializer: string }[],
    ) => {
      if (!this.activeSketchInfo) {
        return;
      }
      insertGeometry(this.withGuideSuffix(statement), this.activeSketchInfo.sourceLocation, newVariable);
    };

    const fetchVars = () => this.fetchScopeVariables();

    // Solved sketches (P5): tools emit fully-specified primitives + explicit
    // constraints through the atomic insert-solved rail. The guide latch is
    // applied here (per geometry entry — never to a constraint, which the
    // legacy last-line withGuideSuffix would decorate).
    const solved = this.activeSketchInfo && isSolvedSketch(this.activeSketchInfo.sketchObj);
    const solvedCtx: SolvedToolContext | null = solved
      ? {
        emit: async (request) => {
          const info = this.activeSketchInfo;
          if (!info) {
            return { success: false, reason: 'no active sketch' };
          }
          const result = await insertSolvedGeometry({
            // Emissions can outpace the render: an added import shifts the
            // sketch statement, and the route reports where it landed. The
            // override is cleared by every fresh payload (update()).
            sketchLine: this.solvedEmitSketchLine ?? info.sourceLocation.line,
            filePath: info.sourceLocation.filePath,
            geometry: this.toolbar.guideModeChecked
              ? request.geometry.map(g => ({ ...g, guide: true }))
              : request.geometry,
            constraints: request.constraints,
            ...(request.newVariables && request.newVariables.length > 0
              ? { newVariables: request.newVariables } : {}),
            ...(request.removals && request.removals.length > 0
              ? { removals: request.removals } : {}),
          });
          if (!result.success) {
            this.showOpMessage(result.reason ?? 'the sketch edit was refused');
          } else if (result.sketchLine !== undefined) {
            this.solvedEmitSketchLine = result.sketchLine;
          }
          return result;
        },
        autoConstraints: () => this.autoConstraints,
      }
      : null;

    // bezier and text create through the LEGACY insert rail on purpose: their
    // statements are anchor-point statements (P8), not solved emission
    // entities — insertGeometryCall places text in the derived-ops tail and
    // bezier in the geometry region, and both are solver-backed after the
    // re-render (draggable anchors, constraint targets).
    const applySolvedContext = (tool: SketchTool | null): SketchTool | null => {
      tool?.setSolvedContext(solvedCtx);
      return tool;
    };

    switch (toolId) {
      case 'line': {
        const tool = applySolvedContext(new LineTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars))!;
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'circle':
        return applySolvedContext(new CircleTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars));
      case 'polygon':
        return applySolvedContext(new PolygonTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars));
      case 'arc2':
        return applySolvedContext(new CenterArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars));
      case 'arc3': {
        const tool = applySolvedContext(new ThreePointArcTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars))!;
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'polyline': {
        const tool = applySolvedContext(new PolylineTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars))!;
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'bezier': {
        // The statement grows through the legacy insert rail, but snapped
        // poles auto-constrain through the solved rail (coincident on
        // bz.point(i)) — the tool needs the emission context for that.
        const tool = applySolvedContext(new BezierTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars))!;
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      case 'rect':
        return applySolvedContext(new RectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars, this.toolbar.rectCenteredChecked));
      case 'rounded-rect':
        return applySolvedContext(new RoundedRectTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars, this.toolbar.rectCenteredChecked));
      case 'slot':
        return applySolvedContext(new SlotTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container, fetchVars, this.slotOp.drawToggleChecked));
      case 'text': {
        const tool = new TextTool(this.viewer.sceneContext, plane, snapCtrl, doInsertGeometry, this.container,
          () => this.handleToolSelect(null));
        // Seed the path-pick index — without a scene re-render during the
        // dialog session, onSceneUpdate would otherwise never fire.
        tool.onSceneUpdate(sceneObjects, sketchId);
        return tool;
      }
      default:
        return null;
    }
  }

  /** A dimension glyph was double-clicked: resolve the constraint statement
   * in the current model and open its value input (P4). */
  private openSolvedDimensionEditor(pick: { objId?: string; clientX: number; clientY: number }): void {
    if (!this.activeSketchInfo || !pick.objId) {
      return;
    }
    const model = buildSolvedSketchModel(this.activeSketchInfo.sketchObj, this.viewer.currentSceneObjects);
    const constraint = model?.constraints.find(c => c.obj.id === pick.objId);
    if (constraint && SolvedDimensionEditor.isDimensional(constraint)) {
      this.solvedDimensionEditor.refreshVariables();
      this.solvedDimensionEditor.show(constraint, pick.clientX, pick.clientY);
    }
  }

  private activateDragHandler(): void {
    if (this.activeSolvedDragHandler || !this.activeSketchInfo) {
      return;
    }
    const snapManager = SnapManager.fromSceneObjects(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!, this.activeSketchInfo.plane, this.viewer.sceneContext);
    const snapCtrl = new SnapController(snapManager, this.activeSketchInfo.plane);
    snapCtrl.snapToVertices = this.snapToVertices;
    snapCtrl.snapToGrid = this.snapToGrid;
    this.activeSolvedDragHandler = new SolvedDragHandler(
      this.viewer.sceneContext,
      this.activeSketchInfo.plane,
      snapCtrl,
      (x, y) => this.activeHoverSelectHandler?.hasBadgeAt(x, y) ?? false,
      (message) => this.showOpMessage(message),
    );
    this.activeSolvedDragHandler.updateSceneData(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    this.activeSolvedDragHandler.activate();

    this.activeHoverSelectHandler = new SketchHoverSelectHandler(
      this.viewer.sceneContext,
      this.activeSketchInfo.plane,
      () => this.activeSolvedDragHandler?.isResizing ?? false,
      // The copy, fillet and rotate dialogs' picks accumulate like the 3D
      // dialogs': every click toggles a target in or out and an empty-space
      // click keeps the list — a multi-pick dialog's set must not vanish
      // under a stray click (a fillet routinely wants several edges, and
      // rotate's center vertex click must not clear its targets). The armed
      // two-pick dimension tool accumulates the same way (its second plain
      // click must not replace the first pick). The remaining single-value
      // ops keep the classic replace-and-clear rails.
      () => (this.toolbar.activeTool === 'copy' || this.toolbar.activeTool === 'fillet'
        || this.toolbar.activeTool === 'rotate'
        || this.solvedToolbar.isDimensionArmed
        ? 'toggle' : 'replace'),
    );
    this.activeHoverSelectHandler.onSelectionChange = () => {
      this.activeOpService()?.refresh();
      this.solvedToolbar.selectionChanged(this.activeHoverSelectHandler);
    };
    this.activeHoverSelectHandler.onConstraintPick = (pick) => {
      if (pick.sourceLocation) {
        gotoSource(pick.sourceLocation);
      }
      this.solvedToolbar.noteConstraintPick(pick);
      this.onConstraintPick?.(pick);
    };
    this.activeHoverSelectHandler.onConstraintDoubleClick = (pick) => {
      this.openSolvedDimensionEditor(pick);
    };
    this.activeHoverSelectHandler.updateSceneData(this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    this.activeHoverSelectHandler.activate();
  }

  private deactivateDragHandler(): void {
    if (this.activeHoverSelectHandler) {
      this.activeHoverSelectHandler.deactivate();
      this.activeHoverSelectHandler = null;
    }
    if (this.activeSolvedDragHandler) {
      this.activeSolvedDragHandler.deactivate();
      this.activeSolvedDragHandler = null;
    }
  }

  private handleToolSelect(toolId: ToolId | null): void {
    // While a create-feature dialog has the toolbar pinned, sketch editing is
    // suspended and there is no active sketch — the tools are shown but inert.
    if (this.keepToolbar && !this.activeSketchInfo) {
      return;
    }
    if (!toolId && this.activeDrawingTool?.handleEscape?.()) {
      return;
    }
    // First Escape in a solved sketch closes the dimension value input or
    // disarms the two-pick dimension tool before anything else folds.
    if (!toolId && this.solvedToolbar.handleEscape()) {
      return;
    }

    if (this.activeDrawingTool) {
      this.activeDrawingTool.deactivate();
      this.activeDrawingTool = null;
    }

    if (this.toolbar.activeTool === 'project' && toolId !== 'project') {
      this.projectionService.exit();
    }
    const previousOp = this.toolbar.activeTool ? this.opServices[this.toolbar.activeTool] : undefined;
    if (previousOp && this.toolbar.activeTool !== toolId) {
      previousOp.exit();
    }

    this.toolbar.setActiveTool(toolId);

    if (!toolId || !this.activeSketchInfo) {
      if (!toolId && this.activeSketchInfo) {
        this.activateDragHandler();
      }
      return;
    }

    // The op dialogs (fillet, offset) keep the drag/hover handlers active —
    // picking IS the input. The slot dialog is a draw-options dialog: the
    // classic drawing tool owns the viewport instead.
    const opService = this.opServices[toolId];
    if (opService) {
      if (opService.isDrawDialog) {
        opService.enter();
        this.armSlotDrawTool();
      } else {
        this.activateDragHandler();
        opService.enter();
      }
      return;
    }

    this.deactivateDragHandler();

    // Project picks solid edges and faces, so it leaves sketch editing (the
    // camera unlocks from the sketch normal) while keeping this sketch as the
    // statement's destination.
    if (toolId === 'project') {
      this.projectionService.enter(this.activeSketchInfo.sourceLocation);
      return;
    }

    const tool = this.createTool(toolId, this.activeSketchInfo.plane, this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!);
    if (!tool) {
      // A tool unavailable in this sketch mode (bezier/text in a solved
      // sketch) — don't leave its button stuck armed with no tool behind it.
      this.toolbar.setActiveTool(null);
      this.activateDragHandler();
      return;
    }

    tool.setRelativeMode(this.relativeCoords);
    tool.onRelativeModeChange = (relative) => { this.relativeCoords = relative; };
    tool.activate();
    this.activeDrawingTool = tool;
  }

  /**
   * Hand the viewport to the slot dialog's drawing tool (the dialog keeps
   * showing its hint and options).
   */
  private armSlotDrawTool(): void {
    if (!this.activeSketchInfo) {
      return;
    }
    this.deactivateDragHandler();
    if (this.activeDrawingTool) {
      return;
    }
    const tool = this.createTool(
      'slot', this.activeSketchInfo.plane, this.viewer.currentSceneObjects, this.activeSketchInfo.sketchObj.id!,
    );
    if (!tool) {
      return;
    }
    tool.setRelativeMode(this.relativeCoords);
    tool.onRelativeModeChange = (relative) => { this.relativeCoords = relative; };
    tool.activate();
    this.activeDrawingTool = tool;
  }

  /** Transient toast under the navbar (mirrors main.ts's edit-refusal toast). */
  private showOpMessage(message: string): void {
    if (!this.opMessageToast) {
      this.opMessageToast = document.createElement('div');
      // Below the constraint mini bar (top-[106px]) so refusals don't cover it.
      this.opMessageToast.className = 'absolute top-[152px] left-[calc(50%+var(--fluidcad-editor-width,0px)/2)] -translate-x-1/2 z-[1003] max-w-[440px] '
        + 'bg-base-100 border border-base-300 text-base-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
      this.container.appendChild(this.opMessageToast);
    }
    this.opMessageToast.textContent = message;
    this.opMessageToast.classList.remove('hidden');
    if (this.opMessageTimer !== null) {
      window.clearTimeout(this.opMessageTimer);
    }
    this.opMessageTimer = window.setTimeout(() => {
      this.opMessageTimer = null;
      this.opMessageToast?.classList.add('hidden');
    }, 4000);
  }

  private lookAlongSketchNormal(): void {
    if (this.activeSketchInfo) {
      this.viewer.lookAlongSketchNormal(this.activeSketchInfo.plane);
    }
  }
}
