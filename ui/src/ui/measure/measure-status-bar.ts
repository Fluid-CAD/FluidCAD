import { ICON_CHEVRON_DOWN, ICON_RULER } from '../icons';
import { sceneUnit } from '../../units/scene-unit';
import { sceneDocument } from '../../units/scene-document';
import type { SceneDocument } from '../../units/scene-document';
import type { LengthUnit } from '../../units/units';
import { showDropupMenu } from '../dropup-menu';
import { buildUnitMenuOptions } from './unit-menu-options';
import type { EngineClient } from '../../engine-client';

/**
 * Bottom-right status row of the viewer: a compact pill showing the primary
 * measurement (e.g. "Parallel dist: 62.09 mm") that expands the full measure
 * panel on click, next to an always-visible chip naming the document unit.
 *
 * On an editor-backed host the chip is a button opening a dropup that
 * changes the document's *declared* unit — never its numbers (a document's
 * numbers ARE its unit). A part file gets a `unit('…')` statement through
 * the editor channel; an assembly, which cannot declare one, changes the
 * project unit in `fluidcad.json` instead.
 */
export class MeasureStatusBar {
  private row: HTMLDivElement;
  private el: HTMLDivElement;
  private labelEl: HTMLSpanElement;
  private valueEl: HTMLSpanElement;
  private chevronEl: HTMLSpanElement;
  private unitChip: HTMLButtonElement;
  /** A refusal to report (the server said no); null hosts stay quiet. */
  onNotice: ((message: string) => void) | null = null;

  constructor(
    private container: HTMLElement,
    onClick: () => void,
    private client: EngineClient | null = null,
  ) {
    // The row anchors where the pill used to; the selection-info overlay
    // sits to its left (its `right-[128px]` = this offset + chip + gap).
    this.row = document.createElement('div');
    this.row.className = 'absolute bottom-6 right-[76px] z-[150] flex items-center gap-2';

    this.el = document.createElement('div');
    this.el.className =
      'panel-bg border border-base-content/10 rounded-lg h-8 px-3 ' +
      'text-xs text-base-content flex items-center gap-2 ' +
      'cursor-pointer select-none hover:border-base-content/30 hidden';
    this.el.title = 'Show all measurements';

    const icon = document.createElement('span');
    icon.className = 'opacity-60 [&>svg]:w-4 [&>svg]:h-4';
    icon.innerHTML = ICON_RULER;

    this.labelEl = document.createElement('span');
    this.labelEl.className = 'text-base-content/60 whitespace-nowrap';

    this.valueEl = document.createElement('span');
    this.valueEl.className = 'font-medium tabular-nums whitespace-nowrap';

    this.chevronEl = document.createElement('span');
    this.chevronEl.className = 'opacity-60 transition-transform rotate-180';
    this.chevronEl.innerHTML = ICON_CHEVRON_DOWN;

    this.el.append(icon, this.labelEl, this.valueEl, this.chevronEl);
    this.el.addEventListener('click', onClick);

    this.unitChip = document.createElement('button');
    this.unitChip.type = 'button';
    this.unitChip.className =
      'panel-bg border border-base-content/10 rounded-lg h-8 min-w-[44px] px-2 ' +
      'text-xs font-medium text-base-content/70 flex items-center justify-center select-none ' +
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
    this.unitChip.title = 'Document unit — set with unit(\'in\') in the file or "unit" in fluidcad.json';
    this.unitChip.dataset.ref = 'document-unit';
    this.unitChip.textContent = sceneUnit.current;
    sceneUnit.subscribe((unit) => {
      this.unitChip.textContent = unit;
    });
    this.applyEditability(sceneDocument.current);
    sceneDocument.subscribe((doc) => this.applyEditability(doc));
    this.unitChip.addEventListener('click', () => this.openUnitMenu());

    this.row.append(this.el, this.unitChip);
    container.appendChild(this.row);
  }

  show(label: string, value: string): void {
    this.labelEl.textContent = `${label}:`;
    this.valueEl.textContent = value;
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  setExpanded(expanded: boolean): void {
    this.chevronEl.classList.toggle('rotate-180', !expanded);
  }

  // ---------------------------------------------------------------------------
  // Unit dropup
  // ---------------------------------------------------------------------------

  /** Only an editor-backed host with a document on screen can change the unit. */
  private get canEdit(): boolean {
    return this.client?.editor != null && sceneDocument.current !== null;
  }

  /** A plain read-only chip in viewing hosts; a menu button everywhere else. */
  private applyEditability(doc: SceneDocument | null): void {
    const editable = this.client?.editor != null && doc !== null;
    this.unitChip.disabled = !editable;
    this.unitChip.classList.toggle('cursor-pointer', editable);
    this.unitChip.classList.toggle('hover:border-base-content/30', editable);
    this.unitChip.classList.toggle('cursor-default', !editable);
    if (editable) {
      this.unitChip.setAttribute('aria-haspopup', 'menu');
      this.unitChip.setAttribute('aria-expanded', 'false');
    } else {
      this.unitChip.removeAttribute('aria-haspopup');
      this.unitChip.removeAttribute('aria-expanded');
    }
  }

  private openUnitMenu(): void {
    const doc = sceneDocument.current;
    if (!this.canEdit || !doc) {
      return;
    }
    showDropupMenu(this.container, this.unitChip, {
      header: doc.kind === 'assembly' ? 'Project unit (fluidcad.json)' : 'Document unit',
      items: buildUnitMenuOptions(doc, sceneUnit.current).map((option) => ({
        label: option.label,
        current: option.current,
        onSelect: () => {
          // Re-picking the checked entry would be a rewrite to the same
          // text (or, for "Same as project", a no-op transform) — skip it.
          if (!option.current) {
            void this.applyUnit(doc, option.unit);
          }
        },
      })),
    });
  }

  /**
   * Route the pick by the document's kind. Either way the chip itself does
   * not change here: the next `scene-rendered` carries the new unit, and
   * everything that prints a length (this chip included) follows it. A null
   * unit (parts only — the menu never offers it for an assembly) removes the
   * file's declaration so it follows the project unit.
   */
  private async applyUnit(doc: SceneDocument, unit: LengthUnit | null): Promise<void> {
    const editor = this.client?.editor;
    if (!editor) {
      return;
    }
    const result = doc.kind === 'assembly'
      ? await editor.setProjectUnit(unit ?? doc.projectUnit)
      : await editor.setDocumentUnit(doc.absPath, unit);
    if (!result.success) {
      this.onNotice?.(result.reason ?? 'Could not change the document unit.');
    }
  }
}
