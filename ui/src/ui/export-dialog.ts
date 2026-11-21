import { SceneContext } from '../scene/scene-context';
import { sceneUnit } from '../units/scene-unit';
import { captureScreenshot } from '../screenshot';
import { deliverFile } from '../desktop';
import type { DesktopFileFilter } from '../desktop';
import type { EngineClient } from '../engine-client';
import { toExportResult } from '../api';
import type { ExportDrawingView, ExportFormat, ExportFormatOptions, ExportInstancePose, ExportRequestBody, MeasurePose, ShapeSelection } from '../api';
import type { UIConfigurations } from '../types';
import type { SceneDocument } from '../units/scene-document';
import { ConfigurationExport, type ConfigurationPick } from './export-configurations';
import { DrawingPreview } from './export-drawing-preview';
import { DrawingViews, type ExportViewProvider } from './export-drawing-views';
import { ICON_CLOSE } from './icons';

/**
 * What the dialog exports: solids, each in its own frame (a part-scene
 * solid, an assembly's part template), or the whole assembly — every
 * instance where it sits.
 *
 * `shapeIds` lists solids of the scene on screen (a timeline row, the top
 * bar's pick), or is `'all'` (`EVERY_SOLID`) — File ▸ Export — for every solid
 * of the scene exported, which for another configuration row is that row's
 * own set, bodies the screen does not show included.
 *
 * `fileBase` is set when the solids are a part scene's — the output of the
 * file on screen ({@link exportBaseName} of it). It names the download
 * (`plate.step`, `plate-M8.step`, `plate-configurations.zip`) and lets the
 * Configuration select export another `configurations()` row of that file.
 * Without it (an assembly's part template, a host that knows no file) the
 * solids export as on screen, as `export.<ext>`.
 */
export type ExportTarget =
  | { kind: 'shapes'; shapeIds: ShapeSelection; fileBase?: string }
  | { kind: 'assembly' };

/**
 * Where the whole-assembly export reads the scene from. Injected rather than
 * imported so the dialog never reaches into the viewer: the poses are the
 * browser solver's, which only the host holds.
 */
export interface ExportAssemblyProvider {
  /** Every instance of the current assembly, as the payload lists them. */
  instances(): { instanceId: string; name: string }[];
  /** The instance's live world pose from the solver; null while the scene is mid-update. */
  poseOf(instanceId: string): MeasurePose | null;
  /** The download's base name — the assembly file without its directory and `.assembly.js`. */
  fileBaseName(): string;
}

/** The download name of solids that name no file; a part scene's and the assembly's are named after their file. */
const SHAPES_FILE_BASE = 'export';

/**
 * The 2D formats: a drawing of the solids' view on a standard plane rather
 * than the solids themselves. They share one options section (the preview,
 * the view and which edges are drawn) and carry the view in the download's
 * name.
 */
const DRAWING_FORMATS: ReadonlySet<string> = new Set<ExportFormat>(['dxf', 'svg']);

/** What the whole assembly's dialog says in place of the drawing options. */
const DRAWING_PARTS_ONLY = 'DXF/SVG exports are supported only on single parts';

/** The SVG stroke width the dialog opens on, in millimetres — the server's own default. */
const DEFAULT_STROKE_WIDTH_MM = 0.25;
/** The thinnest stroke the dialog sends; anything under it (or not a number) is left to the server's default. */
const MIN_STROKE_WIDTH_MM = 0.01;

const ZIP_FILTER: DesktopFileFilter = { name: 'ZIP Archives', extensions: ['zip'] };

/**
 * Why a configuration other than the one on screen can sit differently: the
 * engine solves its mates from the source's poses, as when a file opens,
 * while the row on screen exports wherever its parts were dragged or driven.
 */
const OFF_SCREEN_POSES = 'place their parts where the mates settle them, not where they were dragged';

/**
 * The download's base name for a document: the file name without its
 * directory and without its model suffix — `.assembly.js`, `.part.js`,
 * `.fluid.js`, else `.js` — so `/work/robot.assembly.js` exports as
 * `robot.step` and `/work/plate.part.js` as `plate.step`.
 */
export function exportBaseName(absPath: string): string {
  const file = absPath.split(/[\\/]/).pop() ?? '';
  return file.replace(/\.(?:assembly|part|fluid)\.js$/, '').replace(/\.js$/, '');
}

export class ExportDialog {
  /**
   * The shapes target for `shapeIds` in the scene `document` shows. A part
   * scene's solids are its file's output, so the target names the file: the
   * download is called after it and the dialog offers the file's
   * `configurations()` rows. An assembly's solids are part templates and
   * export as on screen, unnamed; so do a host's that knows no document.
   */
  static shapesTarget(shapeIds: ShapeSelection, document: SceneDocument | null): ExportTarget {
    if (document?.kind !== 'part') {
      return { kind: 'shapes', shapeIds };
    }
    return { kind: 'shapes', shapeIds, fileBase: exportBaseName(document.absPath) };
  }

  private overlay: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private purposeEl: HTMLParagraphElement;
  private pillsContainer: HTMLDivElement;
  private formatNoteEl: HTMLParagraphElement;
  /** An export of this opening is running: Export stays disabled until it ends. */
  private busy = false;
  private stepSection: HTMLDivElement;
  private stlSection: HTMLDivElement;
  private pngSection: HTMLDivElement;
  private drawingSection: HTMLDivElement;
  private drawingViewSelect: HTMLSelectElement;
  private hiddenLinesToggle: HTMLInputElement;
  private tangentEdgesToggle: HTMLInputElement;
  private strokeSection: HTMLDivElement;
  private strokeWidthInput: HTMLInputElement;
  private previewNote: HTMLParagraphElement;
  private preview: DrawingPreview;
  private includeColorsToggle: HTMLInputElement;
  private resolutionSelect: HTMLSelectElement;
  private customSection: HTMLDivElement;
  private angularInput: HTMLInputElement;
  private linearInput: HTMLInputElement;
  private scaleToMmToggle: HTMLInputElement;
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
  private configurationSection: HTMLDivElement;
  private configurationSelect: HTMLSelectElement;
  private configurationNote: HTMLParagraphElement;
  private target: ExportTarget = { kind: 'shapes', shapeIds: [] };
  private selectedFormat: string = 'step';
  /** The rendered file's table as the last render reported it; null for a file without rows. */
  private configurations: UIConfigurations | null = null;
  /** What the user chose in the Configuration select; null follows the row on screen. */
  private configurationPick: ConfigurationPick | null = null;
  /** Bumped by every show() and hide(): an export still running for an earlier opening drops its result. */
  private session = 0;

  /**
   * `assembly` is the host's window onto the live assembly; a host that never
   * shows one (a part-only viewer) passes nothing and the assembly target
   * reports that it has nothing to export. `view` says where the camera is,
   * so a drawing opens on the side being looked at; without it a drawing
   * opens on Top.
   */
  constructor(
    container: HTMLElement,
    private client: EngineClient,
    private sceneCtx: SceneContext,
    private assembly: ExportAssemblyProvider | null = null,
    private view: ExportViewProvider | null = null,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.titleEl = this.overlay.querySelector('[data-ref="title"]')!;
    this.purposeEl = this.overlay.querySelector('[data-ref="purpose"]')!;
    this.pillsContainer = this.overlay.querySelector('[data-ref="format-pills"]')!;
    this.formatNoteEl = this.overlay.querySelector('[data-ref="format-note"]')!;
    this.stepSection = this.overlay.querySelector('[data-ref="step-section"]')!;
    this.stlSection = this.overlay.querySelector('[data-ref="stl-section"]')!;
    this.pngSection = this.overlay.querySelector('[data-ref="png-section"]')!;
    this.drawingSection = this.overlay.querySelector('[data-ref="drawing-section"]')!;
    this.drawingViewSelect = this.overlay.querySelector('[data-ref="drawing-view"]')!;
    this.hiddenLinesToggle = this.overlay.querySelector('[data-ref="hidden-lines"]')!;
    this.tangentEdgesToggle = this.overlay.querySelector('[data-ref="tangent-edges"]')!;
    this.strokeSection = this.overlay.querySelector('[data-ref="stroke-section"]')!;
    this.strokeWidthInput = this.overlay.querySelector('[data-ref="stroke-width"]')!;
    this.previewNote = this.overlay.querySelector('[data-ref="drawing-preview-note"]')!;
    this.preview = new DrawingPreview(
      {
        image: this.overlay.querySelector('[data-ref="drawing-preview-image"]')!,
        status: this.overlay.querySelector('[data-ref="drawing-preview-status"]')!,
      },
      async (body) => toExportResult(await this.client.exportShapes(body)).blob,
    );
    for (const { view: name, label } of DrawingViews.OPTIONS) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = label;
      this.drawingViewSelect.appendChild(option);
    }
    this.includeColorsToggle = this.overlay.querySelector('[data-ref="include-colors"]')!;
    this.resolutionSelect = this.overlay.querySelector('[data-ref="resolution"]')!;
    this.customSection = this.overlay.querySelector('[data-ref="custom-section"]')!;
    this.angularInput = this.overlay.querySelector('[data-ref="angular"]')!;
    this.linearInput = this.overlay.querySelector('[data-ref="linear"]')!;
    this.scaleToMmToggle = this.overlay.querySelector('[data-ref="scale-to-mm"]')!;
    const linearLabel = this.overlay.querySelector<HTMLLabelElement>('[data-ref="linear-label"]')!;
    const nameUnit = (): void => {
      linearLabel.textContent = `Linear Deflection (${sceneUnit.current})`;
    };
    nameUnit();
    sceneUnit.subscribe(nameUnit);
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
    this.configurationSection = this.overlay.querySelector('[data-ref="configuration-section"]')!;
    this.configurationSelect = this.overlay.querySelector('[data-ref="configuration"]')!;
    this.configurationNote = this.overlay.querySelector('[data-ref="configuration-note"]')!;

    this.bindEvents();
  }

  /**
   * The rendered file's `configurations()` table, fed by the host on every
   * render. A file without rows (or null) has no Configuration select;
   * otherwise it lists Default, the rows and "All configurations", on the
   * row on screen unless the user picked something else since the dialog
   * opened — a pick the new table no longer offers (its row renamed or
   * removed) goes back to the screen.
   */
  setConfigurations(configurations: UIConfigurations | null): void {
    this.configurations = configurations && configurations.names.length > 0 ? configurations : null;
    const pick = this.configurationPick;
    if (pick && (!this.configurations || !ConfigurationExport.offers(this.configurations, pick))) {
      this.configurationPick = null;
    }
    this.renderConfigurationOptions();
    this.syncConfigurationControls();
    // The table comes with every render: the scene a preview was drawn from is no longer the one on screen.
    this.syncPreview(true);
  }

  show(target: ExportTarget): void {
    this.target = target;
    const whole = target.kind === 'assembly';
    this.titleEl.textContent = whole ? 'Export assembly' : 'Export';
    this.purposeEl.textContent = whole
      ? 'Every part where it sits, as one STEP assembly or one STL mesh. Pick a format, then press Export.'
      : '';
    this.purposeEl.classList.toggle('hidden', !whole);
    this.statusEl.classList.add('hidden');
    this.busy = false;
    this.session++;
    // Every opening starts on the row on screen.
    this.configurationPick = null;
    this.syncFormatPills();
    // ...and a drawing on the side the model is being looked at from.
    this.drawingViewSelect.value = DrawingViews.facing(this.view?.eyeDirection() ?? null);
    this.syncConfigurationControls();
    this.overlay.classList.remove('hidden');
    // A preview left by an earlier opening was of another target, or of a scene since rebuilt.
    this.preview.clear();
    this.syncPreview();
  }

  /**
   * Close the dialog; an export still running is abandoned and delivers
   * nothing, and so is a preview still on its way.
   */
  hide(): void {
    this.session++;
    this.overlay.classList.add('hidden');
    this.preview.clear();
  }

  private buildHTML(): string {
    return `
      <div class="w-[380px] max-h-[calc(100vh-2rem)] overflow-y-auto bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
        <div class="flex items-center justify-between mb-4">
          <h3 data-ref="title" class="text-sm font-medium text-base-content/90">Export</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <p data-ref="purpose" class="hidden text-xs text-base-content/60 -mt-2 mb-4"></p>

        <div class="flex flex-col gap-3">
          <div data-ref="configuration-section" class="hidden">
            <label class="text-xs text-base-content/60 mb-1 block">Configuration</label>
            <select data-ref="configuration" class="select select-sm select-bordered w-full"></select>
            <p data-ref="configuration-note" class="hidden mt-1.5 text-[11px] text-base-content/50"></p>
          </div>

          <div>
            <label class="text-xs text-base-content/60 mb-1.5 block">Format</label>
            <div data-ref="format-pills" class="join w-full border border-base-content/10 rounded-lg">
              <input class="join-item btn btn-sm flex-1 border-0 border-r border-base-content/10 checked:btn-primary" type="radio" name="export-format" aria-label="STEP" data-format="step" checked />
              <input class="join-item btn btn-sm flex-1 border-0 border-r border-base-content/10 checked:btn-primary" type="radio" name="export-format" aria-label="STL" data-format="stl" />
              <input class="join-item btn btn-sm flex-1 border-0 border-r border-base-content/10 checked:btn-primary" type="radio" name="export-format" aria-label="DXF" data-format="dxf" />
              <input class="join-item btn btn-sm flex-1 border-0 border-r border-base-content/10 checked:btn-primary" type="radio" name="export-format" aria-label="SVG" data-format="svg" />
              <input class="join-item btn btn-sm flex-1 border-0 checked:btn-primary" type="radio" name="export-format" aria-label="PNG" data-format="png" />
            </div>
            <p data-ref="format-note" class="hidden mt-2 text-xs text-base-content/60">${DRAWING_PARTS_ONLY}</p>
          </div>

          <div data-ref="step-section">
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Include colors</span>
              <input type="checkbox" data-ref="include-colors" class="toggle toggle-sm toggle-primary" checked />
            </label>
          </div>

          <div data-ref="stl-section" class="hidden flex flex-col gap-3">
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Scale to millimetres (recommended for slicers)</span>
              <input type="checkbox" data-ref="scale-to-mm" class="toggle toggle-sm toggle-primary" checked />
            </label>
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
                <label data-ref="linear-label" class="text-xs text-base-content/60 mb-1 block">Linear Deflection (mm)</label>
                <input data-ref="linear" type="number" class="input input-sm input-bordered w-full" value="0.3" min="0.001" max="10" step="0.01" />
              </div>
            </div>
          </div>

          <div data-ref="drawing-section" class="hidden flex flex-col gap-3">
            <div>
              <label class="text-xs text-base-content/60 mb-1 block">Preview</label>
              <div data-ref="drawing-preview" class="relative h-[180px] rounded-md border border-base-content/10 bg-white overflow-hidden">
                <img data-ref="drawing-preview-image" class="hidden w-full h-full object-contain p-2 transition-opacity" alt="The drawing these options export" />
                <span data-ref="drawing-preview-status" class="hidden absolute inset-x-2 top-1/2 -translate-y-1/2 truncate text-center text-[11px] text-black/50"></span>
              </div>
              <p data-ref="drawing-preview-note" class="hidden mt-1.5 text-[11px] text-base-content/50"></p>
            </div>
            <div>
              <label class="text-xs text-base-content/60 mb-1 block">View</label>
              <select data-ref="drawing-view" class="select select-sm select-bordered w-full"></select>
            </div>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Hidden lines (dashed, on their own layer)</span>
              <input type="checkbox" data-ref="hidden-lines" class="toggle toggle-sm toggle-primary" />
            </label>
            <label class="flex items-center justify-between cursor-pointer">
              <span class="text-xs text-base-content/70">Tangent edges</span>
              <input type="checkbox" data-ref="tangent-edges" class="toggle toggle-sm toggle-primary" />
            </label>
            <div data-ref="stroke-section" class="hidden">
              <label class="text-xs text-base-content/60 mb-1 block">Stroke width (mm)</label>
              <input data-ref="stroke-width" type="number" class="input input-sm input-bordered w-full" value="${DEFAULT_STROKE_WIDTH_MM}" min="${MIN_STROKE_WIDTH_MM}" step="0.05" />
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
    this.strokeSection.classList.toggle('hidden', format !== 'svg');
    this.syncDrawingAvailability();
    this.syncConfigurationControls();
    this.syncPreview();
  }

  /**
   * The drawing formats belong to solids: the whole assembly cannot be drawn
   * yet. Its dialog still offers the pills, but a drawing format picked on it
   * has nothing to export.
   */
  private drawingUnavailable(): boolean {
    return this.target.kind === 'assembly' && DRAWING_FORMATS.has(this.selectedFormat);
  }

  /**
   * Show the drawing options for a drawing format — or, on the whole
   * assembly, the note saying drawings are for single parts, with Export
   * disabled.
   */
  private syncDrawingAvailability(): void {
    const unavailable = this.drawingUnavailable();
    this.drawingSection.classList.toggle('hidden', unavailable || !DRAWING_FORMATS.has(this.selectedFormat));
    this.formatNoteEl.classList.toggle('hidden', !unavailable);
    this.syncExportButton();
  }

  /** Export is pressable unless an export is running or the format picked has nothing to export. */
  private syncExportButton(): void {
    this.exportBtn.disabled = this.busy || this.drawingUnavailable();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncExportButton();
  }

  /**
   * Every opening on the whole assembly starts on a format it can export: a
   * drawing pill left selected by an earlier opening goes back to STEP.
   */
  private syncFormatPills(): void {
    if (this.drawingUnavailable()) {
      this.pillsContainer.querySelector<HTMLInputElement>('[data-format="step"]')!.checked = true;
      this.setFormat('step');
      return;
    }
    this.syncDrawingAvailability();
  }

  /**
   * Bring the preview in step with the dialog: the drawing the options on
   * screen would export, while the dialog is open on solids with a drawing
   * format picked; nothing is asked of the server otherwise. `force` asks
   * again for options already previewed — the scene behind them changed.
   *
   * The preview is always an SVG, for a DXF too: the two are the same
   * drawing, and only an SVG can be shown. It leaves the stroke width out —
   * the preview draws its lines one pixel wide at any scale, so the width on
   * paper would not show — and for "All configurations" it draws the row on
   * screen and says so.
   */
  private syncPreview(force = false): void {
    if (this.overlay.classList.contains('hidden')) {
      return;
    }
    if (this.target.kind !== 'shapes' || !DRAWING_FORMATS.has(this.selectedFormat)) {
      this.preview.pause();
      return;
    }
    const configuration = this.configurationToExport();
    const body: ExportRequestBody = {
      format: 'svg',
      shapeIds: this.target.shapeIds,
      ...this.drawingOptions(),
      ...(configuration?.kind === 'one' ? { configuration: configuration.name } : {}),
    };
    const everyRow = configuration?.kind === 'all';
    this.previewNote.textContent = everyRow ? 'The preview shows the configuration on screen.' : '';
    this.previewNote.classList.toggle('hidden', !everyRow);
    this.preview.show(body, force);
  }

  /** What every drawing format sends: the view and which edges are drawn. */
  private drawingOptions(): ExportFormatOptions {
    return {
      plane: this.drawingView(),
      hiddenLines: this.hiddenLinesToggle.checked,
      tangentEdges: this.tangentEdgesToggle.checked,
    };
  }

  /**
   * The SVG stroke width to send, in millimetres; undefined — the server's
   * default — for a field left empty or holding nothing a line can be.
   */
  private strokeWidth(): number | undefined {
    const value = parseFloat(this.strokeWidthInput.value);
    return Number.isFinite(value) && value >= MIN_STROKE_WIDTH_MM ? value : undefined;
  }

  /** The view a drawing export draws: the select's, on Top should it ever hold anything else. */
  private drawingView(): ExportDrawingView {
    const value = this.drawingViewSelect.value;
    return DrawingViews.isView(value) ? value : DrawingViews.DEFAULT;
  }

  /**
   * What a download's name carries between its base and its extension: a
   * drawing's view (`-top`), since one part is usually drawn on several
   * planes and the files must not overwrite each other; nothing otherwise.
   */
  private nameSuffix(format: ExportFormat): string {
    return DRAWING_FORMATS.has(format) ? `-${this.drawingView()}` : '';
  }

  /**
   * The select's options: Default and the table's rows — the one on screen
   * marked — then, past a separator, "All configurations". Values go
   * through {@link ConfigurationExport.optionValue}, so no row name can pass
   * for the "all" option.
   */
  private renderConfigurationOptions(): void {
    const table = this.configurations;
    this.configurationSelect.replaceChildren();
    if (!table) {
      return;
    }
    for (const name of ConfigurationExport.rows(table)) {
      const option = document.createElement('option');
      option.value = ConfigurationExport.optionValue({ kind: 'one', name });
      option.textContent = name === table.active ? `${name} (on screen)` : name;
      this.configurationSelect.appendChild(option);
    }
    this.configurationSelect.appendChild(document.createElement('hr'));
    const all = document.createElement('option');
    all.value = ConfigurationExport.optionValue({ kind: 'all' });
    all.textContent = 'All configurations (.zip)';
    this.configurationSelect.appendChild(all);
  }

  /**
   * The Configuration select belongs to an export of a file's own output —
   * the whole assembly, or a part scene's solids (a target naming its file)
   * — when that file has `configurations()` rows. Solids that name no file
   * (an assembly's part templates) export what is on screen.
   */
  private configurationsOffered(): boolean {
    if (this.configurations === null) {
      return false;
    }
    return this.target.kind === 'assembly' || this.target.fileBase !== undefined;
  }

  /** The download's base name: the assembly's or the part scene's file, else {@link SHAPES_FILE_BASE}. */
  private downloadBase(): string {
    if (this.target.kind === 'assembly') {
      return this.assembly?.fileBaseName() || 'assembly';
    }
    return this.target.fileBase || SHAPES_FILE_BASE;
  }

  /**
   * What a STEP/STL export renders: the user's pick, else the row on screen;
   * null when the dialog offers no Configuration select.
   */
  private configurationToExport(): ConfigurationPick | null {
    if (!this.configurationsOffered()) {
      return null;
    }
    return this.configurationPick ?? { kind: 'one', name: this.configurations!.active };
  }

  /**
   * Show the select for {@link configurationsOffered}, on the pick. A PNG is
   * captured from the viewport, so for it the select is held on the row on
   * screen (the pick comes back with STEP or STL). The note says how the
   * export differs from the viewport: All configurations is one file per
   * row in a zip, and — the assembly only — a row other than the one on
   * screen sits where the engine's own solve settles its mates, the
   * viewer's dragged poses belonging to the row it shows. A part scene's
   * other row needs no note: its solids are simply that row's.
   */
  private syncConfigurationControls(): void {
    const offered = this.configurationsOffered();
    this.configurationSection.classList.toggle('hidden', !offered);
    let note = '';
    if (offered) {
      const png = this.selectedFormat === 'png';
      const active = this.configurations!.active;
      const pick: ConfigurationPick = png ? { kind: 'one', name: active } : this.configurationToExport()!;
      const whole = this.target.kind === 'assembly';
      this.configurationSelect.disabled = png;
      this.configurationSelect.value = ConfigurationExport.optionValue(pick);
      if (png) {
        note = 'A PNG captures the configuration on screen.';
      } else if (pick.kind === 'all') {
        note = whole
          ? `Each configuration is its own file in one .zip. Those not on screen ${OFF_SCREEN_POSES}.`
          : 'Each configuration is its own file in one .zip.';
      } else if (whole && pick.name !== active) {
        note = `A configuration other than the one on screen will ${OFF_SCREEN_POSES}.`;
      }
    }
    this.configurationNote.textContent = note;
    this.configurationNote.classList.toggle('hidden', note === '');
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

    this.configurationSelect.addEventListener('change', () => {
      this.configurationPick = ConfigurationExport.parseOptionValue(this.configurationSelect.value);
      this.syncConfigurationControls();
      this.syncPreview();
    });

    // What the drawing shows: each change is a new preview.
    for (const control of [this.drawingViewSelect, this.hiddenLinesToggle, this.tangentEdgesToggle]) {
      control.addEventListener('change', () => this.syncPreview());
    }

    this.exportBtn.addEventListener('click', () => this.onExport());
  }

  private async onExport(): Promise<void> {
    if (this.selectedFormat === 'png') {
      return this.exportPng();
    }

    const format = ExportDialog.fileFormat(this.selectedFormat);
    const options = this.formatOptions(format);

    let body: ExportRequestBody;
    if (this.target.kind === 'assembly') {
      if (DRAWING_FORMATS.has(format)) {
        this.showError(DRAWING_PARTS_ONLY);
        return;
      }
      const poses = this.collectAssemblyPoses();
      if ('reason' in poses) {
        this.showError(poses.reason);
        return;
      }
      body = { format, assembly: { poses: poses.poses }, ...options };
    } else {
      body = { format, shapeIds: this.target.shapeIds, ...options };
    }
    const fileBase = this.downloadBase();
    const suffix = this.nameSuffix(format);

    const configuration = this.configurationToExport();
    if (configuration?.kind === 'all') {
      return this.exportAllConfigurations(body, fileBase, format, suffix);
    }
    if (configuration) {
      body = { ...body, configuration: configuration.name };
    }

    const session = this.session;
    this.setBusy(true);
    this.statusEl.classList.remove('hidden');
    this.showProgress('Exporting...');

    try {
      const { blob, warnings } = toExportResult(await this.client.exportShapes(body));
      if (session !== this.session) {
        return;
      }
      const { extension, filter } = ExportDialog.fileType(format);
      // Desktop: a native Save dialog. Browser: the usual download.
      const outcome = await deliverFile(blob, `${fileBase}${suffix}${extension}`, [filter]);
      if (outcome === 'failed') {
        throw new Error('The file could not be written.');
      }
      this.finishDelivery(session, outcome === 'cancelled', warnings);
    } catch (err: any) {
      if (session === this.session) {
        this.showError(err?.message ?? String(err));
      }
    } finally {
      if (session === this.session) {
        this.setBusy(false);
      }
    }
  }

  /**
   * "All configurations": one request per row — Default first, then the
   * table's rows in declaration order — one after the other with the
   * progress in the status line, then every file in one zip
   * ({@link ConfigurationExport.entries} names them), delivered once. A
   * failed row stops the run and names it, and nothing is delivered: a
   * partial archive would pass for a complete one. Closing the dialog
   * abandons the run. `suffix` is the drawing's view in every name, the
   * archive's included (`plate-top.dxf`, `plate-M8-top.dxf`,
   * `plate-top-configurations.zip`).
   */
  private async exportAllConfigurations(body: ExportRequestBody, fileBase: string, format: ExportFormat, suffix: string): Promise<void> {
    const { extension } = ExportDialog.fileType(format);
    // The rows as the export starts: a render landing mid-run changes the table, not this run.
    const entries = ConfigurationExport.entries(this.configurations!, fileBase, extension, suffix);
    const session = this.session;
    this.setBusy(true);
    this.statusEl.classList.remove('hidden');

    try {
      const files: { fileName: string; blob: Blob }[] = [];
      const warnings: string[] = [];
      for (const [index, entry] of entries.entries()) {
        this.showProgress(`Exporting ${entry.configuration} (${index + 1} of ${entries.length})...`);
        let exported: { blob: Blob; warnings: string[] };
        try {
          exported = toExportResult(await this.client.exportShapes({ ...body, configuration: entry.configuration }));
        } catch (err: any) {
          throw new Error(`${entry.configuration}: ${err?.message ?? String(err)}`);
        }
        if (session !== this.session) {
          return;
        }
        files.push({ fileName: entry.fileName, blob: exported.blob });
        warnings.push(...exported.warnings.map((warning) => `${entry.configuration}: ${warning}`));
      }

      this.showProgress('Packing the archive...');
      const archive = await ConfigurationExport.archive(files);
      if (session !== this.session) {
        return;
      }
      const outcome = await deliverFile(archive, ConfigurationExport.archiveName(`${fileBase}${suffix}`), [ZIP_FILTER]);
      if (outcome === 'failed') {
        throw new Error('The archive could not be written.');
      }
      this.finishDelivery(session, outcome === 'cancelled', warnings);
    } catch (err: any) {
      if (session === this.session) {
        this.showError(err?.message ?? String(err));
      }
    } finally {
      if (session === this.session) {
        this.setBusy(false);
      }
    }
  }

  /**
   * A delivered file closes the dialog; a cancelled Save dialog leaves it
   * open, its progress line cleared. A file the server had something to say
   * about (a drawing whose curves were approximated) is delivered all the
   * same, and the dialog stays open on what was said: closing over it would
   * hand over a file that is not quite what was asked for without a word.
   */
  private finishDelivery(session: number, cancelled: boolean, warnings: string[] = []): void {
    if (session !== this.session) {
      return;
    }
    if (cancelled) {
      this.statusEl.classList.add('hidden');
      return;
    }
    if (warnings.length > 0) {
      this.showWarnings(warnings);
      return;
    }
    this.hide();
  }

  /** The file format a pill other than PNG exports. */
  private static fileFormat(selected: string): ExportFormat {
    return selected === 'stl' || selected === 'dxf' || selected === 'svg' ? selected : 'step';
  }

  private static fileType(format: ExportFormat): { extension: string; filter: DesktopFileFilter } {
    switch (format) {
      case 'step':
        return { extension: '.step', filter: { name: 'STEP Files', extensions: ['step', 'stp'] } };
      case 'stl':
        return { extension: '.stl', filter: { name: 'STL Files', extensions: ['stl'] } };
      case 'dxf':
        return { extension: '.dxf', filter: { name: 'DXF Files', extensions: ['dxf'] } };
      case 'svg':
        return { extension: '.svg', filter: { name: 'SVG Images', extensions: ['svg'] } };
    }
  }

  private showProgress(message: string): void {
    this.statusEl.replaceChildren();
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-spinner loading-xs';
    const text = document.createElement('span');
    text.textContent = message;
    this.statusEl.append(spinner, text);
  }

  private formatOptions(format: ExportFormat): ExportFormatOptions {
    if (format === 'step') {
      return { includeColors: this.includeColorsToggle.checked };
    }
    if (DRAWING_FORMATS.has(format)) {
      // A drawing takes its own options only: the server refuses the 3D ones
      // with it, and the stroke width with anything but an SVG.
      const strokeWidth = format === 'svg' ? this.strokeWidth() : undefined;
      return { ...this.drawingOptions(), ...(strokeWidth !== undefined ? { strokeWidth } : {}) };
    }
    const resolution = this.resolutionSelect.value as ExportFormatOptions['resolution'];
    // STL has no unit; an mm document is unaffected either way.
    const options: ExportFormatOptions = {
      resolution,
      scaleTo: this.scaleToMmToggle.checked ? 'mm' : 'document',
    };
    if (resolution === 'custom') {
      options.customAngularDeflectionDeg = parseFloat(this.angularInput.value);
      options.customLinearDeflection = parseFloat(this.linearInput.value);
    }
    return options;
  }

  /**
   * One live pose per instance of the current assembly. The server refuses a
   * partial list (it would silently mix solved and unsolved placement), so a
   * missing pose — the solver has not placed a just-inserted instance yet —
   * stops the export here with a reason instead of a round trip.
   */
  private collectAssemblyPoses(): { poses: ExportInstancePose[] } | { reason: string } {
    if (!this.assembly) {
      return { reason: 'No assembly is open.' };
    }
    const instances = this.assembly.instances();
    if (instances.length === 0) {
      return { reason: 'The assembly has no parts to export — insert one first.' };
    }
    const poses: ExportInstancePose[] = [];
    for (const { instanceId, name } of instances) {
      const pose = this.assembly.poseOf(instanceId);
      if (!pose) {
        return {
          reason: `"${name}" has no position yet — the scene is still updating. Try again in a moment.`,
        };
      }
      poses.push({ instanceId, position: pose.position, quaternion: pose.quaternion });
    }
    return { poses };
  }

  /** The file is out; what the server said about it stays on the status line, one line each. */
  private showWarnings(warnings: string[]): void {
    this.statusEl.classList.remove('hidden');
    this.statusEl.replaceChildren();
    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1 text-warning text-xs';
    const lead = document.createElement('span');
    lead.textContent = 'Exported, with a note:';
    list.appendChild(lead);
    for (const warning of [...new Set(warnings)]) {
      const line = document.createElement('span');
      line.textContent = warning;
      list.appendChild(line);
    }
    this.statusEl.appendChild(list);
  }

  private showError(message: string): void {
    this.statusEl.classList.remove('hidden');
    this.statusEl.replaceChildren();
    const text = document.createElement('span');
    text.className = 'text-error text-xs';
    text.textContent = message;
    this.statusEl.appendChild(text);
  }

  private async exportPng(): Promise<void> {
    this.setBusy(true);

    try {
      const blob = await captureScreenshot(this.sceneCtx, {
        width: Math.max(1, Math.min(8192, parseInt(this.widthInput.value) || 800)),
        height: Math.max(1, Math.min(8192, parseInt(this.heightInput.value) || 800)),
        showGrid: this.showGridToggle.checked,
        showAxes: this.showAxesToggle.checked,
        transparent: this.transparentToggle.checked,
        autoCrop: this.autoCropToggle.checked,
        margin: this.autoCropToggle.checked ? Math.max(0, parseInt(this.marginInput.value) || 0) : 0,
      });

      const outcome = await deliverFile(blob, `${this.downloadBase()}.png`, [
        { name: 'PNG Images', extensions: ['png'] },
      ]);
      if (outcome === 'failed') {
        throw new Error('The image could not be written.');
      }
      if (outcome !== 'cancelled') {
        this.hide();
      }
    } catch (err: any) {
      this.showError(err.message);
    } finally {
      this.setBusy(false);
    }
  }
}
