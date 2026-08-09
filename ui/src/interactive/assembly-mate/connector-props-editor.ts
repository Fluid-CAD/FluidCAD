import { FeaturePanel } from '../create-feature/feature-panel';
import {
  applyConnectorProperties,
  fetchConnectorProperties,
  ConnectorProperties,
} from '../../api';
import type { Viewer } from '../../viewer';
import type { MateSlotState } from './mate-service';

const NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The two-chasing-arrows rotate glyph (mirrors the connector dialog's). */
const ROTATE_ICON = `
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.5 9.5A8.5 8.5 0 0 0 5.2 6.2"/>
    <polyline points="5.2 2.2 5.2 6.2 9.2 6.2"/>
    <path d="M3.5 14.5a8.5 8.5 0 0 0 15.3 3.3"/>
    <polyline points="18.8 21.8 18.8 17.8 14.8 17.8"/>
  </svg>`;

/**
 * The pen-button sub-dialog: the picked connector's name, frame-local offset
 * and rotation — the same fields the part-mode connector dialog edits, minus
 * the source slot (the anchor stays what the statement says). Docked beside
 * the mate dialog; applying rewrites the `connector()` statement in its part
 * file.
 */
class ConnectorPropsPanel extends FeaturePanel {
  private nameInput: HTMLInputElement;
  private offsetInputs: [HTMLInputElement, HTMLInputElement, HTMLInputElement];
  private rotateAxisSelect: HTMLSelectElement;
  private rotationValue: HTMLSpanElement;
  private rotateAngle = 0;

  constructor(container: HTMLElement) {
    super(container, {
      id: 'fluidcad-connector-props-panel',
      title: 'Connector',
      icon: '/icons/mate-connector.png',
      bodyHtml: `
        <label class="flex flex-col gap-1.5"
          title="The identifier the connector registers under — mates reference it as instance.connectors.<name>">
          <span class="text-base-content/70">Name</span>
          <input data-role="name" type="text" spellcheck="false" autocomplete="off"
            class="input input-sm input-bordered w-full text-xs font-mono" />
        </label>
        <div class="flex flex-col gap-1.5"
          title="Move the connector along its own axes — measured before the rotation">
          <span class="text-base-content/70">Offset (X, Y, Z)</span>
          <div class="flex gap-1.5">
            <input data-role="offset-x" type="number" step="any" placeholder="0" title="Along the connector's X axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-y" type="number" step="any" placeholder="0" title="Along the connector's Y axis"
              class="input input-sm input-bordered w-full text-xs" />
            <input data-role="offset-z" type="number" step="any" placeholder="0" title="Along the connector's Z axis (the frame normal)"
              class="input input-sm input-bordered w-full text-xs" />
          </div>
        </div>
        <div class="flex flex-col gap-1.5"
          title="Turn the connector around one of its own axes, 90° per click — it pivots where the offset put it">
          <span class="text-base-content/70">Rotation</span>
          <div class="flex items-center gap-1.5">
            <select data-role="rotate-axis" class="select select-sm select-bordered flex-1 text-xs"
              title="The connector's own axis to rotate around">
              <option value="z" selected>Around Z</option>
              <option value="x">Around X</option>
              <option value="y">Around Y</option>
            </select>
            <button data-role="rotate" type="button" class="btn btn-ghost btn-sm gap-1.5 shrink-0">
              ${ROTATE_ICON}
              <span data-role="rotation-value" class="font-mono">0°</span>
            </button>
          </div>
        </div>
      `,
      exitLabel: 'Close',
    });

    this.nameInput = this.role<HTMLInputElement>('name');
    this.offsetInputs = [
      this.role<HTMLInputElement>('offset-x'),
      this.role<HTMLInputElement>('offset-y'),
      this.role<HTMLInputElement>('offset-z'),
    ];
    for (const input of [this.nameInput, ...this.offsetInputs]) {
      input.addEventListener('input', () => this.onChange?.());
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.onApply?.();
        }
      });
    }
    this.rotateAxisSelect = this.role<HTMLSelectElement>('rotate-axis');
    this.rotateAxisSelect.addEventListener('change', () => this.onChange?.());
    this.rotationValue = this.role<HTMLSpanElement>('rotation-value');
    this.role<HTMLButtonElement>('rotate').addEventListener('click', () => {
      this.rotateAngle = (this.rotateAngle + 90) % 360;
      this.rotationValue.textContent = `${this.rotateAngle}°`;
      this.onChange?.();
    });
  }

  /** Seed every field from the parsed statement and show the dialog. */
  showSeeded(title: string, props: ConnectorProperties): void {
    this.shell.setTitle(title);
    this.nameInput.value = props.name;
    this.offsetInputs.forEach((input, index) => {
      const value = props.offset?.[index] ?? 0;
      input.value = value === 0 ? '' : String(value);
    });
    this.rotateAxisSelect.value = props.rotate?.axis ?? 'z';
    this.rotateAngle = (((props.rotate?.angle ?? 0) % 360) + 360) % 360;
    this.rotationValue.textContent = `${this.rotateAngle}°`;
    this.shell.show();
    this.positionBesideMateDialog();
  }

  values(): ConnectorProperties | { error: string } {
    const name = this.nameInput.value.trim();
    if (name === '' || name.length > 64 || !NAME_PATTERN.test(name)) {
      return { error: "Enter a connector name — a plain identifier like 'mountTop'." };
    }
    const offset: number[] = [];
    for (const input of this.offsetInputs) {
      const raw = input.value.trim();
      const value = raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(value)) {
        return { error: 'Offsets must be numbers.' };
      }
      offset.push(value);
    }
    const axis = this.rotateAxisSelect.value as 'x' | 'y' | 'z';
    return {
      name,
      rotate: this.rotateAngle === 0 ? null : { axis, angle: this.rotateAngle },
      offset: offset.every(v => v === 0) ? null : offset as [number, number, number],
    };
  }

  /**
   * Slide the float out from under the mate dialog: the mate panel is glued
   * to the viewport's right edge, so "beside" means directly to its left,
   * edge-aligned with an 8px gutter. Mobile keeps the bottom-sheet layout
   * (the sheets stack; the mate dialog is hidden under this one until it
   * closes).
   */
  private positionBesideMateDialog(): void {
    const root = document.getElementById('fluidcad-connector-props-panel');
    const mate = document.getElementById('fluidcad-mate-panel');
    if (!root || !mate) {
      return;
    }
    if (!window.matchMedia('(min-width: 640px)').matches) {
      root.style.right = '';
      return;
    }
    const rect = mate.getBoundingClientRect();
    if (rect.width === 0) {
      root.style.right = '';
      return;
    }
    const host = root.offsetParent as HTMLElement | null;
    const hostRight = host ? host.getBoundingClientRect().right : window.innerWidth;
    root.style.right = `${Math.round(hostRight - rect.left + 8)}px`;
  }
}

/**
 * Orchestrates the pen-button flow: fetch the statement's properties, seed
 * the panel beside the mate dialog, and apply the rewrite through
 * `/api/assembly-connector`. One instance serves both mate slots; opening
 * for another connector re-seeds in place.
 */
export class ConnectorPropsEditor {
  private panel: ConnectorPropsPanel;
  private target: {
    sourceLocation: { filePath: string; line: number };
    slot: MateSlotState;
    originalName: string;
  } | null = null;
  private applying = false;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private hooks: {
      /** The connector was renamed — the mate dialog re-points its slot. */
      onRenamed?: (slot: MateSlotState, newName: string) => void;
    } = {},
  ) {
    this.panel = new ConnectorPropsPanel(container);
    this.panel.onExit = () => this.close();
    this.panel.onChange = () => this.panel.setMessage(null);
    this.panel.onApply = () => void this.apply();
  }

  /** The mate dialog's pen: open (or re-seed) the editor for a picked connector. */
  async open(slot: MateSlotState): Promise<void> {
    const sourceLocation = this.viewer.getAssemblyController()
      ?.getConnectorSourceLocation(slot.connectorId) ?? null;
    if (!sourceLocation) {
      return;
    }
    const props = await fetchConnectorProperties(sourceLocation);
    if ('error' in props) {
      // Statement forms the dialog can't hold (expression offsets, multi-
      // rotate chains) refuse with the reason — show it where the user
      // clicked instead of opening an unfaithful editor.
      this.panel.showSeeded(`${slot.instanceName} · ${slot.connectorName}`, {
        name: slot.connectorName, rotate: null, offset: null,
      });
      this.panel.setApplyEnabled(false);
      this.panel.setMessage(props.error);
      this.target = null;
      return;
    }
    this.target = { sourceLocation, slot, originalName: props.name };
    this.panel.setApplyEnabled(true);
    this.panel.showSeeded(`${slot.instanceName} · ${props.name}`, props);
  }

  close(): void {
    this.target = null;
    this.panel.hide();
  }

  get isOpen(): boolean {
    return this.panel.isVisible;
  }

  private async apply(): Promise<void> {
    if (!this.target || this.applying) {
      return;
    }
    const values = this.panel.values();
    if ('error' in values) {
      this.panel.setMessage(values.error);
      return;
    }
    this.applying = true;
    this.panel.setApplyEnabled(false);
    try {
      const result = await applyConnectorProperties(this.target.sourceLocation, values);
      if (!result.success) {
        this.panel.setMessage(result.reason ?? 'Could not apply the connector edit.');
        this.panel.setApplyEnabled(true);
        return;
      }
      if (values.name !== this.target.originalName) {
        this.hooks.onRenamed?.(this.target.slot, values.name);
      }
      this.close();
    } finally {
      this.applying = false;
    }
  }
}
