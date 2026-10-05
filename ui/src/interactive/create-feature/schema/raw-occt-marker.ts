import { ICON_RAW_OCCT } from '../../../ui/icons';

/**
 * The mark on a custom feature whose module reaches raw OpenCascade
 * (`fluidcad/sdk/occt`, or a scope opened with `this.occ()`; the catalog's
 * `usesOcct`): a small icon over the top-right corner of its cell in the
 * Custom dropdown. Its tooltip says what that means — raw code the engine
 * can't check, which can crash the kernel for the whole session.
 */
export class RawOcctMarker {
  static readonly LABEL = 'Uses raw OpenCascade';

  static readonly TIP = 'Uses raw OpenCascade (fluidcad/sdk/occt): unstable code the engine can\'t check. '
    + 'A bug in it can corrupt the kernel\'s memory for the whole engine session, not only this feature — '
    + 'the engine then needs a restart.';

  /** The mark itself, for a dropdown cell's top-right corner. */
  static element(): HTMLSpanElement {
    const mark = document.createElement('span');
    mark.dataset.role = 'raw-occt';
    mark.title = RawOcctMarker.TIP;
    mark.setAttribute('aria-label', RawOcctMarker.TIP);
    mark.setAttribute('role', 'img');
    mark.className = 'absolute top-0.5 right-0.5 text-warning [&>svg]:size-3.5 pointer-events-auto';
    mark.innerHTML = ICON_RAW_OCCT;
    return mark;
  }
}
