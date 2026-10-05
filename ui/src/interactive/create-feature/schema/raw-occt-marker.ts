import { ICON_RAW_OCCT } from '../../../ui/icons';

/**
 * The mark on a custom feature whose module reaches raw OpenCascade
 * (`fluidcad/sdk/occt`, or a scope opened with `this.occ()`; the catalog's
 * `usesOcct`): on its cell in the Custom dropdown and beside its dialog's
 * title. Its tooltip says what that means — raw code the engine can't
 * check, which can crash the kernel for the whole session.
 */
export class RawOcctMarker {
  static readonly LABEL = 'Uses raw OpenCascade';

  static readonly TIP = 'Uses raw OpenCascade (fluidcad/sdk/occt): unstable code the engine can\'t check. '
    + 'A bug in it can corrupt the kernel\'s memory for the whole engine session, not only this feature — '
    + 'the engine then needs a restart.';

  /**
   * The mark itself. `corner`: a small icon over the top-right corner of a
   * dropdown cell. `badge`: the icon with a short caption, beside a
   * dialog's title.
   */
  static element(variant: 'corner' | 'badge'): HTMLSpanElement {
    const mark = document.createElement('span');
    mark.dataset.role = 'raw-occt';
    mark.title = RawOcctMarker.TIP;
    mark.setAttribute('aria-label', RawOcctMarker.TIP);
    mark.setAttribute('role', 'img');
    if (variant === 'corner') {
      mark.className = 'absolute top-0.5 right-0.5 text-warning [&>svg]:size-3.5 pointer-events-auto';
      mark.innerHTML = ICON_RAW_OCCT;
    } else {
      mark.className = 'ml-auto shrink-0 whitespace-nowrap inline-flex items-center gap-1 rounded-full border border-warning/40 '
        + 'px-1.5 py-0.5 text-[10px] font-medium leading-none text-warning [&>svg]:size-3 cursor-help select-none';
      mark.innerHTML = `${ICON_RAW_OCCT}<span>Raw OpenCascade</span>`;
    }
    return mark;
  }
}
