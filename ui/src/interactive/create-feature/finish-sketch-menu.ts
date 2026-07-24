import { FeatureButton, TOOLBAR_BTN_LABEL } from './feature-button';

/** One feature offered in the Finish Sketch grid, backed by a real toolbar button. */
export interface FinishSketchEntry {
  /** The create-group toolbar button this cell mirrors and delegates to. */
  button: FeatureButton;
  /** Grid caption override (the Sketch button reads "New Sketch" here). */
  label?: string;
  /**
   * Whether this cell shows the armed highlight when its source button is
   * active. The Sketch button is permanently active while a sketch is edited
   * (it marks sketch mode), so New Sketch passes `false` to avoid a highlight
   * that would always be lit and mean nothing.
   */
  reflectActive?: boolean;
  /**
   * Action to run on click, overriding the default delegation to
   * `button.click()`. New Sketch needs this because the Sketch button is a
   * toggle that would otherwise take two clicks (close, then start).
   */
  onClick?: () => void;
}

const CELL_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1.5 w-full text-base-content/70';
const CELL_ACTIVE = 'btn btn-soft btn-primary btn-sm h-auto flex-col gap-0.5 px-2 py-1.5 w-full';

// Green "success" styling for the consolidated finish button: a green border
// and green check (the icon strokes with `currentColor` = text-success) over a
// transparent, ghost-hover surface. We deliberately avoid `btn-outline`, whose
// hover inverts to a harsh solid-green fill. The active state (popup open, or a
// launched feature still armed) adds a faint green wash.
const FINISH_BASE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 border border-success text-success';
const FINISH_ACTIVE = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-2 py-1 shrink-0 border border-success text-success bg-success/15';

/** A checkmark glyph for the consolidated "finish the sketch into 3D" button. */
const FINISH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-8 h-8 shrink-0" aria-hidden="true">'
  + '<path d="M20 6 9 17l-5-5" /></svg>';

let styleInjected = false;

/** The `.feature-consolidated` hide rule, injected once (settings-panel pattern). */
function injectStyle(): void {
  if (styleInjected) {
    return;
  }
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = '.feature-consolidated { display: none !important; }';
  document.head.appendChild(style);
}

/**
 * While a sketch is active the individual create-feature buttons (Extrude,
 * Revolve, Sweep, Loft, Wrap, Plane, New Sketch) collapse into a single
 * "Finish Sketch" button that opens a grid popup below it. Each grid cell is a
 * live twin of its toolbar button: it mirrors the button's availability and
 * armed state, and a click delegates straight to it — so no feature logic is
 * duplicated here, only presented differently for the sketch-mode flow.
 *
 * The consolidation is toggled by {@link setConsolidated} (wired to the sketch
 * toolbar's active state in main.ts). Only the mirrored buttons are hidden, so
 * unrelated create-group tools (Shell) stay reachable alongside the button.
 */
export class FinishSketchMenu {
  /**
   * Invoked when the button is clicked in resume mode (editing a consumed
   * sketch): finish by removing the breakpoint instead of opening the grid.
   */
  onResume?: () => void;

  private readonly wrap: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly popup: HTMLElement;
  private readonly cells: { entry: FinishSketchEntry; el: HTMLButtonElement }[] = [];
  private open = false;
  private consolidated = false;
  /**
   * Resume mode: the sketch being edited is consumed by a later feature, so the
   * button removes the breakpoint (letting that feature re-apply) rather than
   * offering the grid — there is no dropdown, so the caret is dropped.
   */
  private resumeMode = false;

  constructor(group: HTMLElement, entries: FinishSketchEntry[]) {
    injectStyle();

    this.wrap = document.createElement('span');
    // `relative` anchors the popup directly beneath the button; `hidden` until
    // a sketch consolidates the group.
    this.wrap.className = 'relative shrink-0 hidden';

    this.button = document.createElement('button');
    this.button.className = FINISH_BASE;
    this.button.setAttribute('aria-label', 'Finish sketch');
    this.button.setAttribute('aria-haspopup', 'true');
    this.button.setAttribute('aria-expanded', 'false');
    this.label = document.createElement('span');
    this.label.className = `${TOOLBAR_BTN_LABEL} whitespace-nowrap`;
    this.label.textContent = 'Finish Sketch ▾';
    this.button.innerHTML = FINISH_ICON;
    this.button.appendChild(this.label);
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.resumeMode) {
        this.onResume?.();
      } else {
        this.togglePopup();
      }
    });
    this.wrap.appendChild(this.button);

    this.popup = document.createElement('div');
    // A solid (not translucent) surface: the popup overlaps the History panel
    // and timeline below the navbar, which bleed through a translucent one.
    this.popup.className =
      'absolute top-full left-0 mt-1 z-[200] hidden bg-base-100 border border-base-content/15 '
      + 'rounded-lg shadow-xl p-2 w-60 grid grid-cols-3 gap-1';
    this.wrap.appendChild(this.popup);

    for (const entry of entries) {
      const el = document.createElement('button');
      el.innerHTML = `<img src="${entry.button.iconSrc}" class="w-8 h-8 object-contain shrink-0" alt="" />`
        + `<span class="text-[10px] leading-none">${entry.label ?? entry.button.labelText}</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.disabled) {
          return;
        }
        // Delegate to the real toolbar button — all its enter/exit coordination
        // (and main.ts's onEnter hooks) run exactly as a toolbar click would.
        // An entry may override with its own action (New Sketch, see above).
        if (entry.onClick) {
          entry.onClick();
        } else {
          entry.button.click();
        }
        this.closePopup();
      });
      this.popup.appendChild(el);
      this.cells.push({ entry, el });
      // Any availability/armed change on the source refreshes the grid.
      entry.button.onStateChange = () => this.refresh();
    }

    group.prepend(this.wrap);

    document.addEventListener('click', this.onDocumentClick);
    document.addEventListener('keydown', this.onKeyDown, true);
  }

  /**
   * Enter or leave the consolidated sketch-mode presentation: hide/restore the
   * mirrored toolbar buttons and show/hide the Finish Sketch button in their
   * place. Leaving also closes an open popup.
   */
  setConsolidated(consolidated: boolean): void {
    if (this.consolidated === consolidated) {
      return;
    }
    this.consolidated = consolidated;
    for (const { entry } of this.cells) {
      entry.button.setConsolidated(consolidated);
    }
    this.wrap.classList.toggle('hidden', !consolidated);
    if (!consolidated) {
      this.closePopup();
    } else {
      this.refresh();
    }
  }

  /**
   * Switch between grid mode (turn this sketch into a 3D feature) and resume
   * mode (the sketch is consumed by a later feature — finish just removes the
   * breakpoint). Resume mode drops the dropdown caret and closes any open grid.
   */
  setResumeMode(resume: boolean): void {
    if (this.resumeMode === resume) {
      return;
    }
    this.resumeMode = resume;
    this.label.textContent = resume ? 'Finish Sketch' : 'Finish Sketch ▾';
    this.button.setAttribute('aria-haspopup', resume ? 'false' : 'true');
    this.button.setAttribute(
      'aria-label',
      resume ? 'Finish editing — apply the sketch changes' : 'Finish sketch',
    );
    if (resume) {
      this.closePopup();
    }
  }

  private togglePopup(): void {
    if (this.open) {
      this.closePopup();
    } else {
      this.openPopup();
    }
  }

  private openPopup(): void {
    this.open = true;
    this.popup.classList.remove('hidden');
    this.button.setAttribute('aria-expanded', 'true');
    this.refresh();
  }

  private closePopup(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.popup.classList.add('hidden');
    this.button.setAttribute('aria-expanded', 'false');
    this.refresh();
  }

  /** Mirror each source button's availability/armed state into its grid cell. */
  private refresh(): void {
    let anyActive = false;
    for (const { entry, el } of this.cells) {
      const source = entry.button;
      const enabled = source.visible && !source.disabled;
      const active = source.active && entry.reflectActive !== false;
      el.disabled = !enabled;
      el.className = active ? CELL_ACTIVE : CELL_BASE;
      el.classList.toggle('opacity-40', !enabled);
      if (active) {
        anyActive = true;
      }
    }
    // The button reads active while its popup is open or a feature it launched
    // is still armed (e.g. an extrude dialog that keeps the sketch live).
    this.button.className = this.open || anyActive ? FINISH_ACTIVE : FINISH_BASE;
  }

  private readonly onDocumentClick = (e: MouseEvent): void => {
    if (this.open && !this.wrap.contains(e.target as Node)) {
      this.closePopup();
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.open && e.key === 'Escape') {
      e.stopPropagation();
      this.closePopup();
    }
  };
}
