import { PanelShell } from '../create-feature/panel-controls';
import { applyUnitDefaults, applyUnitTitles } from '../../units/apply-unit-defaults';
import { sceneUnit } from '../../units/scene-unit';
import { iconUrl } from '../../ui/icon-url';
import type { SketchImageData } from '../../types';
import type { PixelSize } from '../../scene/reference-image-loader';
import { REFERENCE_IMAGE_TYPES } from '../../scene/reference-image-loader';

/** The dialog's read of its fields, or why it has none. */
export type ReferenceImageValues = { values: SketchImageData } | { error: string };

/** Which size field the user typed last — the one that is written while the aspect is locked. */
type SizeAxis = 'width' | 'height';

/**
 * The Image tool's dialog: the picture (a file picker), its size on the
 * plane (Width / Height, with Lock aspect deriving one from the other
 * through the picture's pixel aspect — "scale from a known dimension"),
 * where its centre sits, its rotation and how solid it draws. Pure DOM +
 * form state: the tool owns the file bytes, the live preview, the
 * viewport click that moves the centre, the upload and the commit. Every
 * edit fires `onChange`, which the tool answers with a fresh preview.
 */
export class ReferenceImagePanel {
  onChange?: () => void;
  onApply?: () => void;
  onExit?: () => void;
  onRemove?: () => void;
  /** A picture the user picked; the tool decodes it and calls {@link setFile}. */
  onFile?: (file: File) => void;

  private shell: PanelShell;
  private fileInput: HTMLInputElement;
  private fileLabel: HTMLDivElement;
  private widthInput: HTMLInputElement;
  private heightInput: HTMLInputElement;
  private lockToggle: HTMLInputElement;
  private xInput: HTMLInputElement;
  private yInput: HTMLInputElement;
  private angleInput: HTMLInputElement;
  private opacityRange: HTMLInputElement;
  private opacityLabel: HTMLSpanElement;
  private applyBtn: HTMLButtonElement;
  private removeBtn: HTMLButtonElement;
  private unsubscribeUnit: () => void;
  private pixel: PixelSize | null = null;
  /** Whether a picture is set (chosen here or already in the model) — Apply needs one. */
  private hasFile = false;
  private lastSizeAxis: SizeAxis = 'width';
  /** The written record's own size fields, so an untouched edit keeps its shape. */
  private src: string | null = null;

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
      <div class="flex items-center gap-1.5">
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="The picture's width on the sketch plane, in {unit}">
          <span class="text-base-content/70">Width</span>
          <input data-role="width" data-unit="length" type="number" step="1" min="0" value="100"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="The picture's height on the sketch plane, in {unit}">
          <span class="text-base-content/70">Height</span>
          <input data-role="height" data-unit="length" type="number" step="1" min="0" value="100"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
      </div>
      <label class="flex items-center justify-between cursor-pointer"
        title="Keep the picture's proportions: typing one size derives the other from its pixels">
        <span class="text-base-content/70">Lock aspect</span>
        <input data-role="lock" type="checkbox" checked class="toggle toggle-sm toggle-primary" />
      </label>
      <div class="flex items-center gap-1.5">
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="Centre of the picture along the sketch x axis, in {unit} (click the viewport to place it)">
          <span class="text-base-content/70">Centre X</span>
          <input data-role="x" data-unit="length" type="number" step="1" value="0"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
        <label class="flex flex-col gap-1.5 flex-1 min-w-0" data-unit-title="Centre of the picture along the sketch y axis, in {unit} (click the viewport to place it)">
          <span class="text-base-content/70">Centre Y</span>
          <input data-role="y" data-unit="length" type="number" step="1" value="0"
            class="input input-sm input-bordered w-full min-w-0 text-xs" />
        </label>
      </div>
      <label class="flex flex-col gap-1.5" title="Rotation about the plane normal, degrees counter-clockwise">
        <span class="text-base-content/70">Angle</span>
        <input data-role="angle" type="number" step="1" value="0"
          class="input input-sm input-bordered w-full min-w-0 text-xs" />
      </label>
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
      <button type="button" data-role="remove" class="btn btn-ghost btn-sm text-error hidden" title="Take the picture off this sketch">Remove</button>
      <button type="button" data-role="exit" class="btn btn-ghost btn-sm">Cancel</button>
    `);

    this.fileInput = this.role('file');
    this.fileLabel = this.role('file-label');
    this.widthInput = this.role('width');
    this.heightInput = this.role('height');
    this.lockToggle = this.role('lock');
    this.xInput = this.role('x');
    this.yInput = this.role('y');
    this.angleInput = this.role('angle');
    this.opacityRange = this.role('opacity');
    this.opacityLabel = this.role('opacity-label');
    this.applyBtn = this.role('apply');
    this.removeBtn = this.role('remove');

    applyUnitDefaults(this.shell.body);
    applyUnitTitles(this.shell.body);
    this.unsubscribeUnit = sceneUnit.subscribe(() => {
      if (!this.shell.isVisible) {
        applyUnitDefaults(this.shell.body);
      }
      applyUnitTitles(this.shell.body);
    });

    this.role<HTMLButtonElement>('choose').addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) {
        this.onFile?.(file);
      }
    });
    this.widthInput.addEventListener('input', () => {
      this.lastSizeAxis = 'width';
      this.deriveSize('width');
      this.onChange?.();
    });
    this.heightInput.addEventListener('input', () => {
      this.lastSizeAxis = 'height';
      this.deriveSize('height');
      this.onChange?.();
    });
    this.lockToggle.addEventListener('change', () => {
      this.deriveSize(this.lastSizeAxis);
      this.onChange?.();
    });
    for (const input of [this.xInput, this.yInput, this.angleInput]) {
      input.addEventListener('input', () => this.onChange?.());
    }
    this.opacityRange.addEventListener('input', () => {
      this.syncOpacityLabel();
      this.onChange?.();
    });
    this.applyBtn.addEventListener('click', () => this.onApply?.());
    this.removeBtn.addEventListener('click', () => this.onRemove?.());
    this.role<HTMLButtonElement>('exit').addEventListener('click', () => this.onExit?.());
    // Enter in a field applies; the sketch tools' single-letter chords must
    // not fire from a focused field either.
    this.shell.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') {
        e.preventDefault();
        this.onApply?.();
        return;
      }
      if (e.key !== 'Escape') {
        e.stopPropagation();
      }
    });
    this.syncApplyEnabled();
  }

  private role<T extends HTMLElement = HTMLElement>(name: string): T {
    const el = this.shell.body.querySelector<T>(`[data-role="${name}"]`) ?? this.shell.footer.querySelector<T>(`[data-role="${name}"]`);
    if (!el) {
      throw new Error(`reference image panel: no element with role ${name}`);
    }
    return el;
  }

  // ------------------------------------------------------------- state in

  /**
   * Seed from the sketch's written record (edit mode): the fields take its
   * values, a one-sided size derives the other once the pixel size is
   * known, and Remove shows.
   */
  setValues(spec: SketchImageData, pixel: PixelSize | null): void {
    this.src = spec.src;
    this.pixel = pixel;
    this.hasFile = true;
    this.setFileLabel(spec.src.replace(/^.*\//, ''), pixel);
    if (spec.width !== undefined) {
      this.widthInput.value = ReferenceImagePanel.text(spec.width);
    }
    if (spec.height !== undefined) {
      this.heightInput.value = ReferenceImagePanel.text(spec.height);
    }
    const explicit = spec.width !== undefined && spec.height !== undefined;
    this.lockToggle.checked = !explicit;
    this.lastSizeAxis = spec.width !== undefined ? 'width' : 'height';
    this.deriveSize(this.lastSizeAxis);
    this.xInput.value = ReferenceImagePanel.text(spec.at[0]);
    this.yInput.value = ReferenceImagePanel.text(spec.at[1]);
    this.angleInput.value = ReferenceImagePanel.text(spec.angle);
    this.opacityRange.value = String(Math.round(spec.opacity * 100));
    this.syncOpacityLabel();
    this.removeBtn.classList.remove('hidden');
    this.syncApplyEnabled();
  }

  /** A picture chosen in the dialog: its name and pixels; the size fields re-derive from the new aspect. */
  setFile(name: string, pixel: PixelSize): void {
    this.hasFile = true;
    this.pixel = pixel;
    this.setFileLabel(name, pixel);
    this.deriveSize(this.lastSizeAxis);
    this.syncApplyEnabled();
  }

  /** The pixel size of the sketch's own picture arrived after the dialog opened. */
  setPixelSize(pixel: PixelSize): void {
    this.pixel = pixel;
    this.setFileLabel(this.fileLabel.textContent?.replace(/\s·.*$/, '') ?? '', pixel);
    this.deriveSize(this.lastSizeAxis);
  }

  /** The viewport click that places the picture. */
  setCenter(x: number, y: number): void {
    this.xInput.value = ReferenceImagePanel.text(x);
    this.yInput.value = ReferenceImagePanel.text(y);
  }

  setMessage(message: string | null): void {
    this.shell.setMessage(message);
  }

  setApplyEnabled(enabled: boolean): void {
    this.applyBtn.disabled = !enabled || !this.hasFile;
  }

  // ------------------------------------------------------------ state out

  /** Whether the aspect lock is on — the written chain then carries one size, the typed one. */
  get aspectLocked(): boolean {
    return this.lockToggle.checked;
  }

  values(): ReferenceImageValues {
    if (!this.hasFile) {
      return { error: 'Choose an image first.' };
    }
    const width = ReferenceImagePanel.number(this.widthInput.value);
    const height = ReferenceImagePanel.number(this.heightInput.value);
    const unit = sceneUnit.current;
    const locked = this.lockToggle.checked;
    const typedAxis = locked ? this.lastSizeAxis : null;
    if ((typedAxis === null || typedAxis === 'width') && (width === null || width <= 0)) {
      return { error: `Width must be a positive length in ${unit}.` };
    }
    if ((typedAxis === null || typedAxis === 'height') && (height === null || height <= 0)) {
      return { error: `Height must be a positive length in ${unit}.` };
    }
    const x = ReferenceImagePanel.number(this.xInput.value);
    const y = ReferenceImagePanel.number(this.yInput.value);
    if (x === null || y === null) {
      return { error: `Centre X and Y must be lengths in ${unit}.` };
    }
    const angle = ReferenceImagePanel.number(this.angleInput.value);
    if (angle === null) {
      return { error: 'Angle must be a number of degrees.' };
    }
    const opacity = Math.min(1, Math.max(0, Number(this.opacityRange.value) / 100));
    const size = locked
      ? (typedAxis === 'width' ? { width: width! } : { height: height! })
      : { width: width!, height: height! };
    return { values: { src: this.src ?? '', ...size, at: [x, y], angle, opacity } };
  }

  // --------------------------------------------------------------- shell

  show(): void {
    this.shell.show();
    this.widthInput.focus();
    this.widthInput.select();
  }

  hide(): void {
    this.shell.hide();
  }

  destroy(): void {
    this.unsubscribeUnit();
    this.shell.destroy();
  }

  // ------------------------------------------------------------- helpers

  /** With the lock on and a known aspect, the other size follows the typed one. */
  private deriveSize(from: SizeAxis): void {
    if (!this.lockToggle.checked || !this.pixel || this.pixel.width <= 0 || this.pixel.height <= 0) {
      return;
    }
    const aspect = this.pixel.width / this.pixel.height;
    if (from === 'width') {
      const width = ReferenceImagePanel.number(this.widthInput.value);
      if (width !== null && width > 0) {
        this.heightInput.value = ReferenceImagePanel.text(width / aspect);
      }
    } else {
      const height = ReferenceImagePanel.number(this.heightInput.value);
      if (height !== null && height > 0) {
        this.widthInput.value = ReferenceImagePanel.text(height * aspect);
      }
    }
  }

  private setFileLabel(name: string, pixel: PixelSize | null): void {
    const text = pixel ? `${name} · ${pixel.width}×${pixel.height} px` : name;
    this.fileLabel.textContent = text;
    this.fileLabel.title = text;
  }

  private syncOpacityLabel(): void {
    this.opacityLabel.textContent = `${this.opacityRange.value}%`;
  }

  private syncApplyEnabled(): void {
    this.applyBtn.disabled = !this.hasFile;
  }

  private static number(text: string): number | null {
    const value = parseFloat(text);
    return Number.isFinite(value) ? value : null;
  }

  /** Compact field text (no float noise). */
  private static text(value: number): string {
    return String(Math.round(value * 1000) / 1000);
  }
}
