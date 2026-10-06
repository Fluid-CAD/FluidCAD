/**
 * One choice of a platform choice control (`OptionPopover`, `OptionButton`,
 * `RadioGroup`): plain data, with the image already a URL the page can load.
 */
export interface ChoiceItem<V> {
  value: V;
  label: string;
  /** A URL, already resolved — the controls load it as it stands. */
  image?: string;
  description?: string;
  /** Items sharing a group sit under one heading. */
  group?: string;
  /** Extra words a search matches, never shown. */
  keywords?: readonly string[];
}

/**
 * The fixed box a choice's image sits in. The box is the neutral placeholder:
 * it shows through while the image loads, and stands alone when the item has
 * no image or the image fails.
 */
export class ChoiceImage {
  /** Set on a box that shows no image. */
  static readonly PLACEHOLDER = 'data-choice-placeholder';

  /** 24 px, beside a label. */
  static readonly THUMB = 'w-6 h-6';
  /** A square as wide as its cell, over a label. */
  static readonly SQUARE = 'w-full aspect-square';

  private static readonly BOX =
    'shrink-0 flex items-center justify-center overflow-hidden rounded bg-base-content/[0.06] pointer-events-none';

  /** A box of `size` (`THUMB` or `SQUARE`) showing `src`, or the placeholder without one. */
  static create(src: string | undefined, size: string): HTMLElement {
    const box = document.createElement('span');
    box.className = `${ChoiceImage.BOX} ${size}`;
    box.setAttribute('aria-hidden', 'true');
    if (!src) {
      box.setAttribute(ChoiceImage.PLACEHOLDER, '');
      return box;
    }
    const img = document.createElement('img');
    // As attributes: set before `src`, so the load is lazy from the start.
    img.setAttribute('loading', 'lazy');
    img.setAttribute('alt', '');
    img.setAttribute('draggable', 'false');
    img.className = 'w-full h-full';
    img.style.objectFit = 'contain';
    img.addEventListener('error', () => {
      img.remove();
      box.setAttribute(ChoiceImage.PLACEHOLDER, '');
    });
    img.src = src;
    box.appendChild(img);
    return box;
  }
}
