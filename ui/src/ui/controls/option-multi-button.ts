import type { ChoiceItem } from './choice-item';
import { OptionButton } from './option-button';
import { OptionPopover, type OptionPopoverMode } from './option-popover';

export interface OptionMultiButtonOptions<V> {
  items: readonly ChoiceItem<V>[];
  /** The chosen items' values, in any order; none chosen without them. */
  values?: readonly V[];
  /** Shown while nothing is chosen. */
  placeholder?: string;
  /** The popover's layout, columns and search box (see `OptionPopoverOptions`). */
  mode?: OptionPopoverMode;
  columns?: number;
  search?: boolean;
}

/**
 * The trigger of a select several options are chosen from: `OptionButton`'s
 * look, showing the chosen labels — both of two, a count of more, a
 * placeholder of none — and opening an `OptionPopover` whose options toggle
 * while it stays open. Its value is the chosen values in the order the items
 * are declared, whatever order they were chosen in.
 */
export class OptionMultiButton<V> {
  /** The most chosen labels the trigger spells out; over it, it counts them. */
  static readonly NAMED = 2;

  readonly element: HTMLButtonElement;
  /** The user chose an item or let one go — the list as it stands now. Never fired by `setValue` or `setItems`. */
  onChange?: (values: V[]) => void;

  private items: readonly ChoiceItem<V>[];
  private chosen: Set<V>;
  private readonly placeholder: string;
  private readonly mode: OptionPopoverMode | undefined;
  private readonly columns: number | undefined;
  private readonly search: boolean | undefined;
  private popover: OptionPopover<V> | null = null;

  constructor(options: OptionMultiButtonOptions<V>) {
    this.items = options.items;
    this.chosen = new Set(options.values ?? []);
    this.placeholder = options.placeholder ?? 'None';
    this.mode = options.mode;
    this.columns = options.columns;
    this.search = options.search;

    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = OptionButton.BUTTON_CLASS;
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.show();
  }

  /** The chosen values, in the items' order. A value no item carries is not among them. */
  get value(): V[] {
    return this.chosenItems().map(item => item.value);
  }

  get isOpen(): boolean {
    return this.popover !== null;
  }

  /** Programmatic choice (prefill, reset); no change event fires, and an open popover closes. An empty list shows the placeholder. */
  setValue(values: readonly V[]): void {
    this.chosen = new Set(values);
    this.close();
    this.show();
  }

  /** Replace the choices; an open popover closes. The values stay, each shown once an item carries it. */
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
      multiple: true,
      values: this.value,
      mode: this.mode,
      columns: this.columns,
      search: this.search,
      onToggle: value => this.toggle(value),
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

  private chosenItems(): ChoiceItem<V>[] {
    return this.items.filter(item => this.chosen.has(item.value));
  }

  private toggle(value: V): void {
    if (this.chosen.has(value)) {
      this.chosen.delete(value);
    } else {
      this.chosen.add(value);
    }
    this.show();
    this.onChange?.(this.value);
  }

  /** The chosen labels, a count of them over `NAMED`, or the placeholder; the tooltip names every one. */
  private show(): void {
    const labels = this.chosenItems().map(item => item.label);
    const label = document.createElement('span');
    label.className = labels.length ? OptionButton.LABEL_CLASS : OptionButton.PLACEHOLDER_CLASS;
    if (labels.length === 0) {
      label.textContent = this.placeholder;
    } else if (labels.length > OptionMultiButton.NAMED) {
      label.textContent = `${labels.length} selected`;
    } else {
      label.textContent = labels.join(', ');
    }
    this.element.replaceChildren(label);
    this.element.title = labels.join(', ');
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
