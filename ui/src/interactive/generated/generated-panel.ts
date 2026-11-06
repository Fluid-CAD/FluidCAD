import { SchemaFeaturePanel } from '../create-feature/schema/schema-feature-panel';
import type { GeneratedDefinition } from './generated-definition';

/**
 * The custom-feature dialog over a generated definition's values (values
 * only: no picks, no operation tabs, no Preview toggle — the viewport shows
 * the real result while it is open), with two quiet additions: an
 * "Updating…" mark at the end of the title row while a preview takes
 * longer than a moment, and a note at the top of the body saying why the
 * preview was rebuilt. Cancel, not Exit: closing it restores the model.
 */
export class GeneratedPanel extends SchemaFeaturePanel {
  /** The dialog's element id: one generated dialog is open at a time. */
  static readonly ID = 'fluidcad-generated-dialog';

  private readonly updating: HTMLElement;
  private readonly note: HTMLElement;

  constructor(container: HTMLElement, readonly definition: GeneratedDefinition) {
    super(container, definition.featureSchema(), definition.iconSrc, { id: GeneratedPanel.ID, exitLabel: 'Cancel' });
    this.updating = document.createElement('span');
    this.updating.dataset.role = 'updating';
    this.updating.className = 'hidden ml-auto items-center gap-1 text-[11px] text-base-content/50 font-normal';
    this.updating.innerHTML = '<span class="loading loading-spinner loading-xs"></span><span>Updating…</span>';
    this.shell.header.append(this.updating);
    this.note = document.createElement('div');
    this.note.dataset.role = 'preview-note';
    this.note.className = 'hidden text-[11px] leading-snug text-base-content/60';
    this.body.prepend(this.note);
  }

  /** Show or hide "Updating…" (the newest preview is taking a while). */
  setUpdating(on: boolean): void {
    this.updating.classList.toggle('hidden', !on);
    this.updating.classList.toggle('flex', on);
  }

  get isUpdating(): boolean {
    return !this.updating.classList.contains('hidden');
  }

  /** A line saying what happened to the preview (a render replaced it, and it was rebuilt); null hides it. */
  setNote(text: string | null): void {
    this.note.textContent = text ?? '';
    this.note.classList.toggle('hidden', text === null);
  }

  /** Retitle the dialog ("Edit crate1"); null restores the definition's label. */
  setTitle(title: string | null): void {
    this.shell.setTitle(title);
  }
}
