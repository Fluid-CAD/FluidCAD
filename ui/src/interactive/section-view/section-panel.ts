import { FeaturePanel } from '../create-feature/feature-panel';
import { PlaneOption } from '../create-feature/plane-bases';
import { PlaneSelection, PlaneSlotControl, StandardPlane } from '../create-feature/plane-slot';
import { iconUrl } from '../../ui/icon-url';

/** Validated form values of the section dialog. */
export type SectionValues = {
  name: string;
  flip: boolean;
};

/**
 * The new-section-view dialog: a name, the plane slot (an origin-plane
 * quad, a `plane()` feature, or a picked planar face — the mirror dialog's
 * exact picker) and the Flip switch. The plane slot is always the armed
 * pick target: it is the dialog's only slot. Pure DOM + form state — the
 * service owns scene data, the picked face, and the apply call.
 */
export class SectionPanel extends FeaturePanel {
  static readonly ID = 'fluidcad-section-panel';
  /** The plane slot left face mode (✕, a standard/plane pick) — drop the entity. */
  onPlaneModeChange?: () => void;

  private readonly planeSlot: PlaneSlotControl;
  private readonly nameInput: HTMLInputElement;
  private readonly flipInput: HTMLInputElement;

  constructor(container: HTMLElement) {
    super(container, {
      id: SectionPanel.ID,
      title: 'Section view',
      icon: iconUrl('plane'),
      exitLabel: 'Cancel',
      bodyHtml: `
        <label class="flex flex-col gap-1.5">
          <span class="text-base-content/70">Name</span>
          <input data-role="name" type="text" maxlength="80" placeholder="A-A"
            class="input input-sm input-bordered w-full text-xs" />
        </label>
        <div data-role="plane-slot"></div>
        <label class="flex items-center gap-2 cursor-pointer" title="Keep the half on the plane normal's side instead of removing it">
          <input data-role="flip" type="checkbox" class="checkbox checkbox-sm" />
          <span class="text-base-content/70">Flip side</span>
        </label>
      `,
    });
    this.nameInput = this.role<HTMLInputElement>('name');
    this.flipInput = this.role<HTMLInputElement>('flip');
    this.nameInput.addEventListener('input', () => this.onChange?.());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onApply?.();
      }
    });
    this.flipInput.addEventListener('change', () => this.onChange?.());

    this.planeSlot = new PlaneSlotControl(this.role('plane-slot'));
    this.planeSlot.onModeChange = () => this.onPlaneModeChange?.();
    this.planeSlot.onChange = () => this.onChange?.();
  }

  /** Open fresh: the suggested name, no plane, flip off; the plane slot armed. */
  show(defaultName: string): void {
    this.shell.setTitle(null);
    this.nameInput.value = defaultName;
    this.flipInput.checked = false;
    this.planeSlot.reset();
    this.planeSlot.setArmed(true);
    this.shell.show();
    this.nameInput.focus();
    this.nameInput.select();
  }

  /** Refresh the offered plane features after a re-render (matched by source location). */
  setOptions(planes: PlaneOption[]): void {
    this.planeSlot.setOptions(planes);
  }

  planeSelection(): PlaneSelection | null {
    return this.planeSlot.selection;
  }

  /** A plane feature picked in 3D; no change event fires. */
  selectPlane(option: PlaneOption): void {
    this.planeSlot.selectOption(option);
  }

  /** An origin-plane quad picked in the viewport; no change event fires. */
  selectStandardPlane(plane: StandardPlane): void {
    this.planeSlot.selectStandard(plane);
  }

  /** The plane slot's picked-face chip (the service owns the entity); null clears it. */
  setPlaneFaceChip(label: string | null): void {
    this.planeSlot.setFaceChip(label);
  }

  values(): SectionValues {
    return { name: this.nameInput.value.trim(), flip: this.flipInput.checked };
  }
}
