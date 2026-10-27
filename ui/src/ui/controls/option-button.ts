import { ChoiceImage, ParameterRows, type ChoiceItem, type ParameterChoice } from './choice-item';
import { OptionPopover, type OptionPopoverMode, type ParameterSource } from './option-popover';

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
  /** Parameters the popover offers under the options; none without. */
  parameters?: ParameterSource;
}

// The dialog selects' own look; daisyUI's `select` draws the chevron on
// whatever element wears it.
const BUTTON = 'select select-sm select-bordered w-full text-xs items-center gap-2 text-left cursor-pointer';
const LABEL = 'flex-1 min-w-0 truncate';
const PLACEHOLDER = `${LABEL} text-base-content/50`;
/** A bound trigger's text: the parameter's name, then what it selects, in one line. */
const BOUND = 'flex-1 min-w-0 flex items-baseline gap-2';

/**
 * The trigger of a rich select: a button the width of its row showing the
 * chosen item (image and label) or a placeholder, opening an `OptionPopover`
 * on click, ArrowDown, Enter and Space. Bound to a parameter (chosen from the
 * popover's Parameters group, or set by the host), it shows the parameter's
 * name with the option it selects muted beside it, and holds no value of its
 * own until an option is chosen again.
 */
export class OptionButton<V> {
  /** The trigger's look and its label's, chosen and not — `OptionMultiButton` wears the same. */
  static readonly BUTTON_CLASS = BUTTON;
  static readonly LABEL_CLASS = LABEL;
  static readonly PLACEHOLDER_CLASS = PLACEHOLDER;
  static readonly BOUND_CLASS = BOUND;

  readonly element: HTMLButtonElement;
  /** The user chose an item. Never fired by `setValue` or `setItems`. */
  onChange?: (value: V) => void;
  /** The user chose a parameter (an offer to declare one included): the button shows it bound. Never fired by `setBinding`. */
  onBind?: (choice: ParameterChoice) => void;

  private items: readonly ChoiceItem<V>[];
  private current: V | undefined;
  private bound: ParameterChoice | undefined;
  private readonly placeholder: string;
  private readonly mode: OptionPopoverMode | undefined;
  private readonly columns: number | undefined;
  private readonly search: boolean | undefined;
  private readonly parameters: ParameterSource | undefined;
  private popover: OptionPopover<V> | null = null;

  constructor(options: OptionButtonOptions<V>) {
    this.items = options.items;
    this.current = options.value;
    this.placeholder = options.placeholder ?? 'Choose…';
    this.mode = options.mode;
    this.columns = options.columns;
    this.search = options.search;
    this.parameters = options.parameters;

    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = BUTTON;
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.show();
  }

  /** The chosen item's value; undefined while nothing is, or a parameter stands in its place. */
  get value(): V | undefined {
    return this.bound ? undefined : this.current;
  }

  /** The parameter the button holds in place of an option; undefined while an option (or nothing) is chosen. */
  get binding(): ParameterChoice | undefined {
    return this.bound;
  }

  get isOpen(): boolean {
    return this.popover !== null;
  }

  /** Programmatic choice (prefill, reset); no change event fires. `undefined` shows the placeholder. Lets go of a binding. */
  setValue(value: V | undefined): void {
    this.current = value;
    this.bound = undefined;
    this.show();
  }

  /**
   * Programmatic binding (prefill, a late resolution of the same name); no
   * event fires. The button shows the parameter's name and what it selects;
   * `undefined` lets go of it, showing the last option chosen again.
   */
  setBinding(choice: ParameterChoice | undefined): void {
    this.bound = choice;
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
      value: this.value,
      mode: this.mode,
      columns: this.columns,
      search: this.search,
      parameters: this.parameters,
      bound: this.bound?.name,
      onChoose: value => this.choose(value),
      onChooseParameter: choice => this.bind(choice),
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

  /** An option chosen: the value, unless it is the one already shown — choosing it again over a binding still unbinds. */
  private choose(value: V): void {
    if (value === this.current && !this.bound) {
      return;
    }
    this.current = value;
    this.bound = undefined;
    this.show();
    this.onChange?.(value);
  }

  /** A parameter chosen from the popover: shown bound, the host told. */
  private bind(choice: ParameterChoice): void {
    this.bound = choice;
    this.show();
    this.onBind?.(choice);
  }

  /** The chosen item's image and label, the bound parameter's name and what it selects, or the placeholder. */
  private show(): void {
    if (this.bound) {
      this.showBound(this.bound);
      return;
    }
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

  /** The parameter's name as the chosen text, the option it selects muted beside it; a project parameter's label is the tooltip. */
  private showBound(choice: ParameterChoice): void {
    const text = document.createElement('span');
    text.className = BOUND;
    text.dataset.role = 'binding';
    text.append(ParameterRows.name(choice));
    const value = ParameterRows.value(choice);
    if (value) {
      text.append(value);
    }
    this.element.replaceChildren(text);
    this.element.title = choice.warning ?? choice.label ?? '';
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
