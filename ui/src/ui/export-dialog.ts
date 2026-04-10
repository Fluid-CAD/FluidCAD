import {
  ACESFilmicToneMapping,
  Box3,
  Object3D,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { SceneContext } from '../scene/scene-context';

const CLOSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

export class ExportDialog {
  private overlay: HTMLDivElement;
  private pillsContainer: HTMLDivElement;
  private stepSection: HTMLDivElement;
  private stlSection: HTMLDivElement;
  private pngSection: HTMLDivElement;
  private includeColorsToggle: HTMLInputElement;
  private resolutionSelect: HTMLSelectElement;
  private customSection: HTMLDivElement;
  private angularInput: HTMLInputElement;
  private linearInput: HTMLInputElement;
  private showGridToggle: HTMLInputElement;
  private showAxesToggle: HTMLInputElement;
  private transparentToggle: HTMLInputElement;
  private autoCropToggle: HTMLInputElement;
  private marginSection: HTMLDivElement;
  private marginInput: HTMLInputElement;
  private widthInput: HTMLInputElement;
  private heightInput: HTMLInputElement;
  private exportBtn: HTMLButtonElement;
  private statusEl: HTMLDivElement;
  private shapeIds: string[] = [];
  private selectedFormat: string = 'step';

  constructor(container: HTMLElement, private sceneCtx: SceneContext) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.pillsContainer = this.overlay.querySelector('[data-ref="format-pills"]')!;
    this.stepSection = this.overlay.querySelector('[data-ref="step-section"]')!;
    this.stlSection = this.overlay.querySelector('[data-ref="stl-section"]')!;
    this.pngSection = this.overlay.querySelector('[data-ref="png-section"]')!;
    this.includeColorsToggle = this.overlay.querySelector('[data-ref="include-colors"]')!;
    this.resolutionSelect = this.overlay.querySelector('[data-ref="resolution"]')!;
    this.customSection = this.overlay.querySelector('[data-ref="custom-section"]')!;
    this.angularInput = this.overlay.querySelector('[data-ref="angular"]')!;
    this.linearInput = this.overlay.querySelector('[data-ref="linear"]')!;
    this.showGridToggle = this.overlay.querySelector('[data-ref="show-grid"]')!;
    this.showAxesToggle = this.overlay.querySelector('[data-ref="show-axes"]')!;
    this.transparentToggle = this.overlay.querySelector('[data-ref="transparent"]')!;
    this.autoCropToggle = this.overlay.querySelector('[data-ref="auto-crop"]')!;
    this.marginSection = this.overlay.querySelector('[data-ref="margin-section"]')!;
    this.marginInput = this.overlay.querySelector('[data-ref="margin"]')!;
    this.widthInput = this.overlay.querySelector('[data-ref="png-width"]')!;
    this.heightInput = this.overlay.querySelector('[data-ref="png-height"]')!;
    this.exportBtn = this.overlay.querySelector('[data-ref="export-btn"]')!;
    this.statusEl = this.overlay.querySelector('[data-ref="status"]')!;

    this.bindEvents();
  }

  show(shapeIds: string[]): void {
    this.shapeIds = shapeIds;
    this.statusEl.classList.add('hidden');
    this.exportBtn.disabled = false;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[380px] bg-base-100 border border-white/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-medium text-base-content/90">Export</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${CLOSE_SVG}</span>
          </button>
        </div>

        <div class="flex flex-col gap-3">
          <div>
            <label class="text-xs text-base-content/60 mb-1.5 block">Format</label>
            <div data-ref="format-pills" class="join w-full">
              <input class="join-item btn btn-sm flex-1" type="radio" name="export-format" aria-label="STEP" data-format="step" checked />
              <input class="join-item btn btn-sm flex-1" type="radio" name="export-format" aria-label="STL" data-format="stl" />
              <input class="join-item btn btn-sm flex-1" type="radio" name="export-format" aria-label="PNG" data-format="png" />
            </div>
          </div>

          <div data-ref="step-section">
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Include colors</span>
              <input type="checkbox" data-ref="include-colors" class="toggle toggle-sm toggle-primary" checked />
            </label>
          </div>

          <div data-ref="stl-section" class="hidden flex flex-col gap-3">
            <div>
              <label class="text-xs text-base-content/60 mb-1 block">Resolution</label>
              <select data-ref="resolution" class="select select-sm select-bordered w-full">
                <option value="coarse">Coarse</option>
                <option value="medium" selected>Medium</option>
                <option value="fine">Fine</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div data-ref="custom-section" class="hidden flex gap-2">
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Angular Deflection (deg)</label>
                <input data-ref="angular" type="number" class="input input-sm input-bordered w-full" value="17" min="1" max="90" step="1" />
              </div>
              <div class="flex-1">
                <label class="text-xs text-base-content/60 mb-1 block">Linear Deflection (mm)</label>
                <input data-ref="linear" type="number" class="input input-sm input-bordered w-full" value="0.3" min="0.001" max="10" step="0.01" />
              </div>
            </div>
          </div>

          <div data-ref="png-section" class="hidden flex flex-col gap-3">
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Show grid</span>
              <input type="checkbox" data-ref="show-grid" class="toggle toggle-sm toggle-primary" />
            </label>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Show axes</span>
              <input type="checkbox" data-ref="show-axes" class="toggle toggle-sm toggle-primary" />
            </label>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Transparent background</span>
              <input type="checkbox" data-ref="transparent" class="toggle toggle-sm toggle-primary" />
            </label>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Auto crop</span>
              <input type="checkbox" data-ref="auto-crop" class="toggle toggle-sm toggle-primary" />
            </label>
            <div data-ref="margin-section" class="hidden">
              <label class="text-xs text-base-content/60 mb-1 block">Margin (px)</label>
              <input data-ref="margin" type="number" class="input input-sm input-bordered w-full" value="20" min="0" max="1000" />
            </div>
            <div>
              <label class="text-xs text-base-content/60 mb-1 block">Size (px)</label>
              <div class="flex items-center gap-2">
                <input data-ref="png-width" type="number" class="input input-sm input-bordered w-full" value="800" min="1" max="8192" />
                <span class="text-xs text-base-content/40">&times;</span>
                <input data-ref="png-height" type="number" class="input input-sm input-bordered w-full" value="800" min="1" max="8192" />
              </div>
            </div>
          </div>
        </div>

        <div data-ref="status" class="hidden flex items-center gap-2 mt-3 text-xs text-base-content/60">
          <span class="loading loading-spinner loading-xs"></span>
          <span>Exporting...</span>
        </div>

        <div class="flex justify-end gap-2 mt-4">
          <button data-ref="cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="export-btn" class="btn btn-primary btn-sm">Export</button>
        </div>
      </div>
    `;
  }

  private setFormat(format: string): void {
    this.selectedFormat = format;
    this.stepSection.classList.toggle('hidden', format !== 'step');
    this.stlSection.classList.toggle('hidden', format !== 'stl');
    this.pngSection.classList.toggle('hidden', format !== 'png');
  }

  private bindEvents(): void {
    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="cancel-btn"]')!.addEventListener('click', () => this.hide());

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });

    this.pillsContainer.querySelectorAll<HTMLInputElement>('[data-format]').forEach((radio) => {
      radio.addEventListener('change', () => this.setFormat(radio.dataset.format!));
    });

    this.resolutionSelect.addEventListener('change', () => {
      this.customSection.classList.toggle('hidden', this.resolutionSelect.value !== 'custom');
    });

    this.autoCropToggle.addEventListener('change', () => {
      this.marginSection.classList.toggle('hidden', !this.autoCropToggle.checked);
    });

    this.exportBtn.addEventListener('click', () => this.onExport());
  }

  private async onExport(): Promise<void> {
    if (this.selectedFormat === 'png') {
      return this.exportPng();
    }

    const format = this.selectedFormat;
    const body: Record<string, any> = { format, shapeIds: this.shapeIds };

    if (format === 'step') {
      body.includeColors = this.includeColorsToggle.checked;
    } else {
      body.resolution = this.resolutionSelect.value;
      if (body.resolution === 'custom') {
        body.customAngularDeflectionDeg = parseFloat(this.angularInput.value);
        body.customLinearDeflection = parseFloat(this.linearInput.value);
      }
    }

    this.exportBtn.disabled = true;
    this.statusEl.classList.remove('hidden');
    this.statusEl.innerHTML = '<span class="loading loading-spinner loading-xs"></span><span>Exporting...</span>';

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Export failed');
      }

      const blob = await res.blob();
      const ext = format === 'step' ? '.step' : '.stl';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      this.hide();
    } catch (err: any) {
      this.statusEl.innerHTML = `<span class="text-error text-xs">${err.message}</span>`;
    } finally {
      this.exportBtn.disabled = false;
    }
  }

  private exportPng(): void {
    const width = Math.max(1, Math.min(8192, parseInt(this.widthInput.value) || 800));
    const height = Math.max(1, Math.min(8192, parseInt(this.heightInput.value) || 800));
    const showGrid = this.showGridToggle.checked;
    const showAxes = this.showAxesToggle.checked;
    const transparent = this.transparentToggle.checked;
    const autoCrop = this.autoCropToggle.checked;
    const margin = autoCrop ? Math.max(0, parseInt(this.marginInput.value) || 0) : 0;

    const scene = this.sceneCtx.scene;
    const camera = this.sceneCtx.camera;

    // Save scene state
    const gridObj = scene.getObjectByName('grid');
    const defaultAxes = scene.getObjectByName('defaultAxesHelper');
    const sketchAxes = scene.getObjectByName('sketchAxesHelper');

    const savedGrid = gridObj?.visible;
    const savedDefaultAxes = defaultAxes?.visible;
    const savedSketchAxes = sketchAxes?.visible;
    const savedBackground = scene.background;

    // Apply export settings
    if (gridObj) { gridObj.visible = showGrid; }
    if (defaultAxes) { defaultAxes.visible = showAxes; }
    if (sketchAxes) { sketchAxes.visible = showAxes; }
    if (transparent) { scene.background = null; }

    // Adjust camera projection for export aspect ratio
    const exportAspect = width / height;
    const cam = camera as any;
    let savedCameraState: any;
    if (cam.isOrthographicCamera) {
      savedCameraState = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom };
      const currentHeight = cam.top - cam.bottom;
      cam.left = -exportAspect * currentHeight / 2;
      cam.right = exportAspect * currentHeight / 2;
      cam.updateProjectionMatrix();
    } else {
      savedCameraState = { aspect: cam.aspect };
      cam.aspect = exportAspect;
      cam.updateProjectionMatrix();
    }

    // Create off-screen renderer
    const tmpRenderer = new WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    tmpRenderer.setSize(width, height);
    tmpRenderer.setPixelRatio(1);
    tmpRenderer.toneMapping = ACESFilmicToneMapping;
    tmpRenderer.outputColorSpace = SRGBColorSpace;

    // Update light position to match current view
    const dir = new Vector3();
    camera.getWorldDirection(dir);
    scene.traverse((obj) => {
      if ((obj as any).isDirectionalLight) {
        obj.position.copy(dir.clone().multiplyScalar(-10));
      }
    });

    // Render
    tmpRenderer.render(scene, camera);

    // Determine the canvas to export (full or cropped)
    let exportCanvas: HTMLCanvasElement = tmpRenderer.domElement;

    if (autoCrop) {
      const cropRect = this.computeCropRect(width, height, margin);
      if (cropRect) {
        const cropped = document.createElement('canvas');
        cropped.width = cropRect.w;
        cropped.height = cropRect.h;
        const ctx2d = cropped.getContext('2d')!;
        ctx2d.drawImage(tmpRenderer.domElement, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, cropRect.w, cropRect.h);
        exportCanvas = cropped;
      }
    }

    // Extract PNG and download
    this.exportBtn.disabled = true;
    exportCanvas.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'export.png';
        a.click();
        URL.revokeObjectURL(url);
      }
      this.exportBtn.disabled = false;
      this.hide();
    }, 'image/png');

    // Restore scene state
    if (gridObj) { gridObj.visible = savedGrid!; }
    if (defaultAxes) { defaultAxes.visible = savedDefaultAxes!; }
    if (sketchAxes) { sketchAxes.visible = savedSketchAxes!; }
    scene.background = savedBackground;

    // Restore camera projection
    if (cam.isOrthographicCamera) {
      cam.left = savedCameraState.left;
      cam.right = savedCameraState.right;
      cam.top = savedCameraState.top;
      cam.bottom = savedCameraState.bottom;
    } else {
      cam.aspect = savedCameraState.aspect;
    }
    cam.updateProjectionMatrix();

    // Dispose off-screen renderer and refresh viewport
    tmpRenderer.dispose();
    this.sceneCtx.requestRender();
  }

  /**
   * Compute the crop rectangle by projecting the mesh bounding box onto screen space.
   * Returns pixel coordinates {x, y, w, h} or null if no mesh geometry is found.
   */
  private computeCropRect(canvasW: number, canvasH: number, margin: number): { x: number; y: number; w: number; h: number } | null {
    const compiled = this.sceneCtx.scene.getObjectByName('compiledMesh');
    if (!compiled) { return null; }

    const box = new Box3();
    this.expandBounds(box, compiled);
    if (box.isEmpty()) { return null; }

    // Project the 8 corners of the 3D bounding box to screen pixel coordinates
    const camera = this.sceneCtx.camera;
    const corners = [
      new Vector3(box.min.x, box.min.y, box.min.z),
      new Vector3(box.max.x, box.min.y, box.min.z),
      new Vector3(box.min.x, box.max.y, box.min.z),
      new Vector3(box.max.x, box.max.y, box.min.z),
      new Vector3(box.min.x, box.min.y, box.max.z),
      new Vector3(box.max.x, box.min.y, box.max.z),
      new Vector3(box.min.x, box.max.y, box.max.z),
      new Vector3(box.max.x, box.max.y, box.max.z),
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const c of corners) {
      c.project(camera);
      const px = (c.x + 1) / 2 * canvasW;
      const py = (1 - c.y) / 2 * canvasH;
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }

    // Apply margin and clamp to canvas bounds
    const x = Math.max(0, Math.floor(minX - margin));
    const y = Math.max(0, Math.floor(minY - margin));
    const x2 = Math.min(canvasW, Math.ceil(maxX + margin));
    const y2 = Math.min(canvasH, Math.ceil(maxY + margin));
    const w = x2 - x;
    const h = y2 - y;

    if (w <= 0 || h <= 0) { return null; }
    return { x, y, w, h };
  }

  /** Recursively expand a Box3 to include an object's geometry, skipping meta-shape subtrees. */
  private expandBounds(box: Box3, object: Object3D): void {
    if (object.userData.isMetaShape) { return; }
    const o = object as any;
    if ((o.isMesh || o.isLine || o.isPoints) && o.geometry) {
      o.geometry.computeBoundingBox();
      if (o.geometry.boundingBox) {
        box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
    }
    for (const child of object.children) {
      this.expandBounds(box, child);
    }
  }
}
