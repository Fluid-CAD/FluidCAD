import { AxesHelper, Matrix4, Object3D, Plane, Vector3 } from 'three';
import InfiniteGridHelper from '../helpers/infinit-grid';
import { PlaneData, Vec3Data } from '../types';
import { SceneContext } from './scene-context';
import { viewerSettings } from './viewer-settings';
import { themeColors, onThemeChange } from './theme-colors';

const Z_UP = new Vector3(0, 0, 1);
const DEFAULT_CAMERA_POSITION = new Vector3(50, -50, 40);
const SKETCH_CAMERA_DISTANCE = 50;

export type SceneMode = 'default' | 'sketch';

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
  private _sectionPlane: Plane | null = null;

  constructor(private ctx: SceneContext) {
    this.setupDefaultAxes();
    this.setupGrid(Z_UP);

    viewerSettings.subscribe(() => this.applyGridVisibility());

    // Rebuild grid when theme changes so grid color updates
    onThemeChange(() => this.rebuildGrid());
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

  // -------------------------------------------------------------------------
  // Public mode transitions
  // -------------------------------------------------------------------------

  enterDefaultMode(): void {
    if (this.mode === 'sketch') {
      this._sectionPlane = null;
      this.restoreCamera();

      // Restore perspective if it was active before sketch mode
      if (this.cameraBackupMode === 'perspective') {
        this.ctx.switchCamera('perspective');
        viewerSettings.update({ cameraMode: 'perspective' });
      }
      this.cameraBackupMode = null;
    }

    this.mode = 'default';

    this.ctx.camera.up.copy(Object3D.DEFAULT_UP);
    this.ctx.cameraControls.updateCameraUp();

    this.showDefaultAxes();
    this.setupGrid(Z_UP);
  }

  enterSketchMode(plane: PlaneData): void {
    if (!this.enabled) return;

    this.mode = 'sketch';

    // Force orthographic for sketch mode
    if (viewerSettings.current.cameraMode === 'perspective') {
      this.cameraBackupMode = 'perspective';
      this.ctx.switchCamera('orthographic');
    }

    this.positionCameraForSketch(plane);
    this.showSketchAxes(plane);

    const normal = toVec3(plane.normal);
    const origin = toVec3(plane.origin);
    this.setupGrid(normal, origin.add(normal.clone().multiplyScalar(-0.01)));

    this.createSectionPlane(plane);
  }

  /** Snap the camera back along the sketch normal, preserving target and zoom. */
  enforceSketchNormal(plane: PlaneData): void {
    const cc = this.ctx.cameraControls;

    const normal = toVec3(plane.normal);
    const yDir = toVec3(plane.yDirection);

    const tgt = new Vector3();
    cc.getTarget(tgt);

    const camPos = tgt.clone().add(normal.clone().multiplyScalar(SKETCH_CAMERA_DISTANCE));

    this.ctx.camera.up.copy(yDir);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(camPos.x, camPos.y, camPos.z, tgt.x, tgt.y, tgt.z, false);

    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;

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

    const camPos = center.clone().add(normal.clone().multiplyScalar(SKETCH_CAMERA_DISTANCE));

    // Set up vector BEFORE setLookAt so camera-controls computes correct orientation
    this.ctx.camera.up.copy(yDir);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(camPos.x, camPos.y, camPos.z, center.x, center.y, center.z, false);

    // Keep adapter target in sync
    cc.getTarget(this.ctx.controls.target);
    this.ctx.gizmo.target = this.ctx.controls.target;
  }

  private restoreCamera(): void {
    const cc = this.ctx.cameraControls;
    const backup = this.cameraBackup;
    const position = backup?.position ?? DEFAULT_CAMERA_POSITION.clone();
    const target = backup?.target ?? new Vector3(0, 0, 0);

    // Set up vector BEFORE setLookAt so camera-controls computes correct orientation
    this.ctx.camera.up.copy(Object3D.DEFAULT_UP);
    cc.updateCameraUp();

    cc.normalizeRotations();
    cc.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);

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

  private showSketchAxes(plane: PlaneData): void {
    const defaultAxes = this.ctx.scene.getObjectByName('defaultAxesHelper');
    if (defaultAxes) defaultAxes.visible = false;

    this.removeByName('sketchAxesHelper');

    const axes = new AxesHelper(1000);
    axes.name = 'sketchAxesHelper';

    const origin = toVec3(plane.origin);
    const xDir = toVec3(plane.xDirection);
    const yDir = toVec3(plane.yDirection);
    const normal = toVec3(plane.normal);

    const matrix = new Matrix4().makeBasis(xDir, yDir, normal);
    matrix.setPosition(origin);
    axes.matrix.copy(matrix);
    axes.matrixAutoUpdate = false;

    this.ctx.scene.add(axes);
  }

  // -------------------------------------------------------------------------
  // Grid
  // -------------------------------------------------------------------------

  private rebuildGrid(): void {
    this.setupGrid(this.lastGridNormal, this.lastGridPosition);
    this.ctx.requestRender();
  }

  private setupGrid(normal: Vector3, position?: Vector3): void {
    this.lastGridNormal = normal.clone();
    this.lastGridPosition = position?.clone();
    this.removeByName('grid');

    const grid = new InfiniteGridHelper(10, 100, themeColors.gridColor, 100000, normal);
    grid.name = 'grid';

    if (position) {
      grid.position.copy(position);
    }

    grid.visible = this.mode === 'sketch' || viewerSettings.current.showGrid;
    this.ctx.scene.add(grid);
  }

  private applyGridVisibility(): void {
    const grid = this.ctx.scene.getObjectByName('grid');
    if (grid) {
      grid.visible = this.mode === 'sketch' || viewerSettings.current.showGrid;
      this.ctx.requestRender();
    }
  }

  // -------------------------------------------------------------------------
  // Util
  // -------------------------------------------------------------------------

  private createSectionPlane(plane: PlaneData): void {
    const normal = toVec3(plane.normal).negate();
    const origin = toVec3(plane.origin).add(toVec3(plane.normal).multiplyScalar(0.1));
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
