import { SceneContext } from '../scene/scene-context';
import { sceneUnit } from '../units/scene-unit';
import { captureScreenshot } from '../screenshot';
import { deliverFile } from '../desktop';
import type { DesktopFileFilter } from '../desktop';
import type { EngineClient } from '../engine-client';
import type { ExportFormat, ExportFormatOptions, ExportInstancePose, ExportRequestBody, MeasurePose } from '../api';
import type { UIConfigurations } from '../types';
import { ConfigurationExport, type ConfigurationPick } from './export-configurations';
import { ICON_CLOSE } from './icons';

/**
 * What the dialog exports: the listed solids, each in its own frame (a
 * part-scene solid, an assembly's part template), or the whole assembly —
 * every instance where it sits.
 *
 * `fileBase` is set when the solids are a part scene's — the output of the
 * file on screen ({@link exportBaseName} of it). It names the download
 * (`plate.step`, `plate-M8.step`, `plate-configurations.zip`) and lets the
 * Configuration select export another `configurations()` row of that file.
 * Without it (an assembly's part template, a host that knows no file) the
 * solids export as on screen, as `export.<ext>`.
 */
export type ExportTarget =
  | { kind: 'shapes'; shapeIds: string[]; fileBase?: string }
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

const ZIP_FILTER: DesktopFileFilter = { name: 'ZIP Archives', extensions: ['zip'] };

/** Why a configuration other than the one on screen can sit differently: the viewer solved the mates for the row it shows. */
const OFF_SCREEN_POSES = 'place their parts where the source puts them, not where the mates do';

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
  private overlay: HTMLDivElement;
  private titleEl: HTMLHeadingElement;
  private purposeEl: HTMLParagraphElement;
  private pillsContainer: HTMLDivElement;
  private stepSection: HTMLDivElement;
  private stlSection: HTMLDivElement;
  private pngSection: HTMLDivElement;
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
   * reports that it has nothing to export.
   */
  constructor(
    container: HTMLElement,
    private client: EngineClient,
    private sceneCtx: SceneContext,
    private assembly: ExportAssemblyProvider | null = null,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = this.buildHTML();
    container.appendChild(this.overlay);

    this.titleEl = this.overlay.querySelector('[data-ref="title"]')!;
    this.purposeEl = this.overlay.querySelector('[data-ref="purpose"]')!;
    this.pillsContainer = this.overlay.querySelector('[data-ref="format-pills"]')!;
    this.stepSection = this.overlay.querySelector('[data-ref="step-section"]')!;
    this.stlSection = this.overlay.querySelector('[data-ref="stl-section"]')!;
    this.pngSection = this.overlay.querySelector('[data-ref="png-section"]')!;
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
    this.exportBtn.disabled = false;
    this.session++;
    // Every opening starts on the row on screen.
    this.configurationPick = null;
    this.syncConfigurationControls();
    this.overlay.classList.remove('hidden');
  }

  /** Close the dialog; an export still running is abandoned and delivers nothing. */
  hide(): void {
    this.session++;
    this.overlay.classList.add('hidden');
  }

  private buildHTML(): string {
    return `
      <div class="w-[380px] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)]">
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
              <input class="join-item btn btn-sm flex-1 border-0 checked:btn-primary" type="radio" name="export-format" aria-label="PNG" data-format="png" />
            </div>
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
    this.syncConfigurationControls();
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
   * screen sits at its statement poses, the viewer having solved the mates
   * for the row it shows. A part scene's other row needs no note: its
   * solids are simply that row's.
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
    });

    this.exportBtn.addEventListener('click', () => this.onExport());
  }

  private async onExport(): Promise<void> {
    if (this.selectedFormat === 'png') {
      return this.exportPng();
    }

    const format: ExportFormat = this.selectedFormat === 'stl' ? 'stl' : 'step';
    const options = this.formatOptions(format);

    let body: ExportRequestBody;
    if (this.target.kind === 'assembly') {
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

    const configuration = this.configurationToExport();
    if (configuration?.kind === 'all') {
      return this.exportAllConfigurations(body, fileBase, format);
    }
    if (configuration) {
      body = { ...body, configuration: configuration.name };
    }

    const session = this.session;
    this.exportBtn.disabled = true;
    this.statusEl.classList.remove('hidden');
    this.showProgress('Exporting...');

    try {
      const blob = await this.client.exportShapes(body);
      if (session !== this.session) {
        return;
      }
      const { extension, filter } = ExportDialog.fileType(format);
      // Desktop: a native Save dialog. Browser: the usual download.
      const outcome = await deliverFile(blob, `${fileBase}${extension}`, [filter]);
      if (outcome === 'failed') {
        throw new Error('The file could not be written.');
      }
      this.finishDelivery(session, outcome === 'cancelled');
    } catch (err: any) {
      if (session === this.session) {
        this.showError(err?.message ?? String(err));
      }
    } finally {
      if (session === this.session) {
        this.exportBtn.disabled = false;
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
   * abandons the run.
   */
  private async exportAllConfigurations(body: ExportRequestBody, fileBase: string, format: ExportFormat): Promise<void> {
    const { extension } = ExportDialog.fileType(format);
    // The rows as the export starts: a render landing mid-run changes the table, not this run.
    const entries = ConfigurationExport.entries(this.configurations!, fileBase, extension);
    const session = this.session;
    this.exportBtn.disabled = true;
    this.statusEl.classList.remove('hidden');

    try {
      const files: { fileName: string; blob: Blob }[] = [];
      for (const [index, entry] of entries.entries()) {
        this.showProgress(`Exporting ${entry.configuration} (${index + 1} of ${entries.length})...`);
        let blob: Blob;
        try {
          blob = await this.client.exportShapes({ ...body, configuration: entry.configuration });
        } catch (err: any) {
          throw new Error(`${entry.configuration}: ${err?.message ?? String(err)}`);
        }
        if (session !== this.session) {
          return;
        }
        files.push({ fileName: entry.fileName, blob });
      }

      this.showProgress('Packing the archive...');
      const archive = await ConfigurationExport.archive(files);
      if (session !== this.session) {
        return;
      }
      const outcome = await deliverFile(archive, ConfigurationExport.archiveName(fileBase), [ZIP_FILTER]);
      if (outcome === 'failed') {
        throw new Error('The archive could not be written.');
      }
      this.finishDelivery(session, outcome === 'cancelled');
    } catch (err: any) {
      if (session === this.session) {
        this.showError(err?.message ?? String(err));
      }
    } finally {
      if (session === this.session) {
        this.exportBtn.disabled = false;
      }
    }
  }

  /** A delivered file closes the dialog; a cancelled Save dialog leaves it open, its progress line cleared. */
  private finishDelivery(session: number, cancelled: boolean): void {
    if (session !== this.session) {
      return;
    }
    if (cancelled) {
      this.statusEl.classList.add('hidden');
      return;
    }
    this.hide();
  }

  private static fileType(format: ExportFormat): { extension: string; filter: DesktopFileFilter } {
    return format === 'step'
      ? { extension: '.step', filter: { name: 'STEP Files', extensions: ['step', 'stp'] } }
      : { extension: '.stl', filter: { name: 'STL Files', extensions: ['stl'] } };
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

  private showError(message: string): void {
    this.statusEl.classList.remove('hidden');
    this.statusEl.replaceChildren();
    const text = document.createElement('span');
    text.className = 'text-error text-xs';
    text.textContent = message;
    this.statusEl.appendChild(text);
  }

  private async exportPng(): Promise<void> {
    this.exportBtn.disabled = true;

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
      this.exportBtn.disabled = false;
    }
  }
}
