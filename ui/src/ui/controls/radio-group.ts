import { ChoiceImage, type ChoiceItem } from './choice-item';

export type RadioDisplay = 'list' | 'inline' | 'buttons' | 'cards';

export interface RadioGroupOptions<V> {
  items: readonly ChoiceItem<V>[];
  /** The chosen item's value; none chosen without one. */
  value?: V;
  /** `'list'` (default), `'inline'`, `'buttons'` or `'cards'`. */
  display?: RadioDisplay;
  /** Cards only, 2–6; 3 without one. */
  columns?: number;
  /** A small clear button once something is chosen — for a value that may stay unset. */
  allowClear?: boolean;
  /** The group's accessible name. */
  label?: string;
}

/** One choice: the element that takes focus, and how it shows chosen. */
interface RadioChoice<V> {
  item: ChoiceItem<V>;
  control: HTMLElement;
  mark(chosen: boolean): void;
}

const GROUP = 'flex flex-col items-start gap-1 text-xs';
const LIST = 'flex flex-col gap-1.5 w-full';
const INLINE = 'flex flex-wrap gap-x-4 gap-y-1.5 w-full';
const RADIO_ROW = 'flex items-center gap-2 min-w-0 cursor-pointer';
const RADIO = 'radio radio-sm radio-primary shrink-0';
const DESCRIPTION = 'block truncate text-[11px] text-base-content/50';
// The operation tabs' look (ChoiceTabs in panel-controls.ts).
const BUTTONS = 'join w-full';
const BUTTON_BASE = 'btn btn-sm join-item flex-1 min-w-0 gap-1.5 text-xs px-2 font-normal';
const BUTTON_ACTIVE = 'btn btn-sm join-item flex-1 min-w-0 gap-1.5 text-xs px-2 btn-soft btn-primary';
const CARDS = 'grid gap-1.5 w-full';
const CARD_SHAPE =
  'flex flex-col items-center gap-1 min-w-0 p-1.5 rounded-md border cursor-pointer '
  + 'focus-visible:outline-none focus-visible:bg-base-content/[0.08] hover:bg-base-content/[0.06]';
const CARD_BASE = `${CARD_SHAPE} border-base-content/15 text-base-content/70`;
const CARD_ACTIVE = `${CARD_SHAPE} border-primary ring-1 ring-primary text-base-content`;
const CARD_LABEL = 'block max-w-full truncate text-[11px] leading-tight';
const CLEAR = 'btn btn-ghost btn-xs px-1 font-normal text-base-content/50';

/**
 * One of a few choices, all on show: stacked or inline radios, a segmented
 * row, or image cards. Whatever the display it is a radio group to the
 * keyboard and to assistive tech — one tab stop, arrows move and choose,
 * Space chooses.
 */
export class RadioGroup<V> {
  readonly element: HTMLElement;
  /** The user chose an item, or cleared the choice (`undefined`). Never fired by `setValue`. */
  onChange?: (value: V | undefined) => void;

  private readonly choices: RadioChoice<V>[] = [];
  private readonly clearButton: HTMLButtonElement | null = null;
  private readonly display: RadioDisplay;
  private current: V | undefined;

  /** Groups made so far — each run of native radios needs a name of its own. */
  private static made = 0;

  constructor(options: RadioGroupOptions<V>) {
    this.display = options.display ?? 'list';
    this.current = options.value;

    this.element = document.createElement('div');
    this.element.className = GROUP;
    this.element.setAttribute('role', 'radiogroup');
    this.element.dataset.display = this.display;
    if (options.label) {
      this.element.setAttribute('aria-label', options.label);
    }
    const body = document.createElement('div');
    body.setAttribute('role', 'presentation');
    this.element.appendChild(body);
    if (this.display === 'list' || this.display === 'inline') {
      body.className = this.display === 'list' ? LIST : INLINE;
      const name = `radio-group-${++RadioGroup.made}`;
      // Stacked labels stay in one column: every row gets a box once any item has an image.
      const boxed = this.display === 'list' && options.items.some(item => item.image);
      for (const item of options.items) {
        this.addRadio(body, item, name, boxed);
      }
    } else if (this.display === 'buttons') {
      body.className = BUTTONS;
      for (const item of options.items) {
        this.addButton(body, item);
      }
    } else {
      body.className = CARDS;
      const columns = Math.min(6, Math.max(2, Math.round(options.columns ?? 3)));
      body.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
      this.element.dataset.columns = String(columns);
      for (const item of options.items) {
        this.addCard(body, item);
      }
    }
    if (options.allowClear) {
      this.clearButton = document.createElement('button');
      this.clearButton.type = 'button';
      this.clearButton.className = CLEAR;
      this.clearButton.textContent = 'Clear';
      this.clearButton.title = 'Clear the choice';
      this.clearButton.addEventListener('click', () => this.clear());
      this.element.appendChild(this.clearButton);
    }
    this.element.addEventListener('keydown', this.onKeyDown);
    this.sync();
  }

  get value(): V | undefined {
    return this.current;
  }

  /** Programmatic choice (prefill, reset); no change event fires. `undefined` shows none chosen. */
  setValue(value: V | undefined): void {
    this.current = value;
    this.sync();
  }

  destroy(): void {
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
  }

  /** A native radio in its label: optional thumbnail, label, muted description. */
  private addRadio(host: HTMLElement, item: ChoiceItem<V>, name: string, boxed: boolean): void {
    const row = document.createElement('label');
    row.className = RADIO_ROW;
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.className = RADIO;
    input.addEventListener('change', () => {
      if (input.checked) {
        this.choose(item.value);
      }
    });
    row.appendChild(input);
    if (boxed || item.image) {
      row.appendChild(ChoiceImage.create(item.image, ChoiceImage.THUMB));
    }
    const text = document.createElement('span');
    text.className = 'min-w-0';
    const label = document.createElement('span');
    label.className = 'block truncate';
    label.textContent = item.label;
    text.appendChild(label);
    if (item.description) {
      const description = document.createElement('span');
      description.className = DESCRIPTION;
      description.textContent = item.description;
      text.appendChild(description);
    }
    row.appendChild(text);
    host.appendChild(row);
    this.choices.push({ item, control: input, mark: chosen => { input.checked = chosen; } });
  }

  /** A segment of the joined row: optional image before the label. */
  private addButton(host: HTMLElement, item: ChoiceItem<V>): void {
    const button = this.createRadioButton(item);
    if (item.image) {
      button.appendChild(ChoiceImage.create(item.image, 'w-4 h-4'));
    }
    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = item.label;
    button.appendChild(label);
    host.appendChild(button);
    this.choices.push({
      item,
      control: button,
      mark: chosen => {
        button.className = chosen ? BUTTON_ACTIVE : BUTTON_BASE;
        button.setAttribute('aria-checked', String(chosen));
      },
    });
  }

  /** A tile: the image in a square over a truncated label, outlined when chosen. */
  private addCard(host: HTMLElement, item: ChoiceItem<V>): void {
    const card = this.createRadioButton(item);
    card.appendChild(ChoiceImage.create(item.image, ChoiceImage.SQUARE));
    const label = document.createElement('span');
    label.className = CARD_LABEL;
    label.textContent = item.label;
    card.appendChild(label);
    host.appendChild(card);
    this.choices.push({
      item,
      control: card,
      mark: chosen => {
        card.className = chosen ? CARD_ACTIVE : CARD_BASE;
        card.setAttribute('aria-checked', String(chosen));
      },
    });
  }

  private createRadioButton(item: ChoiceItem<V>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    if (item.description) {
      button.title = item.description;
    }
    button.addEventListener('click', () => this.choose(item.value));
    return button;
  }

  /** A user's choice: shown, then announced — unless it is the one already chosen. */
  private choose(value: V): void {
    if (value === this.current) {
      // A native radio the user pressed is checked by now; nothing else moved.
      return;
    }
    this.current = value;
    this.sync();
    this.onChange?.(value);
  }

  private clear(): void {
    if (this.current === undefined) {
      return;
    }
    this.current = undefined;
    this.sync();
    this.choices[0]?.control.focus({ preventScroll: true });
    this.onChange?.(undefined);
  }

  /** Mark the chosen one, keep one tab stop (the chosen, else the first), show or hide Clear. */
  private sync(): void {
    const chosen = this.choices.findIndex(choice => choice.item.value === this.current);
    this.choices.forEach((choice, index) => {
      choice.mark(index === chosen);
      choice.control.tabIndex = index === Math.max(chosen, 0) ? 0 : -1;
    });
    if (this.clearButton) {
      this.clearButton.hidden = chosen < 0;
    }
  }

  /** Arrows move and choose, wrapping at the ends; Space chooses the focused one. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const at = this.choices.findIndex(choice => choice.control === e.target);
    if (at < 0) {
      return;
    }
    let to = at;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      to = (at + 1) % this.choices.length;
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      to = (at - 1 + this.choices.length) % this.choices.length;
    } else if (e.key === 'Home') {
      to = 0;
    } else if (e.key === 'End') {
      to = this.choices.length - 1;
    } else if (e.key !== ' ') {
      return;
    }
    e.preventDefault();
    this.choices[to].control.focus({ preventScroll: true });
    this.choose(this.choices[to].item.value);
  };
}
