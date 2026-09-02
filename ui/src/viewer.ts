import { Box3, BufferAttribute, BufferGeometry, Color, Group, Intersection, LineSegments, Material, Mesh, MeshPhongMaterial, Object3D, Raycaster, Vector3 } from 'three';
import { FIT_PADDING, SceneContext } from './scene/scene-context';
import { DialogViewOffset } from './scene/dialog-view-offset';
import { SceneModeManager, sketchCameraDistance } from './scene/scene-mode';
import { worldFromMm } from './units/scene-scale';
import { sceneUnit } from './units/scene-unit';
import { GridScaleBar } from './ui/grid-scale-bar';
import { buildSceneMesh } from './meshes/mesh-factory';
import type { SketchMesh } from './meshes/containers/sketch-mesh';
import { PlaneData, SceneObjectPart, SceneObjectRender, SerializedAssembly, SerializedAssemblyMate, SubSelection } from './types';
import { AssemblyController, DragValueHandler, InstanceDragReleaseHandler, SolverUpdateHandler } from './scene/assembly-controller';
import { FaceMesh } from './meshes/shape-meshes/face-mesh';
import { EdgeMesh } from './meshes/shape-meshes/edge-mesh';
import { SettingsPanel } from './ui/settings-panel';
import type { EngineClient } from './engine-client';
import { CentroidIndicator } from './scene/centroid-indicator';
import { viewerSettings } from './scene/viewer-settings';
import { themeColors } from './scene/theme-colors';
import { StandardPlaneId, StandardPlanes } from './scene/standard-planes';
import { SectionClipper } from './scene/section-clipper';
import { collectPickCandidates } from './interactive/pick-candidates';
import { captureScreenshot } from './screenshot';
import { findActiveObject, isSceneEmpty } from './helpers/scene-utils';

/** Recursively expand `box` to include `object`, skipping meta-shape subtrees. */
function expandBoxExcludingMeta(box: Box3, object: Object3D): void {
  if (object.userData.isMetaShape) return;
  const o = object as any;
  if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
    o.geometry.computeBoundingBox();
    if (o.geometry.boundingBox) {
      box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
    }
  }
  for (const child of object.children) {
    expandBoxExcludingMeta(box, child);
  }
}

/**
 * Keep only parts referenced by some `inst.partId` and the entire subtree
 * under each kept part. An assembly file declares every part it might use
 * (typically via factory functions like `getExtrusion(...)`), but only the
 * ones passed to `insert(...)` should appear in the viewport. Filtering
 * here means a `rebuildSceneMesh()` triggered by theme/region-pick can't
 * materialize an un-inserted part at world origin.
 */
function filterToReferencedParts(
  sceneObjects: SceneObjectRender[],
  instances: SerializedAssembly['instances'],
): SceneObjectRender[] {
  const referencedPartIds = new Set(instances.map(i => i.partId));
  const childrenByParent = new Map<string, SceneObjectRender[]>();
  for (const obj of sceneObjects) {
    if (!obj.parentId) continue;
    const list = childrenByParent.get(obj.parentId);
    if (list) list.push(obj);
    else childrenByParent.set(obj.parentId, [obj]);
  }
  const keep = new Set<string>();
  const stack: SceneObjectRender[] = [];
  for (const obj of sceneObjects) {
    if (obj.type === 'part' && obj.id && referencedPartIds.has(obj.id)) {
      stack.push(obj);
    }
  }
  while (stack.length > 0) {
    const obj = stack.pop()!;
    if (!obj.id || keep.has(obj.id)) continue;
    keep.add(obj.id);
    const children = childrenByParent.get(obj.id);
    if (children) stack.push(...children);
  }
  return sceneObjects.filter(obj => obj.id && keep.has(obj.id));
}

const HIGHLIGHT_EDGE_LINE_WIDTH = 2;
/** Gizmo enlargement for a timeline "show connector" — bigger than the assembly hover feedback (1.35) so it reads at a glance. */
const CONNECTOR_SHOW_SCALE = 2;
const HOVER_EDGE_LINE_WIDTH = 2;
// Sketch wires already render at width 2 — a selected sketch needs the extra
// width on top of the highlight color to stand out from its neighbors.
const HIGHLIGHT_SKETCH_WIRE_LINE_WIDTH = 3;

export type SelectionModifiers = { additive: boolean };

/** What pickAt() resolves: a sub-shape (with its owning assembly instance,
 *  when the hit landed inside one), or a shown origin plane. */
type PickResult =
  | { shapeId: string; sub: SubSelection; instanceId?: string | null }
  | { standardPlane: StandardPlaneId };

function isPlanePick(result: PickResult | null): result is { standardPlane: StandardPlaneId } {
  return result !== null && 'standardPlane' in result;
}

// Sketch-wire, axis, plane and connector picks route a dialog action and are
// never held as a selection.
export type SelectedEntity = {
  shapeId: string;
  sub: Exclude<
    NonNullable<SubSelection>,
    { type: 'sketch' } | { type: 'axis' } | { type: 'plane' } | { type: 'connector' }
  >;
};

/**
 * The section-view toggle the viewer drives — implemented by the sketch dialog,
 * the only place section view is offered (it clips at the sketch plane).
 */
export interface SectionViewControl {
  setVisible(visible: boolean): void;
  setActive(active: boolean): void;
}

// How much to blend non-sketch object colors toward the scene background while
// sketch mode is active. Higher = more faded. Opaque tint avoids the three.js
// transparency sort/overdraw cost on complex scenes.
const SKETCH_GHOST_TINT_FACTOR = 0.75;


/**
 *  - SceneContext      — scene, camera, renderer, controls
 *  - SceneModeManager  — default / sketch mode transitions
 *  - buildSceneMesh    — object-type → mesh factory
 */
export class Viewer {
  private ctx: SceneContext;
  private modeManager: SceneModeManager;
  private settingsPanel: SettingsPanel;
  private gridScaleBar: GridScaleBar;
  private sceneObjects: SceneObjectRender[] = [];
  private highlightedShapeId: string | null = null;
  private highlightedSolidShapeIds: string[] = [];
  private highlightedSketchWires: string[] = [];
  private highlightedPlaneQuads: string[] = [];
  /** Part-view connector gizmo enlarged by highlightConnector (timeline "show"). */
  private highlightedConnectorId: string | null = null;
  /** Overlay groups built by highlightDetachedShapes — disposed on clearHighlight. */
  private detachedHighlightGroups: Group[] = [];
  private faceHighlightMeshes: Mesh[] = [];
  private hasRendered = false;
  private lastFitBox: Box3 | null = null;
  isRegionPicking = false;
  isDrawing = false;
  /**
   * Restricts what pickAt() returns while a pick mode is active (e.g. edge-only
   * for fillet/chamfer). Faces still participate in occlusion testing so edges
   * hidden behind the solid don't become pickable — they just can't be *hit*.
   * `none` turns solid picking off entirely while the independent channels
   * (`pickSketchWires`, `pickAxes`) stay live — the revolve dialog's
   * profile-armed mode, where only sketch wires may be picked.
   */
  pickFilter: 'all' | 'edge' | 'face' | 'none' = 'all';
  /**
   * Makes sketch wires pickable, independent of `pickFilter` — the armed
   * create dialogs (extrude/sweep/loft) enable it so clicking a sketch's
   * geometry selects that sketch as an input. A hit returns the wire's
   * shapeId with `sub.type === 'sketch'`; the owning sketch is resolved by
   * the consumer.
   */
  pickSketchWires = false;
  /**
   * Opt-in: top-level offset outlines resolve as profile picks (the extrude
   * dialog). Separate from `pickSketchWires` so the other wire-arming dialogs
   * (sweep, loft) keep offset edges pickable as plain edges.
   */
  pickProfileWires = false;
  /**
   * Makes axis lines (the dashed `axis(…)` guides) pickable, independent of
   * `pickFilter` — the armed revolve dialog enables it so clicking an axis
   * selects it as the revolve axis. A hit returns the line's shapeId with
   * `sub.type === 'axis'`; the owning axis object is resolved by the
   * consumer.
   */
  pickAxes = false;
  /**
   * Makes construction-plane quads (the translucent `plane(…)` faces)
   * pickable, independent of `pickFilter` — the armed sketch mode enables it
   * so clicking a plane sketches on it. A hit returns the quad's shapeId with
   * `sub.type === 'plane'`; the owning plane object is resolved by the
   * consumer.
   */
  pickPlanes = false;
  /**
   * Makes assembly mate-connector gizmos pickable, independent of
   * `pickFilter` — an armed mate dialog enables it. Connector hits resolve
   * by screen distance through the assembly controller (the gizmos render
   * depth-test-off on top of everything) and outrank every raycast channel.
   * A hit returns the connector scene object's id with
   * `sub.type === 'connector'` plus the owning instance id.
   */
  pickConnectors = false;

  private selectionHandler: ((shapeId: string | null, sub: SubSelection, instanceId: string | null, modifiers: SelectionModifiers) => void) | null = null;
  private hoverHandler: ((shapeId: string | null, sub: SubSelection, clientX: number, clientY: number) => void) | null = null;
  private contextMenuHandler: ((shapeId: string | null, sub: SubSelection, clientX: number, clientY: number) => void) | null = null;
  private doubleClickHandler: ((shapeId: string | null, sub: SubSelection) => void) | null = null;
  private centroidIndicator = new CentroidIndicator();
  private hoverState: { shapeId: string; sub: SubSelection; instanceId: string | null } | null = null;
  private hoverFaceOverlayMeshes: Mesh[] = [];
  /**
   * Identifies the assembly instance whose geometry was last selected. Stored
   * as an id (not a Group reference) so it stays valid across diff updates
   * that may replace the underlying Three.js objects. Null in part-design
   * scenes and when nothing is selected.
   */
  private highlightedInstanceId: string | null = null;
  private hoverRafId: number | null = null;
  private isMouseDown = false;
  /**
   * After a drag-release inside the assembly controller, the cursor sits
   * on the just-dropped part. We don't want hover to instantly re-paint
   * its face. Track the dropped instance id and suppress hover that lands
   * on it; clear the suppression as soon as the cursor moves to a
   * different instance or to empty space (i.e. the user "let go" of the
   * part with their cursor too).
   */
  private hoverSuppressForInstance: string | null = null;
  private standardPlanes = new StandardPlanes();
  private standardPlanePickHandler: ((plane: StandardPlaneId) => void) | null = null;
  private highlightedEntities: SelectedEntity[] = [];
  private activeSketchId: string | null = null;
  private sectionViewControl: SectionViewControl | null = null;
  /** The last render's rollback flags — replayed by a self-healing resume. */
  private lastRenderIsRollback = false;
  private lastRenderStop: number | undefined;
  /**
   * A dialog holds sketch editing suspended ({@link suspendSketchEditing}).
   * Tracked here rather than read back off the mode manager: region picking
   * flips `sketchEnabled` for its own reasons on every render, so the flag
   * doesn't say who suspended what.
   */
  private sketchEditingSuspended = false;
  /** A render landed while sketch editing was suspended — see {@link missedSketchRender}. */
  private renderedWhileSuspended = false;
  private readonly sectionClipper = new SectionClipper();
  private hiddenShapeIds = new Set<string>();
  private shapeOpacities = new Map<string, number>();
  private assemblyController: AssemblyController | null = null;
  /**
   * Generic gesture-ownership hooks for overlay tools (the transform
   * gizmo). `clickInterceptor` runs first in the mouseup-as-click handler:
   * returning true swallows the click entirely — the tool already managed
   * its own state and a selection pass would fight it. `hoverSuppressor`
   * gates {@link updateHover} the same way `isDragGestureActive` does,
   * so hover overlays never paint under a pointer that sits on a tool
   * handle.
   */
  private clickInterceptor: (() => boolean) | null = null;
  private hoverSuppressor: (() => boolean) | null = null;
  private pendingDragReleaseHandler: InstanceDragReleaseHandler | null = null;
  private pendingSolverUpdateHandler: SolverUpdateHandler | null = null;
  private pendingDragValueHandler: DragValueHandler | null = null;

  constructor(containerId: string, client: EngineClient) {
    const container = document.getElementById(containerId)!;
    // The renderer fills a dedicated sub-container inset below the toolbar
    // (see #fluidcad-scene in styles.css); it sizes, resizes, and raycasts
    // against this element, so the scene starts under the toolbar with no
    // coordinate offsets. UI chrome stays on the full-size outer container.
    const sceneContainer = document.getElementById('fluidcad-scene') ?? container;
    this.ctx = new SceneContext(sceneContainer);
    this.modeManager = new SceneModeManager(this.ctx);
    new DialogViewOffset(this.ctx);
    this.settingsPanel = new SettingsPanel(container, client, (mode) => this.ctx.switchCamera(mode));
    this.settingsPanel.setFitHandler(() => this.fitViewToScene());
    this.gridScaleBar = new GridScaleBar(container, (key, value) => client.savePreference(key, value));
    this.modeManager.subscribeGridSpacing((spacing, visible) => this.gridScaleBar.update(spacing, visible));
    if (viewerSettings.current.cameraMode === 'perspective') {
      this.ctx.switchCamera('perspective');
    }

    // The document unit is set from scene-rendered BEFORE the render lands.
    // Nothing on screen yet: re-seat the cameras on the unit's defaults so
    // an inch or metre file opens on the same picture a mm file does. A
    // scene already up: its geometry is about to be replaced at a different
    // scale, so let the next render auto-fit rather than keep a camera that
    // may now be inside — or a kilometre from — the model.
    sceneUnit.subscribe(() => {
      if (!this.hasRendered) {
        this.ctx.applyUnitDefaults();
        return;
      }
      this.hasRendered = false;
      this.lastFitBox = null;
    });

    // The sketch-dimension suffix is baked into the glyph labels — re-lay
    // them out when it flips.
    let dimensionSuffix = viewerSettings.current.sketchDimensionSuffix;
    viewerSettings.subscribe((s) => {
      if (s.sketchDimensionSuffix !== dimensionSuffix) {
        dimensionSuffix = s.sketchDimensionSuffix;
        this.refreshSketchConstraintGlyphs();
      }
    });

    this.initClickDetection();
    this.initHoverDetection();
  }

  get sceneContext(): SceneContext {
    return this.ctx;
  }

  get currentSceneObjects(): SceneObjectRender[] {
    return this.sceneObjects;
  }

  /**
   * One solid alone, rendered to a small transparent PNG from the standard
   * iso view — the top bar's Export rows preview themselves with these.
   *
   * The other shapes are hidden only across the synchronous
   * {@link captureScreenshot} render (bounds fitting skips invisible objects,
   * so the solid fills the frame), which is why the interactive canvas never
   * sees the toggle. `solidsOnly` drops what has no shape id — sketch glyphs,
   * overlays — and lifts the sketch-mode ghost tint, so the row looks the
   * same whether or not a sketch is open.
   */
  captureSolidThumbnail(shapeId: string, size = 128): Promise<Blob> {
    const touched: Array<[Object3D, boolean]> = [];
    this.ctx.scene.traverse((child) => {
      const id = child.userData.shapeId as string | undefined;
      if (id === undefined) {
        return;
      }
      if (id !== shapeId && child.visible) {
        touched.push([child, true]);
        child.visible = false;
      } else if (id === shapeId && !child.visible) {
        touched.push([child, false]);
        child.visible = true;
      }
    });
    try {
      return captureScreenshot(this.ctx, {
        width: size,
        height: size,
        transparent: true,
        solidsOnly: true,
        view: { kind: 'named', name: 'iso-ftr' },
      });
    } finally {
      for (const [child, visible] of touched) {
        child.visible = visible;
      }
    }
  }

  /**
   * The document is blank — nothing modelled, only construction geometry at
   * most. Every feature service ORs this into its own availability rule, so an
   * empty scene offers the *whole* toolbar (each dialog then opens on its own
   * empty prompt) instead of collapsing to Import / Sketch / Plane and hiding
   * what FluidCAD can do from someone starting out.
   *
   * A rolled-back view is never empty: the services are handed an empty list
   * on rollbacks (see their `handleSceneRendered`) to hide their buttons, and
   * that truncated scene must keep hiding them.
   */
  get sceneIsEmpty(): boolean {
    return !this.lastRenderIsRollback && isSceneEmpty(this.sceneObjects);
  }

  setSelectionHandler(fn: (shapeId: string | null, sub: SubSelection, instanceId: string | null, modifiers: SelectionModifiers) => void): void {
    this.selectionHandler = fn;
  }

  /** Notified when the hovered sub-shape changes (null = nothing hovered). */
  setHoverHandler(fn: (shapeId: string | null, sub: SubSelection, clientX: number, clientY: number) => void): void {
    this.hoverHandler = fn;
  }

  /** Notified on a non-drag right-click over the canvas (pick may be null). */
  setContextMenuHandler(fn: (shapeId: string | null, sub: SubSelection, clientX: number, clientY: number) => void): void {
    this.contextMenuHandler = fn;
  }

  /** Notified on a non-drag double-click over the canvas (pick may be null). */
  setDoubleClickHandler(fn: (shapeId: string | null, sub: SubSelection) => void): void {
    this.doubleClickHandler = fn;
  }

  get settingsPanelHost(): HTMLElement {
    return this.settingsPanel.panelHost;
  }

  /**
   * The section-view toggle lives in the sketch dialog, which the modify-pick
   * service owns; it registers the control here so the viewer can drive its
   * visibility (see {@link syncSectionViewVisible}) and checked state.
   */
  setSectionViewControl(control: SectionViewControl | null): void {
    this.sectionViewControl = control;
    this.syncSectionViewVisible();
    control?.setActive(viewerSettings.current.sectionView);
  }

  /**
   * Show the sketch dialog's options row (section view + snapping) whenever
   * the scene has a sketch for them to act on. That includes a suspended
   * sketch: re-picking the sketch's face/plane frees the camera from the
   * sketch view for the pick, but the dialog — and its sketch — are still
   * there, so its toggles must not blink out for the duration.
   */
  private syncSectionViewVisible(): void {
    this.sectionViewControl?.setVisible(this.modeManager.isSketchMode || this.hasSuspendedSketch());
  }

  /** Sketch editing is suspended, but the scene still ends in its sketch. */
  private hasSuspendedSketch(): boolean {
    if (!this.sketchEditingSuspended || this.lastRenderIsRollback) {
      return false;
    }
    const active = findActiveObject(this.sceneObjects);
    return active?.type === 'sketch' && !!active.object?.plane;
  }

  /**
   * A render landed while sketch editing was suspended and drew that sketch
   * as a plain 3D scene — no camera lock, no ghosting, no options row. It
   * beat the apply response that was going to lift the suspension, so the
   * lazy resume's "a render is on its way" no longer holds: that render has
   * been and gone, and nothing else will make the transition it skipped.
   */
  get missedSketchRender(): boolean {
    return this.renderedWhileSuspended && this.hasSuspendedSketch();
  }

  /** Clip the scene at the sketch plane, or stop clipping. */
  setSectionViewEnabled(enabled: boolean): void {
    viewerSettings.update({ sectionView: enabled });
    if (enabled) {
      this.applySectionView();
    } else {
      this.clearSectionView();
    }
  }

  /**
   * The sketch dialog's Lock-camera toggle: while in sketch mode, rotation
   * is blocked (pan/zoom only) so a drag can't tilt the view off the sketch
   * plane. The setting sticks for later sketches; leaving sketch mode always
   * frees the camera.
   */
  setSketchCameraLockEnabled(enabled: boolean): void {
    viewerSettings.update({ sketchLockCamera: enabled });
    if (!this.modeManager.isSketchMode) {
      return;
    }
    this.ctx.setRotationLocked(enabled);
    // Re-engaging the lock re-squares the view: free rotation while unlocked
    // may have tilted the camera, and a locked camera must face the plane.
    if (enabled) {
      const active = findActiveObject(this.sceneObjects);
      if (active?.type === 'sketch' && active.object?.plane) {
        this.modeManager.enforceSketchNormal(active.object.plane);
      }
    }
  }

  /**
   * The sketch dialog's constraint-visibility toggles. Dimensional =
   * distance/angle/radius/diameter annotations; positional = every other
   * constraint's badges and dots. Session-wide (like the camera lock), and
   * applied to the live sketch meshes in place — no server round-trip.
   */
  setSketchDimensionsVisible(enabled: boolean): void {
    viewerSettings.update({ sketchShowDimensions: enabled });
    this.refreshSketchConstraintGlyphs();
  }

  setSketchPositionalVisible(enabled: boolean): void {
    viewerSettings.update({ sketchShowPositional: enabled });
    this.refreshSketchConstraintGlyphs();
  }

  private refreshSketchConstraintGlyphs(): void {
    // Collect before refreshing: the rebuild swaps the mesh's own children,
    // which must not happen under scene.traverse's child iteration.
    const meshes: SketchMesh[] = [];
    this.ctx.scene.traverse(node => {
      if (node.userData.isSketchRoot) {
        meshes.push(node as SketchMesh);
      }
    });
    for (const mesh of meshes) {
      mesh.refreshConstraintGlyphs();
    }
    this.ctx.requestRender();
  }

  setParamsToggleHandler(fn: () => void): void {
    this.settingsPanel.setParamsToggleHandler(fn);
  }

  setParamsButtonVisible(visible: boolean): void {
    this.settingsPanel.setParamsButtonVisible(visible);
  }

  setParamsButtonActive(active: boolean): void {
    this.settingsPanel.setParamsButtonActive(active);
  }

  lookAlongSketchNormal(plane: PlaneData): void {
    this.modeManager.enforceSketchNormal(plane);
  }


  private initClickDetection(): void {
    const canvas = this.ctx.renderer.domElement;
    let downX = 0;
    let downY = 0;

    canvas.addEventListener('mousedown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });

    canvas.addEventListener('mouseup', (e) => {
      // Left releases only: a right-click release arrives right after the
      // `contextmenu` event (before it on some platforms) and would both
      // toggle a selection and dismiss the menu the right-click just opened.
      if (e.button !== 0) {
        return;
      }
      if (!this.selectionHandler || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      // A gizmo gesture (drag, handle click, typed commit) owns this click
      // completely — no selection, no highlight churn.
      if (this.clickInterceptor?.()) {
        return;
      }
      // A click on a draggable part (whether the cursor moved or not)
      // shouldn't double as a face-selection click — otherwise a drop
      // leaves a stray face/edge highlight on the part. Clear any
      // pre-existing highlight too in case it was set by an earlier click.
      const dropped = this.assemblyController?.consumeRecentDrag();
      if (dropped) {
        this.clearHighlight();
        this.clearHover();
        // The parts panel may have called assemblyController.highlightInstance
        // earlier (whole-instance tint via assemblyOriginalColor); viewer's
        // clearHighlight only handles selection/hover overlays, so clear the
        // controller's own tint too.
        this.assemblyController?.clearHighlight();
        // Suppress hover on the part the user just dropped — they're still
        // over it, and re-painting its face on the next mousemove would
        // look like the highlight didn't clear. Cleared in updateHover as
        // soon as the cursor moves to a different instance or empty space.
        this.hoverSuppressForInstance = dropped.instanceId;
        if (this.selectionHandler) {
          // The claim swallowed the pick, so this is the only channel a
          // click on a draggable part has: a finished drag clears the
          // selection, a no-move claim IS the click — surface it as an
          // instance-only selection (no face/edge) so the transform gizmo
          // can attach.
          this.selectionHandler(null, null, dropped.moved ? null : dropped.instanceId, { additive: false });
        }
        return;
      }
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 64) {
        return; // was a drag (> 8px)
      }

      this.clearHover();
      const modifiers: SelectionModifiers = { additive: e.ctrlKey || e.metaKey || e.shiftKey };
      const result = this.pickAt(e.clientX, e.clientY);
      if (isPlanePick(result)) {
        this.standardPlanePickHandler?.(result.standardPlane);
        return;
      }
      if (result) {
        this.selectionHandler(result.shapeId, result.sub, result.instanceId ?? null, modifiers);
      } else {
        this.selectionHandler(null, null, null, modifiers);
      }
    });

    // Non-drag double-click. The two single-click selections have already
    // fired by the time this arrives (DOM event order), so the handler sees
    // the selection as the clicks left it.
    canvas.addEventListener('dblclick', (e) => {
      if (!this.doubleClickHandler || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 64) {
        return; // was a drag (> 8px)
      }
      const result = this.pickAt(e.clientX, e.clientY);
      if (isPlanePick(result)) {
        return;
      }
      this.doubleClickHandler(result?.shapeId ?? null, result?.sub ?? null);
    });

    // Non-drag right-click. OrbitControls suppresses the browser menu on the
    // canvas; this hook adds pick-aware context actions on top.
    canvas.addEventListener('contextmenu', (e) => {
      if (!this.contextMenuHandler || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (dx * dx + dy * dy > 64) {
        return; // was a right-drag (pan)
      }
      e.preventDefault();
      const result = this.pickAt(e.clientX, e.clientY);
      if (isPlanePick(result)) {
        return;
      }
      this.contextMenuHandler(result?.shapeId ?? null, result?.sub ?? null, e.clientX, e.clientY);
    });
  }

  /** Walk up parents looking for an `instanceId` user-data marker. */
  private findInstanceIdForObject(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      const id = cur.userData?.instanceId;
      if (typeof id === 'string') {
        return id;
      }
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Resolves an instance scope to a traversal root. Returns the live
   * controller-owned Group when the id is known, the whole scene when no id
   * is given, and null when the id was given but no longer exists (caller
   * should treat as "nothing to highlight").
   */
  private resolveScope(instanceId: string | null | undefined): Object3D | null {
    if (!instanceId) {
      return this.ctx.scene;
    }
    return this.assemblyController?.getInstanceGroup(instanceId) ?? null;
  }

  /** The raycast every pick query shares: candidates collected, hits by distance. */
  private castPick(clientX: number, clientY: number): {
    raycaster: Raycaster;
    faceTargets: Mesh[];
    faceHits: Intersection[];
    edgeHits: Intersection[];
    sketchWireHits: Intersection[];
    axisHits: Intersection[];
    planeHits: Intersection[];
    planeQuadHits: Intersection[];
  } {
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);
    raycaster.params.Line = { threshold: this.computeEdgePickThreshold() };
    raycaster.params.Line2 = { threshold: 8 };

    const candidates = collectPickCandidates(this.ctx.scene, {
      sketchWires: this.pickSketchWires,
      profileWires: this.pickProfileWires,
      axes: this.pickAxes,
      planes: this.pickPlanes,
    });

    const faceHits = candidates.faces.length > 0 ? raycaster.intersectObjects(candidates.faces, false) : [];
    const edgeHits = candidates.edges.length > 0 ? raycaster.intersectObjects(candidates.edges, false) : [];
    const sketchWireHits = candidates.sketchWires.length > 0
      ? raycaster.intersectObjects(candidates.sketchWires, false)
      : [];
    const axisHits = candidates.axes.length > 0 ? raycaster.intersectObjects(candidates.axes, false) : [];
    // Origin-plane quads participate only while shown (armed sketch mode).
    const planeTargets = this.standardPlanes.pickTargets;
    const planeHits = planeTargets.length > 0 ? raycaster.intersectObjects(planeTargets, false) : [];
    const planeQuadHits = candidates.planeQuads.length > 0
      ? raycaster.intersectObjects(candidates.planeQuads, false)
      : [];

    return { raycaster, faceTargets: candidates.faces, faceHits, edgeHits, sketchWireHits, axisHits, planeHits, planeQuadHits };
  }

  /**
   * Whether `point` is visible from the camera: no occluder strictly in
   * front of it (beyond `tolerance` world units) along the sight line
   * through the point itself.
   */
  private isPointVisible(point: Vector3, occluders: Object3D[], tolerance: number): boolean {
    if (occluders.length === 0) {
      return true;
    }
    const ndc = point.clone().project(this.ctx.camera);
    const ray = this.ctx.createPickingRaycaster(ndc.x, ndc.y);
    const pointDepth = ray.ray.direction.dot(new Vector3().copy(point).sub(ray.ray.origin));
    const hits = ray.intersectObjects(occluders, false);
    return hits.length === 0 || hits[0].distance >= pointDepth - tolerance;
  }

  /**
   * Client-side raycaster picking across all shapes.  Returns the closest
   * front-facing face or edge hit together with its shapeId — or, while the
   * origin planes are shown and one is the closest visible target, that
   * plane.
   */
  private pickAt(clientX: number, clientY: number): PickResult | null {
    // Connector gizmos render on top of everything (depth-test off), so while
    // a mate dialog has them armed a nearby gizmo outranks all raycast hits.
    if (this.pickConnectors && this.assemblyController) {
      const connectorHit = this.assemblyController.pickConnectorAt(clientX, clientY);
      if (connectorHit) {
        return {
          shapeId: connectorHit.connectorId,
          sub: { type: 'connector', index: 0 },
          instanceId: connectorHit.instanceId,
        };
      }
    }
    const camera = this.ctx.camera;
    const { faceTargets, faceHits, edgeHits, sketchWireHits, axisHits, planeHits, planeQuadHits } = this.castPick(clientX, clientY);

    if (faceHits.length === 0 && edgeHits.length === 0 && sketchWireHits.length === 0
      && axisHits.length === 0 && planeHits.length === 0 && planeQuadHits.length === 0) {
      return null;
    }

    // Sketch wires render on top of the model (no depth test), so a visible
    // wire is pickable regardless of face occlusion, and as thin targets
    // they outrank face hits within the line threshold.
    for (const wireHit of sketchWireHits) {
      const shapeId = this.findShapeIdForObject(wireHit.object);
      if (shapeId) {
        return { shapeId, sub: { type: 'sketch', index: 0 } };
      }
    }

    // Axis lines are thin construction guides usually floating off the
    // solid — like sketch wires they outrank face hits so picking one never
    // needs pixel-perfect aim against the geometry behind it.
    for (const axisHit of axisHits) {
      const shapeId = this.findShapeIdForObject(axisHit.object);
      if (shapeId) {
        return { shapeId, sub: { type: 'axis', index: 0 } };
      }
    }

    // Pick the closest face hit whose triangle normal faces the camera.
    const viewDir = new Vector3();
    camera.getWorldDirection(viewDir);
    let bestFace: (typeof faceHits)[number] | undefined;
    for (const hit of faceHits) {
      if (!hit.face) {
        bestFace = hit;
        break;
      }
      const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (worldNormal.dot(viewDir) < 0) {
        bestFace = hit;
        break;
      }
    }

    // Edge visibility test: an edge candidate wins iff the closest point on
    // it is itself visible — no face (or shown origin plane) strictly in
    // front of that point along the sight line through it. Testing against
    // the cursor ray's own face hit instead rejects every concave edge: near
    // a shelled pocket's floor edge the cursor lands on an adjacent face
    // that really is closer than the corner, so only a sub-pixel band over
    // the line ever passed. Through the edge point the adjacent faces sit at
    // the edge's own depth, so a visible concave edge ties within tolerance
    // while an edge behind other geometry stays strictly occluded.
    const faceDist = bestFace != null ? bestFace.distance : Infinity;
    const planeDist = planeHits.length > 0 ? planeHits[0].distance : Infinity;
    const planeQuadDist = planeQuadHits.length > 0 ? planeQuadHits[0].distance : Infinity;
    if (this.pickFilter === 'all' || this.pickFilter === 'edge') {
      const occluders: Object3D[] = [...faceTargets, ...this.standardPlanes.pickTargets];
      // ~2px worth of world units: forgiving of tessellation putting an
      // adjacent face marginally in front of the edge polyline, while a real
      // occluder (a wall between camera and edge) still rejects the edge.
      const tolerance = this.computeEdgePickThreshold() / 4;
      for (const edgeHit of edgeHits) {
        // LineSegments2 hits expose `pointOnLine` (closest point on the
        // segment in world space); legacy Line hits carry it as `point`.
        const pointOnLine = (edgeHit as { pointOnLine?: Vector3 }).pointOnLine ?? edgeHit.point;
        if (this.isPointVisible(pointOnLine, occluders, tolerance)) {
          const edgeIndex = edgeHit.object.userData.edgeIndex as number;
          const shapeId = this.findShapeIdForObject(edgeHit.object);
          if (shapeId) {
            return {
              shapeId,
              sub: { type: 'edge', index: edgeIndex },
              instanceId: this.findInstanceIdForObject(edgeHit.object),
            };
          }
        }
      }
    }

    // A construction-plane quad behaves like an origin plane: it wins only
    // where it is the closest visible target — ties go to coplanar geometry
    // and to the origin planes (a plane coincident with 'xy' sketches as 'xy').
    if (planeQuadHits.length > 0 && planeQuadDist < faceDist - 1e-3 && planeQuadDist < planeDist - 1e-3) {
      const shapeId = this.findShapeIdForObject(planeQuadHits[0].object);
      if (shapeId) {
        return { shapeId, sub: { type: 'plane', index: 0 } };
      }
    }

    // An origin plane wins where it is the closest visible target; the tie
    // goes to coplanar geometry (sketching on the face that lies ON a plane).
    if (planeHits.length > 0 && planeDist < faceDist - 1e-3) {
      const planeId = this.standardPlanes.planeIdFor(planeHits[0].object);
      if (planeId) {
        return { standardPlane: planeId };
      }
    }

    if (bestFace && this.pickFilter !== 'edge') {
      const mapping: number[] | undefined = bestFace.object.userData.faceMapping;
      if (!mapping || bestFace.faceIndex == null) {
        return null;
      }
      const faceIndex = mapping[bestFace.faceIndex];
      if (faceIndex == null) {
        return null;
      }
      const shapeId = this.findShapeIdForObject(bestFace.object);
      if (shapeId) {
        return {
          shapeId,
          sub: { type: 'face', index: faceIndex },
          instanceId: this.findInstanceIdForObject(bestFace.object),
        };
      }
    }

    return null;
  }

  private findShapeIdForObject(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      if (cur.userData.shapeId && !cur.userData.isMetaShape) {
        return cur.userData.shapeId as string;
      }
      cur = cur.parent;
    }
    return null;
  }

  toggleSketchMode(enable: boolean): void {
    // While a dialog holds sketch editing suspended, nothing else may
    // re-enable the mode manager — only resumeSketchEditing (which clears
    // the suspension first) hands sketch mode back. Without this, a region
    // reset on an edit session's rollback render re-enables the manager and
    // the next full render locks the camera back onto the sketch normal.
    this.modeManager.sketchEnabled = enable && !this.sketchEditingSuspended;
  }

  /**
   * Show the origin planes (xy/xz/yz) as pick targets — the armed sketch mode
   * offers them for a plane sketch. A click on one calls `onPick` instead of
   * the selection handler; scene faces in front of a plane keep their picks.
   * Re-showing while visible re-sizes the planes to the current scene.
   */
  showStandardPlanes(onPick: (plane: StandardPlaneId) => void): void {
    this.standardPlanePickHandler = onPick;
    this.standardPlanes.show(this.ctx.scene, this.sceneBoundsForPlanes());
    this.ctx.requestRender();
  }

  hideStandardPlanes(): void {
    if (!this.standardPlanes.visible) {
      return;
    }
    this.standardPlanePickHandler = null;
    this.standardPlanes.hide();
    this.ctx.requestRender();
  }

  private sceneBoundsForPlanes(): Box3 | null {
    const mesh = this.ctx.scene.getObjectByName('compiledMesh');
    if (!mesh) {
      return null;
    }
    const box = new Box3();
    expandBoxExcludingMeta(box, mesh);
    return box.isEmpty() ? null : box;
  }

  /**
   * Temporarily leave sketch editing while the scene still ends with a
   * sketch: restore the free 3D camera, unlock the projection, and rebuild
   * the mesh un-ghosted so faces can be picked (the sketch-on-face flow from
   * inside a sketch). {@link resumeSketchEditing} undoes it; scene updates
   * arriving while suspended stay in the default mode.
   */
  suspendSketchEditing(): void {
    this.modeManager.sketchEnabled = false;
    this.sketchEditingSuspended = true;
    this.renderedWhileSuspended = false;
    if (this.modeManager.isSketchMode) {
      this.modeManager.enterDefaultMode();
    }
    this.activeSketchId = null;
    this.settingsPanel.setProjectionLocked(false);
    this.settingsPanel.setFitButtonVisible(true);
    this.syncSectionViewVisible();
    this.clearHover();
    this.rebuildSceneMesh();
  }

  /**
   * Aim the camera down a sketch plane and hold it there while a 2D edit
   * dialog owns the view (the text edit): sketch editing itself stays
   * suspended — no toolbar, no sketch dialog — but the camera behaves like
   * sketch mode's, swung along the normal with rotation locked per the
   * user's "Lock camera" setting. {@link releaseSketchCamera} undoes the
   * hold; the render that follows the edit re-runs the real mode transition.
   */
  holdSketchCamera(plane: PlaneData): void {
    const cc = this.ctx.cameraControls;
    const normal = new Vector3(plane.normal.x, plane.normal.y, plane.normal.z);
    const yDir = new Vector3(plane.yDirection.x, plane.yDirection.y, plane.yDirection.z);

    const tgt = new Vector3();
    cc.getTarget(tgt);
    const camPos = tgt.clone().add(normal.clone().multiplyScalar(sketchCameraDistance()));

    this.ctx.camera.up.copy(yDir);
    cc.updateCameraUp();
    cc.normalizeRotations();
    cc.setLookAt(camPos.x, camPos.y, camPos.z, tgt.x, tgt.y, tgt.z, true);

    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;

    this.ctx.setRotationLocked(viewerSettings.current.sketchLockCamera);
  }

  /** Undo {@link holdSketchCamera}: unlock rotation and restore the world up. */
  releaseSketchCamera(): void {
    this.ctx.setRotationLocked(false);
    this.ctx.camera.up.copy(Object3D.DEFAULT_UP);
    this.ctx.cameraControls.updateCameraUp();
  }

  /**
   * Re-enable sketch editing after {@link suspendSketchEditing}. With
   * `immediate`, re-run the mode transition against the current scene now
   * (the cancel path); without, the next scene render performs it (the
   * applied path — a render of the new sketch is already on its way).
   */
  resumeSketchEditing(immediate: boolean): void {
    this.modeManager.sketchEnabled = true;
    this.sketchEditingSuspended = false;
    this.renderedWhileSuspended = false;
    if (immediate && this.sceneObjects) {
      // Replay the last render as it arrived: re-running a rollback as a full
      // render would let a rolled-back sketch grab the camera.
      this.updateView(this.sceneObjects, this.lastRenderIsRollback, this.lastRenderStop);
    }
  }

  updateView(sceneObjects: SceneObjectRender[], isRollback = false, rollbackStop?: number): void {
    this.sceneObjects = sceneObjects;
    this.lastRenderIsRollback = isRollback;
    this.lastRenderStop = rollbackStop;
    // Sketch editing suspended: this render draws the scene as a plain 3D one,
    // whatever it ends in. A resume that expected to hand its mode transition
    // to this render has to make it itself — see {@link missedSketchRender}.
    if (!isRollback && this.sketchEditingSuspended) {
      this.renderedWhileSuspended = true;
    }
    this.highlightedShapeId = null;
    this.highlightedSolidShapeIds = [];
    this.highlightedEntities = [];
    this.highlightedPlaneQuads = [];
    this.faceHighlightMeshes = [];
    this.hoverState = null;
    this.hoverFaceOverlayMeshes = [];
    this.ctx.renderer.domElement.style.cursor = '';

    this.removeCompiledMesh();
    // Detach the assembly controller's group from the scene but keep its
    // instance state so a part → assembly → part round-trip preserves the
    // poses the user dragged. The controller's clear() is reserved for
    // genuine assembly teardown (handled inside updateAssemblyView when the
    // file changes — see clearAssemblyState).
    if (this.assemblyController) {
      const container = this.assemblyController.getContainer();
      if (container.parent) {
        container.parent.remove(container);
      }
      // Drop any per-instance hover-revealed connectors so they don't
      // resurface when the user re-enters assembly mode.
      this.assemblyController.setHoveredInstance(null);
      // A drag in flight (or an unconsumed drop flag) must not survive into
      // the part view — it would pin isDragGestureActive() true and swallow
      // the first click via consumeRecentDrag().
      this.assemblyController.cancelPointerGesture();
    }

    if (!isRollback) {
      const activeObject = findActiveObject(sceneObjects);

      // A disabled mode manager (suspendSketchEditing / region picking) makes
      // a trailing sketch render like any other scene — no camera lock, no
      // ghosting — so faces stay pickable in the free 3D view.
      if (activeObject?.type === 'sketch' && activeObject.object?.plane && this.modeManager.sketchEnabled) {
        if (!this.modeManager.isSketchMode) {
          this.modeManager.enterSketchMode(activeObject.object.plane);
        } else {
          this.modeManager.enforceSketchNormal(activeObject.object.plane);
        }
        this.activeSketchId = activeObject.id;
        this.settingsPanel.setProjectionLocked(true);
        this.settingsPanel.setFitButtonVisible(false);
      } else {
        this.activeSketchId = null;
        this.modeManager.enterDefaultMode();
        this.settingsPanel.setProjectionLocked(false);
        this.settingsPanel.setFitButtonVisible(true);
        this.lastFitBox = null;
      }
    } else {
      // A disabled mode manager (an edit session's pre-statement rollback)
      // keeps the rolled-back scene un-ghosted even when the stop lands on a
      // sketch — the session is there to pick geometry, not edit the sketch.
      this.activeSketchId = this.modeManager.sketchEnabled
        ? this.findRollbackActiveSketchId(sceneObjects, rollbackStop)
        : null;
    }

    const mesh = buildSceneMesh(sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking, isRollback);
    this.ctx.scene.add(mesh);
    this.applyShapeOverridesAndPrune(sceneObjects);

    if (this.activeSketchId) {
      this.applySketchModeGhosting();
    }

    // Section view: offer the toggles this scene's sketch owns, and apply the
    // clipping when in sketch mode.
    this.syncSectionViewVisible();
    if (this.modeManager.isSketchMode) {
      this.sectionViewControl?.setActive(viewerSettings.current.sectionView);
      if (viewerSettings.current.sectionView) {
        this.applySectionView();
      }
    }

    // Auto-fit on first render or in sketch mode (skip if viewport barely changed).
    // Skip when in sketch mode on first render — positionCameraForSketch already centered on origin.
    if ((!this.hasRendered && !this.modeManager.isSketchMode) || (this.modeManager.isSketchMode && !isRollback && !this.isRegionPicking && !this.isDrawing)) {
      const box = new Box3();
      expandBoxExcludingMeta(box, mesh);
      if (!box.isEmpty() && !this.isBoxContained(box)) {
        this.ctx.fitToBox(box, true);
        this.lastFitBox = box.clone();
        this.hasRendered = true;
      }
    }
    if (!this.hasRendered && this.modeManager.isSketchMode) {
      this.hasRendered = true;
    }

    this.ctx.requestRender();
  }

  highlightInstance(instanceId: string): void {
    this.assemblyController?.highlightInstance(instanceId, themeColors.highlightColor.getHex());
  }

  highlightMate(mate: SerializedAssemblyMate): void {
    this.assemblyController?.highlightMate(mate, themeColors.highlightColor.getHex());
  }

  clearInstanceHighlight(): void {
    this.assemblyController?.clearHighlight();
  }

  setInstanceVisibility(instanceId: string, visible: boolean): void {
    this.assemblyController?.setInstanceVisible(instanceId, visible);
  }

  isInstanceVisible(instanceId: string): boolean {
    return this.assemblyController?.isInstanceVisible(instanceId) ?? true;
  }

  setInstanceDragReleaseHandler(handler: InstanceDragReleaseHandler | null): void {
    this.pendingDragReleaseHandler = handler;
    this.assemblyController?.setDragReleaseHandler(handler);
  }

  setSolverUpdateHandler(handler: SolverUpdateHandler | null): void {
    this.pendingSolverUpdateHandler = handler;
    this.assemblyController?.setSolverUpdateHandler(handler);
  }

  setDragValueHandler(handler: DragValueHandler | null): void {
    this.pendingDragValueHandler = handler;
    this.assemblyController?.setDragValueHandler(handler);
  }

  setClickInterceptor(fn: (() => boolean) | null): void {
    this.clickInterceptor = fn;
  }

  setHoverSuppressor(fn: (() => boolean) | null): void {
    this.hoverSuppressor = fn;
  }

  /**
   * The live assembly controller — created lazily on the first assembly
   * render and rebuilt never, but callers must still re-read it per use
   * rather than caching (it is null until then).
   */
  getAssemblyController(): AssemblyController | null {
    return this.assemblyController;
  }

  updateAssemblyView(sceneObjects: SceneObjectRender[], assembly: SerializedAssembly): void {
    // The render result contains every Part declared in the file, including
    // ones never passed to `insert(...)` (calling `getExtrusion('80x160', …)`
    // for its side-effect of registering the Part in the scene puts it in
    // the result). Drop those subtrees so a stray `rebuildSceneMesh()` (theme
    // change, region pick) can't materialize an un-inserted part at world
    // origin, and so the controller's part-template map / connector lookup
    // doesn't waste time on them.
    sceneObjects = filterToReferencedParts(sceneObjects, assembly.instances);
    this.sceneObjects = sceneObjects;
    this.highlightedShapeId = null;
    this.hoverState = null;
    this.hoverFaceOverlayMeshes = [];

    this.removeCompiledMesh();
    this.activeSketchId = null;
    this.modeManager.enterDefaultMode();
    this.settingsPanel.setProjectionLocked(false);
    this.settingsPanel.setFitButtonVisible(true);

    if (!this.assemblyController) {
      this.assemblyController = new AssemblyController(
        this.ctx.renderer,
        this.ctx.camera,
        () => this.ctx.requestRender(),
        (ndcX, ndcY) => this.ctx.createPickingRaycaster(ndcX, ndcY),
      );
      this.assemblyController.setDragReleaseHandler(this.pendingDragReleaseHandler);
      this.assemblyController.setSolverUpdateHandler(this.pendingSolverUpdateHandler);
      this.assemblyController.setDragValueHandler(this.pendingDragValueHandler);
      // When the controller claims a drag, eagerly clear any face/edge/instance
      // highlight that was set earlier (e.g. by a prior click or parts-panel
      // row). Otherwise it would visually "stick" through the drag and the
      // user would see the just-dropped part still highlighted.
      this.assemblyController.setDragClaimHandler(() => {
        // Cancel any hover RAF that was scheduled by a mousemove fired
        // before the drag began — otherwise its callback runs mid-drag and
        // paints a face overlay on the part we're currently dragging.
        if (this.hoverRafId !== null) {
          cancelAnimationFrame(this.hoverRafId);
          this.hoverRafId = null;
        }
        this.clearHighlight();
        this.clearHover();
        this.assemblyController?.clearHighlight();
        if (this.selectionHandler) {
          this.selectionHandler(null, null, null, { additive: false });
        }
      });
    }
    const container = this.assemblyController.getContainer();
    if (!container.parent) {
      this.ctx.scene.add(container);
    }

    this.assemblyController.update(sceneObjects, assembly);

    if (!this.hasRendered) {
      const box = new Box3();
      expandBoxExcludingMeta(box, this.assemblyController.getContainer());
      if (!box.isEmpty() && !this.isBoxContained(box)) {
        this.ctx.fitToBox(box, true);
        this.lastFitBox = box.clone();
        this.hasRendered = true;
      }
    }

    this.ctx.requestRender();
  }

  highlightShape(shapeId: string, instanceId: string | null = null): void {
    this.clearHighlight();
    this.applyShapeHighlight(shapeId, instanceId);
    this.highlightedShapeId = shapeId;
    this.highlightedInstanceId = instanceId;
    this.highlightedEntities = [];
    this.ctx.render();
  }

  /** Tint one whole shape (all faces of a solid, or its edges) in place. */
  private applyShapeHighlight(shapeId: string, instanceId: string | null = null): void {
    const part = this.findShapeById(shapeId);
    if (!part) return;

    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    const group = this.findMeshByShapeId(shapeId, scope);
    if (!group) return;

    const isFaceHighlight = part.shapeType === 'solid' || part.shapeType === 'face';

    group.traverse((child) => {
      if (!(child as any).material) return;

      const isEdge = (child as LineSegments).isLine || child.userData.isEdgeLine;

      if (isFaceHighlight && child instanceof Mesh && !isEdge) {
        const mat = (child as any).material;
        child.userData.originalColor = mat.color.getHex();
        mat.color.set(themeColors.highlightColor);
        if (mat.opacity < 1 || mat.transparent) {
          child.userData.originalOpacity = mat.opacity;
          child.userData.originalTransparent = mat.transparent;
          mat.opacity = 1;
          mat.transparent = false;
        }
      } else if (!isFaceHighlight && isEdge) {
        child.userData.originalColor = (child as any).material.color.getHex();
        (child as any).material.color.set(themeColors.highlightColor);
        child.userData.originalLineWidth = (child as any).material.linewidth;
        (child as any).material.linewidth = HIGHLIGHT_EDGE_LINE_WIDTH;
        if ((child as any).material.opacity < 1) {
          child.userData.originalOpacity = (child as any).material.opacity;
          (child as any).material.opacity = 1;
        }
      }
    });
  }

  /**
   * Enlarge one part-view connector's gizmo (a timeline row's "show me"),
   * replacing any previous highlight. Mirrors the assembly controller's
   * hover feedback: the multiplier rides the gizmo's userData because its
   * scale is re-derived from the camera on every draw.
   */
  highlightConnector(connectorId: string): void {
    this.clearHighlight();
    this.highlightedConnectorId = connectorId;
    this.applyConnectorScale(connectorId, CONNECTOR_SHOW_SCALE);
    this.ctx.render();
  }

  private applyConnectorScale(connectorId: string, scale: number): void {
    this.ctx.scene.traverse((child) => {
      if (child.userData.isConnector !== true || child.userData.connectorId !== connectorId) {
        return;
      }
      const gizmo = child.children[0];
      if (gizmo) {
        gizmo.userData.highlight = scale;
      }
    });
  }

  /**
   * Show shapes that have no mesh in the scene — an `expose(…)` row's
   * published selection, which the exposure hides from the display — as a
   * highlight overlay built straight from their mesh data. Replaces any
   * previous highlight; cleared with the rest by clearHighlight.
   */
  highlightDetachedShapes(parts: SceneObjectPart[]): void {
    this.clearHighlight();
    const color = '#' + themeColors.highlightColor.getHexString();
    for (const part of parts) {
      let group: Group | undefined;
      switch (part.shapeType) {
        case 'face':
        case 'solid':
          group = new FaceMesh(part, { color });
          break;
        case 'edge':
        case 'wire':
          group = new EdgeMesh(part, { color, lineWidth: HIGHLIGHT_EDGE_LINE_WIDTH });
          break;
      }
      if (!group) {
        continue;
      }
      group.traverse((child) => {
        child.userData.isMetaShape = true;
        child.renderOrder = 1.5;
      });
      this.ctx.scene.add(group);
      this.detachedHighlightGroups.push(group);
    }
    this.ctx.render();
  }

  clearHighlight(): void {
    if (!this.highlightedShapeId && this.highlightedEntities.length === 0
      && this.highlightedSketchWires.length === 0 && this.faceHighlightMeshes.length === 0
      && this.highlightedSolidShapeIds.length === 0 && this.highlightedPlaneQuads.length === 0
      && this.highlightedConnectorId === null && this.detachedHighlightGroups.length === 0) {
      return;
    }

    if (this.highlightedConnectorId !== null) {
      this.applyConnectorScale(this.highlightedConnectorId, 1);
      this.highlightedConnectorId = null;
    }
    for (const group of this.detachedHighlightGroups) {
      group.parent?.remove(group);
      group.traverse((child) => {
        const drawable = child as Mesh;
        drawable.geometry?.dispose();
        (drawable.material as Material | undefined)?.dispose();
      });
    }
    this.detachedHighlightGroups = [];

    this.ctx.scene.traverse((child) => {
      if (child.userData.originalColor !== undefined) {
        (child as any).material.color.setHex(child.userData.originalColor);
        delete child.userData.originalColor;
      }
      if (child.userData.originalOpacity !== undefined) {
        (child as any).material.opacity = child.userData.originalOpacity;
        delete child.userData.originalOpacity;
      }
      if (child.userData.originalTransparent !== undefined) {
        (child as any).material.transparent = child.userData.originalTransparent;
        delete child.userData.originalTransparent;
      }
      if (child.userData.originalLineWidth !== undefined) {
        (child as any).material.linewidth = child.userData.originalLineWidth;
        delete child.userData.originalLineWidth;
      }
    });

    for (const m of this.faceHighlightMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.faceHighlightMeshes = [];

    this.highlightedShapeId = null;
    this.highlightedInstanceId = null;
    this.highlightedSolidShapeIds = [];
    this.highlightedEntities = [];
    this.highlightedSketchWires = [];
    this.highlightedPlaneQuads = [];
    this.ctx.render();
  }

  /**
   * Highlight a set of faces/edges at once (e.g. a measure selection), plus
   * optionally whole sketch wires by shape id (a create dialog's selected
   * sketch inputs), whole solids by shape id (a copy dialog's selected
   * targets) and construction-plane quads by shape id (a plane dialog's
   * chosen plane bases). Replaces any previous highlight. In assembly scenes
   * `instanceId` scopes the face/edge highlights to that instance's group.
   */
  highlightEntities(
    entities: SelectedEntity[],
    sketchWireShapeIds: string[] = [],
    solidShapeIds: string[] = [],
    planeQuadShapeIds: string[] = [],
    instanceId: string | null = null,
  ): void {
    this.clearHighlight();
    this.highlightedInstanceId = instanceId;
    for (const entity of entities) {
      if (entity.sub.type === 'face') {
        this.applyFaceHighlight(entity.shapeId, entity.sub.index, instanceId);
      } else {
        this.applyEdgeHighlight(entity.shapeId, entity.sub.index, instanceId);
      }
    }
    for (const shapeId of sketchWireShapeIds) {
      this.applySketchWireHighlight(shapeId);
    }
    for (const shapeId of solidShapeIds) {
      this.applyShapeHighlight(shapeId);
    }
    for (const shapeId of planeQuadShapeIds) {
      this.applyPlaneQuadHighlight(shapeId);
    }
    this.highlightedEntities = entities;
    this.highlightedSketchWires = sketchWireShapeIds;
    this.highlightedSolidShapeIds = solidShapeIds;
    this.highlightedPlaneQuads = planeQuadShapeIds;
    this.ctx.render();
  }

  /**
   * Highlight a construction-plane quad (the neutral-mode "sketch on this
   * plane" selection): highlight tint plus an opacity raise above the hover
   * level. Replaces any previous highlight; {@link clearHighlight} restores
   * it like every other selection tint.
   */
  highlightPlaneQuad(shapeId: string): void {
    this.clearHighlight();
    this.applyPlaneQuadHighlight(shapeId);
    this.highlightedPlaneQuads = [shapeId];
    this.ctx.render();
  }

  /** Tint one plane quad in place: highlight color plus an opacity raise. */
  private applyPlaneQuadHighlight(shapeId: string): void {
    const quad = this.findMeshByShapeId(shapeId);
    const mat = (quad as any)?.material;
    if (!quad || !mat) {
      return;
    }
    quad.userData.originalColor = mat.color.getHex();
    quad.userData.originalOpacity = mat.opacity;
    mat.color.set(themeColors.highlightColor);
    mat.opacity = 0.3;
  }

  highlightFace(shapeId: string, faceIndex: number, instanceId: string | null = null): void {
    this.highlightEntities([{ shapeId, sub: { type: 'face', index: faceIndex } }], [], [], [], instanceId);
  }

  highlightEdge(shapeId: string, edgeIndex: number, instanceId: string | null = null): void {
    this.highlightEntities([{ shapeId, sub: { type: 'edge', index: edgeIndex } }], [], [], [], instanceId);
  }

  private applyFaceHighlight(shapeId: string, faceIndex: number, instanceId: string | null = null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mapping: number[] | undefined = obj.userData.faceMapping;
      if (!mapping) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      const mesh = obj as Mesh;
      const geo = mesh.geometry as BufferGeometry;
      const indexAttr = geo.index;
      if (!indexAttr) {
        return;
      }

      const indices = indexAttr.array;
      const positions = (geo.getAttribute('position').array) as Float32Array;
      const newPositions: number[] = [];

      for (let tri = 0; tri < mapping.length; tri++) {
        if (mapping[tri] === faceIndex) {
          const i0 = (indices[tri * 3] as number) * 3;
          const i1 = (indices[tri * 3 + 1] as number) * 3;
          const i2 = (indices[tri * 3 + 2] as number) * 3;
          newPositions.push(positions[i0], positions[i0 + 1], positions[i0 + 2]);
          newPositions.push(positions[i1], positions[i1 + 1], positions[i1 + 2]);
          newPositions.push(positions[i2], positions[i2 + 1], positions[i2 + 2]);
        }
      }

      if (newPositions.length === 0) {
        return;
      }

      const overlayGeo = new BufferGeometry();
      overlayGeo.setAttribute('position', new BufferAttribute(new Float32Array(newPositions), 3));

      // No depth write, and slotted between solid faces (renderOrder 1) and
      // edge lines (renderOrder 2): edges depth-test against the pushed-back
      // base face and draw on top, so boundaries between two highlighted
      // faces stay visible.
      const overlayMat = new MeshPhongMaterial({
        color: themeColors.highlightColor,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1,
      });

      const overlayMesh = new Mesh(overlayGeo, overlayMat);
      overlayMesh.renderOrder = 1.5;
      (mesh.parent ?? this.ctx.scene).add(overlayMesh);
      this.faceHighlightMeshes.push(overlayMesh);
    });
  }

  private applyEdgeHighlight(shapeId: string, edgeIndex: number, instanceId: string | null = null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      if (obj.userData.edgeIndex !== edgeIndex) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      // Skip if already highlighted, so the saved original color isn't overwritten.
      if (obj.userData.originalColor !== undefined) {
        return;
      }
      obj.userData.originalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
      obj.userData.originalLineWidth = (obj as any).material.linewidth;
      (obj as any).material.linewidth = HIGHLIGHT_EDGE_LINE_WIDTH;
    });
  }

  /**
   * Tint every line of a sketch wire shape (a create dialog's selected sketch
   * input). The whole EdgeMesh group is addressed by its shapeId — sketch
   * wires have no per-edge sub-selection.
   */
  private applySketchWireHighlight(shapeId: string): void {
    const group = this.findMeshByShapeId(shapeId);
    if (!group) {
      return;
    }
    group.traverse((obj) => {
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      // Skip if already highlighted, so the saved original color isn't overwritten.
      if (obj.userData.originalColor !== undefined) {
        return;
      }
      obj.userData.originalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
      obj.userData.originalLineWidth = (obj as any).material.linewidth;
      (obj as any).material.linewidth = HIGHLIGHT_SKETCH_WIRE_LINE_WIDTH;
    });
  }

  // ---------------------------------------------------------------------------
  // Hover highlighting
  // ---------------------------------------------------------------------------

  private initHoverDetection(): void {
    const canvas = this.ctx.renderer.domElement;

    canvas.addEventListener('mousedown', () => {
      this.isMouseDown = true;
      // A new gesture: the user explicitly clicked on something, so any
      // post-drop hover suppression no longer applies.
      this.hoverSuppressForInstance = null;
      this.clearHover();
    });

    canvas.addEventListener('mouseup', () => {
      this.isMouseDown = false;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.isMouseDown || this.isRegionPicking || this.modeManager.isSketchMode) {
        return;
      }
      // Authoritative drag-active gate. `isMouseDown` above is mouse-event
      // derived; the browser sometimes suppresses compatibility mouse events
      // (touch/pen, palm rejection, fast input). The pointer-event-driven
      // controller state is reliable, so we always consult it.
      if (this.assemblyController?.isDragGestureActive()) {
        return;
      }
      if (this.hoverRafId !== null) {
        return;
      }
      this.hoverRafId = requestAnimationFrame(() => {
        this.hoverRafId = null;
        this.updateHover(e.clientX, e.clientY);
      });
    });

    canvas.addEventListener('mouseleave', () => {
      this.clearHover();
      // Clear the hovered instance when the cursor leaves the canvas. While
      // a mate dialog is picking, updateHover reveals connectors
      // per-instance; without this, a connector left visible by the last
      // hit would linger until the cursor re-enters.
      this.assemblyController?.setHoveredInstance(null);
    });
  }

  private updateHover(clientX: number, clientY: number): void {
    if (!this.selectionHandler) {
      return;
    }
    // A hover RAF can be scheduled by a mousemove that fired *before* a
    // drag began; the callback then runs mid-drag. Re-check authoritative
    // state here so a stale RAF can't paint a face overlay onto the part
    // we're currently dragging.
    if (this.isMouseDown || this.assemblyController?.isDragGestureActive()) {
      return;
    }
    // The pointer sits on a tool handle (gizmo) — part hover must not paint
    // underneath it.
    if (this.hoverSuppressor?.()) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    const result = this.pickAt(clientX, clientY);

    // Origin-plane hover: brighten the quad; anything else clears it.
    if (isPlanePick(result)) {
      if (this.hoverState) {
        this.clearHover();
      }
      if (this.standardPlanes.setHover(result.standardPlane)) {
        this.ctx.requestRender();
      }
      this.ctx.renderer.domElement.style.cursor = 'pointer';
      return;
    }
    if (this.standardPlanes.setHover(null)) {
      this.ctx.renderer.domElement.style.cursor = '';
      this.ctx.requestRender();
    }

    // Track which instance the cursor is on. The controller reveals its
    // connectors only while a mate dialog has picking armed, and otherwise
    // just keeps the id current so an opening dialog reveals the part
    // already under the cursor. Done unconditionally — independent of the
    // face/edge hover dedup paths below — so connectors stay visible while
    // the user moves around within the same part (including over the
    // currently-selected face, which short-circuits the rest of this
    // method).
    this.assemblyController?.setHoveredInstance(result?.instanceId ?? null);

    // Per-instance post-drop suppression: if the user just released the
    // drag and their cursor is still on the dropped instance, don't paint
    // hover on it. As soon as they move to a different instance or off
    // any instance entirely, the suppression lifts.
    if (this.hoverSuppressForInstance) {
      if (result && (result.instanceId ?? null) === this.hoverSuppressForInstance) {
        if (this.hoverState) this.clearHover();
        return;
      }
      this.hoverSuppressForInstance = null;
    }

    // Same as current hover — skip. Include instance id so two instances of
    // the same part don't dedupe against each other.
    if (this.hoverState && result &&
        this.hoverState.shapeId === result.shapeId &&
        this.hoverState.sub?.type === result.sub?.type &&
        this.hoverState.sub?.index === result.sub?.index &&
        this.hoverState.instanceId === (result.instanceId ?? null)) {
      return;
    }

    // Nothing hovered — clear and return.
    if (!result) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    // Don't hover-highlight a currently selected face/edge (same instance).
    const isSelected = this.highlightedEntities.some((entity) =>
      entity.shapeId === result.shapeId &&
      entity.sub.type === result.sub?.type &&
      entity.sub.index === result.sub?.index) &&
      this.highlightedInstanceId === (result.instanceId ?? null);
    if (isSelected) {
      if (this.hoverState) {
        this.clearHover();
      }
      return;
    }

    this.clearHover();
    this.hoverState = { shapeId: result.shapeId, sub: result.sub, instanceId: result.instanceId ?? null };
    this.ctx.renderer.domElement.style.cursor = 'pointer';

    if (result.sub?.type === 'face') {
      this.applyHoverFace(result.shapeId, result.sub.index, result.instanceId ?? null);
    } else if (result.sub?.type === 'edge') {
      this.applyHoverEdge(result.shapeId, result.sub.index, result.instanceId ?? null);
    } else if (result.sub?.type === 'axis') {
      this.applyHoverAxis(result.shapeId);
    } else if (result.sub?.type === 'plane') {
      this.applyHoverPlaneQuad(result.shapeId);
    } else if (result.sub?.type === 'connector') {
      this.assemblyController?.setHighlightedConnector(result.shapeId);
    }
    this.hoverHandler?.(result.shapeId, result.sub, clientX, clientY);
  }

  clearHover(): void {
    // Remove face hover overlays
    for (const m of this.hoverFaceOverlayMeshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
      (m.material as MeshPhongMaterial).dispose();
    }
    this.hoverFaceOverlayMeshes = [];

    // Restore edge hover colors
    this.ctx.scene.traverse((child) => {
      if (child.userData.hoverOriginalColor !== undefined) {
        (child as any).material.color.setHex(child.userData.hoverOriginalColor);
        delete child.userData.hoverOriginalColor;
      }
      if (child.userData.hoverOriginalLineWidth !== undefined) {
        (child as any).material.linewidth = child.userData.hoverOriginalLineWidth;
        delete child.userData.hoverOriginalLineWidth;
      }
      if (child.userData.hoverOriginalOpacity !== undefined) {
        (child as any).material.opacity = child.userData.hoverOriginalOpacity;
        delete child.userData.hoverOriginalOpacity;
      }
    });

    if (this.hoverState?.sub?.type === 'connector') {
      this.assemblyController?.setHighlightedConnector(null);
    }
    if (this.hoverState) {
      this.hoverHandler?.(null, null, 0, 0);
    }
    this.hoverState = null;
    this.standardPlanes.setHover(null);
    this.ctx.renderer.domElement.style.cursor = '';
    this.ctx.requestRender();
  }

  private applyHoverFace(shapeId: string, faceIndex: number, instanceId: string | null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mapping: number[] | undefined = obj.userData.faceMapping;
      if (!mapping) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      const mesh = obj as Mesh;
      const geo = mesh.geometry as BufferGeometry;
      const indexAttr = geo.index;
      if (!indexAttr) {
        return;
      }

      const indices = indexAttr.array;
      const positions = (geo.getAttribute('position').array) as Float32Array;
      const newPositions: number[] = [];

      for (let tri = 0; tri < mapping.length; tri++) {
        if (mapping[tri] === faceIndex) {
          const i0 = (indices[tri * 3] as number) * 3;
          const i1 = (indices[tri * 3 + 1] as number) * 3;
          const i2 = (indices[tri * 3 + 2] as number) * 3;
          newPositions.push(positions[i0], positions[i0 + 1], positions[i0 + 2]);
          newPositions.push(positions[i1], positions[i1 + 1], positions[i1 + 2]);
          newPositions.push(positions[i2], positions[i2 + 1], positions[i2 + 2]);
        }
      }

      if (newPositions.length === 0) {
        return;
      }

      const overlayGeo = new BufferGeometry();
      overlayGeo.setAttribute('position', new BufferAttribute(new Float32Array(newPositions), 3));

      // No depth write, and slotted between solid faces (renderOrder 1) and
      // edge lines (renderOrder 2): edges depth-test against the pushed-back
      // base face and draw on top, so boundaries between two highlighted
      // faces stay visible.
      const overlayMat = new MeshPhongMaterial({
        color: themeColors.highlightColor,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1,
      });

      const overlayMesh = new Mesh(overlayGeo, overlayMat);
      overlayMesh.renderOrder = 1.5;
      (mesh.parent ?? this.ctx.scene).add(overlayMesh);
      this.hoverFaceOverlayMeshes.push(overlayMesh);
    });

    this.ctx.requestRender();
  }

  private applyHoverEdge(shapeId: string, edgeIndex: number, instanceId: string | null): void {
    const scope = this.resolveScope(instanceId);
    if (!scope) return;
    scope.traverse((obj) => {
      if (!(obj as LineSegments).isLine && !obj.userData.isEdgeLine) {
        return;
      }
      if (obj.userData.edgeIndex !== edgeIndex) {
        return;
      }

      let belongsToShape = false;
      let cur: Object3D | null = obj;
      while (cur) {
        if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
          belongsToShape = true;
          break;
        }
        cur = cur.parent;
      }
      if (!belongsToShape) {
        return;
      }

      obj.userData.hoverOriginalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
      obj.userData.hoverOriginalLineWidth = (obj as any).material.linewidth;
      (obj as any).material.linewidth = HOVER_EDGE_LINE_WIDTH;
    });

    this.ctx.requestRender();
  }

  /**
   * Brighten a hovered construction-plane quad (whole plane — planes have no
   * sub-selection): highlight tint plus an opacity bump, since the resting
   * quad is nearly transparent.
   */
  private applyHoverPlaneQuad(shapeId: string): void {
    const quad = this.findMeshByShapeId(shapeId);
    const mat = (quad as any)?.material;
    // A selection-highlighted quad (originalColor saved) keeps its stronger tint.
    if (!quad || !mat || quad.userData.hoverOriginalColor !== undefined
      || quad.userData.originalColor !== undefined) {
      return;
    }
    quad.userData.hoverOriginalColor = mat.color.getHex();
    quad.userData.hoverOriginalOpacity = mat.opacity;
    mat.color.set(themeColors.highlightColor);
    mat.opacity = 0.25;
    this.ctx.requestRender();
  }

  /** Tint a hovered axis line (whole line — axes have no sub-selection). */
  private applyHoverAxis(shapeId: string): void {
    const group = this.findMeshByShapeId(shapeId);
    if (!group) {
      return;
    }
    group.traverse((obj) => {
      if (!obj.userData.isAxisLine || obj.userData.hoverOriginalColor !== undefined) {
        return;
      }
      obj.userData.hoverOriginalColor = (obj as any).material.color.getHex();
      (obj as any).material.color.set(themeColors.highlightColor);
    });
    this.ctx.requestRender();
  }

  showCentroid(pos: { x: number; y: number; z: number }): void {
    const radius = this.computeCentroidRadius();
    this.centroidIndicator.show(this.ctx.scene, pos, radius);
    this.ctx.requestRender();
  }

  clearCentroid(): void {
    this.centroidIndicator.clear(this.ctx.scene);
    this.ctx.requestRender();
  }

  dispose(): void {
    this.ctx.dispose();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute an edge pick threshold in world units equivalent to ~8 screen pixels,
   * so edge selection scales correctly regardless of model size or zoom level.
   */
  private computeEdgePickThreshold(): number {
    const camera = this.ctx.camera;
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const canvasHeight = rect.height || 1;
    const EDGE_PICK_PIXELS = 8;

    let worldHeight: number;
    const cam = camera as any;
    if (cam.isOrthographicCamera) {
      worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
    } else {
      const target = new Vector3();
      this.ctx.cameraControls.getTarget(target);
      const d = camera.position.distanceTo(target);
      const fovRad = (cam.fov * Math.PI) / 180;
      worldHeight = 2 * d * Math.tan(fovRad / 2);
    }

    return (worldHeight / canvasHeight) * EDGE_PICK_PIXELS;
  }

  /** Compute centroid sphere radius as ~1.5 % of the scene diagonal, with a fallback. */
  private computeCentroidRadius(): number {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (compiled) {
      const box = new Box3();
      expandBoxExcludingMeta(box, compiled);
      if (!box.isEmpty()) {
        return box.getSize(new Vector3()).length() * 0.015;
      }
    }
    return worldFromMm(2);
  }

  /** Fit the camera to all scene geometry, excluding meta shapes. */
  private fitViewToScene(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) return;
    const box = new Box3();
    expandBoxExcludingMeta(box, compiled);
    if (!box.isEmpty()) {
      this.ctx.fitToBox(box, true);
    }
  }

  private findShapeById(shapeId: string): SceneObjectPart | undefined {
    for (const obj of this.sceneObjects) {
      for (const part of obj.sceneShapes) {
        if (part.shapeId === shapeId) return part;
      }
    }
    return undefined;
  }

  private findMeshByShapeId(shapeId: string, scope: Object3D = this.ctx.scene): Object3D | undefined {
    let result: Object3D | undefined;
    scope.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        result = child;
      }
    });
    return result;
  }

  /** During rollback the current "active" sketch is the rolled-back target's
   *  sketch ancestor (or the target itself if it is a sketch). Returns null
   *  when the target isn't inside a sketch. */
  private findRollbackActiveSketchId(objects: SceneObjectRender[], rollbackStop?: number): string | null {
    if (rollbackStop == null || rollbackStop < 0 || rollbackStop >= objects.length) {
      return null;
    }
    let current: SceneObjectRender | undefined = objects[rollbackStop];
    while (current) {
      if (current.type === 'sketch') {
        return current.id;
      }
      if (!current.parentId) {
        return null;
      }
      current = objects.find(o => o.id === current!.parentId);
    }
    return null;
  }

  /** Check if a new bounding box is still fully visible within the last fitted (padded) sphere.
   *  Returns true when the new box's circumscribed sphere fits inside the old padded sphere,
   *  meaning we can safely skip re-fitting. */
  private isBoxContained(newBox: Box3): boolean {
    if (!this.lastFitBox) return false;

    const oldCenter = this.lastFitBox.getCenter(new Vector3());
    const oldPaddedRadius =
      this.lastFitBox.getSize(new Vector3()).length() / 2 * FIT_PADDING;
    if (oldPaddedRadius === 0) return false;

    const newCenter = newBox.getCenter(new Vector3());
    const newRadius = newBox.getSize(new Vector3()).length() / 2;

    // The new box is contained when its circumscribed sphere fits within
    // the padded sphere we last fitted to.
    return oldCenter.distanceTo(newCenter) + newRadius <= oldPaddedRadius;
  }

  /** Rebuild the scene mesh using the current scene objects (no mode transitions or auto-fit). */
  rebuildSceneMesh(): void {
    if (!this.sceneObjects) {
      return;
    }
    // In assembly mode, the AssemblyController is the source of truth for
    // geometry — its instance groups already render every referenced part
    // at the right pose with connectors hidden. Building a separate
    // `compiledMesh` here would draw each part again at world origin with
    // its connectors visible (they're not inside an instance group, so the
    // controller's `setConnectorsVisible(false)` never sees them) and the
    // stray mesh would only get cleared on the next assembly update — i.e.
    // the user has to edit the file before the rogue connectors disappear.
    if (this.assemblyController?.getContainer().parent) {
      return;
    }
    this.removeCompiledMesh();
    const mesh = buildSceneMesh(this.sceneObjects, this.activeSketchId, this.ctx.camera, this.isRegionPicking, this.lastRenderIsRollback);
    this.ctx.scene.add(mesh);
    this.applyShapeOverridesAndPrune(this.sceneObjects);
    // The rebuilt materials are un-tinted — reapply the sketch-mode ghosting
    // (as updateView does) or a mid-sketch rebuild (a theme change, region
    // picking) silently drops the dimming until the next full render.
    if (this.activeSketchId) {
      this.applySketchModeGhosting();
    }
    if (this.modeManager.isSketchMode && viewerSettings.current.sectionView) {
      this.applySectionView();
    }
    this.ctx.requestRender();
  }

  setShapeVisibility(shapeId: string, visible: boolean): void {
    if (visible) {
      this.hiddenShapeIds.delete(shapeId);
    } else {
      this.hiddenShapeIds.add(shapeId);
    }
    this.applyVisibilityForId(shapeId, visible);
    this.ctx.requestRender();
  }

  isShapeHidden(shapeId: string): boolean {
    return this.hiddenShapeIds.has(shapeId);
  }

  private applyVisibilityForId(shapeId: string, visible: boolean): void {
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        child.visible = visible;
      }
    });
  }

  setShapeTransparency(shapeId: string, opacity: number): void {
    if (opacity >= 1) {
      this.shapeOpacities.delete(shapeId);
    } else {
      this.shapeOpacities.set(shapeId, opacity);
    }
    this.applyOpacityForId(shapeId, opacity);
    this.ctx.requestRender();
  }

  getShapeTransparency(shapeId: string): number {
    return this.shapeOpacities.get(shapeId) ?? 1;
  }

  resetAllTransparency(): void {
    if (this.shapeOpacities.size === 0) {
      return;
    }
    const ids = Array.from(this.shapeOpacities.keys());
    this.shapeOpacities.clear();
    for (const id of ids) {
      this.applyOpacityForId(id, 1);
    }
    this.ctx.requestRender();
  }

  private applyOpacityForId(shapeId: string, opacity: number): void {
    const roots: Object3D[] = [];
    this.ctx.scene.traverse((child) => {
      if (child.userData.shapeId === shapeId) {
        roots.push(child);
      }
    });
    for (const root of roots) {
      this.applyOpacityToSubtree(root, opacity);
    }
  }

  private applyOpacityToSubtree(root: Object3D, opacity: number): void {
    root.traverse((child) => {
      const mat = (child as any).material;
      if (!mat) {
        return;
      }
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        m.transparent = opacity < 1;
        m.opacity = opacity;
        m.depthWrite = opacity >= 1;
        m.needsUpdate = true;
      }
    });
  }

  private applyShapeOverridesAndPrune(sceneObjects: SceneObjectRender[]): void {
    const presentIds = new Set<string>();
    for (const obj of sceneObjects) {
      if (!obj.sceneShapes) continue;
      for (const shape of obj.sceneShapes) {
        if (shape.isMetaShape) continue;
        if (shape.shapeId) presentIds.add(shape.shapeId);
      }
    }

    for (const id of this.hiddenShapeIds) {
      if (!presentIds.has(id)) this.hiddenShapeIds.delete(id);
    }
    for (const id of this.shapeOpacities.keys()) {
      if (!presentIds.has(id)) this.shapeOpacities.delete(id);
    }

    this.ctx.scene.traverse((child) => {
      const sid = child.userData.shapeId;
      if (typeof sid !== 'string') return;
      if (this.hiddenShapeIds.has(sid)) {
        child.visible = false;
      }
      const opacity = this.shapeOpacities.get(sid);
      if (opacity !== undefined) {
        this.applyOpacityToSubtree(child, opacity);
      }
    });
  }

  // Fake transparency for sketch mode by tinting non-sketch materials toward
  // the scene background. Materials stay fully opaque, so the renderer skips
  // the transparency sort and overdraw blending that was crippling complex
  // scenes. Active sketch subtrees and selection overlays are left untouched.
  private applySketchModeGhosting(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    const bg = themeColors.backgroundColor;
    for (const child of compiled.children) {
      this.tintForGhosting(child, bg);
    }
  }

  private tintForGhosting(node: Object3D, bg: Color): void {
    if (node.userData.isSketchRoot) { return; }
    if (node.renderOrder >= 999) { return; }

    const mat = (node as any).material;
    if (mat) {
      const materials = Array.isArray(mat) ? mat : [mat];
      for (const m of materials) {
        if (!m.color || !(m.color instanceof Color)) { continue; }
        if (!m.userData.ghostOriginalColor) {
          m.userData.ghostOriginalColor = m.color.clone();
        }
        m.color.copy(m.userData.ghostOriginalColor).lerp(bg, SKETCH_GHOST_TINT_FACTOR);
      }
    }

    for (const c of node.children) {
      this.tintForGhosting(c, bg);
    }
  }

  private applySectionView(): void {
    const plane = this.modeManager.sectionPlane;
    if (!plane) { return; }

    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    this.sectionClipper.apply(compiled, plane);

    this.ctx.requestRender();
  }

  private clearSectionView(): void {
    const compiled = this.ctx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return; }

    this.sectionClipper.clear(compiled);

    this.ctx.requestRender();
  }

  /** Remove the previous compiled mesh tree and dispose its GPU resources. */
  private removeCompiledMesh(): void {
    const existing = this.ctx.scene.getObjectByName('compiledMesh');
    if (!existing) return;

    existing.traverse((child: Object3D & { geometry?: any; material?: any }) => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material?.dispose();
      }
    });

    this.ctx.scene.remove(existing);
  }
}
