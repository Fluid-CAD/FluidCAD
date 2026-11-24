import { PanelShell } from '../create-feature/panel-controls';
import { sceneUnit } from '../../units/scene-unit';
import { formatLength, LENGTH_UNITS, type LengthUnit } from '../../units/units';
import { iconUrl } from '../../ui/icon-url';
import type { ImportedLayer } from '../../../../lib/io/drawing/import.js';

/** The file unit the dialog offers: what the file says (`file`), or one the user names. */
export type DrawingUnitChoice = 'file' | LengthUnit;

/** What tells the dialog which kind of file it imports. */
export type DrawingImportFormat = {
  /** Dialog title: "Import DXF". */
  title: string;
  /** The choose button: "Choose DXF…". */
  chooseLabel: string;
  /** The file input's `accept`. */
  accept: string;
  /** The icon's name under `/icons`. */
  icon: string;
};

/** What Apply would write, for the dialog's summary line. */
export type DrawingImportSummary = {
  /** Sketch statements. */
  entities: number;
  /** `coincident` statements, when joins are on. */
  joins: number;
  /** Constraints that pin the geometry (`fix`, radii, diameters), when Fix in place is on. */
  pins: number;
  /** One line each, shown folded under "Warnings (n)": what was left out, approximated, or needs saying. */
  notes: string[];
  /** Why Apply is off, when it is (too many statements, nothing on the chosen layers). */
  blocked: string | null;
};

/**
 * The dialog of a drawing import (DXF today). It holds what the viewport
 * cannot: the file, the unit its numbers are in, a scale, which layers come
 * in, whether ends that meet are joined, and Apply / Cancel. Place and angle
 * are read-outs: they are set by dragging the drawing, its corner handles
 * and its rotate knob.
 */
export class DrawingImportPanel {
  onFile?: (file: File) => void;
  onUnit?: (unit: DrawingUnitChoice) => void;
  onScale?: (scale: number) => void;
  /** The names of the layers left ticked. */
  onLayers?: (layers: Set<string>) => void;
  onJoins?: (joins: boolean) => void;
  onFix?: (fix: boolean) => void;
  onAsDrawn?: () => void;
  onCenter?: () => void;
  onApply?: () => void;
  onExit?: () => void;

  private shell: PanelShell;
  private fileInput: HTMLInputElement;
  private fileLabel: HTMLDivElement;
  private options: HTMLDivElement;
  private unitSelect: HTMLSelectElement;
  private scaleInput: HTMLInputElement;
  private layersBox: HTMLDivElement;
  private layersList: HTMLDivElement;
  private joinsToggle: HTMLInputElement;
  private fixToggle: HTMLInputElement;
  private readout: HTMLDivElement;
  private summary: HTMLDivElement;
  private warnings: HTMLDivElement;
  private warningsTitle: HTMLDivElement;
  private notes: HTMLUListElement;
  private applyBtn: HTMLButtonElement;
  private hasFile = false;
  private busy = false;
  private blocked = false;

  constructor(container: HTMLElement, format: DrawingImportFormat) {
    // A sketch tool's dialog: Escape inside it cancels the tool.
    this.shell = new PanelShell(container, 'fluidcad-drawing-import-panel', format.title, iconUrl(format.icon), 'inside');
    this.shell.onEscape = () => this.onExit?.();
    // The rows follow the other dialogs: a label over its field, the body's
    // own gap between rows, plain `checkbox-xs` boxes in a list.
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div class="flex flex-col gap-1.5">
        <button type="button" data-role="choose" class="btn btn-sm btn-outline w-full">${format.chooseLabel}</button>
        <input data-role="file" type="file" accept="${format.accept}" class="hidden" />
        <div data-role="file-label" class="text-base-content/60 truncate" title="">No file chosen</div>
      </div>
      <div data-role="options" class="hidden flex flex-col gap-3.5">
        <label class="flex flex-col gap-1.5">
          <span class="text-base-content/70">File unit</span>
          <select data-role="unit" class="select select-sm select-bordered w-full text-xs"></select>
        </label>
        <label class="flex flex-col gap-1.5" title="Enlarge or shrink the drawing on top of the unit conversion. Dragging a corner sets it too.">
          <span class="text-base-content/70">Scale</span>
          <input data-role="scale" type="number" min="0" step="any" value="1"
            class="input input-sm input-bordered w-full text-xs tabular-nums" />
        </label>
        <div data-role="layers" class="hidden flex flex-col gap-1.5">
          <span class="text-base-content/70">Layers</span>
          <div data-role="layers-list" class="flex flex-col gap-1.5 max-h-28 overflow-y-auto pr-1"></div>
        </div>
        <label class="flex items-center justify-between cursor-pointer"
          title="Write a coincident constraint wherever two ends meet, so the outline stays in one piece when it is dragged">
          <span class="text-base-content/70">Join ends that meet</span>
          <input data-role="joins" type="checkbox" class="toggle toggle-sm toggle-primary" checked />
        </label>
        <label class="flex items-center justify-between cursor-pointer"
          title="Pin the drawing where it is imported: every point fixed, every radius and diameter dimensioned. The sketch stays fully constrained and nothing can be dragged; delete the constraints on what you want to change.">
          <span class="text-base-content/70">Fix in place</span>
          <input data-role="fix" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </label>
        <div class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Position</span>
          <div class="flex gap-1.5">
            <button type="button" data-role="as-drawn" class="btn btn-sm btn-outline flex-1 px-1"
              title="Put the drawing where the file has it: its coordinates become sketch coordinates">As drawn</button>
            <button type="button" data-role="center" class="btn btn-sm btn-outline flex-1 px-1"
              title="Put the drawing in the middle of the view">Centre in view</button>
          </div>
          <div data-role="readout" class="text-base-content/60 tabular-nums leading-snug"
            title="Drag the drawing to move it, a corner to scale it, the knob above it to rotate (Shift snaps to 15°)"></div>
        </div>
        <div data-role="summary" class="leading-snug"></div>
        <div data-role="warnings" class="hidden collapse collapse-arrow !min-h-0 border border-base-content/10 rounded-md">
          <input data-role="warnings-toggle" type="checkbox" class="!min-h-0 !p-0 !h-8" />
          <div data-role="warnings-title" class="collapse-title !min-h-0 !py-2 !px-3 !pr-8 text-xs text-base-content/70">Warnings</div>
          <div class="collapse-content px-0 pb-0">
            <ul data-role="notes" class="list-disc pl-7 pr-3 pb-3 text-base-content/60 leading-snug flex flex-col gap-1.5"></ul>
          </div>
        </div>
      </div>
    `);
    this.shell.footer.insertAdjacentHTML('beforeend', `
      <button type="button" data-role="apply" class="btn btn-primary btn-sm flex-1">Import</button>
      <button type="button" data-role="exit" class="btn btn-ghost btn-sm">Cancel</button>
    `);

    this.fileInput = this.role('file');
    this.fileLabel = this.role('file-label');
    this.options = this.role('options');
    this.unitSelect = this.role('unit');
    this.scaleInput = this.role('scale');
    this.layersBox = this.role('layers');
    this.layersList = this.role('layers-list');
    this.joinsToggle = this.role('joins');
    this.fixToggle = this.role('fix');
    this.readout = this.role('readout');
    this.summary = this.role('summary');
    this.warnings = this.role('warnings');
    this.warningsTitle = this.role('warnings-title');
    this.notes = this.role('notes');
    this.applyBtn = this.role('apply');

    this.role<HTMLButtonElement>('choose').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) {
        this.onFile?.(file);
      }
    });
    this.unitSelect.addEventListener('change', () => this.onUnit?.(this.unitSelect.value as DrawingUnitChoice));
    this.scaleInput.addEventListener('change', () => {
      const scale = Number(this.scaleInput.value);
      if (Number.isFinite(scale) && scale > 0) {
        this.onScale?.(scale);
      }
    });
    this.joinsToggle.addEventListener('change', () => this.onJoins?.(this.joinsToggle.checked));
    this.fixToggle.addEventListener('change', () => this.onFix?.(this.fixToggle.checked));
    this.role<HTMLButtonElement>('as-drawn').addEventListener('click', () => this.onAsDrawn?.());
    this.role<HTMLButtonElement>('center').addEventListener('click', () => this.onCenter?.());
    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.role<HTMLButtonElement>('exit').addEventListener('click', () => this.onExit?.());
    // The sketch tools' single-letter chords must not fire from the dialog.
    this.shell.body.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') {
        e.stopPropagation();
      }
    });
    this.syncButtons();
  }

  private role<T extends HTMLElement = HTMLElement>(name: string): T {
    const el = this.shell.body.querySelector<T>(`[data-role="${name}"]`) ?? this.shell.footer.querySelector<T>(`[data-role="${name}"]`);
    if (!el) {
      throw new Error(`drawing import panel: no element with role ${name}`);
    }
    return el;
  }

  // ------------------------------------------------------------- state in

  /**
   * A file was read: its name, the unit it declares (null for none), and its
   * layers with the ones to tick. The unit select goes back to "what the
   * file says".
   */
  setFile(name: string, declaredUnit: string | null, layers: readonly ImportedLayer[], ticked: ReadonlySet<string>): void {
    this.hasFile = true;
    this.fileLabel.textContent = name;
    this.fileLabel.title = name;
    this.options.classList.remove('hidden');

    const documentUnit = sceneUnit.current;
    this.unitSelect.replaceChildren();
    // What the file says, or — when it says nothing — the document's unit
    // its numbers are then read in.
    const fromFile = new Option(declaredUnit !== null ? `Same as file (${declaredUnit})` : `Document unit (${documentUnit})`, 'file');
    this.unitSelect.add(fromFile);
    for (const unit of LENGTH_UNITS) {
      this.unitSelect.add(new Option(unit.label, unit.value));
    }
    this.unitSelect.value = 'file';
    this.unitSelect.title = declaredUnit !== null
      ? `The file says its numbers are in ${declaredUnit}. They are converted into the document's unit.`
      : `The file does not say what its unit is, so its numbers are read as ${documentUnit}, the document's unit. Pick the unit it was drawn in if that is another one.`;

    this.layersList.replaceChildren();
    for (const layer of layers) {
      const row = document.createElement('label');
      row.className = 'flex items-center gap-2 cursor-pointer';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'checkbox checkbox-xs';
      box.dataset.layer = layer.name;
      box.checked = ticked.has(layer.name);
      box.addEventListener('change', () => this.onLayers?.(this.tickedLayers()));
      const label = document.createElement('span');
      label.className = 'flex-1 truncate text-base-content/70';
      label.textContent = layer.name;
      label.title = layer.hidden ? `${layer.name}: off or frozen in the file` : layer.name;
      const count = document.createElement('span');
      count.className = 'text-base-content/50 tabular-nums';
      count.textContent = layer.hidden ? `off · ${layer.count}` : String(layer.count);
      row.append(box, label, count);
      this.layersList.append(row);
    }
    this.layersBox.classList.toggle('hidden', layers.length < 2);
    this.syncButtons();
  }

  /** The scale the user asked for, on top of the unit conversion. */
  setScale(scale: number): void {
    // Enough digits to read back a dragged scale, none it does not have.
    this.scaleInput.value = String(Number(scale.toPrecision(6)));
  }

  setJoins(joins: boolean): void {
    this.joinsToggle.checked = joins;
  }

  /** The placed drawing's size, the centre of its bounds and its angle — set by the viewport gestures. */
  setReadout(size: { width: number; height: number } | null, at: [number, number], angle: number): void {
    if (!size) {
      this.readout.textContent = '';
      return;
    }
    const unit = sceneUnit.current;
    const fmt = (v: number) => formatLength(v, unit, { suffix: false });
    const turned = angle ? ` · ${Math.round(angle * 10) / 10}°` : '';
    this.readout.textContent = `${fmt(size.width)} × ${fmt(size.height)} ${unit} at ${fmt(at[0])}, ${fmt(at[1])}${turned}`;
  }

  /** What Apply would write, and anything the user should know about it. */
  setSummary(summary: DrawingImportSummary | null): void {
    this.blocked = summary === null || summary.blocked !== null;
    this.notes.replaceChildren();
    if (!summary) {
      this.summary.textContent = '';
      this.warnings.classList.add('hidden');
      this.syncButtons();
      return;
    }
    const entities = `${summary.entities.toLocaleString('en-US')} sketch ${summary.entities === 1 ? 'entity' : 'entities'}`;
    const joins = summary.joins > 0 ? `, ${summary.joins.toLocaleString('en-US')} ${summary.joins === 1 ? 'join' : 'joins'}` : '';
    const pins = summary.pins > 0 ? `, fixed by ${summary.pins.toLocaleString('en-US')} ${summary.pins === 1 ? 'constraint' : 'constraints'}` : '';
    this.summary.textContent = summary.blocked ?? `${entities}${joins}${pins}`;
    this.summary.classList.toggle('text-error', summary.blocked !== null);
    this.summary.classList.toggle('text-base-content/80', summary.blocked === null);
    for (const note of summary.notes) {
      const item = document.createElement('li');
      item.textContent = note;
      this.notes.append(item);
    }
    // Folded until asked for: most imports have a line or two that changes nothing.
    this.warningsTitle.textContent = `Warnings (${summary.notes.length})`;
    this.warnings.classList.toggle('hidden', summary.notes.length === 0);
    this.syncButtons();
  }

  setMessage(message: string | null): void {
    this.shell.setMessage(message);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncButtons();
  }

  // ------------------------------------------------------------ state out

  get joins(): boolean {
    return this.joinsToggle.checked;
  }

  /** Whether the import pins the geometry where it lands. Off until asked for. */
  get fix(): boolean {
    return this.fixToggle.checked;
  }

  get unit(): DrawingUnitChoice {
    return (this.unitSelect.value || 'file') as DrawingUnitChoice;
  }

  private tickedLayers(): Set<string> {
    const ticked = new Set<string>();
    for (const box of this.layersList.querySelectorAll<HTMLInputElement>('input[data-layer]')) {
      if (box.checked) {
        ticked.add(box.dataset.layer!);
      }
    }
    return ticked;
  }

  /** Where the dialog's box starts on screen, from the left, in client pixels; null while it has no size. */
  get clientLeft(): number | null {
    const rect = this.shell.body.getBoundingClientRect();
    return rect.width > 0 ? rect.left : null;
  }

  // --------------------------------------------------------------- shell

  show(): void {
    this.shell.show();
  }

  hide(): void {
    this.shell.hide();
  }

  destroy(): void {
    this.shell.destroy();
  }

  private syncButtons(): void {
    this.applyBtn.disabled = this.busy || !this.hasFile || this.blocked;
  }
}
