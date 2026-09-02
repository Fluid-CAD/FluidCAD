import {
  AxesHelper,
  BufferGeometry,
  CircleGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Plane,
  RingGeometry,
  Vector3,
} from 'three';
import InfiniteGridHelper, { GridFrame } from '../helpers/infinit-grid';
import { PlaneData, Vec3Data } from '../types';
import { SceneContext } from './scene-context';
import { viewerSettings } from './viewer-settings';
import { themeColors, onThemeChange } from './theme-colors';
import { applyConstantPixelSize, getViewportHeightPx, worldUnitsPerPixel } from '../meshes/screen-scale';
import { worldFromMm } from '../units/scene-scale';
import { sceneUnit } from '../units/scene-unit';
import { resolveGridSpacing } from '../grid/grid-spacing';
import type { GridSpacing } from '../grid/grid-spacing';
import { currentGridPrefs } from '../grid/grid-prefs';

const Z_UP = new Vector3(0, 0, 1);
// Camera stand-offs in mm, converted per document unit at use time.
const DEFAULT_CAMERA_POSITION_MM = new Vector3(50, -50, 40);
const SKETCH_CAMERA_DISTANCE_MM = 50;
/** Initial grid extent / fade radius in mm-equivalent — re-derived from
 * the zoom on every camera change (see updateGridSpacing). */
const GRID_FADE_DISTANCE_MM = 100000;
/** Grid extent as a multiple of the visible height: ~100 m at the 120 mm
 * default view (what the fixed 100000 gave), and small enough when zoomed
 * in that the shader's interpolated coordinates keep the precision a
 * sub-millimetre lattice needs. */
const GRID_EXTENT_VIEW_HEIGHTS = 800;

/** Eye-to-target distance when looking down a sketch plane. */
export function sketchCameraDistance(): number {
  return worldFromMm(SKETCH_CAMERA_DISTANCE_MM);
}

function defaultCameraPosition(): Vector3 {
  return DEFAULT_CAMERA_POSITION_MM.clone().multiplyScalar(worldFromMm(1));
}

// Sketch datum visuals: the x/y axis lines through the sketch origin and the
// origin marker. Both directions, matching the reach of the old AxesHelper.
const AXIS_EXTENT = 1000;
const AXIS_OPACITY = 0.55;
/** Nudge the datum visuals just below the sketch plane (the grid sits at
 * −0.01) so sketch geometry drawn ON an axis renders cleanly above it. */
const DATUM_PLANE_OFFSET = -0.005;
const ORIGIN_MARKER_PX = 10;
/** Marker geometry radius in mm — paired with the pixel size above, so it
 * only has to be the document's order of magnitude. */
const ORIGIN_MARKER_MM = 3;

export type SceneMode = 'default' | 'sketch';

type GridSpacingListener = (spacing: GridSpacing | null, visible: boolean) => void;

function toVec3(v: Vec3Data): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

/**
 * Manages the two scene modes (default 3D view vs. sketch editing) and
 * coordinates all the pieces that change between them: camera position/up,
 * orbit target, grid orientation, and axes helper.
 */
export class SceneModeManager {
  private mode: SceneMode = 'default';
  private cameraBackup: { position: Vector3; target: Vector3 } | null = null;
  private cameraBackupMode: 'perspective' | 'orthographic' | null = null;
  private enabled = true;
  private lastGridNormal = Z_UP.clone();
  private lastGridPosition: Vector3 | undefined;
  private lastGridFrame: GridFrame | undefined;
  /** The plane of the current sketch session — datum visuals rebuild from it
   * on theme changes. */
  private lastSketchPlane: PlaneData | null = null;
  private _sectionPlane: Plane | null = null;
  private gridSpacing: GridSpacing | null = null;
  private gridListeners = new Set<GridSpacingListener>();

  constructor(private ctx: SceneContext) {
    this.setupDefaultAxes();
    this.setupGrid(Z_UP);

    viewerSettings.subscribe(() => {
      this.applyGridVisibility();
      // Adaptive/fixed mode or the pitch prefs may have changed.
      this.updateGridSpacing();
    });
    // The pitch is a function of zoom — re-derive on every view change
    // (plain arithmetic, no debounce needed) and when the unit swaps.
    this.ctx.subscribeCameraChange(() => this.updateGridSpacing());
    sceneUnit.subscribe(() => this.updateGridSpacing());

    // Rebuild theme-colored scene furniture (grid, sketch datums) on switch
    onThemeChange(() => {
      this.rebuildGrid();
      if (this.mode === 'sketch' && this.lastSketchPlane) {
        this.showSketchAxes(this.lastSketchPlane);
        this.ctx.requestRender();
      }
    });
  }

  get currentMode(): SceneMode {
    return this.mode;
  }

  get isSketchMode(): boolean {
    return this.mode === 'sketch';
  }

  get sectionPlane(): Plane | null {
    return this._sectionPlane;
  }

  set sketchEnabled(value: boolean) {
    this.enabled = value;
  }

  get sketchEnabled(): boolean {
    return this.enabled;
  }

  // -------------------------------------------------------------------------
  // Public mode transitions
  // -------------------------------------------------------------------------

  enterDefaultMode(): void {
    this.ctx.setRotationLocked(false);
    if (this.mode === 'sketch') {
      this._sectionPlane = null;

      // Restore perspective BEFORE the animated camera restore: switchCamera
      // rebuilds the CameraControls instance with an instant setLookAt, which
      // would cut the restore transition short if it ran second.
      if (this.cameraBackupMode === 'perspective') {
        this.ctx.switchCamera('perspective');
        viewerSettings.update({ cameraMode: 'perspective' });
      }
      this.cameraBackupMode = null;

      this.restoreCamera();
    }

    this.mode = 'default';
    this.lastSketchPlane = null;

    this.ctx.camera.up.copy(Object3D.DEFAULT_UP);
    this.ctx.cameraControls.updateCameraUp();

    this.showDefaultAxes();
    this.setupGrid(Z_UP);
  }

  enterSketchMode(plane: PlaneData): void {
    if (!this.enabled) return;

    this.mode = 'sketch';

    this.ctx.setRotationLocked(viewerSettings.current.sketchLockCamera);

    // Force orthographic for sketch mode
    if (viewerSettings.current.cameraMode === 'perspective') {
      this.cameraBackupMode = 'perspective';
      this.ctx.switchCamera('orthographic');
    }

    this.positionCameraForSketch(plane);
    this.showSketchAxes(plane);

    const normal = toVec3(plane.normal);
    const origin = toVec3(plane.origin);
    this.setupGrid(normal, origin.clone().add(normal.clone().multiplyScalar(-0.01)), {
      xDirection: toVec3(plane.xDirection),
      origin,
    });

    this.createSectionPlane(plane);
  }

  /** Swing the camera back along the sketch normal, preserving target and zoom. */
  enforceSketchNormal(plane: PlaneData): void {
    const cc = this.ctx.cameraControls;

    const normal = toVec3(plane.normal);
    const yDir = toVec3(plane.yDirection);

    const tgt = new Vector3();
    cc.getTarget(tgt);

    const camPos = tgt.clone().add(normal.clone().multiplyScalar(sketchCameraDistance()));

    this.ctx.camera.up.copy(yDir);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(camPos.x, camPos.y, camPos.z, tgt.x, tgt.y, tgt.z, true);

    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;

    this.showSketchAxes(plane);

    const origin = toVec3(plane.origin);
    this.setupGrid(normal, origin.clone().add(normal.clone().multiplyScalar(-0.01)), {
      xDirection: toVec3(plane.xDirection),
      origin,
    });

    this.createSectionPlane(plane);
  }

  // -------------------------------------------------------------------------
  // Camera helpers
  // -------------------------------------------------------------------------

  private positionCameraForSketch(plane: PlaneData): void {
    const cc = this.ctx.cameraControls;

    // Backup current position and target
    if (!this.cameraBackup) {
      const pos = new Vector3();
      const tgt = new Vector3();
      cc.getPosition(pos);
      cc.getTarget(tgt);
      this.cameraBackup = { position: pos, target: tgt };
    }

    const center = toVec3(plane.center);
    const normal = toVec3(plane.normal);
    const yDir = toVec3(plane.yDirection);

    const camPos = center.clone().add(normal.clone().multiplyScalar(sketchCameraDistance()));

    // Set up vector BEFORE setLookAt so camera-controls computes correct orientation
    this.ctx.camera.up.copy(yDir);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(camPos.x, camPos.y, camPos.z, center.x, center.y, center.z, true);

    // Keep adapter target in sync
    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;
  }

  private restoreCamera(): void {
    const cc = this.ctx.cameraControls;
    const backup = this.cameraBackup;
    const position = backup?.position ?? defaultCameraPosition();
    const target = backup?.target ?? new Vector3(0, 0, 0);

    // Set up vector BEFORE setLookAt so camera-controls computes correct orientation
    this.ctx.camera.up.copy(Object3D.DEFAULT_UP);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, true);

    // Keep adapter target in sync
    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;

    this.cameraBackup = null;
  }

  // -------------------------------------------------------------------------
  // Axes helpers
  // -------------------------------------------------------------------------

  private setupDefaultAxes(): void {
    const axes = new AxesHelper(1000);
    axes.name = 'defaultAxesHelper';
    this.ctx.scene.add(axes);
  }

  private showDefaultAxes(): void {
    this.removeByName('sketchAxesHelper');
    const axes = this.ctx.scene.getObjectByName('defaultAxesHelper');
    if (axes) axes.visible = true;
  }

  /**
   * The sketch datum visuals: x/y axis lines through the sketch origin (both
   * directions, plane-frame aligned) and the origin marker at local (0,0) —
   * what the solver's implicit datum entities look like. Replaces the old
   * one-directional AxesHelper rays; the out-of-plane normal ray is gone on
   * purpose (grid + axes carry the orientation story). Hover/pick of the
   * datums is analytic 2D in the sketch handler — these meshes are visuals,
   * found by userData for hover highlighting only.
   */
  private showSketchAxes(plane: PlaneData): void {
    const defaultAxes = this.ctx.scene.getObjectByName('defaultAxesHelper');
    if (defaultAxes) defaultAxes.visible = false;

    this.removeByName('sketchAxesHelper');
    this.lastSketchPlane = plane;

    const normal = toVec3(plane.normal).normalize();
    const origin = toVec3(plane.origin).add(normal.clone().multiplyScalar(DATUM_PLANE_OFFSET));
    const xDir = toVec3(plane.xDirection).normalize();
    const yDir = toVec3(plane.yDirection).normalize();

    const group = new Group();
    group.name = 'sketchAxesHelper';
    // Scene furniture, not model content — keep it out of camera fits.
    group.userData.isMetaShape = true;

    group.add(this.buildAxisLine(origin, xDir, themeColors.sketchAxisXColor.getHex(), 'x-axis'));
    group.add(this.buildAxisLine(origin, yDir, themeColors.sketchAxisYColor.getHex(), 'y-axis'));
    group.add(this.buildOriginMarker(origin, normal));

    this.ctx.scene.add(group);
  }

  private buildAxisLine(origin: Vector3, dir: Vector3, color: number, datum: 'x-axis' | 'y-axis'): Line {
    const geometry = new BufferGeometry().setFromPoints([
      origin.clone().addScaledVector(dir, -AXIS_EXTENT),
      origin.clone().addScaledVector(dir, AXIS_EXTENT),
    ]);
    const material = new LineBasicMaterial({
      color,
      transparent: true,
      opacity: AXIS_OPACITY,
      depthWrite: false,
    });
    const line = new Line(geometry, material);
    line.userData.isSketchDatumAxis = true;
    line.userData.datum = datum;
    return line;
  }

  private buildOriginMarker(origin: Vector3, normal: Vector3): Group {
    const color = themeColors.sketchOriginColor.getHex();
    const markerUnits = worldFromMm(ORIGIN_MARKER_MM);
    const ring = new Mesh(
      new RingGeometry(markerUnits * 0.72, markerUnits, 32),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
    );
    const dot = new Mesh(
      new CircleGeometry(markerUnits * 0.28, 24),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
    );
    ring.renderOrder = 2;
    dot.renderOrder = 2;

    const marker = new Group();
    marker.renderOrder = 2;
    marker.userData.isSketchOriginMarker = true;
    marker.userData.datum = 'origin';
    marker.add(ring);
    marker.add(dot);
    marker.position.copy(origin);
    marker.lookAt(origin.clone().add(normal));
    applyConstantPixelSize(ring, marker, marker.position, ORIGIN_MARKER_PX, markerUnits);
    return marker;
  }

  // -------------------------------------------------------------------------
  // Grid
  // -------------------------------------------------------------------------

  private rebuildGrid(): void {
    this.setupGrid(this.lastGridNormal, this.lastGridPosition, this.lastGridFrame);
    this.ctx.requestRender();
  }

  private setupGrid(normal: Vector3, position?: Vector3, frame?: GridFrame): void {
    this.lastGridNormal = normal.clone();
    this.lastGridPosition = position?.clone();
    this.lastGridFrame = frame
      ? { xDirection: frame.xDirection.clone(), origin: frame.origin.clone() }
      : undefined;
    this.removeByName('grid');

    const spacing = this.resolveSpacing();
    const grid = new InfiniteGridHelper(
      spacing.minor,
      spacing.major,
      themeColors.gridColor,
      worldFromMm(GRID_FADE_DISTANCE_MM),
      normal,
      frame,
    );
    grid.name = 'grid';

    if (position) {
      grid.position.copy(position);
    }

    grid.visible = this.gridVisible;
    this.ctx.scene.add(grid);
    this.publishGridSpacing(spacing);
  }

  private get gridVisible(): boolean {
    return this.mode === 'sketch' || viewerSettings.current.showGrid;
  }

  private applyGridVisibility(): void {
    const grid = this.ctx.scene.getObjectByName('grid');
    if (grid) {
      grid.visible = this.gridVisible;
      this.ctx.requestRender();
    }
    this.publishGridSpacing(this.gridSpacing);
  }

  /**
   * The grid pitch for the current zoom, from the shared resolver the
   * snapper also calls — one lattice, drawn and snapped. Zoom is measured
   * at the orbit target (the sketch plane in sketch mode).
   */
  private resolveSpacing(): GridSpacing {
    return resolveGridSpacing(sceneUnit.current, this.zoom().wupp, currentGridPrefs());
  }

  /** Document units per pixel and the visible height, at the orbit target. */
  private zoom(): { wupp: number; viewHeight: number } {
    const focus = this.ctx.cameraControls.getTarget(new Vector3());
    const heightPx = getViewportHeightPx(this.ctx.renderer);
    const wupp = worldUnitsPerPixel(this.ctx.camera, heightPx, focus);
    return { wupp, viewHeight: wupp * heightPx };
  }

  private updateGridSpacing(): void {
    const grid = this.ctx.scene.getObjectByName('grid') as InfiniteGridHelper | undefined;
    if (!grid) {
      return;
    }
    const { wupp, viewHeight } = this.zoom();
    if (Number.isFinite(viewHeight) && viewHeight > 0) {
      grid.setExtent(viewHeight * GRID_EXTENT_VIEW_HEIGHTS);
    }
    const spacing = resolveGridSpacing(sceneUnit.current, wupp, currentGridPrefs());
    if (this.gridSpacing && spacing.minor === this.gridSpacing.minor && spacing.major === this.gridSpacing.major) {
      return;
    }
    grid.setSpacing(spacing.minor, spacing.major);
    this.publishGridSpacing(spacing);
    this.ctx.requestRender();
  }

  private publishGridSpacing(spacing: GridSpacing | null): void {
    this.gridSpacing = spacing;
    for (const fn of this.gridListeners) {
      fn(spacing, this.gridVisible);
    }
  }

  /**
   * Follow the drawn grid's pitch and visibility (the scale-bar readout).
   * Fires immediately with the current state.
   */
  subscribeGridSpacing(fn: GridSpacingListener): () => void {
    this.gridListeners.add(fn);
    fn(this.gridSpacing, this.gridVisible);
    return () => {
      this.gridListeners.delete(fn);
    };
  }

  // -------------------------------------------------------------------------
  // Util
  // -------------------------------------------------------------------------

  private createSectionPlane(plane: PlaneData): void {
    const normal = toVec3(plane.normal).negate();
    const origin = toVec3(plane.origin);
    if (!this._sectionPlane) {
      this._sectionPlane = new Plane();
    }
    this._sectionPlane.setFromNormalAndCoplanarPoint(normal, origin);
  }

  private removeByName(name: string): void {
    const obj = this.ctx.scene.getObjectByName(name);
    if (obj) this.ctx.scene.remove(obj);
  }
}
