import { PanelShell } from '../create-feature/panel-controls';
import { sceneUnit } from '../../units/scene-unit';
import { formatLength } from '../../units/units';
import { iconUrl } from '../../ui/icon-url';
import type { PixelSize } from '../../scene/reference-image-loader';
import { REFERENCE_IMAGE_TYPES } from '../../scene/reference-image-loader';

/** Where the Calibrate gesture stands. */
export type CalibrateState = 'idle' | 'first' | 'second' | 'distance';

const CALIBRATE_HINTS: Record<CalibrateState, string> = {
  idle: '',
  first: 'Click the first point on the picture.',
  second: 'Click the second point.',
  distance: 'Type the real distance between the points and press Enter.',
};

/**
 * The Image tool's dialog, reduced to what the viewport cannot do: pick
 * the file, set how faded the picture draws, start a calibration, and
 * Apply / Cancel. Size, place and angle are read-outs here — they are set
 * by dragging the picture, its corner handles and its rotate knob. A
 * picture is removed from its timeline row, like any other statement.
 */
export class ReferenceImagePanel {
  onOpacity?: (opacity: number) => void;
  onCalibrate?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  /** A picture the user picked; the tool decodes it and calls {@link setFile}. */
  onFile?: (file: File) => void;

  private shell: PanelShell;
  private fileInput: HTMLInputElement;
  private fileLabel: HTMLDivElement;
  private readout: HTMLDivElement;
  private hint: HTMLDivElement;
  private opacityRange: HTMLInputElement;
  private opacityLabel: HTMLSpanElement;
  private calibrateBtn: HTMLButtonElement;
  private applyBtn: HTMLButtonElement;
  private hasFile = false;
  private busy = false;

  constructor(container: HTMLElement) {
    // A sketch tool's dialog: Escape inside it cancels the tool.
    this.shell = new PanelShell(container, 'fluidcad-reference-image-panel', 'Reference image', iconUrl('image'), 'inside');
    this.shell.onEscape = () => this.onExit?.();
    this.shell.body.insertAdjacentHTML('beforeend', `
      <div class="flex flex-col gap-1.5">
        <button type="button" data-role="choose" class="btn btn-sm btn-outline w-full">Choose image…</button>
        <input data-role="file" type="file" accept="${REFERENCE_IMAGE_TYPES.join(',')}" class="hidden" />
        <div data-role="file-label" class="text-base-content/60 truncate" title="">No image chosen</div>
      </div>
      <div data-role="readout" class="text-base-content/70 tabular-nums leading-snug"
        title="Drag the picture to move it, a corner to resize it (hold Shift to stretch), the knob above it to rotate (Shift snaps to 15°)">
        Drag the picture to place it; its corners resize, the knob rotates.
      </div>
      <div class="flex flex-col gap-1.5">
        <button type="button" data-role="calibrate" class="btn btn-sm btn-outline w-full"
          title="Click two points on the picture and type the real distance between them: the picture scales to match">Calibrate…</button>
        <div data-role="hint" class="hidden text-primary leading-snug"></div>
      </div>
      <div class="flex flex-col gap-1.5" title="How solid the picture draws under the sketch">
        <span class="text-base-content/70">Opacity</span>
        <div class="flex items-center gap-2">
          <input data-role="opacity" type="range" min="0" max="100" step="1" value="50" class="range range-xs range-primary flex-1" />
          <span data-role="opacity-label" class="text-xs text-base-content/60 tabular-nums w-10 text-right">50%</span>
        </div>
      </div>
    `);
    this.shell.footer.insertAdjacentHTML('beforeend', `
      <button type="button" data-role="apply" class="btn btn-primary btn-sm flex-1">Apply</button>
      <button type="button" data-role="exit" class="btn btn-ghost btn-sm">Cancel</button>
    `);

    this.fileInput = this.role('file');
    this.fileLabel = this.role('file-label');
    this.readout = this.role('readout');
    this.hint = this.role('hint');
    this.opacityRange = this.role('opacity');
    this.opacityLabel = this.role('opacity-label');
    this.calibrateBtn = this.role('calibrate');
    this.applyBtn = this.role('apply');

    this.role<HTMLButtonElement>('choose').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) {
        this.onFile?.(file);
      }
    });
    this.opacityRange.addEventListener('input', () => {
      this.syncOpacityLabel();
      this.onOpacity?.(this.opacity);
    });
    this.calibrateBtn.addEventListener('click', () => this.onCalibrate?.());
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
      throw new Error(`reference image panel: no element with role ${name}`);
    }
    return el;
  }

  // ------------------------------------------------------------- state in

  /** The picture on show: its name (the written path's file name, or the chosen file's) and pixels, once known. */
  setFile(name: string, pixel: PixelSize | null): void {
    this.hasFile = true;
    const text = pixel ? `${name} · ${pixel.width}×${pixel.height} px` : name;
    this.fileLabel.textContent = text;
    this.fileLabel.title = text;
    this.syncButtons();
  }

  /** The picture's size, centre and angle as they stand — set by the viewport gestures. */
  setReadout(size: { width: number; height: number } | null, at: [number, number], angle: number): void {
    if (!size) {
      return;
    }
    const unit = sceneUnit.current;
    const fmt = (v: number) => formatLength(v, unit, { suffix: false });
    const turned = angle ? ` · ${Math.round(angle * 10) / 10}°` : '';
    this.readout.textContent = `${fmt(size.width)} × ${fmt(size.height)} ${unit} at ${fmt(at[0])}, ${fmt(at[1])}${turned}`;
  }

  setOpacity(opacity: number): void {
    this.opacityRange.value = String(Math.round(opacity * 100));
    this.syncOpacityLabel();
  }

  setCalibrateState(state: CalibrateState): void {
    const active = state !== 'idle';
    this.calibrateBtn.classList.toggle('btn-primary', active);
    this.calibrateBtn.classList.toggle('btn-outline', !active);
    this.calibrateBtn.textContent = active ? 'Cancel calibration' : 'Calibrate…';
    this.hint.textContent = CALIBRATE_HINTS[state];
    this.hint.classList.toggle('hidden', !active);
  }

  setMessage(message: string | null): void {
    this.shell.setMessage(message);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncButtons();
  }

  // ------------------------------------------------------------ state out

  get opacity(): number {
    return Math.min(1, Math.max(0, Number(this.opacityRange.value) / 100));
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

  // ------------------------------------------------------------- helpers

  private syncOpacityLabel(): void {
    this.opacityLabel.textContent = `${this.opacityRange.value}%`;
  }

  private syncButtons(): void {
    this.applyBtn.disabled = this.busy || !this.hasFile;
    this.calibrateBtn.disabled = this.busy || !this.hasFile;
  }
}
