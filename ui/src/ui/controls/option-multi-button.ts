import { ParameterRows, type ChoiceItem, type ParameterChoice } from './choice-item';
import { OptionButton } from './option-button';
import { OptionPopover, type OptionPopoverMode, type ParameterSource } from './option-popover';

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
  /** Parameters the popover offers under the options; none without. */
  parameters?: ParameterSource;
}

/**
 * The trigger of a select several options are chosen from: `OptionButton`'s
 * look, showing the chosen labels — both of two, a count of more, a
 * placeholder of none — and opening an `OptionPopover` whose options toggle
 * while it stays open. Its value is the chosen values in the order the items
 * are declared, whatever order they were chosen in. Bound to a parameter (a
 * list), it shows the parameter's name with what it selects muted beside it;
 * the popover opens on the list the parameter holds, and the first toggle
 * lets the parameter go and carries on from that list.
 */
export class OptionMultiButton<V> {
  /** The most chosen labels the trigger spells out; over it, it counts them. */
  static readonly NAMED = 2;

  readonly element: HTMLButtonElement;
  /** The user chose an item or let one go — the list as it stands now. Never fired by `setValue` or `setItems`. */
  onChange?: (values: V[]) => void;
  /** The user chose a parameter (an offer to declare one included): the button shows it bound. Never fired by `setBinding`. */
  onBind?: (choice: ParameterChoice) => void;

  private items: readonly ChoiceItem<V>[];
  private chosen: Set<V>;
  private bound: ParameterChoice | undefined;
  private readonly placeholder: string;
  private readonly mode: OptionPopoverMode | undefined;
  private readonly columns: number | undefined;
  private readonly search: boolean | undefined;
  private readonly parameters: ParameterSource | undefined;
  private popover: OptionPopover<V> | null = null;

  constructor(options: OptionMultiButtonOptions<V>) {
    this.items = options.items;
    this.chosen = new Set(options.values ?? []);
    this.placeholder = options.placeholder ?? 'None';
    this.mode = options.mode;
    this.columns = options.columns;
    this.search = options.search;
    this.parameters = options.parameters;

    this.element = document.createElement('button');
    this.element.type = 'button';
    this.element.className = OptionButton.BUTTON_CLASS;
    this.element.setAttribute('aria-haspopup', 'listbox');
    this.element.setAttribute('aria-expanded', 'false');
    this.element.addEventListener('click', this.onClick);
    this.element.addEventListener('keydown', this.onKeyDown);
    this.show();
  }

  /** The chosen values, in the items' order — bound, the list the parameter holds. A value no item carries is not among them. */
  get value(): V[] {
    return this.chosenItems().map(item => item.value);
  }

  /** The parameter the button holds in place of a list; undefined while the list is its own. */
  get binding(): ParameterChoice | undefined {
    return this.bound;
  }

  get isOpen(): boolean {
    return this.popover !== null;
  }

  /** Programmatic choice (prefill, reset); no change event fires, and an open popover closes. An empty list shows the placeholder. Lets go of a binding. */
  setValue(values: readonly V[]): void {
    this.chosen = new Set(values);
    this.bound = undefined;
    this.close();
    this.show();
  }

  /**
   * Programmatic binding (prefill, a late resolution of the same name); no
   * event fires, and an open popover closes. `values` is the list the
   * parameter holds (empty when unknown): the popover opens on it checked,
   * and a toggle carries on from it. `undefined` lets go of the binding,
   * keeping that list as the button's own.
   */
  setBinding(choice: ParameterChoice | undefined, values: readonly V[] = this.value): void {
    this.bound = choice;
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
      parameters: this.parameters,
      bound: this.bound?.name,
      onToggle: value => this.toggle(value),
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

  private chosenItems(): ChoiceItem<V>[] {
    return this.items.filter(item => this.chosen.has(item.value));
  }

  /** An option toggled: over a binding, the list is the button's own again, carried on from what the parameter held. */
  private toggle(value: V): void {
    this.bound = undefined;
    if (this.chosen.has(value)) {
      this.chosen.delete(value);
    } else {
      this.chosen.add(value);
    }
    this.show();
    this.onChange?.(this.value);
  }

  /** A parameter chosen from the popover: shown bound, the host told — it hands back what the parameter holds. */
  private bind(choice: ParameterChoice): void {
    this.bound = choice;
    this.show();
    this.onBind?.(choice);
  }

  /** The chosen labels, a count of them over `NAMED`, or the placeholder; the tooltip names every one. Bound, the parameter's name and what it selects. */
  private show(): void {
    if (this.bound) {
      const text = document.createElement('span');
      text.className = OptionButton.BOUND_CLASS;
      text.dataset.role = 'binding';
      text.append(ParameterRows.name(this.bound));
      const value = ParameterRows.value(this.bound);
      if (value) {
        text.append(value);
      }
      this.element.replaceChildren(text);
      this.element.title = this.bound.warning ?? this.bound.label ?? '';
      return;
    }
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
