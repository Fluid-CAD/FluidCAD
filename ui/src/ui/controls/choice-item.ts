import { SUGGESTION_CHIP_CLASS } from '../expression-core';

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

/** The chip before a parameter's name: its letter, its tooltip and its colour classes, as the expression dropdowns draw it. */
export interface ParameterChip {
  letter: string;
  title: string;
  colors: string;
}

/**
 * A parameter a choice control offers in place of an option, or holds in
 * place of one: plain data the host resolved — the name the control shows
 * and hands back, the chip, a project parameter's label, and the option the
 * parameter's value selects (`value`, as that option's label) or its raw
 * value with a `warning` when no option carries it. `isNew` marks the offer
 * to declare a parameter of the typed name over the chosen option.
 */
export interface ParameterChoice {
  name: string;
  chip: ParameterChip;
  /** A project parameter's label, dimmed after the name; `labelTitle` is its tooltip (the file). */
  label?: string;
  labelTitle?: string;
  /** What the parameter selects, shown muted: the option's label, or the raw value under `warning`. */
  value?: string;
  warning?: string;
  isNew?: boolean;
}

/** The pieces of a parameter's row or bound trigger, drawn alike wherever a parameter shows. */
export class ParameterRows {
  /** The name, in the code font the expression dropdowns use. */
  static readonly NAME_CLASS = 'font-mono truncate';
  /** The resolved value, muted; `WARNING_CLASS` where no option carries it. */
  static readonly VALUE_CLASS = 'truncate text-base-content/50 select-none';
  static readonly WARNING_CLASS = 'truncate text-warning select-none';
  private static readonly LABEL_CLASS = 'text-xs font-sans text-base-content/45 truncate select-none';
  private static readonly NEW_CLASS = 'text-primary/70 text-[10px] uppercase select-none';

  static chip(chip: ParameterChip): HTMLElement {
    const el = document.createElement('span');
    el.dataset.role = 'chip';
    el.className = `${SUGGESTION_CHIP_CLASS} ${chip.colors}`;
    el.title = chip.title;
    el.textContent = chip.letter;
    return el;
  }

  static name(choice: ParameterChoice): HTMLElement {
    const el = document.createElement('span');
    el.dataset.role = 'parameter';
    el.className = ParameterRows.NAME_CLASS;
    el.textContent = choice.name;
    return el;
  }

  /** The project parameter's label after the name; null when it has none or it is the name. */
  static label(choice: ParameterChoice): HTMLElement | null {
    if (!choice.label || choice.label === choice.name) {
      return null;
    }
    const el = document.createElement('span');
    el.dataset.role = 'parameter-label';
    el.className = ParameterRows.LABEL_CLASS;
    el.textContent = choice.label;
    if (choice.labelTitle) {
      el.title = choice.labelTitle;
    }
    return el;
  }

  /** The "new" badge of an offer to declare; null on an existing parameter. */
  static badge(choice: ParameterChoice): HTMLElement | null {
    if (!choice.isNew) {
      return null;
    }
    const el = document.createElement('span');
    el.dataset.role = 'new';
    el.className = ParameterRows.NEW_CLASS;
    el.textContent = 'new';
    return el;
  }

  /** The resolved value, muted — or the raw value in the warning colour, the warning its tooltip; null when unknown. */
  static value(choice: ParameterChoice): HTMLElement | null {
    if (choice.value === undefined) {
      return null;
    }
    const el = document.createElement('span');
    el.dataset.role = 'resolved';
    el.className = choice.warning ? ParameterRows.WARNING_CLASS : ParameterRows.VALUE_CLASS;
    el.textContent = choice.value;
    if (choice.warning) {
      el.title = choice.warning;
    }
    return el;
  }
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
