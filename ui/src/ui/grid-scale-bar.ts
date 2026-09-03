import { ICON_GRID, ICON_LOCK, ICON_LOCK_OPEN } from './icons';
import { formatGridPitch } from '../grid/grid-spacing';
import type { GridSpacing } from '../grid/grid-spacing';
import { lockGridPitch, parseGridPitch, setGridLocked } from '../grid/grid-pitch';
import type { PreferenceSaver } from '../grid/grid-pitch';
import { sceneUnit } from '../units/scene-unit';
import { viewerSettings } from '../scene/viewer-settings';
import { bottomRightRow, BOTTOM_RIGHT_ORDER } from './bottom-right-row';

/** How long the field flashes red after a value it cannot use. */
const INVALID_FLASH_MS = 600;

const LOCK_TITLE = 'Unlock (adaptive to zoom)';
const UNLOCK_TITLE = 'Lock grid spacing (fixed pitch)';

/**
 * Bottom-left readout of the grid's minor pitch ("10 mm", "1/8 in"). The
 * adaptive grid re-pitches with zoom, which makes a bare lattice ambiguous
 * — this names it, the way a map names its scale bar. Shown whenever the
 * grid is; the mode manager feeds it.
 *
 * It is also where the pitch is set: clicking the value opens an inline
 * field (decimals and simple fractions, in document units), and committing
 * pins the grid to that pitch — the padlock closes. The padlock alone
 * toggles between the pinned pitch and the zoom ladder. Both write the same
 * `viewerSettings` keys the Settings dialog's Grid section edits, so the two
 * never disagree.
 */
export class GridScaleBar {
  private el: HTMLDivElement;
  private valueBtn: HTMLButtonElement;
  private unitEl: HTMLSpanElement;
  private inputEl: HTMLInputElement;
  private lockBtn: HTMLButtonElement;
  private spacing: GridSpacing | null = null;
  private editing = false;
  /** Set by Escape so the blur that follows the field's removal doesn't commit. */
  private cancelling = false;
  private flashTimer: number | undefined;

  constructor(container: HTMLElement, private save: PreferenceSaver = () => {}) {
    this.el = document.createElement('div');
    // Same chip styling as the document-unit chip, which it sits beside in
    // the shared bottom-right row.
    this.el.className =
      'panel-bg border border-base-content/10 rounded-lg h-8 pl-2.5 pr-1.5 ' +
      'text-xs text-base-content/70 flex items-center gap-1.5 select-none ' +
      `hidden ${BOTTOM_RIGHT_ORDER.gridScale}`;
    this.el.title = 'Grid spacing (minor cell)';
    this.el.dataset.ref = 'grid-scale';

    const icon = document.createElement('span');
    icon.className = 'opacity-60 [&>svg]:w-4 [&>svg]:h-4';
    icon.innerHTML = ICON_GRID;

    // The value is a button (click to edit) and the unit a plain suffix, so
    // the edit field replaces exactly the number and the unit stays put.
    this.valueBtn = document.createElement('button');
    this.valueBtn.type = 'button';
    this.valueBtn.className =
      'font-medium tabular-nums whitespace-nowrap rounded px-0.5 -mx-0.5 cursor-text ' +
      'hover:bg-base-content/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
    this.valueBtn.title = 'Click to set the grid spacing';
    this.valueBtn.dataset.ref = 'grid-scale-value';
    this.valueBtn.addEventListener('click', () => this.beginEdit());

    this.inputEl = document.createElement('input');
    this.inputEl.type = 'text';
    this.inputEl.inputMode = 'decimal';
    this.inputEl.spellcheck = false;
    this.inputEl.className =
      'font-medium tabular-nums w-14 h-6 px-1 rounded bg-base-100 text-base-content ' +
      'border border-base-content/20 outline-none focus:border-primary/60 hidden';
    this.inputEl.dataset.ref = 'grid-scale-input';
    this.inputEl.setAttribute('aria-label', 'Grid spacing');
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
      }
    });
    this.inputEl.addEventListener('blur', () => {
      if (this.editing && !this.cancelling) {
        this.commit(false);
      }
    });

    this.unitEl = document.createElement('span');
    this.unitEl.className = 'font-medium whitespace-nowrap';

    this.lockBtn = document.createElement('button');
    this.lockBtn.type = 'button';
    this.lockBtn.className =
      'flex items-center justify-center w-6 h-6 rounded opacity-70 hover:opacity-100 hover:bg-base-content/[0.08] ' +
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
    this.lockBtn.dataset.ref = 'grid-scale-lock';
    this.lockBtn.addEventListener('click', () => {
      setGridLocked(viewerSettings.current.gridAdaptive, this.save);
    });

    this.el.append(icon, this.valueBtn, this.inputEl, this.unitEl, this.lockBtn);
    bottomRightRow(container).appendChild(this.el);

    // The dialog's Grid section writes the same store: a lock toggled there
    // shows here, and a pitch typed here shows there.
    viewerSettings.subscribe(() => this.render());
    sceneUnit.subscribe(() => this.render());
    this.render();
  }

  update(spacing: GridSpacing | null, visible: boolean): void {
    this.spacing = spacing;
    if (!spacing || !visible) {
      if (this.editing) {
        this.cancelEdit();
      }
      this.el.classList.add('hidden');
      return;
    }
    this.render();
    this.el.classList.remove('hidden');
  }

  /** The current readout ("10 mm"), for tests and hosts. */
  get text(): string | null {
    return this.spacing ? `${this.valueBtn.textContent} ${this.unitEl.textContent}` : null;
  }

  /** Whether the padlock is closed (fixed pitch). */
  get locked(): boolean {
    return !viewerSettings.current.gridAdaptive;
  }

  /**
   * Locked: the pinned pitch for the document unit — the store is the truth,
   * even before the mode manager has re-resolved. Unlocked: what the ladder
   * chose for this zoom.
   */
  private displayedPitch(): number | null {
    if (this.locked) {
      return viewerSettings.current.gridFixedSpacing[sceneUnit.current];
    }
    return this.spacing?.minor ?? null;
  }

  private render(): void {
    const unit = sceneUnit.current;
    const pitch = this.displayedPitch();
    if (pitch !== null && Number.isFinite(pitch)) {
      this.valueBtn.textContent = formatGridPitch(pitch, unit);
    }
    this.unitEl.textContent = unit;
    const locked = this.locked;
    this.lockBtn.innerHTML = locked ? ICON_LOCK : ICON_LOCK_OPEN;
    this.lockBtn.title = locked ? LOCK_TITLE : UNLOCK_TITLE;
    this.lockBtn.setAttribute('aria-label', locked ? LOCK_TITLE : UNLOCK_TITLE);
    this.lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    this.lockBtn.classList.toggle('text-primary', locked);
  }

  // ---------------------------------------------------------------------------
  // Inline edit
  // ---------------------------------------------------------------------------

  private beginEdit(): void {
    if (this.editing) {
      return;
    }
    this.editing = true;
    this.cancelling = false;
    this.inputEl.value = this.valueBtn.textContent ?? '';
    this.valueBtn.classList.add('hidden');
    this.inputEl.classList.remove('hidden');
    this.inputEl.focus();
    this.inputEl.select();
  }

  private endEdit(): void {
    this.editing = false;
    this.inputEl.classList.add('hidden');
    this.inputEl.classList.remove('ring-2', 'ring-error');
    this.valueBtn.classList.remove('hidden');
  }

  private cancelEdit(): void {
    this.cancelling = true;
    this.endEdit();
    this.valueBtn.focus();
    this.cancelling = false;
  }

  /**
   * Enter or blur. A value the grid can use pins it (the lock closes); one
   * it cannot flashes red and keeps the old pitch — Enter leaves the field
   * open to try again, a blur just closes it.
   */
  private commit(keepOpenOnError: boolean): void {
    const pitch = parseGridPitch(this.inputEl.value);
    if (pitch === null) {
      this.flashInvalid();
      if (keepOpenOnError) {
        this.inputEl.select();
        return;
      }
      this.cancelEdit();
      return;
    }
    lockGridPitch(sceneUnit.current, pitch, this.save);
    this.cancelling = true;
    this.endEdit();
    this.valueBtn.focus();
    this.cancelling = false;
  }

  private flashInvalid(): void {
    this.inputEl.classList.add('ring-2', 'ring-error');
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.inputEl.classList.remove('ring-2', 'ring-error');
    }, INVALID_FLASH_MS);
  }
}
