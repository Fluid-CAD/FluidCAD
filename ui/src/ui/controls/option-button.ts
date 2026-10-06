import { ChoiceImage, type ChoiceItem } from './choice-item';
import { OptionPopover, type OptionPopoverMode } from './option-popover';

export interface OptionButtonOptions<V> {
  items: readonly ChoiceItem<V>[];
  /** The chosen item's value; nothing chosen without one. */
  value?: V;
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** The popover's layout, columns and search box (see `OptionPopoverOptions`). */
  mode?: OptionPopoverMode;
  columns?: number;
  search?: boolean;
}

// The dialog selects' own look; daisyUI's `select` draws the chevron on
// whatever element wears it.
const BUTTON = 'select select-sm select-bordered w-full text-xs items-center gap-2 text-left cursor-pointer';
const LABEL = 'flex-1 min-w-0 truncate';
const PLACEHOLDER = `${LABEL} text-base-content/50`;

/**
 * The trigger of a rich select: a button the width of its row showing the
 * chosen item (image and label) or a placeholder, opening an `OptionPopover`
 * on click, ArrowDown, Enter and Space.
 */
export class OptionButton<V> {
  readonly element: HTMLButtonElement;
  /** The user chose an item. Never fired by `setValue` or `setItems`. */
  onChange?: (value: V) => void;

  private items: readonly ChoiceItem<V>[];
  private current: V | undefined;
  private readonly placeholder: string;
  private readonly mode: OptionPopoverMode | undefined;
  private readonly columns: number | undefined;
  private readonly search: boolean | undefined;
  private popover: OptionPopover<V> | null = null;

  constructor(options: OptionButtonOptions<V>) {
    this.items = options.items;
    this.current = options.value;
    this.placeholder = options.placeholder ?? 'Choose…';
    this.mode = options.mode;
    this.columns = options.columns;
    this.search = options.search;

    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = BUTTON;
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.show();
  }

  get value(): V | undefined {
    return this.current;
  }

  get isOpen(): boolean {
    return this.popover !== null;
  }

  /** Programmatic choice (prefill, reset); no change event fires. `undefined` shows the placeholder. */
  setValue(value: V | undefined): void {
    this.current = value;
    this.show();
  }

  /** Replace the choices; an open popover closes. The value stays, shown once an item carries it. */
  setItems(items: readonly ChoiceItem<V>[]): void {
    this.items = items;
    this.close();
    this.show();
  }

  open(): void {
    if (this.popover) {
      return;
    }
    const popover = new OptionPopover<V>({
      anchor: this.element,
      items: this.items,
      value: this.current,
      mode: this.mode,
      columns: this.columns,
      search: this.search,
      onChoose: value => this.choose(value),
      onClose: () => {
        this.popover = null;
        this.element.setAttribute('aria-expanded', 'false');
      },
    });
    this.popover = popover;
    this.element.setAttribute('aria-expanded', 'true');
    popover.open();
  }

  close(): void {
    this.popover?.close();
  }

  /** Close the popover and let go of the button's listeners. */
  destroy(): void {
    this.close();
    this.element.removeEventListener('click', this.onClick);
    this.element.removeEventListener('keydown', this.onKeyDown);
  }

  private choose(value: V): void {
    if (value === this.current) {
      return;
    }
    this.current = value;
    this.show();
    this.onChange?.(value);
  }

  /** The chosen item's image and label, or the placeholder. */
  private show(): void {
    const item = this.items.find(candidate => candidate.value === this.current);
    const label = document.createElement('span');
    label.className = item ? LABEL : PLACEHOLDER;
    label.textContent = item ? item.label : this.placeholder;
    if (item?.image) {
      this.element.replaceChildren(ChoiceImage.create(item.image, ChoiceImage.THUMB), label);
    } else {
      this.element.replaceChildren(label);
    }
    this.element.title = item?.description ?? '';
  }

  private readonly onClick = (): void => {
    if (this.popover) {
      this.close();
    } else {
      this.open();
    }
  };

  /**
   * ArrowDown and ArrowUp open, as on a native select; Enter and Space too,
   * taken here so the button's own click doesn't follow and close it again.
   */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.open();
    }
  };
}
