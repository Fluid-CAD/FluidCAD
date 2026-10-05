import { FeatureButton } from './feature-button';
import { TOOLBAR_BTN_LABEL } from '../../ui/toolbar-styles';

// Green "success" styling: a green border and green check (the icon strokes
// with `currentColor` = text-success) over a transparent, ghost-hover surface.
// We deliberately avoid `btn-outline`, whose hover inverts to a harsh solid-
// green fill.
const FINISH_CLASS = 'btn btn-ghost btn-sm h-auto flex-col gap-0.5 px-1.5 py-1 shrink-0 border border-success text-success';

/** A checkmark glyph for the "this sketch is done" button. */
const FINISH_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-7 h-7 shrink-0" aria-hidden="true">'
  + '<path d="M20 6 9 17l-5-5" /></svg>';

let styleInjected = false;

/** The `.feature-sketch-hidden` hide rule, injected once (settings-panel pattern). */
function injectStyle(): void {
  if (styleInjected) {
    return;
  }
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = '.feature-sketch-hidden { display: none !important; }';
  document.head.appendChild(style);
}

/**
 * The green "Finish Sketch" button at the head of the create group, shown
 * only while a sketch is being edited. One click, one meaning: the sketch is
 * done. The modify service writes `.close()` onto the sketch statement (or,
 * for a consumed sketch opened by a timeline double-click, clears the edit
 * breakpoint) and the render that follows leaves sketch mode.
 *
 * While it shows, the create-feature buttons handed to it (`hiddenWhileSketching`)
 * are off the bar: the sketch tools own the toolbar, and a sketch becomes a
 * feature by finishing it and then clicking Extrude, Revolve, … on the
 * toolbar that comes back. Only those buttons hide, so anything else in the
 * group keeps its own per-render visibility.
 */
export class FinishSketchButton {
  onClick?: () => void;

  private readonly wrap: HTMLElement;

  constructor(group: HTMLElement, private readonly hiddenWhileSketching: FeatureButton[]) {
    injectStyle();

    // `hidden` until a sketch becomes active.
    this.wrap = document.createElement('span');
    this.wrap.className = 'shrink-0 hidden';

    const button = document.createElement('button');
    button.className = FINISH_CLASS;
    button.setAttribute('aria-label', 'Finish sketch');
    button.innerHTML = FINISH_ICON;
    const label = document.createElement('span');
    label.className = `${TOOLBAR_BTN_LABEL} whitespace-nowrap`;
    label.textContent = 'Finish Sketch';
    button.appendChild(label);
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onClick?.();
    });
    this.wrap.appendChild(button);

    group.prepend(this.wrap);
  }

  /**
   * Show the button while a sketch is active, hide it otherwise — and swap
   * the create-feature buttons out (or back in) with it.
   */
  setVisible(visible: boolean): void {
    this.wrap.classList.toggle('hidden', !visible);
    for (const button of this.hiddenWhileSketching) {
      button.setSketchHidden(visible);
    }
  }
}
